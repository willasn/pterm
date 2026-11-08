use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::auth;
use super::interactive::AuthPrompt;
use super::jump::JumpTunnel;
use super::key_setup::{self, KeySetupOptions, KeySetupResult};
use super::known_hosts::KnownHostEntry;
use super::session::{open_transport, DEFAULT_EXEC_TIMEOUT_MS};
use super::types::{ConnectParams, ExecResult, SessionInfo};

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

/// 在会话的独立 exec 通道里执行一条命令：**不写入用户终端**，返回合并后的输出。
///
/// AI 助手的 Agent 自动执行与 Ask「运行」都走这里，避免与用户抢同一条交互终端。
/// 命令在后台通道上跑，用户当前 shell 的输入、输出和状态都不受影响。
#[tauri::command]
pub async fn ssh_exec(
    state: State<'_, AppState>,
    id: String,
    command: String,
    timeout_ms: Option<u64>,
) -> AppResult<ExecResult> {
    let sessions = state.sessions.clone();
    let timeout = timeout_ms.unwrap_or(DEFAULT_EXEC_TIMEOUT_MS);
    tauri::async_runtime::spawn_blocking(move || sessions.exec(&id, &command, timeout))
        .await
        .map_err(|e| AppError::Ssh(format!("后台命令任务异常结束：{e}")))?
}

/// 运行时开关「会话资源监控」：终端右下角图标按会话切换，失焦时前端会置为 false。
///
/// 关闭后该会话线程不再发起任何采样（不打开 exec 通道）；打开则下一轮空闲开始采样。
#[tauri::command]
pub fn ssh_set_session_monitor(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> AppResult<()> {
    state.sessions.set_monitor(&id, enabled);
    Ok(())
}

/// 测试连接与认证，不创建会话。用于连接配置界面的「测试」按钮。
#[tauri::command]
pub async fn ssh_test_connection(params: ConnectParams) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || test_connection(&params))
        .await
        .map_err(|e| AppError::Ssh(format!("测试连接任务异常结束：{e}")))?
}

/// 一键生成并部署 SSH 密钥：本地生成 ed25519 密钥对，把公钥追加到远端
/// `~/.ssh/authorized_keys`，验证密钥登录，并写入本机 `~/.ssh/config`。
///
/// 连接凭据由后端按 `connection_id` 从保险库读取，前端不传明文。
#[tauri::command]
pub async fn ssh_setup_key(
    state: State<'_, AppState>,
    connection_id: String,
    options: KeySetupOptions,
) -> AppResult<KeySetupResult> {
    if !state.flags().connection.key_setup {
        return Err(AppError::ModuleDisabled("生成并部署 SSH 密钥".into()));
    }
    let conn = state.store.get_connection(&connection_id)?;
    let jump_enabled = state.flags().connection.jump_host;
    tauri::async_runtime::spawn_blocking(move || key_setup::run(&conn, jump_enabled, &options))
        .await
        .map_err(|e| AppError::Ssh(format!("密钥部署任务异常结束：{e}")))?
}

/// 已知主机（主机密钥）列表。供设置界面展示与删除。
#[tauri::command]
pub fn ssh_known_hosts_list(state: State<'_, AppState>) -> AppResult<Vec<KnownHostEntry>> {
    Ok(state.known_hosts.list())
}

/// 删除一台主机的已知密钥记录，下次连接会重新走首次信任。
#[tauri::command]
pub fn ssh_known_hosts_forget(state: State<'_, AppState>, host: String, port: u16) -> AppResult<()> {
    state.known_hosts.forget(&host, port)
}

/// 回填一次键盘交互认证的提示应答（对应 `ssh:auth-prompt:{id}` 事件）。
/// `text` 为 `None` 表示用户取消，认证会随即以「已取消」结束。
#[tauri::command]
pub fn ssh_auth_respond(
    state: State<'_, AppState>,
    id: String,
    text: Option<String>,
) -> AppResult<()> {
    if state.auth_hub.respond(&id, text) {
        Ok(())
    } else {
        Err(AppError::Other("没有等待中的认证提示".into()))
    }
}

/// 读取某会话当前待应答的键盘交互提示。前端订阅后用它对齐抢跑期间发出的提示。
#[tauri::command]
pub fn ssh_auth_pending(state: State<'_, AppState>, id: String) -> AppResult<Option<AuthPrompt>> {
    Ok(state.auth_hub.pending_of(&id))
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
            // 测试不校验主机密钥（与目标连接的测试一致），也不写 known_hosts
            Some(JumpTunnel::open(
                spec,
                &params.host,
                params.port,
                0,
                None,
                None,
            )?)
        }
        _ => None,
    };
    let (host, port) = match &tunnel {
        Some(t) => ("127.0.0.1".to_string(), t.local_port()),
        None => (params.host.clone(), params.port),
    };

    // 传输与认证都带超时，避免界面长时间无响应。
    // 这里不校验主机密钥：测试只探连通性与凭据，不建立持久会话，也不写 known_hosts；
    // 真正建立会话时（ssh_connect）才做校验。
    let sess = open_transport(&host, port)?;
    let method = auth::authenticate(&sess, params, None)?;
    drop(tunnel);
    Ok(method)
}
