/* 通用工具。挂载到全局 PShell 命名空间（无打包器，全部走原生 script）。 */
window.PShell = window.PShell || {};

(function (PShell) {
  "use strict";

  /** base64 -> Uint8Array。终端输出走 base64 以规避 JSON 数组膨胀。 */
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /** 按路径读写嵌套对象，如 "features.connection.tabs"。 */
  function getPath(obj, path) {
    return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
  }

  function setPath(obj, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    const target = keys.reduce((acc, key) => {
      if (acc[key] == null || typeof acc[key] !== "object") acc[key] = {};
      return acc[key];
    }, obj);
    target[last] = value;
  }

  function deepClone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
  }

  /** 结构化复制语义：用补丁对象覆盖目标对象的对应字段。 */
  function deepAssign(target, patch) {
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

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (value === undefined || value === null || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "html") node.innerHTML = value;
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === "dataset") {
        Object.entries(value).forEach(([k, v]) => (node.dataset[k] = v));
      } else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, value);
    });
    (children || []).forEach((child) => {
      if (child == null || child === false) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function debounce(fn, wait) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  const ICONS = { ok: "✓", error: "✕", info: "ⓘ" };
  const toastHost = () => $("toast-host");

  /** 轻量提示，自动消失。 */
  function toast(message, kind, timeout) {
    // 出错路径不能因为宿主节点缺失而静默失败，否则界面看起来像「卡死没反应」
    if (!toastHost()) {
      console.warn("[toast]", kind || "info", message);
      return;
    }
    const node = el("div", { class: "toast " + (kind || ""), text: (ICONS[kind] || "") + " " + message });
    toastHost().appendChild(node);
    setTimeout(() => node.remove(), timeout || (kind === "error" ? 6000 : 3000));
  }

  /** 把后端 AppError 转成可读文案。 */
  function errorText(err) {
    if (err == null) return "未知错误";
    if (typeof err === "string") return err;
    if (typeof err === "object") {
      if (typeof err.message === "string" && err.message) return err.message;
      // AppError 的 Serialize 实现会带上 kind
      if (typeof err.kind === "string" && err.detail) return err.detail;
    }
    try {
      return JSON.stringify(err);
    } catch (_) {
      return String(err);
    }
  }

  function confirmDialog(options) {
    return new Promise((resolve) => {
      const mask = $("modal-danger");
      $("danger-cmd").textContent = options.command || "";
      $("danger-reason").textContent = options.reason || "";
      mask.hidden = false;
      $("danger-cancel").focus();
      const done = (value) => {
        mask.hidden = true;
        $("danger-confirm").removeEventListener("click", onOk);
        $("danger-cancel").removeEventListener("click", onCancel);
        document.removeEventListener("keydown", onKey, true);
        mask.removeEventListener("mousedown", onMask);
        resolve(value);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      // 捕获阶段拦下 Escape：弹窗在最上层，不应连带关掉它背后的弹窗
      const onKey = (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        done(false);
      };
      const onMask = (e) => {
        if (e.target === mask) done(false);
      };
      $("danger-confirm").addEventListener("click", onOk);
      $("danger-cancel").addEventListener("click", onCancel);
      document.addEventListener("keydown", onKey, true);
      mask.addEventListener("mousedown", onMask);
    });
  }

  /** 原生确认框兜底：仅当应用内弹窗节点缺失（异常场景）时才用。 */
  async function nativeAsk(message) {
    const dialog = window.__TAURI__ && window.__TAURI__.dialog;
    if (dialog && typeof dialog.ask === "function") {
      try {
        return await dialog.ask(message, { title: "pshell", kind: "warning" });
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

  /**
   * 二次确认（应用内统一弹窗，风格与界面一致）。
   *
   * options 可选项：
   *   title      标题，默认「确认操作」
   *   okText     确认按钮文案，默认「确定」
   *   cancelText 取消按钮文案，默认「取消」
   *   kind       "warn" | "danger" | "info"，决定图标配色；danger 时确认按钮变实心红
   */
  function ask(message, options) {
    const opts = options || {};
    const mask = $("modal-confirm");
    // 节点缺失时不阻塞调用方，退回系统原生确认
    if (!mask) return nativeAsk(message);

    const tr = (key, fallback) =>
      PShell.i18n && PShell.i18n.t ? PShell.i18n.t(key, fallback) : fallback;
    const kind = opts.kind || "warn";
    const icon = $("confirm-icon");
    const okBtn = $("confirm-ok");
    const cancelBtn = $("confirm-cancel");

    if (icon) icon.className = "dialog-icon " + kind;
    $("confirm-title").textContent = opts.title || tr("dialog.title", "确认操作");
    $("confirm-message").textContent = message || "";
    okBtn.textContent = opts.okText || tr("common.ok", "确定");
    cancelBtn.textContent = opts.cancelText || tr("common.cancel", "取消");
    okBtn.className = kind === "danger" ? "btn danger-solid" : "btn primary";

    mask.hidden = false;
    // 危险操作默认聚焦「取消」，避免误按回车直接执行
    (kind === "danger" ? cancelBtn : okBtn).focus();

    return new Promise((resolve) => {
      const done = (value) => {
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
      const onKey = (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        done(false);
      };
      const onMask = (e) => {
        if (e.target === mask) done(false);
      };
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      document.addEventListener("keydown", onKey, true);
      mask.addEventListener("mousedown", onMask);
    });
  }

  /**
   * 单行密码输入弹窗（快捷连接认证失败后补录密码用）。
   *
   * 返回用户输入的密码；取消（按钮 / Escape / 点击遮罩）返回 null。
   * 输入为空时确认无效，避免把空串当成密码提交。
   */
  function promptPassword(message, options) {
    const opts = options || {};
    const mask = $("modal-password");
    // 节点缺失时无法收集输入，按取消处理，交由调用方走原来的失败提示
    if (!mask) return Promise.resolve(null);

    const input = $("password-input");
    const okBtn = $("password-ok");
    const cancelBtn = $("password-cancel");

    $("password-title").textContent = opts.title || "输入密码";
    $("password-message").textContent = message || "";
    $("password-label").textContent = opts.label || "密码";
    okBtn.textContent = opts.okText || "连接";
    cancelBtn.textContent = opts.cancelText || "取消";
    input.value = opts.value || "";
    input.placeholder = opts.placeholder || "";

    mask.hidden = false;
    input.focus();
    input.select();

    return new Promise((resolve) => {
      const done = (value) => {
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
      const onKey = (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        onOk();
      };
      // 捕获阶段拦下 Escape：弹窗在最上层，不应连带关掉它背后的弹窗
      const onEscape = (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        done(null);
      };
      const onMask = (e) => {
        if (e.target === mask) done(null);
      };
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      input.addEventListener("keydown", onKey);
      document.addEventListener("keydown", onEscape, true);
      mask.addEventListener("mousedown", onMask);
    });
  }

  PShell.util = {
    b64ToBytes,
    bytesToB64,
    getPath,
    setPath,
    deepClone,
    deepAssign,
    el,
    $,
    debounce,
    toast,
    errorText,
    confirmDialog,
    ask,
    promptPassword,
  };

  // -------------------------------------------------------------------------
  // 配置表单构建器（设置界面与连接编辑共用）
  //
  // 全部走「控件 ↔ 目标对象」即时双向绑定：用户一改就写回草稿对象，
  // 因此保存时不需要额外的「收集表单」步骤，也不会因为重渲染丢焦点。
  // -------------------------------------------------------------------------

  /** 把控件与 target 上 path 指向的字段绑定。 */
  function bind(node, target, path, transform) {
    const current = getPath(target, path);
    if (node.type === "checkbox") node.checked = !!current;
    else node.value = current == null ? "" : String(current);

    const write = () => {
      let value = node.type === "checkbox" ? node.checked : node.value;
      if (transform && node.type !== "checkbox") value = transform(value);
      setPath(target, path, value);
    };
    node.addEventListener("input", write);
    node.addEventListener("change", write);
    return node;
  }

  /** 数值转换器：解析失败时回退到 fallback，避免写入 NaN / 0。 */
  function toInt(fallback) {
    return (raw) => {
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : fallback;
    };
  }

  function toFloat(fallback) {
    return (raw) => {
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : fallback;
    };
  }

  function input(type, attrs) {
    return el("input", Object.assign({ type: type || "text" }, attrs || {}));
  }

  /** options 支持字符串数组或 `{value, label}` 数组。 */
  function select(options, attrs) {
    const node = el("select", attrs || {});
    (options || []).forEach((opt) => {
      const value = typeof opt === "string" ? opt : opt.value;
      const label = typeof opt === "string" ? opt : opt.label;
      node.appendChild(el("option", { value, text: label }));
    });
    return node;
  }

  function field(label, hint, control, opts) {
    const options = opts || {};
    return el("div", { class: "field" + (options.compact ? " compact" : "") }, [
      el("div", { class: "field-label" }, [
        el("span", { class: "name", text: label }),
        hint ? el("span", { class: "hint", text: hint }) : null,
      ]),
      el("div", { class: "field-control" }, [control]),
    ]);
  }

  /** 一个设置分区：标题 + 说明 + 若干字段。 */
  function section(title, desc, children) {
    const nodes = [el("h3", { text: title })];
    if (desc) nodes.push(el("p", { class: "desc", text: desc }));
    (children || []).filter(Boolean).forEach((child) => nodes.push(child));
    return el("div", { class: "settings-section" }, nodes);
  }

  /**
   * 列表编辑器。直接增删传入的数组（引用语义），调用方持有同一份数据。
   * @param {object} opts
   *   items    待编辑数组
   *   fields   `[{path, label, type, placeholder, width, options, transform}]`
   *   blank    新增条目的工厂函数
   *   addLabel 添加按钮文案
   */
  function listEditor(opts) {
    const items = opts.items || [];
    const fields = opts.fields || [];
    const rowsEl = el("div", { class: "list-editor" });
    const root = el("div", { class: "list-editor" }, [rowsEl]);

    function renderRows() {
      if (!items.length) {
        rowsEl.appendChild(el("p", { class: "inline-note", text: opts.emptyText || "暂无条目。" }));
      }
      const cols = fields.map((f) => f.width || "1fr").join(" ") + " 28px";
      items.forEach((item, index) => {
        const row = el("div", { class: "list-row" });
        row.style.gridTemplateColumns = cols;
        fields.forEach((f) => {
          const type = f.type || "text";
          let control;
          if (type === "textarea") {
            control = el("textarea", { rows: 2, placeholder: f.placeholder || "" });
          } else if (type === "select") {
            control = select(f.options);
          } else if (type === "checkbox") {
            const box = input("checkbox");
            control = el("label", { class: "toggle-row", title: f.label || "" }, [
              box,
              f.label ? el("span", { class: "muted", text: f.label }) : null,
            ]);
            bind(box, item, f.path);
          } else {
            control = input(type, { placeholder: f.placeholder || "" });
          }
          if (type !== "checkbox") bind(control, item, f.path, f.transform);
          // full 字段独占一行，用于提示词这类长文本
          if (f.full) control.style.gridColumn = "1 / -1";
          row.appendChild(control);
        });
        row.appendChild(
          el("button", {
            class: "icon-btn",
            title: "删除该条目",
            text: "✕",
            onclick: () => {
              items.splice(index, 1);
              rebuild();
            },
          })
        );
        rowsEl.appendChild(row);
      });
    }

    function rebuild() {
      rowsEl.textContent = "";
      renderRows();
    }

    renderRows();
    root.appendChild(
      el("button", {
        class: "btn ghost",
        text: opts.addLabel || "添加",
        onclick: () => {
          items.push(opts.blank ? opts.blank() : {});
          rebuild();
        },
      })
    );
    return root;
  }

  PShell.form = {
    bind,
    toInt,
    toFloat,
    input,
    select,
    field,
    section,
    listEditor,
  };
})(window.PShell);