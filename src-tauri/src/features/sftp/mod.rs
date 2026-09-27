//! SFTP 模块：远程文件浏览与上传、下载、删除、重命名、权限修改
//! （FEATURES.md §3 连接与传输）。
//!
//! 与 SSH 终端会话的关系：`ssh::session::SessionHandle` 不暴露底层
//! `ssh2::Session`，因此 SFTP 为每个连接持有**一条独立的 SSH 连接**，
//! 每次操作都在会话锁的内层作用域中即时构造 `Sftp`。传输与认证完全
//! 复用 SSH 核心，包括跳板机隧道。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use ssh2::{FileStat, Session};

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::error::{AppError, AppResult};
use crate::modules::ModuleContext;
use crate::ssh::auth;
use crate::ssh::jump::JumpTunnel;
use crate::ssh::session::open_transport;
use crate::ssh::types::ConnectParams;

pub mod commands;

/// 上传/下载的读写块大小。
const COPY_BUF: usize = 32 * 1024;

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

/// 一个 SFTP 连接的元信息。命令层与前端都只依赖这个结构，
/// 底层 `ssh2::Session` 不出模块。
#[derive(Debug, Clone, Serialize)]
pub struct SftpInfo {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// 远端初始目录（登录后的家目录）
    pub home: String,
    pub created_at: String,
}

/// 一个远端目录条目。
#[derive(Debug, Clone, Serialize)]
pub struct SftpEntry {
    pub name: String,
    /// 绝对路径，供下载/删除/重命名直接使用
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// 权限位（低 12 位，例如 0o644）
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    /// 修改时间（Unix 秒）
    pub modified: Option<i64>,
}

/// 目录浏览结果。`path` 是 `realpath` 解析后的绝对路径，
/// 前端用它回填路径栏（相对路径、`~`、符号链接都会被规整）。
#[derive(Debug, Clone, Serialize)]
pub struct SftpListing {
    pub path: String,
    pub entries: Vec<SftpEntry>,
}

// ---------------------------------------------------------------------------
// 连接句柄
// ---------------------------------------------------------------------------

struct SftpHandle {
    info: SftpInfo,
    /// 会话是阻塞模式：每次操作独占持锁，避免多线程交叉使用同一会话
    session: Mutex<Session>,
    /// 跳板机隧道。为 `None` 表示直连；必须与 `session` 同生命周期，
    /// 否则隧道端口关闭会让底层 TCP 连接失效。
    _tunnel: Option<JumpTunnel>,
}

impl SftpHandle {
    /// 在会话锁内打开 SFTP 通道执行操作。
    fn with_sftp<T>(&self, f: impl FnOnce(&ssh2::Sftp) -> AppResult<T>) -> AppResult<T> {
        let sess = self.session.lock();
        let sftp = sess
            .sftp()
            .map_err(|e| AppError::Sftp(format!("打开 SFTP 通道失败：{e}")))?;
        f(&sftp)
    }
}

// ---------------------------------------------------------------------------
// 会话表
// ---------------------------------------------------------------------------

/// SFTP 会话管理。与 [`crate::ssh::session::SessionManager`] 独立：
/// 终端连接与文件连接互不影响，关掉终端不会打断正在进行的传输。
#[derive(Clone, Default)]
pub struct SftpManager {
    sessions: Arc<Mutex<HashMap<String, Arc<SftpHandle>>>>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 建立独立的 SFTP 连接。阻塞调用，调用方需放在 `spawn_blocking` 中。
    pub fn connect(&self, params: ConnectParams) -> AppResult<SftpInfo> {
        if params.host.trim().is_empty() {
            return Err(AppError::Config("未填写主机地址".into()));
        }
        if params.username.trim().is_empty() {
            return Err(AppError::Config("未填写用户名".into()));
        }

        // 跳板机复用 SSH 核心的本地隧道：SFTP 侧只需连接本机端口
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
        let method = auth::authenticate(&sess, &params)?;

        // 家目录仅作初始路径，取不到就退回根目录，不阻断连接
        let home = sess
            .sftp()
            .ok()
            .and_then(|sftp| sftp.realpath(Path::new(".")).ok())
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "/".to_string());

        let info = SftpInfo {
            id: format!("sftp-{}", uuid::Uuid::new_v4()),
            name: match &params.name {
                Some(n) if !n.trim().is_empty() => n.clone(),
                _ => params.endpoint(),
            },
            host: params.host.clone(),
            port: params.port,
            username: params.username.clone(),
            home,
            created_at: chrono::Local::now().to_rfc3339(),
        };

