use std::collections::VecDeque;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use parking_lot::Mutex;
use ssh2::Session;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

use super::session::OutputSink;
use super::types::{SessionCommand, SessionState, ShellEnd};

/// 空闲轮询间隔（毫秒）。libssh2 是非阻塞 + 轮询模型，没有事件通知，
/// 空闲时靠短睡眠让出 CPU；有数据时则紧密循环直到 `WouldBlock`。
const IDLE_SLEEP: Duration = Duration::from_millis(15);
const OUT_BUF: usize = 32 * 1024;
const ERR_BUF: usize = 8 * 1024;
/// 最近输出环形缓冲上限，供 AI 上下文注入 / 错误解释读取
const RECENT_LIMIT: usize = 32 * 1024;
/// libssh2 在非阻塞模式下表示「稍后重试」的错误码
const EAGAIN: i32 = -37;

// ---------------------------------------------------------------------------
// 事件发射
// ---------------------------------------------------------------------------

/// 状态事件名。前端按会话 id 订阅。
pub fn status_event(id: &str) -> String {
    format!("ssh:status:{id}")
}

/// 数据事件名。负载为 base64，避免 JSON 数字数组带来的体积膨胀。
pub fn data_event(id: &str) -> String {
    format!("ssh:data:{id}")
}

/// 会话结束事件名。
pub fn closed_event(id: &str) -> String {
    format!("ssh:closed:{id}")
}

pub fn emit_status(app: &AppHandle, id: &str, state: &SessionState) {
    if let Err(e) = app.emit(&status_event(id), state) {
        log::warn!("推送会话 {id} 状态失败：{e}");
    }
}

/// 推送一段会话输出（stdout / stderr）。供 SSH shell 泵与本地终端共用。
pub(crate) fn emit_data(app: &AppHandle, id: &str, stream: &str, bytes: &[u8]) {
    let payload = serde_json::json!({
        "stream": stream,
        "data": BASE64.encode(bytes),
    });
    if let Err(e) = app.emit(&data_event(id), payload) {
        log::warn!("推送会话 {id} 数据失败：{e}");
    }
}

/// 会话结束事件。由会话线程在**最终**终止时发出；重连过程中不发，
/// 否则前端标签会先闪一下「已关闭」再切到「重连中」。
pub fn emit_closed(app: &AppHandle, id: &str, reason: &str, clean: bool) {
    let payload = serde_json::json!({ "reason": reason, "clean": clean });
    if let Err(e) = app.emit(&closed_event(id), payload) {
        log::warn!("推送会话 {id} 结束事件失败：{e}");
    }
}

// ---------------------------------------------------------------------------
// shell 泵
// ---------------------------------------------------------------------------

