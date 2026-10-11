use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// 模块标识常量。新增可选模块时必须先在此登记，并在 `FEATURES.md` 登记。
pub mod module_id {
    pub const GIT_SYNC: &str = "git_sync";
    pub const AI_ASSISTANT: &str = "ai_assistant";
    pub const SNIPPETS: &str = "snippets";
    pub const GLOBAL_SEARCH: &str = "global_search";
    pub const SFTP: &str = "sftp";
    pub const PORT_FORWARD: &str = "port_forward";
    pub const SESSION_LOG: &str = "session_log";
    pub const IMPORT_EXPORT: &str = "import_export";
    pub const RDP: &str = "rdp";
    pub const COMMAND_HISTORY: &str = "command_history";
    pub const THEME: &str = "theme";
    pub const SHORTCUTS: &str = "shortcuts";
    pub const QUICK_PANEL: &str = "quick_panel";
    pub const SYSTEM_TRAY: &str = "system_tray";
    pub const IME_SWITCH: &str = "ime_switch";
}

/// 可插拔模块统一接口。
///
/// 所有非核心模块（Git 同步 / AI 助手 / 命令片段 / 全局搜索 / 命令历史 / 主题 / 快捷键 /
/// SFTP / 端口转发 / 会话日志 / 导入导出）都必须实现本 trait。
/// SSH 核心模块不可关闭，不实现本 trait。
///
/// 契约：
/// - `is_enabled` 返回 false 时，`init` 不会被调用，前端也不应加载对应 UI。
/// - 开关在运行期变化时，注册表会调用 `dispose` 后再决定是否 `init`。
pub trait PluggableModule: Send + Sync {
    /// 模块唯一标识，取值见 [`module_id`]。
    fn id(&self) -> &'static str;

    /// 当前配置下该模块是否启用。
    fn is_enabled(&self, flags: &FeatureFlags) -> bool;

    /// 模块初始化：注册后台任务、准备资源。仅在 `is_enabled` 为 true 时调用。
    fn init(&self, ctx: &crate::modules::ModuleContext) -> AppResult<()> {
        let _ = ctx;
        Ok(())
    }

    /// 模块卸载：停止后台任务、释放资源。可重复调用。
    fn dispose(&self) -> AppResult<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 连接与传输（FEATURES.md §3）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct ConnectionFlags {
    /// 多标签
    pub tabs: bool,
    /// 分屏
    pub split_view: bool,
    /// SFTP 文件传输
    pub sftp: bool,
    /// 端口转发
    pub port_forward: bool,
    /// 跳板机（ProxyJump）
    pub jump_host: bool,
    /// 会话日志
    pub session_log: bool,
    /// 断线自动重连
    pub auto_reconnect: bool,
    /// 自动重连最大尝试次数
    pub auto_reconnect_max_attempts: u32,
    /// 自动重连基础退避间隔（毫秒），按指数增长，上限 30s
    pub auto_reconnect_base_delay_ms: u64,
    /// 连接分组
    pub connection_group: bool,
    /// 配置导入导出
    pub import_export: bool,
    /// Windows 远程桌面（RDP）连接：调用系统 RDP 客户端打开远程桌面
    pub rdp: bool,
    /// 快捷连接（user@host:port 一行直达）
    pub quick_connect: bool,
    /// 同步输入：把一台终端上的输入广播到同步组内的标签（或全局所有会话）
    pub sync_input: bool,
    /// 终端获得焦点时自动把系统输入源切到英文、失焦时还原（仅 macOS）。
    /// 关闭后需用户自行保证终端里使用英文输入法，否则输入法异常时快打会漏字。
    pub ime_auto_switch: bool,
    /// 会话日志保留天数
    pub session_log_retention_days: u32,
}

impl Default for ConnectionFlags {
    fn default() -> Self {
        Self {
            tabs: true,
            split_view: true,
            sftp: true,
            port_forward: true,
            jump_host: true,
            session_log: false,
            auto_reconnect: true,
            auto_reconnect_max_attempts: 5,
            auto_reconnect_base_delay_ms: 1000,
            connection_group: true,
            import_export: true,
            rdp: false,
            quick_connect: true,
            sync_input: true,
            ime_auto_switch: true,
            session_log_retention_days: 30,
        }
    }
}

// ---------------------------------------------------------------------------
// 同步 / Git（FEATURES.md §4）
// ---------------------------------------------------------------------------

/// 同步范围。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncScope {
    Config,
    Snippets,
    All,
}

