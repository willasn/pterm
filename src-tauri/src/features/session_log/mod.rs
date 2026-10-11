//! 会话日志（FEATURES.md §3）。
//!
//! 把每个会话的终端输出按会话落盘，供事后查阅。
//!
//! 设计要点：
//! - 落盘发生在 SSH 核心的数据泵里（经由 [`crate::ssh::session::OutputSink`] 抽象），
//!   与前端渲染完全解耦：前端卡顿或标签关闭都不会丢日志。
//! - 一个会话一个文件，跨自动重连复用同一文件，命名为 `本地时间-会话名.log`。
//! - 模块关闭时正在记录的会话立即停止写入（`enabled` 置 false 而非删文件）。
//! - 过期清理按「保留天数」在模块初始化时执行一次；置 0 表示不清理。

use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use parking_lot::Mutex;
use serde::Serialize;

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::error::{AppError, AppResult};
use crate::modules::ModuleContext;
use crate::ssh::session::{OutputSink, SessionLogger};
use crate::ssh::types::SessionInfo;

pub mod commands;

/// 文件名中允许保留的最大字符数。
const NAME_LIMIT: usize = 48;

// ---------------------------------------------------------------------------
// 单个会话的日志文件
// ---------------------------------------------------------------------------

/// 单个会话的日志写入端。
///
/// `&File` 也实现了 [`Write`]，因此 [`OutputSink::append`] 可以用 `&self` 接收者，
/// 会话线程无需额外加锁即可持续追加。
struct LogFile {
    path: PathBuf,
    file: File,
    written: AtomicU64,
    /// 模块被关闭 / 会话结束后置 false，之后不再接受写入
    enabled: AtomicBool,
}

impl LogFile {
    fn create(path: PathBuf) -> AppResult<Self> {
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self {
            path,
            file,
            written: AtomicU64::new(0),
            enabled: AtomicBool::new(true),
        })
    }

    fn name(&self) -> String {
        self.path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

impl OutputSink for LogFile {
    fn append(&self, _stream: &str, bytes: &[u8]) {
        if bytes.is_empty() || !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        // `File` 无用户态缓冲，write_all 直接落到内核，因此无需 flush。
        let mut file = &self.file;
        match file.write_all(bytes) {
            Ok(()) => {
                self.written.fetch_add(bytes.len() as u64, Ordering::Relaxed);
            }
            Err(e) => log::warn!("写入会话日志 {} 失败：{e}", self.path.display()),
        }
    }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

/// 供前端展示的日志文件条目。
#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub name: String,
    pub size: u64,
    /// 最后修改时间（RFC3339，本地时区）
    pub modified: String,
    /// 该文件对应的会话是否仍在记录中
    pub active: bool,
}

/// 会话日志服务。命令层与模块层共用同一实例。
#[derive(Clone)]
pub struct SessionLog {
    dir: PathBuf,
    active: Arc<Mutex<HashMap<String, Arc<LogFile>>>>,
}

impl SessionLog {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn active_count(&self) -> usize {
        self.active.lock().len()
    }

    /// 停止记录全部会话（不删除已落盘文件）。
    pub fn close_all(&self) {
        let files: Vec<Arc<LogFile>> = self.active.lock().drain().map(|(_, f)| f).collect();
        for file in files {
            file.enabled.store(false, Ordering::Relaxed);
        }
    }

    /// 删除超过保留天数的日志。`retention_days = 0` 表示不清理。
    pub fn cleanup_expired(&self, retention_days: u32) {
        if retention_days == 0 {
            return;
        }
        let max_age = Duration::from_secs(u64::from(retention_days) * 86_400);
        let now = SystemTime::now();
        let entries = match std::fs::read_dir(&self.dir) {
            Ok(e) => e,
            Err(e) => {
                log::warn!("读取会话日志目录失败：{e}");
                return;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !is_log_file(&path) {
                continue;
            }
            let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
                continue;
            };
            // 时钟回拨等异常情况下 age 可能算不出，此时跳过而不是误删
            if now.duration_since(modified).unwrap_or_default() <= max_age {
                continue;
            }
            match std::fs::remove_file(&path) {
                Ok(()) => log::info!("已清理过期会话日志 {}", path.display()),
                Err(e) => log::warn!("删除过期会话日志 {} 失败：{e}", path.display()),
            }
        }
    }

    /// 列出全部日志文件，最新的在前。
    pub fn list(&self) -> AppResult<Vec<LogEntry>> {
        let active_names: HashSet<String> = self
            .active
            .lock()
            .values()
            .map(|f| f.name())
            .collect();

        let mut out = Vec::new();
        for entry in std::fs::read_dir(&self.dir)? {
            let entry = entry?;
            let path = entry.path();
            if !is_log_file(&path) {
                continue;
            }
            let meta = entry.metadata()?;
            if !meta.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let modified = meta
                .modified()
                .ok()
                .map(|t| chrono::DateTime::<chrono::Local>::from(t).to_rfc3339())
                .unwrap_or_default();
            out.push(LogEntry {
                active: active_names.contains(name),
                name: name.to_string(),
                size: meta.len(),
                modified,
            });
        }
        out.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(out)
    }

    /// 读取日志尾部内容。`max_bytes` 为 0 时按默认上限截断。
    pub fn read(&self, name: &str, max_bytes: usize) -> AppResult<String> {
        let path = self.resolve(name)?;
        let data = std::fs::read(&path)?;
        let limit = if max_bytes == 0 { 64 * 1024 } else { max_bytes };
        let take = data.len().min(limit);
        let slice = &data[data.len() - take..];
        Ok(String::from_utf8_lossy(slice).into_owned())
    }

    /// 清空全部日志文件，返回删除数量。正在记录的会话会继续写入新文件之前
    /// 的旧文件已不存在，但句柄仍有效（类 Unix 下文件被 unlink 后依旧可写）。
    pub fn clear(&self) -> AppResult<usize> {
        let mut removed = 0usize;
        for entry in std::fs::read_dir(&self.dir)?.flatten() {
            let path = entry.path();
            if !is_log_file(&path) {
                continue;
            }
            match std::fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(e) => log::warn!("删除会话日志 {} 失败：{e}", path.display()),
            }
        }
        Ok(removed)
    }

    /// 把前端传来的文件名解析为目录内的绝对路径，拒绝任何目录穿越。
    fn resolve(&self, name: &str) -> AppResult<PathBuf> {
        if name.is_empty()
            || name.contains('/')
            || name.contains('\\')
            || name.contains("..")
            || Path::new(name).components().count() != 1
        {
            return Err(AppError::Config("非法的日志文件名".into()));
        }
        let path = self.dir.join(name);
        if !path.is_file() {
            return Err(AppError::Config(format!("日志文件不存在：{name}")));
        }
        Ok(path)
    }

    /// 生成不会与既有文件冲突的日志路径。
    fn allocate_path(&self, session_name: &str) -> PathBuf {
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let base = format!("{stamp}-{}", safe_name(session_name));
        let mut path = self.dir.join(format!("{base}.log"));
        let mut seq = 2;
        while path.exists() {
            path = self.dir.join(format!("{base}-{seq}.log"));
            seq += 1;
        }
        path
    }
}

