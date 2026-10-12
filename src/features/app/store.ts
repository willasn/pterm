import { pt } from "../../lib/legacy";
import { setEnabledFromConfig as setAiConfig } from "../ai/store";
import { autoCheckOnStartup, setAppVersion, setEnabledFromConfig as setAutoUpdateConfig } from "../auto-update/store";
import {
  onQuickSubmit as connectionsQuickSubmit,
  openForm as connectionsOpenForm,
  openPicker as connectionsOpenPicker,
  refresh as refreshConnections,
  setEnabledFromConfig as setConnectionsConfig,
} from "../connections/store";
import { suppressNative } from "../context-menu/store";
import { setEnabledFromConfig as setHistoryConfig } from "../history/store";
import { setConfig as setLocaleConfig } from "../i18n/store";
import { setEnabledFromConfig as setImportExportConfig } from "../import-export/store";
import { ipc } from "../ipc/api";
import { open as openLocalTerminal, setEnabledFromConfig as setLocalTerminalConfig } from "../local-terminal/api";
import { run as runOnboarding } from "../onboarding/store";
import { setEnabledFromConfig as setPortForwardConfig } from "../port-forward/store";
import { setEnabledFromConfig as setQuickPanelConfig } from "../quick-panel/store";
import { setEnabledFromConfig as setRdpConfig } from "../rdp/api";
import { setEnabledFromConfig as setSessionLogConfig } from "../session-log/store";
import { setEnabledFromConfig as setSftpConfig } from "../sftp/store";
import { handleKeydown, setEnabledFromConfig as setShortcutsConfig } from "../shortcuts/api";
import { setEnabledFromConfig as setSnippetsConfig } from "../snippets/store";
import { setEnabledFromConfig as setSplitConfig } from "../split/store";
import { setEnabledFromConfig as setSyncInputConfig } from "../sync-input/store";
import { setConfig as setTabsConfig } from "../tabs/store";
import * as terminal from "../terminal/api";
import { $, el, errorText } from "../util/util";
import { ensureUnlocked } from "../vault/store";

/**
 * 应用引导与外壳（由原 src/legacy/app.ts 迁移而来）：
 * 拉取配置与模块状态、装配主题与终端外观、绑定全局交互，并托管侧栏收起 / 调宽与底部功能入口。
 *
 * 外壳由 AppShell 组件渲染，本模块在其挂载后按 id 绑定行为；
 * 配置派发与启动流程均已直接 import 各模块，仅 git-sync / search（反向依赖 app）
 * 与 settings 面板入口仍经 window.PTerm 桥接取值；设置与 Git 同步直接调用 applyConfig 应用配置。
 */

interface AppState {
  config: any;
  info: any;
  flags: any[];
  modules: any[];
}

const state: AppState = { config: null, info: null, flags: [], modules: [] };

const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

// ---------------------------------------------------------------------------
// 主题
// ---------------------------------------------------------------------------

/** 主题实际生效的明暗值：把 "system" 解析成当前系统外观。 */
function resolvedMode(): string {
  const mode = (state.config && state.config.theme && state.config.theme.mode) || "dark";
  if (mode === "system") return media && media.matches ? "dark" : "light";
  return mode === "light" ? "light" : "dark";
}

/** 「主题」开关。关闭时回落到内置深色，自定义明暗与强调色都不生效。 */
function themeEnabled(): boolean {
  const features = (state.config && state.config.features) || {};
  return !!((features.auxiliary || {}).theme);
}

/**
 * 强调色派生：主色 -> 浅色底 + 可读前景色。
 *
 * 强调色由用户配置，明暗不确定，所以前景色按相对亮度自动选深色或白色；
 * 否则浅色强调色（如默认的品牌绿）配白字几乎看不清。
 * 返回 null 表示配置值不是合法十六进制色，此时回落到 theme.css 的默认强调色。
 */
