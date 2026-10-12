//! 自动更新（FEATURES.md §6）。
//!
//! 用 tauri-plugin-updater 检查 GitHub Releases 上的 `latest.json`：有新版则下载、
//! 校验签名并安装，装完重启应用。**opt-in**：默认开启（`auxiliary.auto_update = true`），
//! 可在设置中关闭。
//!
//! `auxiliary.auto_update` 开关只控制「启动后自动检查一次（结果按天缓存）并自动弹提示条」
//! 这部分自动行为；设置「关于 → 软件更新」页的「检查更新」按钮**始终可用**，关掉开关也能
//! 主动手动检查（见 [`commands`]，其命令不受开关门控）。
//! 真正的网络请求与安装都在 Rust 侧（见 [`commands`]），前端经 Tauri command 中介。

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::error::AppResult;
use crate::modules::ModuleContext;

pub mod commands;

/// 自动更新模块。
///
/// 没有常驻后台任务：更新检查与安装都由命令驱动（前端启动时按开关触发一次），
/// 注册本模块只为统一生命周期日志与开关门控。
#[derive(Default)]
pub struct AutoUpdateModule;

impl AutoUpdateModule {
    pub fn new() -> Self {
        Self
    }
}

impl PluggableModule for AutoUpdateModule {
    fn id(&self) -> &'static str {
        module_id::AUTO_UPDATE
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.auxiliary.auto_update
    }

    fn init(&self, _ctx: &ModuleContext) -> AppResult<()> {
        log::info!("自动更新已启用：启动后自动检查，设置「关于」页也可手动检查");
        Ok(())
    }
}
