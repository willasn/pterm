import { useSyncExternalStore } from "react";
import { errorText, toast } from "../../lib/legacy";
import { setEnabledFromConfig as setAiConfig } from "../ai/store";
import { applyConfig } from "../app/store";
import { refresh as refreshConnections } from "../connections/store";
import { refresh as refreshGitSync } from "../git-sync/store";
import { t } from "../i18n/store";
import { ipc } from "../ipc/api";
import { actions as shortcutActions, conflicts as shortcutConflictsFor } from "../shortcuts/api";
import { ask } from "../util/util";
import { CATEGORIES, FLAG_META, HIDDEN_FLAGS } from "./constants";
import type {
  AiModelConfig,
  AppInfo,
  CrashLogInfo,
  FlagEntry,
  ModuleStatus,
  ProtocolSpec,
  ShortcutBinding,
  ShortcutRow,
  VaultStatus,
} from "./types";

/**
 * 设置面板的状态与行为（由原 src/legacy/settings.ts 迁移而来）。
 *
 * 表单与 `draft`（配置的深拷贝）即时双向绑定，因此没有「收集表单」这一步；
 * 只有点击保存才把 draft 交给 save_config，由后端统一 replace 并同步模块生命周期。
 *
 * 迁移策略：沿用原有的「可变状态 + 显式重绘」模型——draft 与各类集合保存在模块级变量里，
 * 输入直接写入 draft 且不触发重绘（与原实现一致，避免打断数值输入）；
 * 需要重绘时调用 `rerender()` 递增版本号，React 侧据此重新读取这些变量。
 */

// ---------------------------------------------------------------------------
// 可变状态（非响应式，输入直接写入）
// ---------------------------------------------------------------------------

let draft: any = null;
let flags: FlagEntry[] = [];
let modules: ModuleStatus[] = [];
let info: AppInfo | null = null;
let activeCat = "general";
/** 已在加密保险库中保存 API Key 的模型 id 集合 */
let configuredModelIds = new Set<string>();
/** 后端返回的可选协议清单（值 / 展示名 / 路径后缀 / 说明），供协议下拉与后缀提示使用 */
let protocolList: ProtocolSpec[] = [];
/** AI 模型编辑列表：与 draft.ai.models 解耦，模型逐条测试 / 保存，不随整页保存提交 */
let aiModels: AiModelConfig[] = [];
/** 后端配置里已存在的模型 id；不在其中的是「尚未保存的新条目」 */
let savedModelIds = new Set<string>();
/** 本次设置会话中已通过连通性测试的模型 id；新增条目必须通过后才能保存 */
const testedModelIds = new Set<string>();
/** 本次提交的 Git 密码：键为 remote 名；缺失 = 不修改，"" = 删除，非空 = 写入 */
let gitPasswordInputs = new Map<string, string>();
/** 已在加密保险库中保存密码 / 令牌的 remote 名 */
let gitCredentialNames = new Set<string>();
/** 「关于」页里最近一次读取的崩溃日志；null = 尚未读取 */
let crashTail: CrashLogInfo | null = null;
let crashBusy = false;
/** 保险库状态；null = 尚未读取 */
let vaultState: VaultStatus | null = null;

// ---------------------------------------------------------------------------
// 响应式外壳（版本号驱动重绘）
// ---------------------------------------------------------------------------

let version = 0;
let opened = false;
/** 表单重建键：草稿被整体替换（打开 / 恢复默认 / 保存后重建）时递增，使非受控输入重新取值。 */
let formKey = 0;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): number {
  return version;
}

