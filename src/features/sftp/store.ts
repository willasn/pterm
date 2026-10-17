import { useSyncExternalStore } from "react";
import { errorText, featureFlags, toast } from "../../lib/legacy";
import { paramsFor } from "../connections/store";
import { ipc } from "../ipc/api";
import { ask } from "../util/util";
import type {
  EditorState,
  SftpEntry,
  SftpListing,
  SftpProgressPayload,
  SftpSession,
  TransferItem,
  TransferSpec,
} from "./types";

/**
 * SFTP 文件面板的状态与行为（由原 src/legacy/sftp.ts 迁移而来）。
 *
 * 只在 features.connection.sftp 打开时可用：关闭时侧栏入口隐藏、面板不加载，
 * 后端 command 也会以 ModuleDisabled 拒绝。
 * SFTP 为每个连接持有一条独立的 SSH 连接（后端决定），因此面板必须先选一个
 * 已保存的连接建立会话，再浏览远端目录；全程经 Tauri command，本地文件读写
 * 由 Rust 侧完成，前端只负责取路径。
 *
 * 传输（上传/下载）在后端按块上报进度，前端据此渲染右下角进度条，并可中断。
 * 后端会话是独占的（同一时刻只有一条 SFTP 通道），所以前端串行执行：只有队首在跑，
 * 其余显示「等待中」，避免多条进度条同时 0% 造成困惑。
 */

/** 传输进度事件名，与后端 commands.rs 的 EVENT_SFTP_PROGRESS 保持一致。 */
const TRANSFER_EVENT = "sftp:progress";
/** 建立连接过场的最短展示时长：太快会让动画像闪一下，反而更突兀。 */
const MIN_CONNECT_MS = 650;

export interface SftpState {
  enabled: boolean;
  busy: boolean;
  connections: any[];
  sessions: SftpSession[];
  pendingConn: string | null;
  currentId: string | null;
  listing: SftpListing | null;
  editing: EditorState | null;
  lastError: string | null;
  transfers: TransferItem[];
  /** 建立连接的过场是否可见。 */
  connecting: boolean;
  connectingText: string;
  /** 拖拽上传提示是否可见。 */
  dropVisible: boolean;
  open: boolean;
}

const initialState: SftpState = {
  enabled: false,
  busy: false,
  connections: [],
  sessions: [],
  pendingConn: null,
  currentId: null,
  listing: null,
  editing: null,
  lastError: null,
  transfers: [],
  connecting: false,
  connectingText: "正在连接…",
  dropVisible: false,
  open: false,
};

let state: SftpState = initialState;
const listeners = new Set<() => void>();