impl Default for SyncScope {
    fn default() -> Self {
        SyncScope::Config
    }
}

/// 单个远程仓库配置（多仓库场景）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct GitRemoteConfig {
    /// remote 名称，如 origin
    pub name: String,
    /// 远程地址（ssh 或 https）
    pub url: String,
    /// 推送目标分支，留空则用当前分支同名
    pub branch: Option<String>,
    /// HTTPS 登录用户名（非敏感）。密码 / 访问令牌存加密保险库，不在此处。
    pub username: Option<String>,
}

impl Default for GitRemoteConfig {
    fn default() -> Self {
        Self {
            name: "origin".into(),
            url: String::new(),
            branch: None,
            username: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct SyncFlags {
    /// Git 同步总开关
    pub git_sync: bool,
    /// 本地仓库路径（同步的落地目录）
    pub git_repo_path: Option<String>,
    /// 同步范围
    pub git_sync_scope: SyncScope,
    /// 是否同步敏感字段密文（`secrets.json`）。关闭后本地与远端互不覆盖，
    /// 用于「主密码冲突」时暂时搁置敏感字段同步。
    pub git_sync_secrets: bool,
    /// 冲突提示（检测到冲突时不自动合并）
    pub git_conflict_prompt: bool,
    /// 界面状态显示（ahead/behind、脏文件数、最后同步时间）
    pub git_status_badge: bool,
    /// 提交模板开关
    pub git_commit_template: bool,
    /// 提交信息模板，支持 {date} {time} {host} {count} {scope}
    pub git_commit_template_text: String,
    /// 多仓库
    pub git_multi_repo: bool,
    /// 多仓库配置
    pub git_remotes: Vec<GitRemoteConfig>,
    /// 提交作者
    pub git_author_name: String,
    pub git_author_email: String,
    /// 遇到 libgit2 不支持的场景时是否允许回退系统 git CLI
    pub git_cli_fallback: bool,
}

impl Default for SyncFlags {
    fn default() -> Self {
        Self {
            git_sync: false,
            git_repo_path: None,
            git_sync_scope: SyncScope::Config,
            git_sync_secrets: true,
            git_conflict_prompt: true,
            git_status_badge: true,
            git_commit_template: true,
            git_commit_template_text: "sync({scope}): {count} 项变更 @ {date} {time}".into(),
            git_multi_repo: false,
            git_remotes: vec![GitRemoteConfig::default()],
            git_author_name: "pterm".into(),
            git_author_email: "pterm@localhost".into(),
            git_cli_fallback: true,
        }
    }
}

// ---------------------------------------------------------------------------
// AI（FEATURES.md §5）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct AiFlags {
    /// AI 助手总开关。Ask / Agent 两种模式由面板切换，不另设开关。
    pub ai_assistant: bool,
    /// 流式响应
    pub ai_streaming: bool,
    /// 危险命令提示：Agent 请求执行的命令命中危险规则时额外二次确认
    pub ai_danger_warning: bool,
    /// 上下文注入
    pub ai_context_inject: bool,
}

impl Default for AiFlags {
    fn default() -> Self {
        Self {
            ai_assistant: false,
            ai_streaming: true,
            ai_danger_warning: true,
            ai_context_inject: true,
        }
    }
}

// ---------------------------------------------------------------------------
// 辅助（FEATURES.md §6）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct AuxiliaryFlags {
    /// 命令片段
    pub snippets: bool,
    /// 全局搜索
    pub global_search: bool,
    /// 命令历史
    pub command_history: bool,
    /// 快捷面板
    pub quick_panel: bool,
    /// 系统托盘
    pub system_tray: bool,
    /// 自动更新
    pub auto_update: bool,
    /// 主题
    pub theme: bool,
    /// 快捷键
    pub shortcuts: bool,
    /// 崩溃日志
    pub crash_log: bool,
}

impl Default for AuxiliaryFlags {
    fn default() -> Self {
        Self {
            snippets: true,
            global_search: true,
            command_history: true,
            quick_panel: true,
            system_tray: false,
            auto_update: false,
            theme: true,
            shortcuts: true,
            crash_log: true,
        }
    }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

/// 全局功能开关。与 `FEATURES.md` 一一对应。
///
/// 注意：这里**没有**也**不允许**出现「笔记」相关字段——该功能已明确移除。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct FeatureFlags {
    pub connection: ConnectionFlags,
    pub sync: SyncFlags,
    pub ai: AiFlags,
    pub auxiliary: AuxiliaryFlags,
}

impl FeatureFlags {
    /// 按模块标识查询总开关。Tauri command 在运行期用它做门控：
    /// 命令始终注册，但模块关闭时直接返回 `ModuleDisabled`。
    pub fn module_enabled(&self, id: &str) -> bool {
        match id {
            module_id::GIT_SYNC => self.sync.git_sync,
            module_id::AI_ASSISTANT => self.ai.ai_assistant,
            module_id::SNIPPETS => self.auxiliary.snippets,
            module_id::GLOBAL_SEARCH => self.auxiliary.global_search,
            module_id::SFTP => self.connection.sftp,
            module_id::PORT_FORWARD => self.connection.port_forward,
            module_id::SESSION_LOG => self.connection.session_log,
            module_id::IMPORT_EXPORT => self.connection.import_export,
            module_id::RDP => self.connection.rdp,
            module_id::COMMAND_HISTORY => self.auxiliary.command_history,
            module_id::THEME => self.auxiliary.theme,
            module_id::SHORTCUTS => self.auxiliary.shortcuts,
            module_id::QUICK_PANEL => self.auxiliary.quick_panel,
            module_id::SYSTEM_TRAY => self.auxiliary.system_tray,
            module_id::IME_SWITCH => self.connection.ime_auto_switch,
            // 未登记的标识视为可用，避免误伤核心功能
            _ => true,
        }
    }

