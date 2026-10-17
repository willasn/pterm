import { useSyncExternalStore } from "react";
import { auxiliaryFlags, errorText, toast } from "../../lib/legacy";
import { active } from "../terminal/api";
import { ipc } from "../ipc/api";
import { write } from "../ssh/api";
import { ask } from "../util/util";
import type { Snippet, SnippetDraft, SnippetsView } from "./types";

/**
 * 命令片段的状态与行为（由原 src/legacy/snippets.ts 迁移而来）。
 *
 * 之所以用模块级 store 而非组件内 state：既有模块（app / search / connections / tabs）
 * 仍以命令式 API（PTerm.snippets.open / setConfig / refresh）驱动这个面板，
 * store 对外暴露同样的入口，React 组件只负责订阅与渲染。
 */
export interface SnippetsState {
  enabled: boolean;
  busy: boolean;
  snippets: Snippet[];
  view: SnippetsView;
  selectedId: string | null;
  draft: SnippetDraft | null;
  values: Record<string, string>;
  preview: string;
  lastError: string | null;
  /** 列表筛选关键词（仅前端过滤，不落库）。 */
  query: string;
  open: boolean;
}

const blankDraft = (): SnippetDraft => ({
  id: "",
  name: "",
  description: "",
  content: "",
  group_name: "",
  variables: [],
  updated_at: "",
});

const initialState: SnippetsState = {
  enabled: false,
  busy: false,
  snippets: [],
  view: "list",
  selectedId: null,
  draft: null,
  values: {},
  preview: "",
  lastError: null,
  query: "",
  open: false,
};

let state: SnippetsState = initialState;
const listeners = new Set<() => void>();

function setState(patch: Partial<SnippetsState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): SnippetsState {
  return state;
}

/** 组件订阅入口。 */
export function useSnippets(): SnippetsState {
  return useSyncExternalStore(subscribe, getState, getState);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** 回到片段库（放弃未保存的改动）。 */
function resetEditing(): Partial<SnippetsState> {
  return { view: "list", selectedId: null, draft: null, values: {}, preview: "", lastError: null };
}

// ---------------------------------------------------------------------------
// 派生数据
// ---------------------------------------------------------------------------

/** 按关键词过滤：名称、分组、说明、内容任一命中即可。 */
export function filteredSnippets(): Snippet[] {
  const q = state.query.trim().toLowerCase();
  if (!q) return state.snippets;
  return state.snippets.filter((s) => {
    const hay = [s.name, s.group_name, s.description, s.content]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    return hay.indexOf(q) >= 0;
  });
}

/** 分组名去重，保持后端返回的排序（未分组在最前）。 */
export function groupNames(list: Snippet[]): string[] {
  const seen: string[] = [];
  list.forEach((s) => {
    const group = s.group_name || "";
    if (seen.indexOf(group) < 0) seen.push(group);
  });
  return seen;
}

// ---------------------------------------------------------------------------
// 预览渲染（带 200ms 防抖，避免逐字输入时频繁请求后端）
// ---------------------------------------------------------------------------

let previewSeq = 0;
let previewTimer: ReturnType<typeof setTimeout> | null = null;

async function renderPreview(): Promise<void> {
  const draft = state.draft;
  if (!draft) return;
  const seq = ++previewSeq;
  let text = draft.content || "";
  try {
    text = await ipc.snippetRender(draft.content || "", state.values);
  } catch {
    /* 渲染失败时回落到原文 */
  }
  if (seq !== previewSeq) return;
  setState({ preview: text });
}

function schedulePreview(): void {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = null;
    void renderPreview();
  }, 200);
}

// ---------------------------------------------------------------------------
// 行为
// ---------------------------------------------------------------------------

/** 由 app.ts 在配置变化时调用（启动、保存设置、重置）。 */
export function setEnabledFromConfig(config: unknown): void {
  const enabled = !!auxiliaryFlags(config).snippets;
  if (!enabled) {
    setState({ enabled: false, busy: false, snippets: [], query: "", ...resetEditing() });
    return;
  }
  setState({ enabled: true });
  void refresh();
}

