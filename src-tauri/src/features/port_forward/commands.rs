//! 端口转发对外命令。
//!
//! 启动需要建立 SSH 连接、停止需要 join 监听线程，两者都会阻塞，
//! 因此统一放进 `spawn_blocking`；列表只读内存表，保持同步。

use tauri::State;

use crate::config::feature_flags::module_id;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::{ForwardInfo, ForwardRequest};

/// 启动一条端口转发（本地 / 远程 / 动态）。
#[tauri::command]
pub async fn port_forward_start(
    state: State<'_, AppState>,
    request: ForwardRequest,
) -> AppResult<ForwardInfo> {
    state.require_module(module_id::PORT_FORWARD)?;
    // 跳板机是可关闭的功能点，关闭时不允许经跳板机建立转发
    let uses_jump = request
        .params
        .jump
        .as_ref()
        .map(|j| !j.host.trim().is_empty())
        .unwrap_or(false);
    if uses_jump && !state.flags().connection.jump_host {
        return Err(AppError::ModuleDisabled("跳板机（ProxyJump）".into()));
    }
    let manager = state.port_forward.clone();
    spawn(move || manager.start(request), "启动端口转发").await
}

/// 停止一条端口转发。
#[tauri::command]
pub async fn port_forward_stop(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.require_module(module_id::PORT_FORWARD)?;
    let manager = state.port_forward.clone();
    spawn(move || manager.stop(&id), "停止端口转发").await
}

/// 所有转发规则快照（含已转发连接数）。
#[tauri::command]
pub fn port_forward_list(state: State<'_, AppState>) -> AppResult<Vec<ForwardInfo>> {
    state.require_module(module_id::PORT_FORWARD)?;
    Ok(state.port_forward.list())
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/// 把阻塞任务搬到专用线程池，并把 panic / 取消统一转成转发错误。
async fn spawn<T: Send + 'static>(
    job: impl FnOnce() -> AppResult<T> + Send + 'static,
    label: &str,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| AppError::Forward(format!("{label}任务异常结束：{e}")))?
}