/* SFTP 文件面板（FEATURES.md §3 连接与传输）。
 *
 * 只在 features.connection.sftp 打开时可用：关闭时侧栏入口隐藏、面板不加载，
 * 后端 command 也会以 ModuleDisabled 拒绝。
 * SFTP 为每个连接持有一条独立的 SSH 连接（后端决定），因此面板必须先选一个
 * 已保存的连接建立会话，再浏览远端目录；全程经 Tauri command，本地文件读写
 * 由 Rust 侧完成，前端只负责取路径。 */
(function (PShell) {
  "use strict";

  const { el, $, toast, errorText, ask } = PShell.util;
  const { field, section } = PShell.form;

  let enabled = false;
  let busy = false;
  let connections = [];
  let sessions = [];
  let pendingConn = null;
  let currentId = null;
  let listing = null;
  let editing = null;
  let lastError = null;

  function syncFlags(config) {
    return (config && config.features && config.features.connection) || {};
  }

  function isOpen() {
    const mask = $("modal-sftp");
    return !!mask && !mask.hidden;
  }

  function dialogApi() {
    return (window.__TAURI__ && window.__TAURI__.dialog) || null;
  }

  // -------------------------------------------------------------------------
  // 路径与显示工具
  // -------------------------------------------------------------------------

  function humanSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function baseName(path) {
    const raw = String(path || "").replace(/[\\/]+$/, "");
    const parts = raw.split(/[\\/]/);
    return parts[parts.length - 1] || raw;
  }

  function parentOf(path) {
    const raw = String(path || "").replace(/\/+$/, "");
    if (!raw || raw === "/") return "/";
    const index = raw.lastIndexOf("/");
    if (index <= 0) return "/";
    return raw.slice(0, index);
  }

  function joinPath(dir, name) {
    const target = String(name || "");
    if (target.charAt(0) === "/") return target;
    const base = String(dir || "/").replace(/\/+$/, "") || "/";
    return base === "/" ? "/" + target : base + "/" + target;
  }

  function modeText(mode) {
    return (Number(mode) & 0o7777).toString(8).padStart(3, "0");
  }

  function parseMode(text) {
    const raw = String(text || "").trim();
    if (!/^[0-7]{3,4}$/.test(raw)) return null;
    return parseInt(raw, 8);
  }

  /** Unix 秒 → "YYYY-MM-DD HH:MM"。 */
  function timeText(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n <= 0) return "—";
    const date = new Date(n * 1000);
    if (Number.isNaN(date.getTime())) return "—";
    const pad = (v) => String(v).padStart(2, "0");
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}`
    );
  }

  function currentSession() {
    return sessions.filter((s) => s.id === currentId)[0] || null;
  }

  function homeOf(id) {
    const found = sessions.filter((s) => s.id === id)[0];
    return found ? found.home : "";
  }

  // -------------------------------------------------------------------------
  // 侧栏状态徽标
  // -------------------------------------------------------------------------

  function badgeText() {
    if (!enabled) return "SFTP";
    if (!sessions.length) return "SFTP 未连接";
    const current = currentSession();
    return "SFTP " + sessions.length + (current ? " · " + (current.name || current.host) : "");
  }

  function renderBadge() {
    const node = $("sftp-status");
    if (!node) return;
    if (!enabled) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    node.textContent = badgeText();
  }

  // -------------------------------------------------------------------------
  // 面板
  // -------------------------------------------------------------------------

  function note(text, kind) {
    return el("p", { class: "inline-note " + (kind || ""), text });
  }

  function info(label, value) {
    return field(label, null, el("span", { class: "muted", text: value }));
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
      class: "sftp-act " + (kind || ""),
      type: "button",
      text: label,
      disabled: busy,
      onclick,
    });
  }

  function connectionSection() {
    const nodes = [];
    if (sessions.length) {
      const picker = el("select", {
        class: "sftp-picker",
        onchange: (event) => selectSession(event.target.value),
      });
      sessions.forEach((s) => {
        picker.appendChild(
          el("option", {
            value: s.id,
            text: `${s.name || s.host} · ${s.username}@${s.host}:${s.port}`,
          })
        );
      });
      picker.value = currentId || "";
      nodes.push(field("当前连接", null, picker));
      const current = currentSession();
      if (current) nodes.push(info("家目录", current.home));
      nodes.push(
        el("div", { class: "sftp-actions" }, [
          button(
            "刷新目录",
            () => loadListing(listing ? listing.path : homeOf(currentId)),
            "ghost"
          ),
          button("断开连接", disconnect, "danger"),
        ])
      );
      return section("连接", `SFTP 使用独立连接，当前共 ${sessions.length} 个。`, nodes);
    }

    if (connections.length) {
      const picker = el("select", {
        class: "sftp-picker",
        onchange: (event) => {
          pendingConn = event.target.value;
        },
      });
      connections.forEach((c) => {
        picker.appendChild(
          el("option", {
            value: c.id,
            text: `${c.name || c.host} · ${c.username}@${c.host}:${c.port}`,
          })
        );
      });
      picker.value = pickerSelection();
      nodes.push(
        el("div", { class: "sftp-actions" }, [
          picker,
          button("建立 SFTP 连接", () => connect(picker.value), "primary"),
        ])
      );
    } else {
      nodes.push(note("还没有保存的连接，请先在侧栏新建连接。"));
    }
    return section(null, null, nodes);
  }

  function pickerSelection() {
    if (pendingConn && connections.some((c) => c.id === pendingConn)) return pendingConn;
    pendingConn = connections.length ? connections[0].id : null;
    return pendingConn || "";
  }

  function editorSection() {
    const { kind, entry } = editing;
    const isRename = kind === "rename";
    const box = el("input", {
      type: "text",
      class: "sftp-editor-input",
      value: editing.value || "",
      spellcheck: "false",
      oninput: (event) => {
        // 只更新草稿，不重渲染，避免丢焦点
        editing.value = event.target.value;
      },
      onkeydown: (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        submitEditor();
      },
    });
    const hint = isRename
      ? "输入新名称；含 / 时按当前目录下的相对路径处理，可借此移动条目。"
      : "3~4 位八进制权限位，例如 644（文件）、755（目录或可执行文件）。";
    return section(isRename ? "重命名" : "修改权限", `${entry.name} · ${hint}`, [
      field(isRename ? "新名称" : "权限位", null, box),
      el("div", { class: "sftp-actions" }, [
        button("确定", submitEditor, "primary"),
        button(
          "取消",
          () => {
            editing = null;
            renderBody();
          },
          "ghost"
        ),
      ]),
    ]);
  }

  function itemNode(entry) {
    const label =
      entry.name + (entry.is_dir ? "/" : "") + (entry.is_symlink ? " ↗" : "");
    const nameNode = el("span", {
      class: "sftp-name" + (entry.is_dir ? " dir" : ""),
      title: entry.path,
      text: label,
    });
    if (entry.is_dir) {
      nameNode.addEventListener("click", () => navigate(entry.path));
    }
    return el("div", { class: "sftp-item" }, [
      nameNode,
      el("span", {
        class: "sftp-size",
        text: entry.is_dir ? "—" : humanSize(entry.size),
      }),
      el("span", { class: "sftp-mode", text: modeText(entry.mode) }),
      el("span", { class: "sftp-time", text: timeText(entry.modified) }),
      el("span", { class: "sftp-acts" }, [
        entry.is_dir ? null : actNode("下载", () => download(entry)),
        actNode("重命名", () => startEdit("rename", entry)),
        actNode("权限", () => startEdit("chmod", entry)),
        actNode("删除", () => remove(entry), "danger"),
      ]),
    ]);
  }

  function filesSection() {
    const nodes = [];
    const here = listing ? listing.path : "";
    const pathInput = el("input", {
      type: "text",
      class: "sftp-path",
      value: here,
      spellcheck: "false",
      placeholder: "/var/log",
      onkeydown: (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        navigate(pathInput.value.trim());
      },
    });
    nodes.push(
      el("div", { class: "sftp-toolbar" }, [
        el("button", {
          class: "btn ghost",
          type: "button",
          text: "↑ 上级",
          disabled: busy || !listing || listing.path === "/",
          onclick: () => navigate(parentOf(listing.path)),
        }),
        pathInput,
        button("转到", () => navigate(pathInput.value.trim()), "ghost"),
        button("刷新", () => loadListing(listing ? listing.path : ""), "ghost"),
        button("上传…", upload, "primary"),
      ])
    );
    if (lastError) nodes.push(note(lastError, "error"));

    const entries = listing ? listing.entries : [];
    if (!listing) {
      nodes.push(note("选择一个目录以浏览远端文件。"));
    } else if (!entries.length) {
      nodes.push(note("该目录为空。"));
    } else {
      nodes.push(
        el("div", { class: "sftp-head" }, [
          el("span", { text: "名称" }),
          el("span", { text: "大小" }),
          el("span", { text: "权限" }),
          el("span", { text: "修改时间" }),
          el("span", { text: "操作" }),
        ])
      );
      nodes.push(el("div", { class: "sftp-list" }, entries.map(itemNode)));
    }
    return section(
      "文件",
      listing ? `共 ${entries.length} 个条目` : null,
      nodes
    );
  }

  function renderBody() {
    const host = $("sftp-body");
    if (!host) return;
    const hint = $("sftp-hint");
    if (hint) {
      const current = currentSession();
      hint.textContent = current
        ? `${current.username}@${current.host}:${current.port} · ${listing ? listing.path : current.home}`
        : "";
    }

    host.textContent = "";
    if (!enabled) {
      host.appendChild(
        note("SFTP 已关闭。请在「设置 → 功能开关」中打开「SFTP」。")
      );
      return;
    }

    host.appendChild(connectionSection());
    if (editing) host.appendChild(editorSection());
    if (currentId && listing) host.appendChild(filesSection());
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
    pickerSelection();
  }

  async function loadListing(path) {
    if (!enabled || !currentId) return;
    try {
      listing = await PShell.ipc.sftpList(currentId, path || "");
      lastError = null;
    } catch (err) {
      lastError = errorText(err);
    }
    editing = null;
    renderBadge();
    if (isOpen()) renderBody();
  }

  async function refresh() {
    if (!enabled) {
      sessions = [];
      currentId = null;
      listing = null;
      editing = null;
      lastError = null;
      renderBadge();
      if (isOpen()) renderBody();
      return;
    }
    try {
      sessions = (await PShell.ipc.sftpSessions()) || [];
      lastError = null;
    } catch (err) {
      sessions = [];
      lastError = errorText(err);
    }
    if (currentId && !sessions.some((s) => s.id === currentId)) {
      currentId = null;
      listing = null;
      editing = null;
    }
    if (!currentId && sessions.length) {
      currentId = sessions[0].id;
      listing = null;
      editing = null;
    }
    renderBadge();
    if (currentId && !listing) {
      await loadListing(homeOf(currentId));
      return;
    }
    if (isOpen()) renderBody();
  }

  async function navigate(path) {
    if (!path || !currentId) return;
    await loadListing(path);
  }

  async function selectSession(id) {
    currentId = id;
    listing = null;
    editing = null;
    lastError = null;
    renderBody();
    await loadListing(homeOf(id));
  }

  async function run(label, fn) {
    if (busy) return;
    busy = true;
    renderBody();
    const here = listing ? listing.path : null;
    try {
      const outcome = await fn();
      const detail =
        typeof outcome === "number" && outcome > 0
          ? `，共 ${humanSize(outcome)}`
          : "";
      toast(label + "完成" + detail, "ok");
      editing = null;
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      busy = false;
      const keep = currentId;
      await refresh();
      if (keep && here && currentId === keep) await loadListing(here);
    }
  }

  async function connect(id) {
    const conn = connections.filter((c) => c.id === id)[0];
    if (!conn || busy) return;
    busy = true;
    pendingConn = conn.id;
    renderBody();
    try {
      const info = await PShell.ipc.sftpConnect(PShell.connections.paramsFor(conn));
      currentId = info.id;
      listing = null;
      editing = null;
      toast(`已建立 SFTP 连接 ${info.username}@${info.host}`, "ok");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function disconnect() {
    if (!currentId || busy) return;
    const current = currentSession();
    const target = current ? `${current.username}@${current.host}` : "";
    const confirmed = await ask(`关闭 SFTP 连接${target ? "：" + target : ""}？`);
    if (!confirmed) return;
    const id = currentId;
    busy = true;
    renderBody();
    try {
      await PShell.ipc.sftpDisconnect(id);
      toast("已关闭 SFTP 连接", "ok");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      busy = false;
      currentId = null;
      listing = null;
      editing = null;
      await refresh();
    }
  }

  function startEdit(kind, entry) {
    editing = {
      kind,
      entry,
      value: kind === "rename" ? entry.name : modeText(entry.mode),
    };
    renderBody();
    const box = document.querySelector("#sftp-body .sftp-editor-input");
    if (box) {
      box.focus();
      box.select();
    }
  }

  async function submitEditor() {
    if (!editing) return;
    const { kind, entry } = editing;
    const raw = String(editing.value == null ? "" : editing.value).trim();
    if (kind === "rename") {
      if (!raw) {
        toast("新名称不能为空", "error");
        return;
      }
      const target = raw.charAt(0) === "/" ? raw : joinPath(parentOf(entry.path), raw);
      if (target === entry.path) {
        editing = null;
        renderBody();
        return;
      }
      run(`重命名 ${entry.name}`, () =>
        PShell.ipc.sftpRename(currentId, entry.path, target)
      );
      return;
    }
    const mode = parseMode(raw);
    if (mode == null) {
      toast("权限需为 3~4 位八进制数字，例如 644 或 755", "error");
      return;
    }
    run(`修改 ${entry.name} 权限`, () =>
      PShell.ipc.sftpChmod(currentId, entry.path, mode)
    );
  }

  async function download(entry) {
    const dialog = dialogApi();
    if (!dialog || typeof dialog.save !== "function") {
      toast("当前环境不支持文件保存对话框", "error");
      return;
    }
    let local = null;
    try {
      local = await dialog.save({ title: "下载到", defaultPath: entry.name });
    } catch (err) {
      toast(errorText(err), "error");
      return;
    }
    if (!local) return;
    run(`下载 ${entry.name}`, () =>
      PShell.ipc.sftpDownload(currentId, entry.path, local)
    );
  }

  async function upload() {
    const dialog = dialogApi();
    if (!dialog || typeof dialog.open !== "function") {
      toast("当前环境不支持文件选择对话框", "error");
      return;
    }
    let picked = null;
    try {
      picked = await dialog.open({
        title: "选择要上传的文件",
        multiple: false,
        directory: false,
      });
    } catch (err) {
      toast(errorText(err), "error");
      return;
    }
    const local = Array.isArray(picked) ? picked[0] : picked;
    if (!local) return;
    const remote = joinPath(listing ? listing.path : "/", baseName(local));
    run(`上传 ${baseName(local)}`, () =>
      PShell.ipc.sftpUpload(currentId, local, remote)
    );
  }

  async function remove(entry) {
    const kind = entry.is_dir ? "目录" : "文件";
    const extra = entry.is_dir ? "（只能删除空目录）" : "";
    const confirmed = await ask(`删除${kind}「${entry.name}」${extra}？此操作不可撤销。`);
    if (!confirmed) return;
    run(`删除 ${entry.name}`, () => PShell.ipc.sftpDelete(currentId, entry.path));
  }

  async function open() {
    if (!enabled) {
      toast("SFTP 已关闭，请在「设置 → 功能开关」中启用", "info");
      return;
    }
    const mask = $("modal-sftp");
    if (!mask || isOpen()) return;
    mask.hidden = false;
    renderBody();
    await loadConnections();
    const stale = listing ? listing.path : null;
    await refresh();
    if (currentId && stale) await loadListing(stale);
  }

  /** 由 app.js 在配置变化时调用（启动、保存设置、重置）。 */
  function setConfig(config) {
    enabled = !!syncFlags(config).sftp;
    renderBadge();
    if (enabled) {
      refresh();
      return;
    }
    sessions = [];
    connections = [];
    pendingConn = null;
    currentId = null;
    listing = null;
    editing = null;
    lastError = null;
    renderBadge();
    if (isOpen()) renderBody();
  }

  const badgeNode = $("sftp-status");
  if (badgeNode) badgeNode.addEventListener("click", open);

  PShell.sftp = { setConfig, open, refresh };
})(window.PShell);