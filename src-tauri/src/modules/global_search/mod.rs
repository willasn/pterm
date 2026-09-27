//! 全局搜索（FEATURES.md §6）。
//!
//! 跨 连接 / 命令片段 / 命令历史 / 设置项 的统一模糊搜索。
//!
//! 搜索本身**完全在前端完成**（见 `src/js/search.js`）：四个数据源要么已有现成命令
//! （`list_connections` / `snippet_list` / `list_history`），要么本就位于前端
//! （设置项索引），面板打开时一次性拉齐数据后在本地过滤，因此这里没有后端命令。
//!
//! 本模块没有运行期状态，注册只为统一生命周期日志与设置界面的模块状态徽标。

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::error::AppResult;
use crate::modules::ModuleContext;

/// 全局搜索模块。搜索在前端进行，模块自身无运行期状态。
pub struct GlobalSearchModule;

impl GlobalSearchModule {
    pub fn new() -> Self {
        Self
    }
}

impl Default for GlobalSearchModule {
    fn default() -> Self {
        Self::new()
    }
}

impl PluggableModule for GlobalSearchModule {
    fn id(&self) -> &'static str {
        module_id::GLOBAL_SEARCH
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.auxiliary.global_search
    }

    fn init(&self, _ctx: &ModuleContext) -> AppResult<()> {
        log::info!("全局搜索已启用：可检索连接、命令片段、命令历史与设置项");
        Ok(())
    }
}