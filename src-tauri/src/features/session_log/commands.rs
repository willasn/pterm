//! 会话日志对外命令。

use serde::Serialize;
use tauri::State;

use crate::config::feature_flags::module_id;
use crate::error::AppResult;
use crate::state::AppState;

use super::LogEntry;

/// 会话日志状态。**不做模块门控**，否则关闭后设置界面无法显示入口与原因。
#[derive(Debug, Clone, Serialize)]
pub struct SessionLogStatus {
    pub enabled: bool,
    pub dir: String,
    pub retention_days: u32,
    pub count: usize,
    /// 当前正在记录日志的会话数
    pub active: usize,
}

#[tauri::command]
pub fn session_log_status(state: State<'_, AppState>) -> SessionLogStatus {
    let flags = state.flags();
    SessionLogStatus {
        enabled: flags.connection.session_log,
        dir: state.session_log.dir().display().to_string(),
        retention_days: flags.connection.session_log_retention_days,
        count: state.session_log.list().map(|v| v.len()).unwrap_or(0),
        active: state.session_log.active_count(),
    }
}

#[tauri::command]
pub fn session_log_list(state: State<'_, AppState>) -> AppResult<Vec<LogEntry>> {
    state.require_module(module_id::SESSION_LOG)?;
    state.session_log.list()
}

#[tauri::command]
pub fn session_log_read(
    state: State<'_, AppState>,
    name: String,
    max_bytes: Option<usize>,
) -> AppResult<String> {
    state.require_module(module_id::SESSION_LOG)?;
    state.session_log.read(&name, max_bytes.unwrap_or(0))
}

#[tauri::command]
pub fn session_log_clear(state: State<'_, AppState>) -> AppResult<usize> {
    state.require_module(module_id::SESSION_LOG)?;
    state.session_log.clear()
}