function accentVars(accent: string): { soft: string; text: string } | null {
  const raw = String(accent || "").trim().replace(/^#/, "");
  const hex = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return {
    soft: `rgba(${r}, ${g}, ${b}, 0.14)`,
    text: luminance > 0.6 ? "#10141a" : "#ffffff",
  };
}

export function applyTheme(): void {
  const theme = (state.config && state.config.theme) || {};
  const style = document.body.style;
  if (!themeEnabled()) {
    document.body.dataset.theme = "dark";
    style.removeProperty("--accent");
    style.removeProperty("--accent-soft");
    style.removeProperty("--accent-text");
    return;
  }
  document.body.dataset.theme = resolvedMode();
  const vars = theme.accent ? accentVars(theme.accent) : null;
  if (!vars) {
    style.removeProperty("--accent");
    style.removeProperty("--accent-soft");
    style.removeProperty("--accent-text");
    return;
  }
  style.setProperty("--accent", theme.accent);
  style.setProperty("--accent-soft", vars.soft);
  style.setProperty("--accent-text", vars.text);
}

/** 配置消费者：模块名 + 应用配置的函数。 */
type ConfigConsumer = readonly [name: string, apply: (config: any) => void];

/**
 * 需要接收配置的模块，按此顺序应用 setConfig。
 *
 * 顺序有要求：标签/分屏的开关由 tabs 模块持有，必须先于 terminal 生效。
 * gitSync 与 search 分别反向依赖 app（前者要 applyConfig，后者经 settings 间接依赖），
 * 静态导入会形成 ESM 环，故这两项仍经 window.PTerm 桥接取值。
 */
const CONFIG_CONSUMERS: ConfigConsumer[] = [
  ["tabs", setTabsConfig],
  ["terminal", terminal.setConfig],
  ["syncInput", setSyncInputConfig],
  ["connections", setConnectionsConfig],
  ["gitSync", (config) => pt().gitSync?.setConfig?.(config)],
  ["sessionLog", setSessionLogConfig],
  ["sftp", setSftpConfig],
  ["portForward", setPortForwardConfig],
  ["importExport", setImportExportConfig],
  ["rdp", setRdpConfig],
  ["localTerminal", setLocalTerminalConfig],
  ["snippets", setSnippetsConfig],
  ["history", setHistoryConfig],
  ["search", (config) => pt().search?.setConfig?.(config)],
  ["quickPanel", setQuickPanelConfig],
  ["shortcuts", setShortcutsConfig],
  ["ai", setAiConfig],
  ["split", setSplitConfig],
  ["autoUpdate", setAutoUpdateConfig],
];

/** 把一份完整配置作用到界面：主题、终端外观、侧栏。 */
export function applyConfig(config: any): void {
  state.config = config;
  applyTheme();
  // 逐模块独立 try/catch：任一模块的 setConfig 抛错都不该中断整个初始化。
  // 否则连接列表等核心 UI 都不会渲染——历史上真出过：ai.setConfig 抛错导致侧栏全空、
  // 看起来像「保存的连接丢了」，而用户只能看到一句初始化失败。
  CONFIG_CONSUMERS.forEach(([name, setConfig]) => {
    try {
      setConfig(config);
    } catch (err) {
      console.error("[app] " + name + ".setConfig 失败", err);
    }
  });
  // i18n 返回 Promise（要加载语言包），单独处理
  setLocaleConfig(config);
}

/** 致命错误：直接占据空状态区，避免用户面对一个无提示的空窗口。 */
function fatal(title: string, detail: string): void {
  const host = $("empty-state");
  if (!host) return;
  host.textContent = "";
  host.appendChild(el("h1", { text: "pterm" }));
  host.appendChild(el("p", { text: title }));
  host.appendChild(el("p", { class: "muted", text: detail }));
  host.hidden = false;
}

async function boot(): Promise<void> {
  if (!ipc.available) {
    fatal(
      "未运行在 Tauri 宿主中",
      "请通过 `tauri dev` 或打包后的应用启动 pterm。直接用浏览器打开 index.html 无法访问 SSH 后端。"
    );
    return;
  }
  if (!terminal.isSupported()) {
    fatal("终端组件缺失", "vendor/xterm.js 未加载，请确认 src/vendor 下的文件是否完整。");
    return;
  }
  // 首次启动：先让用户选界面语言。标记文件写在配置目录、不随 Git 同步，
  // 因此仅「这台机器第一次打开」出现，换机后会重新引导一次。
  const locale = await runOnboarding();
  // 敏感字段由主密码加密的保险库保管，未解锁时先要求设置 / 输入主密码
  await ensureUnlocked();
  try {
    const [info, config, flags, modules] = await Promise.all([
      ipc.appInfo(),
      ipc.getConfig(),
      ipc.featureFlags(),
      ipc.moduleStatus(),
    ]);
    state.info = info;
    state.flags = flags || [];
    state.modules = modules || [];
    const previousLanguage = config.language;
    if (locale) config.language = locale;
    applyConfig(config);

    // 先拉连接列表，再让 setConfig 渲染，避免出现一次「还没有连接」的闪动
    await refreshConnections();
    terminal.updateEmptyState();

    // 自动更新：先登记当前运行版本（版本变化即作废旧检查缓存），再按开关检查一次
    setAppVersion(info.version);
    autoCheckOnStartup();

    // 把首次选择的语言落盘，之后启动直接生效；失败不阻断启动
    if (locale && locale !== previousLanguage) {
      ipc.saveConfig(config).catch((err) => console.warn("[app] 保存语言失败", err));
    }
  } catch (err) {
    fatal("初始化失败", errorText(err));
  }
}

// ---------------------------------------------------------------------------
// 快捷键
// ---------------------------------------------------------------------------

// 绑定表解析与动作派发由 src/features/shortcuts 负责（见 PTerm.shortcuts）。
// 弹窗（设置 / 连接 / Git / SFTP / 端口转发 / 导入导出 / 会话日志 / 搜索 / 分屏 / 快捷面板）
// 均已迁为 React 组件并各自处理 Escape，这里不再统一关闭。

function onKeydown(event: KeyboardEvent): void {
  handleKeydown(event);
}

// ---------------------------------------------------------------------------
// 侧边栏：收起 / 展开 + 左右拖动调宽
// ---------------------------------------------------------------------------

/** 宽度范围与持久化键。宽度、收起状态记在 localStorage，重启后保留。 */
const SIDEBAR_KEY = "pterm.sidebar";
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 248;

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width || SIDEBAR_DEFAULT)));
}

