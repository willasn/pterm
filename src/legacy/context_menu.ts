/* 通用右键菜单。
 *
 * 两个职责：
 * 1. suppressNative()：全局拦截 WebView 的原生右键菜单（重载 / 后退 / 检查元素等与业务无关的项），
 *    但在 input / textarea / contenteditable 上放行，保住输入框自带的复制 / 粘贴。
 * 2. open(x, y, items)：在光标处弹出一个业务菜单，单实例、越界自动收边，点外部 / Esc / 滚动即关闭。
 *
 * items 元素形状：`{ label, icon?, danger?, disabled?, run }`，或分隔符 `{ sep: true }`。 */
(function (PShell) {
  "use strict";

  const { el } = PShell.util;

  let node = null;

  /** 输入类控件保留原生菜单：否则用户会失去「粘贴 / 全选」等系统能力。
   *  xterm 内部的隐藏输入框不算——终端区域右击应当完全无菜单。 */
  function isEditable(target) {
    if (!target || typeof target.tagName !== "string") return false;
    if (typeof target.closest === "function" && target.closest(".xterm")) return false;
    const tag = target.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable === true;
  }

  function onDocDown(event) {
    if (node && node.contains(event.target)) return;
    close();
  }

  function onDocKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  function close() {
    if (!node) return;
    node.remove();
    node = null;
    document.removeEventListener("mousedown", onDocDown, true);
    document.removeEventListener("keydown", onDocKey, true);
    document.removeEventListener("scroll", close, true);
    window.removeEventListener("blur", close);
    window.removeEventListener("resize", close);
  }

  function open(x, y, items) {
    close();
    const entries = (items || []).filter(Boolean);
    if (!entries.length) return;

    const menu = el("div", { class: "ctx-menu", role: "menu" });
    entries.forEach((item) => {
      if (item.sep) {
        menu.appendChild(el("div", { class: "ctx-sep" }));
        return;
      }
      const row = el(
        "div",
        {
          class: "ctx-item" + (item.danger ? " danger" : "") + (item.disabled ? " disabled" : ""),
          role: "menuitem",
        },
        [
          el("span", { class: "ico", text: item.icon || "" }),
          el("span", { class: "label", text: item.label || "" }),
        ]
      );
      if (!item.disabled && typeof item.run === "function") {
        row.addEventListener("click", () => {
          close();
          item.run();
        });
      }
      menu.appendChild(row);
    });

    // 先插入 DOM 量尺寸，再按视口边界收边，避免贴边时被裁掉
    menu.style.left = "0px";
    menu.style.top = "0px";
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const pad = 8;
    const left = Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad));
    const top = Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad));
    menu.style.left = left + "px";
    menu.style.top = top + "px";

    node = menu;
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onDocKey, true);
    document.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
  }

  /** 全局抑制原生右键菜单。只调用一次，由 app.js 在绑定时执行。 */
  function suppressNative() {
    document.addEventListener("contextmenu", (event) => {
      if (isEditable(event.target)) return;
      event.preventDefault();
    });
  }

  PShell.menu = { open, close, suppressNative };
})(window.PShell);