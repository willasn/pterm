/* 应用引导：拉取配置与模块状态、装配主题与终端外观、绑定全局交互。
 * 快捷键派发见 shortcuts.js；本文件必须最后加载——它会把各模块的入口（打开设置、发起连接）挂到 DOM 上。 */
(function (PShell) {
  "use strict";

  const { el, $, errorText } = PShell.util;
  const t = PShell.i18n.t;

  const state = {
    config: null,
    info: null,
    flags: [],
    modules: [],
  };

  const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  /** 主题实际生效的明暗值：把 "system" 解析成当前系统外观。 */
  function resolvedMode() {
    const mode = (state.config && state.config.theme && state.config.theme.mode) || "dark";
    if (mode === "system") return media && media.matches ? "dark" : "light";
    return mode === "light" ? "light" : "dark";
  }

  /** 「主题」开关。关闭时回落到内置深色，自定义明暗与强调色都不生效。 */
  function themeEnabled() {
    const features = (state.config && state.config.features) || {};
    return !!((features.auxiliary || {}).theme);
  }

  function applyTheme() {
    const theme = (state.config && state.config.theme) || {};
    if (!themeEnabled()) {
      document.body.dataset.theme = "dark";
      document.body.style.removeProperty("--accent");
      return;
    }
    document.body.dataset.theme = resolvedMode();
    if (theme.accent) document.body.style.setProperty("--accent", theme.accent);
    else document.body.style.removeProperty("--accent");
  }

  /**
   * 需要接收配置的模块，按此顺序应用 setConfig。
   *
   * 顺序有要求：标签/分屏的开关由 tabs.js 持有，必须先于 terminal 生效。
   */
  const CONFIG_CONSUMERS = [
    "tabs",
    "terminal",
    "syncInput",
    "connections",
    "gitSync",
    "sessionLog",
    "sftp",
    "portForward",
    "importExport",
    "rdp",
    "snippets",
    "history",
    "search",
    "quickPanel",
    "shortcuts",
    "ai",
    "split",
  ];

  /** 把一份完整配置作用到界面：主题、终端外观、侧栏。 */
  function applyConfig(config) {
    state.config = config;
    applyTheme();
    // 逐模块独立 try/catch：任一模块的 setConfig 抛错都不该中断整个初始化。
    // 否则连接列表等核心 UI 都不会渲染——历史上真出过：ai.setConfig 抛错导致侧栏全空、
    // 看起来像「保存的连接丢了」，而用户只能看到一句初始化失败。
    CONFIG_CONSUMERS.forEach((name) => {
      const mod = PShell[name];
      if (!mod || typeof mod.setConfig !== "function") return;
      try {
        mod.setConfig(config);
      } catch (err) {
        console.error("[app] " + name + ".setConfig 失败", err);
      }
    });
    // i18n 返回 Promise（要加载语言包），单独处理
    if (PShell.i18n && typeof PShell.i18n.setConfig === "function") {
      PShell.i18n.setConfig(config);
    }
  }

  /** 致命错误：直接占据空状态区，避免用户面对一个无提示的空窗口。 */
  function fatal(title, detail) {
    const host = $("empty-state");
    if (!host) return;
    host.textContent = "";
    host.appendChild(el("h1", { text: "pshell" }));
    host.appendChild(el("p", { text: title }));
    host.appendChild(el("p", { class: "muted", text: detail }));
    host.hidden = false;
  }

  async function boot() {
    if (!PShell.ipc.available) {
      fatal(
        "未运行在 Tauri 宿主中",
        "请通过 `tauri dev` 或打包后的应用启动 pshell。直接用浏览器打开 index.html 无法访问 SSH 后端。"
      );
      return;
    }
    if (!PShell.terminal.isSupported()) {
      fatal("终端组件缺失", "vendor/xterm.js 未加载，请确认 src/vendor 下的文件是否完整。");
      return;
    }
    // 首次启动：先让用户选界面语言。标记文件写在配置目录、不随 Git 同步，
    // 因此仅「这台机器第一次打开」出现，换机后会重新引导一次。
    const locale = await PShell.onboarding.run();
    // 敏感字段由主密码加密的保险库保管，未解锁时先要求设置 / 输入主密码
    await PShell.vault.ensureUnlocked();
    try {
      const [info, config, flags, modules] = await Promise.all([
        PShell.ipc.appInfo(),
        PShell.ipc.getConfig(),
        PShell.ipc.featureFlags(),
        PShell.ipc.moduleStatus(),
      ]);
      state.info = info;
      state.flags = flags || [];
      state.modules = modules || [];
      const previousLanguage = config.language;
      if (locale) config.language = locale;
      applyConfig(config);

      // 先拉连接列表，再让 setConfig 渲染，避免出现一次「还没有连接」的闪动
      await PShell.connections.refresh();
      PShell.terminal.updateEmptyState();

      // 把首次选择的语言落盘，之后启动直接生效；失败不阻断启动
      if (locale && locale !== previousLanguage) {
        PShell.ipc.saveConfig(config).catch((err) => console.warn("[app] 保存语言失败", err));
      }
    } catch (err) {
      fatal("初始化失败", errorText(err));
    }
  }

  // ---------------------------------------------------------------------------
  // 快捷键
  // ---------------------------------------------------------------------------

  // 绑定表解析与动作派发由 shortcuts.js 负责（见 PShell.shortcuts），
  // 这里只保留 Escape 关闭弹窗这一条全局交互。

  // AI 助手不在其中：它是右侧停靠面板，不参与「Escape 关闭最上层弹窗」。
  const MODALS = ["modal-settings", "modal-connection", "modal-git", "modal-session-log", "modal-sftp", "modal-port-forward", "modal-import-export", "modal-snippets", "modal-history", "modal-search", "modal-split", "modal-quick-panel"];

  /** 关闭最上层的弹窗。危险命令确认必须显式选择，不在此处处理。 */
  function closeTopModal() {
    MODALS.forEach((id) => {
      const mask = $(id);
      if (mask && !mask.hidden) mask.hidden = true;
    });
  }

  function onKeydown(event) {
    if (event.key === "Escape") {
      closeTopModal();
      return;
    }
    PShell.shortcuts.handleKeydown(event);
  }

  // ---------------------------------------------------------------------------
  // 侧边栏：收起 / 展开 + 左右拖动调宽
  // ---------------------------------------------------------------------------

  /** 宽度范围与持久化键。宽度、收起状态记在 localStorage，重启后保留。 */
  const SIDEBAR_KEY = "pshell.sidebar";
  const SIDEBAR_MIN = 180;
  const SIDEBAR_MAX = 480;
  const SIDEBAR_DEFAULT = 248;

  function clampSidebarWidth(width) {
    return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width || SIDEBAR_DEFAULT)));
  }

  function sidebarState() {
    try {
      return JSON.parse(localStorage.getItem(SIDEBAR_KEY) || "{}") || {};
    } catch (_) {
      return {};
    }
  }

  function saveSidebarState(patch) {
    try {
      localStorage.setItem(SIDEBAR_KEY, JSON.stringify(Object.assign(sidebarState(), patch)));
    } catch (_) {
      /* 存储不可用（隐私模式等）时静默忽略，仅本次会话内生效 */
    }
  }

  function setSidebarWidth(width) {
    const value = clampSidebarWidth(width);
    document.documentElement.style.setProperty("--sidebar-width", value + "px");
    saveSidebarState({ width: value });
    return value;
  }

  function setSidebarCollapsed(collapsed) {
    const app = $("app");
    if (!app) return;
    app.classList.toggle("sidebar-collapsed", !!collapsed);
    const show = $("btn-sidebar-show");
    if (show) show.hidden = !collapsed;
    saveSidebarState({ collapsed: !!collapsed });
    PShell.terminal.refitAll();
  }

  /** 恢复侧栏宽度/收起状态，并绑定收起按钮、展开按钮与拖拽调宽。 */
  function initSidebar() {
    const saved = sidebarState();
    if (saved.width) setSidebarWidth(saved.width);
    setSidebarCollapsed(!!saved.collapsed);

    const app = $("app");
    const toggle = $("btn-sidebar-toggle");
    if (toggle) toggle.addEventListener("click", () => setSidebarCollapsed(true));
    const show = $("btn-sidebar-show");
    if (show) show.addEventListener("click", () => setSidebarCollapsed(false));

    const handle = $("sidebar-resizer");
    if (!handle || !app) return;

    let dragging = false;
    handle.addEventListener("pointerdown", (event) => {
      if (app.classList.contains("sidebar-collapsed")) return;
      dragging = true;
      handle.classList.add("dragging");
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      // 侧栏贴着窗口左缘，指针相对 app 左缘的偏移即目标宽度
      setSidebarWidth(event.clientX - app.getBoundingClientRect().left);
    });
    const stop = (event) => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("dragging");
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch (_) {
        /* 指针已释放，忽略 */
      }
      PShell.terminal.refitAll();
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    // 双击复位到默认宽度
    handle.addEventListener("dblclick", () => setSidebarWidth(SIDEBAR_DEFAULT));
  }

  // ---------------------------------------------------------------------------
  // 绑定
  // ---------------------------------------------------------------------------

  function bind() {
    const on = (id, event, handler) => {
      const node = $(id);
      if (node) node.addEventListener(event, handler);
    };

    // 先屏蔽原生右键菜单，业务菜单由列表项 / 标签各自按需弹出（见 context_menu.js）
    if (PShell.menu) PShell.menu.suppressNative();

    on("btn-new-conn", "click", () => PShell.connections.openForm(null));
    on("tab-add-btn", "click", () => PShell.connections.openPicker());
    on("btn-settings", "click", () => PShell.settings.open());
    on("quick-input", "keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      PShell.connections.onQuickSubmit();
    });

    on("conn-save", "click", () => PShell.connections.save());
    on("conn-test", "click", () => PShell.connections.test());
    on("conn-delete", "click", () => PShell.connections.remove());
    on("settings-save", "click", () => PShell.settings.save());
    on("settings-reset", "click", () => PShell.settings.reset());

    initSidebar();

    Array.from(document.querySelectorAll("[data-close]")).forEach((button) => {
      button.addEventListener("click", () => {
        const mask = $(button.dataset.close);
        if (mask) mask.hidden = true;
      });
    });

    // 点击遮罩空白处关闭
    MODALS.forEach((id) => {
      const mask = $(id);
      if (!mask) return;
      mask.addEventListener("click", (event) => {
        if (event.target === mask) mask.hidden = true;
      });
    });

    document.addEventListener("keydown", onKeydown);
    window.addEventListener("resize", () => PShell.terminal.refitAll());

    if (media) {
      const onSchemeChange = () => {
        const mode = state.config && state.config.theme && state.config.theme.mode;
        if (mode !== "system") return;
        applyTheme();
        PShell.terminal.refitAll();
      };
      if (media.addEventListener) media.addEventListener("change", onSchemeChange);
      else if (media.addListener) media.addListener(onSchemeChange);
    }
  }

  PShell.app = {
    applyTheme,
    applyConfig,
    config: () => state.config,
    reload: boot,
  };

  bind();
  boot();
})(window.PShell);