//! 连接导入导出对外命令。
//!
//! 读写文件会阻塞磁盘，因此导出 / 导入放进 `spawn_blocking`；
//! 默认路径只读环境信息，保持同步。

use tauri::State;

use crate::config::feature_flags::module_id;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::{
    export_file, format_name, home_dir_text, import_into, normalize_path, parse_pterm,
    parse_ssh_config, resolve_format, ssh_config_path, write_export, ExportReport,
    ImportExportDefaults, ImportFormat, ImportReport,
};

/// 导出连接配置到 JSON 文件。`ids` 为空或未提供时导出全部连接。
/// **导出内容永不包含凭据**，只含主机、端口、用户名、认证方式等非敏感字段。
#[tauri::command]
pub async fn connection_export(
    state: State<'_, AppState>,
    path: String,
    ids: Option<Vec<String>>,
) -> AppResult<ExportReport> {
    state.require_module(module_id::IMPORT_EXPORT)?;
    let store = state.store.clone();
    spawn(
        move || {
            let target = normalize_path(&path)?;
            let all = store.list_connections()?;
            let selected: Vec<_> = match ids.filter(|v| !v.is_empty()) {
                Some(ids) => all.into_iter().filter(|c| ids.contains(&c.id)).collect(),
                None => all,
            };
            let file = export_file(&selected);
            let bytes = write_export(&target, &file)?;
            Ok(ExportReport {
                path: target.display().to_string(),
                count: file.connections.len(),
                bytes,
            })
        },
        "导出连接配置",
    )
    .await
}

/// 从文件导入连接。支持 pterm 导出文件与 `~/.ssh/config`，`format` 默认自动识别。
/// 导入一律新建连接，不覆盖已有配置，也不导入任何凭据。
#[tauri::command]
pub async fn connection_import(
    state: State<'_, AppState>,
    path: String,
    format: Option<ImportFormat>,
) -> AppResult<ImportReport> {
    state.require_module(module_id::IMPORT_EXPORT)?;
    let store = state.store.clone();
    spawn(
        move || {
            let target = normalize_path(&path)?;
            let text = std::fs::read_to_string(&target)?;
            let resolved = resolve_format(format.unwrap_or(ImportFormat::Auto), &text);
            let (candidates, warnings) = match resolved {
                ImportFormat::Pterm => parse_pterm(&text)?,
                _ => parse_ssh_config(&text),
            };
            if candidates.is_empty() {
                return Ok(ImportReport {
                    format: format_name(resolved),
                    imported: 0,
                    skipped: 0,
                    warnings,
                    connections: Vec::new(),
                });
            }
            let (imported, skipped, connections) = import_into(&store, candidates)?;
            Ok(ImportReport {
                format: format_name(resolved),
                imported,
                skipped,
                warnings,
                connections,
            })
        },
        "导入连接配置",
    )
    .await
}

/// 默认路径。**不做模块门控**，否则关闭后设置界面无法显示入口与原因。
#[tauri::command]
pub fn import_export_defaults() -> ImportExportDefaults {
    ImportExportDefaults {
        home_dir: home_dir_text(),
        ssh_config_path: ssh_config_path().display().to_string(),
    }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/// 把阻塞任务搬到专用线程池，并把 panic / 取消统一转成配置错误。
async fn spawn<T: Send + 'static>(
    job: impl FnOnce() -> AppResult<T> + Send + 'static,
    label: &str,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| AppError::Config(format!("{label}任务异常结束：{e}")))?
}