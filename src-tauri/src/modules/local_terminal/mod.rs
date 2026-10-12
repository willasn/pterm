//! 本地终端（FEATURES.md §3）。
//!
//! 在本机 PTY（Unix pty / Windows ConPTY）上打开一个 shell，复用 SSH 的会话表、
//! 事件通道与标签 / 分屏体系，因此没有独立的运行期状态——会话一律由
//! [`crate::ssh::session::SessionManager`] 持有，读写 / 改尺寸 / 断开也走
//! `ssh_write` / `ssh_resize` / `ssh_disconnect` 这几个共用命令。
//!
//! 运行时逻辑见 [`crate::ssh::local`]；本模块只负责开关门控与开新会话的命令。

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::error::AppResult;
use crate::modules::ModuleContext;

pub mod commands;

/// 本地终端模块。
pub struct LocalTerminalModule;

impl LocalTerminalModule {
    pub fn new() -> Self {
        Self
    }
}

impl Default for LocalTerminalModule {
    fn default() -> Self {
        Self::new()
    }
}

impl PluggableModule for LocalTerminalModule {
    fn id(&self) -> &'static str {
        module_id::LOCAL_TERMINAL
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.connection.local_terminal
    }

    fn init(&self, _ctx: &ModuleContext) -> AppResult<()> {
        log::info!("本地终端已启用：可在侧栏新建本机 PTY shell");
        Ok(())
    }
}
