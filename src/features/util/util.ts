/**
 * 通用工具（由原 src/legacy/util.ts 迁移而来）。
 *
 * 分三类：
 * 1. 数据转换：base64 ↔ 字节、嵌套路径读写、深拷贝 / 深合并；
 * 2. DOM 辅助：`el` 建节点、`$` 取节点、`debounce`；
 * 3. 交互反馈：`toast` 轻提示，以及 `confirmDialog` / `ask` / `choose` /
 *    `promptPassword` 四个统一风格的应用内弹窗（操作外壳里的弹窗节点）。
 *
 * 说明：原先同一文件里的 `PTerm.form`（命令式表单构建器）已随设置 / 连接面板迁为
 * React 而失去调用方，此处不再迁移（React 侧见 src/components/form.tsx）。
 */

import { t } from "../i18n/store";

// ---------------------------------------------------------------------------
// 数据转换
// ---------------------------------------------------------------------------

/** base64 -> Uint8Array。终端输出走 base64 以规避 JSON 数组膨胀。 */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** 按路径读写嵌套对象，如 "features.connection.tabs"。 */
export function getPath(obj: any, path: string): any {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export function setPath(obj: any, path: string, value: any): void {
  const keys = path.split(".");
  const last = keys.pop() as string;
  const target = keys.reduce((acc, key) => {
    if (acc[key] == null || typeof acc[key] !== "object") acc[key] = {};
    return acc[key];
  }, obj);
  target[last] = value;
}

export function deepClone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** 结构化复制语义：用补丁对象覆盖目标对象的对应字段。 */
export function deepAssign(target: any, patch: any): any {
  if (patch == null || typeof patch !== "object") return patch;
  Object.keys(patch).forEach((key) => {
    const value = patch[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (target[key] == null || typeof target[key] !== "object") target[key] = {};
      deepAssign(target[key], value);
    } else {
      target[key] = Array.isArray(value) ? deepClone(value) : value;
    }
  });
  return target;
}

// ---------------------------------------------------------------------------
// DOM 辅助
// ---------------------------------------------------------------------------

export function el(
  tag: string,
  attrs?: Record<string, any> | null,
  children?: (Node | string | null | false | undefined)[] | null
): HTMLElement {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === false) return;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "dataset") {
      Object.entries(value).forEach(([k, v]) => (node.dataset[k] = v as string));
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  });
  (children || []).forEach((child) => {
    if (child == null || child === false) return;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  });
  return node;
}

export function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function debounce<F extends (...args: any[]) => void>(fn: F, wait: number): F {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return function (this: any, ...args: any[]) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  } as F;
}

// ---------------------------------------------------------------------------
// 轻提示
// ---------------------------------------------------------------------------

const ICONS: Record<string, string> = { ok: "✓", error: "✕", info: "ⓘ" };
const toastHost = () => $("toast-host");

/** 轻量提示，自动消失。 */
export function toast(message: string, kind?: string, timeout?: number): void {
  // 出错路径不能因为宿主节点缺失而静默失败，否则界面看起来像「卡死没反应」
  const host = toastHost();
  if (!host) {
    console.warn("[toast]", kind || "info", message);
    return;
  }
  const node = el("div", { class: "toast " + (kind || ""), text: (ICONS[kind || ""] || "") + " " + message });
  host.appendChild(node);
  setTimeout(() => node.remove(), timeout || (kind === "error" ? 6000 : 3000));
}

/** 把后端 AppError 转成可读文案。 */
export function errorText(err: unknown): string {
  if (err == null) return "未知错误";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const e = err as { message?: unknown; kind?: unknown; detail?: unknown };
    if (typeof e.message === "string" && e.message) return e.message;
    // AppError 的 Serialize 实现会带上 kind
    if (typeof e.kind === "string" && e.detail) return String(e.detail);
  }
  try {
    return JSON.stringify(err);
  } catch (_) {
    return String(err);
  }
}

// ---------------------------------------------------------------------------
// 应用内弹窗（操作外壳里的对应节点）
// ---------------------------------------------------------------------------