    /// 返回所有已注册的开关及其路径与当前值，供设置界面渲染。
    pub fn flatten(&self) -> Vec<FlagEntry> {
        macro_rules! entries {
            ($group:expr, [$($path:literal => $value:expr),* $(,)?]) => {
                vec![$(FlagEntry {
                    path: format!("{}.{}", $group, $path),
                    value: serde_json::json!($value),
                }),*]
            };
        }

        let mut out = Vec::new();
        out.extend(entries!("connection", [
            "tabs" => self.connection.tabs,
            "split_view" => self.connection.split_view,
            "sftp" => self.connection.sftp,
            "port_forward" => self.connection.port_forward,
            "jump_host" => self.connection.jump_host,
            "session_log" => self.connection.session_log,
            "auto_reconnect" => self.connection.auto_reconnect,
            "connection_group" => self.connection.connection_group,
            "import_export" => self.connection.import_export,
            "rdp" => self.connection.rdp,
            "quick_connect" => self.connection.quick_connect,
            "sync_input" => self.connection.sync_input,
            "ime_auto_switch" => self.connection.ime_auto_switch,
        ]));
        out.extend(entries!("sync", [
            "git_sync" => self.sync.git_sync,
            "git_sync_scope" => self.sync.git_sync_scope,
            "git_sync_secrets" => self.sync.git_sync_secrets,
            "git_conflict_prompt" => self.sync.git_conflict_prompt,
            "git_status_badge" => self.sync.git_status_badge,
            "git_commit_template" => self.sync.git_commit_template,
            "git_multi_repo" => self.sync.git_multi_repo,
            "git_cli_fallback" => self.sync.git_cli_fallback,
        ]));
        out.extend(entries!("ai", [
            "ai_assistant" => self.ai.ai_assistant,
            "ai_streaming" => self.ai.ai_streaming,
            "ai_danger_warning" => self.ai.ai_danger_warning,
            "ai_context_inject" => self.ai.ai_context_inject,
        ]));
        out.extend(entries!("auxiliary", [
            "snippets" => self.auxiliary.snippets,
            "global_search" => self.auxiliary.global_search,
            "command_history" => self.auxiliary.command_history,
            "quick_panel" => self.auxiliary.quick_panel,
            "system_tray" => self.auxiliary.system_tray,
            "auto_update" => self.auxiliary.auto_update,
            "theme" => self.auxiliary.theme,
            "shortcuts" => self.auxiliary.shortcuts,
            "crash_log" => self.auxiliary.crash_log,
        ]));
        out
    }
}

/// 单条开关的扁平化视图。
#[derive(Debug, Clone, Serialize)]
pub struct FlagEntry {
    pub path: String,
    pub value: serde_json::Value,
}

/// 供前端展示的模块状态快照。
#[derive(Debug, Clone, Serialize)]
pub struct ModuleStatus {
    pub id: String,
    pub enabled: bool,
    pub initialized: bool,
    /// 已初始化的模块若被关闭，这里记录尚未释放的资源说明
    pub note: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 已登记的模块标识必须真实反映开关：`module_enabled` 的兜底为 true，
    /// 漏登记会让 `require_module` 恒通过，门控静默失效。
    #[test]
    fn command_history_follows_its_flag() {
        let mut flags = FeatureFlags::default();
        flags.auxiliary.command_history = false;
        assert!(!flags.module_enabled(module_id::COMMAND_HISTORY));

        flags.auxiliary.command_history = true;
        assert!(flags.module_enabled(module_id::COMMAND_HISTORY));
    }