        let handle = Arc::new(SftpHandle {
            info: info.clone(),
            session: Mutex::new(sess),
            _tunnel: tunnel,
        });
        self.sessions.lock().insert(info.id.clone(), handle);
        log::info!("SFTP 会话已建立：{}（{method}）", info.id);
        Ok(info)
    }

    /// 关闭一个 SFTP 连接。可重复调用。
    pub fn disconnect(&self, id: &str) -> AppResult<()> {
        if self.sessions.lock().remove(id).is_none() {
            return Err(AppError::Sftp(format!("SFTP 会话不存在：{id}")));
        }
        // 句柄的 `Drop` 关闭隧道；会话本身随最后一个 Arc 释放
        log::info!("SFTP 会话已关闭：{id}");
        Ok(())
    }

    /// 所有活跃 SFTP 连接快照。
    pub fn list_sessions(&self) -> Vec<SftpInfo> {
        let mut out: Vec<SftpInfo> = self
            .sessions
            .lock()
            .values()
            .map(|h| h.info.clone())
            .collect();
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        out
    }

    /// 退出前关闭全部连接。
    pub fn close_all(&self) {
        let count = self.sessions.lock().len();
        self.sessions.lock().clear();
        if count > 0 {
            log::info!("已关闭 {count} 个 SFTP 会话");
        }
    }

    /// 浏览目录。`path` 为空或 `.` 时解析为家目录。
    pub fn list(&self, id: &str, path: &str) -> AppResult<SftpListing> {
        let handle = self.handle(id)?;
        let target = {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                handle.info.home.clone()
            } else {
                trimmed.to_string()
            }
        };
        handle.with_sftp(|sftp| {
            let dir = sftp
                .realpath(Path::new(&target))
                .map_err(|e| AppError::Sftp(format!("无法解析路径 {target}：{e}")))?;
            let raw = sftp
                .readdir(&dir)
                .map_err(|e| AppError::Sftp(format!("读取目录失败：{e}")))?;

            let mut entries: Vec<SftpEntry> = raw
                .into_iter()
                .filter_map(|(p, stat)| {
                    let name = p.file_name()?.to_str()?.to_string();
                    Some(entry_from(p.display().to_string(), name, &stat))
                })
                .collect();
            // 目录优先，其次按名称不区分大小写排序
            entries.sort_by(|a, b| {
                b.is_dir
                    .cmp(&a.is_dir)
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            });

            Ok(SftpListing {
                path: dir.display().to_string(),
                entries,
            })
        })
    }

    /// 下载远端文件到本地路径，返回写入字节数。
    pub fn download(&self, id: &str, remote: &str, local: &str) -> AppResult<u64> {
        let handle = self.handle(id)?;
        let remote = require_path(remote, "远端路径")?;
        let local = require_path(local, "本地路径")?;
        handle.with_sftp(|sftp| {
            let stat = sftp
                .lstat(Path::new(&remote))
                .map_err(|e| AppError::Sftp(format!("无法读取 {remote}：{e}")))?;
            if stat.is_dir() {
                return Err(AppError::Sftp("暂不支持下载目录".into()));
            }
            let mut src = sftp
                .open(Path::new(&remote))
                .map_err(|e| AppError::Sftp(format!("打开远端文件失败：{e}")))?;
            let mut dst = std::fs::File::create(&local)?;
            let total = copy_stream(&mut src, &mut dst)
                .map_err(|e| AppError::Sftp(format!("下载 {remote} 失败：{e}")))?;
            dst.flush()?;
            Ok(total)
        })
    }

    /// 上传本地文件到远端路径，返回写入字节数。
    pub fn upload(&self, id: &str, local: &str, remote: &str) -> AppResult<u64> {
        let handle = self.handle(id)?;
        let local = require_path(local, "本地路径")?;
        let remote = require_path(remote, "远端路径")?;
        handle.with_sftp(|sftp| {
            let mut src = std::fs::File::open(&local)?;
            let mut dst = sftp
                .create(Path::new(&remote))
                .map_err(|e| AppError::Sftp(format!("创建远端文件失败：{e}")))?;
            let total = copy_stream(&mut src, &mut dst)
                .map_err(|e| AppError::Sftp(format!("上传到 {remote} 失败：{e}")))?;
            dst.flush()?;
            Ok(total)
        })
    }

    /// 删除远端文件或空目录（按远端实际类型决定调用哪条 SFTP 指令）。
    pub fn delete(&self, id: &str, path: &str) -> AppResult<()> {
        let handle = self.handle(id)?;
        let path = require_path(path, "远端路径")?;
        handle.with_sftp(|sftp| {
            let stat = sftp
                .lstat(Path::new(&path))
                .map_err(|e| AppError::Sftp(format!("无法读取 {path}：{e}")))?;
            if stat.is_dir() {
                sftp.rmdir(Path::new(&path))
                    .map_err(|e| AppError::Sftp(format!("删除目录失败（目录需为空）：{e}")))?;
            } else {
                sftp.unlink(Path::new(&path))
                    .map_err(|e| AppError::Sftp(format!("删除文件失败：{e}")))?;
            }
            Ok(())
        })
    }

    /// 重命名 / 移动。
    pub fn rename(&self, id: &str, from: &str, to: &str) -> AppResult<()> {
        let handle = self.handle(id)?;
        let from = require_path(from, "原路径")?;
        let to = require_path(to, "新路径")?;
        handle.with_sftp(|sftp| {
            sftp.rename(Path::new(&from), Path::new(&to), None)
                .map_err(|e| AppError::Sftp(format!("重命名失败：{e}")))
        })
    }

    /// 修改权限位。`mode` 只取低 12 位（含 setuid/setgid/sticky）。
    pub fn chmod(&self, id: &str, path: &str, mode: u32) -> AppResult<()> {
        let handle = self.handle(id)?;
        let path = require_path(path, "远端路径")?;
        let perm = mode & 0o7777;
        handle.with_sftp(|sftp| {
            let stat = FileStat {
                size: None,
                uid: None,
                gid: None,
                perm: Some(perm),
                atime: None,
                mtime: None,
            };
            sftp.setstat(Path::new(&path), stat)
                .map_err(|e| AppError::Sftp(format!("修改权限失败：{e}")))
        })
    }

    fn handle(&self, id: &str) -> AppResult<Arc<SftpHandle>> {
        self.sessions
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::Sftp(format!("SFTP 会话不存在：{id}")))
    }
}

