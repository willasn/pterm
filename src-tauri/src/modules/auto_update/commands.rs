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
use tauri::{AppHandle, Emitter, Url};
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

/// 并行探测所有更新源的版本号，返回 `[(version, url)]` 列表（按版本降序）。
///
/// 单个源超时、非 2xx、JSON 解析失败或版本号非法都视为不可用，直接排除。
/// 返回空列表表示所有源都不可用。
async fn probe_endpoints_ordered(app: &AppHandle) -> AppResult<Vec<(Version, Url)>> {
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

    candidates.sort_by(|a, b| b.0.cmp(&a.0));

    Ok(candidates)
}

/// 尝试用 `updater.check()` 获取指定 endpoint 的更新对象。
///
/// 返回 `Ok(Some(update))` 表示该 endpoint 确实有比当前版本新的更新；
/// 返回 `Ok(None)` 表示版本不新（所有 endpoint 都返回 None 则表示当前已最新）；
/// 返回 `Err` 表示该 endpoint 的 manifest 解析失败或网络错误。
async fn check_update_from(
    app: &AppHandle,
    url: Url,
) -> Result<Option<Update>, tauri_plugin_updater::Error> {
    let updater = app
        .updater_builder()
        .endpoints(vec![url])?
        .timeout(CHECK_TIMEOUT)
        .build()?;

    match updater.check().await {
        Ok(Some(mut update)) => {
            update.timeout = None;
            Ok(Some(update))
        }
        other => other,
    }
}

/// 检查是否有新版本。只查询、不下载。
///
/// 遍历所有 endpoint，返回第一个有更新的结果；如果所有 endpoint 都表示「没有更新」，
/// 则返回 `has_update = false`；如果所有 endpoint 都不可用，则返回错误。
#[tauri::command]
pub async fn auto_update_check(app: AppHandle) -> AppResult<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let candidates = probe_endpoints_ordered(&app).await?;

    if candidates.is_empty() {
        return Err(AppError::Other("更新检查失败：所有更新源均不可用".into()));
    }

    let mut last_check_err: Option<tauri_plugin_updater::Error> = None;
    // 是否至少有一个源成功完成了 check（无论结果是有更新还是没更新）
    let mut any_checked_ok = false;

    for (_, url) in candidates {
        match check_update_from(&app, url).await {
            Ok(Some(update)) => {
                return Ok(UpdateInfo {
                    has_update: true,
                    current: update.current_version.clone(),
                    latest: Some(update.version.clone()),
                    notes: update.body.clone(),
                    published_at: update.date.map(|date| date.unix_timestamp()),
                });
            }
            Ok(None) => {
                // 这个源确认没有更新；继续看其他源是否有更高版本
                any_checked_ok = true;
            }
            Err(err) => last_check_err = Some(err),
        }
    }

    // 至少有一个源确认「无更新」→ 视为已是最新
    if any_checked_ok || last_check_err.is_none() {
        return Ok(UpdateInfo {
            has_update: false,
            current,
            latest: None,
            notes: None,
            published_at: None,
        });
    }

    // 所有源都 check 报错
    Err(last_check_err
        .map(update_error)
        .unwrap_or_else(|| AppError::Other("更新检查失败：所有更新源均不可用".into())))
}

/// 下载并安装更新，完成后重启应用。下载进度经 [`UPDATE_PROGRESS_EVENT`] 事件回传。
///
/// 遍历所有 endpoint，依次尝试 `check()` + `download_and_install()`。当某个源的安装包
/// 签名验证失败或下载损坏时，自动回退到下一个源（典型场景：R2 CDN 上某文件被意外
/// 替换/损坏，而 GitHub Release 仍保留正确签名的原始版本）。
#[tauri::command]
pub async fn auto_update_install(app: AppHandle) -> AppResult<()> {
    let candidates = probe_endpoints_ordered(&app).await?;

    if candidates.is_empty() {
        return Err(AppError::Other("更新检查失败：所有更新源均不可用".into()));
    }

    let mut last_install_err: Option<tauri_plugin_updater::Error> = None;
    let mut found_update = false;

    for (_, url) in candidates {
        let update = match check_update_from(&app, url.clone()).await {
            Ok(Some(update)) => update,
            Ok(None) => continue, // 当前已是最新
            Err(err) => {
                last_install_err = Some(err);
                continue;
            }
        };

        found_update = true;
        let emitter = app.clone();
        let install_result = update
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
            .await;

        match install_result {
            Ok(()) => {
                log::info!("更新已安装，正在重启应用");
                app.restart();
            }
            Err(err) => {
                log::warn!(
                    "从更新源 {} 安装失败（{}），尝试下一个源",
                    url,
                    err
                );
                last_install_err = Some(err);
                // 继续尝试下一个 endpoint
            }
        }
    }

    if !found_update {
        return Err(AppError::Other("当前已是最新版本，无需更新".into()));
    }

    Err(last_install_err
        .map(update_error)
        .unwrap_or_else(|| AppError::Other("更新安装失败：所有更新源均不可用".into())))
}