function setState(patch: Partial<SftpState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

/** 只更新队列里的某一项。 */
function updateTransfer(id: string, patch: Partial<TransferItem>): void {
  setState({
    transfers: state.transfers.map((t) => (t.id === id ? { ...t, ...patch } : t)),
  });
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): SftpState {
  return state;
}

export function useSftp(): SftpState {
  return useSyncExternalStore(subscribe, getState, getState);
}

// ---------------------------------------------------------------------------
// 路径与显示工具
// ---------------------------------------------------------------------------

export function humanSize(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

/** 秒 → "m:ss" / "h:mm:ss"，用于已用时间与剩余时间。 */
export function fmtDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v: number) => String(v).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function baseName(path: string): string {
  const raw = String(path || "").replace(/[\\/]+$/, "");
  const parts = raw.split(/[\\/]/);
  return parts[parts.length - 1] || raw;
}

export function parentOf(path: string): string {
  const raw = String(path || "").replace(/\/+$/, "");
  if (!raw || raw === "/") return "/";
  const index = raw.lastIndexOf("/");
  if (index <= 0) return "/";
  return raw.slice(0, index);
}

function joinPath(dir: string, name: string): string {
  const target = String(name || "");
  if (target.charAt(0) === "/") return target;
  const base = String(dir || "/").replace(/\/+$/, "") || "/";
  return base === "/" ? "/" + target : base + "/" + target;
}

/** 本地路径拼接：只用于把目录选择结果与条目名拼起来，Rust 侧两种分隔符都能读。 */
function joinLocal(dir: string, name: string): string {
  const base = String(dir || "").replace(/[\\/]+$/, "");
  return base ? base + "/" + name : String(name || "");
}

export function modeText(mode: number): string {
  return (Number(mode) & 0o7777).toString(8).padStart(3, "0");
}

function parseMode(text: string): number | null {
  const raw = String(text || "").trim();
  if (!/^[0-7]{3,4}$/.test(raw)) return null;
  return parseInt(raw, 8);
}

/** Unix 秒 → "YYYY-MM-DD HH:MM"。 */
export function timeText(seconds: number): string {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const date = new Date(n * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (v: number) => String(v).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dialogApi(): any {
  return (window as any).__TAURI__?.dialog || null;
}

function currentSession(): SftpSession | null {
  return state.sessions.filter((s) => s.id === state.currentId)[0] || null;
}

function homeOf(id: string | null): string {
  const found = state.sessions.filter((s) => s.id === id)[0];
  return found ? found.home : "";
}

/** 当前会话的家目录（用于工具栏「家目录」按钮）。 */
export function currentHome(): string {
  return homeOf(state.currentId);
}

/** 侧栏徽标文案。 */
export function badgeText(): string {
  if (!state.enabled) return "SFTP";
  if (!state.sessions.length) return "SFTP 未连接";
  const current = currentSession();
  return "SFTP " + state.sessions.length + (current ? " · " + (current.name || current.host) : "");
}

/** 进度条填充比例（0~1）。 */
export function transferRatio(item: TransferItem): number {
  if (item.status === "done") return 1;
  return item.total > 0 ? Math.min(1, item.transferred / item.total) : 0;
}

/** 传输状态文案（速度 / 已用 / 剩余）。 */
export function transferStat(item: TransferItem): string {
  if (item.status === "queued") return "等待中…";
  if (item.status === "cancelling") return "正在中断…";
  if (item.status === "cancelled") return "已中断";
  if (item.status === "error") return item.error || "传输失败";
  // 目录传输会先递归扫描算出总量，这期间既没有总量也没有字节数
  if (item.status === "running" && !item.total && !item.transferred) return "正在读取…";

  const elapsed = ((item.endedAt || Date.now()) - (item.startedAt || Date.now())) / 1000;
  const speed = elapsed > 0 ? item.transferred / elapsed : 0;
  const parts: string[] = [];
  if (item.status === "done") parts.push("共 " + humanSize(item.bytes || item.transferred));
  else if (speed > 0) parts.push(humanSize(speed) + "/s");
  parts.push("已用 " + fmtDuration(elapsed));
  if (item.status === "running" && speed > 0 && item.total > item.transferred) {
    parts.push("剩余 " + fmtDuration((item.total - item.transferred) / speed));
  }
  return parts.join(" · ");
}

/** 进度条上的 ✕ 是否表示「可中断」（在途）。 */
export function transferActive(item: TransferItem): boolean {
  return item.status === "queued" || item.status === "running" || item.status === "cancelling";
}

// ---------------------------------------------------------------------------
// 传输事件绑定（首次打开面板时绑定一次）
// ---------------------------------------------------------------------------

let transferEventsBound = false;

function onTransferProgress(payload: SftpProgressPayload): void {
  if (!payload || !payload.id) return;
  const item = state.transfers.filter((t) => t.id === payload.id)[0];
  if (!item) return;
  const patch: Partial<TransferItem> = { transferred: Number(payload.transferred) || 0 };
  if (payload.total) patch.total = Number(payload.total);
  updateTransfer(payload.id, patch);
}

function bindTransferEvents(): void {
  if (transferEventsBound) return;
  transferEventsBound = true;
  ipc.listen(TRANSFER_EVENT, onTransferProgress)
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// 拖拽上传（本地 → 远端当前目录）
// ---------------------------------------------------------------------------

let dragBound = false;

/** Tauri 的 webview 拖拽接口：全局 API 下同时存在 webview / webviewWindow 两个命名空间。 */
function dragApi(): any {
  const ns = (window as any).__TAURI__;
  if (!ns) return null;
  const mod = ns.webviewWindow || ns.webview;
  if (!mod || typeof mod.getCurrentWebview !== "function") return null;
  try {
    const webview = mod.getCurrentWebview();
    return webview && typeof webview.onDragDropEvent === "function" ? webview : null;
  } catch {
    return null;
  }
}

/** 拖拽与进度事件只在首次打开时才需要，故延后到 openPanel 绑定（此时 PTerm 已就绪）。 */
function bindDragDrop(): void {
  if (dragBound) return;
  const webview = dragApi();
  if (!webview) return;
  dragBound = true;
  webview
    .onDragDropEvent((event: any) => {
      const payload = (event && event.payload) || {};
      if (!state.open) {
        if (state.dropVisible) setState({ dropVisible: false });
        return;
      }
      if (payload.type === "enter" || payload.type === "over") {
        if (state.currentId) setState({ dropVisible: true });
      } else if (payload.type === "leave") {
        setState({ dropVisible: false });
      } else if (payload.type === "drop") {
        setState({ dropVisible: false });
        handleDrop(payload.paths || []);
      }
    })
    .catch(() => {});
}

function handleDrop(paths: string[]): void {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  if (!state.currentId || !state.listing) {
    toast("请先打开一个远端目录再拖入文件", "error");
    return;
  }
  const sessionId = state.currentId;
  const dir = state.listing.path;
  list.forEach((path) => enqueue(uploadSpec(sessionId, path, dir)));
  toast(`开始上传 ${list.length} 个条目`, "ok");
}

// ---------------------------------------------------------------------------
// 传输队列
// ---------------------------------------------------------------------------

let transferSeq = 0;
let pumping = false;

function enqueue(spec: TransferSpec): void {
  if (!spec || typeof spec.run !== "function") return;
  const item: TransferItem = {
    id: "tr-" + ++transferSeq + "-" + Date.now(),
    label: spec.label || "传输",
    direction: spec.direction || "download",
    refresh: !!spec.refresh,
    sessionId: spec.sessionId || state.currentId,
    status: "queued",
    transferred: 0,
    total: 0,
    bytes: 0,
    cancelled: false,
    error: null,
    startedAt: 0,
    endedAt: 0,
    run: spec.run,
  };
  setState({ transfers: [...state.transfers, item] });
  void pump();
}

function dismissTransfer(id: string): void {
  setState({ transfers: state.transfers.filter((t) => t.id !== id) });
}

async function pump(): Promise<void> {
  if (pumping) return;
  const next = state.transfers.filter((t) => t.status === "queued")[0];
  if (!next) return;
  pumping = true;
  const id = next.id;
  const current = () => state.transfers.filter((t) => t.id === id)[0];

  updateTransfer(id, { status: "running", startedAt: Date.now() });
  try {
    const bytes = await next.run(id);
    if (current()?.cancelled) {
      updateTransfer(id, { status: "cancelled" });
    } else {
      const total = current()?.total || 0;
      const transferred = Number(bytes) || current()?.transferred || 0;
      updateTransfer(id, {
        status: "done",
        bytes: transferred,
        transferred: total ? total : transferred,
      });
    }
  } catch (err) {
    if (current()?.cancelled) {
      updateTransfer(id, { status: "cancelled" });
    } else {
      const message = errorText(err);
      updateTransfer(id, { status: "error", error: message });
      toast(message, "error");
    }
  } finally {
    pumping = false;
    updateTransfer(id, { endedAt: Date.now() });
    const settled = current();
    if (!settled) {
      void pump();
      return;
    }
    if (settled.status === "cancelled") {
      // 中断后不保留进度条，直接移除
      toast(`${settled.label} 已中断`, "info");
      dismissTransfer(id);
    } else if (settled.status === "done") {
      toast(`${settled.label} 完成，共 ${humanSize(settled.bytes)}`, "ok");
      setTimeout(() => dismissTransfer(id), 2600);
      // 上传会改变远端目录内容，下载不会
      if (settled.refresh && settled.sessionId === state.currentId) {
        await loadListing(state.listing ? state.listing.path : "");
      }
    }
    void pump();
  }
}

async function cancelTransfer(id: string): Promise<void> {
  const item = state.transfers.filter((t) => t.id === id)[0];
  if (!item) return;
  // 还没轮到它跑：直接出队，不必打扰后端
  if (item.status === "queued") {
    dismissTransfer(id);
    return;
  }
  if (item.status !== "running") return;
  updateTransfer(id, { cancelled: true, status: "cancelling" });
  try {
    await ipc.sftpCancelTransfer(id);
  } catch {
    /* 已结束的传输会在 finally 里落到 cancelled */
  }
}

/** 进度条上的 ✕：在途时是中断，已结束时是移除该条。 */
export function transferAction(id: string): void {
  const item = state.transfers.filter((t) => t.id === id)[0];
  if (!item) return;
  if (transferActive(item)) {
    void cancelTransfer(id);
    return;
  }
  dismissTransfer(id);
}

function uploadSpec(sessionId: string, localPath: string, dir: string): TransferSpec {
  const name = baseName(localPath);
  return {
    label: `上传 ${name}`,
    direction: "upload",
    sessionId,
    refresh: true,
    run: (tid) => ipc.sftpUpload(sessionId, localPath, joinPath(dir, name), tid),
  };
}

// ---------------------------------------------------------------------------
// 行为
// ---------------------------------------------------------------------------

async function loadConnections(): Promise<void> {
  let connections: any[] = [];
  try {
    // SFTP 走 SSH 连接，RDP 连接不在此列出
    connections = ((await ipc.listConnections()) || []).filter(
      (c: any) => (c.protocol || "ssh") !== "rdp"
    );
  } catch {
    connections = [];
  }
  setState({ connections, pendingConn: pickerSelection(connections, state.pendingConn) });
}

/** 保证待连接选中的连接有效：为空或已失效时落到第一个连接。 */
function pickerSelection(connections: any[], pending: string | null): string | null {
  if (pending && connections.some((c) => c.id === pending)) return pending;
  return connections.length ? connections[0].id : null;
}

export async function loadListing(path: string): Promise<void> {
  if (!state.enabled || !state.currentId) return;
  let listing: SftpListing | null = null;
  let lastError: string | null = null;
  try {
    listing = (await ipc.sftpList(state.currentId, path || "")) as SftpListing;
  } catch (err) {
    lastError = errorText(err);
  }
  setState({ listing, lastError, editing: null });
}

export async function refresh(): Promise<void> {
  if (!state.enabled) {
    setState({
      sessions: [],
      currentId: null,
      listing: null,
      editing: null,
      lastError: null,
    });
    return;
  }
  let sessions: SftpSession[] = [];
  let lastError: string | null = null;
  try {
    sessions = ((await ipc.sftpSessions()) || []) as SftpSession[];
  } catch (err) {
    sessions = [];
    lastError = errorText(err);
  }
  const patch: Partial<SftpState> = { sessions, lastError };
  if (state.currentId && !sessions.some((s) => s.id === state.currentId)) {
    patch.currentId = null;
    patch.listing = null;
    patch.editing = null;
  }
  if (!state.currentId && sessions.length) {
    patch.currentId = sessions[0].id;
    patch.listing = null;
    patch.editing = null;
  }
  setState(patch);

  if (state.currentId && !state.listing) {
    await loadListing(homeOf(state.currentId));
  }
}

export async function navigate(path: string): Promise<void> {
  if (!path || !state.currentId) return;
  await loadListing(path);
}

export async function selectSession(id: string): Promise<void> {
  setState({ currentId: id, listing: null, editing: null, lastError: null });
  await loadListing(homeOf(id));
}

export function setPendingConn(id: string): void {
  setState({ pendingConn: id });
}

/** 统一包装一次远端操作：置忙、提示结果（数字表示字节数）、随后刷新并回到原目录。 */
async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
  if (state.busy) return;
  setState({ busy: true });
  const here = state.listing ? state.listing.path : null;
  try {
    const outcome = await fn();
    const detail = typeof outcome === "number" && outcome > 0 ? `，共 ${humanSize(outcome)}` : "";
    toast(label + "完成" + detail, "ok");
    setState({ editing: null });
  } catch (err) {
    toast(errorText(err), "error");
  } finally {
    setState({ busy: false });
    const keep = state.currentId;
    await refresh();
    if (keep && here && state.currentId === keep) await loadListing(here);
  }
}

/** 用一份连接参数建立 SFTP 会话（选择框手动连接与右键直连共用）。 */
async function connectWith(params: any, pendingConn: string | null): Promise<void> {
  if (state.busy) return;
  // 过场期间就让窗口到位，避免连接成功后突然撑高
  setState({
    busy: true,
    pendingConn,
    connecting: true,
    connectingText: `正在建立 SFTP 连接 · ${params.name || params.host}`,
  });
  const started = Date.now();
  try {
    const info = (await ipc.sftpConnect(params)) as SftpSession;
    setState({ currentId: info.id, listing: null, editing: null });
    toast(`已建立 SFTP 连接 ${info.username}@${info.host}`, "ok");
  } catch (err) {
    toast(errorText(err), "error");
  } finally {
    // 过场至少停留一小段时间，避免动画一闪而过
    await wait(Math.max(0, MIN_CONNECT_MS - (Date.now() - started)));
    setState({ connecting: false, busy: false });
    await refresh();
  }
}

export async function connect(id: string): Promise<void> {
  const conn = state.connections.filter((c) => c.id === id)[0];
  if (!conn) return;
  await connectWith(paramsFor(conn), conn.id);
}

/** 会话与目标参数是否指向同一端点（主机 / 端口 / 用户名一致）。 */
function sameEndpoint(session: SftpSession, params: any): boolean {
  return (
    session.host === params.host &&
    String(session.port) === String(params.port) &&
    session.username === params.username
  );
}

/**
 * 由连接 / 标签右键菜单直接打开 SFTP：跳过面板里的连接选择框，直接连到目标连接。
 * 已有指向同一端点的会话时直接切过去，避免重复建立。
 */
export async function openFor(params: any): Promise<void> {
  if (!state.enabled) {
    toast("SFTP 已关闭，请在「设置 → 功能开关」中启用", "info");
    return;
  }
  setState({ open: true });
  bindTransferEvents();
  bindDragDrop();
  await loadConnections();
  const existing = state.sessions.filter((s) => sameEndpoint(s, params))[0];
  if (existing) {
    await selectSession(existing.id);
    return;
  }
  await connectWith(params, params.connection_id || null);
}

export async function disconnect(): Promise<void> {
  if (!state.currentId || state.busy) return;
  const current = currentSession();
  const target = current ? `${current.username}@${current.host}` : "";
  const confirmed = await ask(`关闭 SFTP 连接${target ? "：" + target : ""}？`);
  if (!confirmed) return;
  const id = state.currentId;
  setState({ busy: true });
  try {
    await ipc.sftpDisconnect(id);
    toast("已关闭 SFTP 连接", "ok");
  } catch (err) {
    toast(errorText(err), "error");
  } finally {
    setState({ busy: false, currentId: null, listing: null, editing: null });
    await refresh();
  }
}

export function startEdit(kind: "rename" | "chmod", entry: SftpEntry): void {
  setState({
    editing: {
      kind,
      entry,
      value: kind === "rename" ? entry.name : modeText(entry.mode),
    },
  });
}

export function setEditorValue(value: string): void {
  if (!state.editing) return;
  setState({ editing: { ...state.editing, value } });
}

export function cancelEdit(): void {
  setState({ editing: null });
}

export async function submitEditor(): Promise<void> {
  const editing = state.editing;
  if (!editing) return;
  const { kind, entry } = editing;
  const raw = String(editing.value == null ? "" : editing.value).trim();
  if (kind === "rename") {
    if (!raw) {
      toast("新名称不能为空", "error");
      return;
    }
    const target = raw.charAt(0) === "/" ? raw : joinPath(parentOf(entry.path), raw);
    if (target === entry.path) {
      setState({ editing: null });
      return;
    }
    await run(`重命名 ${entry.name}`, () => ipc.sftpRename(state.currentId, entry.path, target));
    return;
  }
  const mode = parseMode(raw);
  if (mode == null) {
    toast("权限需为 3~4 位八进制数字，例如 644 或 755", "error");
    return;
  }
  await run(`修改 ${entry.name} 权限`, () => ipc.sftpChmod(state.currentId, entry.path, mode));
}

/** 下载条目。目录选落地的父目录（后端按远端目录名递归展开），文件选保存路径。 */
export async function download(entry: SftpEntry): Promise<void> {
  const dialog = dialogApi();
  const sessionId = state.currentId;
  if (!sessionId) return;

  if (entry.is_dir) {
    if (!dialog || typeof dialog.open !== "function") {
      toast("当前环境不支持目录选择对话框", "error");
      return;
    }
    let picked: string | string[] | null = null;
    try {
      picked = await dialog.open({ title: "选择下载位置", directory: true, multiple: false });
    } catch (err) {
      toast(errorText(err), "error");
      return;
    }
    const parent = Array.isArray(picked) ? picked[0] : picked;
    if (!parent) return;
    const local = joinLocal(parent, entry.name);
    enqueue({
      label: `下载 ${entry.name}/`,
      direction: "download",
      sessionId,
      run: (tid) => ipc.sftpDownload(sessionId, entry.path, local, tid),
    });
    return;
  }

  if (!dialog || typeof dialog.save !== "function") {
    toast("当前环境不支持文件保存对话框", "error");
    return;
  }
  let local: string | null = null;
  try {
    local = await dialog.save({ title: "下载到", defaultPath: entry.name });
  } catch (err) {
    toast(errorText(err), "error");
    return;
  }
  if (!local) return;
  enqueue({
    label: `下载 ${entry.name}`,
    direction: "download",
    sessionId,
    run: (tid) => ipc.sftpDownload(sessionId, entry.path, local, tid),
  });
}

async function pickAndUpload(options: any): Promise<void> {
  const dialog = dialogApi();
  const sessionId = state.currentId;
  if (!sessionId || !state.listing) {
    toast("请先打开一个远端目录", "error");
    return;
  }
  if (!dialog || typeof dialog.open !== "function") {
    toast("当前环境不支持文件选择对话框", "error");
    return;
  }
  let picked: string | string[] | null = null;
  try {
    picked = await dialog.open(options);
  } catch (err) {
    toast(errorText(err), "error");
    return;
  }
  const list = (Array.isArray(picked) ? picked : [picked]).filter(Boolean) as string[];
  if (!list.length) return;
  const dir = state.listing.path;
  list.forEach((path) => enqueue(uploadSpec(sessionId, path, dir)));
}

export function uploadFiles(): void {
  void pickAndUpload({ title: "选择要上传的文件", multiple: true, directory: false });
}

export function uploadFolder(): void {
  void pickAndUpload({ title: "选择要上传的文件夹", multiple: false, directory: true });
}

export async function remove(entry: SftpEntry): Promise<void> {
  const kind = entry.is_dir ? "目录" : "文件";
  const extra = entry.is_dir ? "（只能删除空目录）" : "";
  const confirmed = await ask(`删除${kind}「${entry.name}」${extra}？此操作不可撤销。`, {
    title: "删除确认",
    okText: "删除",
    kind: "danger",
  });
  if (!confirmed) return;
  await run(`删除 ${entry.name}`, () => ipc.sftpDelete(state.currentId, entry.path));
}

export function openPanel(): void {
  if (!state.enabled) {
    toast("SFTP 已关闭，请在「设置 → 功能开关」中启用", "info");
    return;
  }
  setState({ open: true });
  bindTransferEvents();
  bindDragDrop();
  void (async () => {
    await loadConnections();
    const stale = state.listing ? state.listing.path : null;
    await refresh();
    if (state.currentId && stale) await loadListing(stale);
  })();
}

export function closePanel(): void {
  setState({ open: false });
}

/** 由 app.ts 在配置变化时调用（启动、保存设置、重置）。 */
export function setEnabledFromConfig(config: unknown): void {
  const enabled = !!featureFlags(config, "connection").sftp;
  if (!enabled) {
    setState({
      enabled: false,
      sessions: [],
      connections: [],
      pendingConn: null,
      currentId: null,
      listing: null,
      editing: null,
      lastError: null,
      connecting: false,
      transfers: [],
      dropVisible: false,
    });
    return;
  }
  setState({ enabled: true });
  void refresh();
}
