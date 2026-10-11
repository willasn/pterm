import { useSyncExternalStore } from "react";
import { auxiliaryFlags, errorText, toast } from "../../lib/legacy";
import { connectTo } from "../connections/store";
import { open as openSettings, searchIndex } from "../settings/store";
import { openPanel as openSnippetsPanel } from "../snippets/store";
import { active } from "../terminal/api";
import { ipc } from "../ipc/api";
import { write } from "../ssh/api";
import { rank, termsOf } from "./matcher";
import type { SearchGroup, SearchHit, SearchSources } from "./types";

/**
 * 全局搜索的状态与行为（由原 src/legacy/search.ts 迁移而来）。
 *
 * 四个数据源在面板打开时一次性拉齐，之后完全在本地过滤，输入不再打 IPC：
 *   连接 → list_connections
 *   片段 → snippet_list（仅在「命令片段」模块打开时拉取）
 *   历史 → list_history（仅在「命令历史」模块打开时拉取）
 *   设置 → legacy settings.searchIndex()，本就是前端数据
 * 关闭的模块不参与搜索、也不拉取：它们的命令会被后端以 ModuleDisabled 拒绝，
 * 拉取失败会连累整个搜索。
 */

/** 每个来源最多展示的命中条数 */
const PER_SOURCE = 6;
/** 向后端请求的历史条数上限 */
const HISTORY_LIMIT = 200;

export interface SearchState {
  enabled: boolean;
  /** features.auxiliary 的快照，用于判断哪些数据源可用 */
  flags: Record<string, boolean>;
  sources: SearchSources | null;
  lastError: string | null;
  query: string;
  open: boolean;
}

const initialState: SearchState = {
  enabled: false,
  flags: {},
  sources: null,
  lastError: null,
  query: "",
  open: false,
};

let state: SearchState = initialState;
const listeners = new Set<() => void>();

function setState(patch: Partial<SearchState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): SearchState {
  return state;
}

export function useSearch(): SearchState {
  return useSyncExternalStore(subscribe, getState, getState);
}

function sessionLabel(ctrl: any): string {
  const info = (ctrl && ctrl.info) || {};
  return info.name || info.host || String((ctrl && ctrl.id) || "").slice(0, 8);
}

// ---------------------------------------------------------------------------
// 命中项：每个数据源都把记录归一成 { title, meta, hay, activate }
// ---------------------------------------------------------------------------

function connectionHits(sources: SearchSources): SearchHit[] {
  return sources.connections.map((conn) => ({
    title: conn.name || conn.host,
    meta: [conn.group_name, `${conn.host}:${conn.port || 22}`, conn.username].filter(Boolean).join(" · "),
    hay: [conn.name, conn.host, conn.username, conn.group_name, conn.port]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
    activate: () => {
      closePanel();
      void connectTo(conn);
    },
  }));
}

