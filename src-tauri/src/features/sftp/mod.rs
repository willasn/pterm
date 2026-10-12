//! SFTP 模块：远程文件浏览与上传、下载、删除、重命名、权限修改
//! （FEATURES.md §3 连接与传输）。
//!
//! 与 SSH 终端会话的关系：`ssh::session::SessionHandle` 不暴露底层
//! `ssh2::Session`，因此 SFTP 为每个连接持有**一条独立的 SSH 连接**，
//! 每次操作都在会话锁的内层作用域中即时构造 `Sftp`。传输与认证完全
//! 复用 SSH 核心，包括跳板机隧道。

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use ssh2::{FileStat, Session};

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::error::{AppError, AppResult};
use crate::modules::ModuleContext;
use crate::ssh::auth;
use crate::ssh::jump::JumpTunnel;
use crate::ssh::known_hosts;
use crate::ssh::session::open_transport;
use crate::ssh::types::ConnectParams;

pub mod commands;

/// 上传/下载的读写块大小。
const COPY_BUF: usize = 32 * 1024;

/// 进度上报的最小间隔：每个读写块都发事件会把 IPC 打满，按时间节流即可。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);

/// 传输被用户中断时的统一错误文案，前端据此区分「中断」与「失败」。
const CANCELLED: &str = "传输已取消";

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
    /// 在途传输的取消标志，键为前端生成的 transferId。传输任务每读一块都会
    /// 检查它，因此不依赖会话锁，取消命令可以随时生效。
    transfers: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
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
            Some(spec) if !spec.host.trim().is_empty() => Some(JumpTunnel::open(
                spec,
                &params.host,
                params.port,
                0,
                None,
                Some(params.host_key_policy),
            )?),
            _ => None,
        };
        let (host, port) = match &tunnel {
            Some(t) => ("127.0.0.1".to_string(), t.local_port()),
            None => (params.host.clone(), params.port),
        };

        let sess = open_transport(&host, port)?;
        // 主机密钥校验：SFTP 无法弹窗确认，未确认 / 变更时给出可操作提示
        known_hosts::verify_session_strict(&sess, &params.host, params.port, params.host_key_policy)?;
        let method = auth::authenticate(&sess, &params, None)?;

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

    /// 退出前关闭全部连接，并中断所有在途传输。
    pub fn close_all(&self) {
        for flag in self.transfers.lock().values() {
            flag.store(true, Ordering::SeqCst);
        }
        self.transfers.lock().clear();
        let count = self.sessions.lock().len();
        self.sessions.lock().clear();
        if count > 0 {
            log::info!("已关闭 {count} 个 SFTP 会话");
        }
    }

    /// 登记一次在途传输，返回其取消标志。前端在调用上传/下载前生成 transferId。
    pub fn begin_transfer(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.transfers.lock().insert(id.to_string(), flag.clone());
        flag
    }

    /// 请求中断一次传输。返回是否命中在途传输（已结束的传输返回 false）。
    pub fn cancel_transfer(&self, id: &str) -> bool {
        match self.transfers.lock().get(id) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    /// 传输结束后注销（成功、失败、中断都要调用）。
    pub fn end_transfer(&self, id: &str) {
        self.transfers.lock().remove(id);
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

    /// 下载远端文件或目录到本地路径，返回写入字节数。
    /// 目录按远端原结构递归创建；`cancel` 置位时尽快中断并清掉半成品。
    /// 进度以「整个传输的已写字节 / 总字节」回调，目录的总量为全部文件之和。
    pub fn download(
        &self,
        id: &str,
        remote: &str,
        local: &str,
        cancel: &AtomicBool,
        on_progress: &mut dyn FnMut(u64, u64),
    ) -> AppResult<u64> {
        let handle = self.handle(id)?;
        let remote = require_path(remote, "远端路径")?;
        let local = require_path(local, "本地路径")?;
        handle.with_sftp(|sftp| {
            let stat = sftp
                .lstat(Path::new(&remote))
                .map_err(|e| AppError::Sftp(format!("无法读取 {remote}：{e}")))?;
            if stat.is_dir() {
                download_tree(
                    sftp,
                    Path::new(&remote),
                    Path::new(&local),
                    cancel,
                    &mut *on_progress,
                )
            } else {
                copy_remote_file(
                    sftp,
                    Path::new(&remote),
                    Path::new(&local),
                    stat.size.unwrap_or(0),
                    cancel,
                    &mut *on_progress,
                )
            }
        })
    }

    /// 上传本地文件或目录到远端路径，返回写入字节数。目录同样递归创建。
    pub fn upload(
        &self,
        id: &str,
        local: &str,
        remote: &str,
        cancel: &AtomicBool,
        on_progress: &mut dyn FnMut(u64, u64),
    ) -> AppResult<u64> {
        let handle = self.handle(id)?;
        let local = require_path(local, "本地路径")?;
        let remote = require_path(remote, "远端路径")?;
        handle.with_sftp(|sftp| {
            let meta = std::fs::metadata(&local)?;
            if meta.is_dir() {
                upload_tree(
                    sftp,
                    Path::new(&local),
                    Path::new(&remote),
                    cancel,
                    &mut *on_progress,
                )
            } else {
                copy_local_file(
                    sftp,
                    Path::new(&local),
                    Path::new(&remote),
                    meta.len(),
                    cancel,
                    &mut *on_progress,
                )
            }
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

/// 远端路径拼接。远端始终是 Unix 风格，不能用 `Path::join`：
/// Windows 宿主上 `join` 会写入 `\` 分隔符，服务端无法解析。
fn remote_join(dir: &Path, name: &str) -> PathBuf {
    let base = dir.to_string_lossy();
    PathBuf::from(format!("{}/{name}", base.trim_end_matches('/')))
}

fn cancelled() -> AppError {
    AppError::Sftp(CANCELLED.into())
}

/// 区分「用户中断」与普通 IO 错误：前者对用户不是错误，只是取消。
fn transfer_error(e: std::io::Error, label: &str) -> AppError {
    if e.kind() == ErrorKind::Interrupted {
        cancelled()
    } else {
        AppError::Sftp(format!("{label}：{e}"))
    }
}

/// 创建远端目录。已存在时跳过：SFTP 的 mkdir 不会覆盖已有目录。
fn mkdir_remote(sftp: &ssh2::Sftp, dir: &Path) -> AppResult<()> {
    let raw = dir.to_string_lossy();
    if raw.is_empty() || raw == "/" || sftp.lstat(dir).is_ok() {
        return Ok(());
    }
    sftp.mkdir(dir, 0o755)
        .map_err(|e| AppError::Sftp(format!("创建远端目录 {} 失败：{e}", dir.display())))
}

/// 单个远端文件 → 本地文件。中断或失败时清掉半成品，避免留下损坏文件。
fn copy_remote_file(
    sftp: &ssh2::Sftp,
    remote: &Path,
    local: &Path,
    total: u64,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(u64, u64),
) -> AppResult<u64> {
    let mut src = sftp
        .open(remote)
        .map_err(|e| AppError::Sftp(format!("打开远端文件 {} 失败：{e}", remote.display())))?;
    let mut dst = std::fs::File::create(local)?;
    match copy_stream(&mut src, &mut dst, total, cancel, on_progress) {
        Ok(written) => {
            dst.flush()?;
            Ok(written)
        }
        Err(e) => {
            drop(dst);
            let _ = std::fs::remove_file(local);
            Err(transfer_error(e, &format!("下载 {} 失败", remote.display())))
        }
    }
}

/// 单个本地文件 → 远端文件。
fn copy_local_file(
    sftp: &ssh2::Sftp,
    local: &Path,
    remote: &Path,
    total: u64,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(u64, u64),
) -> AppResult<u64> {
    let mut src = std::fs::File::open(local)?;
    let mut dst = sftp
        .create(remote)
        .map_err(|e| AppError::Sftp(format!("创建远端文件 {} 失败：{e}", remote.display())))?;
    match copy_stream(&mut src, &mut dst, total, cancel, on_progress) {
        Ok(written) => {
            dst.flush()?;
            Ok(written)
        }
        Err(e) => {
            drop(dst);
            let _ = sftp.unlink(remote);
            Err(transfer_error(e, &format!("上传到 {} 失败", remote.display())))
        }
    }
}

/// 递归扫描远端目录，收集 `(远端文件, 本地文件, 字节数)`。
/// 目录当场建好；用 readdir 返回的 stat 判类型，符号链接不跟进，避免目录环。
fn collect_remote(
    sftp: &ssh2::Sftp,
    remote: &Path,
    local: &Path,
    out: &mut Vec<(PathBuf, PathBuf, u64)>,
    cancel: &AtomicBool,
) -> AppResult<()> {
    if cancel.load(Ordering::SeqCst) {
        return Err(cancelled());
    }
    let raw = sftp
        .readdir(remote)
        .map_err(|e| AppError::Sftp(format!("读取目录 {} 失败：{e}", remote.display())))?;
    for (path, stat) in raw {
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name,
            None => continue,
        };
        let child = local.join(name);
        if stat.is_dir() {
            std::fs::create_dir_all(&child)?;
            collect_remote(sftp, &path, &child, out, cancel)?;
        } else {
            out.push((path, child, stat.size.unwrap_or(0)));
        }
    }
    Ok(())
}

/// 递归下载目录：先算总量，进度才是「已传 / 全部」而不是单个文件的比例。
fn download_tree(
    sftp: &ssh2::Sftp,
    remote: &Path,
    local: &Path,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(u64, u64),
) -> AppResult<u64> {
    let mut files: Vec<(PathBuf, PathBuf, u64)> = Vec::new();
    collect_remote(sftp, remote, local, &mut files, cancel)?;
    let total: u64 = files.iter().map(|f| f.2).sum();
    std::fs::create_dir_all(local)?;
    let mut done = 0u64;
    on_progress(0, total);
    for (src_path, dst_path, _) in &files {
        if let Some(parent) = dst_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut src = sftp.open(src_path).map_err(|e| {
            AppError::Sftp(format!("打开远端文件 {} 失败：{e}", src_path.display()))
        })?;
        let mut dst = std::fs::File::create(dst_path)?;
        let base = done;
        let result = copy_stream(&mut src, &mut dst, total, cancel, &mut |chunk, _| {
            on_progress(base + chunk, total)
        });
        match result {
            Ok(written) => {
                dst.flush()?;
                done += written;
            }
            Err(e) => {
                drop(dst);
                let _ = std::fs::remove_file(dst_path);
                return Err(transfer_error(e, &format!("下载 {} 失败", src_path.display())));
            }
        }
    }
    on_progress(done, total);
    Ok(done)
}

/// 递归扫描本地目录，收集 `(本地文件, 远端文件, 字节数)`。
fn collect_local(
    local: &Path,
    remote: &Path,
    out: &mut Vec<(PathBuf, PathBuf, u64)>,
    cancel: &AtomicBool,
) -> AppResult<()> {
    if cancel.load(Ordering::SeqCst) {
        return Err(cancelled());
    }
    for entry in std::fs::read_dir(local)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        let name = entry.file_name().to_string_lossy().to_string();
        let child = remote_join(remote, &name);
        if meta.is_dir() {
            collect_local(&entry.path(), &child, out, cancel)?;
        } else {
            out.push((entry.path(), child, meta.len()));
        }
    }
    Ok(())
}

/// 递归上传目录：与下载对称，先算总量再逐个文件传输。
fn upload_tree(
    sftp: &ssh2::Sftp,
    local: &Path,
    remote: &Path,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(u64, u64),
) -> AppResult<u64> {
    let mut files: Vec<(PathBuf, PathBuf, u64)> = Vec::new();
    collect_local(local, remote, &mut files, cancel)?;
    let total: u64 = files.iter().map(|f| f.2).sum();
    mkdir_remote(sftp, remote)?;
    let mut done = 0u64;
    on_progress(0, total);
    for (src_path, dst_path, _) in &files {
        if let Some(parent) = dst_path.parent() {
            mkdir_remote(sftp, parent)?;
        }
        let mut src = std::fs::File::open(src_path)?;
        let mut dst = sftp.create(dst_path).map_err(|e| {
            AppError::Sftp(format!("创建远端文件 {} 失败：{e}", dst_path.display()))
        })?;
        let base = done;
        let result = copy_stream(&mut src, &mut dst, total, cancel, &mut |chunk, _| {
            on_progress(base + chunk, total)
        });
        match result {
            Ok(written) => {
                dst.flush()?;
                done += written;
            }
            Err(e) => {
                drop(dst);
                let _ = sftp.unlink(dst_path);
                return Err(transfer_error(e, &format!("上传到 {} 失败", dst_path.display())));
            }
        }
    }
    on_progress(done, total);
    Ok(done)
}

/// 双向复制，返回总字节数。每块检查取消标志，并按时间节流上报进度。
/// 读返回 0 视为结束；取消时返回 `Interrupted` 供上层识别。
fn copy_stream(
    src: &mut impl Read,
    dst: &mut impl Write,
    total: u64,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(u64, u64),
) -> std::io::Result<u64> {
    let mut buf = vec![0u8; COPY_BUF];
    let mut written = 0u64;
    let mut last = Instant::now();
    on_progress(0, total);
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(std::io::Error::new(ErrorKind::Interrupted, CANCELLED));
        }
        let n = src.read(&mut buf)?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])?;
        written += n as u64;
        if last.elapsed() >= PROGRESS_INTERVAL {
            on_progress(written, total);
            last = Instant::now();
        }
    }
    on_progress(written, total);
    Ok(written)
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