/** 设置面板的常量表（由原 src/legacy/settings.ts 顶部的常量原样迁移）。 */

export interface Option {
  value: string;
  label: string;
}

export const CATEGORIES = [
  { id: "general", label: "通用" },
  { id: "terminal", label: "终端" },
  { id: "connection", label: "连接" },
  { id: "flags", label: "功能开关" },
  { id: "ai", label: "AI 助手" },
  { id: "git", label: "Git 同步" },
  { id: "shortcuts", label: "快捷键" },
  { id: "about", label: "关于" },
];

export const LANGUAGES: Option[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en-US", label: "English" },
];

export const THEME_MODES: Option[] = [
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
  { value: "system", label: "跟随系统" },
];

export const CURSOR_STYLES: Option[] = [
  { value: "block", label: "方块" },
  { value: "underline", label: "下划线" },
  { value: "bar", label: "竖线" },
];

/** 「同步范围」两档：都同步全部数据，区别只在是否带上连接密码 / API Key。 */
export const SCOPE_OPTIONS: Option[] = [
  { value: "all", label: "同步全部" },
  { value: "all_no_secrets", label: "同步全部（不包含连接密码、API Key）" },
];

/** 功能开关的分组顺序与标题，与 feature_flags.rs / FEATURES.md 的章节对应。 */
export const FLAG_GROUPS = [
  { key: "connection", title: "连接与传输" },
  { key: "sync", title: "同步 / Git" },
  { key: "ai", title: "AI 助手" },
  { key: "auxiliary", title: "辅助功能" },
];

/** 开关的中文说明。键为 flatten() 给出的路径；未登记的路径会退回显示原始路径。 */
export const FLAG_META: Record<string, { label: string; hint?: string }> = {
  "connection.tabs": { label: "多标签", hint: "关闭后同一时刻只允许一个会话" },
  "connection.split_view": { label: "分屏", hint: "同一窗口内并排查看多个会话" },
  "connection.sftp": { label: "SFTP 文件传输" },
  "connection.port_forward": { label: "端口转发" },
  "connection.jump_host": { label: "跳板机", hint: "ProxyJump：先连跳板机再转发到目标" },
  "connection.session_log": { label: "会话日志", hint: "本地留存会话输出，便于回溯" },
  "connection.auto_reconnect": { label: "断线自动重连", hint: "按指数退避重试" },
  "connection.connection_group": { label: "连接分组", hint: "侧栏按分组名归类连接" },
  "connection.import_export": { label: "配置导入导出" },
  "connection.rdp": {
    label: "远程桌面（RDP）",
    hint: "新建连接时可选 RDP 协议打开 Windows 远程桌面：Windows 调用系统 mstsc，macOS 调用微软「Windows App」（需自行安装）",
  },
  "connection.quick_connect": { label: "快捷连接", hint: "侧栏直接输入 user@host:port" },
  "connection.sync_input": {
    label: "同步输入",
    hint: "把一台终端上的输入广播到同一同步组内的标签；分组与组内同步开关在标签右键菜单中操作",
  },
  "connection.ime_auto_switch": {
    label: "输入法自动切换",
    hint: "终端聚焦时切到英文输入源、失焦时还原（仅 macOS）；终端内可输中文需切到输入法模式",
  },
  "sync.git_sync": { label: "Git 同步", hint: "用 Git 仓库同步配置，不做云同步" },
  "sync.git_sync_scope": { label: "同步范围" },
  "sync.git_sync_secrets": {
    label: "同步敏感字段密文",
    hint: "关闭后 secrets.json 不再随 Git 同步（主密码冲突时可临时关闭）",
  },
  "sync.git_conflict_prompt": { label: "冲突提示", hint: "检测到冲突时不自动合并" },
  "sync.git_status_badge": { label: "状态徽标", hint: "显示 ahead/behind 与脏文件数" },
  "sync.git_commit_template": { label: "提交模板", hint: "使用下方的提交信息模板" },
  "sync.git_multi_repo": { label: "多仓库" },
  "sync.git_cli_fallback": { label: "允许回退系统 git CLI", hint: "仅在 libgit2 不支持时使用" },
  "ai.ai_assistant": { label: "AI 助手", hint: "总开关；关闭时其余 AI 选项不生效" },
  "ai.ai_streaming": { label: "流式响应", hint: "通过 SSE 逐字返回" },
  "ai.ai_danger_warning": { label: "危险命令提示" },
  "ai.ai_context_inject": { label: "上下文注入", hint: "附带最近的终端输出" },
  "auxiliary.snippets": { label: "命令片段" },
  "auxiliary.global_search": { label: "全局搜索" },
  "auxiliary.command_history": { label: "命令历史" },
  "auxiliary.quick_panel": { label: "快捷面板" },
  "auxiliary.system_tray": { label: "系统托盘" },
  "auxiliary.auto_update": {
    label: "自动更新",
    hint: "启动后自动检查新版本并弹提示；关闭后仍可在「关于」页手动检查",
  },
  "auxiliary.theme": { label: "主题", hint: "关闭后外观设置不生效" },
  "auxiliary.shortcuts": { label: "快捷键", hint: "关闭后不响应自定义组合键" },
  "auxiliary.crash_log": { label: "崩溃日志" },
};

/**
 * 不在「功能开关」里展示的开关。
 *
 * - Git 内部细节（提交模板 / 多仓库 / CLI 回退 / 冲突提示 / 徽标）由「设置 → Git 同步」页
 *   与后端默认行为接管。
 * - 已在专属设置页配置：断线自动重连（设置 → 连接）、快捷键总开关（设置 → 快捷键）。
 * - 必开项（多标签 / 分屏 / 连接分组 / 配置导入导出 / 快捷连接 / 同步输入 / 远程桌面 /
 *   Git 同步 / 流式响应 / 命令片段 / 全局搜索 / 命令历史 / 主题 / 崩溃日志）恒为开启，
 *   后端会强制拉回 true。
 */
export const HIDDEN_FLAGS = new Set([
  "connection.tabs",
  "connection.split_view",
  "connection.connection_group",
  "connection.import_export",
  "connection.quick_connect",
  "connection.sync_input",
  "connection.rdp",
  "connection.auto_reconnect",
  "sync.git_sync",
  "sync.git_sync_scope",
  "sync.git_sync_secrets",
  "sync.git_conflict_prompt",
  "sync.git_status_badge",
  "sync.git_commit_template",
  "sync.git_multi_repo",
  "sync.git_cli_fallback",
  "ai.ai_streaming",
  "auxiliary.snippets",
  "auxiliary.global_search",
  "auxiliary.command_history",
  "auxiliary.theme",
  "auxiliary.shortcuts",
  "auxiliary.crash_log",
]);

/** 开关路径 → 模块标识。有此项的开关会在行尾显示模块运行状态徽标。 */
export const FLAG_MODULE: Record<string, string> = {
  "sync.git_sync": "git_sync",
  "ai.ai_assistant": "ai_assistant",
  "auxiliary.snippets": "snippets",
  "auxiliary.global_search": "global_search",
  "auxiliary.command_history": "command_history",
  "auxiliary.theme": "theme",
  "auxiliary.shortcuts": "shortcuts",
  "auxiliary.quick_panel": "quick_panel",
  "auxiliary.system_tray": "system_tray",
  "auxiliary.auto_update": "auto_update",
  "connection.sftp": "sftp",
  "connection.port_forward": "port_forward",
  "connection.session_log": "session_log",
  "connection.import_export": "import_export",
  "connection.rdp": "rdp",
};
