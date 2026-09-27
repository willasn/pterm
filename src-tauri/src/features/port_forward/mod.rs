//! 端口转发模块：本地（`-L`）、远程（`-R`）、动态（SOCKS5，`-D`）
//! （FEATURES.md §3 连接与传输）。
//!
//! 与 SSH 终端会话的关系：转发需要一条**独占的** SSH 连接——三种方向都会把
//! 整条会话切到非阻塞模式并交给多个泵线程共享，因此不复用
//! [`crate::ssh::session::SessionManager`] 的连接。传输与认证完全复用 SSH 核心
//! （含跳板机隧道），转发原语复用 [`crate::ssh::jump`]：本地与动态转发直接
//! 走 `direct-tcpip` 通道，远程转发把 `forward_listen` 收下的通道接回本地
//! TCP，三者在拿到「本地连接 + 通道」之后共用同一个双向泵。
//!
//! 转发规则是**运行期内存态**：进程退出即失效，不写配置文件。

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use ssh2::Session;

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::error::{AppError, AppResult};
use crate::modules::ModuleContext;
use crate::ssh::auth;
use crate::ssh::jump::{self, JumpTunnel};
use crate::ssh::session::open_transport;
use crate::ssh::types::ConnectParams;

pub mod commands;

/// 接受连接与空转的轮询间隔，与跳板机隧道保持一致。
const IDLE_SLEEP: Duration = Duration::from_millis(15);
/// SOCKS5 握手阶段的读写超时，避免半开连接长期占住工作线程。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// libssh2 在非阻塞模式下表示「稍后重试」的错误码。
const EAGAIN: i32 = -37;

// SOCKS5 协议常量（RFC 1928）
const SOCKS5_VERSION: u8 = 0x05;
const SOCKS5_NO_AUTH: u8 = 0x00;
const SOCKS5_NO_ACCEPTABLE: u8 = 0xFF;
const SOCKS5_CMD_CONNECT: u8 = 0x01;
const SOCKS5_ATYP_IPV4: u8 = 0x01;
const SOCKS5_ATYP_DOMAIN: u8 = 0x03;
const SOCKS5_ATYP_IPV6: u8 = 0x04;
const SOCKS5_SUCCEEDED: u8 = 0x00;
const SOCKS5_HOST_UNREACHABLE: u8 = 0x04;
const SOCKS5_ADDR_NOT_SUPPORTED: u8 = 0x08;
const SOCKS5_CMD_NOT_SUPPORTED: u8 = 0x07;

/// 未指定监听地址时的默认值。三种转发一律默认只暴露在本机回环，
/// 需要对外网暴露时必须显式填写 `0.0.0.0`。
const DEFAULT_BIND_HOST: &str = "127.0.0.1";

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

/// 转发方向。前端用它选择表单字段与展示文案。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForwardKind {
    /// 本地转发：本机监听，连接经 SSH 送到目标
    Local,
    /// 远程转发：远端监听，连接经 SSH 送回本机目标
    Remote,
    /// 动态转发：本机 SOCKS5 代理，目标由客户端在握手时指定
    Dynamic,
}

impl Default for ForwardKind {
    fn default() -> Self {
        Self::Local
    }
}

impl ForwardKind {
    /// 中文名，用于日志与默认标签。
    pub fn label(&self) -> &'static str {
        match self {
            Self::Local => "本地",
            Self::Remote => "远程",
            Self::Dynamic => "动态",
        }
    }
}

/// 启动一条转发的请求。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct ForwardRequest {
    /// SSH 连接参数，与终端、SFTP 复用同一份连接配置
    pub params: ConnectParams,
    pub kind: ForwardKind,
    /// 监听地址，留空时使用 `127.0.0.1`
    pub bind_host: Option<String>,
    /// 监听端口；`0` 表示由系统或服务器分配
    pub bind_port: u16,
    /// 目标地址。动态转发由客户端在握手时指定，此处忽略
    pub target_host: Option<String>,
    pub target_port: u16,
    /// 自定义标签，留空时按方向生成
    pub label: Option<String>,
}

