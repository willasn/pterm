/* SFTP 文件面板（FEATURES.md §3 连接与传输）。
 *
 * 只在 features.connection.sftp 打开时可用：关闭时侧栏入口隐藏、面板不加载，
 * 后端 command 也会以 ModuleDisabled 拒绝。
 * SFTP 为每个连接持有一条独立的 SSH 连接（后端决定），因此面板必须先选一个
 * 已保存的连接建立会话，再浏览远端目录；全程经 Tauri command，本地文件读写
 * 由 Rust 侧完成，前端只负责取路径。
 *
 * 传输（上传/下载）在后端按块上报进度，前端据此渲染右下角进度条，并可中断。 */
(function (PShell) {
  "use strict";

  const { el, $, toast, errorText, ask } = PShell.util;
  const { field, section } = PShell.form;

  /** 传输进度事件名，与后端 commands.rs 的 EVENT_SFTP_PROGRESS 保持一致。 */
  const TRANSFER_EVENT = "sftp:progress";
  /** 建立连接过场的最短展示时长：太快会让动画像闪一下，反而更突兀。 */
  const MIN_CONNECT_MS = 650;

  let enabled = false;
  let busy = false;
  let connections = [];
  let sessions = [];
  let pendingConn = null;
  let currentId = null;
  let listing = null;
  let editing = null;
  let lastError = null;

  // 传输队列。后端会话是独占的（同一时刻只有一条 SFTP 通道），所以前端串行
  // 执行：只有队首在跑，其余显示「等待中」，避免多条进度条同时 0% 造成困惑。
  let transfers = [];
  let transferSeq = 0;
  let pumping = false;
  const transferNodes = new Map();

  let connecting = false;
  let dropVisible = false;
  let transferEventsBound = false;
  let dragBound = false;

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

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  /** 秒 → "m:ss" / "h:mm:ss"，用于已用时间与剩余时间。 */
  function fmtDuration(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (v) => String(v).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
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

  /** 本地路径拼接：只用于把目录选择结果与条目名拼起来，Rust 侧两种分隔符都能读。 */
  function joinLocal(dir, name) {
    const base = String(dir || "").replace(/[\\/]+$/, "");
    return base ? base + "/" + name : String(name || "");
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

  function box(className, children) {
    return el("div", { class: "settings-section" + (className ? " " + className : "") }, children);
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

  /** 已连接：一行「当前连接 + 下拉 + 断开」，无标题与说明（需求精简）。 */
  function sessionSection() {
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
    return box("sftp-conn", [
      el("div", { class: "sftp-conn-row" }, [
        el("span", { class: "sftp-conn-label", text: "当前连接" }),
        picker,
        el("span", { class: "spacer" }),
        button("断开连接", disconnect, "danger"),
      ]),
    ]);
  }

  /** 未连接：选一个已保存连接建立 SFTP 会话。 */
  function connectSection() {
    const nodes = [];
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
    return box("", nodes);
  }

  function pickerSelection() {
    if (pendingConn && connections.some((c) => c.id === pendingConn)) return pendingConn;
    pendingConn = connections.length ? connections[0].id : null;
    return pendingConn || "";
  }

  function editorSection() {
    const { kind, entry } = editing;
    const isRename = kind === "rename";
    const boxInput = el("input", {
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
      field(isRename ? "新名称" : "权限位", null, boxInput),
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
        actNode("下载", () => download(entry)),
        actNode("重命名", () => startEdit("rename", entry)),
        actNode("权限", () => startEdit("chmod", entry)),
        actNode("删除", () => remove(entry), "danger"),
      ]),
    ]);
  }

  function toolbar(pathInput) {
    const up = el("button", {
      class: "btn ghost",
      type: "button",
      text: "↑ 上级",
      disabled: busy || !listing || listing.path === "/",
      onclick: () => navigate(parentOf(listing.path)),
    });
    return el("div", { class: "sftp-toolbar" }, [
      up,
      pathInput,
      button("家目录", () => navigate(homeOf(currentId)), "ghost"),
      button("转到", () => navigate(pathInput.value.trim()), "ghost"),
      button("刷新", () => loadListing(listing ? listing.path : ""), "ghost"),
      button("上传", uploadFiles, "primary"),
      button("上传文件夹", uploadFolder, "ghost"),
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
    nodes.push(toolbar(pathInput));

    const entries = listing ? listing.entries : [];
    nodes.push(
      el("div", { class: "sftp-count", text: `共 ${entries.length} 个条目` })
    );
    if (lastError) nodes.push(note(lastError, "error"));

    if (!entries.length) {
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
    return box("sftp-files", nodes);
  }

  /** 未连接时窗口按内容自适应；有会话（或正在建立）时才撑成固定高度，避免切换目录时高度抖动。 */
  function syncSize() {
    const mask = $("modal-sftp");
    const modal = mask && mask.querySelector(".modal.sftp");
    if (!modal) return;
    modal.classList.toggle("expanded", !!(enabled && (sessions.length || connecting)));
  }

  function renderBody() {
    syncSize();
    const host = $("sftp-body");
    if (!host) return;
    host.textContent = "";
    if (!enabled) {
      host.appendChild(note("SFTP 已关闭。请在「设置 → 功能开关」中打开「SFTP」。"));
      return;
    }

    host.appendChild(sessions.length ? sessionSection() : connectSection());
    if (editing) host.appendChild(editorSection());
    if (currentId && listing) {
      host.appendChild(filesSection());
    } else if (currentId) {
      host.appendChild(box("sftp-files", [note("正在载入目录…")]));
    }
  }

  // -------------------------------------------------------------------------
  // 建立连接的过场动画
  // -------------------------------------------------------------------------

  function showConnecting(text) {
    const node = $("sftp-connecting");
    if (!node) return;
    const label = $("sftp-connecting-text");
    if (label) label.textContent = text;
    node.hidden = false;
  }

  function hideConnecting() {
    const node = $("sftp-connecting");
    if (node) node.hidden = true;
  }

  // -------------------------------------------------------------------------
  // 拖拽上传（本地 → 远端当前目录）
  // -------------------------------------------------------------------------

  /** Tauri 的 webview 拖拽接口：全局 API 下同时存在 webview / webviewWindow 两个命名空间。 */
  function dragApi() {
    const ns = window.__TAURI__;
    if (!ns) return null;
    const mod = ns.webviewWindow || ns.webview;
    if (!mod || typeof mod.getCurrentWebview !== "function") return null;
    try {
      const webview = mod.getCurrentWebview();
      return webview && typeof webview.onDragDropEvent === "function" ? webview : null;
    } catch (_) {
      return null;
    }
  }

  function showDropZone() {
    const zone = $("sftp-dropzone");
    if (!zone || dropVisible) return;
    const path = $("sftp-dropzone-path");
    if (path) path.textContent = listing ? listing.path : "";
    dropVisible = true;
    zone.classList.add("active");
  }

  function hideDropZone() {
    const zone = $("sftp-dropzone");
    if (!zone || !dropVisible) return;
    dropVisible = false;
    zone.classList.remove("active");
  }

  function bindDragDrop() {
    if (dragBound) return;
    const webview = dragApi();
    if (!webview) return;
    dragBound = true;
    webview
      .onDragDropEvent((event) => {
        const payload = (event && event.payload) || {};
        if (!isOpen()) {
          hideDropZone();
          return;
        }
        if (payload.type === "enter" || payload.type === "over") {
          if (currentId) showDropZone();
        } else if (payload.type === "leave") {
          hideDropZone();
        } else if (payload.type === "drop") {
          hideDropZone();
          handleDrop(payload.paths || []);
        }
      })
      .catch(() => {});
  }

  function handleDrop(paths) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    if (!currentId || !listing) {
      toast("请先打开一个远端目录再拖入文件", "error");
      return;
    }
    const sessionId = currentId;
    const dir = listing.path;
    list.forEach((path) => enqueue(uploadSpec(sessionId, path, dir)));
    toast(`开始上传 ${list.length} 个条目`, "ok");
  }

  // -------------------------------------------------------------------------
  // 传输队列与进度面板
  // -------------------------------------------------------------------------

  function transferStat(item) {
    if (item.status === "queued") return "等待中…";
    if (item.status === "cancelling") return "正在中断…";
    if (item.status === "cancelled") return "已中断";
    if (item.status === "error") return item.error || "传输失败";
    // 目录传输会先递归扫描算出总量，这期间既没有总量也没有字节数
    if (item.status === "running" && !item.total && !item.transferred) {
      return "正在读取…";
    }

    const elapsed = ((item.endedAt || Date.now()) - (item.startedAt || Date.now())) / 1000;
    const speed = elapsed > 0 ? item.transferred / elapsed : 0;
    const parts = [];
    if (item.status === "done") parts.push("共 " + humanSize(item.bytes || item.transferred));
    else if (speed > 0) parts.push(humanSize(speed) + "/s");
    parts.push("已用 " + fmtDuration(elapsed));
    if (item.status === "running" && speed > 0 && item.total > item.transferred) {
      parts.push("剩余 " + fmtDuration((item.total - item.transferred) / speed));
    }
    return parts.join(" · ");
  }

  function paintTransfer(item) {
    const refs = transferNodes.get(item.id);
    if (!refs) return;
    refs.node.dataset.status = item.status;
    const ratio =
      item.status === "done"
        ? 1
        : item.total > 0
          ? Math.min(1, item.transferred / item.total)
          : 0;
    refs.fill.style.width = (ratio * 100).toFixed(1) + "%";
    refs.pct.textContent = Math.round(ratio * 100) + "%";
    refs.stat.textContent = transferStat(item);
    const active =
      item.status === "queued" ||
      item.status === "running" ||
      item.status === "cancelling";
    refs.cancel.title = active ? "中断传输" : "移除";
  }

  function buildTransferNode(item) {
    const fill = el("div", { class: "sftp-tr-fill" });
    const pct = el("span", { class: "sftp-tr-pct", text: "0%" });
    const stat = el("span", { class: "sftp-tr-stat", text: "" });
    const cancel = el("button", {
      class: "sftp-tr-cancel",
      type: "button",
      title: "中断传输",
      text: "✕",
      onclick: () => transferAction(item.id),
    });
    // 单行紧凑排布：这一栏还要放「关闭」按钮
    const node = el("div", { class: "sftp-tr", dataset: { status: item.status } }, [
      el("span", {
        class: "sftp-tr-dir",
        text: item.direction === "upload" ? "⬆" : "⬇",
      }),
      el("span", { class: "sftp-tr-name", title: item.label, text: item.label }),
      pct,
      el("div", { class: "sftp-tr-bar" }, [fill]),
      stat,
      cancel,
    ]);
    transferNodes.set(item.id, { node, fill, pct, stat, cancel });
    paintTransfer(item);
    return node;
  }

  /** 重建整个进度面板。进度事件不走这里，而是直接 patch 节点，避免频繁重建。 */
  function renderTransfers() {
    const host = $("sftp-transfers");
    if (!host) return;
    transferNodes.clear();
    host.textContent = "";
    if (!transfers.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    transfers.forEach((item) => host.appendChild(buildTransferNode(item)));
  }

  function onTransferProgress(payload) {
    if (!payload || !payload.id) return;
    const item = transfers.filter((t) => t.id === payload.id)[0];
    if (!item) return;
    item.transferred = Number(payload.transferred) || 0;
    if (payload.total) item.total = Number(payload.total);
    if (item.status === "running") paintTransfer(item);
  }

  function bindTransferEvents() {
    if (transferEventsBound) return;
    transferEventsBound = true;
    PShell.ipc.listen(TRANSFER_EVENT, onTransferProgress).catch(() => {});
  }

  function dismissTransfer(id) {
    transfers = transfers.filter((t) => t.id !== id);
    renderTransfers();
  }

  function enqueue(spec) {
    if (!spec || typeof spec.run !== "function") return;
    const item = {
      id: "tr-" + ++transferSeq + "-" + Date.now(),
      label: spec.label || "传输",
      direction: spec.direction || "download",
      refresh: !!spec.refresh,
      sessionId: spec.sessionId || currentId,
      status: "queued",
      transferred: 0,
      total: 0,
      bytes: 0,
      cancelled: false,
      error: null,
      startedAt: 0,
      endedAt: 0,
      run: spec.run,
    };
    transfers.push(item);
    renderTransfers();
    pump();
  }

  async function pump() {
    if (pumping) return;
    const item = transfers.filter((t) => t.status === "queued")[0];
    if (!item) return;
    pumping = true;
    item.status = "running";
    item.startedAt = Date.now();
    renderTransfers();
    try {
      const bytes = await item.run(item.id);
      if (item.cancelled) {
        item.status = "cancelled";
      } else {
        item.status = "done";
        item.bytes = Number(bytes) || item.transferred;
        if (item.total) item.transferred = item.total;
      }
    } catch (err) {
      if (item.cancelled) {
        item.status = "cancelled";
      } else {
        item.status = "error";
        item.error = errorText(err);
        toast(item.error, "error");
      }
    } finally {
      pumping = false;
      item.endedAt = Date.now();
      if (item.status === "cancelled") {
        // 中断后不保留进度条，直接移除
        toast(`${item.label} 已中断`, "info");
        dismissTransfer(item.id);
      } else if (item.status === "done") {
        renderTransfers();
        toast(`${item.label} 完成，共 ${humanSize(item.bytes)}`, "ok");
        setTimeout(() => dismissTransfer(item.id), 2600);
        // 上传会改变远端目录内容，下载不会
        if (item.refresh && item.sessionId === currentId) {
          await loadListing(listing ? listing.path : "");
        }
      } else {
        renderTransfers();
      }
      pump();
    }
  }

  async function cancelTransfer(id) {
    const item = transfers.filter((t) => t.id === id)[0];
    if (!item) return;
    // 还没轮到它跑：直接出队，不必打扰后端
    if (item.status === "queued") {
      dismissTransfer(id);
      return;
    }
    if (item.status !== "running") return;
    item.cancelled = true;
    item.status = "cancelling";
    renderTransfers();
    try {
      await PShell.ipc.sftpCancelTransfer(id);
    } catch (_) {
      /* 已结束的传输会在 finally 里落到 cancelled */
    }
  }

  /** 进度条上的 ✕：在途时是中断，已结束时是移除该条。 */
  function transferAction(id) {
    const item = transfers.filter((t) => t.id === id)[0];
    if (!item) return;
    if (item.status === "queued" || item.status === "running" || item.status === "cancelling") {
      cancelTransfer(id);
      return;
    }
    dismissTransfer(id);
  }

  // -------------------------------------------------------------------------
  // 行为
  // -------------------------------------------------------------------------

  async function loadConnections() {
    try {
      // SFTP 走 SSH 连接，RDP 连接不在此列出
      connections = ((await PShell.ipc.listConnections()) || []).filter(
        (c) => (c.protocol || "ssh") !== "rdp"
      );
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
    // 过场期间就让窗口到位，避免连接成功后突然撑高
    connecting = true;
    renderBody();
    showConnecting(`正在建立 SFTP 连接 · ${conn.name || conn.host}`);
    const started = Date.now();
    try {
      const info = await PShell.ipc.sftpConnect(PShell.connections.paramsFor(conn));
      currentId = info.id;
      listing = null;
      editing = null;
      toast(`已建立 SFTP 连接 ${info.username}@${info.host}`, "ok");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      // 过场至少停留一小段时间，避免动画一闪而过
      await wait(Math.max(0, MIN_CONNECT_MS - (Date.now() - started)));
      hideConnecting();
      connecting = false;
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
    const target = document.querySelector("#sftp-body .sftp-editor-input");
    if (target) {
      target.focus();
      target.select();
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

  /** 下载条目。目录选落地的父目录（后端按远端目录名递归展开），文件选保存路径。 */
  async function download(entry) {
    const dialog = dialogApi();
    const sessionId = currentId;
    if (!sessionId) return;

    if (entry.is_dir) {
      if (!dialog || typeof dialog.open !== "function") {
        toast("当前环境不支持目录选择对话框", "error");
        return;
      }
      let picked = null;
      try {
        picked = await dialog.open({ title: "选择下载位置", directory: true, multiple: false });
      } catch (err) {
        toast(errorText(err), "error");
        return;
      }
      const parent = Array.isArray(picked) ? picked[0] : picked;
      if (!parent) return;
      const local = joinLocal(parent, entry.name);
      enqueue({
        label: `下载 ${entry.name}/`,
        direction: "download",
        sessionId,
        run: (tid) => PShell.ipc.sftpDownload(sessionId, entry.path, local, tid),
      });
      return;
    }

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
    enqueue({
      label: `下载 ${entry.name}`,
      direction: "download",
      sessionId,
      run: (tid) => PShell.ipc.sftpDownload(sessionId, entry.path, local, tid),
    });
  }

  function uploadSpec(sessionId, localPath, dir) {
    const name = baseName(localPath);
    return {
      label: `上传 ${name}`,
      direction: "upload",
      sessionId,
      refresh: true,
      run: (tid) => PShell.ipc.sftpUpload(sessionId, localPath, joinPath(dir, name), tid),
    };
  }

  async function pickAndUpload(options) {
    const dialog = dialogApi();
    const sessionId = currentId;
    if (!sessionId || !listing) {
      toast("请先打开一个远端目录", "error");
      return;
    }
    if (!dialog || typeof dialog.open !== "function") {
      toast("当前环境不支持文件选择对话框", "error");
      return;
    }
    let picked = null;
    try {
      picked = await dialog.open(options);
    } catch (err) {
      toast(errorText(err), "error");
      return;
    }
    const list = (Array.isArray(picked) ? picked : [picked]).filter(Boolean);
    if (!list.length) return;
    const dir = listing.path;
    list.forEach((path) => enqueue(uploadSpec(sessionId, path, dir)));
  }

  function uploadFiles() {
    return pickAndUpload({
      title: "选择要上传的文件",
      multiple: true,
      directory: false,
    });
  }

  function uploadFolder() {
    return pickAndUpload({
      title: "选择要上传的文件夹",
      multiple: false,
      directory: true,
    });
  }

  async function remove(entry) {
    const kind = entry.is_dir ? "目录" : "文件";
    const extra = entry.is_dir ? "（只能删除空目录）" : "";
    const confirmed = await ask(`删除${kind}「${entry.name}」${extra}？此操作不可撤销。`, {
      title: "删除确认",
      okText: "删除",
      kind: "danger",
    });
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
    bindTransferEvents();
    bindDragDrop();
    renderBody();
    renderTransfers();
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
    connecting = false;
    transfers = [];
    hideConnecting();
    hideDropZone();
    renderTransfers();
    renderBadge();
    if (isOpen()) renderBody();
  }

  const badgeNode = $("sftp-status");
  if (badgeNode) badgeNode.addEventListener("click", open);

  PShell.sftp = { setConfig, open, refresh };
})(window.PShell);