function snippetHits(sources: SearchSources): SearchHit[] {
  return sources.snippets.map((snip) => {
    const vars: string[] = snip.variables || [];
    return {
      title: snip.name || "(未命名片段)",
      meta: [
        vars.length ? `含变量 ${vars.length} 个` : "可直接插入",
        snip.group_name,
        snip.description,
      ]
        .filter(Boolean)
        .join(" · "),
      hay: [snip.name, snip.description, snip.content, snip.group_name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
      activate: () => insertSnippet(snip, vars),
    };
  });
}

function historyHits(sources: SearchSources): SearchHit[] {
  return sources.history.map((entry) => ({
    title: entry.command,
    meta: [entry.uses > 1 ? `×${entry.uses}` : null, entry.host].filter(Boolean).join(" · "),
    hay: [entry.command, entry.host].filter(Boolean).join(" ").toLowerCase(),
    activate: () => void insertText(entry.command),
  }));
}

function settingHits(sources: SearchSources): SearchHit[] {
  return sources.settings.map((item) => ({
    title: item.title,
    meta: item.subtitle || "",
    hay: [item.title, item.subtitle, item.keywords].filter(Boolean).join(" ").toLowerCase(),
    activate: () => {
      closePanel();
      void openSettings(item.category);
    },
  }));
}

interface GroupSpec {
  label: string;
  build: () => SearchHit[];
  /** 省略表示始终可用；关闭的模块不出现，避免用户误以为搜索缺数据。 */
  enabled?: () => boolean;
}

function groupSpecs(sources: SearchSources, flags: Record<string, boolean>): GroupSpec[] {
  return (
    [
      { label: "连接", build: () => connectionHits(sources) },
      { label: "命令片段", build: () => snippetHits(sources), enabled: () => !!flags.snippets },
      { label: "命令历史", build: () => historyHits(sources), enabled: () => !!flags.command_history },
      { label: "设置", build: () => settingHits(sources) },
    ] as GroupSpec[]
  ).filter((spec) => !spec.enabled || spec.enabled());
}

/** 当前关键词下的命中分组（空关键词返回空数组）。 */
export function searchGroups(): SearchGroup[] {
  const { sources, flags, query } = state;
  if (!sources) return [];
  const terms = termsOf(query);
  if (!terms.length) return [];

  const groups: SearchGroup[] = [];
  groupSpecs(sources, flags).forEach((spec) => {
    const matched = spec
      .build()
      .map((item) => ({ item, weight: rank(item, terms) }))
      .filter((hit) => hit.weight >= 0)
      .sort((a, b) => b.weight - a.weight);
    if (!matched.length) return;
    groups.push({
      label: spec.label,
      count: matched.length,
      hits: matched.slice(0, PER_SOURCE).map((hit) => hit.item),
    });
  });
  return groups;
}

// ---------------------------------------------------------------------------
// 行为
// ---------------------------------------------------------------------------

/** 写入当前会话的输入行，不追加回车：保留 terminal 的危险命令二次确认。 */
async function insertText(text: string, label?: string): Promise<void> {
  const ctrl = active();
  if (!ctrl) {
    toast("没有可写入的终端会话，请先从左侧连接一个主机", "info");
    return;
  }
  try {
    await write(ctrl.id, text);
    closePanel();
    toast(label || `已插入到 ${sessionLabel(ctrl)}`, "ok");
  } catch (err) {
    toast(errorText(err), "error");
  }
}

/** 含变量的片段不在搜索面板里插：变量值必须在片段面板中填写。 */
function insertSnippet(snip: any, vars: string[]): void {
  if (vars.length) {
    closePanel();
    toast("该片段含变量，请在命令片段面板中填写后插入", "info");
    openSnippetsPanel();
    return;
  }
  void insertText(snip.content || "", `已插入「${snip.name}」`);
}

async function load(): Promise<void> {
  const flags = state.flags;
  const wantSnippets = !!flags.snippets;
  const wantHistory = !!flags.command_history;
  const [connections, snippets, history] = await Promise.all([
    ipc.listConnections(),
    wantSnippets ? ipc.snippetList() : Promise.resolve([]),
    wantHistory ? ipc.listHistory(HISTORY_LIMIT, null, true, "recent") : Promise.resolve([]),
  ]);
  const settings = (searchIndex() as SearchSources["settings"]) || [];
  setState({
    sources: {
      connections: connections || [],
      snippets: snippets || [],
      history: history || [],
      settings,
    },
  });
}

export async function refresh(): Promise<void> {
  if (!state.enabled) return;
  try {
    await load();
    setState({ lastError: null });
  } catch (err) {
    const message = errorText(err);
    setState({ sources: null, lastError: message });
    toast(message, "error");
  }
}

export function openPanel(): void {
  if (!state.enabled) {
    toast("全局搜索已关闭，请在「设置 → 功能开关」中启用", "info");
    return;
  }
  setState({ open: true, query: "" });
  void refresh();
}

export function closePanel(): void {
  setState({ open: false });
}

export function setQuery(query: string): void {
  setState({ query });
}

/** 由 app.ts 在配置变化时调用（启动、保存设置、重置）。 */
export function setEnabledFromConfig(config: unknown): void {
  const flags = auxiliaryFlags(config);
  if (!flags.global_search) {
    setState({ flags, enabled: false, sources: null, query: "", lastError: null });
    return;
  }
  setState({ flags, enabled: true });
}
