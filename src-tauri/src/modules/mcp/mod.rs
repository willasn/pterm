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
    /// 最近一次启动 / 重新配置失败的原因，供设置界面提示用户。
    last_error: Mutex<Option<String>>,
}

impl McpModule {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            running: Mutex::new(None),
            last_error: Mutex::new(None),
        })
    }

    /// 当前实际监听端口；服务未运行时为 None。
    ///
    /// 端口被占用自动降级后，这里返回降级后的端口（同时已写回配置）。
    pub fn running_port(&self) -> Option<u16> {
        self.running.lock().as_ref().map(|running| running.port)
    }

    /// 最近一次启动失败的原因。
    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().clone()
    }

    /// 重新生成访问令牌；运行中的服务会先停再起，旧令牌立即失效。
    pub fn reset_token(&self, ctx: &ModuleContext) -> AppResult<()> {
        let path = ctx.paths.config_dir.join(server::TOKEN_FILE);
        server::reset_token(&path)?;
        if self.running_port().is_none() {
            // 服务未运行：只换令牌，等下次启用时生效
            return Ok(());
        }
        // 先停旧实例，避免旧令牌在换新后仍可用
        if let Some(old) = self.running.lock().take() {
            old.shutdown();
        }
        self.start_service(ctx)
    }

    /// 启动服务并把失败原因记录到 `last_error`。
    fn start_service(&self, ctx: &ModuleContext) -> AppResult<()> {
        match server::start(ctx) {
            Ok(running) => {
                let port = running.port;
                let old = self.running.lock().replace(running);
                if let Some(old) = old {
                    old.shutdown();
                }
                *self.last_error.lock() = None;
                log::info!(
                    "MCP 服务已启动：http://127.0.0.1:{port}/mcp（令牌文件 {}）",
                    ctx.paths.config_dir.join(server::TOKEN_FILE).display()
                );
                Ok(())
            }
            Err(e) => {
                *self.last_error.lock() = Some(e.to_string());
                Err(e)
            }
        }
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
        if self.running_port().is_some() {
            return Ok(());
        }
        self.start_service(ctx)
    }

    /// 配置保存后调用：端口变化时在线重启监听，无需重启应用。
    ///
    /// 先建新监听、成功后再关旧实例；新端口不可用时保留旧服务并记录错误，
    /// 避免一次误配置让已经可用的 MCP 服务直接掉线。
    fn reconfigure(&self, ctx: &ModuleContext) -> AppResult<()> {
        let flags = ctx.config.flags();
        if !self.is_enabled(&flags) {
            return Ok(());
        }
        let desired = flags.mcp.port;
        if self.running_port() == Some(desired) {
            return Ok(());
        }
        self.start_service(ctx)
    }

    fn dispose(&self) -> AppResult<()> {
        if let Some(running) = self.running.lock().take() {
            running.shutdown();
            log::info!("MCP 服务已停止");
        }
        *self.last_error.lock() = None;
        Ok(())
    }
}
