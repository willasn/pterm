//! MCP 服务（可开关）。
//!
//! 把 pterm 已有的 SSH 能力以 MCP 工具的形式暴露给外部 AI 客户端：
//! 外部 AI 只表达「连哪台机器、执行什么命令」，凭据始终留在本机的加密保险库里，
//! 由 pterm 代为完成认证，不经过模型上下文。
//!
//! 传输形态：本机 `127.0.0.1` 上的 Streamable HTTP 端点（`POST /mcp`），
//! 采用无状态 JSON-RPC，请求需携带本地令牌（配置目录下的 `mcp.token`）。
//! stdio 形态需要脱离 Tauri 运行时独立建连，留到后续阶段（见 MCP.md）。

use std::sync::Arc;

use parking_lot::Mutex;

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::error::AppResult;
use crate::modules::ModuleContext;

mod rpc;
mod server;
mod tools;

pub mod commands;

pub struct McpModule {
    running: Mutex<Option<server::Running>>,
}

impl McpModule {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            running: Mutex::new(None),
        })
    }
}

impl PluggableModule for McpModule {
    fn id(&self) -> &'static str {
        module_id::MCP
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.mcp.enabled
    }

    fn init(&self, ctx: &ModuleContext) -> AppResult<()> {
        let mut slot = self.running.lock();
        if slot.is_some() {
            return Ok(());
        }
        let running = server::start(ctx)?;
        log::info!(
            "MCP 服务已启动：http://127.0.0.1:{}/mcp（令牌文件 {}）",
            running.port,
            ctx.paths.config_dir.join(server::TOKEN_FILE).display()
        );
        *slot = Some(running);
        Ok(())
    }

    fn dispose(&self) -> AppResult<()> {
        if let Some(running) = self.running.lock().take() {
            running.shutdown();
            log::info!("MCP 服务已停止");
        }
        Ok(())
    }
}
