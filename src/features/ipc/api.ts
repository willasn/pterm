/**
 * Tauri IPC 封装（由原 src/legacy/ipc.ts 迁移而来）。
 *
 * 前端不直接访问 SSH / Git / AI 底层，全部经此走 Tauri command。
 * 这里是一层薄封装：`call` 负责 invoke，`listen` 负责把事件 payload 解包后交给订阅方。
 */

const api = ((window as any).__TAURI__ && ((window as any).__TAURI__.core || (window as any).__TAURI__)) || null;
const events = ((window as any).__TAURI__ && (window as any).__TAURI__.event) || null;

/** 是否运行在 Tauri 宿主中（纯浏览器里调试前端时为 false，command 调用会抛错）。 */
export const available: boolean = !!(api && typeof api.invoke === "function");

/** 调用一个 Tauri command。 */
export async function call<T = any>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!available) {
    throw new Error("未运行在 Tauri 宿主中，无法调用 " + command);
  }
  return api.invoke(command, args || {});
}

/** 订阅后端事件，返回取消订阅函数。 */
export async function listen(event: string, handler: (payload: any) => void): Promise<() => void> {
  if (!events || typeof events.listen !== "function") return () => {};
  return events.listen(event, (message: { payload: any }) => handler(message.payload));
}

/** 全部 command 与事件订阅入口（与迁移前的 PTerm.ipc 形状一致）。 */
export const ipc = {
  available,
  call,
  listen,

  // ---------- 应用与配置 ----------
  appInfo: () => call("app_info"),
  // 首次启动引导（核心，不随模块开关）：标记文件为本机私有，不随 Git 同步
  onboardingStatus: () => call("onboarding_status"),
  onboardingComplete: () => call("onboarding_complete"),
  getConfig: () => call("get_config"),
  saveConfig: (config: any) => call("save_config", { config }),
  featureFlags: () => call("feature_flags"),
  moduleStatus: () => call("module_status"),
  resetConfig: () => call("reset_config"),

  // ---------- 连接配置 ----------
  listConnections: () => call("list_connections"),
  saveConnection: (input: any) => call("save_connection", { input }),
  deleteConnection: (id: string) => call("delete_connection", { id }),

  // ---------- 主密码保险库（核心，不随模块开关） ----------
  vaultStatus: () => call("vault_status"),
  vaultSetup: (password: string) => call("vault_setup", { password }),
  vaultUnlock: (password: string) => call("vault_unlock", { password }),
  vaultChangePassword: (current: string, newPassword: string) =>
    call("vault_change_password", { current, newPassword }),
  vaultLock: () => call("vault_lock"),
  vaultReset: () => call("vault_reset"),
  // 主密码冲突（Git 同步的保险库与本机不一致）
  vaultAdoptPending: (password: string) => call("vault_adopt_pending", { password }),
  vaultDiscardPending: () => call("vault_discard_pending"),

  // ---------- AI 模型 API Key（每个模型一把，存加密保险库） ----------
  aiConfiguredModels: () => call("ai_configured_models"),
  setAiModelKey: (modelId: string, key: string) => call("set_ai_model_key", { modelId, key }),
  clearAiModelKey: (modelId: string) => call("clear_ai_model_key", { modelId }),

  // ---------- AI 模型配置（测试连通性 / 单条保存与删除） ----------
  aiTestModel: (input: any) => call("ai_test_model", { input }),
  aiSaveModel: (model: any, apiKey: string) => call("ai_save_model", { input: { model, api_key: apiKey } }),
  aiDeleteModel: (modelId: string) => call("ai_delete_model", { modelId }),
  // 可选协议清单（值 / 展示名 / 路径后缀 / 说明），用于渲染协议下拉与后缀提示
  aiProtocols: () => call("ai_protocols"),

  // ---------- AI 助手（可开关） ----------
  aiAsk: (input: any) => call("ai_ask", { input }),
  aiCancel: (id: string) => call("ai_cancel", { id }),
  aiAgentStep: (input: any) => call("ai_agent_step", { input }),
  // 上下文注入开关（开关在 AI 助手面板标题栏，不在「设置 → 功能开关」中）
  aiSetContextInject: (enabled: boolean) => call("ai_set_context_inject", { enabled }),

  // ---------- 命令历史（可开关） ----------
  listHistory: (limit: number, query: string | null, dedupe: boolean, order: string) =>
    call("list_history", { limit, query, dedupe, order }),
  clearHistory: () => call("clear_history"),
  pushHistory: (command: string, host: string, sessionId: string) => call("push_history", { command, host, sessionId }),

  // ---------- SSH ----------
  sshConnect: (params: any) => call("ssh_connect", { params }),
  sshWrite: (id: string, data: string) => call("ssh_write", { id, data }),
  sshResize: (id: string, cols: number, rows: number) => call("ssh_resize", { id, cols, rows }),
  sshDisconnect: (id: string) => call("ssh_disconnect", { id }),
  sshSessions: () => call("ssh_sessions"),
  sshRecentOutput: (id: string, maxBytes: number) => call("ssh_recent_output", { id, maxBytes }),
  sshTestConnection: (params: any) => call("ssh_test_connection", { params }),
  // 主机密钥校验（known_hosts / TOFU）
  sshKnownHostsList: () => call("ssh_known_hosts_list"),
  sshKnownHostsForget: (host: string, port: number) => call("ssh_known_hosts_forget", { host, port }),
  // 键盘交互认证（keyboard-interactive）提示应答。text 为 null 表示用户取消。
  sshAuthRespond: (id: string, text: string | null) => call("ssh_auth_respond", { id, text }),
  sshAuthPending: (id: string) => call("ssh_auth_pending", { id }),

  // ---------- 本地终端（可开关，本机 PTY shell） ----------
  localTerminalOpen: (cols: number, rows: number, sessionId: string | null) =>
    call("local_terminal_open", { cols, rows, sessionId }),

  // ---------- 输入源自动切换（可开关，仅 macOS 生效） ----------
  imeUseAscii: () => call("ime_use_ascii"),
  imeRestore: () => call("ime_restore"),
  imeSupported: () => call("ime_supported"),

  // ---------- 会话日志（可开关） ----------
  sessionLogStatus: () => call("session_log_status"),
  sessionLogList: () => call("session_log_list"),
  sessionLogRead: (name: string, maxBytes: number) => call("session_log_read", { name, maxBytes }),
  sessionLogClear: () => call("session_log_clear"),

  // ---------- SFTP（可开关） ----------
  // 上传/下载带 transferId：进度事件按它回传，中断也按它发起。
  sftpConnect: (params: any) => call("sftp_connect", { params }),
  sftpDisconnect: (id: string) => call("sftp_disconnect", { id }),
  sftpSessions: () => call("sftp_sessions"),
  sftpList: (id: string, path: string) => call("sftp_list", { id, path }),
  sftpDownload: (id: string, remote: string, local: string, transferId: string) =>
    call("sftp_download", { id, remote, local, transferId }),
  sftpUpload: (id: string, local: string, remote: string, transferId: string) =>
    call("sftp_upload", { id, local, remote, transferId }),
  sftpCancelTransfer: (transferId: string) => call("sftp_cancel_transfer", { transferId }),
  sftpDelete: (id: string, path: string) => call("sftp_delete", { id, path }),
  sftpRename: (id: string, from: string, to: string) => call("sftp_rename", { id, from, to }),
  sftpChmod: (id: string, path: string, mode: number) => call("sftp_chmod", { id, path, mode }),

  // ---------- 端口转发（可开关） ----------
  portForwardStart: (request: any) => call("port_forward_start", { request }),
  portForwardStop: (id: string) => call("port_forward_stop", { id }),
  portForwardList: () => call("port_forward_list"),

  // ---------- 连接导入导出（可开关） ----------
  connectionExport: (path: string, ids: string[]) => call("connection_export", { path, ids }),
  connectionImport: (path: string, format: string) => call("connection_import", { path, format }),
  importExportDefaults: () => call("import_export_defaults"),

  // ---------- 远程桌面（可开关） ----------
  rdpClientAvailable: () => call("rdp_client_available"),
  rdpSavedPassword: (connectionId: string) => call("rdp_saved_password", { connectionId }),
  rdpOpen: (input: any) => call("rdp_open", { input }),
  rdpProbe: (host: string, port: number, timeoutMs: number) => call("rdp_probe", { host, port, timeoutMs }),
  rdpOpenInstaller: () => call("rdp_open_installer"),

  // ---------- 命令片段（可开关） ----------
  snippetList: () => call("snippet_list"),
  snippetSave: (snippet: any) => call("snippet_save", { snippet }),
  snippetDelete: (id: string) => call("snippet_delete", { id }),
  snippetRender: (content: string, values: any) => call("snippet_render", { content, values }),

  // ---------- 崩溃日志（可开关） ----------
  crashLogRead: (tailBytes: number) => call("crash_log_read", { tailBytes }),
  crashLogExport: (path: string) => call("crash_log_export", { path }),

  // ---------- 系统剪贴板（核心） ----------
  clipboardReadText: () => call<string>("clipboard_read_text"),
  clipboardWriteText: (text: string) => call("clipboard_write_text", { text }),

  // ---------- 自动更新（可开关） ----------
  updateCheck: () => call("auto_update_check"),
  updateInstall: () => call("auto_update_install"),

  // ---------- Git 同步（可开关） ----------
  gitStatus: () => call("git_sync_status"),
  gitInit: () => call("git_sync_init"),
  gitClone: (url: string) => call("git_sync_clone", { url }),
  gitSyncNow: (includeSecrets?: boolean) => call("git_sync_now", { includeSecrets }),
  gitPull: () => call("git_sync_pull"),
  gitPush: () => call("git_sync_push"),
  gitCommit: () => call("git_sync_commit"),
  gitDiff: () => call("git_sync_diff"),
  gitResolve: (connections: any, snippets: any) => call("git_sync_resolve", { connections, snippets }),
  gitCredentials: () => call("git_sync_credentials"),
  gitSetCredential: (name: string, password: string) => call("git_sync_set_credential", { name, password }),
  gitTest: (input: any) => call("git_sync_test", { input }),
};