impl ForwardRequest {
    /// 解析本地 / 远程转发必需的目标地址。
    fn target(&self) -> AppResult<(String, u16)> {
        let host = self.target_host.as_deref().unwrap_or("").trim();
        if host.is_empty() {
            return Err(AppError::Forward("未填写目标地址".into()));
        }
        if self.target_port == 0 {
            return Err(AppError::Forward("未填写目标端口".into()));
        }
        Ok((host.to_string(), self.target_port))
    }

    /// 监听地址，留空或全空白时回退到回环地址。
    fn resolved_bind_host(&self) -> String {
        match self.bind_host.as_deref().map(str::trim) {
            Some(h) if !h.is_empty() => h.to_string(),
            _ => DEFAULT_BIND_HOST.to_string(),
        }
    }
}

/// 一条转发规则的对外快照。命令层与前端只依赖这个结构。
#[derive(Debug, Clone, Serialize)]
pub struct ForwardInfo {
    pub id: String,
    pub kind: ForwardKind,
    pub label: String,
    /// SSH 目标主机（转发经由这台机器的连接）
    pub host: String,
    pub port: u16,
    pub username: String,
    pub bind_host: String,
    /// 请求的监听端口，`0` 表示由系统或服务器分配
    pub bind_port: u16,
    /// 实际生效的监听端口
    pub actual_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    /// 界面上直接展示的一行说明
    pub endpoint: String,
    pub created_at: String,
    /// 至今转发过的连接数
    pub connections: u64,
}

// ---------------------------------------------------------------------------
// 转发句柄
// ---------------------------------------------------------------------------

struct ForwardHandle {
    info: ForwardInfo,
    /// 停止标志：接受线程与所有泵线程共用
    stop: Arc<AtomicBool>,
    /// 已转发连接计数，由 `list()` 读取
    accepted: Arc<AtomicU64>,
    /// 接受线程。停止时置位再 join，同时触发 `Listener` 的转发取消。
    accept_thread: Mutex<Option<JoinHandle<()>>>,
    /// 跳板机隧道：会把 SSH 连接接到本机端口上，因此必须与转发同生命周期。
    /// 为 `None` 表示直连。
    _tunnel: Option<JumpTunnel>,
}

impl ForwardHandle {
    /// 当前快照：把计数从原子变量刷新进信息结构。
    fn snapshot(&self) -> ForwardInfo {
        let mut info = self.info.clone();
        info.connections = self.accepted.load(Ordering::Relaxed);
        info
    }

    /// 停止转发。可重复调用。
    fn shutdown(&self) {
        self.stop.store(true, Ordering::Relaxed);
        let handle = self.accept_thread.lock().take();
        if let Some(handle) = handle {
            let _ = handle.join();
        }
    }
}

impl Drop for ForwardHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ---------------------------------------------------------------------------
// 转发表
// ---------------------------------------------------------------------------

/// 端口转发管理。持有一张「转发 id -> 句柄」的内存表。
#[derive(Clone, Default)]
pub struct PortForwardManager {
    forwards: Arc<Mutex<HashMap<String, Arc<ForwardHandle>>>>,
}

