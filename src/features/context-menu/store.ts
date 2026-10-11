import { useSyncExternalStore } from "react";

/**
 * 通用右键菜单（由原 src/legacy/context_menu.ts 迁移而来）。
 *
 * 两个职责：
 * 1. suppressNative()：全局拦截 WebView 的原生右键菜单（重载 / 后退 / 检查元素等与
 *    业务无关的项），但在 input / textarea / contenteditable 上放行，保住输入框自带的
 *    复制 / 粘贴。
 * 2. openMenu(x, y, items)：在光标处弹出一个业务菜单，单实例、越界自动收边，点外部 /
 *    Esc / 滚动即关闭。
 *
 * 条目形状：`{ label, icon?, danger?, disabled?, run }`，或分隔符 `{ sep: true }`。
 */

export interface MenuItem {
  label?: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  run?: () => void;
  sep?: boolean;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

let current: MenuState | null = null;

// ---------------------------------------------------------------------------
// 响应式外壳（版本号驱动重绘）
// ---------------------------------------------------------------------------

let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMenuVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

export function getMenu(): MenuState | null {
  return current;
}

/** 在 (x, y) 弹出一个业务菜单；单实例，已打开的先关掉。 */
export function openMenu(x: number, y: number, items: MenuItem[]): void {
  const entries = (items || []).filter(Boolean);
  if (!entries.length) return;
  current = { x, y, items: entries };
  bump();
}

export function closeMenu(): void {
  if (!current) return;
  current = null;
  bump();
}

// ---------------------------------------------------------------------------
// 原生菜单抑制
// ---------------------------------------------------------------------------

let nativeSuppressed = false;

/** 输入类控件保留原生菜单：否则用户会失去「粘贴 / 全选」等系统能力。
 *  xterm 内部的隐藏输入框不算——终端区域右击应当完全无菜单。 */
function isEditable(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node || typeof node.tagName !== "string") return false;
  if (typeof node.closest === "function" && node.closest(".xterm")) return false;
  const tag = node.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || node.isContentEditable === true;
}

/** 全局抑制原生右键菜单。幂等：重复调用只注册一次（原实现约定「只调用一次，由 app 执行」）。 */
export function suppressNative(): void {
  if (nativeSuppressed) return;
  nativeSuppressed = true;
  document.addEventListener("contextmenu", (event) => {
    if (isEditable(event.target)) return;
    event.preventDefault();
  });
}