// ---------------------------------------------------------------------------
// 模块
// ---------------------------------------------------------------------------

/// SFTP 模块。连接按需建立，初始化阶段只有一条日志。
pub struct SftpModule {
    service: SftpManager,
}

impl SftpModule {
    pub fn new(service: SftpManager) -> Self {
        Self { service }
    }
}

impl PluggableModule for SftpModule {
    fn id(&self) -> &'static str {
        module_id::SFTP
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.connection.sftp
    }

    fn init(&self, _ctx: &ModuleContext) -> AppResult<()> {
        log::info!("SFTP 已启用：远程文件浏览与传输");
        Ok(())
    }

    fn dispose(&self) -> AppResult<()> {
        self.service.close_all();
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

fn entry_from(path: String, name: String, stat: &FileStat) -> SftpEntry {
    SftpEntry {
        name,
        path,
        is_dir: stat.is_dir(),
        is_symlink: stat.file_type().is_symlink(),
        size: stat.size.unwrap_or(0),
        mode: stat.perm.unwrap_or(0) & 0o7777,
        uid: stat.uid.unwrap_or(0),
        gid: stat.gid.unwrap_or(0),
        modified: stat.mtime.map(|v| v as i64),
    }
}

fn require_path(raw: &str, label: &str) -> AppResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Config(format!("{label}不能为空")));
    }
    Ok(trimmed.to_string())
}

/// 双向复制，返回总字节数。读返回 0 视为结束。
fn copy_stream(src: &mut impl Read, dst: &mut impl Write) -> std::io::Result<u64> {
    let mut buf = vec![0u8; COPY_BUF];
    let mut total = 0u64;
    loop {
        let n = src.read(&mut buf)?;
        if n == 0 {
            return Ok(total);
        }
        dst.write_all(&buf[..n])?;
        total += n as u64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn require_path_trims_and_rejects_empty() {
        assert_eq!(require_path("  /tmp/a  ", "远端路径").unwrap(), "/tmp/a");
        assert!(require_path("   ", "远端路径").is_err());
    }

    #[test]
    fn chmod_masks_to_permission_bits() {
        // 只保留低 12 位，高位（文件类型）被丢弃
        assert_eq!(0o10_0644 & 0o7777, 0o644);
    }
}