impl PortForwardManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 建立 SSH 连接并启动一条转发。阻塞调用，调用方需放在 `spawn_blocking` 中。
    pub fn start(&self, request: ForwardRequest) -> AppResult<ForwardInfo> {
        let params = request.params.clone();
        if params.host.trim().is_empty() {
            return Err(AppError::Forward("未填写主机地址".into()));
        }
        if params.username.trim().is_empty() {
            return Err(AppError::Forward("未填写用户名".into()));
        }
        // 经跳板机建立的会话，其远端监听端口会落在跳板机上而非目标主机上，
        // 与用户填写的目标是哪台机器无关，因此直接拒绝而不是给出误导结果。
        if request.kind == ForwardKind::Remote
            && params
                .jump
                .as_ref()
                .map(|j| !j.host.trim().is_empty())
                .unwrap_or(false)
        {
            return Err(AppError::Forward(
                "远程转发不支持跳板机：监听端口会建立在跳板机上".into(),
            ));
        }

        let bind_host = request.resolved_bind_host();
        let target = match request.kind {
            ForwardKind::Dynamic => None,
            _ => Some(request.target()?),
        };

        let (session, tunnel) = open_session(&params)?;
        let stop = Arc::new(AtomicBool::new(false));
        let accepted = Arc::new(AtomicU64::new(0));

        let (actual_port, accept_thread) = match request.kind {
            ForwardKind::Local => start_local(
                &session,
                &bind_host,
                request.bind_port,
                target.as_ref().expect("本地转发必有目标"),
                &stop,
                &accepted,
            )?,
            ForwardKind::Dynamic => start_dynamic(
                &session,
                &bind_host,
                request.bind_port,
                &stop,
                &accepted,
            )?,
            ForwardKind::Remote => start_remote(
                &session,
                &bind_host,
                request.bind_port,
                target.as_ref().expect("远程转发必有目标"),
                &stop,
                &accepted,
            )?,
        };

        let (th, tp) = target.clone().unwrap_or_default();
        let id = format!("pf-{}", uuid::Uuid::new_v4());
        let info = ForwardInfo {
            id: id.clone(),
            kind: request.kind,
            label: match request.label.as_deref().map(str::trim) {
                Some(l) if !l.is_empty() => l.to_string(),
                _ => format!("{}转发", request.kind.label()),
            },
            host: params.host.clone(),
            port: params.port,
            username: params.username.clone(),
            bind_host: bind_host.clone(),
            bind_port: request.bind_port,
            actual_port,
            target_host: target.as_ref().map(|_| th.clone()),
            target_port: target.as_ref().map(|_| tp),
            endpoint: endpoint_of(request.kind, &params, &bind_host, actual_port, &th, tp),
            created_at: chrono::Local::now().to_rfc3339(),
            connections: 0,
        };

        log::info!("端口转发已启动：{} {}（{}）", id, info.label, info.endpoint);
        self.forwards.lock().insert(
            id,
            Arc::new(ForwardHandle {
                info: info.clone(),
                stop,
                accepted,
                accept_thread: Mutex::new(Some(accept_thread)),
                _tunnel: tunnel,
            }),
        );
        Ok(info)
    }

    /// 停止一条转发。可重复调用同一 id 之外的错误会被明确报出。
    pub fn stop(&self, id: &str) -> AppResult<()> {
        let handle = self
            .forwards
            .lock()
            .remove(id)
            .ok_or_else(|| AppError::Forward(format!("转发规则不存在：{id}")))?;
        handle.shutdown();
        log::info!("端口转发已停止：{id}");
        Ok(())
    }

    /// 所有转发规则快照。
    pub fn list(&self) -> Vec<ForwardInfo> {
        let mut out: Vec<ForwardInfo> = self
            .forwards
            .lock()
            .values()
            .map(|h| h.snapshot())
            .collect();
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        out
    }

    /// 退出前停止全部转发。
    pub fn close_all(&self) {
        let handles: Vec<Arc<ForwardHandle>> =
            self.forwards.lock().drain().map(|(_, h)| h).collect();
        for handle in &handles {
            handle.shutdown();
        }
        if !handles.is_empty() {
            log::info!("已停止 {} 条端口转发", handles.len());
        }
    }
}

// ---------------------------------------------------------------------------
// 模块
// ---------------------------------------------------------------------------

/// 端口转发模块。转发按需启动，初始化阶段只有一条日志。
pub struct PortForwardModule {
    service: PortForwardManager,
}

impl PortForwardModule {
    pub fn new(service: PortForwardManager) -> Self {
        Self { service }
    }
}

