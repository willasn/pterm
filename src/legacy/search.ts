/* 全局搜索面板（FEATURES.md §6 辅助模块）。
 *
 * 只在 features.auxiliary.global_search 打开时可用：关闭时侧栏入口隐藏、
 * 快捷键 app.search 也不响应。
 * 四个数据源在面板打开时一次性拉齐，之后完全在本地过滤，输入不再打 IPC：
 *   连接 → list_connections
 *   片段 → snippet_list（仅在「命令片段」模块打开时拉取）
 *   历史 → list_history（仅在「命令历史」模块打开时拉取）
 *   设置 → settings.js 导出的 searchIndex()，本就是前端数据
 * 关闭的模块不参与搜索，也不去拉取：它们的命令会被后端以 ModuleDisabled 拒绝，
 * 拉取失败会连累整个搜索。 */
(function (PShell) {
  "use strict";

  const { el, $, toast, errorText } = PShell.util;
  const { section } = PShell.form;

  /** 每个来源最多展示的命中条数 */
  const PER_SOURCE = 6;
  /** 向后端请求的历史条数上限 */
  const HISTORY_LIMIT = 200;

  let enabled = false;
  /** features.auxiliary 的快照，用于判断哪些数据源可用 */
  let flags = {};
  /** 已拉取的数据源：{ connections, snippets, history, settings } */
  let sources = null;
  let lastError = null;
  let query = "";
  /** 结果挂载点与命中按钮，供方向键在结果间移动 */
  let resultsHost = null;
  let hitNodes = [];
  /** 面板头部的搜索框，只绑定一次监听 */
  const inputNode = $("search-input");

  function isOpen() {
    const mask = $("modal-search");
    return !!mask && !mask.hidden;
  }

  function close() {
    const mask = $("modal-search");
    if (mask) mask.hidden = true;
  }

  function note(text, kind) {
    return el("p", { class: "inline-note " + (kind || ""), text });
  }

  function activeSession() {
    return PShell.terminal.active();
  }

  function sessionLabel(ctrl) {
    const info = (ctrl && ctrl.info) || {};
    return info.name || info.host || String((ctrl && ctrl.id) || "").slice(0, 8);
  }

  // -------------------------------------------------------------------------
  // 命中项：每个数据源都把记录归一成 { title, meta, hay, activate }
  // -------------------------------------------------------------------------

  function connectionItems() {
    return sources.connections.map((conn) => ({
      title: conn.name || conn.host,
      meta: [conn.group_name, `${conn.host}:${conn.port || 22}`, conn.username]
        .filter(Boolean)
        .join(" · "),
      hay: [conn.name, conn.host, conn.username, conn.group_name, conn.port]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
      activate: () => {
        close();
        PShell.connections.connectTo(conn);
      },
    }));
  }

  function snippetItems() {
    return sources.snippets.map((snip) => {
      const vars = snip.variables || [];
      return {
        title: snip.name || "(未命名片段)",
        meta: [
          vars.length ? `含变量 ${vars.length} 个` : "可直接插入",
          snip.group_name,
          snip.description,
        ]
          .filter(Boolean)
          .join(" · "),
        hay: [snip.name, snip.description, snip.content, snip.group_name]
          .filter(Boolean)
          .join(" ")
          .toLowerCase(),
        activate: () => insertSnippet(snip, vars),
      };
    });
  }

  function historyItems() {
    return sources.history.map((entry) => ({
      title: entry.command,
      meta: [entry.uses > 1 ? `×${entry.uses}` : null, entry.host].filter(Boolean).join(" · "),
      hay: [entry.command, entry.host].filter(Boolean).join(" ").toLowerCase(),
      activate: () => insertText(entry.command),
    }));
  }

  function settingItems() {
    return sources.settings.map((item) => ({
      title: item.title,
      meta: item.subtitle,
      hay: [item.title, item.subtitle, item.keywords].filter(Boolean).join(" ").toLowerCase(),
      activate: () => {
        close();
        PShell.settings.open(item.category);
      },
    }));
  }

  /** 可用的数据源分组。关闭的模块不出现，避免用户误以为搜索缺数据。 */
  function groupSpecs() {
    return [
      { label: "连接", build: connectionItems },
      { label: "命令片段", build: snippetItems, enabled: () => !!flags.snippets },
      { label: "命令历史", build: historyItems, enabled: () => !!flags.command_history },
      {
        label: "设置",
        build: settingItems,
        enabled: () => !!(PShell.settings && PShell.settings.searchIndex),
      },
    ].filter((spec) => !spec.enabled || spec.enabled());
  }

  // -------------------------------------------------------------------------
  // 模糊匹配：空格分隔的关键词需全部命中（AND），标题命中权重更高
  // -------------------------------------------------------------------------

  function termsOf(raw) {
    return String(raw || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  }

  /** 子串打分：命中越靠前、越贴近词首越相关；-1 表示不匹配。 */
  function score(hay, term) {
    const idx = hay.indexOf(term);
    if (idx < 0) return -1;
    if (idx === 0) return 100;
    return /[\s/._\-·:|@]/.test(hay.charAt(idx - 1)) ? 60 : 30;
  }

  function rank(item, terms) {
    const title = item.title.toLowerCase();
    let total = 0;
    terms.forEach((term) => {
      const inTitle = score(title, term);
      const inHay = score(item.hay, term);
      if (inTitle < 0 && inHay < 0) {
        total = -1;
        return;
      }
      if (total < 0) return;
      total += inTitle >= 0 ? inTitle + 20 : inHay;
    });
    return total;
  }

  // -------------------------------------------------------------------------
  // 面板
  // -------------------------------------------------------------------------

  /** 把焦点移到第 index 个命中（越界时环绕）。 */
  function focusHit(index) {
    if (!hitNodes.length) return;
    hitNodes[(index + hitNodes.length) % hitNodes.length].focus();
  }

  function hitNode(item) {
    const node = el(
      "button",
      {
        class: "log-item",
        type: "button",
        title: item.meta ? `${item.title} · ${item.meta}` : item.title,
        onclick: () => item.activate(),
      },
      [
        el("span", { class: "log-name", text: item.title }),
        item.meta ? el("span", { class: "log-meta", text: item.meta }) : null,
      ]
    );
    node.addEventListener("keydown", (event) => {
      const dir = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      if (!dir) return;
      event.preventDefault();
      focusHit(hitNodes.indexOf(node) + dir);
    });
    hitNodes.push(node);
    return el("li", null, [node]);
  }

  function renderResults() {
    if (!resultsHost) return;
    resultsHost.textContent = "";
    hitNodes = [];

    const terms = termsOf(query);
    if (!terms.length) return;

    let total = 0;
    groupSpecs().forEach((spec) => {
      const matched = spec
        .build()
        .map((item) => ({ item, weight: rank(item, terms) }))
        .filter((hit) => hit.weight >= 0)
        .sort((a, b) => b.weight - a.weight);
      if (!matched.length) return;
      total += matched.length;
      resultsHost.appendChild(
        section(spec.label, `命中 ${matched.length} 项`, [
          el(
            "ul",
            { class: "log-list" },
            matched.slice(0, PER_SOURCE).map((hit) => hitNode(hit.item))
          ),
        ])
      );
    });

    if (!total) {
      resultsHost.appendChild(note(`没有匹配「${query}」的结果。`));
    }
  }

  /** 搜索框监听只绑一次：输入即本地过滤，不再打 IPC。 */
  function bindInput() {
    if (!inputNode) return;
    inputNode.addEventListener("input", () => {
      query = inputNode.value;
      renderResults();
    });
    inputNode.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusHit(0);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        focusHit(hitNodes.length - 1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (hitNodes[0]) hitNodes[0].click();
      }
    });
  }

  /** 结果区顶部的提示：拉取失败、被关闭的模块。 */
  function noticeNodes() {
    const nodes = [];
    if (lastError) nodes.push(note(lastError, "error"));
    const off = [];
    if (!flags.snippets) off.push("命令片段");
    if (!flags.command_history) off.push("命令历史");
    if (off.length) nodes.push(note(`已关闭的模块不参与搜索：${off.join("、")}。`));
    return nodes;
  }

  function renderBody() {
    const host = $("search-body");
    if (!host) return;

    resultsHost = null;
    hitNodes = [];
    host.textContent = "";
    if (inputNode) {
      inputNode.hidden = !enabled;
      inputNode.value = query;
    }
    if (!enabled) {
      host.appendChild(note("全局搜索已关闭。请在「设置 → 功能开关」中打开「全局搜索」。"));
      return;
    }
    noticeNodes().forEach((node) => host.appendChild(node));
    resultsHost = el("div", null, null);
    host.appendChild(resultsHost);
    renderResults();
  }

  // -------------------------------------------------------------------------
  // 行为
  // -------------------------------------------------------------------------

  async function load() {
    const wantSnippets = !!flags.snippets;
    const wantHistory = !!flags.command_history;
    const [connections, snippets, history] = await Promise.all([
      PShell.ipc.listConnections(),
      wantSnippets ? PShell.ipc.snippetList() : [],
      wantHistory ? PShell.ipc.listHistory(HISTORY_LIMIT, null, true, "recent") : [],
    ]);
    const settings =
      (PShell.settings && PShell.settings.searchIndex && PShell.settings.searchIndex()) || [];
    sources = {
      connections: connections || [],
      snippets: snippets || [],
      history: history || [],
      settings,
    };
  }

  async function refresh() {
    if (!enabled) return;
    try {
      await load();
      lastError = null;
    } catch (err) {
      sources = null;
      lastError = errorText(err);
      toast(lastError, "error");
    } finally {
      if (isOpen()) renderBody();
    }
  }

  /** 写入当前会话的输入行，不追加回车：保留 terminal.js 的危险命令二次确认。 */
  async function insertText(text, label) {
    const ctrl = activeSession();
    if (!ctrl) {
      toast("没有可写入的终端会话，请先从左侧连接一个主机", "info");
      return;
    }
    try {
      await PShell.ssh.write(ctrl.id, text);
      close();
      toast(label || `已插入到 ${sessionLabel(ctrl)}`, "ok");
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  /** 含变量的片段不在搜索面板里插：变量值必须在片段面板中填写。 */
  function insertSnippet(snip, vars) {
    if (vars.length) {
      close();
      toast("该片段含变量，请在命令片段面板中填写后插入", "info");
      PShell.snippets.open();
      return;
    }
    return insertText(snip.content || "", `已插入「${snip.name}」`);
  }

  function renderBadge() {
    const node = $("search-status");
    if (!node) return;
    node.hidden = !enabled;
  }

  async function open() {
    if (!enabled) {
      toast("全局搜索已关闭，请在「设置 → 功能开关」中启用", "info");
      return;
    }
    const mask = $("modal-search");
    if (!mask || isOpen()) return;
    mask.hidden = false;
    query = "";
    renderBody();
    await refresh();
    if (inputNode) inputNode.focus();
  }

  /** 由 app.js 在配置变化时调用（启动、保存设置、重置）。 */
  function setConfig(config) {
    flags = (config && config.features && config.features.auxiliary) || {};
    enabled = !!flags.global_search;
    if (!enabled) {
      sources = null;
      query = "";
      lastError = null;
      renderBadge();
      if (isOpen()) renderBody();
      return;
    }
    renderBadge();
  }

  const badgeNode = $("search-status");
  if (badgeNode) badgeNode.addEventListener("click", open);
  bindInput();

  PShell.search = { setConfig, open, refresh };
})(window.PShell);