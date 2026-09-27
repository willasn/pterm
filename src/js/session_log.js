/* 会话日志面板（FEATURES.md §3 连接与传输）。
 *
 * 只在 features.connection.session_log 打开时可用：关闭时侧栏入口隐藏、面板不加载，
 * 后端 command 也会以 ModuleDisabled 拒绝。
 * 落盘由 SSH 核心在数据泵里完成，本面板只做查阅与清理，全程经 Tauri command。 */
(function (PShell) {
  "use strict";

  const { el, $, toast, errorText, ask } = PShell.util;
  const { field, section } = PShell.form;

  let enabled = false;
  let busy = false;
  let status = null;
  let entries = [];
  let selected = null;
  let preview = null;

  function syncFlags(config) {
    return (config && config.features && config.features.connection) || {};
  }

  function isOpen() {
    const mask = $("modal-session-log");
    return !!mask && !mask.hidden;
  }

  function humanSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  /** RFC3339 → "YYYY-MM-DD HH:MM"，解析失败时原样返回。 */
  function shortTime(raw) {
    if (!raw) return "—";
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}`
    );
  }

  // -------------------------------------------------------------------------
  // 侧栏状态徽标
  // -------------------------------------------------------------------------

  function badgeText() {
    if (!status) return "日志 …";
    const marks = [`${status.count} 个文件`];
    if (status.active) marks.push(`记录中 ${status.active}`);
    return "日志 " + marks.join(" · ");
  }

  function renderBadge() {
    const node = $("log-status");
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

  function stateSection(s) {
    return section("状态", null, [
      info("日志目录", s.dir),
      info("保留天数", s.retention_days ? `${s.retention_days} 天` : "不自动清理"),
      info("文件数", `${s.count} 个`),
      info("记录中的会话", s.active ? `${s.active} 个` : "无"),
      note("日志包含终端全部输出，可能含敏感内容，请按需清理。"),
    ]);
  }

  function itemNode(entry) {
    return el(
      "button",
      {
        class: "log-item" + (entry.name === selected ? " current" : ""),
        type: "button",
        title: entry.modified,
        onclick: () => select(entry.name),
      },
      [
        el("span", { class: "log-name", text: entry.name }),
        el("span", {
          class: "log-meta",
          text: (entry.active ? "记录中 · " : "") + humanSize(entry.size),
        }),
      ]
    );
  }

  function filesSection() {
    const nodes = [];
    if (!entries.length) {
      nodes.push(note("还没有日志文件。打开一个 SSH 会话后会自动开始记录。"));
    } else {
      nodes.push(el("ul", { class: "log-list" }, entries.map(itemNode)));
    }
    nodes.push(
      el("div", { class: "log-actions" }, [
        button("刷新", () => refresh(), "ghost"),
        button("清空全部", clearAll, "danger"),
      ])
    );
    return section(
      "日志文件",
      entries.length ? "点击文件名查看尾部内容（最多 64 KB）。" : null,
      nodes
    );
  }

  function previewSection() {
    const nodes = [];
    if (preview == null) {
      nodes.push(note("尚未选择日志文件。"));
    } else {
      nodes.push(
        el("pre", { class: "log-preview", text: preview || "（该文件为空）" })
      );
      nodes.push(
        el("div", { class: "log-actions" }, [
          button(
            "关闭预览",
            () => {
              selected = null;
              preview = null;
              renderBody();
            },
            "ghost"
          ),
        ])
      );
    }
    return section("预览", selected ? "文件：" + selected : null, nodes);
  }

  function renderBody() {
    const host = $("log-body");
    if (!host) return;
    const hint = $("log-hint");
    if (hint) hint.textContent = status ? "目录：" + status.dir : "";

    host.textContent = "";
    if (!enabled) {
      host.appendChild(
        note("会话日志已关闭。请在「设置 → 功能开关」中打开「会话日志」。")
      );
      return;
    }
    if (!status) {
      host.appendChild(note("正在读取日志状态…"));
      return;
    }

    host.appendChild(stateSection(status));
    host.appendChild(filesSection());
    host.appendChild(previewSection());
  }

  // -------------------------------------------------------------------------
  // 行为
  // -------------------------------------------------------------------------

  async function refresh() {
    if (!enabled) {
      status = null;
      entries = [];
    } else {
      try {
        status = await PShell.ipc.sessionLogStatus();
        entries = await PShell.ipc.sessionLogList();
      } catch (err) {
        status = null;
        entries = [];
        if (isOpen()) toast(errorText(err), "error");
      }
    }
    renderBadge();
    if (isOpen()) renderBody();
  }

  async function run(label, fn) {
    if (busy) return;
    busy = true;
    renderBody();
    try {
      const outcome = await fn();
      const detail =
        typeof outcome === "number" ? `，共 ${outcome} 个文件` : "";
      toast(label + "完成" + detail, "ok");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function select(name) {
    try {
      preview = await PShell.ipc.sessionLogRead(name, 0);
      selected = name;
    } catch (err) {
      toast(errorText(err), "error");
      return;
    }
    renderBody();
  }

  async function clearAll() {
    const confirmed = await ask(
      "清空全部会话日志文件？此操作不可撤销，正在记录的会话会继续写入，但历史内容无法恢复。"
    );
    if (!confirmed) return;
    selected = null;
    preview = null;
    run("清空日志", () => PShell.ipc.sessionLogClear());
  }

  async function open() {
    if (!enabled) {
      toast("会话日志已关闭，请在「设置 → 功能开关」中启用", "info");
      return;
    }
    const mask = $("modal-session-log");
    if (!mask || isOpen()) return;
    mask.hidden = false;
    renderBody();
    await refresh();
  }

  /** 由 app.js 在配置变化时调用（启动、保存设置、重置）。 */
  function setConfig(config) {
    enabled = !!syncFlags(config).session_log;
    renderBadge();
    if (enabled) {
      refresh();
    } else {
      status = null;
      entries = [];
      selected = null;
      preview = null;
      renderBadge();
      if (isOpen()) renderBody();
    }
  }

  const badgeNode = $("log-status");
  if (badgeNode) badgeNode.addEventListener("click", open);

  PShell.sessionLog = { setConfig, open, refresh };
})(window.PShell);