    #[test]
    fn global_search_follows_its_flag() {
        let mut flags = FeatureFlags::default();
        flags.auxiliary.global_search = false;
        assert!(!flags.module_enabled(module_id::GLOBAL_SEARCH));

        flags.auxiliary.global_search = true;
        assert!(flags.module_enabled(module_id::GLOBAL_SEARCH));
    }

    #[test]
    fn theme_follows_its_flag() {
        let mut flags = FeatureFlags::default();
        flags.auxiliary.theme = false;
        assert!(!flags.module_enabled(module_id::THEME));

        flags.auxiliary.theme = true;
        assert!(flags.module_enabled(module_id::THEME));
    }

    #[test]
    fn shortcuts_follow_their_flag() {
        let mut flags = FeatureFlags::default();
        flags.auxiliary.shortcuts = false;
        assert!(!flags.module_enabled(module_id::SHORTCUTS));

        flags.auxiliary.shortcuts = true;
        assert!(flags.module_enabled(module_id::SHORTCUTS));
    }

    #[test]
    fn quick_panel_follows_its_flag() {
        let mut flags = FeatureFlags::default();
        flags.auxiliary.quick_panel = false;
        assert!(!flags.module_enabled(module_id::QUICK_PANEL));

        flags.auxiliary.quick_panel = true;
        assert!(flags.module_enabled(module_id::QUICK_PANEL));
    }

    #[test]
    fn system_tray_follows_its_flag() {
        let mut flags = FeatureFlags::default();
        flags.auxiliary.system_tray = false;
        assert!(!flags.module_enabled(module_id::SYSTEM_TRAY));

        flags.auxiliary.system_tray = true;
        assert!(flags.module_enabled(module_id::SYSTEM_TRAY));
    }

    #[test]
    fn rdp_follows_its_flag() {
        let mut flags = FeatureFlags::default();
        flags.connection.rdp = false;
        assert!(!flags.module_enabled(module_id::RDP));

        flags.connection.rdp = true;
        assert!(flags.module_enabled(module_id::RDP));
    }

    #[test]
    fn ime_switch_follows_its_flag() {
        let mut flags = FeatureFlags::default();
        flags.connection.ime_auto_switch = false;
        assert!(!flags.module_enabled(module_id::IME_SWITCH));

        flags.connection.ime_auto_switch = true;
        assert!(flags.module_enabled(module_id::IME_SWITCH));
    }

    #[test]
    fn ai_assistant_follows_its_flag() {
        let mut flags = FeatureFlags::default();
        flags.ai.ai_assistant = false;
        assert!(!flags.module_enabled(module_id::AI_ASSISTANT));

        flags.ai.ai_assistant = true;
        assert!(flags.module_enabled(module_id::AI_ASSISTANT));
    }
}