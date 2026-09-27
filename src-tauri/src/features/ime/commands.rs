//! 输入源切换对外命令。

use tauri::{AppHandle, State};

use crate::config::feature_flags::module_id;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::platform;

/// 在主线程执行并取回结果。Carbon 的输入源 API 属于 UI 相关调用，应在主线程进行。
fn on_main<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce() -> T + Send + 'static,
) -> AppResult<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(work());
    })
    .map_err(|e| AppError::Other(format!("切换到主线程失败：{e}")))?;
    rx.recv().map_err(|e| AppError::Other(e.to_string()))
}

/// 终端获得焦点：把系统输入源切到英文，让命令走 xterm 的原生按键通道。
///
/// 返回值表示本平台是否支持自动切换；不支持时前端可提示用户手动使用英文输入法。
#[tauri::command]
pub async fn ime_use_ascii(app: AppHandle, state: State<'_, AppState>) -> AppResult<bool> {
    state.require_module(module_id::IME_SWITCH)?;
    if !super::supported() {
        return Ok(false);
    }
    on_main(&app, platform::use_ascii)
}

/// 终端失去焦点：还原用户原来的输入源。
#[tauri::command]
pub async fn ime_restore(app: AppHandle, state: State<'_, AppState>) -> AppResult<bool> {
    state.require_module(module_id::IME_SWITCH)?;
    if !super::supported() {
        return Ok(false);
    }
    on_main(&app, platform::restore)
}

/// 本平台是否支持自动切换输入源，供界面提示使用。
#[tauri::command]
pub fn ime_supported(state: State<'_, AppState>) -> AppResult<bool> {
    state.require_module(module_id::IME_SWITCH)?;
    Ok(super::supported())
}
