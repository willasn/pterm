/* 连接管理：侧栏列表、新建 / 编辑弹窗、快捷连接、会话发起。
 *
 * 前端只负责收集参数并交给 Tauri command；密码与 passphrase 提交后由后端
 * 写入主密码加密的保险库，前端既不保存也不回显，列表接口只返回 has_password 这类布尔标记。 */
(function (PShell) {
  "use strict";

  const { el, $, toast, errorText, deepClone, ask, promptPassword } = PShell.util;
  const { field, input, select, section, bind, toInt } = PShell.form;
  const t = PShell.i18n.t;

  const AUTH_KINDS = [
    { value: "auto", label: "自动（agent → 默认私钥 → 已存密码）" },
    { value: "password", label: "密码" },
    { value: "private_key", label: "私钥文件" },
    { value: "agent", label: "SSH Agent" },
  ];

  /** 连接协议。RDP 仅在 features.connection.rdp 打开时可选。 */
  const PROTOCOLS = [
    { value: "ssh", label: "SSH 终端" },
    { value: "rdp", label: "远程桌面（RDP）" },
  ];

  const DEFAULT_PORT = { ssh: 22, rdp: 3389 };

  const isRdp = (conn) => !!conn && conn.protocol === "rdp";

  let config = null;
  let connections = [];
  /** 弹窗中的草稿（StoredConnection 形状） */
  let draft = null;
  let draftIsNew = true;
  /** 本次提交携带的敏感字段：null = 不修改，"" = 删除 */
  let draftSecrets = { password: null, passphrase: null, jump_password: null };
  /** 「复制会话」时来源连接的 id：保存时让后端把源凭据复制到新条目 */
  let draftCopySecretsFrom = null;

  const connFlags = () => (config && config.features && config.features.connection) || {};

  // ---------------------------------------------------------------------------
  // 侧栏列表
  // ---------------------------------------------------------------------------

  function setConfig(next) {
    config = next;
    render();
    const quick = $("quick-connect");
    if (quick) quick.hidden = !connFlags().quick_connect;
  }

  async function refresh() {
    connections = await PShell.ipc.listConnections();
    render();
    return connections;
  }

  function render() {
    const host = $("conn-list");
    if (!host) return;
    host.textContent = "";

    if (!connections.length) {
      host.appendChild(
        el("p", { class: "inline-note", text: "还没有连接，点击右上角 ＋ 新建。" })
      );
      return;
    }

    if (!connFlags().connection_group) {
      connections.forEach((c) => host.appendChild(item(c)));
      return;
    }

    const groups = new Map();
    connections.forEach((c) => {
      const key = (c.group_name || "").trim() || "未分组";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    });
    Array.from(groups.keys())
      .sort((a, b) => a.localeCompare(b, "zh-CN"))
      .forEach((key) => {
        host.appendChild(el("div", { class: "conn-group-title", text: key }));
        groups.get(key).forEach((c) => host.appendChild(item(c)));
      });
  }

  function item(conn) {
    const children = [
      el("span", { class: "dot" }),
      el("span", { class: "label", text: conn.name }),
    ];
    if (isRdp(conn)) children.push(el("span", { class: "proto", title: "远程桌面（RDP）", text: "RDP" }));
    children.push(el("span", { class: "sub", text: `${conn.host}:${conn.port}` }));
    children.push(el("button", { class: "icon-btn edit", title: "编辑该连接", text: "✎" }));

    const node = el(
      "div",
      {
        class: "conn-item",
        title: isRdp(conn)
          ? `${conn.domain ? conn.domain + "\\" : ""}${conn.username} → ${conn.host}:${conn.port}`
          : `${conn.username}@${conn.host}:${conn.port}`,
      },
      children
    );
    if (conn.color) node.querySelector(".dot").style.background = conn.color;
    node.addEventListener("click", () => connectTo(conn));
    node.querySelector(".edit").addEventListener("click", (e) => {
      e.stopPropagation();
      openForm(conn);
    });
    node.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      PShell.menu.open(event.clientX, event.clientY, connMenu(conn));
    });
    return node;
  }

  /** 连接项的右键菜单：只放与这条连接 / 会话相关的动作，入口按功能开关隐藏。 */
  function connMenu(conn) {
    const flags = connFlags();
    const aux = (config && config.features && config.features.auxiliary) || {};
    const rdp = isRdp(conn);
    const port = conn.port || (rdp ? 3389 : 22);
    const address = `${conn.username}@${conn.host}:${port}`;

    const items = [
      { label: rdp ? "打开远程桌面" : "打开连接", icon: "▶", run: () => connectTo(conn) },
      { label: "编辑连接…", icon: "✎", run: () => openForm(conn) },
      { label: "复制会话", icon: "❐", run: () => duplicate(conn) },
      { label: "复制连接信息", icon: "⧉", run: () => copyText(address, "已复制连接信息") },
    ];

    if (rdp) {
      items.push({ label: "测试端口", icon: "⇄", run: () => PShell.rdp.probe(conn) });
      if (conn.has_password) {
        items.push({ label: "复制密码", icon: "⎘", run: () => PShell.rdp.copyPassword(conn) });
      }
      items.push({ sep: true }, { label: "删除连接…", icon: "✕", danger: true, run: () => removeById(conn) });
      return items;
    }

    const modules = [
      flags.sftp ? { label: "打开 SFTP", icon: "⇅", run: () => openModule(PShell.sftp) } : null,
      flags.port_forward ? { label: "端口转发", icon: "⇄", run: () => openModule(PShell.portForward) } : null,
      flags.session_log ? { label: "会话日志", icon: "▤", run: () => openModule(PShell.sessionLog) } : null,
      aux.snippets ? { label: "命令片段", icon: "⌘", run: () => openModule(PShell.snippets) } : null,
      aux.command_history ? { label: "命令历史", icon: "⟲", run: () => openModule(PShell.history) } : null,
    ].filter(Boolean);
    if (modules.length) items.push({ sep: true }, ...modules);

    items.push({ sep: true }, { label: "删除连接…", icon: "✕", danger: true, run: () => removeById(conn) });
    return items;
  }

  /** 模块可能未启用或未加载，open 不可用时静默跳过。 */
  function openModule(mod) {
    if (mod && typeof mod.open === "function") mod.open();
  }

  function copyText(text, okMessage) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => toast(okMessage, "ok"))
        .catch(() => toast("复制失败", "error"));
    } else {
      toast("当前环境不支持剪贴板", "error");
    }
  }

  // ---------------------------------------------------------------------------
  // 发起连接
  // ---------------------------------------------------------------------------

  function authSpec(kind, keyPath) {
    switch (kind) {
      case "password":
        return { kind: "password" };
      case "private_key":
        return { kind: "private_key", key_path: keyPath || "" };
      case "agent":
        return { kind: "agent" };
      default:
        return { kind: "auto" };
    }
  }

  function jumpSpec(record) {
    return {
      connection_id: null,
      host: record.host || "",
      port: record.port || 22,
      username: record.username || "",
      auth: authSpec(record.auth_kind, record.key_path),
    };
  }

  /** StoredConnection -> ConnectParams。密码一律由后端按 connection_id 从保险库读取。 */
  function paramsFor(conn) {
    const active = PShell.terminal.active();
    const terminal = (config && config.terminal) || {};
    return {
      connection_id: conn.id || null,
      name: conn.name || null,
      host: (conn.host || "").trim(),
      port: conn.port || 22,
      username: (conn.username || "").trim(),
      auth: authSpec(conn.auth_kind, conn.key_path),
      jump: connFlags().jump_host && conn.jump ? jumpSpec(conn.jump) : null,
      cols: active ? active.term.cols : 80,
      rows: active ? active.term.rows : 24,
      term_type: terminal.term_type || null,
      session_id: null,
    };
  }

  async function connectTo(conn) {
    // RDP 不要求用户名（客户端可弹框输入），SSH 则必须有主机与用户名
    if (!conn.host || (!conn.username && !isRdp(conn))) {
      toast(isRdp(conn) ? "该连接缺少主机" : "该连接缺少主机或用户名", "error");
      openForm(conn);
      return;
    }
    if (isRdp(conn)) {
      await PShell.rdp.open(conn);
      return;
    }
    try {
      await PShell.ssh.connect(paramsFor(conn));
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  /**
   * 临时连接（不落盘）：仅用于快捷连接。
   *
   * 先用自动认证（agent → 默认私钥）；认证不通过时弹框让用户手动输入密码，
   * 在同一标签内改用密码认证重试。取消或非认证类失败则保留终端里的错误提示。
   */
  async function connectQuick(parsed) {
    const terminal = (config && config.terminal) || {};
    const active = PShell.terminal.active();
    const params = {
      connection_id: null,
      name: `${parsed.username}@${parsed.host}`,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      auth: { kind: "auto" },
      jump: null,
      cols: active ? active.term.cols : 80,
      rows: active ? active.term.rows : 24,
      term_type: terminal.term_type || null,
      session_id: null,
    };

    let ctrl;
    try {
      ctrl = await PShell.ssh.connect(params);
    } catch (err) {
      toast(errorText(err), "error");
      return;
    }

    while (ctrl) {
      const outcome = await PShell.ssh.awaitOutcome(ctrl.id);
      if (outcome.ok || !outcome.authFailed) return;
      const password = await promptPassword(
        `${parsed.username}@${parsed.host} 认证未通过，请输入登录密码。`,
        { title: "输入登录密码", okText: "连接" }
      );
      if (password == null) return;
      ctrl.params.auth = { kind: "password", password };
      ctrl = await PShell.ssh.reconnect(ctrl.id);
    }
  }

  /** 解析 `user@host[:port]`。用户名必填——后端不允许空用户名。 */
  function parseQuick(text) {
    const raw = (text || "").trim();
    if (!raw) return null;
    let rest = raw;
    let username = "";
    const at = rest.indexOf("@");
    if (at > 0) {
      username = rest.slice(0, at);
      rest = rest.slice(at + 1);
    }
    if (!username) return null;

    let host = rest;
    let port = 22;
    const colon = rest.lastIndexOf(":");
    if (colon > 0 && /^\d+$/.test(rest.slice(colon + 1))) {
      host = rest.slice(0, colon);
      port = parseInt(rest.slice(colon + 1), 10);
    }
    if (!host) return null;
    return { username, host, port };
  }

  function onQuickSubmit() {
    const box = $("quick-input");
    if (!box) return;
    const parsed = parseQuick(box.value);
    if (!parsed) {
      toast("快捷连接格式：user@host:port", "error");
      return;
    }
    box.value = "";
    connectQuick(parsed);
  }

  // ---------------------------------------------------------------------------
  // 编辑弹窗
  // ---------------------------------------------------------------------------

  function blankConnection() {
    return {
      id: "",
      name: "",
      host: "",
      port: 22,
      username: "",
      protocol: "ssh",
      domain: null,
      auth_kind: "auto",
      key_path: null,
      group_name: null,
      has_password: false,
      has_passphrase: false,
      jump: null,
      color: null,
      created_at: "",
      updated_at: "",
    };
  }

  function blankJump() {
    return { host: "", port: 22, username: "", auth_kind: "auto", key_path: null };
  }

  /**
   * 打开连接表单。传入 `null`（或 `options.asNew`）表示新建。
   *
   * `options.copySecretsFrom`：新建时把该连接在保险库中的凭据一并复制到新条目
   * （「复制会话」用；前端拿不到明文，只能让后端按 id 复制）。
   *
   * 多标签的 ＋ 也走这里：侧栏本身就是连接选择器，因此不再叠一层「选择器」弹窗。
   */
  function openForm(conn, options) {
    const opts = options || {};
    draftIsNew = !conn || !!opts.asNew;
    draft = conn ? deepClone(conn) : blankConnection();
    if (!draft.jump) draft.jump = null;
    if (draft.protocol !== "rdp") draft.protocol = "ssh";
    draftSecrets = { password: null, passphrase: null, jump_password: null };
    draftCopySecretsFrom = draftIsNew ? opts.copySecretsFrom || null : null;
    $("conn-modal-title").textContent = draftIsNew
      ? t("modal.connection", "新建连接")
      : t("modal.connectionEdit", "编辑连接");
    $("conn-delete").hidden = draftIsNew;
    renderForm();
    $("modal-connection").hidden = false;
    const first = $("conn-form").querySelector("input");
    if (first) first.focus();
  }

  /**
   * 复制会话：基于已有连接打开一份预填的新建弹窗，名称自动加后缀，
   * 保存时由后端把源连接的凭据一并复制到新条目。SSH / RDP 通用。
   */
  function duplicate(conn) {
    if (!conn) return;
    const copy = deepClone(conn);
    copy.id = "";
    copy.created_at = "";
    copy.updated_at = "";
    copy.name = uniqueCopyName(conn.name || conn.host);
    openForm(copy, { asNew: true, copySecretsFrom: conn.id });
  }

  /** 「复制会话」的名称：原名加「副本」后缀，与已有重名时追加序号。 */
  function uniqueCopyName(base) {
    const name = (base || "").trim() || "新连接";
    const taken = new Set(connections.map((c) => (c.name || "").trim()));
    let candidate = `${name} 副本`;
    for (let i = 2; taken.has(candidate); i += 1) {
      candidate = `${name} 副本 ${i}`;
    }
    return candidate;
  }

  function closeForm() {
    $("modal-connection").hidden = true;
    draft = null;
  }

  function renderForm() {
    const form = $("conn-form");
    form.textContent = "";
    const rdp = isRdp(draft);

    const basics = [];
    // 协议选择仅在 RDP 开关打开、或正在编辑一条 RDP 连接时出现
    if (connFlags().rdp || rdp) basics.push(protocolField());
    basics.push(
      field("名称", null, bind(input("text", { placeholder: "例如 生产环境" }), draft, "name"), { compact: true }),
      field("主机", null, bind(input("text", { placeholder: "域名或 IP，例如 10.0.0.1" }), draft, "host"), { compact: true }),
      field(
        "端口",
        null,
        bind(input("number", { min: 1, max: 65535 }), draft, "port", toInt(rdp ? 3389 : 22)),
        { compact: true }
      ),
      field(
        "用户名",
        null,
        bind(input("text", { placeholder: rdp ? "域账号用户名（可留空）" : "root" }), draft, "username"),
        { compact: true }
      )
    );
    if (rdp) {
      basics.push(
        field("域", "Windows 域账号填写，留空使用本机账号", bind(input("text", { placeholder: "例如 CORP" }), draft, "domain"), {
          compact: true,
        })
      );
    }
    form.appendChild(section("基础", null, basics));

    if (rdp) {
      form.appendChild(
        section(
          "凭据",
          "密码保存在加密保险库中，不写入配置文件。Windows 写入系统凭据管理器交给 mstsc 免密登录；macOS 由「Windows App」自行管理凭据，这里的密码供「复制密码」使用。",
          [passwordField()]
        )
      );
    } else {
      form.appendChild(
        section("认证", "密码与 passphrase 保存在加密保险库中，不写入配置文件。", [
          authSelect("认证方式", "auth_kind", () => renderForm()),
          draft.auth_kind === "private_key" ? keyPathField("私钥路径", "key_path") : null,
          draft.auth_kind === "password" ? passwordField() : null,
          draft.auth_kind === "private_key" ? passphraseField() : null,
        ])
      );
    }

    if (connFlags().connection_group) {
      form.appendChild(
        section("分组", null, [
          field("分组名", null, bind(input("text", { placeholder: "留空将归入「未分组」" }), draft, "group_name"), { compact: true }),
        ])
      );
    }

    if (!rdp && connFlags().jump_host) form.appendChild(jumpSection());
  }

  /** 协议下拉：切换后端口换为该协议默认值，并重渲染专属字段。 */
  function protocolField() {
    const node = bind(select(PROTOCOLS), draft, "protocol");
    node.addEventListener("change", () => {
      draft.port = DEFAULT_PORT[draft.protocol] || 22;
      renderForm();
    });
    return field("协议", "SSH 终端或 Windows 远程桌面（RDP）", node, { compact: true });
  }

  /** 认证方式下拉：切换后需要重渲染，以便显示 / 隐藏该方式专属字段。 */
  function authSelect(label, path, onChange) {
    const node = bind(select(AUTH_KINDS), draft, path);
    node.addEventListener("change", onChange);
    return field(label, null, node, { compact: true });
  }

  function keyPathField(label, path) {
    const node = bind(input("text", { placeholder: "~/.ssh/id_ed25519" }), draft, path);
    const browse = pickerButton("选择私钥文件", (picked) => {
      node.value = picked;
      PShell.util.setPath(draft, path, picked);
    });
    return field(label, "支持 ~ 开头的路径", el("div", { class: "input-row" }, [node, browse]), {
      compact: true,
    });
  }

  function passwordField() {
    const node = input("password", {
      placeholder: draft.has_password ? "已保存在保险库，留空则不修改" : "尚未保存",
    });
    node.addEventListener("input", () => {
      // 空串表示「不修改」，只有非空才作为新密码提交
      draftSecrets.password = node.value === "" ? null : node.value;
    });
    const children = [node];
    if (draft.has_password) {
      children.push(
        el("button", {
          class: "btn ghost",
          type: "button",
          text: "清除",
          onclick: () => {
            draftSecrets.password = "";
            draft.has_password = false;
            node.value = "";
            node.placeholder = "保存后将删除已存密码";
          },
        })
      );
    }
    return field("密码", "仅写入加密保险库", el("div", { class: "input-row" }, children), {
      compact: true,
    });
  }

  function passphraseField() {
    const node = input("password", {
      placeholder: draft.has_passphrase ? "已保存在保险库，留空则不修改" : "私钥无口令可留空",
    });
    node.addEventListener("input", () => {
      draftSecrets.passphrase = node.value === "" ? null : node.value;
    });
    const children = [node];
    if (draft.has_passphrase) {
      children.push(
        el("button", {
          class: "btn ghost",
          type: "button",
          text: "清除",
          onclick: () => {
            draftSecrets.passphrase = "";
            draft.has_passphrase = false;
            node.value = "";
            node.placeholder = "保存后将删除已存口令";
          },
        })
      );
    }
    return field("私钥口令", "仅写入加密保险库", el("div", { class: "input-row" }, children), {
      compact: true,
    });
  }

  function jumpSection() {
    const enabled = !!draft.jump;
    const rows = [
      field(
        "启用跳板机",
        null,
        el("label", { class: "toggle-row" }, [
          el("input", {
            type: "checkbox",
            checked: enabled,
            onchange: (e) => {
              draft.jump = e.target.checked ? blankJump() : null;
              renderForm();
            },
          }),
        ]),
        { compact: true }
      ),
    ];

    if (enabled) {
      const jump = draft.jump;
      rows.push(
        field("跳板机主机", null, bind(input("text"), jump, "host"), { compact: true }),
        field("跳板机端口", null, bind(input("number", { min: 1, max: 65535 }), jump, "port", toInt(22)), { compact: true }),
        field("跳板机用户", null, bind(input("text"), jump, "username"), { compact: true }),
        (function () {
          const node = bind(select(AUTH_KINDS), jump, "auth_kind");
          node.addEventListener("change", renderForm);
          return field("跳板机认证", null, node, { compact: true });
        })()
      );
      if (jump.auth_kind === "private_key") {
        rows.push(
          field("跳板机私钥", "留空则使用默认私钥", bind(input("text"), jump, "key_path"), { compact: true })
        );
      }
      if (jump.auth_kind === "password") {
        const node = input("password", { placeholder: "留空则不修改已保存的密码" });
        node.addEventListener("input", () => {
          draftSecrets.jump_password = node.value === "" ? null : node.value;
        });
        rows.push(field("跳板机密码", "仅写入加密保险库", node, { compact: true }));
      }
    }

    return section("跳板机", null, rows);
  }

  /** 需要原生文件选择框；插件不可用时返回 null，由调用方自动省略该按钮。 */
  function pickerButton(title, onPick) {
    const dialog = window.__TAURI__ && window.__TAURI__.dialog;
    if (!dialog || typeof dialog.open !== "function") return null;
    return el("button", {
      class: "btn ghost",
      type: "button",
      text: "浏览…",
      onclick: async () => {
        try {
          const picked = await dialog.open({ multiple: false, directory: false, title });
          if (typeof picked === "string" && picked) onPick(picked);
        } catch (err) {
          toast(errorText(err), "error");
        }
      },
    });
  }

  /** 端口等字段被清空时会解析成回退值，保存前再兜一次底。 */
  function normalizeDraft() {
    draft.protocol = draft.protocol === "rdp" ? "rdp" : "ssh";
    const rdp = draft.protocol === "rdp";
    draft.port = toInt(rdp ? 3389 : 22)(String(draft.port));
    draft.name = (draft.name || "").trim();
    draft.host = (draft.host || "").trim();
    draft.username = (draft.username || "").trim();
    const domain = (draft.domain || "").trim();
    draft.domain = domain === "" ? null : domain;
    const group = (draft.group_name || "").trim();
    draft.group_name = group === "" ? null : group;
    if (draft.key_path === "") draft.key_path = null;
    if (!rdp && draft.jump) {
      draft.jump.port = toInt(22)(String(draft.jump.port));
      draft.jump.host = (draft.jump.host || "").trim();
      draft.jump.username = (draft.jump.username || "").trim();
      if (!draft.jump.host) draft.jump = null;
    }
  }

  async function save() {
    if (!draft) return;
    normalizeDraft();
    const rdp = draft.protocol === "rdp";
    if (!draft.host || (!rdp && !draft.username)) {
      toast(rdp ? "请填写主机" : "请填写主机与用户名", "error");
      return;
    }
    try {
      const saved = await PShell.ipc.saveConnection({
        connection: draft,
        password: draftSecrets.password,
        passphrase: draftSecrets.passphrase,
        jump_password: draftSecrets.jump_password,
        copy_secrets_from: draftCopySecretsFrom,
      });
      closeForm();
      await refresh();
      toast(`已保存连接「${saved.name}」`, "ok");
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  async function test() {
    if (!draft) return;
    normalizeDraft();
    const rdp = draft.protocol === "rdp";
    if (!draft.host || (!rdp && !draft.username)) {
      toast(rdp ? "请填写主机" : "请填写主机与用户名", "error");
      return;
    }

    const button = $("conn-test");
    const label = button.textContent;

    // 远程桌面没有 SSH 握手，「测试」退化为探测 RDP 端口
    if (rdp) {
      button.disabled = true;
      button.textContent = "测试中…";
      try {
        await PShell.rdp.probe(draft);
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
      return;
    }

    const params = paramsFor(draft);
    // 新建连接尚未存过密码时，允许用当前输入临时测试（不落盘）
    if (draft.auth_kind === "password" && draftSecrets.password) {
      params.auth = { kind: "password", password: draftSecrets.password };
    }
    button.disabled = true;
    button.textContent = "测试中…";
    try {
      const method = await PShell.ssh.test(params);
      toast(`连接成功，认证方式：${method}`, "ok");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      button.disabled = false;
      button.textContent = "测试连接";
    }
  }

  /** 删除一条连接（编辑弹窗按钮与右键菜单共用）。 */
  async function removeById(conn) {
    if (!conn || !conn.id) return;
    const name = conn.name || conn.host;
    const ok = await ask(`删除连接「${name}」？其保存在加密保险库中的密码也会一并删除，操作不可撤销。`, {
      title: "删除确认",
      okText: "删除",
      kind: "danger",
    });
    if (!ok) return;
    try {
      await PShell.ipc.deleteConnection(conn.id);
      // 正开在编辑弹窗里的就是这条连接时，一并关掉
      if (draft && !draftIsNew && draft.id === conn.id) closeForm();
      await refresh();
      toast("已删除该连接", "ok");
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  async function remove() {
    if (!draft || draftIsNew) return;
    return removeById(draft);
  }

  function openPicker() {
    openForm(null);
  }

  PShell.connections = {
    setConfig,
    refresh,
    render,
    openForm,
    openPicker,
    connectTo,
    paramsFor,
    onQuickSubmit,
    save,
    test,
    remove,
    removeById,
  };
})(window.PShell);