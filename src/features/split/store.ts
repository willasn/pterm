import { useSyncExternalStore } from "react";
import { errorText, toast } from "../../lib/legacy";
import { ipc } from "../ipc/api";
import { connect } from "../ssh/api";
import * as tabs from "../tabs/store";
import { active } from "../terminal/api";

/**
 * 分屏交互（由原 src/legacy/split.ts 迁移而来）：标签栏右侧的方向按钮与「选择分屏目标」弹窗。
 * 布局本身由 tabs 模块的 pane-group 负责，本模块只发起方向设置与新建会话。
 */

export interface SameHostItem {
  title: string;
  sub: string;
  params: any;
}

export interface SplitState {
  /** 是否显示方向按钮（需同时开启多标签与分屏，且有会话）。 */
  show: boolean;
  /** 当前分屏方向；未分屏为 null。 */
  dir: "h" | "v" | null;
  /** 当前标签内是否已分屏（决定「取消分屏」按钮是否可见）。 */
  split: boolean;
  /** 「选择分屏目标」弹窗。 */
  pickerOpen: boolean;
  pickerDir: "h" | "v";
  pickerGroup: string | null;
  /** 同主机新会话入口（无活动会话时为 null）。 */
  sameHost: SameHostItem | null;
  /** 已保存连接（不含 RDP）。 */
  connections: any[];
  /** 连接列表是否仍在加载。 */
  loading: boolean;
}

const initialState: SplitState = {
  show: false,
  dir: null,
  split: false,
  pickerOpen: false,
  pickerDir: "h",
  pickerGroup: null,
  sameHost: null,
  connections: [],
  loading: false,
};

let state: SplitState = initialState;
const listeners = new Set<() => void>();

function setState(patch: Partial<SplitState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): SplitState {
  return state;
}

export function useSplit(): SplitState {
  return useSyncExternalStore(subscribe, getState, getState);
}

function hasSplit(): boolean {
  return tabs.hasSplit();
}

/** 由 tabs 在布局变化后调用，刷新按钮可用状态。 */
export function sync(): void {
  const show = hasSplit() && tabs.hasTabs() && tabs.count() > 0;
  if (!show) {
    setState({ show: false, dir: null, split: false });
    return;
  }
  const group = tabs.activeGroup();
  const split = !!(group && group.memberIds.length > 1);
  setState({ show: true, split, dir: split ? (group.dir as "h" | "v") : null });
}

/** 分屏开关由 tabs 持有；这里只在配置变更时重建按钮。 */
export function setEnabledFromConfig(): void {
  sync();
}

/**
 * 发起分屏。
 * @param dir h 为左右并排，v 为上下堆叠
 */
export function start(dir: "h" | "v"): void {
  if (!hasSplit() || !tabs.hasTabs()) {
    toast("分屏不可用：需同时开启多标签与分屏", "info");
    return;
  }
  const group = tabs.activeGroup();
  if (!group) {
    toast("请先打开一个会话再分屏", "info");
    return;
  }
  // 方向要在新 pane 加入之前设好，否则会按旧方向渲染一帧
  tabs.setDirection(group.id, dir);
  if (group.memberIds.length > 1) return;
  void openPicker(group.id, dir);
}

export function closePicker(): void {
  setState({ pickerOpen: false });
}

/** 选择要放进新分屏的会话目标。 */
export async function openPicker(groupId: string, dir: "h" | "v"): Promise<void> {
  const current = active();
  const sameHost: SameHostItem | null =
    current && current.params
      ? (() => {
          // 同一主机再开一个会话：复用当前会话的参数，仅清除会话 id
          const params = Object.assign({}, current.params, { session_id: null });
          return { title: `同主机新会话 · ${params.username}@${params.host}`, sub: "沿用当前会话的连接参数", params };
        })()
      : null;

  setState({
    pickerOpen: true,
    pickerDir: dir,
    pickerGroup: groupId,
    sameHost,
    connections: [],
    loading: true,
  });

  let connections: any[] = [];
  try {
    // 分屏开的是 SSH 终端，RDP 连接不在此列出
    connections = ((await ipc.listConnections()) || []).filter(
      (c: any) => (c.protocol || "ssh") !== "rdp"
    );
  } catch (err) {
    toast(errorText(err), "error");
    if (state.pickerOpen) setState({ pickerOpen: false });
    return;
  }
  if (!state.pickerOpen) return;
  setState({ connections, loading: false });
}

/** 把新会话并入指定标签，失败时提示但不影响已有会话。 */
export async function openInto(params: any): Promise<void> {
  const groupId = state.pickerGroup;
  setState({ pickerOpen: false });
  try {
    await connect(params, { groupId });
  } catch (err) {
    toast(errorText(err), "error");
  }
}

/** 取消分屏：把一个标签内的会话拆成独立标签，不断开任何连接。 */
export function stop(): void {
  const group = tabs.activeGroup();
  if (!group || group.memberIds.length < 2) return;
  const moved = tabs.unmerge(group);
  if (moved) toast(`已取消分屏，${moved} 个会话拆分为独立标签`, "info");
}
