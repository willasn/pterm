/* 连接导入导出面板（FEATURES.md §3 连接与传输）。
 *
 * 只在 features.connection.import_export 打开时可用：关闭时侧栏入口隐藏、
 * 面板不加载，后端 command 也会以 ModuleDisabled 拒绝。
 * 导出**永不包含凭据**：密码 / passphrase 只在加密保险库里，导出结构里没有这些字段；
 * 导入一律新建连接（重新分配 id、不覆盖已有配置），支持 pshell 导出文件与
 * OpenSSH 的 ~/.ssh/config。文件读写全部在 Rust 侧完成，前端只负责取路径。 */
(function (PShell) {
  "use strict";

  const { el, $, toast, errorText } = PShell.util;
  const { field, section } = PShell.form;

  const FORMATS = [
    { value: "auto", label: "自动识别" },
    { value: "pshell", label: "pshell 导出文件" },
    { value: "ssh_config", label: "OpenSSH 配置（ssh config）" },
  ];

  let enabled = false;
  let busy = false;
  let connections = [];
  let selected = null; // null 表示全选
  let defaults = null;
  let format = "auto";
  let importPath = "";
  let report = null;
  let lastError = null;

  function syncFlags(config) {
    return (config && config.features && config.features.connection) || {};
  }

  function isOpen() {
    const mask = $("modal-import-export");
    return !!mask && !mask.hidden;
  }

  function dialogApi() {
    return (window.__TAURI__ && window.__TAURI__.dialog) || null;
  }

  function homeDir() {
    return (defaults && defaults.home_dir) || "";
  }

  function sshConfigPath() {
    return (defaults && defaults.ssh_config_path) || "";
  }

  function joinPath(dir, name) {
    const base = String(dir || "").replace(/[\\/]+$/, "");
    if (!base) return name;
    const sep = base.indexOf("\\") >= 0 && base.indexOf("/") < 0 ? "\\" : "/";
    return base + sep + name;
  }

  function baseName(path) {
    const parts = String(path || "").split(/[\\/]/);
    return parts[parts.length - 1] || String(path || "");
  }

  function formatLabel(value) {
    const hit = FORMATS.filter((f) => f.value === value)[0];
    return hit ? hit.label : String(value || "");
  }

  function note(text, kind) {
    return el("p", { class: "inline-note " + (kind || ""), text });
  }

  function button(label, onclick, kind) {
    return el("button", {
      class: "btn " + (kind || "ghost"),
      type: "button",
      text: label,
      disabled: busy,
      onclick,
    });
  }

  function actNode(label, onclick, kind) {
    return el("button", {
      class: "ie-act " + (kind || ""),
      type: "button",
      text: label,
      disabled: busy,
      onclick,
    });
  }

  // -------------------------------------------------------------------------
  // 选择集
  // -------------------------------------------------------------------------

  /** 真正参与导出的连接 id。null 表示全选。 */
  function selectedIds() {
    if (!selected) return connections.map((c) => c.id);
    return connections.map((c) => c.id).filter((id) => selected.has(id));
  }

  function isChecked(id) {
    return !selected || selected.has(id);
  }

  function toggle(id, on) {
    if (!selected) selected = new Set(connections.map((c) => c.id));
    if (on) selected.add(id);
    else selected.delete(id);
    if (selected.size === connections.length) selected = null;
  }

  // -------------------------------------------------------------------------
  // 侧栏状态徽标
  // -------------------------------------------------------------------------

  function renderBadge() {
    const node = $("ie-status");
    if (!node) return;
    if (!enabled) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    node.textContent = "导入导出";
  }

  // -------------------------------------------------------------------------
  // 面板
  // -------------------------------------------------------------------------

  function connectionPicker() {
    if (!connections.length) {
      return note("还没有保存的连接，请先在侧栏新建连接。");
    }
    const ids = selectedIds();
    const count = ids.length;
    const rows = connections.map((c) => {
      const box = el("input", { type: "checkbox" });
      box.checked = isChecked(c.id);
      box.addEventListener("change", () => {
        toggle(c.id, box.checked);
        renderBody();
      });
      return el("label", { class: "ie-row", title: `${c.host}:${c.port}` }, [
        box,
        el("span", { class: "ie-name", text: c.name || c.host }),
        el("span", {
          class: "ie-addr",
          text: `${c.username || "—"}@${c.host}:${c.port}`,
        }),
      ]);
    });

    const nodes = [
      el("div", { class: "ie-toolbar" }, [
        el("span", { class: "muted", text: `已选 ${count} / ${connections.length} 个连接` }),
        el("span", { class: "spacer" }),
        actNode("全选", () => {
          selected = null;
          renderBody();
        }),
        actNode("全不选", () => {
          selected = new Set();
          renderBody();
        }),
      ]),
      el("div", { class: "ie-list" }, rows),
      el("div", { class: "ie-actions" }, [
        button("导出为 JSON…", exportTo, "primary"),
      ]),
    ];
    return section(
      "导出",
      "导出文件只含主机、端口、用户名、认证方式等非敏感字段，不含任何密码或 passphrase。",
      nodes
    );
  }

  function importForm() {
    const picker = el("select", {
      class: "ie-picker",
      onchange: (event) => {
        format = event.target.value;
      },
    });
    FORMATS.forEach((f) => {
      picker.appendChild(el("option", { value: f.value, text: f.label }));
    });
    picker.value = format;

    const pathInput = el("input", {
      type: "text",
      class: "ie-path",
      value: importPath,
      spellcheck: "false",
      placeholder: sshConfigPath() || "选择要导入的文件",
    });
    // 只更新草稿，不重渲染，避免输入过程中丢焦点
    pathInput.addEventListener("input", () => {
      importPath = pathInput.value;
    });

    const nodes = [
      field("来源格式", "不确定时保持自动识别", picker),
      field("文件", null, pathInput),
      el("div", { class: "ie-toolbar" }, [
        actNode("选择文件…", pickFile),
        actNode("使用 ssh config", () => {
          importPath = sshConfigPath();
          renderBody();
        }),
      ]),
      note("导入一律新建连接，不覆盖已有配置；重复条目会被跳过，凭据需要导入后重新填写。"),
      el("div", { class: "ie-actions" }, [button("导入", runImport, "primary")]),
    ];

    if (lastError) nodes.push(note(lastError, "error"));
    if (report) nodes.push(reportNode());
    return section(
      "导入",
      `支持 pshell 导出文件与 OpenSSH 配置（默认位置 ${sshConfigPath() || "~/.ssh/config"}）。`,
      nodes
    );
  }

  function reportNode() {
    const nodes = [
      el("p", { class: "inline-note ok", text: `格式：${formatLabel(report.format)}` }),
      el("p", {
        class: "inline-note",
        text: `新建 ${report.imported} 个，跳过 ${report.skipped} 个。`,
      }),
    ];
    if (report.connections && report.connections.length) {
      nodes.push(
        el(
          "div",
          { class: "ie-list" },
          report.connections.map((c) =>
            el("div", { class: "ie-row" }, [
              el("span", { class: "ie-name", text: c.name || c.host }),
              el("span", { class: "ie-addr", text: `${c.username || "—"}@${c.host}:${c.port}` }),
            ])
          )
        )
      );
    }
    (report.warnings || []).forEach((text) => nodes.push(note(text, "warn")));
    return el("div", { class: "ie-report" }, nodes);
  }

  function renderBody() {
    const host = $("ie-body");
    if (!host) return;
    const hint = $("ie-hint");
    if (hint) {
      hint.textContent = enabled ? `已保存 ${connections.length} 个连接` : "";
    }

    host.textContent = "";
    if (!enabled) {
      host.appendChild(
        note("配置导入导出已关闭。请在「设置 → 功能开关」中打开「配置导入导出」。")
      );
      return;
    }
    host.appendChild(connectionPicker());
    host.appendChild(importForm());
  }

  // -------------------------------------------------------------------------
  // 行为
  // -------------------------------------------------------------------------

  async function loadConnections() {
    try {
      connections = (await PShell.ipc.listConnections()) || [];
    } catch (_) {
      connections = [];
    }
    selected = null;
  }

  async function loadDefaults() {
    try {
      defaults = await PShell.ipc.importExportDefaults();
    } catch (_) {
      defaults = null;
    }
    if (!importPath) importPath = sshConfigPath();
  }

  async function refresh() {
    if (!enabled) {
      connections = [];
      selected = null;
      importPath = "";
      report = null;
      lastError = null;
      renderBadge();
      if (isOpen()) renderBody();
      return;
    }
    await loadConnections();
    renderBadge();
    if (isOpen()) renderBody();
  }

  async function pickSavePath() {
    const dialog = dialogApi();
    if (!dialog || typeof dialog.save !== "function") {
      toast("当前环境不支持文件保存对话框", "error");
      return null;
    }
    try {
      return await dialog.save({
        title: "导出连接配置",
        defaultPath: joinPath(homeDir(), "pshell-connections.json"),
      });
    } catch (err) {
      toast(errorText(err), "error");
      return null;
    }
  }

  async function exportTo() {
    if (busy) return;
    const ids = selectedIds();
    if (!ids.length) {
      toast("请至少选择一个连接", "error");
      return;
    }
    const target = await pickSavePath();
    if (!target) return;
    busy = true;
    renderBody();
    try {
      const info = await PShell.ipc.connectionExport(target, ids);
      toast(`已导出 ${info.count} 个连接到 ${baseName(info.path)}`, "ok");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function pickFile() {
    const dialog = dialogApi();
    if (!dialog || typeof dialog.open !== "function") {
      toast("当前环境不支持文件选择对话框", "error");
      return;
    }
    let picked = null;
    try {
      picked = await dialog.open({
        title: "选择要导入的文件",
        multiple: false,
        directory: false,
        defaultPath: importPath || sshConfigPath(),
      });
    } catch (err) {
      toast(errorText(err), "error");
      return;
    }
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    importPath = path;
    report = null;
    renderBody();
  }

  async function runImport() {
    if (busy) return;
    const path = String(importPath || "").trim();
    if (!path) {
      toast("请先选择要导入的文件", "error");
      return;
    }
    busy = true;
    renderBody();
    try {
      report = await PShell.ipc.connectionImport(path, format);
      lastError = null;
      const detail = report.skipped ? `，跳过 ${report.skipped} 个重复` : "";
      toast(`导入完成：新建 ${report.imported} 个连接${detail}`, "ok");
      if (report.imported > 0) await PShell.connections.refresh();
    } catch (err) {
      report = null;
      lastError = errorText(err);
      toast(lastError, "error");
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function open() {
    if (!enabled) {
      toast("配置导入导出已关闭，请在「设置 → 功能开关」中启用", "info");
      return;
    }
    const mask = $("modal-import-export");
    if (!mask || isOpen()) return;
    mask.hidden = false;
    report = null;
    lastError = null;
    renderBody();
    await loadDefaults();
    await refresh();
  }

  /** 由 app.js 在配置变化时调用（启动、保存设置、重置）。 */
  function setConfig(config) {
    enabled = !!syncFlags(config).import_export;
    if (!enabled) {
      connections = [];
      selected = null;
      importPath = "";
      report = null;
      lastError = null;
      renderBadge();
      if (isOpen()) renderBody();
      return;
    }
    renderBadge();
    refresh();
  }

  const badgeNode = $("ie-status");
  if (badgeNode) badgeNode.addEventListener("click", open);

  PShell.importExport = { setConfig, open, refresh };
})(window.PShell);