/* 设置面板：配置驱动的表单 + 功能开关一览 + 模块状态。
 *
 * 表单控件与 `draft`（配置的深拷贝）即时双向绑定，因此没有「收集表单」这一步；
 * 只有点击保存才把 draft 交给 save_config，由后端统一 replace 并同步模块生命周期。 */
(function (PShell) {
  "use strict";

  const { el, $, toast, errorText, deepClone, ask } = PShell.util;
  const { field, input, select, section, bind, toInt, toFloat, listEditor } = PShell.form;
  const t = PShell.i18n.t;

  const CATEGORIES = [
    { id: "general", label: "通用" },
    { id: "terminal", label: "终端" },
    { id: "connection", label: "连接" },
    { id: "flags", label: "功能开关" },
    { id: "ai", label: "AI 助手" },
    { id: "git", label: "Git 同步" },
    { id: "shortcuts", label: "快捷键" },
    { id: "about", label: "关于" },
  ];

  const LANGUAGES = [
    { value: "zh-CN", label: "简体中文" },
    { value: "en-US", label: "English" },
  ];

  const THEME_MODES = [
    { value: "dark", label: "深色" },
    { value: "light", label: "浅色" },
    { value: "system", label: "跟随系统" },
  ];

  const CURSOR_STYLES = [
    { value: "block", label: "方块" },
    { value: "underline", label: "下划线" },
    { value: "bar", label: "竖线" },
  ];

  const SCOPE_OPTIONS = [
    { value: "config", label: "仅连接配置" },
    { value: "snippets", label: "仅命令片段" },
    { value: "all", label: "全部" },
  ];

  /** 功能开关的分组顺序与标题，与 feature_flags.rs / FEATURES.md 的章节对应。 */
  const FLAG_GROUPS = [
    { key: "connection", title: "连接与传输（§3）" },
    { key: "sync", title: "同步 / Git（§4）" },
    { key: "ai", title: "AI 助手（§5）" },
    { key: "auxiliary", title: "辅助功能（§6）" },
  ];

  /** 开关的中文说明。键为 flatten() 给出的路径；未登记的路径会退回显示原始路径。 */
  const FLAG_META = {
    "connection.tabs": { label: "多标签", hint: "关闭后同一时刻只允许一个会话" },
    "connection.split_view": { label: "分屏", hint: "同一窗口内并排查看多个会话" },
    "connection.sftp": { label: "SFTP 文件传输" },
    "connection.port_forward": { label: "端口转发" },
    "connection.jump_host": { label: "跳板机", hint: "ProxyJump：先连跳板机再转发到目标" },
    "connection.session_log": { label: "会话日志", hint: "本地留存会话输出，便于回溯" },
    "connection.auto_reconnect": { label: "断线自动重连", hint: "按指数退避重试" },
    "connection.connection_group": { label: "连接分组", hint: "侧栏按分组名归类连接" },
    "connection.import_export": { label: "配置导入导出" },
    "connection.rdp": {
      label: "远程桌面（RDP）",
      hint: "新建连接时可选 RDP 协议打开 Windows 远程桌面：Windows 调用系统 mstsc，macOS 调用微软「Windows App」（需自行安装）",
    },
    "connection.quick_connect": { label: "快捷连接", hint: "侧栏直接输入 user@host:port" },
    "connection.sync_input": {
      label: "同步输入",
      hint: "把一台终端上的输入广播到同一同步组内的标签；分组与组内同步开关在标签右键菜单中操作",
    },
    "connection.ime_auto_switch": {
      label: "输入法自动切换",
      hint: "终端聚焦时切到英文输入源、失焦时还原（仅 macOS）；终端内可输中文需切到输入法模式",
    },
    "sync.git_sync": { label: "Git 同步", hint: "用 Git 仓库同步配置，不做云同步" },
    "sync.git_sync_scope": { label: "同步范围" },
    "sync.git_sync_secrets": {
      label: "同步敏感字段密文",
      hint: "关闭后 secrets.json 不再随 Git 同步（主密码冲突时可临时关闭）",
    },
    "sync.git_conflict_prompt": { label: "冲突提示", hint: "检测到冲突时不自动合并" },
    "sync.git_status_badge": { label: "状态徽标", hint: "显示 ahead/behind 与脏文件数" },
    "sync.git_commit_template": { label: "提交模板", hint: "使用下方的提交信息模板" },
    "sync.git_multi_repo": { label: "多仓库" },
    "sync.git_cli_fallback": { label: "允许回退系统 git CLI", hint: "仅在 libgit2 不支持时使用" },
    "ai.ai_assistant": { label: "AI 助手", hint: "总开关；关闭时其余 AI 选项不生效" },
    "ai.ai_streaming": { label: "流式响应", hint: "通过 SSE 逐字返回" },
    "ai.ai_danger_warning": { label: "危险命令提示" },
    "ai.ai_context_inject": { label: "上下文注入", hint: "附带最近的终端输出" },
    "auxiliary.snippets": { label: "命令片段" },
    "auxiliary.global_search": { label: "全局搜索" },
    "auxiliary.command_history": { label: "命令历史" },
    "auxiliary.quick_panel": { label: "快捷面板" },
    "auxiliary.system_tray": { label: "系统托盘" },
    "auxiliary.auto_update": { label: "自动更新" },
    "auxiliary.theme": { label: "主题", hint: "关闭后外观设置不生效" },
    "auxiliary.shortcuts": { label: "快捷键", hint: "关闭后不响应自定义组合键" },
    "auxiliary.crash_log": { label: "崩溃日志" },
  };

  /** 开关路径 → 模块标识。有此项的开关会在行尾显示模块运行状态徽标。 */
  const FLAG_MODULE = {
    "sync.git_sync": "git_sync",
    "ai.ai_assistant": "ai_assistant",
    "auxiliary.snippets": "snippets",
    "auxiliary.global_search": "global_search",
    "auxiliary.command_history": "command_history",
    "auxiliary.theme": "theme",
    "auxiliary.shortcuts": "shortcuts",
    "auxiliary.quick_panel": "quick_panel",
    "auxiliary.system_tray": "system_tray",
    "connection.sftp": "sftp",
    "connection.port_forward": "port_forward",
    "connection.session_log": "session_log",
    "connection.import_export": "import_export",
    "connection.rdp": "rdp",
  };

  const MODULE_LABELS = {
    git_sync: "Git 同步",
    ai_assistant: "AI 助手",
    snippets: "命令片段",
    global_search: "全局搜索",
    command_history: "命令历史",
    theme: "主题",
    shortcuts: "快捷键",
    quick_panel: "快捷面板",
    system_tray: "系统托盘",
    sftp: "SFTP",
    port_forward: "端口转发",
    session_log: "会话日志",
    import_export: "配置导入导出",
    rdp: "远程桌面",
  };

  let draft = null;
  let flags = [];
  let modules = [];
  let info = null;
  let activeCat = "general";
  /** 已在加密保险库中保存 API Key 的模型 id 集合 */
  let configuredModelIds = new Set();
  /** 后端返回的可选协议清单（值 / 展示名 / 路径后缀 / 说明），供协议下拉与后缀提示使用 */
  let protocolList = [];
  /** AI 模型编辑列表：与 draft.ai.models 解耦，模型逐条测试 / 保存，不随整页保存提交 */
  let aiModels = [];
  /** 后端配置里已存在的模型 id；不在其中的是「尚未保存的新条目」 */
  let savedModelIds = new Set();
  /** 本次设置会话中已通过连通性测试的模型 id；新增条目必须通过后才能保存 */
  let testedModelIds = new Set();
  /** 本次提交的 Git 密码：键为 remote 名；缺失 = 不修改，"" = 删除，非空 = 写入 */
  let gitPasswordInputs = new Map();
  /** 已在加密保险库中保存密码 / 令牌的 remote 名 */
  let gitCredentialNames = new Set();
  /** 「关于」页里最近一次读取的崩溃日志（CrashLogInfo）；null = 尚未读取 */
  let crashTail = null;
  let crashBusy = false;
  /** 保险库状态（VaultStatus）；null = 尚未读取 */
  let vaultState = null;

  // ---------------------------------------------------------------------------
  // 通用控件助手
  // ---------------------------------------------------------------------------

  function toggler(path) {
    return el("label", { class: "toggle-row" }, [bind(input("checkbox"), draft, path)]);
  }

  function toggleField(label, hint, path) {
    return field(label, hint, toggler(path));
  }

  function textField(label, hint, path, attrs) {
    return field(label, hint, bind(input("text", attrs || {}), draft, path));
  }

  function numberField(label, hint, path, fallback, attrs) {
    return field(label, hint, bind(input("number", attrs || {}), draft, path, toInt(fallback)));
  }

  function floatField(label, hint, path, fallback, attrs) {
    return field(label, hint, bind(input("number", attrs || {}), draft, path, toFloat(fallback)));
  }

  function selectField(label, hint, path, options) {
    return field(label, hint, bind(select(options), draft, path));
  }

  function notice(text) {
    return el("p", { class: "inline-note", text });
  }

  function badge(text, kind) {
    return el("span", { class: "badge " + (kind || ""), text });
  }

  /** 把模块状态渲染成徽标。enabled 但未 initialized 说明实现还没落地。 */
  function moduleBadge(status) {
    if (!status) return badge("未注册", "off");
    if (!status.enabled) return badge("已关闭", "off");
    if (status.initialized) return badge("已启用", "on");
    return badge("已启用 · 未初始化", "warn");
  }

  function emptyToNull(value) {
    const text = (value || "").trim();
    return text === "" ? null : text;
  }

  // ---------------------------------------------------------------------------
  // 各分类页面
  // ---------------------------------------------------------------------------

  function renderGeneral() {
    const themeOn = !!draft.features.auxiliary.theme;
    return [
      masterPasswordSection(),
      section(t("settings.section.ui", "界面"), null, [languageField()]),
      section(
        t("settings.section.theme", "主题"),
        themeOn ? null : "「主题」开关已关闭，以下设置暂不生效。",
        [
          selectField("明暗模式", "「跟随系统」会响应系统外观变化", "theme.mode", THEME_MODES),
          textField("强调色", "CSS 颜色值，留空则用默认强调色", "theme.accent", {
            placeholder: "#4ade80",
          }),
        ]
      ),
    ];
  }

  /**
   * 主密码：查看状态 + 用当前密码换成新密码。
   *
   * 保险库里的密文会随 Git 同步分发，所以改完密码要尽快把新的 secrets.json 推到远端，
   * 否则其它设备同步到的仍是旧密文、需要用旧密码解锁。这里在改成功后主动同步一次
   * （仅在 Git 同步已启用时；同步失败只提示，不影响改密本身已经成功的事实）。
   */
  function masterPasswordSection() {
    const configured = !!(vaultState && vaultState.configured);
    const unlocked = !!(vaultState && vaultState.unlocked);

    const currentInput = input("password", { placeholder: "当前主密码", autocomplete: "off" });
    const nextInput = input("password", { placeholder: "新主密码", autocomplete: "off" });
    const againInput = input("password", { placeholder: "再次输入新主密码", autocomplete: "off" });
    const statusNode = el("p", { class: "inline-note", text: "" });
    const button = el("button", {
      class: "btn primary",
      type: "button",
      text: "修改主密码",
      onclick: change,
    });

    function setStatus(text, kind) {
      statusNode.className = "inline-note" + (kind ? " " + kind : "");
      statusNode.textContent = text || "";
    }

    async function change() {
      const current = currentInput.value;
      const next = nextInput.value;
      if (!current) {
        setStatus("请输入当前主密码", "error");
        return;
      }
      if (!next) {
        setStatus("请输入新主密码", "error");
        return;
      }
      if (next !== againInput.value) {
        setStatus("两次输入的新主密码不一致", "error");
        return;
      }
      const confirmed = await ask(
        "修改主密码后，本机保险库会立即用新密码重新加密。其它设备需要同步后用新主密码解锁，旧密码将失效。确定继续？",
        { title: "修改主密码", okText: "继续" }
      );
      if (!confirmed) return;

      button.disabled = true;
      setStatus("正在重新加密保险库…", "");
      try {
        await PShell.ipc.vaultChangePassword(current, next);
        currentInput.value = "";
        nextInput.value = "";
        againInput.value = "";
        vaultState = { configured: true, unlocked: true };
        setStatus("主密码已修改。", "ok");
        toast("主密码已修改", "ok");
        await syncAfterPasswordChange(statusNode);
      } catch (err) {
        setStatus("修改失败：" + errorText(err), "error");
        toast(errorText(err), "error");
      } finally {
        button.disabled = false;
      }
    }

    const rows = [
      el("p", {
        class: "inline-note",
        text: configured
          ? unlocked
            ? "保险库已设置并解锁。"
            : "保险库已设置，当前处于锁定状态。"
          : "尚未设置主密码。",
      }),
      field("当前主密码", null, currentInput),
      field("新主密码", "仅本机生效，其它设备需用新密码解锁", nextInput),
      field("确认新主密码", null, againInput),
      el("div", { class: "log-actions" }, [button]),
      statusNode,
    ];
    return section(
      "主密码",
      "SSH 密码 / API Key / Git 凭据等都以此密码加密保存在本地，并随 Git 同步以密文分发。改密后需要让新的密文同步出去，其它设备才能用新密码解锁。",
      rows
    );
  }

  /**
   * 改密后主动同步一次，把新的 secrets.json 密文推到远端。
   *
   * 同步范围不含配置（`secrets.json`）时密文不会被分发，此时只提示、不白跑一次网络同步。
   * Git 同步未启用或同步失败也一样只提示，不回滚、不阻断——改密本身已经成功。
   */
  async function syncAfterPasswordChange(statusNode) {
    const gitOn = modules.some((m) => m.id === "git_sync" && m.enabled);
    if (!gitOn) {
      statusNode.textContent += " Git 同步未启用，仓库中的旧密文需在启用后同步更新。";
      return;
    }

    // 用后端实际生效的同步范围判断（草稿可能还没保存），只有含连接配置才会带上 secrets.json
    let scope = "config";
    try {
      const status = await PShell.ipc.gitStatus();
      scope = (status && status.scope) || "config";
    } catch (_) {
      /* 读不到状态就按默认范围继续，同步结果本身会给出反馈 */
    }
    if (scope === "snippets") {
      statusNode.textContent +=
        " 当前同步范围为「仅命令片段」，不含 secrets.json，新密文未分发；如需分发请改为「仅连接配置」或「全部」后再同步。";
      return;
    }

    try {
      const outcome = await PShell.ipc.gitSyncNow();
      const message = (outcome && outcome.message) || "已同步";
      statusNode.textContent += " 已同步：" + message;
      if (PShell.gitSync && typeof PShell.gitSync.refresh === "function") {
        PShell.gitSync.refresh().catch(() => {});
      }
    } catch (err) {
      statusNode.textContent +=
        " 自动同步失败：" + errorText(err) + "；请到「Git 同步」面板手动同步。";
      toast("主密码已修改，但自动同步失败", "warn");
    }
  }

  /** 「语言」字段：通用页的基础设置，改动后立即切换语言并重绘设置面板与模块概览。 */
  function languageField() {
    const node = bind(select(LANGUAGES), draft, "language");
    node.addEventListener("change", () => {
      PShell.i18n.setLocale(draft.language).then(() => {
        renderNav();
        renderBody();
      });
    });
    return field(t("settings.language", "语言"), t("settings.language.hint", "切换后立即生效。"), node);
  }

  function renderTerminal() {
    return section("终端外观", "保存后立即作用于所有已打开的终端。", [
      textField("字体", "CSS font-family 列表", "terminal.font_family"),
      numberField("字号", "像素", "terminal.font_size", 13, { min: 6, max: 40 }),
      floatField("行高", "倍数，如 1.2", "terminal.line_height", 1.2, {
        step: "0.05",
        min: 1,
        max: 3,
      }),
      numberField("回滚缓冲", "保留的历史行数", "terminal.scrollback", 5000, { min: 0 }),
      selectField("光标样式", null, "terminal.cursor_style", CURSOR_STYLES),
      toggleField("光标闪烁", null, "terminal.cursor_blink"),
      toggleField("响铃", "远端触发 BEL 时发出提示音", "terminal.bell"),
      toggleField("选中即复制", "选中文本自动写入剪贴板", "terminal.copy_on_select"),
      toggleField("右击菜单", "终端内右击弹出「复制 / 粘贴」菜单", "terminal.right_click_menu"),
      toggleField(
        "本地回显",
        "按键立即上屏，远端回显到达后再对齐；关闭后字符只在远端回显到达时出现",
        "terminal.local_echo"
      ),
      textField("TERM", "传给远端的终端类型", "terminal.term_type"),
      textField("背景色", "CSS 颜色值，留空则跟随主题", "terminal.background", {
        placeholder: "#16181d",
      }),
      textField("前景色", "CSS 颜色值，留空则跟随主题", "terminal.foreground", {
        placeholder: "#dfe3ea",
      }),
      numberField("心跳间隔", "秒；由 SSH 核心用于保活", "terminal.keepalive_secs", 30, {
        min: 0,
      }),
    ]);
  }

  function renderConnection() {
    const sessionLogOn = !!draft.features.connection.session_log;
    return [
      section("自动重连", "断线后按指数退避重试，直到达到最大次数。", [
        toggleField("启用自动重连", null, "features.connection.auto_reconnect"),
        numberField(
          "最大尝试次数",
          "超过后进入「连接失败」，可手动重连",
          "features.connection.auto_reconnect_max_attempts",
          5,
          { min: 0, max: 100 }
        ),
        numberField(
          "基础退避间隔",
          "毫秒；实际间隔按 2^n 增长，上限 30 秒",
          "features.connection.auto_reconnect_base_delay_ms",
          1000,
          { min: 100, step: "100" }
        ),
      ]),
      section(
        "会话日志",
        sessionLogOn ? null : "「会话日志」开关已关闭，该设置暂不生效。",
        [
          numberField(
            "保留天数",
            "超过该天数的日志会被清理",
            "features.connection.session_log_retention_days",
            30,
            { min: 1 }
          ),
        ]
      ),
    ];
  }

  /** 功能开关：完全由 flatten() 的返回驱动，新增开关无需改前端即可出现。 */
  function renderFlags() {
    const nodes = [
      notice("开关与 FEATURES.md 一一对应。新增功能必须先在 feature_flags.rs 注册，再登记文档。"),
    ];
    FLAG_GROUPS.forEach((group) => {
      const entries = flags.filter((entry) => entry.path.indexOf(group.key + ".") === 0);
      if (!entries.length) return;
      nodes.push(el("div", { class: "flag-group-title", text: t("flags.group." + group.key, group.title) }));
      entries.forEach((entry) => nodes.push(flagRow(entry)));
    });
    return el("div", { class: "settings-section" }, nodes);
  }

  function flagRow(entry) {
    const meta = FLAG_META[entry.path] || {};
    const label = t("flags." + entry.path, meta.label || entry.path);
    const path = "features." + entry.path;

    if (entry.path === "sync.git_sync_scope") {
      return selectField(label, meta.hint, path, SCOPE_OPTIONS);
    }

    const control = toggler(path);
    const moduleId = FLAG_MODULE[entry.path];
    if (moduleId) {
      const status = modules.filter((m) => m.id === moduleId)[0];
      control.appendChild(moduleBadge(status));
    }
    return field(label, meta.hint || "", control);
  }

  function renderAi() {
    const aiFlags = (draft.features && draft.features.ai) || {};
    const nodes = [];
    if (!aiFlags.ai_assistant) {
      nodes.push(
        notice("AI 助手当前已关闭：请先在「功能开关」中打开「AI 助手」并保存，「测试连通性 / 保存」才会生效。")
      );
    }
    nodes.push(modelsSection());
    return nodes;
  }

  /**
   * 可留空的数值绑定：空串写回 `null`，后端据此回落到该参数的默认值。
   * 整数项取整，否则 1.5 之类会写进 u32 字段导致保存失败。
   */
  function optionalNumber(node, model, path, integer) {
    const current = model[path];
    node.value = current == null ? "" : String(current);
    const write = () => {
      const raw = node.value.trim();
      if (raw === "") {
        model[path] = null;
        return;
      }
      const n = integer ? parseInt(raw, 10) : parseFloat(raw);
      model[path] = Number.isFinite(n) ? n : null;
    };
    node.addEventListener("input", write);
    node.addEventListener("change", write);
    return node;
  }

  /** 单个模型的一组生成参数；全部可留空，留空即用默认值。 */
  function modelParamFields(model) {
    const num = (attrs) => input("number", attrs);
    return [
      field(
        "采样温度",
        "0 ~ 2；留空用默认值",
        optionalNumber(num({ step: "0.1", min: 0, max: 2, placeholder: "0.2" }), model, "temperature", false)
      ),
      field(
        "最大输出 token",
        "单次回复的 max_tokens 上限；留空用默认值",
        optionalNumber(num({ min: 1, placeholder: "2048" }), model, "max_tokens", true)
      ),
      field(
        "最大输入 token",
        "模型上下文窗口；用于 AI 面板底部估算上下文占比，留空用默认值",
        optionalNumber(num({ min: 1, placeholder: "128000" }), model, "max_input_tokens", true)
      ),
      field(
        "请求超时",
        "秒；留空用默认值",
        optionalNumber(num({ min: 1, placeholder: "60" }), model, "timeout_secs", true)
      ),
      field(
        "上下文注入",
        "附带最近多少字节的终端输出；留空用默认值",
        optionalNumber(num({ min: 0, placeholder: "4096" }), model, "context_bytes", true)
      ),
    ];
  }

  /** 协议下拉的选项；后端清单不可用时至少保留 OpenAI 兼容一项，避免下拉为空。 */
  function protocolOptions() {
    const list = protocolList.length
      ? protocolList
      : [{ value: "openai", label: "OpenAI 兼容（Chat Completions）", suffix: "/chat/completions", note: "" }];
    return list.map((p) => ({ value: p.value, label: p.label }));
  }

  /** 按值取协议元信息（含后缀 suffix、说明 note）；找不到时返回 null。 */
  function protocolSpec(value) {
    const want = value || "openai";
    return protocolList.filter((p) => p.value === want)[0] || null;
  }

  /** 生成模型条目的稳定标识。与后端一样用 uuid，保证 API Key 的保险库键名不冲突。 */
  function newModelId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "m-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function addModel() {
    aiModels.push({
      id: newModelId(),
      name: "",
      model: "",
      base_url: "",
      protocol: "openai",
      temperature: null,
      max_tokens: null,
      max_input_tokens: null,
      timeout_secs: null,
      context_bytes: null,
    });
    renderBody();
  }

  /**
   * 用后端返回的模型列表对齐本地状态。
   *
   * 模型是「逐条保存」的，draft 里的模型列表必须始终等于后端已保存的列表，
   * 否则整体保存时会把界面上尚未测通的新条目一起写进配置、绕过测试门槛。
   * 本地尚未保存的新条目保留在界面上，等待用户单独保存。
   */
  function applyServerModels(models) {
    draft.ai = draft.ai || {};
    draft.ai.models = models.map((m) => deepClone(m));
    savedModelIds = new Set(models.map((m) => m.id));
    const byId = new Map(models.map((m) => [m.id, m]));
    aiModels = aiModels.map((m) => (byId.has(m.id) ? deepClone(byId.get(m.id)) : m));
    models.forEach((m) => {
      if (!aiModels.some((local) => local.id === m.id)) aiModels.push(deepClone(m));
    });
  }

  /** 整理成 AiModelConfig 的形状：只去首尾空白；生成参数保留 null（= 用默认值）。 */
  function normalizeModel(model) {
    return {
      id: model.id,
      name: (model.name || "").trim(),
      model: (model.model || "").trim(),
      base_url: (model.base_url || "").trim(),
      protocol: model.protocol || "openai",
      temperature: model.temperature == null ? null : model.temperature,
      max_tokens: model.max_tokens == null ? null : model.max_tokens,
      max_input_tokens: model.max_input_tokens == null ? null : model.max_input_tokens,
      timeout_secs: model.timeout_secs == null ? null : model.timeout_secs,
      context_bytes: model.context_bytes == null ? null : model.context_bytes,
    };
  }

  /**
   * 逐条保存 / 删除后刷新主界面 AI 面板的模型下拉。
   *
   * 只把 AI 相关配置推给面板，不整份 draft 应用一遍——否则草稿里其它还没点保存的
   * 改动会被提前生效。模型列表既然已经落库，面板就应该立刻能选到。
   */
  function refreshAiPanel() {
    if (PShell.ai && typeof PShell.ai.setConfig === "function") {
      PShell.ai.setConfig(draft);
    }
  }

  /**
   * 单个自定义模型卡片：字段 + 该条目自己的「测试连通性 / 保存 / 删除」。
   *
   * 逐条保存让「测通一个、存一个」成为最短路径；新增条目在测通之前保存按钮保持禁用，
   * 避免把地址 / Key / 模型名有误的条目写进配置，之后在面板里反复报错。
   */
  function modelRow(model, index) {
    if (!model.id) model.id = newModelId();
    const id = model.id;
    const stored = configuredModelIds.has(id);
    const isSaved = savedModelIds.has(id);

    const statusNode = el("p", { class: "inline-note", text: "" });
    const testBtn = el("button", {
      class: "btn ghost",
      type: "button",
      text: "测试连通性",
      onclick: runTest,
    });
    const saveBtn = el("button", {
      class: "btn primary",
      type: "button",
      text: "保存",
      onclick: runSave,
    });

    const nameNode = bind(input("text", { placeholder: "如「DeepSeek 对话」" }), model, "name");
    const modelIdNode = bind(input("text", { placeholder: "如 deepseek-chat" }), model, "model");
    const urlNode = bind(
      input("text", { placeholder: "如 https://api.deepseek.com/v1" }),
      model,
      "base_url"
    );
    // 协议下拉：决定 base_url 之后拼接的路径后缀与请求 / 响应格式
    const protocolNode = select(protocolOptions());
    protocolNode.value = model.protocol || "openai";
    protocolNode.title = "决定请求地址后缀与请求 / 响应格式";
    // 「会加什么后缀」提示：随协议与地址实时更新
    const endpointNote = el("p", { class: "inline-note", text: "" });
    function syncEndpointHint() {
      const base = (model.base_url || "").trim().replace(/\/+$/, "");
      const shown = base || "（未填 API 地址）";
      const spec = protocolSpec(model.protocol);
      endpointNote.textContent = spec
        ? "实际请求地址：" + shown + spec.suffix + (spec.note ? "；" + spec.note : "")
        : "实际请求地址：" + shown;
    }
    protocolNode.addEventListener("change", () => {
      model.protocol = protocolNode.value;
      syncEndpointHint();
      invalidate();
    });
    urlNode.addEventListener("input", syncEndpointHint);
    syncEndpointHint();
    const keyNode = input("password", {
      placeholder: stored ? "已保存在加密保险库，留空则不修改" : "粘贴该模型的 API Key",
    });

    const keyControl = el("div", {}, [
      keyNode,
      el("p", { class: "inline-note" }, [
        stored ? badge("已配置", "on") : badge("未配置", "off"),
        el("span", { text: stored ? " 保险库中已有该模型的 Key" : " 尚未保存 Key" }),
      ]),
    ]);

    /** 测试结果文案；空串表示尚无结果，此时状态行用来提示保存门槛。 */
    let statusText = "";
    function setStatus(text, kind) {
      statusText = (text || "").trim();
      statusNode.className = "inline-note" + (kind ? " " + kind : "");
      statusNode.textContent = text || "";
    }

    function syncActions() {
      const gated = !savedModelIds.has(id) && !testedModelIds.has(id);
      saveBtn.disabled = gated;
      saveBtn.title = gated ? "新增模型需先通过连通性测试" : "保存该模型到模型列表";
      // 门槛提示只在没有测试结果时占用状态行，避免盖掉「测试通过 / 失败原因」
      if (!statusText) {
        setStatus(gated ? "新增模型：请先点击「测试连通性」，通过后才能保存。" : "", "");
      }
    }

    /** 地址 / 模型名 / Key 一变，之前的测试结论就不再对应当前配置，必须重新测。 */
    function invalidate() {
      testedModelIds.delete(id);
      setStatus("", "");
      syncActions();
    }
    [nameNode, modelIdNode, urlNode, keyNode].forEach((node) =>
      node.addEventListener("input", invalidate)
    );

    /** 保存时给后端的 api_key：null = 不修改保险库，非空 = 写入。 */
    function apiKeyPayload() {
      const typed = keyNode.value.trim();
      return typed === "" ? null : typed;
    }

    async function runTest() {
      const payload = {
        id: id,
        name: (model.name || "").trim(),
        model: (model.model || "").trim(),
        base_url: (model.base_url || "").trim(),
        protocol: model.protocol || "openai",
        api_key: apiKeyPayload(),
        timeout_secs: model.timeout_secs == null ? null : model.timeout_secs,
      };
      if (!payload.model) {
        toast("请先填写模型 ID", "warn");
        return;
      }
      if (!payload.base_url) {
        toast("请先填写 API 地址", "warn");
        return;
      }
      if (payload.api_key == null && !configuredModelIds.has(id)) {
        toast("请先填写该模型的 API Key", "warn");
        return;
      }

      testBtn.disabled = true;
      testBtn.textContent = "测试中…";
      setStatus("正在测试连通性…", "");
      try {
        const outcome = await PShell.ipc.aiTestModel(payload);
        testedModelIds.add(id);
        const cost = outcome && outcome.elapsed_ms != null ? "（" + outcome.elapsed_ms + " ms）" : "";
        setStatus("连通性测试通过" + cost + "，可以保存。", "ok");
        toast("连通性测试通过", "ok");
      } catch (err) {
        testedModelIds.delete(id);
        setStatus("测试失败：" + errorText(err), "error");
        toast(errorText(err), "error");
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = "测试连通性";
        syncActions();
      }
    }

    async function runSave() {
      if (!savedModelIds.has(id) && !testedModelIds.has(id)) {
        toast("请先点击「测试连通性」，验证通过后再保存", "warn");
        return;
      }
      const payload = normalizeModel(model);
      if (!payload.model) {
        toast("请先填写模型 ID", "warn");
        return;
      }
      if (!payload.base_url) {
        toast("请先填写 API 地址", "warn");
        return;
      }
      const apiKey = apiKeyPayload();
      if (apiKey == null && !configuredModelIds.has(id)) {
        toast("请先填写该模型的 API Key", "warn");
        return;
      }

      saveBtn.disabled = true;
      try {
        const result = await PShell.ipc.aiSaveModel(payload, apiKey);
        applyServerModels((result && result.models) || []);
        if (apiKey != null) configuredModelIds.add(id);
        refreshAiPanel();
        toast("已保存模型「" + (payload.name || payload.model) + "」", "ok");
        renderBody();
      } catch (err) {
        saveBtn.disabled = false;
        toast(errorText(err), "error");
      }
    }

    async function runDelete() {
      const label = (model.name || model.model || "该模型").trim();
      const confirmed = await ask(
        "删除模型「" + label + "」？若已保存，保险库中的 API Key 也会一并清除。",
        { title: "删除确认", okText: "删除", kind: "danger" }
      );
      if (!confirmed) return;

      // 后端已存在的条目要同步删除；只是界面上新加、还没保存过的直接丢掉即可
      if (savedModelIds.has(id)) {
        try {
          const result = await PShell.ipc.aiDeleteModel(id);
          applyServerModels((result && result.models) || []);
        } catch (err) {
          toast(errorText(err), "error");
          return;
        }
      }
      configuredModelIds.delete(id);
      testedModelIds.delete(id);
      aiModels = aiModels.filter((m) => m.id !== id);
      refreshAiPanel();
      toast("已删除模型「" + label + "」", "ok");
      renderBody();
    }

    syncActions();
    if (testedModelIds.has(id)) setStatus("连通性测试已通过，可以保存。", "ok");

    return el("div", { class: "ai-model-row" }, [
      el("div", { class: "ai-model-head" }, [
        el("span", { class: "ai-model-title", text: "模型 " + (index + 1) }),
        el("div", { class: "ai-model-head-actions" }, [
          isSaved ? badge("已保存", "on") : badge("未保存", "warn"),
          el("button", { class: "btn ghost", type: "button", text: "删除", onclick: runDelete }),
        ]),
      ]),
      field("展示名", null, nameNode),
      field("模型 ID", null, modelIdNode),
      field("API 地址", null, urlNode),
      field("协议", "决定请求地址后缀与请求 / 响应格式", protocolNode),
      endpointNote,
      field("API Key", "留空则沿用保险库中已保存的 Key", keyControl),
      ...modelParamFields(model),
      el("div", { class: "log-actions" }, [testBtn, saveBtn]),
      statusNode,
    ]);
  }

  function modelsSection() {
    const rows = aiModels.length
      ? aiModels.map((model, index) => modelRow(model, index))
      : [notice("尚未添加模型。添加后即可在 AI 助手面板中选择使用。")];
    return section(
      "自定义模型",
      "每个模型独立配置协议、API 地址、API Key 与生成参数，可混合不同供应商（OpenAI、DeepSeek、Anthropic、自建网关等）。协议决定请求地址后缀与请求 / 响应格式，下方会实时给出「实际请求地址」。每个模型单独「测试连通性 → 保存」，新增模型必须先测试通过才能保存；Key 只写入加密保险库；生成参数留空即使用默认值。",
      [
        el("div", { class: "ai-model-list" }, rows),
        el("div", { class: "log-actions" }, [
          el("button", { class: "btn ghost", type: "button", text: "添加模型", onclick: addModel }),
        ]),
      ]
    );
  }

  function renderGit() {
    const sync = draft.features.sync;
    const nodes = [];
    if (!sync.git_sync) {
      nodes.push(notice("Git 同步当前已关闭，以下配置在启用后生效（可在「功能开关」中开启）。"));
    }
    nodes.push(
      section("仓库", "pshell 用 Git 仓库同步配置，不做任何云同步。", [
        repoPathField(),
        selectField("同步范围", "决定纳入版本控制的文件", "features.sync.git_sync_scope", SCOPE_OPTIONS),
      ])
    );
    nodes.push(
      section("提交", "模板支持 {date} {time} {host} {count} {scope} 占位符。", [
        field(
          "提交信息模板",
          "仅在「提交模板」开关打开时使用",
          bind(el("textarea", { rows: 2 }), draft, "features.sync.git_commit_template_text")
        ),
        textField("作者名", null, "features.sync.git_author_name"),
        textField("作者邮箱", null, "features.sync.git_author_email", { placeholder: "pshell@localhost" }),
      ])
    );
    if (sync.git_multi_repo) {
      nodes.push(
        section("多仓库", "每个仓库一条记录；名称对应 git remote 名。", [
          listEditor({
            items: sync.git_remotes,
            addLabel: "添加仓库",
            emptyText: "暂无仓库，将使用默认的 origin。",
            blank: () => ({ name: "origin", url: "", branch: null, username: null }),
            fields: [
              { path: "name", placeholder: "remote 名，如 origin", width: "130px" },
              { path: "url", placeholder: "git@github.com:you/pshell-config.git", width: "1fr" },
              { path: "branch", placeholder: "目标分支（可留空）", width: "130px" },
            ],
          }),
        ])
      );
    } else {
      // 单仓库模式：绑到第一条远端，保证「填个地址就能用」的路径最短
      ensureOrigin();
      nodes.push(
        section("远程仓库", "只同步到一个远端；需要多个远端时打开「多仓库」开关。", [
          textField(
            "远程地址",
            "SSH 或 HTTPS 地址；留空则只做本地提交，不推送",
            "features.sync.git_remotes.0.url",
            { placeholder: "git@github.com:you/pshell-config.git" }
          ),
          textField("目标分支", "留空则推送与本地同名的分支", "features.sync.git_remotes.0.branch", {
            placeholder: "main",
          }),
        ])
      );
    }
    nodes.push(credentialsSection(sync.git_remotes || []));
    return nodes;
  }

  /** 远端名规范化，与后端 git_sync::normalize_remote_name 保持一致。 */
  function remoteName(remote) {
    const name = ((remote && remote.name) || "").trim();
    return name || "origin";
  }

  /** 单个远端的访问凭据：用户名随配置保存，密码 / 令牌只进加密保险库。 */
  function credentialRow(remote, index) {
    const name = remoteName(remote);
    const stored = gitCredentialNames.has(name);
    const user = bind(
      input("text", { placeholder: "用户名，如 your-name 或 x-access-token" }),
      draft,
      `features.sync.git_remotes.${index}.username`
    );
    const pwd = input("password", {
      placeholder: stored ? "已保存在加密保险库，留空则不修改" : "密码或访问令牌（PAT）",
    });
    pwd.addEventListener("input", () => {
      if (pwd.value === "") gitPasswordInputs.delete(name);
      else gitPasswordInputs.set(name, pwd.value);
    });

    const statusNode = el("p", { class: "inline-note", text: "" });
    const testBtn = el("button", {
      class: "btn ghost",
      type: "button",
      text: "测试连接",
      onclick: runTest,
    });

    /**
     * 用当前表单里的地址 / 用户名 / 密码连一次远端并读引用列表：
     * 一次即可验证地址可达与凭据正确。密码已输入就用输入的，否则后端回落保险库。
     */
    async function runTest() {
      const url = (((draft.features.sync.git_remotes || [])[index] || {}).url || "").trim();
      if (!url) {
        toast("请先填写远程地址", "warn");
        return;
      }
      testBtn.disabled = true;
      testBtn.textContent = "测试中…";
      statusNode.className = "inline-note";
      statusNode.textContent = "正在连接 " + url + " …";
      try {
        const result = await PShell.ipc.gitTest({
          name,
          url,
          username: (user.value || "").trim() || null,
          password: pwd.value === "" ? null : pwd.value,
        });
        statusNode.className = "inline-note ok";
        statusNode.textContent =
          "连接成功：" + result.message + "（" + result.elapsed_ms + " ms）";
        toast("Git 远端连接与凭据均正常", "ok");
      } catch (err) {
        statusNode.className = "inline-note error";
        statusNode.textContent = "测试失败：" + errorText(err);
        toast(errorText(err), "error");
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = "测试连接";
      }
    }

    const control = el("div", {}, [
      el("div", { class: "input-row" }, [
        pwd,
        testBtn,
        el("button", {
          class: "btn ghost",
          type: "button",
          text: "清除",
          onclick: () => {
            gitPasswordInputs.set(name, "");
            pwd.value = "";
            pwd.placeholder = "保存后将删除保险库中的密码";
          },
        }),
      ]),
      el("p", { class: "inline-note" }, [
        stored ? badge("已保存", "on") : badge("未保存", "off"),
        el("span", { text: stored ? " 保险库中已有凭据" : " 尚未保存凭据" }),
      ]),
      statusNode,
    ]);

    return el("div", { class: "git-credential-row" }, [
      field("用户名", `远端 ${name}`, user),
      field("密码 / 令牌", "留空即不修改；可先点「测试连接」验证地址与凭据", control),
    ]);
  }

  function credentialsSection(remotes) {
    const rows = remotes.length
      ? remotes.map((remote, index) => credentialRow(remote, index))
      : [notice("暂未配置远端地址，填写后即可配置凭据。")];
    return section(
      "访问凭据",
      "HTTPS 远端需要用户名与密码 / 访问令牌（如 GitHub PAT）。密码只写入加密保险库，不写入配置文件；它会以密文随 Git 同步一起分发。SSH 远端请改用 ssh-agent 或 ~/.ssh 私钥。填好后可点「测试连接」验证地址可达、凭据正确。",
      rows
    );
  }

  /** 单仓库模式下保证 git_remotes 至少有一条 origin，供字段绑定。 */
  function ensureOrigin() {
    const sync = draft.features.sync;
    if (!Array.isArray(sync.git_remotes)) sync.git_remotes = [];
    if (!sync.git_remotes.length) sync.git_remotes.push({ name: "origin", url: "", branch: null, username: null });
    const origin = sync.git_remotes[0];
    if (!origin.name) origin.name = "origin";
    if (origin.branch === undefined) origin.branch = null;
    if (origin.username === undefined) origin.username = null;
    return origin;
  }

  function repoPathField() {
    const node = bind(input("text", { placeholder: "~/.pshell/sync" }), draft, "features.sync.git_repo_path");
    const dialog = window.__TAURI__ && window.__TAURI__.dialog;
    const row = [node];
    if (dialog && typeof dialog.open === "function") {
      row.push(
        el("button", {
          class: "btn ghost",
          type: "button",
          text: "选择目录…",
          onclick: async () => {
            try {
              const picked = await dialog.open({
                directory: true,
                multiple: false,
                title: "选择 Git 仓库目录",
              });
              if (typeof picked === "string" && picked) {
                node.value = picked;
                draft.features.sync.git_repo_path = picked;
              }
            } catch (err) {
              toast(errorText(err), "error");
            }
          },
        })
      );
    }
    return field("仓库路径", "留空则使用应用数据目录下的 sync", el("div", { class: "input-row" }, row));
  }

  /**
   * 快捷键行的数据来源。每个已实现的动作固定占一行，左侧只读描述取自动作注册表；
   * 某个动作还没有绑定时就地补一条空绑定（组合键留空 = 未绑定，保存时会被丢掉）。
   */
  function shortcutRows() {
    const actions = PShell.shortcuts.actions();
    const bindings = (draft.shortcuts = draft.shortcuts || []);
    const used = new Set();
    const rows = actions.map((action) => {
      let binding = bindings.filter((item) => item && item.action === action.id)[0];
      if (!binding) {
        binding = { action: action.id, keys: "", enabled: true };
        bindings.push(binding);
      }
      used.add(binding);
      return { label: action.label, hint: action.hint || "", binding, removable: false };
    });
    // 配置里多出来的条目（同一动作的重复绑定、或当前版本没实现的动作 id）原样保留并允许删除，
    // 否则它们会一直留在配置文件里却完全不可见。
    bindings.forEach((item) => {
      if (!item || used.has(item)) return;
      const known = actions.filter((action) => action.id === item.action)[0];
      rows.push({
        label: known ? known.label + "（重复条目）" : "未实现的动作：" + (item.action || "（空）"),
        hint: known
          ? "同一动作绑定了多条，只有靠前的那条生效"
          : "当前版本没有实现该动作，按键不会触发",
        binding: item,
        removable: true,
      });
    });
    return rows;
  }

  function renderShortcuts() {
    const list = el("div", { class: "list-editor" });
    const report = el("div");
    /** 动作 id -> 描述文字，用于把冲突报告里的 id 换成可读文案 */
    const labels = {};

    function renderRows() {
      list.textContent = "";
      shortcutRows().forEach((row) => {
        if (!labels[row.binding.action]) labels[row.binding.action] = row.label;
        const node = el("div", { class: "list-row" });
        node.style.gridTemplateColumns = row.removable ? "1fr 28px" : "1fr 54px 210px";

        node.appendChild(
          el("div", { class: "field-label" }, [
            el("span", { class: "name", text: row.label }),
            el("span", { class: "hint", text: row.hint }),
          ])
        );

        if (!row.removable) {
          const box = bind(input("checkbox"), row.binding, "enabled");
          box.title = "关闭后该组合键不再派发动作，按键原样交给终端";
          node.appendChild(el("label", { class: "toggle-row" }, [box]));
          node.appendChild(bind(input("text", { placeholder: "留空 = 未绑定" }), row.binding, "keys"));
        } else {
          node.appendChild(
            el("button", {
              class: "icon-btn",
              title: "删除该条目",
              text: "✕",
              onclick: () => {
                const index = draft.shortcuts.indexOf(row.binding);
                if (index >= 0) draft.shortcuts.splice(index, 1);
                renderRows();
                refreshReport();
              },
            })
          );
        }
        list.appendChild(node);
      });
    }

    /** 冲突检测随编辑即时刷新：改键、切换启用、删条目都要重算。 */
    function refreshReport() {
      report.textContent = "";
      const issues = PShell.shortcuts.conflicts(draft.shortcuts);
      if (!issues.length) {
        report.appendChild(el("p", { class: "inline-note ok", text: "未发现冲突。" }));
        return;
      }
      issues.forEach((issue) => {
        const who = labels[issue.action] || issue.action;
        let text = (who ? "「" + who + "」：" : "") + issue.text;
        if (issue.duplicateOf) {
          text += "（与「" + (labels[issue.duplicateOf] || issue.duplicateOf) + "」冲突）";
        }
        report.appendChild(el("p", { class: "inline-note " + issue.level, text }));
      });
    }

    renderRows();
    refreshReport();
    list.addEventListener("input", refreshReport);
    list.addEventListener("click", refreshReport);

    return [
      section(
        "键盘快捷键",
        "组合键写法如 CmdOrCtrl+T（macOS 上是 ⌘，其他平台是 Ctrl），多个修饰键用 + 连接；" +
          "也可直接写 Cmd / Ctrl / Shift / Alt。",
        [list, report]
      ),
    ];
  }

  function renderAbout() {
    const source = info || {};
    const rows = [
      ["应用", source.name || "pshell"],
      ["版本", source.version || "—"],
      ["配置文件", source.config_file || "—"],
      ["数据库", source.database_file || "—"],
      ["日志目录", source.log_dir || "—"],
    ].map((pair) => field(pair[0], null, el("span", { class: "muted", text: pair[1] })));

    const moduleRows = modules.length
      ? modules.map((status) =>
          field(t("module." + status.id, MODULE_LABELS[status.id] || status.id), null, el("span", {}, [
            moduleBadge(status),
            status.note ? el("span", { class: "muted", text: " " + status.note }) : null,
          ]))
        )
      : [notice("尚未注册任何可插拔模块实现（ModuleRegistry 为空）。")];

    return [
      section("应用信息", "配置为纯文本 YAML，可直接编辑。", rows),
      section("模块状态", "可选模块在 Rust 侧统一实现 init / dispose / is_enabled。", moduleRows),
      renderCrashLog(),
    ];
  }

  // ---------------------------------------------------------------------------
  // 崩溃日志（FEATURES.md §6）
  // ---------------------------------------------------------------------------

  /** 崩溃日志所在目录。与 Rust 侧的 paths.crash_log 同目录。 */
  function crashLogDir() {
    return String((info && info.log_dir) || "").replace(/[\\/]+$/, "");
  }

  /** 以平台分隔符拼一个崩溃日志导出的默认文件名。 */
  function crashLogPath(name) {
    const dir = crashLogDir();
    if (!dir) return name;
    const sep = dir.indexOf("\\") >= 0 && dir.indexOf("/") < 0 ? "\\" : "/";
    return dir + sep + name;
  }

  function crashFileName() {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return `pshell-crash-${stamp}.log`;
  }

  async function viewCrashLog() {
    if (crashBusy) return;
    crashBusy = true;
    renderBody();
    try {
      crashTail = await PShell.ipc.crashLogRead(16384);
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      crashBusy = false;
      renderBody();
    }
  }

  async function exportCrashLog() {
    if (crashBusy) return;
    const dialog = (window.__TAURI__ && window.__TAURI__.dialog) || null;
    if (!dialog || typeof dialog.save !== "function") {
      toast("当前环境不支持文件保存对话框", "error");
      return;
    }
    let target = null;
    try {
      target = await dialog.save({
        title: "导出崩溃日志",
        defaultPath: crashLogPath(crashFileName()),
      });
    } catch (err) {
      toast(errorText(err), "error");
      return;
    }
    if (!target) return;
    crashBusy = true;
    renderBody();
    try {
      const result = await PShell.ipc.crashLogExport(target);
      toast(`已导出崩溃日志（${result.bytes} 字节）`, "ok");
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      crashBusy = false;
      renderBody();
    }
  }

  function renderCrashLog() {
    if (!draft.features.auxiliary.crash_log) {
      return section("崩溃日志", null, [
        notice("崩溃日志已关闭。打开后 pshell 会把 panic 信息写入本地日志，可在此查看与导出。"),
      ]);
    }

    const nodes = [
      notice("panic hook 捕获的崩溃信息写入本地日志。反馈问题时导出该文件即可。"),
      el("div", { class: "log-actions" }, [
        el("button", {
          class: "btn ghost",
          type: "button",
          text: "查看",
          disabled: crashBusy,
          onclick: viewCrashLog,
        }),
        el("button", {
          class: "btn ghost",
          type: "button",
          text: "导出",
          disabled: crashBusy,
          onclick: exportCrashLog,
        }),
      ]),
    ];

    if (crashTail) {
      nodes.push(
        notice(
          crashTail.exists
            ? `${crashTail.path}（${crashTail.bytes} 字节${crashTail.truncated ? "，仅显示末尾部分" : ""}）`
            : "暂无崩溃日志，应用尚未崩溃过。"
        )
      );
      if (crashTail.exists) {
        nodes.push(el("pre", { class: "log-preview", text: crashTail.content || "（文件为空）" }));
      }
    }

    return section("崩溃日志", "关闭时后端命令会被门控拒绝。", nodes);
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  function renderNav() {
    const nav = $("settings-nav");
    if (!nav) return;
    nav.textContent = "";
    CATEGORIES.forEach((cat) => {
      nav.appendChild(
        el("button", {
          class: cat.id === activeCat ? "active" : "",
          text: t("settings.cat." + cat.id, cat.label),
          onclick: () => {
            activeCat = cat.id;
            renderNav();
            renderBody();
          },
        })
      );
    });
  }

  function renderBody() {
    const host = $("settings-body");
    if (!host || !draft) return;
    host.textContent = "";

    // 单个分类渲染失败时把错误显示在面板里：否则整页空白，用户只看到「打不开」
    let nodes;
    try {
      nodes = renderCategory();
    } catch (err) {
      console.error("[settings] 渲染分类 " + activeCat + " 失败", err);
      host.appendChild(
        el("p", { class: "inline-note error", text: "该页渲染失败：" + errorText(err) })
      );
      return;
    }

    (nodes || []).forEach((node) => node && host.appendChild(node));
    host.scrollTop = 0;
  }

  function renderCategory() {
    switch (activeCat) {
      case "terminal":
        return [renderTerminal()];
      case "connection":
        return renderConnection();
      case "flags":
        return [renderFlags()];
      case "ai":
        return renderAi();
      case "git":
        return renderGit();
      case "shortcuts":
        return renderShortcuts();
      case "about":
        return renderAbout();
      case "general":
      default:
        return renderGeneral();
    }
  }

  async function open(category) {
    const target = CATEGORIES.some((cat) => cat.id === category) ? category : null;
    if (target) activeCat = target;
    const mask = $("modal-settings");
    if (mask && !mask.hidden) {
      // 已打开时只切分类，不重拉配置，避免丢掉用户未保存的修改
      if (target) {
        renderNav();
        renderBody();
      }
      return;
    }
    try {
      // 这些命令相互独立：任何一个失败都不该让整个设置面板打不开（原先用 Promise.all，
      // 一个 AI 模块未就绪就会让 open() 直接跳到 catch，表现就是「点设置没反应」）。
      const [cfg, flagList, moduleList, appInfo, keySet, gitCreds, vState, protos] = await Promise.all([
        PShell.ipc.getConfig(),
        PShell.ipc.featureFlags(),
        PShell.ipc.moduleStatus(),
        PShell.ipc.appInfo(),
        PShell.ipc.aiConfiguredModels().catch(() => []),
        PShell.ipc.gitCredentials().catch(() => []),
        PShell.ipc.vaultStatus().catch(() => null),
        PShell.ipc.aiProtocols().catch(() => []),
      ]);
      draft = deepClone(cfg);
      flags = flagList || [];
      modules = moduleList || [];
      protocolList = protos || [];
      info = appInfo || null;
      vaultState = vState || null;
      configuredModelIds = new Set(keySet || []);
      aiModels = deepClone((cfg.ai && cfg.ai.models) || []);
      savedModelIds = new Set(aiModels.map((m) => m.id));
      testedModelIds = new Set();
      gitCredentialNames = new Set(gitCreds || []);
      gitPasswordInputs = new Map();
      crashTail = null;
      crashBusy = false;
      // 渲染失败已由 renderBody 内部兜底（显示错误文案），弹窗本身照常打开，
      // 否则保存 / 取消按钮会一起消失，用户只能强杀应用。
      renderNav();
      renderBody();
      const hint = $("settings-hint");
      if (hint) hint.textContent = "配置文件：" + (info && info.config_file ? info.config_file : "—");
      mask.hidden = false;
    } catch (err) {
      // 直接 console.error：toast 依赖宿主节点，出错时可能连提示都看不到
      console.error("[settings] 打开设置失败", err);
      toast(errorText(err), "error");
    }
  }

  /** 保存前兜底：清掉空字符串伪装成的 Some("")、去掉残缺条目。 */
  function normalize() {
    const sync = draft.features.sync;
    sync.git_repo_path = emptyToNull(sync.git_repo_path);
    sync.git_remotes = (sync.git_remotes || [])
      .map((remote) => ({
        name: (remote.name || "").trim() || "origin",
        url: (remote.url || "").trim(),
        branch: emptyToNull(remote.branch),
        // 用户名非敏感，随配置保存；密码 / 令牌走加密保险库
        username: emptyToNull(remote.username),
      }))
      .filter((remote) => remote.url);

    // 组合键留空 = 未绑定，直接丢掉；已启用 / 已禁用的绑定都要留存（禁用靠 enabled 字段表达）
    draft.shortcuts = (draft.shortcuts || [])
      .map((item) => ({
        action: (item.action || "").trim(),
        keys: (item.keys || "").trim(),
        enabled: item.enabled !== false,
      }))
      .filter((item) => item.action && item.keys);
  }

  async function save() {
    if (!draft) return;
    normalize();
    try {
      const moduleList = await PShell.ipc.saveConfig(draft);
      modules = moduleList || modules;

      // Git 凭据同 API Key：也必须在 save_config 之后（set 带模块门控），
      // 且只写加密保险库，绝不进配置文件。
      if (gitPasswordInputs.size) {
        if (draft.features.sync.git_sync) {
          for (const [name, value] of gitPasswordInputs) {
            await PShell.ipc.gitSetCredential(name, value);
            if (value === "") gitCredentialNames.delete(name);
            else gitCredentialNames.add(name);
          }
        } else {
          toast("Git 同步已关闭，本次未写入 Git 密码", "info");
        }
      }
      gitPasswordInputs = new Map();

      applyToApp();
      toast("设置已保存", "ok");
      // 尚未逐条保存的模型不会随整份配置提交，否则等于绕过「先测通再保存」的门槛
      const pending = aiModels.filter((m) => !savedModelIds.has(m.id));
      if (pending.length) {
        toast("有 " + pending.length + " 个模型尚未保存，请在该模型卡片上点击「保存」", "warn");
      }
      renderBody();
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  async function reset() {
    const confirmed = await ask(
      "恢复默认设置？功能开关、终端外观、AI 与 Git 配置都会回到初始值。连接列表与加密保险库中的凭据不受影响。",
      { title: "恢复默认设置", okText: "恢复默认", kind: "danger" }
    );
    if (!confirmed) return;
    try {
      draft = deepClone(await PShell.ipc.resetConfig());
      flags = await PShell.ipc.featureFlags();
      modules = await PShell.ipc.moduleStatus();
      configuredModelIds = new Set((await PShell.ipc.aiConfiguredModels().catch(() => [])) || []);
      aiModels = deepClone((draft.ai && draft.ai.models) || []);
      savedModelIds = new Set(aiModels.map((m) => m.id));
      testedModelIds = new Set();
      gitCredentialNames = new Set((await PShell.ipc.gitCredentials()) || []);
      gitPasswordInputs = new Map();
      applyToApp();
      renderBody();
      if (configuredModelIds.size) {
        toast("已恢复默认设置；保险库中的模型 API Key 仍保留，删除对应模型即可一并清除", "info");
      } else {
        toast("已恢复默认设置", "ok");
      }
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  /** 把草稿立刻作用到界面（主题、终端、侧栏），无需重开应用。 */
  function applyToApp() {
    if (PShell.app && typeof PShell.app.applyConfig === "function") {
      PShell.app.applyConfig(draft);
    }
    if (PShell.connections && typeof PShell.connections.refresh === "function") {
      PShell.connections.refresh().catch(() => {});
    }
  }

  /** 供全局搜索使用：可检索的设置项索引（分类页 + 功能开关）。 */
  function searchIndex() {
    const items = CATEGORIES.map((cat) => ({
      category: cat.id,
      title: t("settings.cat." + cat.id, cat.label),
      subtitle: "设置分类",
      keywords: cat.label,
    }));
    Object.keys(FLAG_META).forEach((path) => {
      const meta = FLAG_META[path];
      items.push({
        category: "flags",
        title: t("flags." + path, meta.label),
        subtitle: "功能开关 · " + path,
        keywords: path + " " + (meta.hint || ""),
      });
    });
    return items;
  }

  PShell.settings = { open, save, reset, searchIndex };
})(window.PShell);