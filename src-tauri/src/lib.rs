mod config;
mod error;
mod features;
mod modules;
mod ssh;
mod state;
mod utils;

use std::sync::Arc;

use tauri::Manager;

use config::store::Store;
use config::ConfigManager;
use features::import_export::ImportExportModule;
use features::port_forward::{PortForwardManager, PortForwardModule};
use features::rdp::RdpModule;
use features::session_log::{SessionLog, SessionLogModule};
use features::sftp::{SftpManager, SftpModule};
use modules::ai_assistant::{AiAssistantModule, AiService};
use modules::auto_update::AutoUpdateModule;
use modules::command_history::CommandHistoryModule;
use modules::git_sync::{GitSync, GitSyncModule};
use modules::global_search::GlobalSearchModule;
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
        // 自动更新：从 tauri.conf.json 的 plugins.updater 配置的 GitHub Releases
        // latest.json 检查更新（见 modules/auto_update）
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let paths = Paths::resolve()?;
            let config = ConfigManager::load(paths.config_file())?;
            // 敏感字段统一由主密码加密的保险库保管（配置目录下的 secrets.json）
            config::vault::init(paths.config_dir.join("secrets.json"))?;
            // 首次设置 / 输入主密码后，派生密钥会存进配置目录下的 vault.token；
            // 这里尝试静默解锁，让「新装首次输入」之外不再重复要求主密码。
            match config::vault::auto_unlock() {
                Ok(true) => log::info!("已用本地自动解锁令牌解锁保险库"),
                Ok(false) => {}
                Err(e) => log::warn!("自动解锁保险库失败：{e}"),
            }
            let crash_log = config.flags().auxiliary.crash_log;
            utils::init_logging(crash_log, paths.crash_log.clone());
            log::info!("pterm 启动，配置目录 {}", paths.config_dir.display());

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
            // 远程桌面（RDP）：不实现协议，连接交给系统 / 外部客户端
            registry.register(Arc::new(RdpModule::new()));
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
            // 系统托盘由模块生命周期构建 / 移除（modules/system_tray），这里注册即可
            registry.register(Arc::new(SystemTrayModule::new()));
            // 自动更新无运行期状态，检查与安装都由命令驱动（modules/auto_update）
            registry.register(Arc::new(AutoUpdateModule::new()));
            // AI 助手服务与模块共用同一实例：命令层与后台流式任务共用一个 HTTP 客户端
            let ai = AiService::new();
            registry.register(Arc::new(AiAssistantModule::new(ai.clone())));

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
            // 首次启动引导（核心，不随模块开关）
            config::commands::onboarding_status,
            config::commands::onboarding_complete,
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
            // 主密码保险库（核心，不随模块开关）
            config::commands::vault_status,
            config::commands::vault_setup,
            config::commands::vault_unlock,
            config::commands::vault_change_password,
            config::commands::vault_lock,
            config::commands::vault_reset,
            config::commands::vault_adopt_pending,
            config::commands::vault_discard_pending,
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
            modules::git_sync::commands::git_sync_test,
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
            features::sftp::commands::sftp_cancel_transfer,
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
            // 远程桌面（可开关）
            features::rdp::commands::rdp_client_available,
            features::rdp::commands::rdp_saved_password,
            features::rdp::commands::rdp_open,
            features::rdp::commands::rdp_probe,
            features::rdp::commands::rdp_open_installer,
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
            modules::ai_assistant::commands::ai_protocols,
            // 崩溃日志（可开关）
            utils::commands::crash_log_read,
            utils::commands::crash_log_export,
            // 自动更新（可开关）
            modules::auto_update::commands::auto_update_check,
            modules::auto_update::commands::auto_update_install,
        ])
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                state.sessions.close_all();
                state.modules.dispose_all();
                log::info!("pterm 已退出");
            }
        });
}