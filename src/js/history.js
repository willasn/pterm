/* 命令历史面板（FEATURES.md §6 辅助模块）。
 *
 * 只在 features.auxiliary.command_history 打开时可用：关闭时侧栏入口隐藏、
 * 面板不加载，后端 command 也会以 ModuleDisabled 拒绝。
 * 去重与频率统计都在 Rust 侧的聚合查询里完成（不删原始记录），
 * 前端只负责传参（搜索词 / 是否去重 / 排序方式）与展示使用次数。
 * 插入终端只写入输入行、不追加回车，保留 terminal.js 的危险命令二次确认。 */
(function (PShell) {
  "use strict";

  const { el, $, toast, errorText, ask, debounce } = PShell.util;
  const { field, section } = PShell.form;

  const LIMIT = 200;

  let enabled = false;
  let busy = false;
  let entries = [];
  let query = "";
  let dedupe = true;
  let order = "recent";
  let lastError = null;
  /** 列表挂载点：搜索只重绘列表，避免输入框失焦 */
  let listHost = null;

  function syncFlags(config) {
    return (config && config.features && config.features.auxiliary) || {};
  }

  function isOpen() {
    const mask = $("modal-history");
    return !!mask && !mask.hidden;
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

  function activeSession() {
    return PShell.terminal.active();
  }

  function sessionLabel(ctrl) {
    const info = (ctrl && ctrl.info) || {};
    return info.name || info.host || String((ctrl && ctrl.id) || "").slice(0, 8);
  }

  function shortTime(iso) {
    const t = Date.parse(iso);
    if (!t) return iso || "";
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
  }

  // -------------------------------------------------------------------------
  // 侧栏状态徽标
  // -------------------------------------------------------------------------

  function renderBadge() {
    const node = $("hist-status");
    if (!node) return;
    if (!enabled) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    node.textContent = `历史 ${entries.length}`;
  }

  // -------------------------------------------------------------------------
  // 面板
  // -------------------------------------------------------------------------

  function controlsSection() {
    const searchInput = el("input", {
      type: "text",
      spellcheck: "false",
      placeholder: "按命令子串过滤…",
    });
    searchInput.value = query;
    searchInput.addEventListener("input", () => {
      query = searchInput.value;
      scheduleSearch();
    });

    const dedupeInput = el("input", { type: "checkbox" });
    dedupeInput.checked = dedupe;
    dedupeInput.addEventListener("change", () => {
      dedupe = dedupeInput.checked;
      refresh();
    });

    const orderSelect = el("select", null, [
      el("option", { value: "recent", text: "最近使用" }),
      el("option", { value: "frequent", text: "最常用" }),
    ]);
    orderSelect.value = order;
    // 非去重模式下每条记录只出现一次，频率排序没有意义
    orderSelect.disabled = !dedupe;
    orderSelect.addEventListener("change", () => {
      order = orderSelect.value;
      refresh();
    });

    const nodes = [
      field(`最多显示最近 ${LIMIT} 条`, null, searchInput),
      el("div", { class: "toggle-row" }, [
        el("label", { class: "toggle-row" }, [
          dedupeInput,
          el("span", { text: "去重（按命令合并）" }),
        ]),
        el("span", { class: "muted", text: "排序" }),
        orderSelect,
      ]),
    ];
    if (lastError) nodes.push(note(lastError, "error"));
    nodes.push(
      el("div", { class: "log-actions" }, [
        button("刷新", () => refresh(), "ghost"),
        button("清空历史", clearAll, "danger"),
      ])
    );
    return section(null, null, nodes);
  }

  function itemNode(entry) {
    const ctrl = activeSession();
    const meta = [];
    if (entry.uses > 1) meta.push(`×${entry.uses}`);
    if (entry.host) meta.push(entry.host);
    meta.push(shortTime(entry.executed_at));
    return el("li", null, [
      el(
        "button",
        {
          class: "log-item",
          type: "button",
          title: ctrl ? `插入到 ${sessionLabel(ctrl)}` : "当前没有打开的会话",
          onclick: () => insert(entry),
        },
        [
          el("span", { class: "log-name", text: entry.command }),
          el("span", { class: "log-meta", text: meta.join(" · ") }),
        ]
      ),
    ]);
  }

  function listSection() {
    if (!entries.length) {
      return section(
        "命令",
        null,
        [
          note(
            query
              ? `没有匹配「${query}」的历史命令。`
              : "还没有历史命令。连接主机并执行命令后会自动记录。"
          ),
        ]
      );
    }
    return section(
      "命令",
      query ? `匹配「${query}」的 ${entries.length} 条` : `共 ${entries.length} 条`,
      [
        el(
          "ul",
          { class: "log-list" },
          entries.map(itemNode)
        ),
        note("点击命令写入当前会话的输入行，不追加回车；请确认后自行按回车执行。"),
      ]
    );
  }

  function renderList() {
    if (!listHost) return;
    listHost.textContent = "";
    listHost.appendChild(listSection());
  }

  function renderBody() {
    const host = $("hist-body");
    if (!host) return;
    const hint = $("hist-hint");
    if (hint) hint.textContent = enabled ? `已记录 ${entries.length} 条` : "";

    listHost = null;
    host.textContent = "";
    if (!enabled) {
      host.appendChild(
        note("命令历史已关闭。请在「设置 → 功能开关」中打开「命令历史」。")
      );
      return;
    }
    host.appendChild(controlsSection());
    listHost = el("div", null, null);
    host.appendChild(listHost);
    renderList();
  }

  // -------------------------------------------------------------------------
  // 行为
  // -------------------------------------------------------------------------

  async function load() {
    if (!enabled) return;
    try {
      entries = (await PShell.ipc.listHistory(LIMIT, query || null, dedupe, order)) || [];
      lastError = null;
    } catch (err) {
      entries = [];
      lastError = errorText(err);
      if (isOpen()) toast(lastError, "error");
    }
    renderBadge();
    if (isOpen()) renderList();
  }

  const scheduleSearch = debounce(load, 250);

  async function refresh() {
    if (!enabled) {
      entries = [];
      query = "";
      lastError = null;
      renderBadge();
      if (isOpen()) renderBody();
      return;
    }
    busy = true;
    if (isOpen()) renderBody();
    try {
      await load();
    } finally {
      busy = false;
      if (isOpen()) renderBody();
    }
  }

  async function clearAll() {
    if (busy) return;
    const confirmed = await ask("清空全部命令历史？此操作不可撤销。", {
      title: "清空确认",
      okText: "清空",
      kind: "danger",
    });
    if (!confirmed) return;
    busy = true;
    renderBody();
    try {
      await PShell.ipc.clearHistory();
      toast("命令历史已清空", "ok");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function insert(entry) {
    const ctrl = activeSession();
    if (!ctrl) {
      toast("当前没有打开的会话", "error");
      return;
    }
    try {
      await PShell.ssh.write(ctrl.id, entry.command);
      toast(`已插入到 ${sessionLabel(ctrl)}`, "ok");
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  async function open() {
    if (!enabled) {
      toast("命令历史已关闭，请在「设置 → 功能开关」中启用", "info");
      return;
    }
    const mask = $("modal-history");
    if (!mask || isOpen()) return;
    mask.hidden = false;
    renderBody();
    await refresh();
  }

  /** 由 app.js 在配置变化时调用（启动、保存设置、重置）。 */
  function setConfig(config) {
    enabled = !!syncFlags(config).command_history;
    if (!enabled) {
      entries = [];
      query = "";
      lastError = null;
      renderBadge();
      if (isOpen()) renderBody();
      return;
    }
    renderBadge();
    refresh();
  }

  const badgeNode = $("hist-status");
  if (badgeNode) badgeNode.addEventListener("click", open);

  PShell.history = { setConfig, open, refresh };
})(window.PShell);