impl PluggableModule for PortForwardModule {
    fn id(&self) -> &'static str {
        module_id::PORT_FORWARD
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.connection.port_forward
    }

    fn init(&self, _ctx: &ModuleContext) -> AppResult<()> {
        log::info!("端口转发已启用：本地 / 远程 / 动态（SOCKS5）");
        Ok(())
    }

    fn dispose(&self) -> AppResult<()> {
        self.service.close_all();
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 三种转发的启动实现
// ---------------------------------------------------------------------------

/// 建立一条独占的 SSH 连接。跳板机复用 SSH 核心的本地隧道。
fn open_session(params: &ConnectParams) -> AppResult<(Session, Option<JumpTunnel>)> {
    let tunnel = match &params.jump {
        Some(spec) if !spec.host.trim().is_empty() => {
            Some(JumpTunnel::open(spec, &params.host, params.port, 0)?)
        }
        _ => None,
    };
    let (host, port) = match &tunnel {
        Some(t) => ("127.0.0.1".to_string(), t.local_port()),
        None => (params.host.clone(), params.port),
    };
    let sess = open_transport(&host, port)?;
    let method = auth::authenticate(&sess, params)?;
    log::info!("端口转发会话已建立：{}（{method}）", params.endpoint());
    Ok((sess, tunnel))
}

/// 本地转发：本机监听，每条连接经会话连到目标。
fn start_local(
    session: &Session,
    bind_host: &str,
    bind_port: u16,
    target: &(String, u16),
    stop: &Arc<AtomicBool>,
    accepted: &Arc<AtomicU64>,
) -> AppResult<(u16, JoinHandle<()>)> {
    let (listener, actual) = bind_listener(bind_host, bind_port)?;

    let sess = session.clone();
    let (host, port) = target.clone();
    let accept_stop = stop.clone();
    let counter = accepted.clone();
    let handle = thread::spawn(move || {
        while !accept_stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, peer)) => {
                    log::debug!("本地转发接受来自 {peer} 的连接");
                    let sess = sess.clone();
                    let stop = accept_stop.clone();
                    let counter = counter.clone();
                    let host = host.clone();
                    thread::spawn(move || {
                        counter.fetch_add(1, Ordering::Relaxed);
                        if let Err(e) = jump::forward(sess, stream, &host, port, &stop) {
                            log::warn!("本地转发连接结束：{e}");
                        }
                    });
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => thread::sleep(IDLE_SLEEP),
                Err(e) => {
                    log::warn!("本地转发监听中断：{e}");
                    break;
                }
            }
        }
        log::debug!("本地转发监听线程退出");
    });
    Ok((actual, handle))
}

/// 动态转发：本机 SOCKS5 代理，目标由每条连接的握手决定。
fn start_dynamic(
    session: &Session,
    bind_host: &str,
    bind_port: u16,
    stop: &Arc<AtomicBool>,
    accepted: &Arc<AtomicU64>,
) -> AppResult<(u16, JoinHandle<()>)> {
    let (listener, actual) = bind_listener(bind_host, bind_port)?;

    session.set_blocking(false);
    let sess = session.clone();
    let accept_stop = stop.clone();
    let counter = accepted.clone();
    let handle = thread::spawn(move || {
        while !accept_stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, peer)) => {
                    log::debug!("SOCKS5 代理接受来自 {peer} 的连接");
                    let sess = sess.clone();
                    let stop = accept_stop.clone();
                    let counter = counter.clone();
                    thread::spawn(move || {
                        counter.fetch_add(1, Ordering::Relaxed);
                        if let Err(e) = serve_socks5(sess, stream, &stop) {
                            log::warn!("SOCKS5 连接结束：{e}");
                        }
                    });
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => thread::sleep(IDLE_SLEEP),
                Err(e) => {
                    log::warn!("SOCKS5 代理监听中断：{e}");
                    break;
                }
            }
        }
        log::debug!("SOCKS5 代理监听线程退出");
    });
    Ok((actual, handle))
}

/// 远程转发：远端监听，每条通道接回本机目标。
fn start_remote(
    session: &Session,
    bind_host: &str,
    bind_port: u16,
    target: &(String, u16),
    stop: &Arc<AtomicBool>,
    accepted: &Arc<AtomicU64>,
) -> AppResult<(u16, JoinHandle<()>)> {
    // 监听建立在远端：必须在阻塞模式下调用，返回服务器实际分配的端口
    let (listener, actual) = session
        .channel_forward_listen(bind_port, Some(bind_host), None)
        .map_err(|e| AppError::Forward(format!("远端监听 {bind_host}:{bind_port} 失败：{e}")))?;
    session.set_blocking(false);

    let (host, port) = target.clone();
    let accept_stop = stop.clone();
    let counter = accepted.clone();
    let handle = thread::spawn(move || {
        let mut listener = listener;
        while !accept_stop.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok(channel) => {
                    log::debug!("远程转发收到一条通道");
                    let stop = accept_stop.clone();
                    let counter = counter.clone();
                    let host = host.clone();
                    thread::spawn(move || {
                        counter.fetch_add(1, Ordering::Relaxed);
                        match TcpStream::connect((host.as_str(), port)) {
                            Ok(stream) => {
                                if let Err(e) = jump::pump(stream, channel, &stop) {
                                    log::warn!("远程转发连接结束：{e}");
                                }
                            }
                            Err(e) => {
                                log::warn!("远程转发无法连接本地目标 {host}:{port}：{e}");
                            }
                        }
                    });
                }
                Err(e) if matches!(e.code(), ssh2::ErrorCode::Session(EAGAIN)) => {
                    thread::sleep(IDLE_SLEEP)
                }
                Err(e) => {
                    log::warn!("远程转发监听中断：{e}");
                    break;
                }
            }
        }
        log::debug!("远程转发监听线程退出");
    });
    Ok((actual, handle))
}

