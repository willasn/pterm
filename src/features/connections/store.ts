import { useSyncExternalStore } from "react";
import { errorText, toast } from "../../lib/legacy";
import { ipc } from "../ipc/api";
import { copyPassword as copyRdpPassword, open as openRdp, probe as probeRdp } from "../rdp/api";
import * as ssh from "../ssh/api";
import { active } from "../terminal/api";
import { ask, getPath, promptPassword, setPath } from "../util/util";

/** 可被右键菜单打开的模块面板：只依赖其 open()。 */
interface OpenableModule {
  open(): void;
}

let sftp: OpenableModule;
let portForward: OpenableModule;
let sessionLog: OpenableModule;
let snippets: OpenableModule;
let history: OpenableModule;

export function wireDependencies(deps: {
  sftp: typeof sftp;
  portForward: typeof portForward;
  sessionLog: typeof sessionLog;
  snippets: typeof snippets;
  history: typeof history;
}): void {
  ({ sftp, portForward, sessionLog, snippets, history } = deps);
}

/**
 * 连接管理（由原 src/legacy/connections.ts 迁移而来）：侧栏列表、新建 / 编辑弹窗、快捷连接、会话发起。
 *
 * 前端只负责收集参数并交给 Tauri command；密码与 passphrase 提交后由后端
 * 写入主密码加密的保险库，前端既不保存也不回显，列表接口只返回 has_password 这类布尔标记。
 */

export const AUTH_KINDS = [
  { value: "auto", label: "自动（agent → 默认私钥 → 已存密码）" },
  { value: "password", label: "密码" },
  { value: "private_key", label: "私钥文件" },
  { value: "agent", label: "SSH Agent" },
];

/** 连接协议。RDP 仅在 features.connection.rdp 打开时可选。 */
export const PROTOCOLS = [
  { value: "ssh", label: "SSH 终端" },
  { value: "rdp", label: "远程桌面（RDP）" },
];

const DEFAULT_PORT: Record<string, number> = { ssh: 22, rdp: 3389 };

export interface ConnectionSecrets {
  password: string | null;
  passphrase: string | null;
  jump_password: string | null;
}

export interface ConnectionsState {
  list: any[];
  /** 快捷连接输入框所在容器的显隐。 */
  quickVisible: boolean;
  formOpen: boolean;
  formIsNew: boolean;
  /** 表单重建键：打开 / 结构性切换（协议、认证方式、跳板机开关）时递增。 */
  formKey: number;
  /** 敏感输入框重建键：打开 / 清除时递增，使非受控输入清空。 */
  secretKey: number;
  secrets: ConnectionSecrets;
  testing: boolean;
}

let config: any = null;
let connections: any[] = [];
/** 弹窗中的草稿（StoredConnection 形状），可变，表单直接写入 */
let draft: any = null;
let draftIsNew = true;
/** 「复制会话」时来源连接的 id：保存时让后端把源凭据复制到新条目 */
let draftCopySecretsFrom: string | null = null;

const initialState: ConnectionsState = {
  list: [],
  quickVisible: false,
  formOpen: false,
  formIsNew: true,
  formKey: 0,
  secretKey: 0,
  secrets: { password: null, passphrase: null, jump_password: null },
  testing: false,
};

let state: ConnectionsState = initialState;
const listeners = new Set<() => void>();

function setState(patch: Partial<ConnectionsState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): ConnectionsState {
  return state;
}

export function useConnections(): ConnectionsState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/** 当前表单草稿（组件渲染阶段读取）。 */
export function getDraft(): any {
  return draft;
}

const connFlags = (): any => (config && config.features && config.features.connection) || {};
const isRdp = (conn: any): boolean => !!conn && conn.protocol === "rdp";

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// 侧栏列表
// ---------------------------------------------------------------------------

export function setEnabledFromConfig(next: any): void {
  config = next;
  render();
  setState({ quickVisible: !!connFlags().quick_connect });
}

async function loadList(): Promise<any[]> {
  connections = (await ipc.listConnections()) || [];
  return connections;
}

