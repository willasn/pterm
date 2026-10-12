//! 自动更新对外命令。
//!
//! 更新检查与安装都放在 Rust 侧：前端不直接访问底层，且 WebView 的 CSP 不放行
//! 外部 origin。
//!
//! 这两条命令**不受 `auto_update` 开关门控**：该开关只控制前端「启动后自动检查 +
//! 自动弹提示条」的行为，用户始终可以主动手动检查。关掉自动更新不应连带剥夺
//! 手动检查更新的能力（FEATURES.md §6）。

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::error::{AppError, AppResult};

/// 下载进度事件名，前端经 `ipc.listen` 订阅。命名沿用「模块:事件」约定。
pub const UPDATE_PROGRESS_EVENT: &str = "update:progress";

/// 更新检查结果。`has_update` 为 false 时其余字段均为 `None`。
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub has_update: bool,
    /// 当前运行版本
    pub current: String,
    /// 远端最新版本
    pub latest: Option<String>,
    /// 更新说明（Release notes）
    pub notes: Option<String>,
    /// 发布时间（Unix 秒），由前端按本地时区格式化
    pub published_at: Option<i64>,
}

/// 下载进度负载。`chunk` 是本次回调新增的字节数，由前端累加；`total` 未知时为 `None`。
#[derive(Debug, Clone, Serialize)]
pub struct ProgressPayload {
    pub chunk: u64,
    pub total: Option<u64>,
}

fn update_error(e: tauri_plugin_updater::Error) -> AppError {
    AppError::Other(format!("更新失败：{e}"))
}

/// 检查是否有新版本。只查询、不下载。
#[tauri::command]
pub async fn auto_update_check(app: AppHandle) -> AppResult<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let update = app
        .updater()
        .map_err(update_error)?
        .check()
        .await
        .map_err(update_error)?;
    Ok(match update {
        Some(update) => UpdateInfo {
            has_update: true,
            current: update.current_version.clone(),
            latest: Some(update.version.clone()),
            notes: update.body.clone(),
            published_at: update.date.map(|date| date.unix_timestamp()),
        },
        None => UpdateInfo {
            has_update: false,
            current,
            latest: None,
            notes: None,
            published_at: None,
        },
    })
}

/// 下载并安装更新，完成后重启应用。下载进度经 [`UPDATE_PROGRESS_EVENT`] 事件回传。
///
/// 这里重新 `check()` 一次而不是复用上次检查的结果：检查本身很轻，而缓存
/// 待安装句柄需要额外的托管状态，收益不值这个复杂度。
#[tauri::command]
pub async fn auto_update_install(app: AppHandle) -> AppResult<()> {
    let update = app
        .updater()
        .map_err(update_error)?
        .check()
        .await
        .map_err(update_error)?
        .ok_or_else(|| AppError::Other("当前已是最新版本，无需更新".into()))?;

    let emitter = app.clone();
    update
        .download_and_install(
            move |chunk_length, content_length| {
                let _ = emitter.emit(
                    UPDATE_PROGRESS_EVENT,
                    ProgressPayload {
                        chunk: chunk_length as u64,
                        total: content_length,
                    },
                );
            },
            || {},
        )
        .await
        .map_err(update_error)?;

    log::info!("更新已安装，正在重启应用");
    app.restart();
}