/** 危险命令确认弹窗（Agent 用）。确认返回 true，取消 / Escape / 点遮罩返回 false。 */
export function confirmDialog(options: { command?: string; reason?: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const mask = $("modal-danger") as HTMLElement;
    ($("danger-cmd") as HTMLElement).textContent = options.command || "";
    ($("danger-reason") as HTMLElement).textContent = options.reason || "";
    mask.hidden = false;
    ($("danger-cancel") as HTMLElement).focus();
    const done = (value: boolean) => {
      mask.hidden = true;
      ($("danger-confirm") as HTMLElement).removeEventListener("click", onOk);
      ($("danger-cancel") as HTMLElement).removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey, true);
      mask.removeEventListener("mousedown", onMask);
      resolve(value);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    // 捕获阶段拦下 Escape：弹窗在最上层，不应连带关掉它背后的弹窗
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      done(false);
    };
    const onMask = (e: MouseEvent) => {
      if (e.target === mask) done(false);
    };
    ($("danger-confirm") as HTMLElement).addEventListener("click", onOk);
    ($("danger-cancel") as HTMLElement).addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey, true);
    mask.addEventListener("mousedown", onMask);
  });
}

/** 原生确认框兜底：仅当应用内弹窗节点缺失（异常场景）时才用。 */
async function nativeAsk(message: string): Promise<boolean> {
  const dialog = (window as any).__TAURI__ && (window as any).__TAURI__.dialog;
  if (dialog && typeof dialog.ask === "function") {
    try {
      return await dialog.ask(message, { title: "pterm", kind: "warning" });
    } catch (_) {
      /* 落到下面的兜底 */
    }
  }
  try {
    return window.confirm(message);
  } catch (_) {
    return false;
  }
}

export interface AskOptions {
  /** 标题，默认「确认操作」 */
  title?: string;
  /** 确认按钮文案，默认「确定」 */
  okText?: string;
  /** 取消按钮文案，默认「取消」 */
  cancelText?: string;
  /** 决定图标配色；danger 时确认按钮变实心红 */
  kind?: "warn" | "danger" | "info";
}

/**
 * 二次确认（应用内统一弹窗，风格与界面一致）。
 */
export function ask(message: string, options?: AskOptions): Promise<boolean> {
  const opts = options || {};
  const mask = $("modal-confirm");
  // 节点缺失时不阻塞调用方，退回系统原生确认
  if (!mask) return nativeAsk(message);

  const kind = opts.kind || "warn";
  const icon = $("confirm-icon");
  const okBtn = $("confirm-ok") as HTMLElement;
  const cancelBtn = $("confirm-cancel") as HTMLElement;

  if (icon) icon.className = "dialog-icon " + kind;
  ($("confirm-title") as HTMLElement).textContent = opts.title || tr("dialog.title", "确认操作");
  ($("confirm-message") as HTMLElement).textContent = message || "";
  okBtn.textContent = opts.okText || tr("common.ok", "确定");
  cancelBtn.textContent = opts.cancelText || tr("common.cancel", "取消");
  okBtn.className = kind === "danger" ? "btn danger-solid" : "btn primary";

  mask.hidden = false;
  // 危险操作默认聚焦「取消」，避免误按回车直接执行
  (kind === "danger" ? cancelBtn : okBtn).focus();

  return new Promise((resolve) => {
    const done = (value: boolean) => {
      mask.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey, true);
      mask.removeEventListener("mousedown", onMask);
      resolve(value);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    // 捕获阶段拦下 Escape：弹窗在最上层，不应连带关掉它背后的弹窗
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      done(false);
    };
    const onMask = (e: MouseEvent) => {
      if (e.target === mask) done(false);
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey, true);
    mask.addEventListener("mousedown", onMask);
  });
}

export interface ChooseOption {
  value: any;
  label: string;
  desc?: string;
  /** 按钮样式（primary / ghost） */
  kind?: string;
}

export interface ChooseOptions {
  /** 标题，默认「请选择」 */
  title?: string;
  /** 说明文字 */
  message?: string;
  /** 待选方案，逐条渲染为按钮 */
  options?: ChooseOption[];
  /** 取消按钮文案，默认「取消」 */
  cancelText?: string;
}

/**
 * 多选一弹窗：从若干方案中挑一个，逐条渲染为按钮。
 * 返回被选中项的 value；取消（按钮 / Escape / 点击遮罩）返回 null。
 */