// ---------------------------------------------------------------------------
// SOCKS5（RFC 1928，仅 CONNECT 命令，无认证）
// ---------------------------------------------------------------------------

/// 完成 SOCKS5 协商与请求解析，返回目标地址。
fn socks5_negotiate(stream: &mut TcpStream) -> AppResult<(String, u16)> {
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).ok();
    stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT)).ok();

    // 版本与方法协商：VER NMETHODS METHODS...
    let mut head = [0u8; 2];
    read_exact(stream, &mut head)?;
    if head[0] != SOCKS5_VERSION {
        return Err(AppError::Forward(format!("不支持的 SOCKS 版本：{}", head[0])));
    }
    let mut methods = vec![0u8; head[1] as usize];
    read_exact(stream, &mut methods)?;
    if !methods.contains(&SOCKS5_NO_AUTH) {
        write_all(stream, &[SOCKS5_VERSION, SOCKS5_NO_ACCEPTABLE])?;
        return Err(AppError::Forward("客户端未提供免认证方式".into()));
    }
    write_all(stream, &[SOCKS5_VERSION, SOCKS5_NO_AUTH])?;

    // 请求：VER CMD RSV ATYP DST.ADDR DST.PORT
    let mut req = [0u8; 4];
    read_exact(stream, &mut req)?;
    if req[0] != SOCKS5_VERSION {
        return Err(AppError::Forward(format!("不支持的 SOCKS 版本：{}", req[0])));
    }
    if req[1] != SOCKS5_CMD_CONNECT {
        let _ = socks5_reply(stream, SOCKS5_CMD_NOT_SUPPORTED);
        return Err(AppError::Forward("仅支持 SOCKS5 的 CONNECT 命令".into()));
    }

    let host = match req[3] {
        SOCKS5_ATYP_IPV4 => {
            let mut buf = [0u8; 4];
            read_exact(stream, &mut buf)?;
            Ipv4Addr::from(buf).to_string()
        }
        SOCKS5_ATYP_IPV6 => {
            let mut buf = [0u8; 16];
            read_exact(stream, &mut buf)?;
            Ipv6Addr::from(buf).to_string()
        }
        SOCKS5_ATYP_DOMAIN => {
            let mut len = [0u8; 1];
            read_exact(stream, &mut len)?;
            let mut buf = vec![0u8; len[0] as usize];
            read_exact(stream, &mut buf)?;
            String::from_utf8(buf)
                .map_err(|_| AppError::Forward("SOCKS5 域名不是合法的 UTF-8".into()))?
        }
        other => {
            let _ = socks5_reply(stream, SOCKS5_ADDR_NOT_SUPPORTED);
            return Err(AppError::Forward(format!("不支持的 SOCKS5 地址类型：{other}")));
        }
    };

    let mut port = [0u8; 2];
    read_exact(stream, &mut port)?;

    // 转入转发阶段前清除超时，避免长连接被误判
    stream.set_read_timeout(None).ok();
    stream.set_write_timeout(None).ok();
    Ok((host, u16::from_be_bytes(port)))
}

/// 回写 SOCKS5 响应。`BND.ADDR` 固定为 `0.0.0.0:0`，客户端不使用该字段。
fn socks5_reply(stream: &mut TcpStream, code: u8) -> std::io::Result<()> {
    stream.write_all(&[
        SOCKS5_VERSION,
        code,
        0x00,
        SOCKS5_ATYP_IPV4,
        0,
        0,
        0,
        0,
        0,
        0,
    ])
}

