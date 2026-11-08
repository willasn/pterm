//! 激活码授权的 Tauri command 层。
//!
//! 授权是核心能力（未激活时也需要能打开界面查状态、输激活码），
//! 因此这些命令不做模块门控；Git 同步的写操作在 `git_sync::commands` 里单独校验。

use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;

use super::LicenseStatusView;

/// 当前授权状态（纯本地验签，不联网）。
#[tauri::command]
pub fn license_status(state: State<'_, AppState>) -> AppResult<LicenseStatusView> {
    Ok(state.license.status())
}

/// 使用激活码在线激活 / 更换激活码。
#[tauri::command]
pub async fn license_activate(
    state: State<'_, AppState>,
    key: String,
) -> AppResult<LicenseStatusView> {
    let service = state.license.clone();
    service.activate(&key).await
}
