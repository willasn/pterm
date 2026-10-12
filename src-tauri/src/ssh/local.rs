//! 本地终端会话运行器。
//!
//! 在用户本机起一个 PTY（Unix 走 pty，Windows 走 ConPTY），把 `$SHELL` / `cmd` 作为
//! 交互式 shell 拉起，并复用与 SSH 完全相同的会话事件通道（`ssh:data:{id}` 等）与
//! 命令通道（`SessionCommand`）。因此前端终端、标签、分屏等无需感知「本地」与「SSH」的差异。
//!
//! 会话生命周期：PTY 退出即会话结束，不自动重连。

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::AppHandle;

use crate::error::{AppError, AppResult};

use super::channel::{self, push_recent};
use super::session::OutputSink;
use super::types::{SessionCommand, ShellEnd};

/// 空闲轮询间隔
const IDLE_SLEEP: Duration = Duration::from_millis(15);
const READ_BUF: usize = 32 * 1024;

/// 打开本地 shell 并持续泵数据，直到远端（本机 shell）退出或用户关闭。
pub fn run_local(
    app: AppHandle,
    id: String,
    cols: u32,
    rows: u32,
    rx: &Receiver<SessionCommand>,
    cancel: &AtomicBool,
    recent: Arc<Mutex<VecDeque<u8>>>,
    sink: Option<Arc<dyn OutputSink>>,
) -> AppResult<ShellEnd> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: rows.clamp(1, u16::MAX as u32) as u16,
            cols: cols.clamp(1, u16::MAX as u32) as u16,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Other(format!("无法创建本地终端：{e}")))?;

    let mut cmd = CommandBuilder::new(default_shell());
    cmd.env("TERM", "xterm-256color");
    // 继承常用环境变量，让本地 shell 与系统终端行为一致
    for key in [
        "HOME", "PATH", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR",
        "SYSTEMROOT", "USERPROFILE", "APPDATA", "COMSPEC", "PATHEXT",
    ] {
        if let Ok(value) = std::env::var(key) {
            cmd.env(key, value);
        }
    }
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::Other(format!("无法启动本地 shell：{e}")))?;
    drop(pair.slave);

    let master = pair.master;
    let mut reader = master
        .try_clone_reader()
        .map_err(|e| AppError::Other(format!("无法读取本地终端输出：{e}")))?;
    let mut writer = master
        .take_writer()
        .map_err(|e| AppError::Other(format!("无法写入本地终端：{e}")))?;

    // 终端尺寸变化：把新的行列数下发给 PTY（前台程序据此重排）
    let resize = |cols: u32, rows: u32| {
        let _ = master.resize(PtySize {
            rows: rows.clamp(1, u16::MAX as u32) as u16,
            cols: cols.clamp(1, u16::MAX as u32) as u16,
            pixel_width: 0,
            pixel_height: 0,
        });
    };

    // 读取线程：PTY 输出 -> 事件 + 最近输出缓冲 + 会话日志
    let reader_done = Arc::new(AtomicBool::new(false));
    {
        let app = app.clone();
        let id = id.clone();
        let recent = recent.clone();
        let sink = sink.clone();
        let done = reader_done.clone();
        thread::Builder::new()
            .name("pterm-local-read".into())
            .spawn(move || {
                let mut buf = [0u8; READ_BUF];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            channel::emit_data(&app, &id, "stdout", &buf[..n]);
                            push_recent(&recent, &buf[..n]);
                            if let Some(sink) = &sink {
                                sink.append("stdout", &buf[..n]);
                            }
                        }
                        Err(_) => break,
                    }
                }
                done.store(true, Ordering::Relaxed);
            })
            .map_err(|e| AppError::Other(format!("无法启动本地终端读取线程：{e}")))?;
    }

    let mut pending_input: Vec<u8> = Vec::new();
    let end = loop {
        if cancel.load(Ordering::Relaxed) {
            break ShellEnd {
                clean: true,
                reason: "用户主动断开".into(),
            };
        }

        // 收取前端指令
        let mut want_close = false;
        loop {
            match rx.try_recv() {
                Ok(SessionCommand::Write(data)) => pending_input.extend_from_slice(&data),
                Ok(SessionCommand::Resize { cols, rows }) => {
                    resize(cols, rows);
                }
                Ok(SessionCommand::Close) => {
                    want_close = true;
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
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

        // 发送键盘输入
        if !pending_input.is_empty() {
            match writer.write_all(&pending_input) {
                Ok(()) => {
                    let _ = writer.flush();
                    pending_input.clear();
                }
                Err(e) => return Err(AppError::Other(format!("写入本地终端失败：{e}"))),
            }
        }

        // shell 退出且没有待发输入：结束
        if reader_done.load(Ordering::Relaxed) {
            break ShellEnd {
                clean: true,
                reason: "本地 shell 已退出".into(),
            };
        }

        // 等待输入，避免忙等
        match rx.recv_timeout(IDLE_SLEEP) {
            Ok(SessionCommand::Write(data)) => pending_input.extend_from_slice(&data),
            Ok(SessionCommand::Resize { cols, rows }) => resize(cols, rows),
            Ok(SessionCommand::Close) => {
                break ShellEnd {
                    clean: true,
                    reason: "用户主动断开".into(),
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                break ShellEnd {
                    clean: true,
                    reason: "会话已结束".into(),
                }
            }
        }
    };

    // 收尾：杀掉 shell 让读取线程退出
    let _ = child.kill();
    let _ = child.wait();
    Ok(end)
}

/// 默认 shell：Unix 用 `$SHELL`，Windows 优先 PowerShell、回退 `$COMSPEC`（cmd）。
fn default_shell() -> String {
    #[cfg(windows)]
    {
        which_powershell().unwrap_or_else(|| std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()))
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }
}

#[cfg(windows)]
fn which_powershell() -> Option<String> {
    let path = std::env::var("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        for name in ["pwsh.exe", "powershell.exe"] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

