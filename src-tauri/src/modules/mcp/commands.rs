//! MCP 服务的设置界面命令。
//!
//! 只读查询：开关值来自配置，运行状态通过探测本地端口判断，
//! 令牌从配置目录的 `mcp.token` 读取，供界面展示与一键复制。

use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;

use super::server::TOKEN_FILE;

/// 设置界面展示的 MCP 状态快照。
#[derive(Debug, Clone, Serialize)]
pub struct McpInfo {
    /// 配置里的总开关
    pub enabled: bool,
    /// 配置里的端口
    pub port: u16,
    /// 客户端应填写的端点地址
    pub endpoint: String,
    /// 本地令牌；服务尚未启动过时为 None
    pub token: Option<String>,
    /// 本地端口是否已在实际监听
    pub running: bool,
}

#[tauri::command]
pub fn mcp_info(state: State<'_, AppState>) -> AppResult<McpInfo> {
    let flags = state.flags();
    let port = flags.mcp.port;
    let token = std::fs::read_to_string(state.paths.config_dir.join(TOKEN_FILE))
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|value| !value.is_empty());
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let running = TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok();
    Ok(McpInfo {
        enabled: flags.mcp.enabled,
        port,
        endpoint: format!("http://127.0.0.1:{port}/mcp"),
        token,
        running,
    })
}
