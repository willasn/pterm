/* 端口转发面板（FEATURES.md §3 连接与传输）。
 *
 * 只在 features.connection.port_forward 打开时可用：关闭时侧栏入口隐藏、
 * 面板不加载，后端 command 也会以 ModuleDisabled 拒绝。
 * 转发规则是运行期内存态（后端决定，不写配置），因此面板只做两件事：
 * 新建一条规则并启动，以及查看 / 停止已在运行的规则。
 * 本地与远程转发需要显式目标地址，动态转发（SOCKS5）由客户端在握手时指定。 */
(function (PShell) {
  "use strict";

  const { el, $, toast, errorText, ask } = PShell.util;
  const { field, section } = PShell.form;

  const KINDS = [
    { value: "local", label: "本地转发" },
    { value: "remote", label: "远程转发" },
    { value: "dynamic", label: "动态转发（SOCKS5）" },
  ];

  let enabled = false;
  let busy = false;
  let connections = [];
  let forwards = [];
  let draft = blankDraft();
  let lastError = null;

  function blankDraft() {
    return {
      connection_id: null,
      kind: "local",
      bind_host: "",
      bind_port: "",
      target_host: "",
      target_port: "",
      label: "",
    };
  }

  function syncFlags(config) {
    return (config && config.features && config.features.connection) || {};
  }

  function isOpen() {
    const mask = $("modal-port-forward");
    return !!mask && !mask.hidden;
  }

  function kindLabel(kind) {
    const hit = KINDS.filter((k) => k.value === kind)[0];
    return hit ? hit.label : String(kind || "");
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

  // -------------------------------------------------------------------------
  // 侧栏状态徽标
  // -------------------------------------------------------------------------

  function renderBadge() {
    const node = $("pf-status");
    if (!node) return;
    if (!enabled) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    node.textContent = forwards.length
      ? "端口转发 " + forwards.length
      : "端口转发";
  }

  // -------------------------------------------------------------------------
  // 面板
  // -------------------------------------------------------------------------

  /** 绑定草稿字段：只更新草稿，不重渲染，避免输入过程中丢焦点。 */
  function draftInput(path, attrs) {
    const options = Object.assign({ type: "text", spellcheck: "false" }, attrs || {});
    const node = el("input", options);
    node.value = draft[path] == null ? "" : String(draft[path]);
    node.addEventListener("input", () => {
      draft[path] = node.value;
    });
    return node;
  }

  function formSection() {
    const nodes = [];
    if (!connections.length) {
      nodes.push(note("还没有保存的连接，请先在侧栏新建连接。"));
      return section("新建规则", "转发需要一条独立的 SSH 连接。", nodes);
    }

    const picker = el("select", {
      class: "pf-picker",
      onchange: (event) => {
        draft.connection_id = event.target.value;
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
    nodes.push(field("连接", null, picker));

    const kindPicker = el("select", {
      class: "pf-picker",
      onchange: (event) => {
        draft.kind = event.target.value;
        renderBody();
      },
    });
    KINDS.forEach((k) => {
      kindPicker.appendChild(el("option", { value: k.value, text: k.label }));
    });
    kindPicker.value = draft.kind;
    nodes.push(field("类型", null, kindPicker));

    const dynamic = draft.kind === "dynamic";
    nodes.push(
      field(
        "监听地址",
        "留空表示 127.0.0.1",
        draftInput("bind_host", { class: "pf-input", placeholder: "127.0.0.1" })
      )
    );
    nodes.push(
      field(
        "监听端口",
        dynamic ? "0 表示由系统分配" : "0 表示由系统或服务器分配",
        draftInput("bind_port", { class: "pf-input", placeholder: "8080" })
      )
    );

    if (dynamic) {
      nodes.push(
        note("动态转发在本机提供 SOCKS5 代理，目标地址由客户端在握手时指定。")
      );
    } else {
      nodes.push(
        field(
          "目标地址",
          null,
          draftInput("target_host", { class: "pf-input", placeholder: "10.0.0.5" })
        )
      );
      nodes.push(
        field(
          "目标端口",
          null,
          draftInput("target_port", { class: "pf-input", placeholder: "80" })
        )
      );
    }

    nodes.push(
      field(
        "标签",
        "留空时按类型自动生成",
        draftInput("label", { class: "pf-input", placeholder: kindLabel(draft.kind) })
      )
    );

    if (lastError) nodes.push(note(lastError, "error"));

    const hint = dynamic
      ? "本机监听端口可直接作为 SOCKS5 代理使用。"
      : draft.kind === "remote"
        ? "远端转发在 SSH 服务器上监听；该服务器需允许端口转发，不支持经跳板机建立。"
        : "本地转发在本机监听，连接经 SSH 送到目标。";
    nodes.push(
      el("div", { class: "pf-actions" }, [button("启动转发", start, "primary")])
    );
    return section("新建规则", hint, nodes);
  }

  function pickerSelection() {
    if (draft.connection_id && connections.some((c) => c.id === draft.connection_id)) {
      return draft.connection_id;
    }
    draft.connection_id = connections.length ? connections[0].id : null;
    return draft.connection_id || "";
  }

  function forwardNode(info) {
    return el("div", { class: "pf-item" }, [
      el("span", { class: "pf-label", title: info.label, text: info.label }),
      el("span", { class: "pf-kind", text: kindLabel(info.kind) }),
      el("span", {
        class: "pf-endpoint",
        title: `${info.username}@${info.host}:${info.port} · ${info.created_at}`,
        text: info.endpoint,
      }),
      el("span", { class: "pf-count", text: info.connections + " 连接" }),
      el("span", { class: "pf-acts" }, [
        el("button", {
          class: "pf-act danger",
          type: "button",
          text: "停止",
          disabled: busy,
          onclick: () => stop(info),
        }),
      ]),
    ]);
  }

  function runningSection() {
    const nodes = [];
    if (!forwards.length) {
      nodes.push(note("当前没有运行中的转发规则。"));
      return section("运行中", null, nodes);
    }
    nodes.push(
      el("div", { class: "pf-head" }, [
        el("span", { text: "规则" }),
        el("span", { text: "类型" }),
        el("span", { text: "转发路径" }),
        el("span", { text: "累计" }),
        el("span", { text: "操作" }),
      ])
    );
    nodes.push(el("div", { class: "pf-list" }, forwards.map(forwardNode)));
    return section("运行中", `共 ${forwards.length} 条规则。`, nodes);
  }

  function renderBody() {
    const host = $("pf-body");
    if (!host) return;
    const hint = $("pf-hint");
    if (hint) {
      hint.textContent = enabled ? `运行中 ${forwards.length} 条` : "";
    }

    host.textContent = "";
    if (!enabled) {
      host.appendChild(
        note("端口转发已关闭。请在「设置 → 功能开关」中打开「端口转发」。")
      );
      return;
    }
    host.appendChild(formSection());
    host.appendChild(runningSection());
  }

  // -------------------------------------------------------------------------
  // 行为
  // -------------------------------------------------------------------------

  async function loadConnections() {
    try {
      // 端口转发走 SSH 隧道，RDP 连接不在此列出
      connections = ((await PShell.ipc.listConnections()) || []).filter(
        (c) => (c.protocol || "ssh") !== "rdp"
      );
    } catch (_) {
      connections = [];
    }
    pickerSelection();
  }

  async function refresh() {
    if (!enabled) {
      forwards = [];
      connections = [];
      draft = blankDraft();
      lastError = null;
      renderBadge();
      if (isOpen()) renderBody();
      return;
    }
    try {
      forwards = (await PShell.ipc.portForwardList()) || [];
      lastError = null;
    } catch (err) {
      forwards = [];
      lastError = errorText(err);
    }
    renderBadge();
    if (isOpen()) renderBody();
  }

  function portOf(raw, fallback) {
    const n = parseInt(String(raw == null ? "" : raw).trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  async function start() {
    if (busy) return;
    const conn = connections.filter((c) => c.id === draft.connection_id)[0];
    if (!conn) {
      toast("请选择一个连接", "error");
      return;
    }
    const dynamic = draft.kind === "dynamic";
    const targetHost = String(draft.target_host || "").trim();
    const targetPort = portOf(draft.target_port, 0);
    if (!dynamic && !targetHost) {
      toast("请填写目标地址", "error");
      return;
    }
    if (!dynamic && targetPort === 0) {
      toast("目标端口需为 1~65535", "error");
      return;
    }
    const request = {
      params: PShell.connections.paramsFor(conn),
      kind: draft.kind,
      bind_host: String(draft.bind_host || "").trim() || null,
      bind_port: portOf(draft.bind_port, 0),
      target_host: dynamic ? null : targetHost,
      target_port: dynamic ? 0 : targetPort,
      label: String(draft.label || "").trim() || null,
    };
    busy = true;
    renderBody();
    try {
      const info = await PShell.ipc.portForwardStart(request);
      toast(`已启动${kindLabel(info.kind)}：${info.endpoint}`, "ok");
      draft = blankDraft();
      pickerSelection();
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function stop(info) {
    if (busy) return;
    const confirmed = await ask(`停止转发「${info.label}」？\n${info.endpoint}`);
    if (!confirmed) return;
    busy = true;
    renderBody();
    try {
      await PShell.ipc.portForwardStop(info.id);
      toast(`已停止「${info.label}」`, "ok");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function open() {
    if (!enabled) {
      toast("端口转发已关闭，请在「设置 → 功能开关」中启用", "info");
      return;
    }
    const mask = $("modal-port-forward");
    if (!mask || isOpen()) return;
    mask.hidden = false;
    renderBody();
    await loadConnections();
    await refresh();
  }

  /** 由 app.js 在配置变化时调用（启动、保存设置、重置）。 */
  function setConfig(config) {
    enabled = !!syncFlags(config).port_forward;
    if (!enabled) {
      forwards = [];
      connections = [];
      draft = blankDraft();
      lastError = null;
      renderBadge();
      if (isOpen()) renderBody();
      return;
    }
    renderBadge();
    refresh();
  }

  const badgeNode = $("pf-status");
  if (badgeNode) badgeNode.addEventListener("click", open);

  PShell.portForward = { setConfig, open, refresh };
})(window.PShell);