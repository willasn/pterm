//! 崩溃日志的查看与导出（FEATURES.md §6）。
//!
//! panic hook 由 [`super::init_logging`] 安装，崩溃信息写入 `paths.crash_log`。
//! 这里只负责把该文件读给用户看、以及另存到用户选定位置（供上报或留档）。
//!
//! 开关关闭时命令返回 `ModuleDisabled`——但文件本身可能存有历史崩溃记录，
//! 因此「读取」仍然按开关门控，与设置界面的显示保持一致。

use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 读取崩溃日志的默认上限：只回传末尾 64 KiB，避免超大文件塞爆前端。
const DEFAULT_TAIL_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct CrashLogInfo {
    pub path: String,
    pub exists: bool,
    /// 文件总字节数
    pub bytes: u64,
    /// 回传内容（超过上限时只含末尾部分）
    pub content: String,
    /// 内容是否被截断
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CrashLogExport {
    pub path: String,
    pub bytes: u64,
}

/// 读取崩溃日志。文件不存在时返回 `exists: false`，不视为错误。
#[tauri::command]
pub fn crash_log_read(
    state: State<'_, AppState>,
    tail_bytes: Option<usize>,
) -> AppResult<CrashLogInfo> {
    require_enabled(&state)?;
    let path = &state.paths.crash_log;

    let data = match std::fs::read(path) {
        Ok(data) => data,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CrashLogInfo {
                path: path.display().to_string(),
                exists: false,
                bytes: 0,
                content: String::new(),
                truncated: false,
            })
        }
        Err(e) => return Err(AppError::Io(e)),
    };

    let limit = tail_bytes.unwrap_or(DEFAULT_TAIL_BYTES);
    let truncated = data.len() > limit;
    let tail = if truncated {
        &data[data.len() - limit..]
    } else {
        &data[..]
    };

    Ok(CrashLogInfo {
        path: path.display().to_string(),
        exists: true,
        bytes: data.len() as u64,
        // 截断点可能落在多字节字符中间，用 lossy 兜底
        content: String::from_utf8_lossy(tail).into_owned(),
        truncated,
    })
}

/// 把崩溃日志另存到指定文件。没有崩溃记录时拒绝导出，避免产出空文件。
#[tauri::command]
pub fn crash_log_export(state: State<'_, AppState>, path: String) -> AppResult<CrashLogExport> {
    require_enabled(&state)?;
    let source = &state.paths.crash_log;
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err(AppError::Config("导出路径不能为空".into()));
    }

    let bytes = std::fs::metadata(source)
        .map(|m| m.len())
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => AppError::Config("暂无崩溃日志可供导出".into()),
            _ => AppError::Io(e),
        })?;
    std::fs::copy(source, &target)?;

    log::info!("已导出崩溃日志到 {}", target.display());
    Ok(CrashLogExport {
        path: target.display().to_string(),
        bytes,
    })
}

/// 开关关闭时，与其它可选功能一致地拒绝执行。
fn require_enabled(state: &State<'_, AppState>) -> AppResult<()> {
    if state.flags().auxiliary.crash_log {
        Ok(())
    } else {
        Err(AppError::ModuleDisabled("崩溃日志".into()))
    }
}

// ---------------------------------------------------------------------------
// 系统剪贴板
//
// macOS 打包后页面运行在 `tauri://` 自定义协议下，WKWebView 不把它视为安全上下文，
// `navigator.clipboard` 往往不存在；Linux 的 WebKitGTK 也可能拒绝读取。终端里的
// 复制 / 粘贴因此统一回退到这里，用 arboard 直接读写系统剪贴板。
// ---------------------------------------------------------------------------

/// Linux 的 X11 剪贴板是「所有者」模型：内容由本进程的线程持续应答，实例销毁后
/// 内容即失效，因此全局复用一个实例（同时用锁串行化访问）。macOS / Windows 的
/// 剪贴板由系统持有，Windows 的实例还与创建线程绑定，按需创建更安全。
#[cfg(target_os = "linux")]
fn with_clipboard<T>(run: impl FnOnce(&mut arboard::Clipboard) -> AppResult<T>) -> AppResult<T> {
    use std::sync::{Mutex, OnceLock};

    static CLIPBOARD: OnceLock<Mutex<arboard::Clipboard>> = OnceLock::new();
    if CLIPBOARD.get().is_none() {
        let clipboard = arboard::Clipboard::new()
            .map_err(|e| AppError::Other(format!("无法访问系统剪贴板：{e}")))?;
        let _ = CLIPBOARD.set(Mutex::new(clipboard));
    }
    let cell = CLIPBOARD
        .get()
        .ok_or_else(|| AppError::Other("剪贴板初始化失败".into()))?;
    let mut clipboard = cell
        .lock()
        .map_err(|_| AppError::Other("剪贴板状态异常".into()))?;
    run(&mut clipboard)
}

#[cfg(not(target_os = "linux"))]
fn with_clipboard<T>(run: impl FnOnce(&mut arboard::Clipboard) -> AppResult<T>) -> AppResult<T> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| AppError::Other(format!("无法访问系统剪贴板：{e}")))?;
    run(&mut clipboard)
}

/// 读取系统剪贴板文本。剪贴板中没有文本（例如只有图片）时返回空串。
#[tauri::command]
pub async fn clipboard_read_text() -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(|| {
        with_clipboard(|clipboard| match clipboard.get_text() {
            Ok(text) => Ok(text),
            Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
            Err(e) => Err(AppError::Other(format!("读取剪贴板失败：{e}"))),
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("读取剪贴板失败：{e}")))?
}

/// 写入系统剪贴板文本。
#[tauri::command]
pub async fn clipboard_write_text(text: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        with_clipboard(|clipboard| {
            clipboard
                .set_text(text)
                .map_err(|e| AppError::Other(format!("写入剪贴板失败：{e}")))
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("写入剪贴板失败：{e}")))?
}