export function useSettingsVersion(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** 触发一次重绘。rebuild = true 时同时重建非受控表单（草稿被整体替换的场景）。 */
export function rerender(rebuild?: boolean): void {
  version++;
  if (rebuild) formKey++;
  emit();
}

// ---------------------------------------------------------------------------
// 读取接口（组件在渲染阶段调用）
// ---------------------------------------------------------------------------

export const getOpen = () => opened;
export const getActiveCat = () => activeCat;
export const getFormKey = () => formKey;
export const getDraft = () => draft;
export const getFlags = () => flags;
export const getModules = () => modules;
export const getInfo = () => info;
export const getProtocolList = () => protocolList;
export const getAiModels = () => aiModels;
export const getConfiguredModelIds = () => configuredModelIds;
export const getSavedModelIds = () => savedModelIds;
export const isTested = (id: string) => testedModelIds.has(id);
export const markTested = (id: string) => testedModelIds.add(id);
export const clearTested = (id: string) => testedModelIds.delete(id);
export const getGitCredentialNames = () => gitCredentialNames;
export const getCrashTail = () => crashTail;
export const getCrashBusy = () => crashBusy;
export const getVaultState = () => vaultState;

/** 路径读写：用于非受控输入直接写入 draft。 */
export function getPath(obj: any, path: string): any {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export function setPath(obj: any, path: string, value: any): void {
  const keys = path.split(".");
  const last = keys.pop() as string;
  const target = keys.reduce((acc, key) => {
    if (acc[key] == null || typeof acc[key] !== "object") acc[key] = {};
    return acc[key];
  }, obj);
  target[last] = value;
}

function deepClone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function emptyToNull(value: string | null | undefined): string | null {
  const text = (value || "").trim();
  return text === "" ? null : text;
}

export function setActiveCat(id: string): void {
  activeCat = id;
  rerender();
}

// ---------------------------------------------------------------------------
// 打开 / 保存 / 恢复默认
// ---------------------------------------------------------------------------

export async function open(category?: string): Promise<void> {
  const target = CATEGORIES.some((cat) => cat.id === category) ? category! : null;
  if (target) activeCat = target;
  if (opened) {
    // 已打开时只切分类，不重拉配置，避免丢掉用户未保存的修改
    if (target) rerender();
    else if (typeof category === "string") rerender();
    return;
  }
  try {
    // 这些命令相互独立：任何一个失败都不该让整个设置面板打不开（原先用 Promise.all，
    // 一个 AI 模块未就绪就会让 open() 直接跳到 catch，表现就是「点设置没反应」）。
    const [cfg, flagList, moduleList, appInfo, keySet, gitCreds, vState, protos] = await Promise.all([
      ipc.getConfig(),
      ipc.featureFlags(),
      ipc.moduleStatus(),
      ipc.appInfo(),
      ipc.aiConfiguredModels().catch(() => []),
      ipc.gitCredentials().catch(() => []),
      ipc.vaultStatus().catch(() => null),
      ipc.aiProtocols().catch(() => []),
    ]);
    draft = deepClone(cfg);
    flags = flagList || [];
    modules = moduleList || [];
    protocolList = protos || [];
    info = appInfo || null;
    vaultState = vState || null;
    configuredModelIds = new Set(keySet || []);
    aiModels = deepClone((cfg.ai && cfg.ai.models) || []);
    savedModelIds = new Set(aiModels.map((m) => m.id));
    testedModelIds.clear();
    gitCredentialNames = new Set(gitCreds || []);
    gitPasswordInputs = new Map();
    crashTail = null;
    crashBusy = false;
    opened = true;
    // 渲染失败由组件内部兜底（显示错误文案），弹窗本身照常打开
    rerender(true);
  } catch (err) {
    // 直接 console.error：toast 依赖宿主节点，出错时可能连提示都看不到
    console.error("[settings] 打开设置失败", err);
    toast(errorText(err), "error");
  }
}

export function close(): void {
  opened = false;
  rerender();
}

/** 保存前兜底：清掉空字符串伪装成的 Some("")、去掉残缺条目。 */
function normalize(): void {
  const sync = draft.features.sync;
  // 同步范围只有「全部」两档，数据域恒为 all；是否带敏感字段由 git_sync_secrets 表达
  sync.git_sync_scope = "all";
  sync.git_repo_path = emptyToNull(sync.git_repo_path);
  sync.git_remotes = (sync.git_remotes || [])
    .map((remote: any) => ({
      name: (remote.name || "").trim() || "origin",
      url: (remote.url || "").trim(),
      branch: emptyToNull(remote.branch),
      // 用户名非敏感，随配置保存；密码 / 令牌走加密保险库
      username: emptyToNull(remote.username),
    }))
    .filter((remote: any) => remote.url);

  // 组合键留空 = 未绑定，直接丢掉；已启用 / 已禁用的绑定都要留存（禁用靠 enabled 字段表达）
  draft.shortcuts = (draft.shortcuts || [])
    .map((item: any) => ({
      action: (item.action || "").trim(),
      keys: (item.keys || "").trim(),
      enabled: item.enabled !== false,
    }))
    .filter((item: any) => item.action && item.keys);
}

/** 把草稿立刻作用到界面（主题、终端、侧栏），无需重开应用。 */
function applyToApp(): void {
  applyConfig(draft);
  refreshConnections().catch(() => {});
}

/**
 * Git 同步启用时列出尚未填写的必填项（在 normalize 之后调用）。
 *
 * 「使用 Git 同步，所有选项必填」：只要开关打开，远程地址、目标分支、用户名与提交身份
 * 都不能为空，缺任一项即拒绝保存并提示，避免出现「半配置」状态。
 * 仓库路径允许留空——留空即使用应用数据目录下的默认 sync 目录。
 */
function missingGitFields(): string[] {
  const sync = draft.features.sync;
  if (!sync.git_sync) return [];
  const remote = (sync.git_remotes || [])[0] || {};
  const fields: [string, unknown][] = [
    ["远程地址", remote.url],
    ["目标分支", remote.branch],
    ["远端用户名", remote.username],
    ["提交用户名", sync.git_author_name],
    ["提交邮箱", sync.git_author_email],
  ];
  return fields
    .filter(([, value]) => !String(value == null ? "" : value).trim())
    .map(([label]) => label);
}

export async function save(): Promise<void> {
  if (!draft) return;
  normalize();
  const missing = missingGitFields();
  if (missing.length) {
    toast("Git 同步已启用，请先填写：" + missing.join("、"), "warn");
    return;
  }
  try {
    const moduleList = await ipc.saveConfig(draft);
    modules = moduleList || modules;

    // Git 凭据同 API Key：也必须在 save_config 之后（set 带模块门控），
    // 且只写加密保险库，绝不进配置文件。
    if (gitPasswordInputs.size) {
      if (draft.features.sync.git_sync) {
        for (const [name, value] of gitPasswordInputs) {
          await ipc.gitSetCredential(name, value);
          if (value === "") gitCredentialNames.delete(name);
          else gitCredentialNames.add(name);
        }
      } else {
        toast("Git 同步已关闭，本次未写入 Git 密码", "info");
      }
    }
    gitPasswordInputs = new Map();

    applyToApp();
    toast("设置已保存", "ok");
    // 尚未逐条保存的模型不会随整份配置提交，否则等于绕过「先测通再保存」的门槛
    const pending = aiModels.filter((m) => !savedModelIds.has(m.id));
    if (pending.length) {
      toast("有 " + pending.length + " 个模型尚未保存，请在该模型卡片上点击「保存」", "warn");
    }
    rerender(true);
  } catch (err) {
    toast(errorText(err), "error");
  }
}

export async function reset(): Promise<void> {
  const confirmed = await ask(
    "恢复默认设置？功能开关、终端外观、AI 与 Git 配置都会回到初始值。连接列表与加密保险库中的凭据不受影响。",
    { title: "恢复默认设置", okText: "恢复默认", kind: "danger" }
  );
  if (!confirmed) return;
  try {
    draft = deepClone(await ipc.resetConfig());
    flags = await ipc.featureFlags();
    modules = await ipc.moduleStatus();
    configuredModelIds = new Set((await ipc.aiConfiguredModels().catch(() => [])) || []);
    aiModels = deepClone((draft.ai && draft.ai.models) || []);
    savedModelIds = new Set(aiModels.map((m) => m.id));
    testedModelIds.clear();
    gitCredentialNames = new Set((await ipc.gitCredentials()) || []);
    gitPasswordInputs = new Map();
    applyToApp();
    rerender(true);
    if (configuredModelIds.size) {
      toast("已恢复默认设置；保险库中的模型 API Key 仍保留，删除对应模型即可一并清除", "info");
    } else {
      toast("已恢复默认设置", "ok");
    }
  } catch (err) {
    toast(errorText(err), "error");
  }
}

/** 供全局搜索使用：可检索的设置项索引（分类页 + 功能开关）。 */
export function searchIndex() {
  const items = CATEGORIES.map((cat) => ({
    category: cat.id,
    title: t("settings.cat." + cat.id, cat.label),
    subtitle: "设置分类",
    keywords: cat.label,
  }));
  Object.keys(FLAG_META).forEach((path) => {
    if (HIDDEN_FLAGS.has(path)) return;
    const meta = FLAG_META[path];
    items.push({
      category: "flags",
      title: t("flags." + path, meta.label),
      subtitle: "功能开关 · " + path,
      keywords: path + " " + (meta.hint || ""),
    });
  });
  return items;
}

// ---------------------------------------------------------------------------
// AI 模型：逐条测试 / 保存 / 删除
// ---------------------------------------------------------------------------

/** 生成模型条目的稳定标识。与后端一样用 uuid，保证 API Key 的保险库键名不冲突。 */
export function newModelId(): string {
  const crypto = window.crypto;
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "m-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

export function addModel(): void {
  aiModels.push({
    id: newModelId(),
    name: "",
    model: "",
    base_url: "",
    protocol: "openai",
    temperature: null,
    max_tokens: null,
    max_input_tokens: null,
    timeout_secs: null,
    context_bytes: null,
  });
  rerender();
}

/**
 * 用后端返回的模型列表对齐本地状态。
 *
 * 模型是「逐条保存」的，draft 里的模型列表必须始终等于后端已保存的列表，
 * 否则整体保存时会把界面上尚未测通的新条目一起写进配置、绕过测试门槛。
 * 本地尚未保存的新条目保留在界面上，等待用户单独保存。
 */
export function applyServerModels(models: AiModelConfig[]): void {
  draft.ai = draft.ai || {};
  draft.ai.models = models.map((m) => deepClone(m));
  savedModelIds = new Set(models.map((m) => m.id));
  const byId = new Map(models.map((m) => [m.id, m]));
  aiModels = aiModels.map((m) => (byId.has(m.id) ? deepClone(byId.get(m.id)) : m));
  models.forEach((m) => {
    if (!aiModels.some((local) => local.id === m.id)) aiModels.push(deepClone(m));
  });
}

/** 整理成后端的模型形状：只去首尾空白；生成参数保留 null（= 用默认值）。 */
export function normalizeModel(model: AiModelConfig): AiModelConfig {
  return {
    id: model.id,
    name: (model.name || "").trim(),
    model: (model.model || "").trim(),
    base_url: (model.base_url || "").trim(),
    protocol: model.protocol || "openai",
    temperature: model.temperature == null ? null : model.temperature,
    max_tokens: model.max_tokens == null ? null : model.max_tokens,
    max_input_tokens: model.max_input_tokens == null ? null : model.max_input_tokens,
    timeout_secs: model.timeout_secs == null ? null : model.timeout_secs,
    context_bytes: model.context_bytes == null ? null : model.context_bytes,
  };
}

/**
 * 逐条保存 / 删除后刷新主界面 AI 面板的模型下拉。
 *
 * 只把 AI 相关配置推给面板，不整份 draft 应用一遍——否则草稿里其它还没点保存的
 * 改动会被提前生效。模型列表既然已经落库，面板就应该立刻能选到。
 */
export function refreshAiPanel(): void {
  setAiConfig(draft);
}

/** 测试单个模型连通性（失败会抛出，由调用方提示）。 */
export async function testModel(payload: any): Promise<any> {
  return ipc.aiTestModel(payload);
}

/** 保存单个模型：成功后同步服务端列表并刷新 AI 面板。 */
export async function saveModel(model: AiModelConfig, apiKey: string | null): Promise<void> {
  const result = await ipc.aiSaveModel(normalizeModel(model), apiKey);
  applyServerModels((result && result.models) || []);
  if (apiKey != null) configuredModelIds.add(model.id);
  refreshAiPanel();
  rerender();
}

/** 删除单个模型：后端已存在的条目要同步删除；仅界面上新加的直接丢弃。 */
export async function deleteModel(id: string): Promise<void> {
  if (savedModelIds.has(id)) {
    const result = await ipc.aiDeleteModel(id);
    applyServerModels((result && result.models) || []);
  }
  configuredModelIds.delete(id);
  testedModelIds.delete(id);
  aiModels = aiModels.filter((m) => m.id !== id);
  refreshAiPanel();
  rerender();
}

/** 协议下拉的选项；后端清单不可用时至少保留 OpenAI 兼容一项，避免下拉为空。 */
export function protocolOptions(): { value: string; label: string }[] {
  const list = protocolList.length
    ? protocolList
    : [{ value: "openai", label: "OpenAI 兼容（Chat Completions）", suffix: "/chat/completions", note: "" }];
  return list.map((p) => ({ value: p.value, label: p.label }));
}

/** 按值取协议元信息（含后缀 suffix、说明 note）；找不到时返回 null。 */
export function protocolSpec(value: string): ProtocolSpec | null {
  const want = value || "openai";
  return protocolList.filter((p) => p.value === want)[0] || null;
}

// ---------------------------------------------------------------------------
// Git 凭据
// ---------------------------------------------------------------------------

export function setGitPassword(name: string, value: string): void {
  if (value === "") gitPasswordInputs.delete(name);
  else gitPasswordInputs.set(name, value);
}

export function markGitPasswordClear(name: string): void {
  gitPasswordInputs.set(name, "");
}

/** 测试远端连接与凭据（失败会抛出，由调用方提示）。 */
export async function testGitRemote(input: {
  name: string;
  url: string;
  username: string | null;
  password: string | null;
}): Promise<any> {
  return ipc.gitTest(input);
}

// ---------------------------------------------------------------------------
// 崩溃日志
// ---------------------------------------------------------------------------

export async function viewCrashLog(): Promise<void> {
  if (crashBusy) return;
  crashBusy = true;
  rerender();
  try {
    crashTail = await ipc.crashLogRead(16384);
  } catch (err) {
    toast(errorText(err), "error");
  } finally {
    crashBusy = false;
    rerender();
  }
}

/** 导出崩溃日志：成功返回 true（调用方无需额外提示，本函数已 toast）。 */
export async function exportCrashLog(): Promise<void> {
  if (crashBusy) return;
  const dialog = (window as any).__TAURI__?.dialog || null;
  if (!dialog || typeof dialog.save !== "function") {
    toast("当前环境不支持文件保存对话框", "error");
    return;
  }
  let target: string | null = null;
  try {
    target = await dialog.save({
      title: "导出崩溃日志",
      defaultPath: crashLogPath(crashFileName()),
    });
  } catch (err) {
    toast(errorText(err), "error");
    return;
  }
  if (!target) return;
  crashBusy = true;
  rerender();
  try {
    const result = await ipc.crashLogExport(target);
    toast(`已导出崩溃日志（${result.bytes} 字节）`, "ok");
  } catch (err) {
    toast(errorText(err), "error");
  } finally {
    crashBusy = false;
    rerender();
  }
}

/** 崩溃日志所在目录。与 Rust 侧的 paths.crash_log 同目录。 */
function crashLogDir(): string {
  return String((info && info.log_dir) || "").replace(/[\\/]+$/, "");
}

/** 以平台分隔符拼一个崩溃日志导出的默认文件名。 */
function crashLogPath(name: string): string {
  const dir = crashLogDir();
  if (!dir) return name;
  const sep = dir.indexOf("\\") >= 0 && dir.indexOf("/") < 0 ? "\\" : "/";
  return dir + sep + name;
}

function crashFileName(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `pterm-crash-${stamp}.log`;
}

// ---------------------------------------------------------------------------
// 主密码
// ---------------------------------------------------------------------------

export async function changeMasterPassword(current: string, next: string): Promise<void> {
  await ipc.vaultChangePassword(current, next);
  vaultState = { configured: true, unlocked: true };
  rerender();
}

/**
 * 改密后主动同步一次，把新的 secrets.json 密文推到远端。
 *
 * 同步范围不含配置（secrets.json）时密文不会被分发，此时只提示、不白跑一次网络同步。
 * Git 同步未启用或同步失败也一样只提示，不回滚、不阻断——改密本身已经成功。
 * 返回值是需要追加到状态行的文本（无则空串）。
 */
export async function syncAfterPasswordChange(): Promise<string> {
  const gitOn = modules.some((m) => m.id === "git_sync" && m.enabled);
  if (!gitOn) {
    return " Git 同步未启用，仓库中的旧密文需在启用后同步更新。";
  }

  // 用后端实际生效的同步范围判断（草稿可能还没保存），只有含连接配置才会带上 secrets.json
  let scope = "config";
  try {
    const status = await ipc.gitStatus();
    scope = (status && status.scope) || "config";
  } catch {
    /* 读不到状态就按默认范围继续，同步结果本身会给出反馈 */
  }
  if (scope === "snippets") {
    return " 当前同步范围为「仅命令片段」，不含 secrets.json，新密文未分发；如需分发请改为「仅连接配置」或「全部」后再同步。";
  }

  try {
    const outcome = await ipc.gitSyncNow();
    const message = (outcome && outcome.message) || "已同步";
    refreshGitSync().catch(() => {});
    return " 已同步：" + message;
  } catch (err) {
    toast("主密码已修改，但自动同步失败", "warn");
    return " 自动同步失败：" + errorText(err) + "；请到「Git 同步」面板手动同步。";
  }
}

// ---------------------------------------------------------------------------
// 快捷键编辑行
// ---------------------------------------------------------------------------

export function shortcutRows(): ShortcutRow[] {
  const actions = shortcutActions();
  const bindings: ShortcutBinding[] = (draft.shortcuts = draft.shortcuts || []);
  const used = new Set<ShortcutBinding>();
  const rows: ShortcutRow[] = actions.map((action) => {
    let binding = bindings.filter((item) => item && item.action === action.id)[0];
    if (!binding) {
      binding = { action: action.id, keys: "", enabled: true };
      bindings.push(binding);
    }
    used.add(binding);
    return { label: action.label, hint: action.hint || "", binding, removable: false };
  });
  // 配置里多出来的条目（同一动作的重复绑定、或当前版本没实现的动作 id）原样保留并允许删除，
  // 否则它们会一直留在配置文件里却完全不可见。
  bindings.forEach((item) => {
    if (!item || used.has(item)) return;
    const known = actions.filter((action) => action.id === item.action)[0];
    rows.push({
      label: known ? known.label + "（重复条目）" : "未实现的动作：" + (item.action || "（空）"),
      hint: known ? "同一动作绑定了多条，只有靠前的那条生效" : "当前版本没有实现该动作，按键不会触发",
      binding: item,
      removable: true,
    });
  });
  return rows;
}

export function removeShortcutBinding(binding: ShortcutBinding): void {
  const index = (draft.shortcuts || []).indexOf(binding);
  if (index >= 0) draft.shortcuts.splice(index, 1);
  rerender();
}

/** 冲突检测（每次编辑后由组件重算）。 */
export function shortcutConflicts(): any[] {
  return shortcutConflictsFor(draft.shortcuts);
}
