use tauri::{AppHandle, State};

use crate::config::feature_flags::module_id;
use crate::error::AppResult;
use crate::ssh::types::{ConnectParams, SessionInfo, SessionKind};
use crate::state::AppState;

/// 打开一个本地终端（本机 PTY shell）。会话进入与 SSH 相同的会话表，
/// 之后用 `ssh_write` / `ssh_resize` / `ssh_disconnect` 操作。
#[tauri::command]
pub async fn local_terminal_open(
    app: AppHandle,
    state: State<'_, AppState>,
    cols: Option<u32>,
    rows: Option<u32>,
    session_id: Option<String>,
) -> AppResult<SessionInfo> {
    state.require_module(module_id::LOCAL_TERMINAL)?;
    let params = ConnectParams {
        kind: SessionKind::Local,
        session_id,
        cols: cols.unwrap_or(80),
        rows: rows.unwrap_or(24),
        ..ConnectParams::default()
    };
    let deps = state.session_deps(&app);
    state.sessions.create(&deps, params)
}