export async function refresh(): Promise<any[]> {
  await loadList();
  render();
  return connections;
}

/** 把当前连接列表推给界面（分组逻辑在组件侧按开关处理）。 */
export function render(): void {
  setState({ list: connections.slice() });
}

/** 按 group_name 分组（仅在 connection_group 开关打开时由组件调用）。 */
export function groupedList(): { key: string; items: any[] }[] {
  const groups = new Map<string, any[]>();
  connections.forEach((c) => {
    const key = (c.group_name || "").trim() || "未分组";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  });
  return Array.from(groups.keys())
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .map((key) => ({ key, items: groups.get(key)! }));
}

export function groupEnabled(): boolean {
  return !!connFlags().connection_group;
}

/** 连接相关的功能开关（表单据此决定显示哪些字段）。 */
export function connectionFlags(): any {
  return connFlags();
}

/** 连接项的右键菜单条目（沿用 legacy menu.open 的形状）。 */
export function connMenu(conn: any): any[] {
  const flags = connFlags();
  const aux = (config && config.features && config.features.auxiliary) || {};
  const rdp = isRdp(conn);
  const port = conn.port || (rdp ? 3389 : 22);
  const address = `${conn.username}@${conn.host}:${port}`;

  const items: any[] = [
    { label: rdp ? "打开远程桌面" : "打开连接", icon: "▶", run: () => connectTo(conn) },
    { label: "编辑连接…", icon: "✎", run: () => openForm(conn) },
    { label: "复制会话", icon: "❐", run: () => duplicate(conn) },
    { label: "复制连接信息", icon: "⧉", run: () => copyText(address, "已复制连接信息") },
  ];

  if (rdp) {
    items.push({ label: "测试端口", icon: "⇄", run: () => probeRdp(conn) });
    if (conn.has_password) {
      items.push({ label: "复制密码", icon: "⎘", run: () => copyRdpPassword(conn) });
    }
    items.push({ sep: true }, { label: "删除连接…", icon: "✕", danger: true, run: () => removeById(conn) });
    return items;
  }

  const modules = [
    flags.sftp ? { label: "打开 SFTP", icon: "⇅", run: () => openModule(sftp) } : null,
    flags.port_forward ? { label: "端口转发", icon: "⇄", run: () => openModule(portForward) } : null,
    flags.session_log ? { label: "会话日志", icon: "▤", run: () => openModule(sessionLog) } : null,
    aux.snippets ? { label: "命令片段", icon: "⌘", run: () => openModule(snippets) } : null,
    aux.command_history ? { label: "命令历史", icon: "⟲", run: () => openModule(history) } : null,
  ].filter(Boolean);
  if (modules.length) items.push({ sep: true }, ...modules);

  items.push({ sep: true }, { label: "删除连接…", icon: "✕", danger: true, run: () => removeById(conn) });
  return items;
}

/** 模块可能未启用或未加载，open 不可用时静默跳过。 */
function openModule(mod: any): void {
  if (mod && typeof mod.open === "function") mod.open();
}

function copyText(text: string, okMessage: string): void {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(() => toast(okMessage, "ok"))
      .catch(() => toast("复制失败", "error"));
  } else {
    toast("当前环境不支持剪贴板", "error");
  }
}

// ---------------------------------------------------------------------------
// 发起连接
// ---------------------------------------------------------------------------

function authSpec(kind: string, keyPath: string | null): any {
  switch (kind) {
    case "password":
      return { kind: "password" };
    case "private_key":
      return { kind: "private_key", key_path: keyPath || "" };
    case "agent":
      return { kind: "agent" };
    default:
      return { kind: "auto" };
  }
}

function jumpSpec(record: any): any {
  return {
    connection_id: null,
    host: record.host || "",
    port: record.port || 22,
    username: record.username || "",
    auth: authSpec(record.auth_kind, record.key_path),
  };
}

