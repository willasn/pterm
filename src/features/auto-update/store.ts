import { useSyncExternalStore } from "react";
import { auxiliaryFlags, errorText, toast } from "../../lib/legacy";
import { ipc } from "../ipc/api";

/**
 * 自动更新的状态与行为。
 *
 * 检查与安装都在 Rust 侧完成（modules/auto_update），这里只管状态机与提示：
 * 启动后按开关自动检查一次（结果按天缓存，避免每次启动都打网络），设置「关于」页
 * 也可手动检查；发现新版本时右下角弹出提示条，点击「立即更新」下载安装并重启。
 */

/** 下载进度事件名，与 Rust 侧 modules/auto_update/commands.rs 保持一致。 */
const PROGRESS_EVENT = "update:progress";
/** 检查结果缓存键与有效期。 */
const CACHE_KEY = "pterm.update.check";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface UpdateInfo {
  has_update: boolean;
  current: string;
  latest: string | null;
  notes: string | null;
  published_at: number | null;
}

export type UpdateStatus =
  | "idle"
  | "checking"
  /** 已是最新版本 */
  | "latest"
  /** 发现新版本，等待用户决定 */
  | "available"
  | "downloading"
  | "error";

export interface AutoUpdateState {
  enabled: boolean;
  status: UpdateStatus;
  current: string;
  latest: string | null;
  notes: string | null;
  publishedAt: number | null;
  /** 已下载字节数（下载中） */
  downloaded: number;
  /** 安装包总字节数，未知时为 null */
  total: number | null;
  lastError: string | null;
  /** 用户点了「稍后」，本次会话内不再展示提示条 */
  dismissed: boolean;
}

const initialState: AutoUpdateState = {
  enabled: false,
  status: "idle",
  current: "",
  latest: null,
  notes: null,
  publishedAt: null,
  downloaded: 0,
  total: null,
  lastError: null,
  dismissed: false,
};

let state: AutoUpdateState = initialState;
const listeners = new Set<() => void>();

function setState(patch: Partial<AutoUpdateState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): AutoUpdateState {
  return state;
}

export function useAutoUpdate(): AutoUpdateState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/** 读取上次检查结果缓存（localStorage 不可用时视为无缓存）。 */
function cacheRead(): { at: number; info: UpdateInfo } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.at !== "number" || !parsed.info) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function cacheWrite(info: UpdateInfo): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), info }));
  } catch (_) {
    /* 存储不可用时忽略：下次启动照常重新检查 */
  }
}

/** 把一次检查结果落到状态里。 */
function applyInfo(info: UpdateInfo): void {
  setState({
    current: info.current || state.current,
    latest: info.latest,
    notes: info.notes,
    publishedAt: info.published_at,
    status: info.has_update ? "available" : "latest",
    downloaded: 0,
    total: null,
    lastError: null,
    // 有新版本就重新展示提示条（即使上次点过「稍后」）
    dismissed: info.has_update ? false : state.dismissed,
  });
}

/** 配置派发：记录开关；关闭时清空提示与状态。 */
export function setEnabledFromConfig(config: unknown): void {
  const enabled = !!auxiliaryFlags(config).auto_update;
  setState(enabled ? { enabled: true } : { ...initialState, enabled: false });
}

/** 启动检查：24 小时内查过就直接用缓存结果，不重复打网络。 */
export function autoCheckOnStartup(): void {
  if (!state.enabled) return;
  const cached = cacheRead();
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    applyInfo(cached.info);
    return;
  }
  void check();
}

/** 检查更新。`manual` 为 true 时用轻提示告知「已是最新」或检查失败。 */
export async function check(options: { manual?: boolean } = {}): Promise<void> {
  if (!state.enabled) return;
  if (state.status === "checking" || state.status === "downloading") return;
  setState({ status: "checking", lastError: null });
  try {
    const info = (await ipc.updateCheck()) as UpdateInfo;
    applyInfo(info);
    cacheWrite(info);
    if (options.manual && !info.has_update) toast("已是最新版本");
  } catch (err) {
    const message = errorText(err);
    setState({ status: "error", lastError: message });
    if (options.manual) toast(message, "error");
  }
}

/** 下载并安装更新，成功后应用由 Rust 侧重启。 */
export async function install(): Promise<void> {
  if (state.status === "downloading") return;
  setState({ status: "downloading", downloaded: 0, total: null, lastError: null });
  const off = await ipc.listen(PROGRESS_EVENT, (payload: any) => {
    const chunk = Number(payload?.chunk || 0);
    const total = payload?.total == null ? null : Number(payload.total);
    setState({ downloaded: state.downloaded + chunk, total: total ?? state.total });
  });
  try {
    await ipc.updateInstall();
    off();
  } catch (err) {
    off();
    const message = errorText(err);
    setState({ status: "error", lastError: message });
    toast(message, "error");
  }
}

/** 用户选择「稍后」：本次会话内不再展示提示条。 */
export function dismiss(): void {
  setState({ dismissed: true });
}

/** 下载进度百分比（0~100），总量未知时返回 null。 */
export function progressPercent(current: AutoUpdateState): number | null {
  if (!current.total) return null;
  return Math.min(100, Math.round((current.downloaded / current.total) * 100));
}
