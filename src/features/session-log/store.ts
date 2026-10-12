import { useSyncExternalStore } from "react";
import { errorText, featureFlags, pt, toast } from "../../lib/legacy";
import { ipc } from "../ipc/api";
import { ask } from "../util/util";
import type { SessionLogEntry, SessionLogStatus } from "./types";

/**
 * 会话日志的状态与行为（由原 src/legacy/session_log.ts 迁移而来）。
 *
 * 只在 features.connection.session_log 打开时可用：关闭时侧栏入口隐藏、面板不加载，
 * 后端 command 也会以 ModuleDisabled 拒绝。
 * 落盘由 SSH 核心在数据泵里完成，本面板只做查阅与清理，全程经 Tauri command。
 */

export interface SessionLogState {
  enabled: boolean;
  busy: boolean;
  status: SessionLogStatus | null;
  entries: SessionLogEntry[];
  /** 当前预览的文件名；null 表示未选择。 */
  selected: string | null;
  /** 预览内容；null 表示未选择文件。 */
  preview: string | null;
  open: boolean;
}

const initialState: SessionLogState = {
  enabled: false,
  busy: false,
  status: null,
  entries: [],
  selected: null,
  preview: null,
  open: false,
};

let state: SessionLogState = initialState;
const listeners = new Set<() => void>();

function setState(patch: Partial<SessionLogState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): SessionLogState {
  return state;
}

export function useSessionLog(): SessionLogState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/** 字节数转可读大小。 */
export function humanSize(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

/** 侧栏徽标文案。 */
export function badgeText(status: SessionLogStatus | null): string {
  if (!status) return "日志 …";
  const marks = [`${status.count} 个文件`];
  if (status.active) marks.push(`记录中 ${status.active}`);
  return "日志 " + marks.join(" · ");
}

// ---------------------------------------------------------------------------
// 行为
// ---------------------------------------------------------------------------

export async function refresh(): Promise<void> {
  if (!state.enabled) {
    setState({ status: null, entries: [] });
    return;
  }
  try {
    const status = (await ipc.sessionLogStatus()) as SessionLogStatus;
    const entries = ((await ipc.sessionLogList()) || []) as SessionLogEntry[];
    setState({ status, entries });
  } catch (err) {
    setState({ status: null, entries: [] });
    if (state.open) toast(errorText(err), "error");
  }
}

/** 清空等操作的统一包装：置忙、提示结果（数字表示文件数）、随后刷新。 */
async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
  if (state.busy) return;
  setState({ busy: true });
  try {
    const outcome = await fn();
    const detail = typeof outcome === "number" ? `，共 ${outcome} 个文件` : "";
    toast(label + "完成" + detail, "ok");
  } catch (err) {
    toast(errorText(err), "error");
  } finally {
    setState({ busy: false });
    await refresh();
  }
}

/** 选中单个文件并读取其末尾内容（仅单个文件，最多截取末尾 10 KB）。 */
export async function selectLog(name: string): Promise<void> {
  let preview: string;
  try {
    preview = (await ipc.sessionLogRead(name, 0)) as string;
  } catch (err) {
    toast(errorText(err), "error");
    return;
  }
  setState({ preview, selected: name });
}

export function clearPreview(): void {
  setState({ selected: null, preview: null });
}

export async function clearAll(): Promise<void> {
  const confirmed = await ask(
    "清空全部会话日志文件？此操作不可撤销，正在记录的会话会继续写入，但历史内容无法恢复。",
    { title: "清空确认", okText: "清空", kind: "danger" }
  );
  if (!confirmed) return;
  setState({ selected: null, preview: null });
  await run("清空日志", () => ipc.sessionLogClear());
}

export function openPanel(): void {
  if (!state.enabled) {
    toast("会话日志已关闭，请在「设置 → 功能开关」中启用", "info");
    return;
  }
  setState({ open: true });
  void refresh();
}

export function closePanel(): void {
  setState({ open: false });
}

/** 由 app.ts 在配置变化时调用（启动、保存设置、重置）。 */
export function setEnabledFromConfig(config: unknown): void {
  const enabled = !!featureFlags(config, "connection").session_log;
  if (!enabled) {
    setState({ enabled: false, status: null, entries: [], selected: null, preview: null });
    return;
  }
  setState({ enabled: true });
  void refresh();
}
