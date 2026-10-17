use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use ssh2::Session;
use tauri::AppHandle;

use crate::config::ConfigManager;
use crate::error::{AppError, AppResult};

use super::channel;
use super::interactive::{AuthPromptHub, InteractivePrompter};
use super::jump::JumpTunnel;
use super::known_hosts;
use super::local;
use super::types::{ConnectParams, SessionCommand, SessionInfo, SessionKind, SessionState};
use super::auth;

/// TCP 连接（含 DNS 解析）超时
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 握手阶段使用的阻塞超时；握手完成后切换为非阻塞轮询
const HANDSHAKE_TIMEOUT_MS: u32 = 20_000;
/// 自动重连退避上限
const MAX_RECONNECT_DELAY_MS: u64 = 30_000;
/// 复用同一会话 id 时，等待旧会话线程退出的最长时间
const REUSE_WAIT: Duration = Duration::from_secs(5);
/// 已结束会话保留的最终快照条数上限
const ENDED_HISTORY: usize = 32;

// ---------------------------------------------------------------------------
// 传输层
// ---------------------------------------------------------------------------

/// 建立到 `host:port` 的 TCP 连接并完成 SSH 握手。
///
/// 仅负责传输层，不做认证。跳板机场景下调用方传入的是本地隧道端口，
/// 因此这里完全不需要感知 ProxyJump。
pub(crate) fn open_transport(host: &str, port: u16) -> AppResult<Session> {
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| AppError::Ssh(format!("无法解析主机 {host}：{e}")))?;

    let mut stream = None;
    let mut last_err: Option<std::io::Error> = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            Err(e) => last_err = Some(e),
        }
    }
    let stream = stream.ok_or_else(|| {
        AppError::Ssh(format!(
            "无法连接 {host}:{port}：{}",
            last_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| "无可用地址".into())
        ))
    })?;
    let _ = stream.set_nodelay(true);

    let mut sess = Session::new().map_err(|e| AppError::Ssh(format!("初始化 SSH 会话失败：{e}")))?;
    sess.set_tcp_stream(stream);
    sess.set_timeout(HANDSHAKE_TIMEOUT_MS);
    sess.handshake()
        .map_err(|e| AppError::Ssh(format!("与 {host}:{port} 握手失败：{e}")))?;
    Ok(sess)
}

// ---------------------------------------------------------------------------
// 会话句柄
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 终端输出的记录扩展点
// ---------------------------------------------------------------------------

/// 由可选模块（如会话日志）实现的输出记录器。
///
/// SSH 核心只依赖这个抽象，不感知具体模块，符合「核心不依赖可选模块」的分层约定。
pub trait SessionLogger: Send + Sync {
    /// 为一个会话开启记录。`max_bytes` 为单文件大小上限（0 表示不限）。
    /// 返回 `None` 表示跳过记录（例如文件创建失败）。
    fn open(&self, info: &SessionInfo, max_bytes: u64) -> Option<Arc<dyn OutputSink>>;

    /// 会话结束时的收尾；可重复调用。
    fn close(&self, session_id: &str);
}

/// 单条会话的输出写入端。实现必须是 `Send + Sync` 且写入无阻塞。
pub trait OutputSink: Send + Sync {
    fn append(&self, stream: &str, bytes: &[u8]);
}

// ---------------------------------------------------------------------------
// 会话句柄
// ---------------------------------------------------------------------------

/// 一个会话的运行时句柄。命令线程通过它向会话线程投递指令。
pub struct SessionHandle {
    /// 会话信息与当前状态。会话线程持有同一个 `Arc` 以便更新状态。
    info: Arc<Mutex<SessionInfo>>,
    /// 最近输出缓冲，供 AI 上下文注入 / 错误解释读取
    recent: Arc<Mutex<VecDeque<u8>>>,
    /// 置位后会话线程不再重连并尽快退出
    cancel: Arc<AtomicBool>,
    tx: Sender<SessionCommand>,
}

impl SessionHandle {
    pub fn id(&self) -> String {
        self.info.lock().id.clone()
    }

    pub fn snapshot(&self) -> SessionInfo {
        self.info.lock().clone()
    }

    pub fn state(&self) -> SessionState {
        self.info.lock().state.clone()
    }

