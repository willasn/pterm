/* Tauri IPC 封装。前端不直接访问 SSH / Git / AI 底层，全部经此走 Tauri command。 */
(function (PShell) {
  "use strict";

  const api = (window.__TAURI__ && (window.__TAURI__.core || window.__TAURI__)) || null;
  const events = (window.__TAURI__ && window.__TAURI__.event) || null;

  const available = !!(api && typeof api.invoke === "function");

  async function call(command, args) {
    if (!available) {
      throw new Error("未运行在 Tauri 宿主中，无法调用 " + command);
    }
    return api.invoke(command, args || {});
  }

  /** 订阅后端事件，返回取消订阅函数。 */
  async function listen(event, handler) {
    if (!events || typeof events.listen !== "function") return () => {};
    return events.listen(event, (message) => handler(message.payload));
  }

  PShell.ipc = {
    available,
    call,
    listen,

    // ---------- 应用与配置 ----------
    appInfo: () => call("app_info"),
    // 首次启动引导（核心，不随模块开关）：标记文件为本机私有，不随 Git 同步
    onboardingStatus: () => call("onboarding_status"),
    onboardingComplete: () => call("onboarding_complete"),
    getConfig: () => call("get_config"),
    saveConfig: (config) => call("save_config", { config }),
    featureFlags: () => call("feature_flags"),
    moduleStatus: () => call("module_status"),
    resetConfig: () => call("reset_config"),

    // ---------- 连接配置 ----------
    listConnections: () => call("list_connections"),
    saveConnection: (input) => call("save_connection", { input }),
    deleteConnection: (id) => call("delete_connection", { id }),

    // ---------- 主密码保险库（核心，不随模块开关） ----------
    vaultStatus: () => call("vault_status"),
    vaultSetup: (password) => call("vault_setup", { password }),
    vaultUnlock: (password) => call("vault_unlock", { password }),
    vaultChangePassword: (current, newPassword) =>
      call("vault_change_password", { current, newPassword }),
    vaultLock: () => call("vault_lock"),
    vaultReset: () => call("vault_reset"),
    // 主密码冲突（Git 同步的保险库与本机不一致）
    vaultAdoptPending: (password) => call("vault_adopt_pending", { password }),
    vaultDiscardPending: () => call("vault_discard_pending"),

    // ---------- AI 模型 API Key（每个模型一把，存加密保险库） ----------
    aiConfiguredModels: () => call("ai_configured_models"),
    setAiModelKey: (modelId, key) => call("set_ai_model_key", { modelId, key }),
    clearAiModelKey: (modelId) => call("clear_ai_model_key", { modelId }),

    // ---------- AI 模型配置（测试连通性 / 单条保存与删除） ----------
    aiTestModel: (input) => call("ai_test_model", { input }),
    aiSaveModel: (model, apiKey) => call("ai_save_model", { input: { model, api_key: apiKey } }),
    aiDeleteModel: (modelId) => call("ai_delete_model", { modelId }),
    // 可选协议清单（值 / 展示名 / 路径后缀 / 说明），用于渲染协议下拉与后缀提示
    aiProtocols: () => call("ai_protocols"),

    // ---------- AI 助手（可开关） ----------
    aiAsk: (input) => call("ai_ask", { input }),
    aiCancel: (id) => call("ai_cancel", { id }),
    aiAgentStep: (input) => call("ai_agent_step", { input }),

    // ---------- 命令历史（可开关） ----------
    listHistory: (limit, query, dedupe, order) =>
      call("list_history", { limit, query, dedupe, order }),
    clearHistory: () => call("clear_history"),
    pushHistory: (command, host, sessionId) => call("push_history", { command, host, sessionId }),

    // ---------- SSH ----------
    sshConnect: (params) => call("ssh_connect", { params }),
    sshWrite: (id, data) => call("ssh_write", { id, data }),
    sshResize: (id, cols, rows) => call("ssh_resize", { id, cols, rows }),
    sshDisconnect: (id) => call("ssh_disconnect", { id }),
    sshSessions: () => call("ssh_sessions"),
    sshRecentOutput: (id, maxBytes) => call("ssh_recent_output", { id, maxBytes }),
    sshTestConnection: (params) => call("ssh_test_connection", { params }),

    // ---------- 输入源自动切换（可开关，仅 macOS 生效） ----------
    imeUseAscii: () => call("ime_use_ascii"),
    imeRestore: () => call("ime_restore"),
    imeSupported: () => call("ime_supported"),

    // ---------- 会话日志（可开关） ----------
    sessionLogStatus: () => call("session_log_status"),
    sessionLogList: () => call("session_log_list"),
    sessionLogRead: (name, maxBytes) => call("session_log_read", { name, maxBytes }),
    sessionLogClear: () => call("session_log_clear"),

    // ---------- SFTP（可开关） ----------
    // 上传/下载带 transferId：进度事件按它回传，中断也按它发起。
    sftpConnect: (params) => call("sftp_connect", { params }),
    sftpDisconnect: (id) => call("sftp_disconnect", { id }),
    sftpSessions: () => call("sftp_sessions"),
    sftpList: (id, path) => call("sftp_list", { id, path }),
    sftpDownload: (id, remote, local, transferId) =>
      call("sftp_download", { id, remote, local, transferId }),
    sftpUpload: (id, local, remote, transferId) =>
      call("sftp_upload", { id, local, remote, transferId }),
    sftpCancelTransfer: (transferId) => call("sftp_cancel_transfer", { transferId }),
    sftpDelete: (id, path) => call("sftp_delete", { id, path }),
    sftpRename: (id, from, to) => call("sftp_rename", { id, from, to }),
    sftpChmod: (id, path, mode) => call("sftp_chmod", { id, path, mode }),

    // ---------- 端口转发（可开关） ----------
    portForwardStart: (request) => call("port_forward_start", { request }),
    portForwardStop: (id) => call("port_forward_stop", { id }),
    portForwardList: () => call("port_forward_list"),

    // ---------- 连接导入导出（可开关） ----------
    connectionExport: (path, ids) => call("connection_export", { path, ids }),
    connectionImport: (path, format) => call("connection_import", { path, format }),
    importExportDefaults: () => call("import_export_defaults"),

    // ---------- 远程桌面（可开关） ----------
    rdpClientAvailable: () => call("rdp_client_available"),
    rdpSavedPassword: (connectionId) => call("rdp_saved_password", { connectionId }),
    rdpOpen: (input) => call("rdp_open", { input }),
    rdpProbe: (host, port, timeoutMs) => call("rdp_probe", { host, port, timeoutMs }),
    rdpOpenInstaller: () => call("rdp_open_installer"),

    // ---------- 命令片段（可开关） ----------
    snippetList: () => call("snippet_list"),
    snippetSave: (snippet) => call("snippet_save", { snippet }),
    snippetDelete: (id) => call("snippet_delete", { id }),
    snippetRender: (content, values) => call("snippet_render", { content, values }),

    // ---------- 崩溃日志（可开关） ----------
    crashLogRead: (tailBytes) => call("crash_log_read", { tailBytes }),
    crashLogExport: (path) => call("crash_log_export", { path }),

    // ---------- Git 同步（可开关） ----------
    gitStatus: () => call("git_sync_status"),
    gitInit: () => call("git_sync_init"),
    gitClone: (url) => call("git_sync_clone", { url }),
    gitSyncNow: () => call("git_sync_now"),
    gitPull: () => call("git_sync_pull"),
    gitPush: () => call("git_sync_push"),
    gitCommit: () => call("git_sync_commit"),
    gitDiff: () => call("git_sync_diff"),
    gitResolve: (strategy) => call("git_sync_resolve", { strategy }),
    gitCredentials: () => call("git_sync_credentials"),
    gitSetCredential: (name, password) => call("git_sync_set_credential", { name, password }),
    gitTest: (input) => call("git_sync_test", { input }),
  };
})(window.PShell);