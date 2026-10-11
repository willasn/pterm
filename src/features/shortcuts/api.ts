import { pt } from "../../lib/legacy";
import { open as openAi } from "../ai/store";
import { openPicker } from "../connections/store";
import * as terminal from "../terminal/api";
import { close } from "../ssh/api";
import { start } from "../split/store";

/**
 * 快捷键的动作注册表与按键解析（由原 src/legacy/shortcuts.ts 迁移而来）。
 *
 * 绑定表是可编辑的纯数据（config.shortcuts），本模块只做两件事：
 * 1. 按键派发——matches() 判断事件是否命中组合键，命中即调用对应动作；
 *    绑定带 `enabled` 字段，关闭的绑定直接跳过；动作返回 false 表示「本次不接管」，
 *    此时不阻止默认行为，按键照常交给终端（无选中文本的复制即走这条路）。
 * 2. 冲突检测——conflicts() 找出重复组合键、未实现的动作 id 与空缺字段，
 *    供设置界面提示（派发取「首个命中」，重复绑定会让后者变成死键）。
 * Escape 关闭弹窗属于全局交互，仍由 app 处理。
 */

/** 无 UI：由 app 的按键派发、快捷面板与设置面板调用。 */

interface Action {
  label: string;
  hint: string;
  run: () => unknown;
}

/** 取元素（quick_connect 动作聚焦侧栏输入框用）。 */
function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/** action -> { label, hint, run }。只登记前端已实现的动作，其余动作静默忽略。 */
const ACTIONS: Record<string, Action> = {
  "tab.new": {
    label: "新建标签 / 连接",
    hint: "打开连接选择器",
    run: () => openPicker(),
  },
  "tab.close": {
    label: "关闭当前会话",
    hint: "断开并移除当前标签中的会话",
    run: () => {
      const ctrl = terminal.active();
      if (ctrl) close(ctrl.id);
    },
  },
  "tab.next": {
    label: "下一个标签",
    hint: "切换到下一个会话标签",
    run: () => {
      const list = terminal.list();
      if (list.length < 2) return;
      const current = terminal.active();
      const index = current ? list.indexOf(current) : -1;
      terminal.activate(list[(index + 1) % list.length].id);
    },
  },
  "app.settings": {
    label: "打开设置",
    hint: "修改配置与功能开关",
    run: () => pt().settings.open(),
  },
  "app.search": {
    label: "全局搜索",
    hint: "跨连接 / 片段 / 历史 / 设置检索",
    run: () => pt().search.open(),
  },
  "view.split_h": {
    label: "左右分屏",
    hint: "在当前标签内左右并排两个会话",
    run: () => start("h"),
  },
  "view.split_v": {
    label: "上下分屏",
    hint: "在当前标签内上下堆叠两个会话",
    run: () => start("v"),
  },
  "app.quick_connect": {
    label: "快捷连接",
    hint: "聚焦 user@host:port 输入框",
    run: () => {
      const box = byId("quick-input");
      const wrap = byId("quick-connect");
      if (box && wrap && !(wrap as HTMLElement).hidden) box.focus();
    },
  },
  "app.quick_panel": {
    label: "快捷面板",
    hint: "唤出本命令面板（类 Spotlight）",
    run: () => pt().quickPanel.open(),
  },
  "app.ai": {
    label: "AI 助手",
    hint: "打开 AI 助手面板",
    run: () => openAi(),
  },
  "terminal.copy": {
    label: "复制选中内容",
    hint: "把当前终端的选中文本写入剪贴板；无选中时不接管按键",
    run: () => terminal.copySelection(),
  },
  "terminal.paste": {
    label: "粘贴",
    hint: "把剪贴板内容写入当前终端（同样经过危险命令检测）",
    run: () => terminal.pasteClipboard(),
  },
};

const isMac = /mac/i.test(navigator.platform || "") || /mac os x/i.test(navigator.userAgent || "");

let config: any = null;

/** 由 app 在配置变化时调用。 */
export function setEnabledFromConfig(next: any): void {
  config = next;
}

function enabled(): boolean {
  return !!(config && config.features && config.features.auxiliary && config.features.auxiliary.shortcuts);
}

/** 判断事件是否命中 "CmdOrCtrl+Shift+E" 这类组合。 */
export function matches(event: KeyboardEvent, keys: string): boolean {
  if (!keys) return false;
  const parts = String(keys)
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  let ctrl = false;
  let shift = false;
  let alt = false;
  let meta = false;
  let key = "";

  parts.forEach((part) => {
    const lower = part.toLowerCase();
    if (lower === "cmdorctrl" || lower === "mod") {
      if (isMac) meta = true;
      else ctrl = true;
    } else if (lower === "ctrl" || lower === "control") ctrl = true;
    else if (lower === "shift") shift = true;
    else if (lower === "alt" || lower === "option") alt = true;
    else if (lower === "meta" || lower === "cmd" || lower === "command") meta = true;
    else key = part;
  });

  if (!key) return false;
  if (event.ctrlKey !== ctrl) return false;
  if (event.shiftKey !== shift) return false;
  if (event.altKey !== alt) return false;
  if (event.metaKey !== meta) return false;
  return event.key.toLowerCase() === key.toLowerCase();
}

