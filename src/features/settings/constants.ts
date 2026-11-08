
export interface Option {
  value: string;
  label: string;
}

export const CATEGORIES = [
  { id: "general", label: "通用" },
  { id: "terminal", label: "终端" },
  { id: "connection", label: "连接" },
  { id: "ai", label: "AI 助手" },
  { id: "mcp", label: "MCP 服务" },
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
