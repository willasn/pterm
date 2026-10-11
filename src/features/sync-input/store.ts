import { useSyncExternalStore } from "react";
import { toast } from "../../lib/legacy";
import * as tabs from "../tabs/store";

/**
 * 同步输入（由原 src/legacy/sync_input.ts 迁移而来）：只在一台终端输入，把按键同步广播到同一同步组内的其它标签。
 *
 * 同步以「标签」为单位（分屏时一个标签含多个会话，整组一起同步）。
 * 每个组各有一个同步开关：关闭时只着色标识分组，开启后组内才互相广播，
 * 并给成员标签加上高亮。标签的着色、高亮、序号徽标与聚拢排序由 tabs 模块呈现，
 * 本模块只维护分组状态、计算广播目标，并在加入组后驱动标签重排（当前标签落到组的最右侧）。
 */

/** 分组配色：同一组同色，不同组按创建顺序取不同色。 */
const PALETTE = [
  "#e5a84b",
  "#4b9fe5",
  "#7bc86c",
  "#c07be0",
  "#e56b6b",
  "#3fbfb0",
  "#d98cc4",
  "#8a8ae5",
];

interface Group {
  id: string;
  index: number;
  color: string;
  /** 该组的「同步输入」开关：关闭时只着色，开启后组内广播。 */
  active: boolean;
  tabs: Set<string>;
}

let config: any = null;
/** 组序号自增，用作 id 与展示编号 */
let seq = 0;
const groups = new Map<string, Group>();

// ---------------------------------------------------------------------------
// 基础状态
// ---------------------------------------------------------------------------

/** 功能开关是否启用（config.yaml 的 features.connection.sync_input）。 */
export function enabled(): boolean {
  const conn = (config && config.features && config.features.connection) || {};
  return conn.sync_input !== false;
}

/** 标签是否仍存在（关掉的标签会从 tabs 里移除）。 */
function tabExists(tabId: string): boolean {
  return !!tabs.byId(tabId);
}

function orderIds(): string[] {
  return tabs.orderIds();
}

/** 组内仍存活的标签，按标签栏顺序返回。 */
function liveTabs(group: Group): string[] {
  return orderIds().filter((id) => group.tabs.has(id) && tabExists(id));
}

export function groupOfTab(tabId: string): Group | null {
  let found: Group | null = null;
  groups.forEach((group) => {
    if (!found && group.tabs.has(tabId)) found = group;
  });
  return found;
}

export function list(): Group[] {
  return Array.from(groups.values()).sort((a, b) => a.index - b.index);
}

/** 丢弃已不存在标签的成员；组内无成员时连同组一起删除。 */
function prune(): void {
  groups.forEach((group) => {
    Array.from(group.tabs).forEach((id) => {
      if (!tabExists(id)) group.tabs.delete(id);
    });
  });
  groups.forEach((group, id) => {
    if (!group.tabs.size) groups.delete(id);
  });
}

// ---------------------------------------------------------------------------
// 广播目标
// ---------------------------------------------------------------------------

/**
 * 计算某个会话的同步目标会话 id 列表。
 * - 功能关闭：只有自己。
 * - 在该标签所属的同步组且该组「同步输入」已开启：组内所有标签的全部会话。
 * - 否则：只有自己。
 */
export function targetsFor(sessionId: string): string[] {
  if (!enabled() || !sessionId) return sessionId ? [sessionId] : [];

  const tab = tabs.groupOf(sessionId);
  const group = tab ? groupOfTab(tab.id) : null;
  if (!group || !group.active) return [sessionId];

  const ids: string[] = [];
  liveTabs(group).forEach((tabId) => {
    const target = tabs.byId(tabId);
    (target ? target.memberIds : []).forEach((id: string) => ids.push(id));
  });
  return ids.length ? ids : [sessionId];
}

// ---------------------------------------------------------------------------
// 分组操作
// ---------------------------------------------------------------------------

