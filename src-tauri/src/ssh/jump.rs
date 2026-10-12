use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use ssh2::{Channel, Session};

use crate::config::store::secrets;
use crate::error::{AppError, AppResult};

use super::auth;
use super::session::open_transport;
use super::types::{AuthSpec, ConnectParams, JumpSpec};

/// 空闲轮询间隔。libssh2 的会话是“非阻塞 + 轮询”模型，没有可用的
/// 事件通知，因此用短睡眠降低空转开销。
const IDLE_SLEEP: Duration = Duration::from_millis(15);
const BUF_SIZE: usize = 32 * 1024;
/// 单方向最多缓存的未发送字节数，避免对端不读时无限增长
const MAX_PENDING: usize = BUF_SIZE * 4;
const CHANNEL_TIMEOUT: Duration = Duration::from_secs(15);
/// libssh2 在非阻塞模式下表示「稍后重试」的错误码
const EAGAIN: i32 = -37;

/// 经跳板机建立的本机隧道。
///
/// 在 `127.0.0.1` 上监听一个随机端口；每条进入的连接都会在跳板机会话上打开
/// 一个 `direct-tcpip` 通道转发到目标主机。目标连接只需把 `TcpStream` 指向
/// 这个本地端口即可，`ssh2` 本身无需感知跳板机的存在。
pub struct JumpTunnel {
    local_port: u16,
    stop: Arc<AtomicBool>,
    accept_thread: Option<JoinHandle<()>>,
}

