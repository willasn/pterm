//! 系统托盘（仅 Windows）。
//!
//! 托盘图标、右键菜单、最小化到托盘。**无功能开关**：Windows 上恒定启用，
//! 设置里不再出现「系统托盘」开关；macOS 不编译本模块（见 `modules/mod.rs` 的
//! `#[cfg(windows)]`），也不支持系统托盘，关闭窗口改由 Dock 图标恢复。
//!
//! 托盘在 `setup` 中随窗口一起构建、退出时移除。左键单击恢复主窗口，
//! 右键菜单提供「显示 / 退出」；「退出」通过 [`tauri::AppHandle::exit`] 真正结束进程，
//! 不触发「关闭 → 隐藏」逻辑。

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

/// 托盘资源 id。创建与移除都用它定位，保证同一时刻最多一个托盘。
const TRAY_ID: &str = "pterm-tray";

/// 构建托盘图标与右键菜单。幂等：已存在则直接返回。
pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }

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
                show_main_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
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
pub fn remove_tray(app: &AppHandle) {
    if app.remove_tray_by_id(TRAY_ID).is_none() {
        log::warn!("未找到 id 为 {TRAY_ID} 的托盘，可能已被移除");
    }
}

/// 呼出被隐藏到后台的主窗口。
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
