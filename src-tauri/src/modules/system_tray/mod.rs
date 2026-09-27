//! 系统托盘（FEATURES.md §6）。
//!
//! 托盘图标、右键菜单、最小化到托盘。**opt-in**：默认关闭（`auxiliary.system_tray = false`）。
//!
//! 托盘图标与菜单在 `lib.rs` 的启动流程中按开关构建（`tauri::tray::TrayIconBuilder`），
//! 并处理「关闭窗口 → 隐藏到托盘」与托盘菜单「显示 / 退出」。
//! 前端只需据此显示设置徽标，没有后端命令。
//!
//! 本模块没有独立运行期状态（托盘句柄由启动流程持有），注册只为统一生命周期日志
//! 与设置界面的模块状态徽标。

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::error::AppResult;
use crate::modules::ModuleContext;

/// 系统托盘模块。托盘由启动流程构建，模块自身无运行期状态。
pub struct SystemTrayModule;

impl SystemTrayModule {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SystemTrayModule {
    fn default() -> Self {
        Self::new()
    }
}

impl PluggableModule for SystemTrayModule {
    fn id(&self) -> &'static str {
        module_id::SYSTEM_TRAY
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.auxiliary.system_tray
    }

    fn init(&self, _ctx: &ModuleContext) -> AppResult<()> {
        log::info!("系统托盘已启用：关闭窗口将最小化到托盘");
        Ok(())
    }
}