/* 快捷命令面板（FEATURES.md §6 辅助模块）。
 *
 * 一个类 Spotlight 的动作命令面板：由快捷键 app.quick_panel 唤起，
 * 列出「前端已实现的动作」，本地过滤后回车 / 点击即执行。
 *
 * 与全局搜索（search.js）的区别：搜索跨数据源模糊检索（连接 / 片段 / 历史 / 设置），
 * 这里只列「动作」本身。动作注册表来自 shortcuts.js 的 `actions()`，因此
 * 面板会自动覆盖所有已实现的快捷键动作，包括它们当前绑定的组合键。 */
(function (PShell) {
  "use strict";

  const { el, $, toast } = PShell.util;
  const { field } = PShell.form;

  let enabled = false;
  let query = "";
  /** 当前动作列表：[{ id, label, hint, keys }] */
  let items = [];
  let hitNodes = [];
  let inputNode = null;
  let resultsHost = null;

  function isOpen() {
    const mask = $("modal-quick-panel");
    return !!mask && !mask.hidden;
  }

  function close() {
    const mask = $("modal-quick-panel");
    if (mask) mask.hidden = true;
  }

  function note(text, kind) {
    return el("p", { class: "inline-note " + (kind || ""), text });
  }

  function focusHit(index) {
    if (!hitNodes.length) return;
    hitNodes[(index + hitNodes.length) % hitNodes.length].focus();
  }

  function hitNode(item) {
    const meta = [item.hint, item.keys ? `快捷键 ${item.keys}` : null]
      .filter(Boolean)
      .join(" · ");
    const node = el(
      "button",
      {
        class: "log-item",
        type: "button",
        title: meta ? `${item.label} · ${meta}` : item.label,
        onclick: () => {
          close();
          run(item.id);
        },
      },
      [
        el("span", { class: "log-name", text: item.label }),
        meta ? el("span", { class: "log-meta", text: meta }) : null,
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

  function run(actionId) {
    PShell.shortcuts.run(actionId);
  }

  function filtered() {
    const terms = String(query || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!terms.length) return items;
    return items.filter((item) => {
      const hay = [item.id, item.label, item.hint].join(" ").toLowerCase();
      return terms.every((term) => hay.indexOf(term) >= 0);
    });
  }

  function renderResults() {
    if (!resultsHost) return;
    resultsHost.textContent = "";
    hitNodes = [];

    if (!enabled) {
      resultsHost.appendChild(note("快捷面板已关闭。请在「设置 → 功能开关」中打开「快捷面板」。"));
      return;
    }

    const matched = filtered();
    if (!matched.length) {
      resultsHost.appendChild(note(`没有匹配「${query}」的动作。`));
      return;
    }

    resultsHost.appendChild(
      el("ul", { class: "log-list" }, matched.map((item) => hitNode(item)))
    );
  }

  function renderBody() {
    const host = $("quick-panel-body");
    if (!host) return;
    host.textContent = "";
    resultsHost = null;
    hitNodes = [];

    const hint = $("quick-panel-hint");
    if (hint) hint.textContent = enabled ? `${items.length} 个动作` : "";

    inputNode = el("input", {
      type: "text",
      spellcheck: "false",
      placeholder: "输入命令名称过滤，回车执行第一条…",
    });
    inputNode.value = query;
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

    host.appendChild(field("命令", "回车执行第一条，↑↓ 在结果间移动", inputNode));
    resultsHost = el("div", null, null);
    host.appendChild(resultsHost);
    renderResults();
  }

  async function open() {
    if (!enabled) {
      toast("快捷面板已关闭，请在「设置 → 功能开关」中启用", "info");
      return;
    }
    const mask = $("modal-quick-panel");
    if (!mask || isOpen()) return;
    // 拉取最新的动作注册表，保证与快捷键联动
    items = PShell.shortcuts.actions();
    mask.hidden = false;
    query = "";
    renderBody();
    if (inputNode) inputNode.focus();
  }

  /** 由 app.js 在配置变化时调用。 */
  function setConfig(config) {
    enabled = !!(
      config &&
      config.features &&
      config.features.auxiliary &&
      config.features.auxiliary.quick_panel
    );
  }

  PShell.quickPanel = { setConfig, open };
})(window.PShell);