/**
 * 把组合键归一化成可比较的形式：大小写无关、修饰键顺序无关，
 * 并把 CmdOrCtrl 按当前平台解析成 ctrl / meta。无按键部分时返回 ""。
 */
function normalizedKeys(keys: string): string {
  if (!keys) return "";
  const parts = String(keys)
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const mods = new Set<string>();
  let key = "";

  parts.forEach((part) => {
    const lower = part.toLowerCase();
    if (lower === "cmdorctrl" || lower === "mod") {
      mods.add(isMac ? "meta" : "ctrl");
    } else if (lower === "ctrl" || lower === "control") mods.add("ctrl");
    else if (lower === "shift") mods.add("shift");
    else if (lower === "alt" || lower === "option") mods.add("alt");
    else if (lower === "meta" || lower === "cmd" || lower === "command") mods.add("meta");
    else key = lower;
  });

  if (!key) return "";
  return ["ctrl", "shift", "alt", "meta"]
    .filter((mod) => mods.has(mod))
    .concat(key)
    .join("+");
}

/** 查询某个动作当前绑定的组合键（未绑定或已禁用返回空串）。 */
function curKeys(actionId: string): string {
  const bindings = (config && config.shortcuts) || [];
  const hit = bindings.filter(
    (item: any) => item && item.action === actionId && item.enabled !== false
  )[0];
  return (hit && hit.keys) || "";
}

/** 派发一次按键。返回 true 表示已识别并执行（调用方无需再处理）。 */
export function handleKeydown(event: KeyboardEvent): boolean {
  if (!enabled()) return false;
  const bindings = (config && config.shortcuts) || [];
  // 取首个命中：同一组合键绑定多个动作时，只有靠前的那条生效。已禁用的绑定直接跳过，
  // 按键照常落到终端（例如关掉「复制」后 Ctrl+Shift+C 不再被吞掉）。
  const hit = bindings.filter(
    (item: any) => item && item.enabled !== false && matches(event, item.keys)
  )[0];
  if (!hit) return false;
  const action = ACTIONS[hit.action];
  if (!action || typeof action.run !== "function") return false;
  // 动作返回 false = 本次不接管（终端没有选中文本时的复制），不阻止默认行为
  if (action.run() === false) return false;
  event.preventDefault();
  return true;
}

/** 动作注册表快照，供快捷面板列出可执行命令。 */
export function actions(): { id: string; label: string; hint: string; keys: string }[] {
  return Object.keys(ACTIONS).map((id) => ({
    id,
    label: ACTIONS[id].label,
    hint: ACTIONS[id].hint || "",
    keys: curKeys(id),
  }));
}

/** 直接执行某个动作 id（供快捷面板复用，与快捷键派发走同一入口）。 */
export function run(actionId: string): boolean {
  const action = ACTIONS[actionId];
  if (action && typeof action.run === "function") {
    action.run();
    return true;
  }
  return false;
}

/**
 * 冲突检测。返回 `[{ level: "error" | "warn", action, duplicateOf, text }]`：
 * - 重复组合键 → error：派发只取首个命中，后者是死键；
 * - 未实现的动作 id → warn：绑定会保存，但当前不会触发；
 * - 组合键没有可识别的按键 → warn：该绑定不会触发。
 *
 * 已禁用（`enabled === false`）与未绑定（组合键为空）的条目都不参与检测——
 * 前者按键本来就不派发，后者是设置界面里「留空即未绑定」的正常状态。
 * `action` / `duplicateOf` 是动作 id，供调用方换成可读描述展示。
 */
export function conflicts(bindings: any[]): any[] {
  const list = Array.isArray(bindings) ? bindings : [];
  const issues: any[] = [];
  const seen = new Map<string, string>();

  list.forEach((item) => {
    if (!item || item.enabled === false) return;
    const action = (item.action || "").trim();
    const keys = (item.keys || "").trim();
    if (!keys) return;

    if (!action) {
      issues.push({ level: "warn", action: "", text: "缺少动作，保存时会被丢弃。" });
      return;
    }
    if (!ACTIONS[action]) {
      issues.push({ level: "warn", action, text: `动作「${action}」尚未实现，该绑定不会触发。` });
    }

    const normalized = normalizedKeys(keys);
    if (!normalized) {
      issues.push({ level: "warn", action, text: `组合键「${keys}」没有可识别的按键。` });
      return;
    }
    if (seen.has(normalized)) {
      issues.push({
        level: "error",
        action,
        duplicateOf: seen.get(normalized),
        text: `组合键「${keys}」重复，只有靠前的那条生效。`,
      });
      return;
    }
    seen.set(normalized, action);
  });

  return issues;
}