    pub fn recent_text(&self, max_bytes: usize) -> String {
        channel::recent_text(&self.recent, max_bytes)
    }

    fn send(&self, cmd: SessionCommand) -> AppResult<()> {
        self.tx
            .send(cmd)
            .map_err(|_| AppError::SessionNotFound("会话已结束，输入未发送".into()))
    }
}

/// 会话线程需要的共享上下文。
#[derive(Clone)]
pub struct SessionDeps {
    pub app: AppHandle,
    pub config: Arc<ConfigManager>,
    /// 可选的终端输出记录器（会话日志模块）。关闭时为 `None`。
    pub logger: Option<Arc<dyn SessionLogger>>,
    /// 键盘交互认证的应答中枢：会话线程发问、前端回填。
    pub auth_hub: Arc<AuthPromptHub>,
}

// ---------------------------------------------------------------------------
// 会话管理器
// ---------------------------------------------------------------------------

/// 全局会话表。内部 `Arc` 使会话线程可以在退出时把自己摘掉。
#[derive(Clone, Default)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, Arc<SessionHandle>>>>,
    /// 刚结束的会话保留的最终快照。
    ///
    /// 会话线程可能在后端握手很快时、`ssh_connect` 返回前就结束，此时前端尚未
    /// 订阅，状态事件会整批丢失；前端订阅后靠 `list()` 对齐状态（见 ssh.js 的
    /// resyncState）。没有这段历史，快速失败的会话会永远停在「连接中」，
    /// 也无从判断失败原因（例如是否需要补录密码）。
    ended: Arc<Mutex<VecDeque<SessionInfo>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 创建会话并立即返回；连接在后台线程中进行，进度通过状态事件推送。
    pub fn create(&self, deps: &SessionDeps, params: ConnectParams) -> AppResult<SessionInfo> {
        // 本地终端没有主机 / 用户名，只有 SSH 需要这两个字段
        if params.kind == SessionKind::Ssh {
            if params.host.trim().is_empty() {
                return Err(AppError::Config("未填写主机地址".into()));
            }
            if params.username.trim().is_empty() {
                return Err(AppError::Config("未填写用户名".into()));
            }
        }

        let id = params
            .session_id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(new_session_id);

        // 复用同一 id 时先让旧会话退出，避免同 id 双写导致事件错乱
        self.close_existing(&id);
        // 旧会话的结束快照不能留到新会话：同一个 id 只能有一个权威状态
        self.ended.lock().retain(|item| item.id != id);

        let name = params
            .name
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| {
                if params.kind == SessionKind::Local {
                    "本地终端".to_string()
                } else {
                    params.endpoint()
                }
            });

        let info = Arc::new(Mutex::new(SessionInfo {
            id: id.clone(),
            kind: params.kind,
            name,
            host: params.host.clone(),
            port: params.port,
            username: params.username.clone(),
            state: SessionState::Connecting,
            created_at: chrono::Utc::now().to_rfc3339(),
        }));

        let (tx, rx) = mpsc::channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let recent = Arc::new(Mutex::new(VecDeque::new()));

        let handle = Arc::new(SessionHandle {
            info: info.clone(),
            recent: recent.clone(),
            cancel: cancel.clone(),
            tx,
        });
        self.sessions.lock().insert(id.clone(), handle);

        let snapshot = info.lock().clone();
        // 一个会话一个日志文件，跨自动重连复用同一写入端；
        // 单文件大小上限由配置决定（单位 KB，0 表示不限）
        let max_bytes = u64::from(deps.config.flags().connection.session_log_max_file_kb) * 1024;
        let sink = deps
            .logger
            .as_ref()
            .and_then(|l| l.open(&snapshot, max_bytes));
        let run = RunContext {
            deps: deps.clone(),
            params,
            id,
            info,
            recent,
            cancel,
            sessions: self.sessions.clone(),
            ended: self.ended.clone(),
            sink,
        };
        thread::Builder::new()
            .name("pterm-session".into())
            .spawn(move || run.run(rx))
            .map_err(|e| AppError::Ssh(format!("无法启动会话线程：{e}")))?;

        Ok(snapshot)
    }

    pub fn get(&self, id: &str) -> Option<Arc<SessionHandle>> {
        self.sessions.lock().get(id).cloned()
    }

    pub fn require(&self, id: &str) -> AppResult<Arc<SessionHandle>> {
        self.get(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))
    }

    /// 会话快照：活跃会话 + 最近结束的一小段历史。
    ///
    /// 会话线程结束时会把自己从活跃表中摘掉，之后由 `ended` 保留其最终状态；
    /// 前端订阅前就结束的会话只能靠这里对齐，因此不能只返回活跃项。
    /// 同一 id 以活跃会话为准（重连复用 id 时两者都会存在）。
    pub fn list(&self) -> Vec<SessionInfo> {
        let mut out: Vec<SessionInfo> = self
            .sessions
            .lock()
            .values()
            .map(|h| h.snapshot())
            .collect();
        let active: HashSet<String> = out.iter().map(|item| item.id.clone()).collect();
        let ended = self.ended.lock();
        out.extend(
            ended
                .iter()
                .filter(|item| !active.contains(&item.id))
                .cloned(),
        );
        out
    }

    pub fn write(&self, id: &str, data: Vec<u8>) -> AppResult<()> {
        let handle = self.require(id)?;
        // 未就绪时输入进不到远端 shell。这里明确报错，不再静默丢弃，
        // 因为前端本地回显已经把字符画到了屏幕上。
        if !handle.state().is_ready() {
            return Err(AppError::Ssh("会话未就绪，输入未发送".into()));
        }
        handle.send(SessionCommand::Write(data))
    }

    pub fn resize(&self, id: &str, cols: u32, rows: u32) -> AppResult<()> {
        self.require(id)?.send(SessionCommand::Resize { cols, rows })
    }

    /// 用户主动关闭：置位取消标志，会话线程不再重连。
    pub fn close(&self, id: &str) -> AppResult<()> {
        // 用户已经关掉这个标签，它的结束历史也一并清掉
        self.ended.lock().retain(|item| item.id != id);
        let handle = self.require(id)?;
        handle.cancel.store(true, Ordering::Relaxed);
        let _ = handle.send(SessionCommand::Close);
        Ok(())
    }

    /// 退出应用时关闭全部会话。
    pub fn close_all(&self) {
        let handles: Vec<Arc<SessionHandle>> = self.sessions.lock().values().cloned().collect();
        for h in handles {
            h.cancel.store(true, Ordering::Relaxed);
            let _ = h.send(SessionCommand::Close);
        }
    }

    pub fn recent_text(&self, id: &str, max_bytes: usize) -> AppResult<String> {
        Ok(self.require(id)?.recent_text(max_bytes))
    }

    /// 让同一 id 的旧会话退出。
    ///
    /// 取旧会话时必须先把锁的临时值绑进局部变量再判断：若写成
    /// `if let Some(old) = self.sessions.lock().get(&id).cloned()`，`if let` 判值表达式里
    /// 产生的 `MutexGuard` 会在 Rust 2021 语义下存活到整个 `if let` 块结束，
    /// 于是下面 `wait_gone` 里再锁同一把锁就会**自锁死**（parking_lot 不可重入），
    /// 持有者永不释放，主线程上的 `ssh_*` 同步命令随之一并挂住，整个界面冻结。
    fn close_existing(&self, id: &str) {
        // 必须先把锁的临时值绑进局部变量：写成 `if let Some(old) = self.sessions.lock()...`
        // 时，判值表达式里的 MutexGuard 会存活到整个 if let 块结束，
        // 下面 wait_gone 再锁同一把锁就会自锁死（parking_lot 不可重入）。
        let existing = self.sessions.lock().get(id).cloned();
        if let Some(old) = existing {
            log::info!("会话 {id} 已存在，先关闭旧会话");
            old.cancel.store(true, Ordering::Relaxed);
            let _ = old.send(SessionCommand::Close);
            self.wait_gone(id, REUSE_WAIT);
        }
    }

    fn wait_gone(&self, id: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if !self.sessions.lock().contains_key(id) {
                return true;
            }
            if Instant::now() >= deadline {
                log::warn!("会话 {id} 未能及时退出，仍将创建新会话");
                return false;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}

// ---------------------------------------------------------------------------
// 会话线程
// ---------------------------------------------------------------------------

struct RunContext {
    deps: SessionDeps,
    params: ConnectParams,
    id: String,
    info: Arc<Mutex<SessionInfo>>,
    recent: Arc<Mutex<VecDeque<u8>>>,
    cancel: Arc<AtomicBool>,
    sessions: Arc<Mutex<HashMap<String, Arc<SessionHandle>>>>,
    /// 结束快照的去处，与 `SessionManager::ended` 同一份
    ended: Arc<Mutex<VecDeque<SessionInfo>>>,
    /// 本次会话的终端输出写入端（会话日志开启时存在）
    sink: Option<Arc<dyn OutputSink>>,
}

impl RunContext {
    fn run(mut self, rx: Receiver<SessionCommand>) {
        // 本地终端不经过网络，也不自动重连：PTY 退出即会话结束
        if self.params.kind == SessionKind::Local {
            self.run_local(rx);
            return;
        }

        let flags = self.deps.config.flags().connection;
        let max_attempts = flags.auto_reconnect_max_attempts.max(1);
        let base_delay = Duration::from_millis(flags.auto_reconnect_base_delay_ms.max(100));

        let mut attempt: u32 = 0;
        let mut last_reason = String::new();

        while !self.cancel.load(Ordering::Relaxed) {
            // 断线期间积压的键盘输入不应在重连后补发；丢弃量记日志，避免输入无声消失。
            // 尺寸调整例外：要保留最后一次值，否则重连后新 pty 会退回连接时的旧尺寸
            // （首开标签时是 80x24），apt / dpkg 等按错误尺寸排版会覆盖已输出的行。
            let mut discarded = 0usize;
            let mut latest_size: Option<(u32, u32)> = None;
            while let Ok(cmd) = rx.try_recv() {
                match cmd {
                    SessionCommand::Write(data) => discarded += data.len(),
                    SessionCommand::Resize { cols, rows } => latest_size = Some((cols, rows)),
                    SessionCommand::Close => {}
                }
            }
            if let Some((cols, rows)) = latest_size {
                self.params.cols = cols;
                self.params.rows = rows;
            }
            if discarded > 0 {
                log::warn!("会话 {} 重连前丢弃 {discarded} 字节未送达的输入", self.id);
            }
            if attempt > 0 {
                self.recent.lock().clear();
            }

            self.set_state(SessionState::Connecting);

            let outcome = self.connect_and_shell(&rx);
            match outcome {
                Ok(end) => {
                    if self.cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    if end.clean {
                        self.set_state(SessionState::Closed);
                        channel::emit_closed(&self.deps.app, &self.id, &end.reason, true);
                        self.finish();
                        return;
                    }
                    last_reason = end.reason;
                }
                Err(e) => {
                    if self.cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    // 认证被拒绝 / 参数错误属于不可重试错误，重连只会重复失败
                    if !retryable(&e) {
                        let msg = e.to_string();
                        // 认证被拒时打个标记：前端可据此弹框让用户补录密码
                        let auth_failed = matches!(e, AppError::Auth(_));
                        // 主机密钥未通过时把指纹上下文带给前端，由它弹信任确认框
                        let host_key = match &e {
                            AppError::HostKey(info) => Some(info.clone()),
                            _ => None,
                        };
                        self.set_state(SessionState::Error {
                            message: msg.clone(),
                            auth_failed,
                            host_key,
                        });
                        channel::emit_closed(&self.deps.app, &self.id, &msg, false);
                        self.finish();
                        return;
                    }
                    last_reason = e.to_string();
                }
            }

            if !flags.auto_reconnect {
                break;
            }
            if attempt >= max_attempts {
                break;
            }

            attempt += 1;
            let delay = backoff(base_delay, attempt);
            self.set_state(SessionState::Reconnecting {
                attempt,
                max_attempts,
                delay_ms: delay.as_millis() as u64,
                reason: last_reason.clone(),
            });
            log::warn!(
                "会话 {} 断开（{}），{}ms 后进行第 {}/{} 次重连",
                self.id,
                last_reason,
                delay.as_millis(),
                attempt,
                max_attempts
            );
            if self.sleep_interruptible(delay) {
                break;
            }
        }

        let reason = if self.cancel.load(Ordering::Relaxed) {
            "用户主动断开".to_string()
        } else if last_reason.is_empty() {
            "会话已结束".to_string()
        } else {
            last_reason
        };
        self.set_state(SessionState::Disconnected {
            reason: reason.clone(),
            will_reconnect: false,
        });
        channel::emit_closed(&self.deps.app, &self.id, &reason, false);
        self.finish();
    }

    /// 运行一个本地终端会话：起一个本机 PTY shell，读写走与 SSH 相同的事件通道。
    fn run_local(self, rx: Receiver<SessionCommand>) {
        self.set_state(SessionState::Ready);
        let result = local::run_local(
            self.deps.app.clone(),
            self.id.clone(),
            self.params.cols,
            self.params.rows,
            &rx,
            &self.cancel,
            self.recent.clone(),
            self.sink.clone(),
        );
        match result {
            Ok(end) => {
                self.set_state(SessionState::Closed);
                channel::emit_closed(&self.deps.app, &self.id, &end.reason, true);
            }
            Err(e) => {
                let msg = e.to_string();
                self.set_state(SessionState::Error {
                    message: msg.clone(),
                    auth_failed: false,
                    host_key: None,
                });
                channel::emit_closed(&self.deps.app, &self.id, &msg, false);
            }
        }
        self.finish();
    }

    /// 建立一次连接并运行 shell。
    fn connect_and_shell(&self, rx: &Receiver<SessionCommand>) -> Result<super::types::ShellEnd, AppError> {
        let keepalive = self.deps.config.snapshot().terminal.keepalive_secs;

        // 键盘交互认证的应答器：跳板机与我方目标连接共用同一个会话 id，
        // 因此两者的提示都能弹到同一个界面上。
        let prompter = InteractivePrompter::new(
            self.deps.app.clone(),
            self.id.clone(),
            self.deps.auth_hub.clone(),
        );

        // 跳板机：在本机开一条隧道，目标连接指向隧道端口
        let _tunnel = match &self.params.jump {
            Some(spec) if !spec.host.trim().is_empty() => {
                let tunnel = JumpTunnel::open(
                    spec,
                    &self.params.host,
                    self.params.port,
                    keepalive,
                    Some(&prompter),
                    Some(self.params.host_key_policy),
                )?;
                log::info!(
                    "经跳板机 {} 的隧道已就绪：127.0.0.1:{}",
                    spec.host,
                    tunnel.local_port()
                );
                Some(tunnel)
            }
            _ => None,
        };

        let (host, port) = match &_tunnel {
            Some(t) => ("127.0.0.1".to_string(), t.local_port()),
            None => (self.params.host.clone(), self.params.port),
        };

        let sess = open_transport(&host, port)?;

        // 主机密钥校验（known_hosts / TOFU）：在认证之前完成，避免把凭据交给可疑主机。
        // 未通过时返回带指纹上下文的错误，由前端弹窗让用户确认。
        let host_key = known_hosts::verify_session(
            &sess,
            &self.params.host,
            self.params.port,
            self.params.host_key_policy,
        )?;
        log::info!(
            "主机密钥校验通过：{}:{} {} {}",
            host_key.host,
            host_key.port,
            host_key.key_type,
            host_key.fingerprint
        );

        let method = auth::authenticate(&sess, &self.params, Some(&prompter))?;
        log::info!("会话 {} 认证成功（{method}）", self.params.endpoint());

        if keepalive > 0 {
            sess.set_keepalive(true, keepalive);
        }

        let term = "xterm-256color";

        let end = {
            self.set_state(SessionState::Authenticated {
                method: method.clone(),
            });
            self.set_state(SessionState::Ready);
            channel::run_shell(
                &self.deps.app,
                &self.id,
                &sess,
                term,
                self.params.cols,
                self.params.rows,
                rx,
                &self.cancel,
                &self.recent,
                self.sink.as_deref(),
            )?
        };

        // 隧道随本次连接一起释放
        drop(_tunnel);
        Ok(end)
    }

    fn set_state(&self, state: SessionState) {
        {
            self.info.lock().state = state.clone();
        }
        channel::emit_status(&self.deps.app, &self.id, &state);
    }

    /// 退避等待。返回 `true` 表示等待期间收到取消信号。
    fn sleep_interruptible(&self, delay: Duration) -> bool {
        let step = Duration::from_millis(50);
        let mut left = delay;
        while left > Duration::ZERO {
            if self.cancel.load(Ordering::Relaxed) {
                return true;
            }
            let slice = left.min(step);
            thread::sleep(slice);
            left -= slice;
        }
        self.cancel.load(Ordering::Relaxed)
    }

    /// 线程退出前把自己从会话表中摘掉，并把最终状态留档（供前端对齐）。
    /// 摘除仅当表内条目仍是本次运行时才执行，避免误删同 id 的新会话。
    fn finish(&self) {
        if let Some(logger) = &self.deps.logger {
            logger.close(&self.id);
        }
        // 会话结束：清掉可能残留的键盘交互等待，避免前端弹出一个无人等待的输入框
        self.deps.auth_hub.cancel(&self.id);
        let snapshot = self.info.lock().clone();
        {
            let mut ended = self.ended.lock();
            ended.retain(|item| item.id != self.id);
            ended.push_back(snapshot);
            while ended.len() > ENDED_HISTORY {
                ended.pop_front();
            }
        }
        let mut map = self.sessions.lock();
        if let Some(current) = map.get(&self.id) {
            if Arc::ptr_eq(&current.info, &self.info) {
                map.remove(&self.id);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/// 指数退避：base、2×base、4×base……上限 30 秒。
fn backoff(base: Duration, attempt: u32) -> Duration {
    let factor = 1u64 << (attempt.saturating_sub(1)).min(5);
    let ms = (base.as_millis() as u64).saturating_mul(factor);
    Duration::from_millis(ms.min(MAX_RECONNECT_DELAY_MS))
}

/// 是否值得重试。认证失败、用户取消认证、主机密钥不符、参数错误等重试也不会成功。
fn retryable(err: &AppError) -> bool {
    !matches!(
        err,
        AppError::Auth(_)
            | AppError::AuthCancelled(_)
            | AppError::HostKey(_)
            | AppError::Config(_)
            | AppError::ModuleDisabled(_)
    )
}

fn new_session_id() -> String {
    format!("s-{}", uuid::Uuid::new_v4())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_handle(id: &str) -> Arc<SessionHandle> {
        let (tx, _rx) = mpsc::channel();
        Arc::new(SessionHandle {
            info: Arc::new(Mutex::new(SessionInfo {
                id: id.to_string(),
                kind: SessionKind::Ssh,
                name: "test".into(),
                host: "127.0.0.1".into(),
                port: 22,
                username: "test".into(),
                state: SessionState::Ready,
                created_at: String::new(),
            })),
            recent: Arc::new(Mutex::new(VecDeque::new())),
            cancel: Arc::new(AtomicBool::new(false)),
            tx,
        })
    }

    /// 复用同一 id 时，`wait_gone` 等待期间不能还握着 `sessions` 锁：
    /// 否则 `wait_gone` 里的 `lock()` 会自锁死（parking_lot 不可重入），锁再也放不出来，
    /// 主线程上的 ssh 命令随之全部挂住，整个界面冻结。
    ///
    /// 复现要点：必须等 worker 已经进到 `wait_gone` 再去验锁，否则测试线程会先抢到
    /// 那把空闲的锁，用例会空过（假通过）。
    #[test]
    fn reusing_session_id_does_not_deadlock() {
        let manager = SessionManager::new();
        let id = "s-reuse";
        manager
            .sessions
            .lock()
            .insert(id.to_string(), fake_handle(id));

        {
            let manager = manager.clone();
            // 故意不 join：worker 若自锁死，也不能把用例一起拖住
            let _ = thread::spawn(move || manager.close_existing(id));
        }

        // worker 只需抢一次空闲锁即可进入 wait_gone；旧会话不会被摘掉，
        // 所以它会一直停在 wait_gone 里轮询
        thread::sleep(Duration::from_millis(300));

        for round in 0..6 {
            assert!(
                manager
                    .sessions
                    .try_lock_for(Duration::from_millis(100))
                    .is_some(),
                "第 {round} 轮拿不到 sessions 锁：wait_gone 期间仍持锁（自锁死），主线程会被一起挂死"
            );
            thread::sleep(Duration::from_millis(30));
        }
    }
}