/** 把若干标签并入指定组：先退出各自的旧组，再加入新组，最后重排。 */
export function join(groupId: string, tabIds: string[], currentTabId: string): void {
  const group = groups.get(groupId);
  if (!group) return;
  tabIds.forEach((id) => {
    const other = groupOfTab(id);
    if (other && other !== group) other.tabs.delete(id);
    group.tabs.add(id);
  });
  prune();
  arrange(group.id, currentTabId);
  const count = liveTabs(group).length;
  toast(
    group.active
      ? `已加入同步组 ${group.index}（${count} 个标签，同步输入已开启）`
      : `已加入同步组 ${group.index}（${count} 个标签，可在右键菜单开启同步输入）`,
    "info"
  );
}

/** 新建一个组并把目标标签加入。syncActive 决定建组时是否即开启组内同步。 */
function createGroup(tabIds: string[], currentTabId: string, syncActive?: boolean): void {
  seq += 1;
  const id = "sg" + seq;
  const group: Group = {
    id,
    index: seq,
    color: PALETTE[(seq - 1) % PALETTE.length],
    active: !!syncActive,
    tabs: new Set(),
  };
  groups.set(id, group);
  join(id, tabIds, currentTabId);
}

/** 把标签移出它所在的组（组空则删除）。 */
export function leave(tabId: string): void {
  const group = groupOfTab(tabId);
  if (!group) return;
  group.tabs.delete(tabId);
  groups.forEach((item, id) => {
    if (!item.tabs.size) groups.delete(id);
  });
  tabs.render();
}

/** 解散全部同步组：清空所有标签的组标记与配色。 */
export function clearAll(): void {
  if (!groups.size) return;
  groups.clear();
  tabs.render();
  toast("已移除全部同步组", "info");
}

export function hasGroups(): boolean {
  return groups.size > 0;
}

/**
 * 切换当前标签所在组的「同步输入」开关。
 * 标签尚未分组时，直接以它新建一个已开启同步的组。
 */
export function toggleSync(tabId: string): void {
  if (!enabled()) {
    toast("同步输入已在设置中关闭", "info");
    return;
  }
  const group = groupOfTab(tabId);
  if (!group) {
    // join 内部会给出提示
    createGroup([tabId], tabId, true);
    return;
  }
  group.active = !group.active;
  tabs.render();
  toast(
    group.active
      ? `同步组 ${group.index} 已开启：组内输入会互相广播`
      : `同步组 ${group.index} 已关闭组内同步输入`,
    "info"
  );
}

/**
 * 组内标签聚拢到一起，且当前标签落到组的最右侧。
 * 其余成员保持原有相对顺序；块整体挪到原第一个成员所在的位置。
 */
function arrange(groupId: string, currentTabId: string): void {
  const group = groups.get(groupId);
  if (!group) return;
  const all = orderIds();
  const members = all.filter((id) => group.tabs.has(id));
  if (!members.length || members.length === 1) {
    tabs.render();
    return;
  }
  const firstIndex = all.findIndex((id) => group.tabs.has(id));
  const rest = all.filter((id) => !group.tabs.has(id));
  const block = members.filter((id) => id !== currentTabId);
  if (currentTabId && members.indexOf(currentTabId) !== -1) block.push(currentTabId);
  // 块的目标插入位置 = 原第一个成员之前、非成员标签的数量
  const before = all.slice(0, firstIndex).filter((id) => !group.tabs.has(id)).length;
  const next = rest.slice(0, before).concat(block, rest.slice(before));
  tabs.setOrder(next);
}

/** 标签关闭时清理它的组成员关系。 */
export function onTabGone(tabId: string): boolean {
  let changed = false;
  groups.forEach((group, id) => {
    if (group.tabs.delete(tabId)) changed = true;
    if (!group.tabs.size) {
      groups.delete(id);
      changed = true;
    }
  });
  return changed;
}

