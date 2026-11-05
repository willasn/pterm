use std::collections::VecDeque;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use parking_lot::Mutex;
use ssh2::{Channel, Session};
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

use super::latency;
use super::monitor;
use super::session::OutputSink;
use super::types::{ExecReply, ExecResult, SessionCommand, SessionState, ShellEnd};

/// 空闲轮询间隔（毫秒）。libssh2 是非阻塞 + 轮询模型，没有事件通知，
/// 空闲时靠短睡眠让出 CPU；有数据时则紧密循环直到 `WouldBlock`。
const IDLE_SLEEP: Duration = Duration::from_millis(15);
const OUT_BUF: usize = 32 * 1024;
const ERR_BUF: usize = 8 * 1024;
/// 最近输出环形缓冲上限，供 AI 上下文注入 / 错误解释读取
const RECENT_LIMIT: usize = 32 * 1024;
/// libssh2 在非阻塞模式下表示「稍后重试」的错误码
const EAGAIN: i32 = -37;
/// 连续探测失败多少次后停止（远端可能禁用了 exec，避免每轮都刷失败日志）
const PROBE_MAX_FAILURES: u32 = 3;
/// 后台命令输出保留上限（超出部分继续读取但不再累积，避免内存无限增长）
const EXEC_OUTPUT_LIMIT: usize = 256 * 1024;
/// 后台命令单次读取缓冲
const EXEC_BUF: usize = 16 * 1024;

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

/// 延迟事件名。
pub fn latency_event(id: &str) -> String {
    format!("ssh:latency:{id}")
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

/// 推送一次延迟探测结果；`None` 表示该会话不再提供延迟（远端不支持）。
pub fn emit_latency(app: &AppHandle, id: &str, ms: Option<u32>) {
    let payload = serde_json::json!({ "ms": ms });
    if let Err(e) = app.emit(&latency_event(id), payload) {
        log::warn!("推送会话 {id} 延迟失败：{e}");
    }
}

// ---------------------------------------------------------------------------
// 后台命令（独立 exec 通道）
// ---------------------------------------------------------------------------

/// 一次后台命令执行。
///
/// 在会话上另开一条 exec 通道，**不申请 pty、不写入用户终端**，因此用户当前
/// 交互的 shell 完全不受影响。通道在非阻塞会话上可能返回 EAGAIN，所以每次
/// 轮询只推进一步，由 shell 泵循环反复调用 [`ExecJob::poll`] 直到拿到结果。
struct ExecJob {
    command: String,
    reply: Option<ExecReply>,
    channel: Option<Channel>,
    /// `exec` 请求是否已经成功发出（通道建立与 exec 可能分处两轮）
    exec_sent: bool,
    started: Instant,
    timeout: Duration,
    output: Vec<u8>,
}

impl ExecJob {
    fn new(command: String, timeout_ms: u64, reply: ExecReply) -> Self {
        Self {
            command,
            reply: Some(reply),
            channel: None,
            exec_sent: false,
            started: Instant::now(),
            timeout: Duration::from_millis(timeout_ms.clamp(1_000, 600_000)),
            output: Vec::new(),
        }
    }

    /// 推进一次。返回 `Some` 表示任务已结束（含出错 / 超时）。
    fn poll(&mut self, sess: &Session) -> Option<Result<ExecResult, String>> {
        if self.channel.is_none() {
            match sess.channel_session() {
                Ok(mut channel) => {
                    // 合并 stderr：AI 只看一段连续输出即可，不需要区分流
                    let _ = channel.handle_extended_data(ssh2::ExtendedData::Merge);
                    self.channel = Some(channel);
                }
                Err(e) if e.code() == ssh2::ErrorCode::Session(EAGAIN) => return None,
                Err(e) => return Some(Err(format!("打开后台执行通道失败：{e}"))),
            }
        }

        let mut failure: Option<String> = None;
        let mut done = false;
        let mut timed_out = false;
        let mut exit_code = None;

        {
            let channel = self.channel.as_mut()?;

            if !self.exec_sent {
                match channel.exec(&self.command) {
                    Ok(()) => self.exec_sent = true,
                    Err(e) if e.code() == ssh2::ErrorCode::Session(EAGAIN) => return None,
                    Err(e) => failure = Some(format!("提交后台命令失败：{e}")),
                }
            }

            if failure.is_none() {
                let mut buf = [0u8; EXEC_BUF];
                loop {
                    match channel.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let room = EXEC_OUTPUT_LIMIT.saturating_sub(self.output.len());
                            if room > 0 {
                                self.output.extend_from_slice(&buf[..n.min(room)]);
                            }
                        }
                        Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                        Err(e) => {
                            failure = Some(format!("读取后台命令输出失败：{e}"));
                            break;
                        }
                    }
                }
            }

            if failure.is_none() {
                let eof = channel.eof();
                timed_out = !eof && self.started.elapsed() >= self.timeout;
                done = eof || timed_out;
                if done && eof {
                    exit_code = channel.exit_status().ok();
                }
            }
        }

        if let Some(msg) = failure {
            self.close_channel();
            return Some(Err(msg));
        }
        if !done {
            return None;
        }

        self.close_channel();
        Some(Ok(ExecResult {
            output: String::from_utf8_lossy(&self.output).into_owned(),
            exit_code,
            timed_out,
        }))
    }

    fn close_channel(&mut self) {
        if let Some(mut channel) = self.channel.take() {
            let _ = channel.send_eof();
            let _ = channel.close();
        }
    }
}

