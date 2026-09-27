use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::auth;
use super::jump::JumpTunnel;
use super::session::open_transport;
use super::types::{ConnectParams, SessionInfo};

/// 建立 SSH 会话。立即返回会话信息，连接进度通过
/// `ssh:status:{id}` / `ssh:data:{id}` / `ssh:closed:{id}` 事件推送。
#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    params: ConnectParams,
) -> AppResult<SessionInfo> {
    // 跳板机是可关闭的功能点，关闭时不允许使用
    if params.jump.is_some() && !state.flags().connection.jump_host {
        return Err(AppError::ModuleDisabled("跳板机（ProxyJump）".into()));
    }
    let deps = state.session_deps(&app);
    state.sessions.create(&deps, params)
}

/// 向会话写入键盘输入。
#[tauri::command]
pub fn ssh_write(state: State<'_, AppState>, id: String, data: String) -> AppResult<()> {
    state.sessions.write(&id, data.into_bytes())
}

/// 通知远端终端尺寸变化。
#[tauri::command]
pub fn ssh_resize(state: State<'_, AppState>, id: String, cols: u32, rows: u32) -> AppResult<()> {
    state.sessions.resize(&id, cols, rows)
}

/// 主动断开会话，不再自动重连。
#[tauri::command]
pub fn ssh_disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.sessions.close(&id)
}

/// 所有活跃会话快照。
#[tauri::command]
pub fn ssh_sessions(state: State<'_, AppState>) -> AppResult<Vec<SessionInfo>> {
    Ok(state.sessions.list())
}

/// 读取会话最近输出，供 AI 上下文注入与错误解释使用。
#[tauri::command]
pub fn ssh_recent_output(
    state: State<'_, AppState>,
    id: String,
    max_bytes: Option<usize>,
) -> AppResult<String> {
    let limit = max_bytes.unwrap_or(8 * 1024);
    state.sessions.recent_text(&id, limit)
}

/// 测试连接与认证，不创建会话。用于连接配置界面的「测试」按钮。
#[tauri::command]
pub async fn ssh_test_connection(params: ConnectParams) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || test_connection(&params))
        .await
        .map_err(|e| AppError::Ssh(format!("测试连接任务异常结束：{e}")))?
}

fn test_connection(params: &ConnectParams) -> AppResult<String> {
    if params.host.trim().is_empty() {
        return Err(AppError::Config("未填写主机地址".into()));
    }
    if params.username.trim().is_empty() {
        return Err(AppError::Config("未填写用户名".into()));
    }

    let tunnel = match &params.jump {
        Some(spec) if !spec.host.trim().is_empty() => {
            Some(JumpTunnel::open(spec, &params.host, params.port, 0)?)
        }
        _ => None,
    };
    let (host, port) = match &tunnel {
        Some(t) => ("127.0.0.1".to_string(), t.local_port()),
        None => (params.host.clone(), params.port),
    };

    // 传输与认证都带超时，避免界面长时间无响应
    let sess = open_transport(&host, port)?;
    let method = auth::authenticate(&sess, params)?;
    drop(tunnel);
    Ok(method)
}