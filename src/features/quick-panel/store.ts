import { useSyncExternalStore } from "react";
import { auxiliaryFlags, toast } from "../../lib/legacy";
import { actions, run } from "../shortcuts/api";
import type { QuickAction } from "./types";

/**
 * 快捷命令面板的状态与行为（由原 src/legacy/quick_panel.ts 迁移而来）。
 *
 * 一个类 Spotlight 的动作命令面板：由快捷键 app.quick_panel 唤起，
 * 列出「前端已实现的动作」，本地过滤后回车 / 点击即执行。
 *
 * 与全局搜索的区别：搜索跨数据源模糊检索（连接 / 片段 / 历史 / 设置），
 * 这里只列「动作」本身。动作注册表来自 legacy shortcuts 的 actions()，因此
 * 面板会自动覆盖所有已实现的快捷键动作，包括它们当前绑定的组合键。
 */

export interface QuickPanelState {
  enabled: boolean;
  query: string;
  /** 当前动作列表；每次打开时从 shortcuts 重新拉取，保证与快捷键联动。 */
  items: QuickAction[];
  open: boolean;
}

const initialState: QuickPanelState = {
  enabled: false,
  query: "",
  items: [],
  open: false,
};

let state: QuickPanelState = initialState;
const listeners = new Set<() => void>();

function setState(patch: Partial<QuickPanelState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): QuickPanelState {
  return state;
}

export function useQuickPanel(): QuickPanelState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/** 按关键词过滤：空格分隔的词需全部命中 id / label / hint 之一。 */
export function filteredActions(): QuickAction[] {
  const terms = String(state.query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return state.items;
  return state.items.filter((item) => {
    const hay = [item.id, item.label, item.hint].join(" ").toLowerCase();
    return terms.every((term) => hay.indexOf(term) >= 0);
  });
}

export function setQuery(query: string): void {
  setState({ query });
}

/** 执行动作：与快捷键派发走同一入口（legacy shortcuts.run）。 */
export function runAction(actionId: string): void {
  run(actionId);
}

export function closePanel(): void {
  setState({ open: false });
}

export function openPanel(): void {
  if (!state.enabled) {
    toast("快捷面板已关闭，请在「设置 → 功能开关」中启用", "info");
    return;
  }
  // 拉取最新的动作注册表，保证与快捷键联动
  const items = actions() as QuickAction[];
  setState({ items, open: true, query: "" });
}

/** 由 app.ts 在配置变化时调用。 */
export function setEnabledFromConfig(config: unknown): void {
  setState({ enabled: !!auxiliaryFlags(config).quick_panel });
}