function sidebarState(): any {
  try {
    return JSON.parse(localStorage.getItem(SIDEBAR_KEY) || "{}") || {};
  } catch (_) {
    return {};
  }
}

function saveSidebarState(patch: any): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, JSON.stringify(Object.assign(sidebarState(), patch)));
  } catch (_) {
    /* 存储不可用（隐私模式等）时静默忽略，仅本次会话内生效 */
  }
}

/**
 * 一次性迁移：更名前的界面偏好存在 `pshell.*` 键下，改名后改用 `pterm.*`。
 * 把旧键的值搬到新键（新键已有值时不覆盖），再删掉旧键，避免宽度等偏好被重置。
 */
function migrateLegacyStorage(): void {
  const pairs = [
    ["pshell.sidebar", SIDEBAR_KEY],
    ["pshell.aiPanelWidth", "pterm.aiPanelWidth"],
  ];
  pairs.forEach(([oldKey, newKey]) => {
    try {
      const value = localStorage.getItem(oldKey);
      if (value === null) return;
      if (localStorage.getItem(newKey) === null) localStorage.setItem(newKey, value);
      localStorage.removeItem(oldKey);
    } catch (_) {
      /* 存储不可用时忽略 */
    }
  });
}

function setSidebarWidth(width: number): number {
  const value = clampSidebarWidth(width);
  document.documentElement.style.setProperty("--sidebar-width", value + "px");
  saveSidebarState({ width: value });
  return value;
}