/** StoredConnection -> ConnectParams。密码一律由后端按 connection_id 从保险库读取。 */
export function paramsFor(conn: any): any {
  const current = active();
  const terminal = (config && config.terminal) || {};
  return {
    connection_id: conn.id || null,
    name: conn.name || null,
    host: (conn.host || "").trim(),
    port: conn.port || 22,
    username: (conn.username || "").trim(),
    auth: authSpec(conn.auth_kind, conn.key_path),
    jump: connFlags().jump_host && conn.jump ? jumpSpec(conn.jump) : null,
    cols: current ? current.term.cols : 80,
    rows: current ? current.term.rows : 24,
    term_type: terminal.term_type || null,
    session_id: null,
  };
}

export async function connectTo(conn: any): Promise<void> {
  // RDP 不要求用户名（客户端可弹框输入），SSH 则必须有主机与用户名
  if (!conn.host || (!conn.username && !isRdp(conn))) {
    toast(isRdp(conn) ? "该连接缺少主机" : "该连接缺少主机或用户名", "error");
    openForm(conn);
    return;
  }
  if (isRdp(conn)) {
    await openRdp(conn);
    return;
  }
  try {
    await ssh.connect(paramsFor(conn));
  } catch (err) {
    toast(errorText(err), "error");
  }
}

/**
 * 临时连接（不落盘）：仅用于快捷连接。
 *
 * 先用自动认证（agent → 默认私钥）；认证不通过时弹框让用户手动输入密码，
 * 在同一标签内改用密码认证重试。取消或非认证类失败则保留终端里的错误提示。
 */
async function connectQuick(parsed: { username: string; host: string; port: number }): Promise<void> {
  const terminal = (config && config.terminal) || {};
  const current = active();
  const params = {
    connection_id: null,
    name: `${parsed.username}@${parsed.host}`,
    host: parsed.host,
    port: parsed.port,
    username: parsed.username,
    auth: { kind: "auto" },
    jump: null,
    cols: current ? current.term.cols : 80,
    rows: current ? current.term.rows : 24,
    term_type: terminal.term_type || null,
    session_id: null,
  };

  let ctrl: any;
  try {
    ctrl = await ssh.connect(params);
  } catch (err) {
    toast(errorText(err), "error");
    return;
  }

  while (ctrl) {
    const outcome = await ssh.awaitOutcome(ctrl.id);
    if (outcome.ok || !outcome.authFailed) return;
    const password = await promptPassword(
      `${parsed.username}@${parsed.host} 认证未通过，请输入登录密码。`,
      { title: "输入登录密码", okText: "连接" }
    );
    if (password == null) return;
    ctrl.params.auth = { kind: "password", password };
    ctrl = await ssh.reconnect(ctrl.id);
  }
}

/** 解析 `user@host[:port]`。用户名必填——后端不允许空用户名。 */
export function parseQuick(text: string): { username: string; host: string; port: number } | null {
  const raw = (text || "").trim();
  if (!raw) return null;
  let rest = raw;
  let username = "";
  const at = rest.indexOf("@");
  if (at > 0) {
    username = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  if (!username) return null;

  let host = rest;
  let port = 22;
  const colon = rest.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(rest.slice(colon + 1))) {
    host = rest.slice(0, colon);
    port = parseInt(rest.slice(colon + 1), 10);
  }
  if (!host) return null;
  return { username, host, port };
}

/** 快捷连接输入框回车：由 app 绑定在外壳输入框上调用。 */
export function onQuickSubmit(): void {
  const box = document.getElementById("quick-input") as HTMLInputElement | null;
  if (!box) return;
  const parsed = parseQuick(box.value);
  if (!parsed) {
    toast("快捷连接格式：user@host:port", "error");
    return;
  }
  box.value = "";
  void connectQuick(parsed);
}

// ---------------------------------------------------------------------------
// 编辑弹窗
// ---------------------------------------------------------------------------

function blankConnection(): any {
  return {
    id: "",
    name: "",
    host: "",
    port: 22,
    username: "",
    protocol: "ssh",
    domain: null,
    auth_kind: "auto",
    key_path: null,
    group_name: null,
    has_password: false,
    has_passphrase: false,
    jump: null,
    color: null,
    created_at: "",
    updated_at: "",
  };
}

