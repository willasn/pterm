/* 命令片段面板（FEATURES.md §6 辅助模块）。
 *
 * 只在 features.auxiliary.snippets 打开时可用：关闭时侧栏入口隐藏、面板不加载，
 * 后端 command 也会以 ModuleDisabled 拒绝。
 * 片段内容以 `{{name}}` 声明变量：**变量的识别与替换都在 Rust 侧**完成，
 * 前端只收集取值并调用渲染命令，因此不存在两份占位符语义。
 * 插入终端只写入输入行、不追加回车（单行片段不会被执行）。 */
(function (PShell) {
  "use strict";

  const { el, $, toast, errorText, ask, debounce } = PShell.util;
  const { field, section, bind } = PShell.form;

  let enabled = false;
  let busy = false;
  let snippets = [];
  /** 面板视图：list = 片段库，edit = 单个片段的编辑 / 插入。两者不同时展示。 */
  let view = "list";
  let selectedId = null;
  let draft = null;
  let values = {};
  let preview = "";
  let lastError = null;

  function syncFlags(config) {
    return (config && config.features && config.features.auxiliary) || {};
  }

  function isOpen() {
    const mask = $("modal-snippets");
    return !!mask && !mask.hidden;
  }

  function blankDraft() {
    return { id: "", name: "", description: "", content: "", group_name: "", variables: [] };
  }

  function find(id) {
    return snippets.filter((s) => s.id === id)[0] || null;
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

  function sessionLabel(ctrl) {
    const info = (ctrl && ctrl.info) || {};
    return info.name || info.host || String((ctrl && ctrl.id) || "").slice(0, 8);
  }

  // -------------------------------------------------------------------------
  // 侧栏状态徽标
  // -------------------------------------------------------------------------

  function renderBadge() {
    const node = $("snip-status");
    if (!node) return;
    if (!enabled) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    node.textContent = `片段 ${snippets.length}`;
  }

  // -------------------------------------------------------------------------
  // 面板
  // -------------------------------------------------------------------------

  /** 分组名去重，保持后端返回的排序（未分组在最前）。 */
  function groupNames() {
    const seen = [];
    snippets.forEach((s) => {
      const group = s.group_name || "";
      if (seen.indexOf(group) < 0) seen.push(group);
    });
    return seen;
  }

  function itemNode(snippet) {
    const count = (snippet.variables || []).length;
    return el(
      "li",
      null,
      [
        el(
          "button",
          {
            class: "log-item snip-item" + (snippet.id === selectedId ? " current" : ""),
            type: "button",
            title: snippet.description || snippet.content,
            onclick: () => select(snippet.id),
          },
          [
            el("span", { class: "log-name", text: snippet.name || "未命名片段" }),
            el("span", { class: "log-meta", text: count ? `${count} 个变量` : "无变量" }),
          ]
        ),
      ]
    );
  }

  function listSection() {
    const nodes = [];
    if (!snippets.length) {
      nodes.push(note("还没有保存任何片段。点击「新建片段」开始。"));
    } else {
      const items = [];
      groupNames().forEach((group) => {
        items.push(el("li", { class: "snip-group", text: group || "未分组" }));
        snippets
          .filter((s) => (s.group_name || "") === group)
          .forEach((s) => items.push(itemNode(s)));
      });
      nodes.push(el("ul", { class: "log-list" }, items));
      nodes.push(note("点击片段名称进入编辑。"));
    }
    nodes.push(
      el("div", { class: "log-actions" }, [
        button("新建片段", startNew, "primary"),
        button("刷新", () => refresh(), "ghost"),
      ])
    );
    return section("片段库", snippets.length ? `共 ${snippets.length} 个片段。` : null, nodes);
  }

  function editorSection() {
    const nameInput = bind(
      el("input", { type: "text", spellcheck: "false", placeholder: "留空则取内容首行" }),
      draft,
      "name"
    );
    const groupInput = bind(
      el("input", { type: "text", spellcheck: "false", placeholder: "可选，用于归类" }),
      draft,
      "group_name"
    );
    const descInput = bind(
      el("input", { type: "text", spellcheck: "false", placeholder: "可选，说明用途" }),
      draft,
      "description"
    );
    const contentArea = bind(
      el("textarea", {
        rows: 6,
        spellcheck: "false",
        placeholder: "例如：tail -n {{lines}} -f {{path}}",
      }),
      draft,
      "content"
    );

    const vars = draft.variables || [];
    const nodes = [
      field("名称", null, nameInput),
      field("分组", null, groupInput),
      field("说明", null, descInput),
      field("内容", "用 {{name}} 声明变量，保存后自动识别", contentArea),
      vars.length
        ? note(`已识别变量：${vars.map((v) => "{{" + v + "}}").join("、")}`)
        : note("尚未识别到变量。保存后会自动提取 {{name}} 形式的占位符。"),
      el("div", { class: "log-actions" }, [
        button(draft.id ? "保存修改" : "保存为新片段", save, "primary"),
        draft.id ? button("删除", remove, "danger") : null,
      ]),
    ];
    if (lastError) nodes.push(note(lastError, "error"));
    return section(
      draft.id ? "编辑片段" : "新建片段",
      draft.id ? null : "填写内容后点击「保存为新片段」。",
      nodes
    );
  }

  /** 编辑视图：返回条 + 编辑 + 插入到终端。 */
  function editView() {
    if (!draft) {
      view = "list";
      return listSection();
    }
    return el("div", null, [
      el("div", { class: "log-actions snip-back" }, [
        button("← 返回片段库", backToList, "ghost"),
        el("span", {
          class: "muted",
          text: draft.id ? "编辑已有片段" : "未保存的新片段",
        }),
      ]),
      editorSection(),
      insertSection(),
    ]);
  }

  function insertSection() {
    const nodes = [];
    if (!draft || !draft.id) {
      nodes.push(note("先保存片段，才能插入到终端。"));
      return section("插入到终端", null, nodes);
    }

    const ctrl = activeSession();
    if (!ctrl) nodes.push(note("当前没有打开的会话，请先连接一个主机。"));

    const vars = draft.variables || [];
    if (!vars.length) {
      nodes.push(note("该片段没有变量，可直接插入。"));
    } else {
      vars.forEach((name) => {
        const input = el("input", {
          type: "text",
          spellcheck: "false",
          placeholder: "{{" + name + "}}",
        });
        input.value = values[name] == null ? "" : values[name];
        input.addEventListener("input", () => {
          values[name] = input.value;
          schedulePreview();
        });
        nodes.push(field(name, null, input));
      });
    }

    nodes.push(
      el("pre", { class: "log-preview", id: "snip-preview", text: preview || draft.content })
    );
    const risky = String(preview || draft.content).indexOf("\n") >= 0;
    if (risky) {
      nodes.push(note("内容含换行，送入终端后会逐行执行，请确认后再插入。", "warn"));
    }
    nodes.push(
      el("div", { class: "log-actions" }, [button("插入到终端", insert, "primary")])
    );
    nodes.push(note("只写入终端输入行，不追加回车；请确认后自行按回车执行。"));
    return section("插入到终端", ctrl ? `目标会话：${sessionLabel(ctrl)}` : null, nodes);
  }

  function renderBody() {
    const host = $("snip-body");
    if (!host) return;
    const hint = $("snip-hint");
    if (hint) hint.textContent = enabled ? `已保存 ${snippets.length} 个片段` : "";

    host.textContent = "";
    if (!enabled) {
      host.appendChild(
        note("命令片段已关闭。请在「设置 → 功能开关」中打开「命令片段」。")
      );
      return;
    }
    host.appendChild(view === "edit" ? editView() : listSection());
  }

  // -------------------------------------------------------------------------
  // 行为
  // -------------------------------------------------------------------------

  function activeSession() {
    return PShell.terminal.active();
  }

  async function renderPreview() {
    if (!draft) return;
    try {
      preview = await PShell.ipc.snippetRender(draft.content || "", values);
    } catch (_) {
      preview = draft.content || "";
    }
    const node = $("snip-preview");
    if (node) node.textContent = preview || "（内容为空）";
  }

  const schedulePreview = debounce(renderPreview, 200);

  function select(id) {
    const hit = find(id);
    if (!hit) return;
    view = "edit";
    selectedId = id;
    draft = JSON.parse(JSON.stringify(hit));
    values = {};
    preview = hit.content;
    lastError = null;
    renderBody();
    renderPreview();
  }

  function startNew() {
    view = "edit";
    selectedId = null;
    draft = blankDraft();
    values = {};
    preview = "";
    lastError = null;
    renderBody();
  }

  /** 返回片段库：放弃未保存的改动，回到以数据库为准的列表。 */
  function backToList() {
    view = "list";
    selectedId = null;
    draft = null;
    values = {};
    preview = "";
    lastError = null;
    renderBody();
  }

  async function refresh() {
    if (!enabled) {
      snippets = [];
      view = "list";
      selectedId = null;
      draft = null;
      values = {};
      preview = "";
      lastError = null;
      renderBadge();
      if (isOpen()) renderBody();
      return;
    }
    try {
      snippets = (await PShell.ipc.snippetList()) || [];
    } catch (err) {
      snippets = [];
      if (isOpen()) toast(errorText(err), "error");
    }
    renderBadge();
    if (isOpen()) renderBody();
  }

  async function save() {
    if (busy || !draft) return;
    if (!String(draft.content || "").trim()) {
      lastError = "片段内容不能为空";
      renderBody();
      return;
    }
    busy = true;
    renderBody();
    try {
      const saved = await PShell.ipc.snippetSave({
        id: draft.id || "",
        name: draft.name || "",
        description: draft.description || "",
        content: draft.content || "",
        variables: draft.variables || [],
        group_name: draft.group_name || null,
        updated_at: "",
      });
      selectedId = saved.id;
      draft = saved;
      values = {};
      preview = saved.content;
      lastError = null;
      toast("片段已保存", "ok");
    } catch (err) {
      lastError = errorText(err);
      toast(lastError, "error");
    } finally {
      busy = false;
      await refresh();
      renderPreview();
    }
  }

  async function remove() {
    if (busy || !draft || !draft.id) return;
    const confirmed = await ask(`删除片段「${draft.name || "未命名片段"}」？此操作不可撤销。`);
    if (!confirmed) return;
    busy = true;
    renderBody();
    try {
      await PShell.ipc.snippetDelete(draft.id);
      view = "list";
      selectedId = null;
      draft = null;
      values = {};
      preview = "";
      toast("片段已删除", "ok");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function insert() {
    const ctrl = activeSession();
    if (!ctrl) {
      toast("当前没有打开的会话", "error");
      return;
    }
    if (!draft || !draft.id) {
      toast("请先保存片段", "error");
      return;
    }
    try {
      const text = await PShell.ipc.snippetRender(draft.content || "", values);
      await PShell.ssh.write(ctrl.id, text);
      toast("已插入到终端", "ok");
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  async function open() {
    if (!enabled) {
      toast("命令片段已关闭，请在「设置 → 功能开关」中启用", "info");
      return;
    }
    const mask = $("modal-snippets");
    if (!mask || isOpen()) return;
    mask.hidden = false;
    // 有未完成的草稿时直接回到编辑视图，避免重新打开后丢失未保存的内容
    view = draft ? "edit" : "list";
    renderBody();
    await refresh();
    if (draft) renderPreview();
  }

  /** 由 app.js 在配置变化时调用（启动、保存设置、重置）。 */
  function setConfig(config) {
    enabled = !!syncFlags(config).snippets;
    if (!enabled) {
      snippets = [];
      view = "list";
      selectedId = null;
      draft = null;
      values = {};
      preview = "";
      lastError = null;
      renderBadge();
      if (isOpen()) renderBody();
      return;
    }
    renderBadge();
    refresh();
  }

  const badgeNode = $("snip-status");
  if (badgeNode) badgeNode.addEventListener("click", open);

  PShell.snippets = { setConfig, open, refresh };
})(window.PShell);