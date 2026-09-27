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
      const done = (value) => {
        mask.hidden = true;
        $("danger-confirm").removeEventListener("click", onOk);
        $("danger-cancel").removeEventListener("click", onCancel);
        document.removeEventListener("keydown", onKey);
        resolve(value);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      const onKey = (e) => {
        if (e.key === "Escape") done(false);
      };
      $("danger-confirm").addEventListener("click", onOk);
      $("danger-cancel").addEventListener("click", onCancel);
      document.addEventListener("keydown", onKey);
    });
  }

  /** 二次确认。优先用原生对话框，退回 WebView 的 confirm，都失败时按「取消」处理。 */
  async function ask(message) {
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