/// 在已认证的会话上开启交互式 shell 并持续泵数据，直到远端关闭或链路中断。
///
/// 返回值 `clean = true` 表示无需重连（用户主动关闭或远端 shell 正常退出）；
/// `clean = false` 表示链路异常，由调用方决定是否自动重连。
///
/// `sink` 是可选的输出记录端（会话日志模块），在事件推送之外同步落盘。
#[allow(clippy::too_many_arguments)]
pub fn run_shell(
    app: &AppHandle,
    id: &str,
    sess: &Session,
    term: &str,
    cols: u32,
    rows: u32,
    rx: &Receiver<SessionCommand>,
    cancel: &AtomicBool,
    recent: &Mutex<VecDeque<u8>>,
    sink: Option<&dyn OutputSink>,
) -> AppResult<ShellEnd> {
    let mut channel = sess
        .channel_session()
        .map_err(|e| AppError::Ssh(format!("无法打开 shell 通道：{e}")))?;
    channel
        .request_pty(term, None, Some((cols, rows, 0, 0)))
        .map_err(|e| AppError::Ssh(format!("申请 pty 失败：{e}")))?;
    channel
        .shell()
        .map_err(|e| AppError::Ssh(format!("启动 shell 失败：{e}")))?;

    // 之后进入非阻塞轮询模型
    sess.set_blocking(false);

    let mut out = [0u8; OUT_BUF];
    let mut err = [0u8; ERR_BUF];
    let mut pending_input: Vec<u8> = Vec::new();
    let mut pending_resize: Option<(u32, u32)> = None;

    let end = loop {
        if cancel.load(Ordering::Relaxed) {
            break ShellEnd {
                clean: true,
                reason: "用户主动断开".into(),
            };
        }

        // 1. 收取前端指令
        let mut want_close = false;
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                SessionCommand::Write(data) => pending_input.extend_from_slice(&data),
                SessionCommand::Resize { cols, rows } => pending_resize = Some((cols, rows)),
                SessionCommand::Close => {
                    want_close = true;
                    break;
                }
            }
        }
        if want_close {
            break ShellEnd {
                clean: true,
                reason: "用户主动断开".into(),
            };
        }

        // 2. 应用终端尺寸（EAGAIN 时留到下一轮重试）
        if let Some((c, r)) = pending_resize {
            match channel.request_pty_size(c, r, None, None) {
                Ok(()) => pending_resize = None,
                Err(e) if e.code() == ssh2::ErrorCode::Session(EAGAIN) => {}
                Err(e) => {
                    log::warn!("会话 {id} 调整终端尺寸失败：{e}");
                    pending_resize = None;
                }
            }
        }

        // 3. 发送键盘输入
        while !pending_input.is_empty() {
            match channel.write(&pending_input) {
                Ok(0) => break,
                Ok(n) => {
                    pending_input.drain(..n);
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                Err(e) => return Err(AppError::Ssh(format!("写入终端失败：{e}"))),
            }
        }

        // 4. 读取远端输出
        let mut read_any = false;
        loop {
            match channel.read(&mut out) {
                Ok(0) => break,
                Ok(n) => {
                    emit_data(app, id, "stdout", &out[..n]);
                    push_recent(recent, &out[..n]);
                    if let Some(sink) = sink {
                        sink.append("stdout", &out[..n]);
                    }
                    read_any = true;
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                Err(e) => return Err(AppError::Ssh(format!("读取终端数据失败：{e}"))),
            }
        }
        // `stderr()` 取 &self 且返回 owned 的 Stream，因此不会与后续的写入/刷新冲突
        let mut err_ch = channel.stderr();
        loop {
            match err_ch.read(&mut err) {
                Ok(0) => break,
                Ok(n) => {
                    emit_data(app, id, "stderr", &err[..n]);
                    push_recent(recent, &err[..n]);
                    if let Some(sink) = sink {
                        sink.append("stderr", &err[..n]);
                    }
                    read_any = true;
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                Err(_) => break,
            }
        }

        // 5. 远端关闭
        if channel.eof() {
            // exit-status 正常到达说明 shell 是主动退出；拿不到则多半是链路中断
            break match channel.exit_status() {
                Ok(code) => ShellEnd {
                    clean: true,
                    reason: format!("远端 shell 已退出（exit {code}）"),
                },
                Err(_) => ShellEnd {
                    clean: false,
                    reason: "远端连接已中断".into(),
                },
            };
        }

        if !read_any {
            if pending_input.is_empty() {
                // 空闲时等待前端输入：有输入立刻唤醒，避免固定睡眠把按键推迟一个轮询周期。
                // 远端输出没有事件通知，只能靠 IDLE_SLEEP 兜底轮询。
                match rx.recv_timeout(IDLE_SLEEP) {
                    Ok(SessionCommand::Write(data)) => pending_input.extend_from_slice(&data),
                    Ok(SessionCommand::Resize { cols, rows }) => pending_resize = Some((cols, rows)),
                    Ok(SessionCommand::Close) => {
                        break ShellEnd {
                            clean: true,
                            reason: "用户主动断开".into(),
                        };
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        break ShellEnd {
                            clean: true,
                            reason: "会话已结束".into(),
                        };
                    }
                }
            } else {
                // 远端窗口还没消化完，稍后再重试写入，避免忙等
                thread::sleep(IDLE_SLEEP);
            }
        }
    };

    let _ = channel.send_eof();
    let _ = channel.close();
    Ok(end)
}

/// 维护最近输出缓冲，供 AI 上下文注入使用。
pub fn push_recent(recent: &Mutex<VecDeque<u8>>, bytes: &[u8]) {
    let mut buf = recent.lock();
    buf.extend(bytes);
    let overflow = buf.len().saturating_sub(RECENT_LIMIT);
    if overflow > 0 {
        buf.drain(..overflow);
    }
}

/// 读取最近输出并在 UTF-8 边界上裁剪（终端输出可能切断多字节字符）。
pub fn recent_text(recent: &Mutex<VecDeque<u8>>, max_bytes: usize) -> String {
    let buf = recent.lock();
    let take = buf.len().min(max_bytes);
    let slice: Vec<u8> = buf.iter().skip(buf.len() - take).copied().collect();
    String::from_utf8_lossy(&slice).into_owned()
}