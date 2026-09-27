//! 命令历史（FEATURES.md §6）。
//!
//! 记录终端里执行过的命令，支持搜索、按命令去重与按使用频率排序。
//!
//! 数据全部落在 SQLite 的 `command_history` 表（见 `config::store`），模块本身
//! **没有运行期状态**，因此 [`CommandHistoryModule`] 只在初始化时打一条日志，
//! 真正的读写发生在命令层（见 `commands.rs`）。
//!
//! 去重与频率统计都在查询期完成（不删原始行），保留每一条执行记录才能算出
//! 真实的使用次数与最近一次执行的主机 / 会话。

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::error::AppResult;
use crate::modules::ModuleContext;

pub mod commands;

/// 命令历史模块。数据落在 SQLite，模块自身无运行期状态。
pub struct CommandHistoryModule;

impl CommandHistoryModule {
    pub fn new() -> Self {
        Self
    }
}

impl Default for CommandHistoryModule {
    fn default() -> Self {
        Self::new()
    }
}

impl PluggableModule for CommandHistoryModule {
    fn id(&self) -> &'static str {
        module_id::COMMAND_HISTORY
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.auxiliary.command_history
    }

    fn init(&self, _ctx: &ModuleContext) -> AppResult<()> {
        log::info!("命令历史已启用：支持搜索、去重与频率排序");
        Ok(())
    }
}