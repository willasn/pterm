mod config;
mod error;
mod features;
mod modules;
mod ssh;
mod state;
mod utils;

use std::sync::Arc;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use config::store::Store;
use config::ConfigManager;
use features::import_export::ImportExportModule;
use features::port_forward::{PortForwardManager, PortForwardModule};
use features::session_log::{SessionLog, SessionLogModule};
use features::sftp::{SftpManager, SftpModule};
use modules::ai_assistant::{AiAssistantModule, AiService};
use modules::command_history::CommandHistoryModule;
use modules::git_sync::{GitSync, GitSyncModule};
use modules::global_search::GlobalSearchModule;
use modules::i18n::I18nModule;
use modules::quick_panel::QuickPanelModule;
use modules::shortcuts::ShortcutsModule;
use modules::snippets::SnippetsModule;
use modules::system_tray::SystemTrayModule;
use modules::theme::ThemeModule;
use modules::ModuleRegistry;
use state::AppState;
use utils::Paths;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let paths = Paths::resolve()?;
            let config = ConfigManager::load(paths.config_file())?;
            // 旧版「全局 AI Key」按模型条目 id 迁移到新的钥匙串键名（幂等）
            config::commands::migrate_legacy_ai_key(&config.snapshot());
            let crash_log = config.flags().auxiliary.crash_log;
            utils::init_logging(crash_log, paths.crash_log.clone());
            log::info!("pshell 启动，配置目录 {}", paths.config_dir.display());

            let store = Arc::new(Store::open(&paths.database_file())?);
            let config = Arc::new(config);

            // 可选模块在此注册。未注册的模块其命令一律被门控拒绝。
            let mut registry = ModuleRegistry::new();
            // Git 同步服务与命令层共用同一实例：命令层与同步任务共用一把锁
            let git_sync = GitSync::new();
            registry.register(Arc::new(GitSyncModule::new()));
            // 会话日志服务与模块共用同一实例，日志目录固定为数据目录下的 sessions/
            let session_log = SessionLog::new(paths.log_dir.clone());
            registry.register(Arc::new(SessionLogModule::new(session_log.clone())));
            // SFTP 服务与模块共用同一实例：命令层与模块层看到同一张连接表
            let sftp = SftpManager::new();
            registry.register(Arc::new(SftpModule::new(sftp.clone())));
            // 端口转发服务与模块共用同一实例：命令层与模块层看到同一张转发表
            let port_forward = PortForwardManager::new();
            registry.register(Arc::new(PortForwardModule::new(port_forward.clone())));
            // 导入导出为纯函数式文件 IO，无运行期状态，注册只为统一生命周期日志
            registry.register(Arc::new(ImportExportModule::new()));
            // 命令片段同样无运行期状态，数据全部落在 SQLite 的 snippets 表
            registry.register(Arc::new(SnippetsModule::new()));
            // 命令历史同样无运行期状态，数据全部落在 SQLite 的 command_history 表
            registry.register(Arc::new(CommandHistoryModule::new()));
            // 全局搜索完全在前端聚合已有数据源，没有后端命令，注册只为生命周期日志
            registry.register(Arc::new(GlobalSearchModule::new()));
            // 主题配色全部在前端应用（styles/theme.css + app.js），无运行期状态
            registry.register(Arc::new(ThemeModule::new()));
            // 快捷键派发与冲突检测全部在前端完成（js/shortcuts.js），无运行期状态
            registry.register(Arc::new(ShortcutsModule::new()));
            // 快捷命令面板列动作并在前端过滤执行（js/quick_panel.js），无运行期状态
            registry.register(Arc::new(QuickPanelModule::new()));
            // 系统托盘由下方 build_tray() 按开关构建，这里注册只为设置徽标
            registry.register(Arc::new(SystemTrayModule::new()));
            // 多语言切换完全在前端完成（js/i18n.js + src/locales/），注册只为生命周期日志
            registry.register(Arc::new(I18nModule::new()));
            // AI 助手服务与模块共用同一实例：命令层与后台流式任务共用一个 HTTP 客户端
            let ai = AiService::new();
            registry.register(Arc::new(AiAssistantModule::new(ai.clone())));

            // 托盘开关在启动时即确定，运行期不动态增删托盘，故在构建 AppState 前取一次
            let system_tray_enabled = config.flags().auxiliary.system_tray;

            let state = AppState::new(
                config,
                store,
                paths,
                registry,
                git_sync,
                session_log,
                sftp,
                port_forward,
                ai,
            );
            let ctx = state.module_context(app.handle().clone());
            state.modules.apply(&ctx)?;
            app.manage(state);

            // 系统托盘按开关构建（FEATURES.md §6）：托盘图标 + 右键菜单
            if system_tray_enabled {
                build_tray(app.handle())?;
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // 系统托盘启用时，「关闭窗口」改为隐藏到托盘，否则按默认关闭退出应用。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<AppState>().flags().auxiliary.system_tray {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // 设置与配置
            config::commands::app_info,
            config::commands::get_config,
            config::commands::save_config,
            config::commands::reset_config,
            config::commands::feature_flags,
            config::commands::module_status,
            config::commands::list_connections,
            config::commands::save_connection,
            config::commands::delete_connection,
            config::commands::ai_configured_models,
            config::commands::set_ai_model_key,
            config::commands::clear_ai_model_key,
            // SSH 核心
            ssh::commands::ssh_connect,
            ssh::commands::ssh_write,
            ssh::commands::ssh_resize,
            ssh::commands::ssh_disconnect,
            ssh::commands::ssh_sessions,
            ssh::commands::ssh_recent_output,
            ssh::commands::ssh_test_connection,
            // Git 同步（可开关）
            modules::git_sync::commands::git_sync_status,
            modules::git_sync::commands::git_sync_init,
            modules::git_sync::commands::git_sync_clone,
            modules::git_sync::commands::git_sync_now,
            modules::git_sync::commands::git_sync_pull,
            modules::git_sync::commands::git_sync_push,
            modules::git_sync::commands::git_sync_commit,
            modules::git_sync::commands::git_sync_diff,
            modules::git_sync::commands::git_sync_resolve,
            modules::git_sync::commands::git_sync_credentials,
            modules::git_sync::commands::git_sync_set_credential,
            // 会话日志（可开关）
            features::session_log::commands::session_log_status,
            features::session_log::commands::session_log_list,
            features::session_log::commands::session_log_read,
            features::session_log::commands::session_log_clear,
            // SFTP（可开关）
            features::sftp::commands::sftp_connect,
            features::sftp::commands::sftp_disconnect,
            features::sftp::commands::sftp_sessions,
            features::sftp::commands::sftp_list,
            features::sftp::commands::sftp_download,
            features::sftp::commands::sftp_upload,
            features::sftp::commands::sftp_delete,
            features::sftp::commands::sftp_rename,
            features::sftp::commands::sftp_chmod,
            // 端口转发（可开关）
            features::port_forward::commands::port_forward_start,
            features::port_forward::commands::port_forward_stop,
            features::port_forward::commands::port_forward_list,
            // 连接导入导出（可开关）
            features::import_export::commands::connection_export,
            features::import_export::commands::connection_import,
            features::import_export::commands::import_export_defaults,
            // 输入源自动切换（可开关，仅 macOS 生效）
            features::ime::commands::ime_use_ascii,
            features::ime::commands::ime_restore,
            features::ime::commands::ime_supported,
            // 命令片段（可开关）
            modules::snippets::commands::snippet_list,
            modules::snippets::commands::snippet_save,
            modules::snippets::commands::snippet_delete,
            modules::snippets::commands::snippet_render,
            // 命令历史（可开关）
            modules::command_history::commands::list_history,
            modules::command_history::commands::clear_history,
            modules::command_history::commands::push_history,
            // AI 助手（可开关）
            modules::ai_assistant::commands::ai_ask,
            modules::ai_assistant::commands::ai_cancel,
            modules::ai_assistant::commands::ai_agent_step,
            modules::ai_assistant::commands::ai_test_model,
            modules::ai_assistant::commands::ai_save_model,
            modules::ai_assistant::commands::ai_delete_model,
            // 崩溃日志（可开关）
            utils::commands::crash_log_read,
            utils::commands::crash_log_export,
        ])
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                state.sessions.close_all();
                state.modules.dispose_all();
                log::info!("pshell 已退出");
            }
        });
}

/// 构建系统托盘图标与右键菜单（FEATURES.md §6）。
///
/// 仅在 `auxiliary.system_tray` 为 true 时由启动流程调用：
/// 左键单击恢复到主窗口，右键菜单提供「显示 / 退出」。
/// 「退出」通过 [`tauri::AppHandle::exit`] 真正结束进程，不触发上面的隐藏逻辑。
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    // 左键单击默认弹出菜单（show_menu_on_left_click 为 true），这里改用单击恢复窗口，
    // 让右键弹出菜单，符合「驻留后台 + 一键呼出」的直觉。
    let mut builder = TrayIconBuilder::with_id("pshell-tray")
        .tooltip("pshell")
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