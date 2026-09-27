//! 快捷键（FEATURES.md §6）。
//!
//! 全部操作可绑定快捷键，支持冲突检测。
//!
//! 按键派发**完全在前端完成**：绑定表位于 `config.shortcuts`，由 `src/js/shortcuts.js`
//! 解析组合键并派发到具体动作，设置界面（`src/js/settings.js`）负责冲突检测，
//! 因此这里没有后端命令。
//!
//! 本模块没有运行期状态，注册只为统一生命周期日志与设置界面的模块状态徽标。

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::error::AppResult;
use crate::modules::ModuleContext;

/// 快捷键模块。按键派发在前端进行，模块自身无运行期状态。
pub struct ShortcutsModule;

impl ShortcutsModule {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ShortcutsModule {
    fn default() -> Self {
        Self::new()
    }
}

impl PluggableModule for ShortcutsModule {
    fn id(&self) -> &'static str {
        module_id::SHORTCUTS
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.auxiliary.shortcuts
    }

    fn init(&self, _ctx: &ModuleContext) -> AppResult<()> {
        log::info!("快捷键已启用：按键派发与冲突检测均在前端完成");
        Ok(())
    }
}
