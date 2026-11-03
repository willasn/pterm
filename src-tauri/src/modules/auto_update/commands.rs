//! 自动更新对外命令。
//!
//! 更新检查与安装都放在 Rust 侧：前端不直接访问底层，且 WebView 的 CSP 不放行
//! 外部 origin。
//!
//! 这两条命令**不受 `auto_update` 开关门控**：该开关只控制前端「启动后自动检查 +
//! 自动弹提示条」的行为，用户始终可以主动手动检查。关掉自动更新不应连带剥夺
//! 手动检查更新的能力（FEATURES.md §6）。

use std::time::Duration;

use futures_util::future::join_all;
use semver::Version;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{AppError, AppResult};

/// 下载进度事件名，前端经 `ipc.listen` 订阅。命名沿用「模块:事件」约定。
pub const UPDATE_PROGRESS_EVENT: &str = "update:progress";

/// 单个更新源的检查超时时间。
const CHECK_TIMEOUT: Duration = Duration::from_secs(4);

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

/// 读取 `tauri.conf.json` 中 `plugins.updater.endpoints` 配置的全部更新源。
fn configured_endpoints(app: &AppHandle) -> Vec<Url> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("endpoints"))
        .and_then(Value::as_array)
        .map(|endpoints| {
            endpoints
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|url| Url::parse(url).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// 请求单个更新源的 `latest.json`，返回其中声明的版本号。
///
/// 超时、非 2xx、JSON 解析失败或版本号非法都视为该源不可用，返回 `None`。
async fn probe_endpoint(client: &reqwest::Client, url: &Url) -> Option<Version> {
    let response = client.get(url.clone()).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let manifest: Value = response.json().await.ok()?;
    Version::parse(manifest.get("version")?.as_str()?).ok()
}

/// 并行检查所有更新源，取版本号最大的可用源交由 updater 做正式检查。
///
/// 并行探测只用来挑源：真正解析平台信息、校验版本是否比当前新仍走 updater 本身。
async fn resolve_update(app: &AppHandle) -> AppResult<Option<Update>> {
    let client = reqwest::Client::builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| AppError::Other(format!("更新检查失败：{e}")))?;

    let probes = configured_endpoints(app).into_iter().map(|url| {
        let client = client.clone();
        async move {
            let version = probe_endpoint(&client, &url).await;
            (url, version)
        }
    });

    let mut candidates: Vec<(Version, Url)> = join_all(probes)
        .await
        .into_iter()
        .filter_map(|(url, version)| version.map(|version| (version, url)))
        .collect();

    if candidates.is_empty() {
        return Err(AppError::Other("更新检查失败：所有更新源均不可用".into()));
    }

    // 版本号降序：优先用最新的那份清单。
    candidates.sort_by(|a, b| b.0.cmp(&a.0));

    let mut last_error: Option<tauri_plugin_updater::Error> = None;
    for (_, url) in candidates {
        // 检查请求同样限时；拿到结果后清掉超时，避免 4 秒限制到后续的安装包下载。
        let updater = app
            .updater_builder()
            .endpoints(vec![url])
            .map_err(update_error)?
            .timeout(CHECK_TIMEOUT)
            .build()
            .map_err(update_error)?;

        match updater.check().await {
            Ok(Some(mut update)) => {
                update.timeout = None;
                return Ok(Some(update));
            }
            Ok(None) => return Ok(None),
            Err(err) => last_error = Some(err),
        }
    }

    Err(last_error
        .map(update_error)
        .unwrap_or_else(|| AppError::Other("更新检查失败：所有更新源均不可用".into())))
}

/// 检查是否有新版本。只查询、不下载。
#[tauri::command]
pub async fn auto_update_check(app: AppHandle) -> AppResult<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let update = resolve_update(&app).await?;
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
    let update = resolve_update(&app)
        .await?
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
