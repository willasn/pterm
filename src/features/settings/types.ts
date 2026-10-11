/** 设置面板涉及的少量结构类型。config draft 形状较宽，按 any 处理。 */

/** feature_flags 扁平化后的一项。 */
export interface FlagEntry {
  path: string;
  value: boolean;
}

/** 模块运行状态（module_status 返回）。 */
export interface ModuleStatus {
  id: string;
  enabled: boolean;
  initialized: boolean;
  note?: string;
}

/** app_info 返回的运行时路径信息。 */
export interface AppInfo {
  name?: string;
  version?: string;
  config_file?: string;
  database_file?: string;
  log_dir?: string;
}

/** 崩溃日志读取结果（crash_log_read 返回）。 */
export interface CrashLogInfo {
  exists: boolean;
  path: string;
  bytes: number;
  truncated: boolean;
  content: string;
}

/** 保险库状态（vault_status 返回）。 */
export interface VaultStatus {
  configured: boolean;
  unlocked: boolean;
}

/** AI 模型配置项。 */
export interface AiModelConfig {
  id: string;
  name: string;
  model: string;
  base_url: string;
  protocol: string;
  temperature: number | null;
  max_tokens: number | null;
  max_input_tokens: number | null;
  timeout_secs: number | null;
  context_bytes: number | null;
}

/** 协议元信息（ai_protocols 返回）。 */
export interface ProtocolSpec {
  value: string;
  label: string;
  suffix: string;
  note: string;
}

/** 快捷键绑定项。 */
export interface ShortcutBinding {
  action: string;
  keys: string;
  enabled: boolean;
}

/** 冲突报告项（shortcuts.conflicts 返回）。 */
export interface ShortcutIssue {
  action: string;
  text: string;
  level: string;
  duplicateOf?: string;
}

/** 一条快捷键编辑行。 */
export interface ShortcutRow {
  label: string;
  hint: string;
  binding: ShortcutBinding;
  removable: boolean;
}

/** 内联状态行（测试结果 / 操作反馈）。 */
export interface InlineStatus {
  text: string;
  kind: string;
}