function setSidebarCollapsed(collapsed: boolean): void {
  const app = $("app");
  if (!app) return;
  app.classList.toggle("sidebar-collapsed", !!collapsed);
  const show = $("btn-sidebar-show");
  if (show) show.hidden = !collapsed;
  saveSidebarState({ collapsed: !!collapsed });
  applyFootState();
  terminal.refitAll();
}

/** 恢复侧栏宽度/收起状态，并绑定收起按钮、展开按钮与拖拽调宽。 */
function initSidebar(disposers: (() => void)[]): void {
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
  const onDown = (event: PointerEvent) => {
    if (app.classList.contains("sidebar-collapsed")) return;
    dragging = true;
    handle.classList.add("dragging");
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onMove = (event: PointerEvent) => {
    if (!dragging) return;
    // 侧栏贴着窗口左缘，指针相对 app 左缘的偏移即目标宽度
    setSidebarWidth(event.clientX - app.getBoundingClientRect().left);
    applyFootState();
  };
  const stop = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    try {
      handle.releasePointerCapture(event.pointerId);
    } catch (_) {
      /* 指针已释放，忽略 */
    }
    applyFootState();
    terminal.refitAll();
  };
  const onReset = () => setSidebarWidth(SIDEBAR_DEFAULT);

  handle.addEventListener("pointerdown", onDown);
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  // 双击复位到默认宽度
  handle.addEventListener("dblclick", onReset);
  disposers.push(() => {
    handle.removeEventListener("pointerdown", onDown);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", stop);
    handle.removeEventListener("pointercancel", stop);
    handle.removeEventListener("dblclick", onReset);
  });
}

// ---------------------------------------------------------------------------
// 侧栏底部功能入口：竖向铺开，空间不足时自动收成一个按钮
// ---------------------------------------------------------------------------

// 空间不足的判定阈值：窗口过矮、或侧栏被拖得/挤得过窄。
// 窗口最小高度由 tauri.conf.json 的 minHeight（560）兜底，阈值必须明显高于它，
// 否则缩到最小也踩不到自动收起；700 约等于从默认 780 高度往下缩 80px 时生效。
const FOOT_MIN_WINDOW_HEIGHT = 700;
const FOOT_MIN_SIDEBAR_WIDTH = 220;

/** 当前实际可见（模块已启用并渲染）的功能徽标。 */
function visibleFootBadges(): HTMLElement[] {
  const host = $("foot-badges");
  if (!host) return [];
  return Array.from(host.querySelectorAll(".git-status")).filter(
    (node) => !(node as HTMLElement).hidden
  ) as HTMLElement[];
}

/** 空间是否铺不开功能入口。 */
function footSpaceTight(): boolean {
  if (window.innerHeight < FOOT_MIN_WINDOW_HEIGHT) return true;
  const sidebar = $("sidebar");
  if (!sidebar) return false;
  return sidebar.getBoundingClientRect().width < FOOT_MIN_SIDEBAR_WIDTH;
}

/** 重算底部状态：未手动选择时按空间自动收放，手动选择优先（展开偏好仅在空间不足时保留）。 */
function applyFootState(): void {
  const foot = $("sidebar-foot");
  const toggle = $("foot-toggle");
  if (!foot || !toggle) return;

  const items = visibleFootBadges();
  const tight = footSpaceTight();
  let pref = sidebarState().footCollapsed;
  // 「展开」这个手动偏好只在空间不足时才有意义；空间一恢复就清掉，让自动判定重新接管
  if (pref === false && !tight) {
    saveSidebarState({ footCollapsed: undefined });
    pref = undefined;
  }
  const collapsed = pref === undefined ? tight : !!pref;
  foot.classList.toggle("compact", collapsed);

  // 一个功能都没启用时连收放按钮也不显示，底部不占位
  toggle.hidden = items.length === 0;
  const arrow = toggle.querySelector(".foot-toggle-arrow");
  if (arrow) arrow.textContent = collapsed ? "▸" : "▾";
  const count = $("foot-toggle-count");
  // 收起后才提示隐藏了几个，展开时保持干净
  if (count) count.textContent = collapsed && items.length ? String(items.length) : "";
}