/** 分屏被取消、一个标签拆成多个标签时，新标签继承原标签的组成员关系。 */
export function onTabsFromSplit(originalTabId: string, newTabIds: string[]): void {
  const group = groupOfTab(originalTabId);
  if (!group) return;
  (newTabIds || []).forEach((id) => group.tabs.add(id));
}

/** 供 tabs 渲染：标签所属组的颜色、序号与同步开关；不在组里返回 null。 */
export function styleFor(tabId: string): { color: string; index: number; active: boolean } | null {
  if (!enabled()) return null;
  const group = groupOfTab(tabId);
  if (!group) return null;
  return { color: group.color, index: group.index, active: group.active };
}

// ---------------------------------------------------------------------------
// 选组弹框
// ---------------------------------------------------------------------------

export interface PickerRow {
  id: string;
  index: number;
  color: string;
  active: boolean;
  liveCount: number;
}

export interface PickerState {
  open: boolean;
  tabIds: string[];
  currentTabId: string;
  title: string;
  rows: PickerRow[];
  /** 目标标签当前全在同一组时，额外提供「移出组」入口。 */
  common: { index: number } | null;
}

const initialPicker: PickerState = {
  open: false,
  tabIds: [],
  currentTabId: "",
  title: "",
  rows: [],
  common: null,
};

let picker: PickerState = initialPicker;
const listeners = new Set<() => void>();

function setPicker(patch: Partial<PickerState>): void {
  picker = { ...picker, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPicker(): PickerState {
  return picker;
}

export function useSyncInputPicker(): PickerState {
  return useSyncExternalStore(subscribe, getPicker, getPicker);
}

export function closePicker(): void {
  if (!picker.open) return;
  setPicker({ open: false, tabIds: [], rows: [], common: null });
}

/**
 * 打开选组弹框：把 tabIds 加入已有组或新建组。
 * @param tabIds 待加入的标签（全部添加到组时是全部标签）
 * @param currentTabId 当前右击的标签，加入后落到组的最右侧
 */
export function pick(tabIds: string[], currentTabId: string): void {
  if (!enabled()) {
    toast("同步输入已在设置中关闭", "info");
    return;
  }
  prune();
  const ids = (tabIds || []).filter((id) => tabExists(id));
  if (!ids.length) return;
  closePicker();

  const currentOnly = ids.length === 1 && ids[0] === currentTabId;
  const title = currentOnly ? "添加当前标签到同步组" : `添加全部 ${ids.length} 个标签到同步组`;

  const rows: PickerRow[] = list().map((group) => ({
    id: group.id,
    index: group.index,
    color: group.color,
    active: group.active,
    liveCount: liveTabs(group).length,
  }));

  // 目标标签当前全在同一组时，额外提供「移出组」入口
  let common: Group | null = groupOfTab(ids[0]) || null;
  for (let i = 1; common && i < ids.length; i++) {
    if (groupOfTab(ids[i]) !== common) common = null;
  }

  setPicker({
    open: true,
    tabIds: ids,
    currentTabId,
    title,
    rows,
    common: common ? { index: common.index } : null,
  });
}

/** 选中已有组。 */
export function chooseGroup(groupId: string): void {
  const { tabIds, currentTabId } = picker;
  closePicker();
  join(groupId, tabIds, currentTabId);
}

/** 新建组（建组时不开组内同步）。 */
export function chooseCreate(): void {
  const { tabIds, currentTabId } = picker;
  closePicker();
  createGroup(tabIds, currentTabId);
}

/** 把目标标签移出它们共同的组。 */
export function chooseLeave(): void {
  const { tabIds } = picker;
  closePicker();
  tabIds.forEach((id) => leave(id));
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

export function setEnabledFromConfig(next: any): void {
  config = next;
  if (!enabled()) {
    // 功能被关掉：清空状态，让标签恢复原样（广播在 targetsFor 里已被门控）
    groups.clear();
    tabs.render();
  }
}