impl SessionLogger for SessionLog {
    fn open(&self, info: &SessionInfo) -> Option<Arc<dyn OutputSink>> {
        let path = self.allocate_path(&info.name);
        match LogFile::create(path) {
            Ok(file) => {
                let file = Arc::new(file);
                self.active.lock().insert(info.id.clone(), file.clone());
                log::info!("会话 {} 的日志已写入 {}", info.id, file.path.display());
                Some(file as Arc<dyn OutputSink>)
            }
            Err(e) => {
                log::warn!("为会话 {} 创建日志文件失败：{e}", info.id);
                None
            }
        }
    }

    fn close(&self, session_id: &str) {
        let file = self.active.lock().remove(session_id);
        if let Some(file) = file {
            file.enabled.store(false, Ordering::Relaxed);
        }
    }
}

// ---------------------------------------------------------------------------
// 模块
// ---------------------------------------------------------------------------

/// 会话日志模块。启用时准备目录并清理过期日志。
pub struct SessionLogModule {
    service: SessionLog,
}

impl SessionLogModule {
    pub fn new(service: SessionLog) -> Self {
        Self { service }
    }
}

impl PluggableModule for SessionLogModule {
    fn id(&self) -> &'static str {
        module_id::SESSION_LOG
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.connection.session_log
    }

    fn init(&self, ctx: &ModuleContext) -> AppResult<()> {
        std::fs::create_dir_all(&self.service.dir)?;
        let days = ctx.config.flags().connection.session_log_retention_days;
        self.service.cleanup_expired(days);
        log::info!(
            "会话日志已启用：目录 {}，保留 {days} 天",
            self.service.dir.display()
        );
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

fn is_log_file(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()) == Some("log")
}

/// 把会话名转换成安全的文件名片段：保留中英文与数字，其余字符压成下划线。
fn safe_name(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars() {
        if out.chars().count() >= NAME_LIMIT {
            break;
        }
        if ch.is_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "session".to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_name_keeps_cjk_and_replaces_separators() {
        assert_eq!(safe_name("user@host:22"), "user_host_22");
        assert_eq!(safe_name("  生产服务器  "), "生产服务器");
        assert_eq!(safe_name(""), "session");
    }

    #[test]
    fn resolve_rejects_path_traversal() {
        let dir = std::env::temp_dir().join("pterm-session-log-test");
        let service = SessionLog::new(dir);
        assert!(service.resolve("../config.yaml").is_err());
        assert!(service.resolve("a/b.log").is_err());
        assert!(service.resolve("..").is_err());
    }
}