function initSidebarFoot(disposers: (() => void)[]): void {
  const toggle = $("foot-toggle");
  const onToggle = () => {
    const foot = $("sidebar-foot");
    const collapsed = !!foot && foot.classList.contains("compact");
    saveSidebarState({ footCollapsed: !collapsed });
    applyFootState();
  };
  if (toggle) toggle.addEventListener("click", onToggle);

  // 各模块按开关异步显示 / 隐藏自己的徽标，跟随变化重算（含改设置后重渲染）
  const host = $("foot-badges");
  let observer: MutationObserver | null = null;
  if (host && window.MutationObserver) {
    let queued = false;
    observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        applyFootState();
      });
    });
    observer.observe(host, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden"],
    });
  }

  applyFootState();
  disposers.push(() => {
    if (toggle) toggle.removeEventListener("click", onToggle);
    if (observer) observer.disconnect();
  });
}

// ---------------------------------------------------------------------------
// 绑定
// ---------------------------------------------------------------------------

function bind(): () => void {
  const disposers: (() => void)[] = [];
  const on = (id: string, event: string, handler: EventListener) => {
    const node = $(id);
    if (!node) return;
    node.addEventListener(event, handler);
    disposers.push(() => node.removeEventListener(event, handler));
  };

  // 先屏蔽原生右键菜单，业务菜单由列表项 / 标签各自按需弹出（见 src/features/context-menu/）
  suppressNative();

  on("btn-new-conn", "click", () => connectionsOpenForm(null));
  on("btn-local-term", "click", () => openLocalTerminal());
  on("tab-add-btn", "click", () => connectionsOpenPicker());
  on("btn-settings", "click", () => pt().settings?.open?.());
  on("quick-input", "keydown", (event: Event) => {
    if ((event as KeyboardEvent).key !== "Enter") return;
    event.preventDefault();
    connectionsQuickSubmit();
  });

  initSidebar(disposers);
  initSidebarFoot(disposers);

  Array.from(document.querySelectorAll("[data-close]")).forEach((button) => {
    const target = (button as HTMLElement).dataset.close as string;
    const handler = () => {
      const mask = $(target);
      if (mask) mask.hidden = true;
    };
    button.addEventListener("click", handler);
    disposers.push(() => button.removeEventListener("click", handler));
  });

  // 注：外壳里剩余的弹窗（密码补录 / 通用确认 / 选择 / 危险命令）由 features/util 的
  // 弹窗函数自行处理「点击遮罩关闭」，且关闭时需 resolve 对应 Promise，故不在此统一绑定。

  document.addEventListener("keydown", onKeydown);
  disposers.push(() => document.removeEventListener("keydown", onKeydown));

  const onResize = () => {
    applyFootState();
    terminal.refitAll();
  };
  window.addEventListener("resize", onResize);
  disposers.push(() => window.removeEventListener("resize", onResize));

  if (media) {
    const onSchemeChange = () => {
      const mode = state.config && state.config.theme && state.config.theme.mode;
      if (mode !== "system") return;
      applyTheme();
      terminal.refitAll();
    };
    if (media.addEventListener) media.addEventListener("change", onSchemeChange);
    else if (media.addListener) media.addListener(onSchemeChange);
    disposers.push(() => {
      if (media.removeEventListener) media.removeEventListener("change", onSchemeChange);
      else if (media.removeListener) media.removeListener(onSchemeChange);
    });
  }

  return () => disposers.forEach((fn) => fn());
}

/**
 * 启动应用：迁移本地存储、绑定全局交互并拉取配置引导。
 * 由 App.tsx 在外壳挂载完成后调用（父组件副作用晚于子组件，各功能模块的桥接已就位）。
 * 返回解绑函数供 React 在卸载时清理。
 */
export function startApp(): () => void {
  migrateLegacyStorage();
  const unbind = bind();
  void boot();

  return () => {
    unbind();
  };
}