export async function refresh(): Promise<void> {
  if (!state.enabled) {
    setState({ snippets: [], query: "", ...resetEditing() });
    return;
  }
  let list: Snippet[] = [];
  try {
    list = ((await ipc.snippetList()) || []) as Snippet[];
  } catch (err) {
    if (state.open) toast(errorText(err), "error");
  }
  setState({ snippets: list });
}

export function openPanel(): void {
  if (!state.enabled) {
    toast("命令片段已关闭，请在「设置 → 功能开关」中启用", "info");
    return;
  }
  // 有未完成的草稿时直接回到编辑视图，避免重新打开后丢失未保存的内容
  setState({ open: true, query: "", view: state.draft ? "edit" : "list" });
  void refresh().then(() => {
    if (state.draft) void renderPreview();
  });
}

export function closePanel(): void {
  setState({ open: false });
}

export function selectSnippet(id: string): void {
  const hit = state.snippets.filter((s) => s.id === id)[0] || null;
  if (!hit) return;
  setState({
    view: "edit",
    selectedId: id,
    draft: clone(hit),
    values: {},
    preview: hit.content,
    lastError: null,
  });
  void renderPreview();
}

export function startNew(): void {
  setState({
    view: "edit",
    selectedId: null,
    draft: blankDraft(),
    values: {},
    preview: "",
    lastError: null,
  });
}

export function backToList(): void {
  setState(resetEditing());
}

export function setQuery(query: string): void {
  setState({ query });
}

export function setDraftField<K extends keyof SnippetDraft>(field: K, value: SnippetDraft[K]): void {
  if (!state.draft) return;
  setState({ draft: { ...state.draft, [field]: value } });
}

export function setValue(name: string, value: string): void {
  setState({ values: { ...state.values, [name]: value } });
  schedulePreview();
}

export async function save(): Promise<void> {
  const draft = state.draft;
  if (state.busy || !draft) return;
  if (!String(draft.content || "").trim()) {
    setState({ lastError: "片段内容不能为空" });
    return;
  }
  setState({ busy: true });
  try {
    const saved = (await ipc.snippetSave({
      id: draft.id || "",
      name: draft.name || "",
      description: draft.description || "",
      content: draft.content || "",
      variables: draft.variables || [],
      group_name: draft.group_name || null,
      updated_at: "",
    })) as Snippet;
    setState({
      selectedId: saved.id,
      draft: saved,
      values: {},
      preview: saved.content,
      lastError: null,
      busy: false,
    });
    toast("片段已保存", "ok");
    await refresh();
    await renderPreview();
  } catch (err) {
    const message = errorText(err);
    setState({ lastError: message, busy: false });
    toast(message, "error");
  }
}

export async function remove(): Promise<void> {
  const draft = state.draft;
  if (state.busy || !draft || !draft.id) return;
  const confirmed = await ask(`删除片段「${draft.name || "未命名片段"}」？此操作不可撤销。`, {
    title: "删除确认",
    okText: "删除",
    kind: "danger",
  });
  if (!confirmed) return;
  setState({ busy: true });
  try {
    await ipc.snippetDelete(draft.id);
    setState({ busy: false, ...resetEditing() });
    toast("片段已删除", "ok");
    await refresh();
  } catch (err) {
    setState({ busy: false });
    toast(errorText(err), "error");
  }
}

export async function insert(): Promise<void> {
  const ctrl = active();
  if (!ctrl) {
    toast("当前没有打开的会话", "error");
    return;
  }
  const draft = state.draft;
  if (!draft || !draft.id) {
    toast("请先保存片段", "error");
    return;
  }
  try {
    const text = await ipc.snippetRender(draft.content || "", state.values);
    await write(ctrl.id, text);
    toast("已插入到终端", "ok");
    closePanel();
  } catch (err) {
    toast(errorText(err), "error");
  }
}
