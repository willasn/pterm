//! 系统托盘（FEATURES.md §6）。
//!
//! 托盘图标、右键菜单、最小化到托盘。**opt-in**：默认关闭（`auxiliary.system_tray = false`）。
//!
//! 托盘随模块生命周期动态创建 / 销毁：设置里切换开关保存后，`save_config` 调用
//! `ModuleRegistry::apply`，本模块的 `init` 构建托盘、`dispose` 移除托盘，无需重启。
//! 前端只需据此显示设置徽标，没有后端命令。

use parking_lot::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::error::{AppError, AppResult};
use crate::modules::ModuleContext;

/// 托盘资源 id。创建与移除都用它定位，保证同一时刻最多一个托盘。
const TRAY_ID: &str = "pterm-tray";

/// 系统托盘模块。
///
/// 托盘句柄由 Tauri 的资源表持有，这里只记住 app 句柄：`dispose` 没有上下文参数，
/// 只能靠它按 id 移除托盘。
#[derive(Default)]
pub struct SystemTrayModule {
    app: Mutex<Option<AppHandle>>,
}

impl SystemTrayModule {
    pub fn new() -> Self {
        Self::default()
    }
}

impl PluggableModule for SystemTrayModule {
    fn id(&self) -> &'static str {
        module_id::SYSTEM_TRAY
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.auxiliary.system_tray
    }

    fn init(&self, ctx: &ModuleContext) -> AppResult<()> {
        build_tray(&ctx.app).map_err(|e| AppError::Other(format!("构建系统托盘失败：{e}")))?;
        *self.app.lock() = Some(ctx.app.clone());
        log::info!("系统托盘已启用：关闭窗口将最小化到托盘");
        Ok(())
    }

    fn dispose(&self) -> AppResult<()> {
        if let Some(app) = self.app.lock().take() {
            remove_tray(&app);
        }
        log::info!("系统托盘已关闭");
        Ok(())
    }
}

/// 构建托盘图标与右键菜单（FEATURES.md §6）。
///
/// 左键单击恢复到主窗口，右键菜单提供「显示 / 退出」。
/// 「退出」通过 [`tauri::AppHandle::exit`] 真正结束进程，不触发「关闭 → 隐藏」逻辑。
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    // 左键单击默认弹出菜单（show_menu_on_left_click 为 true），这里改用单击恢复窗口，
    // 让右键弹出菜单，符合「驻留后台 + 一键呼出」的直觉。
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("pterm")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });

    // 复用应用默认窗口图标作为托盘图标。
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// 移除托盘图标与菜单。可重复调用。
fn remove_tray(app: &AppHandle) {
    if app.remove_tray_by_id(TRAY_ID).is_none() {
        log::warn!("未找到 id 为 {TRAY_ID} 的托盘，可能已被移除");
    }
}