function blankJump(): any {
  return { host: "", port: 22, username: "", auth_kind: "auto", key_path: null };
}

/**
 * 打开连接表单。传入 `null`（或 `options.asNew`）表示新建。
 *
 * `options.copySecretsFrom`：新建时把该连接在保险库中的凭据一并复制到新条目
 * （「复制会话」用；前端拿不到明文，只能让后端按 id 复制）。
 *
 * 多标签的 ＋ 也走这里：侧栏本身就是连接选择器，因此不再叠一层「选择器」弹窗。
 */
export function openForm(conn: any, options?: { asNew?: boolean; copySecretsFrom?: string }): void {
  const opts = options || {};
  draftIsNew = !conn || !!opts.asNew;
  draft = conn ? deepClone(conn) : blankConnection();
  if (!draft.jump) draft.jump = null;
  if (draft.protocol !== "rdp") draft.protocol = "ssh";
  draftCopySecretsFrom = draftIsNew ? opts.copySecretsFrom || null : null;
  setState({
    formOpen: true,
    formIsNew: draftIsNew,
    formKey: state.formKey + 1,
    secretKey: state.secretKey + 1,
    secrets: { password: null, passphrase: null, jump_password: null },
    testing: false,
  });
}

/**
 * 复制会话：基于已有连接打开一份预填的新建弹窗，名称自动加后缀，
 * 保存时由后端把源连接的凭据一并复制到新条目。SSH / RDP 通用。
 */
export function duplicate(conn: any): void {
  if (!conn) return;
  const copy = deepClone(conn);
  copy.id = "";
  copy.created_at = "";
  copy.updated_at = "";
  copy.name = uniqueCopyName(conn.name || conn.host);
  openForm(copy, { asNew: true, copySecretsFrom: conn.id });
}

/** 「复制会话」的名称：原名加「副本」后缀，与已有重名时追加序号。 */
function uniqueCopyName(base: string): string {
  const name = (base || "").trim() || "新连接";
  const taken = new Set(connections.map((c) => (c.name || "").trim()));
  let candidate = `${name} 副本`;
  for (let i = 2; taken.has(candidate); i += 1) {
    candidate = `${name} 副本 ${i}`;
  }
  return candidate;
}

export function closeForm(): void {
  draft = null;
  setState({ formOpen: false, testing: false });
}

/** 结构性变更（协议 / 认证方式 / 跳板机开关）后重建表单，使非受控输入重新取值。 */
export function rerenderForm(): void {
  setState({ formKey: state.formKey + 1 });
}

export function setDraftValue(path: string, value: any): void {
  if (!draft) return;
  setPath(draft, path, value);
}

export function getDraftValue(path: string): any {
  return draft ? getPath(draft, path) : undefined;
}

/** 切换协议：端口换为该协议默认值，并重建表单以显示 / 隐藏专属字段。 */
export function setProtocol(value: string): void {
  if (!draft) return;
  draft.protocol = value;
  draft.port = DEFAULT_PORT[value] || 22;
  rerenderForm();
}

/** 启用 / 停用跳板机：新建空记录或整体清空，并重建表单。 */
export function setJumpEnabled(on: boolean): void {
  if (!draft) return;
  draft.jump = on ? blankJump() : null;
  rerenderForm();
}

/** 修改待提交的敏感字段：空串 = 不修改（保持保险库中的原值），非空 = 写入。 */
export function setSecret(key: keyof ConnectionSecrets, value: string): void {
  setState({ secrets: { ...state.secrets, [key]: value === "" ? null : value } });
}

/** 清除已保存的敏感字段：提交空串表示删除，并清空输入框。 */
export function clearSecret(key: "password" | "passphrase"): void {
  if (!draft) return;
  setState({
    secrets: { ...state.secrets, [key]: "" },
    secretKey: state.secretKey + 1,
    formKey: state.formKey + 1,
  });
  if (key === "password") draft.has_password = false;
  if (key === "passphrase") draft.has_passphrase = false;
}

