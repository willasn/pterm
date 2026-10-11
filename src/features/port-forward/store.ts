import { useSyncExternalStore } from "react";
import { errorText, featureFlags, toast } from "../../lib/legacy";
import { paramsFor } from "../connections/store";
import { ipc } from "../ipc/api";
import { ask } from "../util/util";
import type { PortForwardDraft, PortForwardKind, RunningForward } from "./types";

/**
 * 端口转发的状态与行为（由原 src/legacy/port_forward.ts 迁移而来）。
 *
 * 只在 features.connection.port_forward 打开时可用：关闭时侧栏入口隐藏、面板不加载，
 * 后端 command 也会以 ModuleDisabled 拒绝。
 * 转发规则是运行期内存态（后端决定，不写配置），因此面板只做两件事：
 * 新建一条规则并启动，以及查看 / 停止已在运行的规则。
 * 本地与远程转发需要显式目标地址，动态转发（SOCKS5）由客户端在握手时指定。
 */

export const KINDS: { value: PortForwardKind; label: string }[] = [
  { value: "local", label: "本地转发" },
  { value: "remote", label: "远程转发" },
  { value: "dynamic", label: "动态转发（SOCKS5）" },
];

function blankDraft(): PortForwardDraft {
  return {
    connection_id: null,
    kind: "local",
    bind_host: "",
    bind_port: "",
    target_host: "",
    target_port: "",
    label: "",
  };
}

export interface PortForwardState {
  enabled: boolean;
  busy: boolean;
  /** 可选连接（已排除 RDP 连接）。 */
  connections: any[];
  forwards: RunningForward[];
  draft: PortForwardDraft;
  lastError: string | null;
  open: boolean;
}

const initialState: PortForwardState = {
  enabled: false,
  busy: false,
  connections: [],
  forwards: [],
  draft: blankDraft(),
  lastError: null,
  open: false,
};

let state: PortForwardState = initialState;
const listeners = new Set<() => void>();

function setState(patch: Partial<PortForwardState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): PortForwardState {
  return state;
}

export function usePortForward(): PortForwardState {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function kindLabel(kind: string): string {
  const hit = KINDS.filter((k) => k.value === kind)[0];
  return hit ? hit.label : String(kind || "");
}

/** 侧栏徽标文案。 */
export function badgeText(forwards: RunningForward[]): string {
  return forwards.length ? "端口转发 " + forwards.length : "端口转发";
}

/** 保证草稿里的连接有效：为空或已失效时落到第一个连接。 */
function normalizeSelection(draft: PortForwardDraft, connections: any[]): PortForwardDraft {
  if (draft.connection_id && connections.some((c) => c.id === draft.connection_id)) {
    return draft;
  }
  return { ...draft, connection_id: connections.length ? connections[0].id : null };
}

// ---------------------------------------------------------------------------
// 行为
// ---------------------------------------------------------------------------

export function setDraftField<K extends keyof PortForwardDraft>(
  field: K,
  value: PortForwardDraft[K]
): void {
  setState({ draft: { ...state.draft, [field]: value } });
}

async function loadConnections(): Promise<void> {
  let connections: any[] = [];
  try {
    // 端口转发走 SSH 隧道，RDP 连接不在此列出
    connections = ((await ipc.listConnections()) || []).filter(
      (c: any) => (c.protocol || "ssh") !== "rdp"
    );
  } catch {
    connections = [];
  }
  setState({ connections, draft: normalizeSelection(state.draft, connections) });
}

export async function refresh(): Promise<void> {
  if (!state.enabled) {
    setState({ forwards: [], connections: [], draft: blankDraft(), lastError: null });
    return;
  }
  try {
    const forwards = ((await ipc.portForwardList()) || []) as RunningForward[];
    setState({ forwards, lastError: null });
  } catch (err) {
    setState({ forwards: [], lastError: errorText(err) });
  }
}

/** 端口取值：非负整数否则用 fallback。 */
function portOf(raw: unknown, fallback: number): number {
  const n = parseInt(String(raw == null ? "" : raw).trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function start(): Promise<void> {
  if (state.busy) return;
  const { draft, connections } = state;
  const conn = connections.filter((c) => c.id === draft.connection_id)[0];
  if (!conn) {
    toast("请选择一个连接", "error");
    return;
  }
  const dynamic = draft.kind === "dynamic";
  const targetHost = String(draft.target_host || "").trim();
  const targetPort = portOf(draft.target_port, 0);
  if (!dynamic && !targetHost) {
    toast("请填写目标地址", "error");
    return;
  }
  if (!dynamic && targetPort === 0) {
    toast("目标端口需为 1~65535", "error");
    return;
  }
  const request = {
    params: paramsFor(conn),
    kind: draft.kind,
    bind_host: String(draft.bind_host || "").trim() || null,
    bind_port: portOf(draft.bind_port, 0),
    target_host: dynamic ? null : targetHost,
    target_port: dynamic ? 0 : targetPort,
    label: String(draft.label || "").trim() || null,
  };
  setState({ busy: true });
  try {
    const info = (await ipc.portForwardStart(request)) as RunningForward;
    toast(`已启动${kindLabel(info.kind)}：${info.endpoint}`, "ok");
    const next = blankDraft();
    setState({ draft: normalizeSelection(next, connections) });
  } catch (err) {
    toast(errorText(err), "error");
  } finally {
    setState({ busy: false });
    await refresh();
  }
}

export async function stop(info: RunningForward): Promise<void> {
  if (state.busy) return;
  const confirmed = await ask(`停止转发「${info.label}」？\n${info.endpoint}`);
  if (!confirmed) return;
  setState({ busy: true });
  try {
    await ipc.portForwardStop(info.id);
    toast(`已停止「${info.label}」`, "ok");
  } catch (err) {
    toast(errorText(err), "error");
  } finally {
    setState({ busy: false });
    await refresh();
  }
}

export function openPanel(): void {
  if (!state.enabled) {
    toast("端口转发已关闭，请在「设置 → 功能开关」中启用", "info");
    return;
  }
  setState({ open: true });
  void loadConnections().then(() => refresh());
}

export function closePanel(): void {
  setState({ open: false });
}

/** 由 app.ts 在配置变化时调用（启动、保存设置、重置）。 */
export function setEnabledFromConfig(config: unknown): void {
  const enabled = !!featureFlags(config, "connection").port_forward;
  if (!enabled) {
    setState({ enabled: false, forwards: [], connections: [], draft: blankDraft(), lastError: null });
    return;
  }
  setState({ enabled: true });
  void refresh();
}
