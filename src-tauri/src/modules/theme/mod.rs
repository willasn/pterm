//! 主题（FEATURES.md §6）。
//!
//! 内置亮 / 暗主题 + 自定义配色，终端配色可独立配置。
//!
//! 主题的应用**完全在前端完成**：调色板位于 `src/styles/theme.css`，由 `src/js/app.js`
//! 的 `applyTheme()` 依据 `config.theme` 写入 `body[data-theme]` 与 `--accent`，
//! 终端背景 / 前景色由 `config.terminal.background/foreground` 覆盖
//! （见 `src/js/terminal.js` 的 `xtermTheme()`），因此这里没有后端命令。
//!
//! 本模块没有运行期状态，注册只为统一生命周期日志与设置界面的模块状态徽标。

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::error::AppResult;
use crate::modules::ModuleContext;

/// 主题模块。配色计算在前端进行，模块自身无运行期状态。
pub struct ThemeModule;

impl ThemeModule {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ThemeModule {
    fn default() -> Self {
        Self::new()
    }
}

impl PluggableModule for ThemeModule {
    fn id(&self) -> &'static str {
        module_id::THEME
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.auxiliary.theme
    }

    fn init(&self, _ctx: &ModuleContext) -> AppResult<()> {
        log::info!("主题已启用：亮 / 暗模式、自定义强调色与终端配色");
        Ok(())
    }
}
