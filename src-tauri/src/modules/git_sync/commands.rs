//! Git 同步模块的 Tauri command 层（FEATURES.md §4）。
//!
//! 所有命令都先经 [`AppState::require_module`] 门控：模块关闭时直接拒绝，
//! 前端不加载 UI、也不会误调用。真正的仓库与网络操作是阻塞的，统一放进
//! `spawn_blocking`，避免卡住 WebView 的事件循环。

use tauri::{AppHandle, State};

use crate::config::feature_flags::module_id;
use crate::config::store::secrets;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::repo::ConflictStrategy;
use super::{normalize_remote_name, GitStatusView, GitTestInput, GitTestView, Op, SyncOutcomeView};

/// 把阻塞的同步任务放到后台线程执行。
async fn blocking<T, F>(job: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| AppError::Git(format!("同步任务异常结束：{e}")))?
}

/// 当前同步状态（分支、领先/落后、变更数、冲突、远端）。
#[tauri::command]
pub async fn git_sync_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<GitStatusView> {
    state.require_module(module_id::GIT_SYNC)?;
    let sync = state.sync_context(app);
    blocking(move || sync.status()).await
}

/// 初始化本地同步仓库。目录已是仓库时直接复用。
#[tauri::command]
pub async fn git_sync_init(app: AppHandle, state: State<'_, AppState>) -> AppResult<GitStatusView> {
    state.require_module(module_id::GIT_SYNC)?;
    let sync = state.sync_context(app);
    blocking(move || sync.init_repo()).await
}

/// 从远端克隆到同步目录。已有仓库时拒绝，避免覆盖本地数据。
#[tauri::command]
pub async fn git_sync_clone(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> AppResult<GitStatusView> {
    state.require_module(module_id::GIT_SYNC)?;
    let sync = state.sync_context(app);
    blocking(move || sync.clone_repo(&url)).await
}

/// 完整同步：导出 → 提交 → 拉取 → 导入 → 推送。
#[tauri::command]
pub async fn git_sync_now(app: AppHandle, state: State<'_, AppState>) -> AppResult<SyncOutcomeView> {
    state.require_module(module_id::GIT_SYNC)?;
    let sync = state.sync_context(app);
    blocking(move || sync.execute(Op::Sync)).await
}

/// 只拉取远端并导入，不产生本地提交。
#[tauri::command]
pub async fn git_sync_pull(app: AppHandle, state: State<'_, AppState>) -> AppResult<SyncOutcomeView> {
    state.require_module(module_id::GIT_SYNC)?;
    let sync = state.sync_context(app);
    blocking(move || sync.execute(Op::Pull)).await
}

/// 只推送本地已有提交。
#[tauri::command]
pub async fn git_sync_push(app: AppHandle, state: State<'_, AppState>) -> AppResult<SyncOutcomeView> {
    state.require_module(module_id::GIT_SYNC)?;
    let sync = state.sync_context(app);
    blocking(move || sync.execute(Op::Push)).await
}

/// 只导出并提交（离线留痕，不触网）。
#[tauri::command]
pub async fn git_sync_commit(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<SyncOutcomeView> {
    state.require_module(module_id::GIT_SYNC)?;
    let sync = state.sync_context(app);
    blocking(move || sync.execute(Op::Commit)).await
}

/// 工作区相对 HEAD 的 unified diff，供差异面板显示。
#[tauri::command]
pub async fn git_sync_diff(app: AppHandle, state: State<'_, AppState>) -> AppResult<String> {
    state.require_module(module_id::GIT_SYNC)?;
    let sync = state.sync_context(app);
    blocking(move || sync.diff()).await
}

/// 按策略解决冲突。`strategy` 取 `keep_local` / `keep_remote`。
///
/// 解决后不自动推送：冲突解决的结果交用户确认，再走一次推送。
#[tauri::command]
pub async fn git_sync_resolve(
    app: AppHandle,
    state: State<'_, AppState>,
    strategy: String,
) -> AppResult<SyncOutcomeView> {
    state.require_module(module_id::GIT_SYNC)?;
    let strategy = match strategy.trim() {
        "keep_local" => ConflictStrategy::KeepLocal,
        "keep_remote" => ConflictStrategy::KeepRemote,
        other => {
            return Err(AppError::Git(format!(
                "未知的冲突处理策略：{other}（可选 keep_local / keep_remote）"
            )))
        }
    };
    let sync = state.sync_context(app);
    blocking(move || sync.execute(Op::Resolve(strategy))).await
}

/// 已保存密码 / 访问令牌的远端名称列表。**不返回密码本身**。
///
/// 只读且不做模块门控：设置界面需要它来判断是否显示「已保存」。
#[tauri::command]
pub fn git_sync_credentials(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let names = state
        .flags()
        .sync
        .git_remotes
        .iter()
        .map(|r| normalize_remote_name(&r.name))
        .filter(|name| {
            matches!(
                secrets::get(&secrets::git_password_key(name)),
                Ok(Some(value)) if !value.is_empty()
            )
        })
        .collect();
    Ok(names)
}

/// 写入或删除某远端的密码 / 访问令牌。传空串表示删除。
///
/// 凭据只进加密保险库，绝不写入配置文件；用户名是非敏感字段，随配置保存。
#[tauri::command]
pub fn git_sync_set_credential(
    state: State<'_, AppState>,
    name: String,
    password: String,
) -> AppResult<()> {
    state.require_module(module_id::GIT_SYNC)?;
    let key = secrets::git_password_key(&normalize_remote_name(&name));
    let password = password.trim();
    if password.is_empty() {
        secrets::delete(&key)
    } else {
        secrets::set(&key, password)
    }
}

/// 测试远端连通性并校验凭据（等价 `git ls-remote`）。
///
/// 只读操作、不改动用户仓库，因此与 [`git_sync_credentials`] 一样不做模块门控：
/// 用户需要能在「启用 Git 同步之前」先确认地址与密码是否正确。
#[tauri::command]
pub async fn git_sync_test(
    app: AppHandle,
    state: State<'_, AppState>,
    input: GitTestInput,
) -> AppResult<GitTestView> {
    let sync = state.sync_context(app);
    blocking(move || sync.test_connection(&input)).await
}