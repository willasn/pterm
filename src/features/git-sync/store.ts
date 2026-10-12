import { useSyncExternalStore } from "react";
import { errorText, featureFlags, toast } from "../../lib/legacy";
import { applyConfig } from "../app/store";
import { refresh as refreshConnections } from "../connections/store";
import { ipc } from "../ipc/api";
import { choose } from "../util/util";
import type { ConflictChoice, GitStatus, SyncOutcome } from "./types";

/**
 * Git 同步面板的状态与行为（由原 src/legacy/git_sync.ts 迁移而来）。
 *
 * 面向使用者只暴露一个「同步」按钮：点击后选择同步范围，出现冲突时再按数据域逐个选择
 * 处理方式。Git 内部概念（分支 / ahead / behind / diff / 初始化）不上界面；仓库操作全部
 * 经 Tauri command 交给 Rust：优先 git2（进程内 libgit2），仅在 libgit2 明确不支持时
 * 回退系统 git CLI。
 *
 * 只在 features.sync.git_sync 打开时可用：关闭时侧栏入口隐藏、面板不加载，
 * 后端 command 也会以 ModuleDisabled 拒绝。
 */

export interface GitSyncState {
  enabled: boolean;
  busy: boolean;
  status: GitStatus | null;
  /** 上次同步返回、仍待用户决策的冲突文件；设置类冲突后端已自动以远端为准 */
  pendingConflicts: string[] | null;
  open: boolean;
}

const initialState: GitSyncState = {
  enabled: false,
  busy: false,
  status: null,
  pendingConflicts: null,
  open: false,
};

let state: GitSyncState = initialState;
const listeners = new Set<() => void>();

function setState(patch: Partial<GitSyncState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): GitSyncState {
  return state;
}

export function useGitSync(): GitSyncState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/** 需要用户决策的冲突（连接 / 片段）；设置与保险库由后端直接以远端为准。 */
function needsDecision(conflicts: string[] | undefined): boolean {
  if (!conflicts || !conflicts.length) return false;
  return conflicts.indexOf("connections.json") >= 0 || conflicts.indexOf("snippets.json") >= 0;
}

/** 把后端 RFC3339 的上次同步时间格式化成徽标用的紧凑文案（如 10-12 14:23）。 */
function formatSyncTime(raw?: string | null): string {
  if (!raw) return "";
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 侧栏徽标文案（只讲业务状态，不暴露 Git 细节）。 */
export function badgeText(): string {
  const { status, pendingConflicts } = state;
  if (!status) return "同步 …";
  if (pendingConflicts) return "需处理冲突";
  if (!(status.remotes || []).length) return "未配置远端";
  const pending =
    (status.ahead || 0) + (status.behind || 0) + (status.dirty || 0) + (status.untracked || 0);
  if (pending) return "待同步 " + pending + " 项";
  // 已同步时在末尾附上上次同步时间
  const at = formatSyncTime(status.last_sync_at);
  return at ? `已同步 · ${at}` : "已同步";
}

// ---------------------------------------------------------------------------
// 行为
// ---------------------------------------------------------------------------

export async function refresh(): Promise<void> {
  if (!state.enabled) {
    setState({ status: null });
    return;
  }
  try {
    const status = (await ipc.gitStatus()) as GitStatus;
    setState({ status });
  } catch (err) {
    setState({ status: null });
    if (state.open) toast(errorText(err), "error");
  }
}

async function run(fn: () => Promise<SyncOutcome>): Promise<void> {
  if (state.busy) return;
  setState({ busy: true });
  try {
    const outcome = await fn();
    if (needsDecision(outcome && outcome.conflicts)) {
      setState({ pendingConflicts: outcome.conflicts || [] });
      toast((outcome && outcome.message) || "同步暂停，等待你确认冲突处理方式", "info");
    } else {
      setState({ pendingConflicts: null });
      toast((outcome && outcome.message) || "同步完成", "ok");
    }
  } catch (err) {
    toast(errorText(err), "error");
  } finally {
    setState({ busy: false });
    await refresh();
  }
}

/** 单按钮入口：先选同步范围，再执行。 */
export async function startSync(): Promise<void> {
  if (state.busy) return;
  const includeSecrets = await choose({
    title: "同步",
    message: "选择本次同步的范围。连接密码与 API Key 属于敏感信息，可单独排除。",
    options: [
      { value: true, label: "同步全部", desc: "包含连接密码与 API Key（密文）", kind: "primary" },
      { value: false, label: "同步全部（不包含连接密码、API Key）", desc: "仅同步设置、连接与命令片段" },
    ],
  });
  if (includeSecrets === null) return;
  await run(() => ipc.gitSyncNow(includeSecrets));
}

/** 冲突决策：按数据域逐个让用户选择，随后一次提交给后端解决并推送。 */
export async function resolveConflicts(): Promise<void> {
  if (state.busy) return;
  const conflicts = state.pendingConflicts || [];
  const pick = (title: string, message: string) =>
    choose({
      title,
      message,
      options: [
        { value: "remote", label: "远端覆盖", desc: "以仓库中的内容为准", kind: "primary" },
        { value: "local", label: "本地覆盖", desc: "以本机内容为准" },
        { value: "both", label: "两者保留", desc: "同名条目保留为两条" },
      ],
    }) as Promise<ConflictChoice | null>;

  let connections: ConflictChoice = "remote";
  let snippets: ConflictChoice = "remote";
  if (conflicts.indexOf("connections.json") >= 0) {
    const picked = await pick("连接冲突", "同一份连接在两处都被修改过，选择如何保留。");
    if (picked === null) return;
    connections = picked;
  }
  if (conflicts.indexOf("snippets.json") >= 0) {
    const picked = await pick("命令片段冲突", "同一份命令片段在两处都被修改过，选择如何保留。");
    if (picked === null) return;
    snippets = picked;
  }

  await run(async () => {
    const outcome = (await ipc.gitResolve(connections, snippets)) as SyncOutcome;
    setState({ pendingConflicts: null });
    return outcome;
  });
}

export function openPanel(): void {
  if (!state.enabled) {
    toast("Git 同步已关闭，请在「设置 → 功能开关」中启用", "info");
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
  const enabled = !!featureFlags(config, "sync").git_sync;
  if (!enabled) {
    setState({ enabled: false, status: null, pendingConflicts: null });
    return;
  }
  setState({ enabled: true });
  void refresh();
}

// ---------------------------------------------------------------------------
// 同步导入会改动本地配置，后端广播后这里重新拉取一次
// ---------------------------------------------------------------------------

/**
 * 订阅 git:config-updated。
 *
 * 直接走 window.__TAURI__.event：本函数在组件挂载时订阅事件，
 * Tauri 会在页面脚本执行前注入该接口。
 */
export function subscribeConfigUpdated(): () => void {
  const events = (window as any).__TAURI__?.event;
  if (!events || typeof events.listen !== "function") return () => {};

  let unlisten: (() => void) | null = null;
  let cancelled = false;
  events
    .listen("git:config-updated", async () => {
      try {
        const config = await ipc.getConfig();
        applyConfig(config);
        refreshConnections().catch(() => {});
        toast("已从同步仓库导入配置", "info");
      } catch (err) {
        toast(errorText(err), "error");
      }
    })
    .then((fn: () => void) => {
      if (cancelled) fn();
      else unlisten = fn;
    })
    .catch(() => {});

  return () => {
    cancelled = true;
    if (unlisten) unlisten();
  };
}