/** 端口等字段被清空时会解析成回退值，保存前再兜一次底。 */
function normalizeDraft(): void {
  draft.protocol = draft.protocol === "rdp" ? "rdp" : "ssh";
  const rdp = draft.protocol === "rdp";
  const toInt = (fallback: number) => (raw: string) => {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  draft.port = toInt(rdp ? 3389 : 22)(String(draft.port));
  draft.name = (draft.name || "").trim();
  draft.host = (draft.host || "").trim();
  draft.username = (draft.username || "").trim();
  const domain = (draft.domain || "").trim();
  draft.domain = domain === "" ? null : domain;
  const group = (draft.group_name || "").trim();
  draft.group_name = group === "" ? null : group;
  if (draft.key_path === "") draft.key_path = null;
  if (!rdp && draft.jump) {
    draft.jump.port = toInt(22)(String(draft.jump.port));
    draft.jump.host = (draft.jump.host || "").trim();
    draft.jump.username = (draft.jump.username || "").trim();
    if (!draft.jump.host) draft.jump = null;
  }
}

export async function save(): Promise<void> {
  if (!draft) return;
  normalizeDraft();
  const rdp = draft.protocol === "rdp";
  if (!draft.host || (!rdp && !draft.username)) {
    toast(rdp ? "请填写主机" : "请填写主机与用户名", "error");
    return;
  }
  try {
    const saved = await ipc.saveConnection({
      connection: draft,
      password: state.secrets.password,
      passphrase: state.secrets.passphrase,
      jump_password: state.secrets.jump_password,
      copy_secrets_from: draftCopySecretsFrom,
    });
    closeForm();
    await refresh();
    toast(`已保存连接「${saved.name}」`, "ok");
  } catch (err) {
    toast(errorText(err), "error");
  }
}

export async function test(): Promise<void> {
  if (!draft) return;
  normalizeDraft();
  const rdp = draft.protocol === "rdp";
  if (!draft.host || (!rdp && !draft.username)) {
    toast(rdp ? "请填写主机" : "请填写主机与用户名", "error");
    return;
  }

  // 远程桌面没有 SSH 握手，「测试」退化为探测 RDP 端口
  if (rdp) {
    setState({ testing: true });
    try {
      await probeRdp(draft);
    } finally {
      setState({ testing: false });
    }
    return;
  }

  const params = paramsFor(draft);
  // 新建连接尚未存过密码时，允许用当前输入临时测试（不落盘）
  if (draft.auth_kind === "password" && state.secrets.password) {
    params.auth = { kind: "password", password: state.secrets.password };
  }
  setState({ testing: true });
  try {
    const method = await ssh.test(params);
    toast(`连接成功，认证方式：${method}`, "ok");
  } catch (err) {
    toast(errorText(err), "error");
  } finally {
    setState({ testing: false });
  }
}

/** 删除一条连接（编辑弹窗按钮与右键菜单共用）。 */
export async function removeById(conn: any): Promise<void> {
  if (!conn || !conn.id) return;
  const name = conn.name || conn.host;
  const ok = await ask(
    `删除连接「${name}」？其保存在加密保险库中的密码也会一并删除，操作不可撤销。`,
    { title: "删除确认", okText: "删除", kind: "danger" }
  );
  if (!ok) return;
  try {
    await ipc.deleteConnection(conn.id);
    // 正开在编辑弹窗里的就是这条连接时，一并关掉
    if (draft && !draftIsNew && draft.id === conn.id) closeForm();
    await refresh();
    toast("已删除该连接", "ok");
  } catch (err) {
    toast(errorText(err), "error");
  }
}

export async function remove(): Promise<void> {
  if (!draft || draftIsNew) return;
  return removeById(draft);
}

/** 多标签的 ＋ / 快捷入口：直接打开新建表单（侧栏本身就是选择器）。 */
export function openPicker(): void {
  openForm(null);
}

/** 当前是否编辑已有连接（决定删除按钮是否可用）。 */
export function currentIsNew(): boolean {
  return draftIsNew;
}
