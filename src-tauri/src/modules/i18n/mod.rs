//! 多语言 i18n（FEATURES.md §6）。
//!
//! 中英文界面切换，语言包外置。翻译的加载与应用**完全在前端完成**：
//! 语言包位于 `src/locales/*.json`，由 `src/js/i18n.js` 依据 `config.language`
//! 与 `config.features.auxiliary.i18n` 加载并替换 `data-i18n*` 标记的界面骨架文案，
//! 因此这里没有后端命令。
//!
//! 本模块没有运行期状态，注册只为统一生命周期日志与设置界面的模块状态徽标。

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::error::AppResult;
use crate::modules::ModuleContext;

/// 多语言模块。语言包加载与切换在前端进行，模块自身无运行期状态。
pub struct I18nModule;

impl I18nModule {
    pub fn new() -> Self {
        Self
    }
}

impl Default for I18nModule {
    fn default() -> Self {
        Self::new()
    }
}

impl PluggableModule for I18nModule {
    fn id(&self) -> &'static str {
        module_id::I18N
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.auxiliary.i18n
    }

    fn init(&self, _ctx: &ModuleContext) -> AppResult<()> {
        log::info!("多语言已启用：界面文案由前端语言包（src/locales/）驱动");
        Ok(())
    }
}