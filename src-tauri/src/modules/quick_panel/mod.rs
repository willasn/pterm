//! 快捷命令面板（FEATURES.md §6）。
//!
//! 类 Spotlight 的动作命令面板：由快捷键 `app.quick_panel` 唤起，
//! 列出前端已实现的快捷键动作，本地过滤后回车执行。
//!
//! 面板本身**完全在前端完成**（见 `src/js/quick_panel.js`）：动作注册表来自
//! `src/js/shortcuts.js` 的 `actions()`，执行复用同文件的 `run()`，因此这里没有后端命令。
//!
//! 本模块没有运行期状态，注册只为统一生命周期日志与设置界面的模块状态徽标。

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::error::AppResult;
use crate::modules::ModuleContext;

/// 快捷命令面板模块。动作列表面板在前端进行，模块自身无运行期状态。
pub struct QuickPanelModule;

impl QuickPanelModule {
    pub fn new() -> Self {
        Self
    }
}

impl Default for QuickPanelModule {
    fn default() -> Self {
        Self::new()
    }
}

impl PluggableModule for QuickPanelModule {
    fn id(&self) -> &'static str {
        module_id::QUICK_PANEL
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.auxiliary.quick_panel
    }

    fn init(&self, _ctx: &ModuleContext) -> AppResult<()> {
        log::info!("快捷命令面板已启用：动作列表面板完全在前端完成");
        Ok(())
    }
}