/// 接收一条新的后台命令；同一会话同一时刻只允许一条，避免输出互相干扰。
fn accept_exec(job: &mut Option<ExecJob>, command: String, timeout_ms: u64, reply: ExecReply) {
    if job.is_some() {
        let _ = reply.send(Err("已有后台命令正在执行，请稍后重试".into()));
        return;
    }
    if command.trim().is_empty() {
        let _ = reply.send(Err("命令为空".into()));
        return;
    }
    *job = Some(ExecJob::new(command, timeout_ms, reply));
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
///
/// `keepalive_secs` 同时驱动保活与延迟探测：为 0 时两者都不做。
///
/// `monitor` 是会话资源监控的运行时开关：关闭时每轮只有一次原子读取，不产生
/// 任何通道与 IO；打开后按 [`monitor::INTERVAL`] 节流采样。
#[allow(clippy::too_many_arguments)]
pub fn run_shell(
    app: &AppHandle,
    id: &str,
    sess: &Session,
    term: &str,
    cols: u32,
    rows: u32,
    keepalive_secs: u32,
    rx: &Receiver<SessionCommand>,
    cancel: &AtomicBool,
    monitor: &AtomicBool,
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
    let keepalive = Duration::from_secs(keepalive_secs as u64);
    let mut next_keepalive = Instant::now() + keepalive;
    // 首个探测立刻做一次，标签上的信号条不必等满一个间隔
    let mut next_probe = Instant::now();
    let mut probe_failures = 0u32;
    // 资源监控状态：开关关闭时不采样，首个样本在打开后立刻采集
    let mut monitor_state = monitor::Monitor::new();
    // 后台命令：同一时刻只跑一条，独立 exec 通道，输出不进入用户终端
    let mut exec_job: Option<ExecJob> = None;

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
                SessionCommand::Exec {
                    command,
                    timeout_ms,
                    reply,
                } => accept_exec(&mut exec_job, command, timeout_ms, reply),
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

        // 5. 推进后台命令（独立通道，与上面的交互 shell 互不影响）
        let exec_finished = match exec_job.as_mut() {
            Some(job) => match job.poll(sess) {
                Some(result) => {
                    if let Some(reply) = job.reply.take() {
                        // 前端可能已经超时放弃等待，发送失败不算错误
                        let _ = reply.send(result);
                    }
                    true
                }
                None => false,
            },
            None => false,
        };
        if exec_finished {
            exec_job = None;
        }

        // 6. 远端关闭
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
            // 资源监控：开关关闭时这里只有一次原子读取，不产生任何远端开销
            monitor_state.tick(app, id, sess, monitor.load(Ordering::Relaxed));

            // 保活与延迟探测只在空闲轮驱动，避免与高频输出抢同一轮循环
            if !keepalive.is_zero() {
                if Instant::now() >= next_keepalive {
                    next_keepalive = Instant::now() + keepalive;
                    // libssh2 只配置间隔不会自动发送，必须由应用主动驱动
                    if let Err(e) = sess.keepalive_send() {
                        if e.code() != ssh2::ErrorCode::Session(EAGAIN) {
                            log::debug!("会话 {id} 发送保活失败：{e}");
                        }
                    }
                }
                if Instant::now() >= next_probe && probe_failures < PROBE_MAX_FAILURES {
                    next_probe = Instant::now() + keepalive;
                    match latency::probe_once(sess) {
                        Ok(ms) => {
                            probe_failures = 0;
                            emit_latency(app, id, Some(ms));
                        }
                        Err(e) => {
                            probe_failures += 1;
                            log::debug!(
                                "会话 {id} 延迟探测失败（{probe_failures}/{PROBE_MAX_FAILURES}）：{e}"
                            );
                            if probe_failures >= PROBE_MAX_FAILURES {
                                log::info!("会话 {id} 延迟探测连续失败，停止探测");
                                emit_latency(app, id, None);
                            }
                        }
                    }
                }
            }

            if pending_input.is_empty() {
                // 空闲时等待前端输入：有输入立刻唤醒，避免固定睡眠把按键推迟一个轮询周期。
                // 远端输出没有事件通知，只能靠 IDLE_SLEEP 兜底轮询。
                match rx.recv_timeout(IDLE_SLEEP) {
                    Ok(SessionCommand::Write(data)) => pending_input.extend_from_slice(&data),
                    Ok(SessionCommand::Resize { cols, rows }) => pending_resize = Some((cols, rows)),
                    Ok(SessionCommand::Exec {
                        command,
                        timeout_ms,
                        reply,
                    }) => accept_exec(&mut exec_job, command, timeout_ms, reply),
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