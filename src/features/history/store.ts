import { useSyncExternalStore } from "react";
import { auxiliaryFlags, errorText, toast } from "../../lib/legacy";
import { active } from "../terminal/api";
import { ipc } from "../ipc/api";
import { write } from "../ssh/api";
import { ask } from "../util/util";
import type { HistoryEntry, HistoryOrder } from "./types";

/**
 * 命令历史的状态与行为（由原 src/legacy/history.ts 迁移而来）。
 *
 * 去重与频率统计都在 Rust 侧的聚合查询里完成（不删原始记录），
 * 前端只负责传参（搜索词 / 是否去重 / 排序方式）与展示使用次数。
 * 插入终端只写入输入行、不追加回车，保留 terminal 的危险命令二次确认。
 */

const LIMIT = 200;
/** 搜索输入的防抖时长：逐字输入时只发最后一次查询。 */
const SEARCH_DEBOUNCE = 250;

export interface HistoryState {
  enabled: boolean;
  busy: boolean;
  entries: HistoryEntry[];
  query: string;
  dedupe: boolean;
  order: HistoryOrder;
  lastError: string | null;
  open: boolean;
}

const initialState: HistoryState = {
  enabled: false,
  busy: false,
  entries: [],
  query: "",
  dedupe: true,
  order: "recent",
  lastError: null,
  open: false,
};

let state: HistoryState = initialState;
const listeners = new Set<() => void>();

function setState(patch: Partial<HistoryState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): HistoryState {
  return state;
}

export function useHistory(): HistoryState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/** 列表最多显示的条数（展示在筛选框标签上）。 */
export const HISTORY_LIMIT = LIMIT;

function sessionLabel(ctrl: any): string {
  const info = (ctrl && ctrl.info) || {};
  return info.name || info.host || String((ctrl && ctrl.id) || "").slice(0, 8);
}

/** 把 ISO 时间戳格式化成「YYYY-MM-DD HH:mm」。 */
export function shortTime(iso: string): string {
  const time = Date.parse(iso);
  if (!time) return iso || "";
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

// ---------------------------------------------------------------------------
// 行为
// ---------------------------------------------------------------------------

async function load(): Promise<void> {
  if (!state.enabled) return;
  try {
    const list =
      ((await ipc.listHistory(LIMIT, state.query || null, state.dedupe, state.order)) ||
        []) as HistoryEntry[];
    setState({ entries: list, lastError: null });
  } catch (err) {
    const message = errorText(err);
    setState({ entries: [], lastError: message });
    if (state.open) toast(message, "error");
  }
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSearch(): void {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    void load();
  }, SEARCH_DEBOUNCE);
}

export function setQuery(query: string): void {
  setState({ query });
  scheduleSearch();
}

export function setDedupe(dedupe: boolean): void {
  setState({ dedupe });
  void refresh();
}

export function setOrder(order: HistoryOrder): void {
  setState({ order });
  void refresh();
}

export async function refresh(): Promise<void> {
  if (!state.enabled) {
    setState({ entries: [], query: "", lastError: null });
    return;
  }
  setState({ busy: true });
  try {
    await load();
  } finally {
    setState({ busy: false });
  }
}

export function openPanel(): void {
  if (!state.enabled) {
    toast("命令历史已关闭，请在「设置 → 功能开关」中启用", "info");
    return;
  }
  setState({ open: true });
  void refresh();
}

export function closePanel(): void {
  setState({ open: false });
}

export async function clearAll(): Promise<void> {
  if (state.busy) return;
  const confirmed = await ask("清空全部命令历史？此操作不可撤销。", {
    title: "清空确认",
    okText: "清空",
    kind: "danger",
  });
  if (!confirmed) return;
  setState({ busy: true });
  try {
    await ipc.clearHistory();
    toast("命令历史已清空", "ok");
  } catch (err) {
    toast(errorText(err), "error");
  } finally {
    setState({ busy: false });
    await refresh();
  }
}

export async function insertEntry(entry: HistoryEntry): Promise<void> {
  const ctrl = active();
  if (!ctrl) {
    toast("当前没有打开的会话", "error");
    return;
  }
  try {
    await write(ctrl.id, entry.command);
    toast(`已插入到 ${sessionLabel(ctrl)}`, "ok");
  } catch (err) {
    toast(errorText(err), "error");
  }
}

/** 由 app.ts 在配置变化时调用（启动、保存设置、重置）。 */
export function setEnabledFromConfig(config: unknown): void {
  const enabled = !!auxiliaryFlags(config).command_history;
  if (!enabled) {
    setState({ enabled: false, entries: [], query: "", lastError: null });
    return;
  }
  setState({ enabled: true });
  void refresh();
}

/** 条目按钮的悬停提示：有会话则提示插入目标，否则说明当前无会话。 */
export function insertTitle(): string {
  const ctrl = active();
  return ctrl ? `插入到 ${sessionLabel(ctrl)}` : "当前没有打开的会话";
}