/// 一条 SOCKS5 连接：协商 -> 建通道 -> 回响应 -> 双向泵。
fn serve_socks5(sess: Session, mut stream: TcpStream, stop: &Arc<AtomicBool>) -> AppResult<()> {
    let (host, port) = socks5_negotiate(&mut stream)?;
    match jump::open_direct_tcpip(&sess, &host, port, stop) {
        Ok(channel) => {
            socks5_reply(&mut stream, SOCKS5_SUCCEEDED)
                .map_err(|e| AppError::Forward(format!("回写 SOCKS5 响应失败：{e}")))?;
            jump::pump(stream, channel, stop)
        }
        Err(e) => {
            let _ = socks5_reply(&mut stream, SOCKS5_HOST_UNREACHABLE);
            Err(e)
        }
    }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/// 绑定本地监听端口并返回实际端口。监听端口为非阻塞，配合轮询接受连接。
fn bind_listener(bind_host: &str, bind_port: u16) -> AppResult<(TcpListener, u16)> {
    let listener = TcpListener::bind((bind_host, bind_port))
        .map_err(|e| AppError::Forward(format!("无法监听 {bind_host}:{bind_port}：{e}")))?;
    let actual = listener
        .local_addr()
        .map_err(|e| AppError::Forward(format!("无法获取监听端口：{e}")))?
        .port();
    listener
        .set_nonblocking(true)
        .map_err(|e| AppError::Forward(format!("监听端口设置非阻塞失败：{e}")))?;
    Ok((listener, actual))
}

/// 界面展示用的转发说明。
fn endpoint_of(
    kind: ForwardKind,
    params: &ConnectParams,
    bind_host: &str,
    actual_port: u16,
    target_host: &str,
    target_port: u16,
) -> String {
    match kind {
        ForwardKind::Local => {
            format!("{bind_host}:{actual_port} → {target_host}:{target_port}")
        }
        ForwardKind::Remote => format!(
            "{}:{actual_port}（远端监听）→ {target_host}:{target_port}",
            params.endpoint()
        ),
        ForwardKind::Dynamic => format!("{bind_host}:{actual_port} → SOCKS5"),
    }
}

fn read_exact(stream: &mut TcpStream, buf: &mut [u8]) -> AppResult<()> {
    stream
        .read_exact(buf)
        .map_err(|e| AppError::Forward(format!("SOCKS5 协商读取失败：{e}")))
}

fn write_all(stream: &mut TcpStream, buf: &[u8]) -> AppResult<()> {
    stream
        .write_all(buf)
        .map_err(|e| AppError::Forward(format!("SOCKS5 协商写入失败：{e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(kind: ForwardKind) -> ForwardRequest {
        ForwardRequest {
            kind,
            ..Default::default()
        }
    }

    #[test]
    fn bind_host_falls_back_to_loopback() {
        let mut req = request(ForwardKind::Local);
        assert_eq!(req.resolved_bind_host(), DEFAULT_BIND_HOST);
        req.bind_host = Some("   ".into());
        assert_eq!(req.resolved_bind_host(), DEFAULT_BIND_HOST);
        req.bind_host = Some(" 0.0.0.0 ".into());
        assert_eq!(req.resolved_bind_host(), "0.0.0.0");
    }

    #[test]
    fn target_requires_host_and_port() {
        let mut req = request(ForwardKind::Local);
        assert!(req.target().is_err());

        req.target_host = Some(" 10.0.0.5 ".into());
        assert!(req.target().is_err(), "端口为 0 时应报错");

        req.target_port = 80;
        assert_eq!(req.target().unwrap(), ("10.0.0.5".to_string(), 80));
    }

    #[test]
    fn default_label_uses_kind_name() {
        assert_eq!(ForwardKind::default(), ForwardKind::Local);
        assert_eq!(ForwardKind::Remote.label(), "远程");
    }

    #[test]
    fn endpoint_mentions_both_ends() {
        let line = endpoint_of(
            ForwardKind::Local,
            &ConnectParams::default(),
            "127.0.0.1",
            8080,
            "10.0.0.5",
            80,
        );
        assert_eq!(line, "127.0.0.1:8080 → 10.0.0.5:80");
    }
}