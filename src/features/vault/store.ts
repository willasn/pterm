import { useSyncExternalStore } from "react";
import { errorText, pt, toast } from "../../lib/legacy";
import { t } from "../i18n/store";
import { ipc } from "../ipc/api";
import { ask } from "../util/util";
import type { VaultStatus } from "./types";

/**
 * 主密码保险库门禁（由原 src/legacy/vault.ts 迁移而来）。核心，不随模块开关。
 *
 * 敏感字段（SSH 密码 / passphrase / 跳板机密码、AI API Key、Git 远端密码）由后端
 * 以主密码加密保存在配置目录的 secrets.json；派生密钥另存同目录的 vault.token 用于自动解锁。
 *
 * 本模块是「门禁」：新装首次打开时弹出弹窗要求设置主密码，之后启动由后端用本地令牌
 * 静默解锁、不再弹窗；仅在保险库被锁定或缺失时才要求输入。Git 同步导入的保险库若
 * 与本机主密码不一致，后端会广播 `git:vault-conflict`，这里弹出冲突处理弹窗。
 */

export interface VaultState {
  /** 主密码弹窗（设置 / 解锁）。 */
  gateOpen: boolean;
  /** 是否处于「首次设置」模式（需要两次输入）。 */
  setup: boolean;
  gateError: string;
  gateBusy: boolean;
  /** 输入框重建键：打开 / 重置时递增，使非受控输入清空。 */
  gateKey: number;
  /** 主密码冲突弹窗。 */
  conflictOpen: boolean;
  conflictError: string;
  conflictBusy: boolean;
  conflictKey: number;
}

const initialState: VaultState = {
  gateOpen: false,
  setup: false,
  gateError: "",
  gateBusy: false,
  gateKey: 0,
  conflictOpen: false,
  conflictError: "",
  conflictBusy: false,
  conflictKey: 0,
};

let state: VaultState = initialState;
const listeners = new Set<() => void>();

function setState(patch: Partial<VaultState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): VaultState {
  return state;
}

export function useVault(): VaultState {
  return useSyncExternalStore(subscribe, getState, getState);
}

function tr(key: string, fallback: string): string {
  return t(key, fallback);
}

// ---------------------------------------------------------------------------
// 待解锁 / 待决策时挂起的 resolve，用于让 boot 流程等待用户输入
// ---------------------------------------------------------------------------

let gateResolve: (() => void) | null = null;
let conflictResolve: (() => void) | null = null;

function openGate(isSetup: boolean): Promise<void> {
  setState({
    gateOpen: true,
    setup: !!isSetup,
    gateError: "",
    gateBusy: false,
    gateKey: state.gateKey + 1,
  });
  return new Promise((resolve) => {
    gateResolve = resolve;
  });
}

function closeGate(): void {
  setState({ gateOpen: false });
  const resolve = gateResolve;
  gateResolve = null;
  if (resolve) resolve();
}

/** 打开冲突弹窗；已在展示时不重复打开，避免覆盖待决策的 resolve。 */
function openConflict(): Promise<void> {
  if (state.conflictOpen) return Promise.resolve();
  setState({ conflictOpen: true, conflictError: "", conflictBusy: false, conflictKey: state.conflictKey + 1 });
  return new Promise((resolve) => {
    conflictResolve = resolve;
  });
}

function closeConflict(): void {
  setState({ conflictOpen: false });
  const resolve = conflictResolve;
  conflictResolve = null;
  if (resolve) resolve();
}

// ---------------------------------------------------------------------------
// 主密码弹窗
// ---------------------------------------------------------------------------

/** 校验两个输入框：返回错误文案（无错误则空串）。 */
function validate(current: string, again: string): string {
  if (!current) return tr("vault.empty", "请输入主密码");
  if (state.setup && current !== again) return tr("vault.mismatch", "两次输入的主密码不一致");
  return "";
}

export async function submitGate(current: string, again: string): Promise<void> {
  const message = validate(current, again);
  if (message) {
    setState({ gateError: message });
    return;
  }
  setState({ gateBusy: true });
  try {
    if (state.setup) await ipc.vaultSetup(current);
    else await ipc.vaultUnlock(current);
    closeGate();
  } catch (err) {
    setState({ gateError: errorText(err) });
  } finally {
    setState({ gateBusy: false });
  }
}