export function choose(options: ChooseOptions): Promise<any> {
  const opts = options || {};
  const mask = $("modal-choose") as HTMLElement;
  // 节点缺失时无法收集选择，按取消处理
  if (!mask) return Promise.resolve(null);

  const body = $("choose-body") as HTMLElement;
  const cancelBtn = $("choose-cancel") as HTMLElement;

  ($("choose-title") as HTMLElement).textContent = opts.title || tr("dialog.choose", "请选择");
  ($("choose-message") as HTMLElement).textContent = opts.message || "";
  cancelBtn.textContent = opts.cancelText || tr("common.cancel", "取消");

  body.textContent = "";
  mask.hidden = false;

  return new Promise((resolve) => {
    const done = (value: any) => {
      mask.hidden = true;
      body.textContent = "";
      cancelBtn.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey, true);
      mask.removeEventListener("mousedown", onMask);
      resolve(value);
    };
    const onCancel = () => done(null);
    // 捕获阶段拦下 Escape：弹窗在最上层，不应连带关掉它背后的弹窗
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      done(null);
    };
    const onMask = (e: MouseEvent) => {
      if (e.target === mask) done(null);
    };

    (opts.options || []).forEach((item) => {
      body.appendChild(
        el(
          "button",
          {
            class: "btn " + (item.kind || "ghost") + " choose-option",
            type: "button",
            onclick: () => done(item.value),
          },
          [
            el("span", { class: "choose-option-label", text: item.label }),
            item.desc ? el("span", { class: "choose-option-desc", text: item.desc }) : null,
          ]
        )
      );
    });

    cancelBtn.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey, true);
    mask.addEventListener("mousedown", onMask);
    // 聚焦首个选项，键盘回车即可选中
    const first = body.querySelector("button") as HTMLElement | null;
    if (first) first.focus();
  });
}

export interface PromptPasswordOptions {
  title?: string;
  label?: string;
  okText?: string;
  cancelText?: string;
  value?: string;
  placeholder?: string;
}

/**
 * 单行密码输入弹窗（快捷连接认证失败后补录密码用）。
 * 返回用户输入的密码；取消（按钮 / Escape / 点击遮罩）返回 null。
 * 输入为空时确认无效，避免把空串当成密码提交。
 */
export function promptPassword(message: string, options?: PromptPasswordOptions): Promise<string | null> {
  const opts = options || {};
  const mask = $("modal-password") as HTMLElement;
  // 节点缺失时无法收集输入，按取消处理，交由调用方走原来的失败提示
  if (!mask) return Promise.resolve(null);

  const input = $("password-input") as HTMLInputElement;
  const okBtn = $("password-ok") as HTMLElement;
  const cancelBtn = $("password-cancel") as HTMLElement;

  ($("password-title") as HTMLElement).textContent = opts.title || "输入密码";
  ($("password-message") as HTMLElement).textContent = message || "";
  ($("password-label") as HTMLElement).textContent = opts.label || "密码";
  okBtn.textContent = opts.okText || "连接";
  cancelBtn.textContent = opts.cancelText || "取消";
  input.value = opts.value || "";
  input.placeholder = opts.placeholder || "";

  mask.hidden = false;
  input.focus();
  input.select();

  return new Promise((resolve) => {
    const done = (value: string | null) => {
      mask.hidden = true;
      input.value = "";
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", onEscape, true);
      mask.removeEventListener("mousedown", onMask);
      resolve(value);
    };
    const onOk = () => {
      if (!input.value) {
        input.focus();
        return;
      }
      done(input.value);
    };
    const onCancel = () => done(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      onOk();
    };
    // 捕获阶段拦下 Escape：弹窗在最上层，不应连带关掉它背后的弹窗
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      done(null);
    };
    const onMask = (e: MouseEvent) => {
      if (e.target === mask) done(null);
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    input.addEventListener("keydown", onKey);
    document.addEventListener("keydown", onEscape, true);
    mask.addEventListener("mousedown", onMask);
  });
}

/** 取翻译。 */
function tr(key: string, fallback: string): string {
  return t(key, fallback);
}
