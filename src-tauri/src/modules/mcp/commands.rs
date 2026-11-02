//! MCP 服务的设置界面命令。
//!
//! 查询：开关值来自配置，运行状态与实际端口来自模块句柄（端口被占用自动降级后
//! 配置已写回），令牌从配置目录的 `mcp.token` 读取，供界面展示与一键复制。
//! 写入：重置访问令牌（旧令牌立即失效，运行中的服务随之重新加载）。

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::config::feature_flags::module_id;
use crate::error::AppResult;
use crate::state::AppState;

use super::server::TOKEN_FILE;
use super::McpModule;

/// 设置界面展示的 MCP 状态快照。
#[derive(Debug, Clone, Serialize)]
pub struct McpInfo {
    /// 配置里的总开关
    pub enabled: bool,
    /// 实际端口：服务运行时为监听端口（可能已自动降级），否则为配置端口
    pub port: u16,
    /// 客户端应填写的端点地址
    pub endpoint: String,
    /// 本地令牌；服务尚未启动过时为 None
    pub token: Option<String>,
    /// 本地端口是否已在实际监听
    pub running: bool,
    /// 最近一次启动 / 重新配置失败的原因
    pub last_error: Option<String>,
}

/// 组装状态快照（`mcp_info` 与重置令牌后共用）。
fn snapshot(state: &AppState, mcp: &McpModule) -> McpInfo {
    let flags = state.flags();
    let running_port = mcp.running_port();
    let port = running_port.unwrap_or(flags.mcp.port);
    let token = std::fs::read_to_string(state.paths.config_dir.join(TOKEN_FILE))
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|value| !value.is_empty());
    McpInfo {
        enabled: flags.mcp.enabled,
        port,
        endpoint: format!("http://127.0.0.1:{port}/mcp"),
        token,
        running: running_port.is_some(),
        last_error: mcp.last_error(),
    }
}

#[tauri::command]
pub fn mcp_info(state: State<'_, AppState>, mcp: State<'_, Arc<McpModule>>) -> AppResult<McpInfo> {
    Ok(snapshot(&state, &mcp))
}

/// 重置访问令牌：生成新令牌并让运行中的服务立即使用它，旧令牌随即失效。
#[tauri::command]
pub fn mcp_reset_token(
    app: AppHandle,
    state: State<'_, AppState>,
    mcp: State<'_, Arc<McpModule>>,
) -> AppResult<McpInfo> {
    state.require_module(module_id::MCP)?;
    let ctx = state.module_context(app);
    mcp.reset_token(&ctx)?;
    Ok(snapshot(&state, &mcp))
}