impl JumpTunnel {
    /// 连接跳板机并启动本地转发端口。
    pub fn open(
        spec: &JumpSpec,
        target_host: &str,
        target_port: u16,
        keepalive_secs: u32,
    ) -> AppResult<Self> {
        let session = connect_jump_session(spec, keepalive_secs)?;

        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| AppError::Ssh(format!("无法为跳板机隧道分配本地端口：{e}")))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| AppError::Ssh(format!("无法获取隧道本地端口：{e}")))?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|e| AppError::Ssh(format!("隧道监听端口设置失败：{e}")))?;

        let stop = Arc::new(AtomicBool::new(false));
        let target_host = target_host.to_string();
        let accept_stop = stop.clone();
        let accept_thread = thread::spawn(move || {
            while !accept_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, peer)) => {
                        log::debug!("跳板机隧道接受来自 {peer} 的连接");
                        let sess = session.clone();
                        let conn_stop = accept_stop.clone();
                        let host = target_host.clone();
                        thread::spawn(move || {
                            if let Err(e) = forward(sess, stream, &host, target_port, &conn_stop) {
                                log::warn!("跳板机隧道转发结束：{e}");
                            }
                        });
                    }
                    Err(e) if e.kind() == ErrorKind::WouldBlock => thread::sleep(IDLE_SLEEP),
                    Err(e) => {
                        log::warn!("跳板机隧道监听中断：{e}");
                        break;
                    }
                }
            }
            log::debug!("跳板机隧道监听线程退出");
        });

        Ok(Self {
            local_port,
            stop,
            accept_thread: Some(accept_thread),
        })
    }

    /// 本地转发端口。目标会话应连接 `127.0.0.1:{port}`。
    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    /// 关闭隧道。可重复调用。
    pub fn close(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.accept_thread.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for JumpTunnel {
    fn drop(&mut self) {
        self.close();
    }
}

// ---------------------------------------------------------------------------
// 实现细节
// ---------------------------------------------------------------------------

fn connect_jump_session(spec: &JumpSpec, keepalive_secs: u32) -> AppResult<Session> {
    if spec.host.trim().is_empty() || spec.username.trim().is_empty() {
        return Err(AppError::Ssh("跳板机配置不完整（缺少主机或用户名）".into()));
    }
    let params = ConnectParams {
        // 跳板机会话不携带连接的 id，避免误用目标主机的密码条目
        connection_id: None,
        name: Some("跳板机".into()),
        host: spec.host.clone(),
        port: spec.port,
        username: spec.username.clone(),
        auth: resolve_auth(spec),
        jump: None,
        cols: 80,
        rows: 24,
        session_id: None,
    };

    let sess = open_transport(&spec.host, spec.port)?;
    let method = auth::authenticate(&sess, &params)?;
    log::info!("跳板机 {} 认证成功（{method}）", params.endpoint());
    if keepalive_secs > 0 {
        sess.set_keepalive(true, keepalive_secs);
    }
    Ok(sess)
}

/// 解析跳板机的认证方式。
///
/// 密码缺失时读取专用的保险库条目 `conn:{id}:jump-password`，
/// **绝不**回退到目标主机的密码条目。
fn resolve_auth(spec: &JumpSpec) -> AuthSpec {
    match &spec.auth {
        AuthSpec::Password { password: None } => {
            let pw = spec
                .connection_id
                .as_deref()
                .and_then(|id| secrets::get(&secrets::jump_password_key(id)).ok().flatten())
                .filter(|s| !s.is_empty());
            AuthSpec::Password { password: pw }
        }
        other => other.clone(),
    }
}

/// 在会话上打开一条到目标的 `direct-tcpip` 通道。
///
/// 会话需处于非阻塞模式；`EAGAIN` 会按 [`IDLE_SLEEP`] 重试直到超时。
pub(crate) fn open_direct_tcpip(
    sess: &Session,
    host: &str,
    port: u16,
    stop: &AtomicBool,
) -> AppResult<Channel> {
    let deadline = Instant::now() + CHANNEL_TIMEOUT;
    loop {
        if stop.load(Ordering::Relaxed) {
            return Err(AppError::Ssh("隧道已关闭".into()));
        }
        match sess.channel_direct_tcpip(host, port, None) {
            Ok(channel) => return Ok(channel),
            Err(e) if e.code() == ssh2::ErrorCode::Session(EAGAIN) => {
                if Instant::now() >= deadline {
                    return Err(AppError::Ssh(format!(
                        "经跳板机连接 {host}:{port} 超时（{CHANNEL_TIMEOUT:?}）"
                    )));
                }
                thread::sleep(IDLE_SLEEP);
            }
            Err(e) => {
                return Err(AppError::Ssh(format!(
                    "经跳板机连接 {host}:{port} 失败：{e}"
                )))
            }
        }
    }
}

/// 经会话把本地 TCP 连接接入一条到目标的 `direct-tcpip` 通道。
///
/// 本地转发与跳板机隧道共用这条路径：连接在握手阶段才会真正建立，
/// 因此对端不接受时错误只体现在该条连接上。
pub(crate) fn forward(
    sess: Session,
    stream: TcpStream,
    host: &str,
    port: u16,
    stop: &AtomicBool,
) -> AppResult<()> {
    sess.set_blocking(false);
    let channel = open_direct_tcpip(&sess, host, port, stop)?;
    pump(stream, channel, stop)
}

/// 双向泵：本地 TCP <-> SSH 通道。
///
/// `stream` 进入时可处于阻塞模式，函数内部会切到非阻塞；`channel` 所属
/// 会话必须已是非阻塞模式。三种转发方向（本地 / 远程 / 动态）在拿到
/// 一条本地连接与一条通道之后，转发语义完全一致，因此共用此函数。
pub(crate) fn pump(
    mut stream: TcpStream,
    mut channel: Channel,
    stop: &AtomicBool,
) -> AppResult<()> {
    stream
        .set_nonblocking(true)
        .map_err(|e| AppError::Ssh(format!("转发连接设置非阻塞失败：{e}")))?;
    let _ = stream.set_nodelay(true);

    let mut buf = [0u8; BUF_SIZE];
    let mut to_remote: Vec<u8> = Vec::new();
    let mut to_local: Vec<u8> = Vec::new();

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let mut busy = false;

        // 本地 -> 远端
        if to_remote.len() < MAX_PENDING {
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    to_remote.extend_from_slice(&buf[..n]);
                    busy = true;
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => {}
                Err(e) => return Err(e.into()),
            }
        }
        while !to_remote.is_empty() {
            match channel.write(&to_remote) {
                Ok(0) => break,
                Ok(n) => {
                    to_remote.drain(..n);
                    busy = true;
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                Err(e) => return Err(AppError::Ssh(e.to_string())),
            }
        }

        // 远端 -> 本地
        if to_local.len() < MAX_PENDING {
            loop {
                match channel.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        to_local.extend_from_slice(&buf[..n]);
                        busy = true;
                    }
                    Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                    Err(e) => return Err(AppError::Ssh(e.to_string())),
                }
            }
        }
        while !to_local.is_empty() {
            match stream.write(&to_local) {
                Ok(0) => break,
                Ok(n) => {
                    to_local.drain(..n);
                    busy = true;
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                Err(e) => return Err(e.into()),
            }
        }

        let _ = stream.flush();
        let _ = channel.flush();

        if channel.eof() {
            break;
        }
        if !busy {
            thread::sleep(IDLE_SLEEP);
        }
    }

    let _ = channel.send_eof();
    let _ = channel.close();
    Ok(())
}