export async function resetVault(): Promise<void> {
  const ok = await ask(
    tr("vault.resetConfirm", "重置后保险库中的所有密码将被清除且无法恢复，确定继续？"),
    {
      title: tr("vault.resetTitle", "重置保险库"),
      okText: tr("vault.resetOk", "重置"),
      kind: "danger",
    }
  );
  if (!ok) return;
  try {
    await ipc.vaultReset();
    // 重置即回到「首次设置」
    setState({ setup: true, gateError: "", gateKey: state.gateKey + 1 });
  } catch (err) {
    setState({ gateError: errorText(err) });
  }
}

// ---------------------------------------------------------------------------
// 冲突弹窗
// ---------------------------------------------------------------------------

/** 采用远端：用远端主密码校验暂存的保险库，通过后落盘并解锁。 */
export async function adoptRemote(password: string): Promise<void> {
  if (!password) {
    setState({ conflictError: tr("vault.conflictNeedPassword", "请输入远端主密码") });
    return;
  }
  setState({ conflictBusy: true });
  try {
    await ipc.vaultAdoptPending(password);
    closeConflict();
    toast(tr("vault.conflictAdopted", "已采用远端保险库"), "ok");
    await refresh();
  } catch (err) {
    setState({ conflictError: errorText(err) });
  } finally {
    setState({ conflictBusy: false });
  }
}

/** 保留本地：丢弃远端，用本机密文重新覆盖远端仓库并推送。 */
export async function keepLocal(): Promise<void> {
  setState({ conflictBusy: true });
  try {
    await ipc.vaultDiscardPending();
    await ipc.gitCommit();
    await ipc.gitPush();
    closeConflict();
    toast(tr("vault.conflictKept", "已保留本地保险库并覆盖远端"), "ok");
    await refresh();
    if (pt().gitSync && typeof pt().gitSync.refresh === "function") {
      pt().gitSync.refresh().catch(() => {});
    }
  } catch (err) {
    setState({ conflictError: errorText(err) });
  } finally {
    setState({ conflictBusy: false });
  }
}

/** 暂停同步：保留本地，并在设置中关闭 secrets.json 同步。 */
export async function pauseSecrets(): Promise<void> {
  setState({ conflictBusy: true });
  try {
    await ipc.vaultDiscardPending();
    const config = await ipc.getConfig();
    if (config && config.features && config.features.sync) {
      config.features.sync.git_sync_secrets = false;
    }
    await ipc.saveConfig(config);
    closeConflict();
    toast(tr("vault.conflictPaused", "已暂停同步 secrets.json，可在设置中重新开启"), "warn");
    await refresh();
  } catch (err) {
    setState({ conflictError: errorText(err) });
  } finally {
    setState({ conflictBusy: false });
  }
}

// ---------------------------------------------------------------------------
// 门禁
// ---------------------------------------------------------------------------

/** 按后端状态决定是否弹窗：冲突优先，其次未解锁，均已就绪则直接返回。 */
export async function refresh(): Promise<boolean> {
  const status = (await ipc.vaultStatus()) as VaultStatus;
  if (status && status.conflict) {
    await openConflict();
    return true;
  }
  if (status && status.unlocked) return true;
  await openGate(!(status && status.configured));
  return true;
}

let bound = false;

/**
 * 同步导入新的保险库后会被后端加锁 / 触发冲突，这里重新评估门禁。
 *
 * 直接用 window.__TAURI__.event：本函数在组件挂载时订阅事件，
 * Tauri 会在页面脚本执行前注入该接口。
 * 回调里的跨模块调用在事件真正到来时才发生，届时 PTerm 已就绪。
 */
function bind(): void {
  if (bound) return;
  bound = true;
  const events = (window as any).__TAURI__?.event;
  if (!events || typeof events.listen !== "function") return;
  const reevaluate = () => {
    refresh().catch(() => {});
  };
  events.listen("git:config-updated", reevaluate).catch(() => {});
  events.listen("git:vault-conflict", reevaluate).catch(() => {});
}

/** boot 流程调用：确保应用进入已解锁状态后再继续。 */
export async function ensureUnlocked(): Promise<void> {
  bind();
  if (!ipc.available) return;
  try {
    await refresh();
  } catch (err) {
    // 门禁本身失败（例如 secrets.json 损坏）时不要卡死界面，交给后续操作报错
    console.error("[vault] 初始化失败", err);
    toast(errorText(err), "error");
  }
}

/** 手动锁定（设置界面用），锁定后立即弹窗要求重新解锁。 */
export async function lock(): Promise<void> {
  await ipc.vaultLock();
  await refresh();
}
