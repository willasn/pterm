use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::config::app_config::AppConfig;
use crate::config::feature_flags::{module_id, FlagEntry, ModuleStatus};
use crate::config::store::{secrets, StoredConnection};
use crate::error::AppResult;
use crate::state::AppState;

/// 应用信息，供「关于」与设置界面展示。
#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub config_file: String,
    pub database_file: String,
    pub log_dir: String,
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppResult<AppInfo> {
    Ok(AppInfo {
        name: "pshell".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        config_file: state.paths.config_file().display().to_string(),
        database_file: state.paths.database_file().display().to_string(),
        log_dir: state.paths.log_dir.display().to_string(),
    })
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/// 完整配置快照。斜杠命令、快捷键、主题都从这里读取。
#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> AppResult<AppConfig> {
    Ok(state.config.snapshot())
}

/// 保存配置并立即同步模块生命周期。
///
/// 关闭的模块会被 `dispose`，新启用的模块会 `init`——前端随后应重新拉取
/// 模块状态并卸载 / 加载对应 UI。
#[tauri::command]
pub fn save_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: AppConfig,
) -> AppResult<Vec<ModuleStatus>> {
    state.config.replace(config)?;
    let ctx = state.module_context(app);
    state.modules.apply(&ctx)?;
    Ok(state.modules.status(&state.flags()))
}

/// 所有功能开关的扁平化列表（路径 → 当前值）。
#[tauri::command]
pub fn feature_flags(state: State<'_, AppState>) -> AppResult<Vec<FlagEntry>> {
    Ok(state.flags().flatten())
}

/// 可插拔模块的启用 / 初始化状态。
#[tauri::command]
pub fn module_status(state: State<'_, AppState>) -> AppResult<Vec<ModuleStatus>> {
    Ok(state.modules.status(&state.flags()))
}

/// 重置为默认配置（含全部开关）。
#[tauri::command]
pub fn reset_config(app: AppHandle, state: State<'_, AppState>) -> AppResult<AppConfig> {
    let fresh = AppConfig::with_defaults();
    state.config.replace(fresh.clone())?;
    let ctx = state.module_context(app);
    state.modules.apply(&ctx)?;
    Ok(fresh)
}

// ---------------------------------------------------------------------------
// 连接配置
// ---------------------------------------------------------------------------

/// 保存连接时一并提交的敏感字段。
///
/// `password` / `passphrase` / `jump_password` 为 `None` 表示「不修改」，
/// 空串表示「删除」。这些值只会进入系统钥匙串，绝不写入 SQLite 或配置文件。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ConnectionInput {
    pub connection: StoredConnection,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub jump_password: Option<String>,
}

#[tauri::command]
pub fn list_connections(state: State<'_, AppState>) -> AppResult<Vec<StoredConnection>> {
    state.store.list_connections()
}

#[tauri::command]
pub fn save_connection(
    state: State<'_, AppState>,
    input: ConnectionInput,
) -> AppResult<StoredConnection> {
    let mut conn = input.connection;
    let now = chrono::Utc::now().to_rfc3339();

    if conn.name.trim().is_empty() {
        conn.name = if conn.host.is_empty() {
            "新连接".into()
        } else {
            conn.host.clone()
        };
    }
    if conn.id.trim().is_empty() {
        conn.id = uuid::Uuid::new_v4().to_string();
        conn.created_at = now.clone();
    }
    if conn.created_at.trim().is_empty() {
        conn.created_at = now.clone();
    }
    conn.updated_at = now;

    // 敏感字段：只写钥匙串，并在记录上标记是否存在
    conn.has_password = apply_secret(
        &secrets::conn_password_key(&conn.id),
        input.password,
        conn.has_password,
    )?;
    conn.has_passphrase = apply_secret(
        &secrets::conn_passphrase_key(&conn.id),
        input.passphrase,
        conn.has_passphrase,
    )?;
    apply_secret(
        &secrets::jump_password_key(&conn.id),
        input.jump_password,
        false,
    )?;

    state.store.upsert_connection(&conn)?;
    log::info!("已保存连接配置 {}（{}）", conn.name, conn.id);
    Ok(conn)
}

#[tauri::command]
pub fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.store.delete_connection(&id)
}

/// 应用敏感字段变更。返回更新后的「是否已保存」标记。
fn apply_secret(key: &str, value: Option<String>, current: bool) -> AppResult<bool> {
    match value {
        None => Ok(current),
        Some(v) if v.is_empty() => {
            secrets::delete(key)?;
            Ok(false)
        }
        Some(v) => {
            secrets::set(key, &v)?;
            Ok(true)
        }
    }
}

// ---------------------------------------------------------------------------
// AI 模型 API Key（每个模型一把，按模型条目 id 存系统钥匙串）
// ---------------------------------------------------------------------------

/// 已配置 API Key 的模型 id 列表。**不返回 Key 本身**，也不内置任何 Key。
/// 设置界面据此给每个模型标注「已配置 / 未配置」。
#[tauri::command]
pub fn ai_configured_models(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let models = state.config.snapshot().ai.models;
    Ok(models
        .into_iter()
        .filter(|m| {
            matches!(
                secrets::get(&secrets::ai_model_key_key(&m.id)),
                Ok(Some(v)) if !v.is_empty()
            )
        })
        .map(|m| m.id)
        .collect())
}

/// 写入 / 删除某个模型的 API Key。空串表示删除。
#[tauri::command]
pub fn set_ai_model_key(
    state: State<'_, AppState>,
    model_id: String,
    key: String,
) -> AppResult<()> {
    state.require_module(module_id::AI_ASSISTANT)?;
    let key = key.trim();
    if key.is_empty() {
        secrets::delete(&secrets::ai_model_key_key(&model_id))
    } else {
        secrets::set(&secrets::ai_model_key_key(&model_id), key)
    }
}

/// 删除某个模型的 API Key（模型被删除时一并清理）。
#[tauri::command]
pub fn clear_ai_model_key(state: State<'_, AppState>, model_id: String) -> AppResult<()> {
    state.require_module(module_id::AI_ASSISTANT)?;
    secrets::delete(&secrets::ai_model_key_key(&model_id))
}

/// 把旧版的「全局 AI Key」迁移到第一个模型条目，供启动流程调用。
///
/// 幂等：目标模型已有 Key、或旧 Key 不存在时什么都不做。迁移成功后删除旧键，
/// 避免它一直留在钥匙串里；也正因如此，用户之后清空该模型 Key 不会「复活」旧值。
pub fn migrate_legacy_ai_key(cfg: &AppConfig) {
    let Some(model) = cfg.ai.models.first() else {
        return;
    };
    let legacy = match secrets::get(&secrets::legacy_ai_api_key_key()) {
        Ok(Some(v)) if !v.is_empty() => v,
        _ => return,
    };
    // 目标已有 Key 说明用户已经配过新结构，不覆盖
    if matches!(
        secrets::get(&secrets::ai_model_key_key(&model.id)),
        Ok(Some(v)) if !v.is_empty()
    ) {
        return;
    }
    match secrets::set(&secrets::ai_model_key_key(&model.id), &legacy) {
        Ok(()) => {
            let _ = secrets::delete(&secrets::legacy_ai_api_key_key());
            log::info!("已把旧版全局 AI Key 迁移到模型条目");
        }
        Err(e) => log::warn!("迁移旧版 AI Key 失败：{e}"),
    }
}