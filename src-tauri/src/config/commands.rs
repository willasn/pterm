use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::config::app_config::AppConfig;
use crate::config::feature_flags::{module_id, FlagEntry, ModuleStatus};
use crate::config::store::{self, secrets, StoredConnection};
use crate::config::vault::{self, VaultStatus};
use crate::error::{AppError, AppResult};
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
// 首次启动引导
// ---------------------------------------------------------------------------

/// 引导完成标记的文件名，写在配置目录下。
///
/// 这是**本机**标记而非配置项：放在 config.yaml 里会随 Git 同步分发到其它机器，
/// 导致换机后跳过引导；单独落文件才能保证「每台机器首次打开都引导一次」。
const ONBOARDING_MARKER: &str = "onboarding.done";

/// 是否需要在启动时展示首次引导（语言选择）。标记文件不存在即视为首次。
#[tauri::command]
pub fn onboarding_status(state: State<'_, AppState>) -> AppResult<bool> {
    Ok(!state.paths.config_dir.join(ONBOARDING_MARKER).exists())
}

/// 记录引导已完成（用户选完语言并确认）。之后启动不再展示引导。
#[tauri::command]
pub fn onboarding_complete(state: State<'_, AppState>) -> AppResult<()> {
    let path = state.paths.config_dir.join(ONBOARDING_MARKER);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, b"1")?;
    log::info!("首次启动引导已完成：{}", path.display());
    Ok(())
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
/// 空串表示「删除」。这些值只会进入主密码加密的保险库（`secrets.json`），
/// 绝不写入 SQLite；该文件本身可随 Git 同步一起分发。
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
    /// 「复制会话」的来源连接 id：新建时把该连接的保险库凭据（密码 / passphrase /
    /// 跳板机密码 / RDP 密码）一并复制到新条目。前端拿不到明文，只能由后端按 id 复制。
    #[serde(default)]
    pub copy_secrets_from: Option<String>,
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
    // 「复制会话」的来源连接 id（仅在新建时生效），见 ConnectionInput 的说明
    let copy_from = input
        .copy_secrets_from
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    // 协议只接受 ssh / rdp，其余（含旧客户端缺字段）一律回退 SSH
    conn.protocol = if conn.protocol.trim() == store::PROTOCOL_RDP {
        store::PROTOCOL_RDP.to_string()
    } else {
        store::PROTOCOL_SSH.to_string()
    };
    conn.domain = conn
        .domain
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty());
    if conn.protocol == store::PROTOCOL_RDP {
        // RDP 不使用 SSH 专属字段，避免脏数据被导出 / 同步到别处
        conn.jump = None;
        conn.key_path = None;
        conn.has_passphrase = false;
    }

    if conn.name.trim().is_empty() {
        conn.name = if conn.host.is_empty() {
            "新连接".into()
        } else {
            conn.host.clone()
        };
    }
    let is_new = conn.id.trim().is_empty();
    if is_new {
        conn.id = uuid::Uuid::new_v4().to_string();
        conn.created_at = now.clone();
    }
    if conn.created_at.trim().is_empty() {
        conn.created_at = now.clone();
    }
    conn.updated_at = now;

    // 复制会话：新建且来源是另一条连接时，先搬凭据再应用本次编辑，
    // 这样本次表单里显式填写的密码 / passphrase 仍会覆盖复制来的值。
    if is_new {
        if let Some(src) = copy_from.filter(|s| *s != conn.id) {
            copy_connection_secrets(&src, &conn.id);
        }
    }

    // 敏感字段：只写加密保险库，并在记录上标记是否存在。
    // SSH 与 RDP 各用一个键名，按协议路由，列表接口只回传 has_password 布尔标记。
    let password_key = if conn.protocol == store::PROTOCOL_RDP {
        secrets::rdp_password_key(&conn.id)
    } else {
        secrets::conn_password_key(&conn.id)
    };
    conn.has_password = apply_secret(&password_key, input.password, conn.has_password)?;
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

/// 把源连接在保险库中的全部凭据复制到目标连接 id 下（「复制会话」用）。
///
/// 四类键名都尝试复制，源上不存在的键自然跳过；复制失败只记录日志，
/// 不阻断保存流程（例如保险库未解锁时凭据复制不到，但连接配置仍会落盘）。
fn copy_connection_secrets(from: &str, to: &str) {
    for (src_key, dst_key) in [
        (secrets::conn_password_key(from), secrets::conn_password_key(to)),
        (secrets::conn_passphrase_key(from), secrets::conn_passphrase_key(to)),
        (secrets::jump_password_key(from), secrets::jump_password_key(to)),
        (secrets::rdp_password_key(from), secrets::rdp_password_key(to)),
    ] {
        match secrets::get(&src_key) {
            Ok(Some(value)) if !value.is_empty() => {
                if let Err(e) = secrets::set(&dst_key, &value) {
                    log::warn!("复制保险库条目 {src_key} -> {dst_key} 失败：{e}");
                }
            }
            Ok(_) => {}
            Err(e) => log::warn!("读取保险库条目 {src_key} 失败：{e}"),
        }
    }
}

// ---------------------------------------------------------------------------
// AI 模型 API Key（每个模型一把，按模型条目 id 存加密保险库）
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

// ---------------------------------------------------------------------------
// 主密码保险库
// ---------------------------------------------------------------------------

/// 保险库状态：界面据此决定「设置主密码 / 解锁 / 已就绪」。
#[tauri::command]
pub fn vault_status() -> AppResult<VaultStatus> {
    vault::status()
}

/// 首次设置主密码，创建空保险库并直接解锁。
#[tauri::command]
pub fn vault_setup(password: String) -> AppResult<()> {
    if password.trim().is_empty() {
        return Err(AppError::Vault("主密码不能为空".into()));
    }
    vault::setup(&password)
}

/// 用主密码解锁保险库。密码错误时返回错误，不会清空已有数据。
#[tauri::command]
pub fn vault_unlock(password: String) -> AppResult<()> {
    vault::unlock(&password)
}

/// 修改主密码：先用当前密码校验，再用新密码重新加密全部敏感字段。
#[tauri::command]
pub fn vault_change_password(current: String, new_password: String) -> AppResult<()> {
    if current.trim().is_empty() {
        return Err(AppError::Vault("请输入当前主密码".into()));
    }
    if new_password.trim().is_empty() {
        return Err(AppError::Vault("新主密码不能为空".into()));
    }
    vault::change_password(&current, &new_password)
}

/// 手动锁定，丢弃内存中的密钥与明文。锁定时保留本地自动解锁令牌（`vault.token`），
/// 下次启动仍可静默解锁；本次会话需重新输入主密码。
#[tauri::command]
pub fn vault_lock() -> AppResult<()> {
    vault::lock()
}

/// 通过主密码冲突：采用 Git 同步仓库中的保险库（需提供远端主密码）。
#[tauri::command]
pub fn vault_adopt_pending(password: String) -> AppResult<()> {
    if password.trim().is_empty() {
        return Err(AppError::Vault("请输入远端主密码".into()));
    }
    vault::adopt_pending(&password)
}

/// 主密码冲突：丢弃同步仓库中的保险库，保留本地不变。
#[tauri::command]
pub fn vault_discard_pending() -> AppResult<()> {
    vault::discard_pending()
}

/// 忘记主密码时的兜底：删除保险库文件（其中所有敏感字段一并丢失）。
#[tauri::command]
pub fn vault_reset() -> AppResult<()> {
    vault::reset()
}