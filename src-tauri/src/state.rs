use std::sync::Arc;

use tauri::AppHandle;

use crate::config::feature_flags::FeatureFlags;
use crate::config::store::SharedStore;
use crate::config::ConfigManager;
use crate::error::{AppError, AppResult};
use crate::features::port_forward::PortForwardManager;
use crate::features::session_log::SessionLog;
use crate::features::sftp::SftpManager;
use crate::modules::ai_assistant::{AiContext, AiService};
use crate::modules::git_sync::{GitSync, SyncContext};
use crate::modules::{ModuleContext, ModuleRegistry};
use crate::ssh::interactive::AuthPromptHub;
use crate::ssh::known_hosts::{self, KnownHostsStore};
use crate::ssh::session::{SessionDeps, SessionLogger, SessionManager};
use crate::utils::Paths;

/// 应用全局状态，由 Tauri 托管，command 通过 `State<AppState>` 获取。
pub struct AppState {
    pub config: Arc<ConfigManager>,
    pub store: SharedStore,
    pub paths: Paths,
    pub modules: ModuleRegistry,
    pub sessions: SessionManager,
    /// Git 同步服务。命令层与模块层共用同一实例（同一把锁、同一个调度器）。
    pub git_sync: GitSync,
    /// 会话日志服务。命令层与模块层共用同一实例。
    pub session_log: SessionLog,
    /// SFTP 服务。命令层与模块层共用同一实例（同一张会话表）。
    pub sftp: SftpManager,
    /// 端口转发服务。命令层与模块层共用同一实例（同一张转发表）。
    pub port_forward: PortForwardManager,
    /// AI 服务。命令层与模块层共用同一实例（同一个 HTTP 客户端、同一张取消表）。
    pub ai: AiService,
    /// 已知主机（主机密钥）存储。配置目录下的 `known_hosts.json`，本机私有、不随 Git 同步。
    pub known_hosts: Arc<KnownHostsStore>,
    /// 键盘交互认证的应答中枢。命令层与会话线程共用同一实例。
    pub auth_hub: Arc<AuthPromptHub>,
}

impl AppState {
    pub fn new(
        config: Arc<ConfigManager>,
        store: SharedStore,
        paths: Paths,
        modules: ModuleRegistry,
        git_sync: GitSync,
        session_log: SessionLog,
        sftp: SftpManager,
        port_forward: PortForwardManager,
        ai: AiService,
    ) -> Self {
        // 已知主机表随配置目录存放，本机私有、不随 Git 同步
        let known_hosts = Arc::new(KnownHostsStore::load(
            paths.config_dir.join("known_hosts.json"),
        ));
        // 安装全局主机密钥校验器：终端 / SFTP / 端口转发 / 跳板机共用同一存储与配置
        known_hosts::install(known_hosts.clone(), config.clone());
        Self {
            config,
            store,
            paths,
            modules,
            sessions: SessionManager::new(),
            git_sync,
            session_log,
            sftp,
            port_forward,
            ai,
            known_hosts,
            auth_hub: Arc::new(AuthPromptHub::new()),
        }
    }

    pub fn flags(&self) -> FeatureFlags {
        self.config.flags()
    }

    /// 组装可插拔模块的初始化上下文。
    pub fn module_context(&self, app: AppHandle) -> ModuleContext {
        ModuleContext {
            app,
            config: self.config.clone(),
            store: self.store.clone(),
            paths: self.paths.clone(),
            sessions: self.sessions.clone(),
        }
    }

    /// 组装 Git 同步上下文。命令层与模块层共用同一个 [`GitSync`] 实例。
    pub fn sync_context(&self, app: AppHandle) -> SyncContext {
        SyncContext::new(
            app,
            self.config.clone(),
            self.store.clone(),
            self.paths.clone(),
            self.git_sync.clone(),
        )
    }

    /// 组装 AI 调用上下文。命令层与后台任务共用同一个 [`AiService`] 实例。
    pub fn ai_context(&self, app: AppHandle) -> AiContext {
        AiContext {
            app,
            config: self.config.clone(),
            store: self.store.clone(),
            service: self.ai.clone(),
        }
    }

    /// 组装 SSH 会话线程所需的上下文。
    pub fn session_deps(&self, app: &AppHandle) -> SessionDeps {
        // 会话日志关闭时不注入记录器：不建文件、不产生任何写入
        let logger: Option<Arc<dyn SessionLogger>> = if self.flags().connection.session_log {
            Some(Arc::new(self.session_log.clone()))
        } else {
            None
        };
        SessionDeps {
            app: app.clone(),
            config: self.config.clone(),
            logger,
            auth_hub: self.auth_hub.clone(),
        }
    }

    /// 模块门控：关闭的模块对应的 command 一律拒绝执行。
    pub fn require_module(&self, id: &str) -> AppResult<()> {
        if self.flags().module_enabled(id) {
            Ok(())
        } else {
            Err(AppError::ModuleDisabled(id.to_string()))
        }
    }
}