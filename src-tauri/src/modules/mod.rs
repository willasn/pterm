pub mod ai_assistant;
pub mod auto_update;
pub mod command_history;
pub mod git_sync;
pub mod global_search;
pub mod quick_panel;
pub mod shortcuts;
pub mod snippets;
#[cfg(windows)]
pub mod system_tray;
pub mod theme;

use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::AppHandle;

use crate::config::feature_flags::{FeatureFlags, ModuleStatus, PluggableModule};
use crate::config::store::SharedStore;
use crate::config::ConfigManager;
use crate::error::AppResult;
use crate::ssh::session::SessionManager;
use crate::utils::Paths;

/// 模块初始化时获得的共享上下文。
///
/// SSH 核心是唯一的核心依赖：可选模块可以依赖它，反之不行。
pub struct ModuleContext {
    pub app: AppHandle,
    pub config: Arc<ConfigManager>,
    pub store: SharedStore,
    pub paths: Paths,
    pub sessions: SessionManager,
}

/// 可插拔模块注册表。
///
/// 开关变化时调用 [`ModuleRegistry::apply`]：新启用的模块执行 `init`，
/// 被关闭的模块执行 `dispose`。关闭的模块不初始化、不占资源、前端不加载 UI。
#[derive(Default)]
pub struct ModuleRegistry {
    modules: Vec<Arc<dyn PluggableModule>>,
    initialized: Mutex<HashSet<&'static str>>,
}

impl ModuleRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册模块。各可选模块在自己的 `mod.rs` 中提供构造入口，由启动流程统一注册。
    pub fn register(&mut self, module: Arc<dyn PluggableModule>) {
        self.modules.push(module);
    }

    /// 已注册模块的 id 列表。
    pub fn ids(&self) -> Vec<&'static str> {
        self.modules.iter().map(|m| m.id()).collect()
    }

    /// 按当前开关同步模块生命周期。可重复调用。
    pub fn apply(&self, ctx: &ModuleContext) -> AppResult<()> {
        let flags = ctx.config.flags();
        for module in &self.modules {
            let id = module.id();
            let enabled = module.is_enabled(&flags);
            let running = self.initialized.lock().contains(id);

            if enabled && !running {
                match module.init(ctx) {
                    Ok(()) => {
                        log::info!("模块 {id} 已启用");
                        self.initialized.lock().insert(id);
                    }
                    // 初始化失败只记录，不影响其他模块与应用启动
                    Err(e) => log::error!("模块 {id} 初始化失败：{e}"),
                }
            } else if !enabled && running {
                if let Err(e) = module.dispose() {
                    log::warn!("模块 {id} 卸载时出错：{e}");
                }
                self.initialized.lock().remove(id);
                log::info!("模块 {id} 已关闭");
            }
        }
        Ok(())
    }

    /// 退出前卸载全部已初始化模块。
    pub fn dispose_all(&self) {
        for module in &self.modules {
            let id = module.id();
            if self.initialized.lock().contains(id) {
                if let Err(e) = module.dispose() {
                    log::warn!("模块 {id} 卸载时出错：{e}");
                }
                self.initialized.lock().remove(id);
            }
        }
    }

    /// 模块状态快照，供设置界面显示。
    pub fn status(&self, flags: &FeatureFlags) -> Vec<ModuleStatus> {
        self.modules
            .iter()
            .map(|m| {
                let id = m.id();
                ModuleStatus {
                    id: id.to_string(),
                    enabled: m.is_enabled(flags),
                    initialized: self.initialized.lock().contains(id),
                    note: None,
                }
            })
            .collect()
    }
}