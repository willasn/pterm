import { openMenu } from "../context-menu/store";
import { createTracker } from "../danger/tracker";
import { ipc } from "../ipc/api";
import * as tabs from "../tabs/store";
import { $, confirmDialog, el, errorText, toast } from "../util/util";

let ssh: { disconnect(id: string): Promise<void>; reconnect(id: string): Promise<any> };
let syncInput: { targetsFor(id: string): string[] };
let ai: { forget(id: string): void };

export function wireDependencies(deps: {
  ssh: typeof ssh;
  syncInput: typeof syncInput;
  ai: typeof ai;
}): void {
  ({ ssh, syncInput, ai } = deps);
}

/**
 * 终端渲染（由原 src/legacy/terminal.ts 迁移而来）：每个会话一个 xterm 实例 + 一个 pane。
 *
 * 标签与分屏布局由 tabs 模块负责（它按 id 直接操作外壳里的 panes 容器、
 * 并把本模块产出的 pane 追加进对应的 pane-group），因此 pane 仍是命令式创建的 DOM 节点；
 * 本模块只持有终端实例并保证公开 API 稳定。
 *
 * 键盘输入经危险命令检测后写入会话；远端输出通过 Tauri event 流式写入终端。
 */

export interface SessionState {
  state?: string;
  reason?: string;
  message?: string;
  auth_failed?: boolean;
  delay_ms?: number;
  attempt?: number;
  max_attempts?: number;
}

export interface SessionInfo {
  id: string;
  name?: string;
  host?: string;
  state?: SessionState;
  [key: string]: any;
}

/** 本地预测性回显（见 createEcho）。 */
interface Echo {
  setEnabled(next: boolean): void;
  predict(text: string): boolean;
  writeRemote(bytes: Uint8Array): void;
  reset(): void;
}

/** 终端会话控制器：terminal 与 tabs / ssh 等模块协作的接口。 */
export interface TerminalController {
  id: string;
  info: SessionInfo;
  params: any;
  term: any;
  pane: HTMLElement;
  banner: HTMLElement;
  fitAddon: any;
  echo: Echo;
  activated: boolean;
  /** 当前输入法模式。 */
  readonly imeMode: string;
  setImeMode(mode: string): boolean;
  toggleImeMode(): boolean;
  /** 按当前模式重新申请切换系统输入源（终端重新获得焦点时用）。 */
  syncInputSource(): void;
  /** 应用最新配置（字体 / 主题）。 */
  applyConfig(): void;
  /** 写入远端输出（先剥掉本地已经画过的回显）。 */
  writeBytes(bytes: Uint8Array): void;
  /** 根据状态事件更新提示条与标签上的指示灯。 */
  setState(state: SessionState): void;
  fit(): void;
  focus(): void;
  /** 复制选中内容到剪贴板；返回 false 表示本次不接管（无选中）。 */
  copySelection(): boolean;
  /** 把剪贴板内容粘贴到本会话；返回 false 表示本次不接管。 */
  pasteClipboard(): boolean;
  activate(): void;
  dispose(): void;
}

/** 所有已打开的终端会话：id -> controller */
const controllers = new Map<string, TerminalController>();
let config: any = null;

/**
 * 最近一次选择的输入法模式。新会话继承它，避免每开一个标签都要重新切一次。
 * 见 open() 中 imeMode 的说明。
 */
let lastImeMode = "strict";

/** 输入法模式取值。见 open() 中的 imeMode 说明。 */
const IME_STRICT = "strict";
const IME_NATIVE = "native";

let imeWindowBound = false;
/** 「平台不支持自动切换输入源」只提示一次 */
let imeUnsupportedWarned = false;

/**
 * 应用获得 / 失去焦点时同步系统输入源。
 * 只注册一次，作用于当前活跃会话。
 */
function bindWindowInputSource(): void {
  if (imeWindowBound) return;
  imeWindowBound = true;
  // 离开应用：把输入源还给用户，免得他在别的应用里也被迫用英文输入
  window.addEventListener("blur", () => {
    try {
      ipc.imeRestore().catch(() => {});
    } catch (_) {}
  });
  // 回到应用：按当前活跃会话的模式重新申请
  window.addEventListener("focus", () => {
    const ctrl = active();
    if (ctrl && ctrl.syncInputSource) ctrl.syncInputSource();
  });
}

function hasTabs(): boolean {
  return tabs.hasTabs();
}

/** 应用配置变化：字体、主题、滚动缓冲等。 */
export function setConfig(next: any): void {
  config = next;
  controllers.forEach((ctrl) => ctrl.applyConfig());
  tabs.render();
}

/** 终端配色：默认跟随主题的 --term-bg / --term-fg，可被 terminal.background/foreground 独立覆盖。 */
function xtermTheme(): Record<string, string> {
  const css = getComputedStyle(document.body);
  const pick = (name: string) => (css.getPropertyValue(name) || "").trim();
  const t = (config && config.terminal) || {};
  const background = (t.background || "").trim() || pick("--term-bg");
  const foreground = (t.foreground || "").trim() || pick("--term-fg");
  return {
    background,
    foreground,
    cursor: pick("--accent"),
    cursorAccent: background,
    selectionBackground: pick("--bg-hover"),
    black: "#1f2329",
    red: pick("--danger"),
    green: pick("--ok"),
    yellow: pick("--warn"),
    blue: pick("--accent"),
  };
}

function termOptions(): Record<string, any> {
  const t = (config && config.terminal) || {};
  const supported = ["block", "underline", "bar"].includes(t.cursor_style);
  return {
    fontFamily: t.font_family || "Menlo, monospace",
    fontSize: t.font_size || 13,
    lineHeight: t.line_height || 1.2,
    scrollback: t.scrollback || 5000,
    cursorStyle: supported ? t.cursor_style : "block",
    cursorBlink: t.cursor_blink !== false,
    bellStyle: t.bell === false ? "none" : "sound",
    allowProposedApi: true,
    theme: xtermTheme(),
  };
}

export function updateEmptyState(): void {
  const empty = $("empty-state");
  if (empty) empty.hidden = controllers.size > 0;
}

/** 终端本地回显是否开启（config.yaml 的 terminal.local_echo，缺省视为开启）。 */
function localEchoEnabled(): boolean {
  const t = (config && config.terminal) || {};
  return t.local_echo !== false;
}

/**
 * 预测性本地回显：按键立即上屏，远端回显到达后再对齐。
 *
 * 本地绘制分两类：
 * - 纯 ASCII 可打印字符：直接照画（且保证不跨越行尾，撤回才有确定的表达）。
 * - 退格：照画远端 pty 会回显的 `\b \b`。只允许删掉「自己还没被确认的内容」，
 *   这样撤回一定安全；删到已确认的内容会无法回退，所以那种情况不预测。
 * 回车 / Tab / 方向键 / 粘贴 / 非 ASCII 一律不绘制，交给远端真实回显。
 *
 * 远端数据到达后与未确认字节流逐字节比对：一致则丢弃（已经画过），
 * 不一致则撤回整段未确认内容后原样重画，保证屏幕与远端一致。
 */
function createEcho(term: any): Echo {
  /** 已本地绘制、尚未被远端回显确认的字节流（ASCII，可逐字节与回显比对） */
  let pending = "";
  /** 未确认内容占用的净列数：退格会减少它 */
  let visual = 0;
  /** 未确认内容起始处的 buffer 行列，用于定位撤回位置 */
  let startRow = 0;
  let startCol = 0;
  /** 仍在终端解析中的写入数。解析未完成时 buffer 里的光标位置不可信 */
  let busy = 0;
  let enabled = true;

  /** 写入并跟踪解析进度：回调触发时该段数据才真正落到 buffer 上。 */
  function writeTracked(data: string | Uint8Array): void {
    busy += 1;
    try {
      term.write(data, () => {
        busy -= 1;
      });
    } catch (_) {
      // 终端已销毁等异常不能让计数失衡，否则预测会被永久关闭
      busy -= 1;
    }
  }

  /** 全是 ASCII 可打印字符（单宽），可以按列可靠计数。 */
  function allPrintable(text: string): boolean {
    if (!text) return false;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code < 0x20 || code > 0x7e) return false;
    }
    return true;
  }

  /**
   * 由未确认字节流推算它占用的净列数：退格（0x08）为 -1，其余可见字符为 +1。
   * `pending` 只可能含可打印字符与退格，所以这个是精确值。
   */
  function netColumns(text: string): number {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
      n += text.charCodeAt(i) === 8 ? -1 : 1;
    }
    return n;
  }

  /** 撤回全部未确认内容：光标移回预测起点并清到行尾（预测限制在单行内，这样就够）。 */
  function undo(): void {
    if (!pending) return;
    writeTracked("\x1b[" + (startCol + 1) + "G\x1b[K");
    pending = "";
    visual = 0;
  }

  /**
   * 确认还能不能继续预测，必要时记录预测起点。
   * 返回空串表示可以继续，否则返回被拒原因。
   */
  function canExtend(): string {
    const buf = term.buffer.active;
    if (!pending) {
      // 终端还在解析远端数据，此刻读到的光标位置不可信
      if (busy > 0) return "busy";
      startRow = buf.cursorY;
      startCol = buf.cursorX;
      visual = 0;
    } else if (buf.cursorY !== startRow) {
      return "row";
    }
    return "";
  }

  return {
    /**
     * 是否允许新增本地预测。
     * 关闭时不撤回已有未确认内容——它们已经发往远端，撤回只会让屏幕闪一下，
     * 交给 writeRemote 在远端回显到达时正常对齐即可。
     */
    setEnabled(next: boolean): void {
      enabled = !!next;
    },

    /** 按键时立即上屏。返回 true 表示本次已本地绘制。 */
    predict(text: string): boolean {
      if (!enabled) {
        return false;
      }

      // 退格：远端 pty 回显 "\b \b"，本地照画即可即时生效
      if (text === "\x7f" || text === "\b") {
        if (visual <= 0) {
          // 光标已经退到未确认内容起点，再删就会删到已确认的内容，无法安全回退
          return false;
        }
        const why = canExtend();
        if (why) {
          return false;
        }
        writeTracked("\b \b");
        pending += "\b \b";
        visual = netColumns(pending);
        return true;
      }

      if (!allPrintable(text)) {
        return false;
      }
      const why = canExtend();
      if (why) {
        return false;
      }
      // 跨行后无法确定撤回位置，直接放弃预测，等远端回显
      if (startCol + visual + text.length > term.cols) {
        return false;
      }
      writeTracked(text);
      pending += text;
      visual = netColumns(pending);
      return true;
    },

    /**
     * 写入远端数据：剥掉本地已经画过的回显，必要时整段撤回重画。
     * 只要还有未确认内容就必须对齐（不依赖 enabled）——否则这些内容会被重复画一遍。
     */
    writeRemote(bytes: Uint8Array): void {
      let out: Uint8Array | string = bytes;
      if (pending) {
        const before = pending;
        const shared = Math.min(before.length, bytes.length);
        let i = 0;
        while (i < shared && bytes[i] === before.charCodeAt(i)) i += 1;
        if (i < shared) {
          // 对不上：以远端为准，撤回未确认内容后原样重画
          undo();
        } else if (i === before.length) {
          // 整个预测都被这次回显确认（已画在屏幕上），多余部分照写
          pending = "";
          visual = 0;
          out = bytes.subarray(i);
        } else {
          // 只回显了一部分（TCP 分片），剩下的继续等，不能当作不一致撤回
          pending = before.slice(i);
          visual = netColumns(pending);
          out = bytes.subarray(i);
        }
      }
      if (out.length) writeTracked(out);
    },

    /** 会话不可写、写入失败或状态变化时调用：未确认内容没有送达，撤回。 */
    reset: undo,
  };
}

/** 会话是否处于可写入状态。非就绪时后端会丢弃输入，这里直接拦下并提示。 */
function isWritable(ctrl: TerminalController): boolean {
  const state = ctrl.info && ctrl.info.state;
  const kind = state && state.state;
  if (!kind) return true;
  return kind === "ready";
}

/** 提示输入未被接收，做节流避免刷屏。 */
function warnNotWritable(ctrl: TerminalController & { warnedAt?: number }): void {
  const now = Date.now();
  if (ctrl.warnedAt && now - ctrl.warnedAt < 2000) return;
  ctrl.warnedAt = now;
  toast("连接未就绪，输入未发送", "info");
}

/**
 * 打开一个终端与会话绑定。
 * @param info 后端返回的 SessionInfo
 * @param options `{ params, onExit }`
 */
export function open(info: SessionInfo, options?: any): TerminalController {
  const opts = options || {};

  const term = new window.Terminal(termOptions());
  const FitAddonCtor = window.FitAddon && window.FitAddon.FitAddon;
  const fitAddon = FitAddonCtor ? new FitAddonCtor() : null;
  if (fitAddon) term.loadAddon(fitAddon);

  const pane = el("div", { class: "pane", dataset: { id: info.id } });
  const banner = el("div", { class: "pane-banner" }, [el("span", { class: "text" })]);
  pane.appendChild(banner);

  // 预测性本地回显：按键先上屏，远端回显到达后再对齐（见 createEcho）
  const echo = createEcho(term);
  echo.setEnabled(localEchoEnabled());
  /** 本会话挂到 document / pane 上的监听器摘除函数，销毁时统一摘掉 */
  const detachHandlers: (() => void)[] = [];

  /**
   * 输入法模式。
   *
   * WKWebView 里简体拼音 / 微信输入法即使切到英文，也会把普通字母键报成
   * keyCode 229（"正在组词"），字符只能经隐藏 textarea 的组合输入通道进来：
   * 快打丢字、慢打一个键插两次。而系统 ABC 输入法没有这个问题。
   *
   * 这里不试图在 Web 层"挡住输入法"——把 textarea 设为只读会连带把中文输入一起
   * 废掉，且 WKWebView 下 readOnly 复位后输入法上下文不会恢复。改为让 Rust 侧
   * 切换系统输入源：
   *
   * - 命令模式（默认）：终端获得焦点时把系统输入源切到英文、应用失焦时还原。
   *   英文命令走 xterm 原生按键通道，既不漏字也跟手；想输中文时切到输入法模式。
   * - 输入法模式：不做任何干预，交还给系统输入法，中文正常输入。
   *
   * 终端内用 Cmd/Ctrl+Shift+I 或点击右下角角标切换，选择会被新会话继承。
   */
  let imeMode = lastImeMode === IME_NATIVE ? IME_NATIVE : IME_STRICT;
  /** 右下角的模式角标（可点击切换），在 term.open 之后创建 */
  let imeBadge: HTMLElement | null = null;

  /** 按当前模式申请切换系统输入源。平台不支持时切换不会生效。 */
  function syncInputSource(): void {
    let req;
    try {
      req = imeMode === IME_STRICT ? ipc.imeUseAscii() : ipc.imeRestore();
    } catch (_) {
      return;
    }
    Promise.resolve(req)
      .then((ok) => {
        // 非 macOS 平台不做切换，提示一次让用户知道要自己用英文输入法
        if (!ok && imeMode === IME_STRICT && !imeUnsupportedWarned) {
          imeUnsupportedWarned = true;
          toast("当前平台不支持自动切换输入源，请在终端中使用英文输入法", "info");
        }
      })
      .catch(() => {});
  }

  /** 同步与模式相关的界面状态。 */
  function applyImeMode(): void {
    pane.dataset.ime = imeMode;
    // 输入法模式下字符可能来自组合输入（拼音字母会被替换成汉字），本地预测会和它
    // 打架，因此只在命令模式下预测；输入法模式退回"等远端回显"，慢但不乱。
    echo.setEnabled(localEchoEnabled() && imeMode === IME_STRICT);
    if (imeBadge) {
      imeBadge.textContent = imeMode === IME_STRICT ? "命令模式" : "输入法模式";
      imeBadge.dataset.ime = imeMode;
    }
  }

  /** 切换输入法模式。返回 true 表示确实发生了切换。 */
  function setImeMode(mode: string): boolean {
    const next = mode === IME_NATIVE ? IME_NATIVE : IME_STRICT;
    if (next === imeMode) return false;
    imeMode = next;
    lastImeMode = next;
    applyImeMode();
    syncInputSource();
    // 切换发生在角标点击时，焦点可能已经离开终端，交还给它
    try {
      term.focus();
    } catch (_) {}
    toast(
      next === IME_STRICT
        ? "命令模式：终端内已切到英文输入，不会漏字"
        : "输入法模式：已交还你的输入法，可以输入中文",
      "info"
    );
    return true;
  }

  const ctrl: TerminalController = {
    id: info.id,
    info,
    params: opts.params || null,
    term,
    pane,
    banner,
    fitAddon,
    echo,
    activated: false,

    /** 当前输入法模式。 */
    get imeMode() {
      return imeMode;
    },
    setImeMode,
    toggleImeMode() {
      return setImeMode(imeMode === IME_STRICT ? IME_NATIVE : IME_STRICT);
    },
    /** 按当前模式重新申请切换系统输入源（终端重新获得焦点时用）。 */
    syncInputSource,

    /** 应用最新配置（字体 / 主题）。 */
    applyConfig() {
      const next = termOptions();
      Object.assign(term.options, next);
      echo.setEnabled(localEchoEnabled());
      applyImeMode();
    },

    /** 写入远端输出（先剥掉本地已经画过的回显）。 */
    writeBytes(bytes: Uint8Array) {
      echo.writeRemote(bytes);
    },

    /** 根据状态事件更新提示条与标签上的指示灯。 */
    setState(state: SessionState) {
      const kind = state && state.state ? state.state : "disconnected";
      if (state) this.info.state = state;
      // 非就绪时未确认的本地预测不会送达远端，撤回以免屏幕与 shell 不一致
      if (kind !== "ready") echo.reset();
      pane.dataset.state = kind;
      renderBanner(this, state);
      // 分屏时可能同时有多个会话在连接，只把焦点给当前活跃的那个
      if (kind === "ready" && tabs.activeIdOf() === info.id) term.focus();
      tabs.touch(this);
    },

    fit() {
      fit(this);
    },

    focus() {
      term.focus();
      // 终端（重新）拿到焦点时重新申请切换输入源：应用可能刚从后台回来，
      // 输入法已经被还原成用户自己的了。
      syncInputSource();
    },

    /** 复制选中内容到剪贴板；返回 false 表示本次不接管（无选中）。 */
    copySelection: copyToClipboard,
    /** 把剪贴板内容粘贴到本会话；返回 false 表示本次不接管。 */
    pasteClipboard: pasteFromClipboard,

    activate() {
      activate(info.id);
    },

    dispose() {
      detachHandlers.splice(0).forEach((fn) => {
        try {
          fn();
        } catch (_) {}
      });
      try {
        term.dispose();
      } catch (_) {}
      pane.remove();
    },
  };

  // 键盘输入 -> 危险命令检测 -> 本地即时上屏 -> 写入会话
  const tracker = createTracker();

  /** 统一的输入处理。 */
  function dispatchInput(data: string): void {
    const verdict = tracker.feed(data);
    // 未就绪时输入进不到远端，直接拦下并提示，不再静默丢弃
    if (!isWritable(ctrl)) {
      warnNotWritable(ctrl);
      return;
    }
    if (verdict && verdict.reason) {
      holdForConfirm(ctrl, data, verdict);
      return;
    }
    if (verdict && verdict.command && !verdict.stale) {
      recordHistory(ctrl, verdict.command);
    }
    echo.predict(data);
    send(ctrl, data);
    mirror(ctrl, data);
  }

  term.onData((data: string) => {
    dispatchInput(data);
  });

  // 终端内切换输入法模式。放在捕获阶段，确保抢在 xterm 的 keydown 处理之前。
  const onImeToggleKey = (event: KeyboardEvent) => {
    if (!event.shiftKey || !(event.metaKey || event.ctrlKey)) return;
    if (event.code !== "KeyI") return;
    if (!ctrl.pane.contains(document.activeElement)) return;
    event.preventDefault();
    event.stopPropagation();
    ctrl.toggleImeMode();
  };
  document.addEventListener("keydown", onImeToggleKey, true);
  detachHandlers.push(() => document.removeEventListener("keydown", onImeToggleKey, true));

  // 这里不再接管按键、也不改 textarea 的可写性：命令模式靠"把系统输入源切到英文"
  // 让按键走 xterm 的原生通道，输入法模式下则完全交还系统输入法，两条路都不需要
  // preventDefault，也就不会和输入法互相打架。
  // 已知限制：命令模式下用户若手动把输入源切回拼音，漏字问题会重现——此时应切到
  // 输入法模式（角标或 Cmd/Ctrl+Shift+I），或在设置里关掉自动切换。

  // 选中即复制
  term.onSelectionChange(() => {
    const t = (config && config.terminal) || {};
    if (!t.copy_on_select) return;
    const selection = term.getSelection();
    if (selection) {
      navigator.clipboard && navigator.clipboard.writeText(selection).catch(() => {});
    }
  });

  // 复制 / 粘贴的统一入口：快捷键（shortcuts 的 terminal.copy / .paste）与右击菜单都走这里
  const clipboardApi = () => navigator.clipboard || null;

  /** 把选中文本写入剪贴板。无选中、或本环境没有剪贴板 API 时返回 false，让按键原样落到终端。 */
  function copyToClipboard(): boolean {
    const text = term.getSelection();
    if (!text) return false;
    const api = clipboardApi();
    if (!api || typeof api.writeText !== "function") return false;
    api.writeText(text).catch(() => toast("写入剪贴板失败", "error"));
    return true;
  }

  /**
   * 把剪贴板内容写入终端。走 xterm 的 paste()：括号粘贴模式、危险命令检测、事件流
   * 都与系统粘贴键一致，因此粘贴进来的危险命令同样会被拦下确认。
   */
  function pasteFromClipboard(): boolean {
    const api = clipboardApi();
    if (!api || typeof api.readText !== "function") {
      toast("当前环境不支持读取剪贴板，请使用系统粘贴键", "warn");
      return false;
    }
    api
      .readText()
      .then((text) => {
        if (!text) return;
        // 可能是右击菜单发起的粘贴，焦点不在终端：仍写进这个会话，并把焦点收回来
        term.paste(text);
        ctrl.focus();
      })
      .catch(() => toast("读取剪贴板失败：请授予剪贴板权限，或使用系统粘贴键", "warn"));
    return true;
  }

  // 点击非活跃 pane 时把它切换为当前会话
  pane.addEventListener("mousedown", () => {
    if (tabs.activeIdOf() !== info.id) tabs.activate(info.id);
  });

  // term.open 会自己把 .xterm 容器插入 pane；提示条为绝对定位，随后追加即可
  term.open(pane);
  pane.appendChild(banner);

  // 终端内右击：原生菜单已被通用右键菜单模块全局屏蔽（src/features/context-menu/），
  // 这里按配置补一个「复制 / 粘贴」菜单
  const onContextMenu = (event: MouseEvent) => {
    const t = (config && config.terminal) || {};
    if (t.right_click_menu === false) return;
    event.preventDefault();
    openMenu(event.clientX, event.clientY, [
      { label: "复制", disabled: !term.hasSelection(), run: () => copyToClipboard() },
      { label: "粘贴", run: () => pasteFromClipboard() },
    ]);
  };
  term.element.addEventListener("contextmenu", onContextMenu);
  detachHandlers.push(() => term.element.removeEventListener("contextmenu", onContextMenu));

  // 右下角模式角标：既提示当前模式，也提供一个可见的切换入口
  imeBadge = el("button", {
    class: "pane-ime",
    type: "button",
    title: "点击切换输入法模式（快捷键 Cmd/Ctrl+Shift+I）",
    onmousedown: (event: Event) => event.preventDefault(), // 别把终端焦点抢走
    onclick: () => ctrl.toggleImeMode(),
  });
  pane.appendChild(imeBadge);
  // 必须在 term.open 之后：helper textarea 是它创建出来的
  applyImeMode();
  // 命令模式下把系统输入源切到英文，让命令走 xterm 原生按键通道
  bindWindowInputSource();
  syncInputSource();

  controllers.set(info.id, ctrl);
  tabs.attach(ctrl, opts);
  updateEmptyState();
  ctrl.setState(info.state || { state: "connecting" });
  return ctrl;
}

function renderBanner(ctrl: TerminalController, state: SessionState): void {
  const banner = ctrl.banner;
  const text = banner.querySelector(".text") as HTMLElement;
  const set = (cls: string, message: string, actions?: { text: string; run: () => void }[]) => {
    banner.className = "pane-banner show " + (cls || "");
    text.textContent = message;
    // 清掉上一轮渲染的按钮与占位，避免状态切换时元素堆积
    Array.from(banner.children).forEach((child) => {
      if (child !== text) child.remove();
    });
    (actions || []).forEach((action) =>
      banner.appendChild(el("button", { class: "btn ghost", text: action.text, onclick: action.run }))
    );
  };

  const kind = state && state.state;
  switch (kind) {
    case "connecting":
      set("", "正在建立连接…");
      break;
    case "authenticated":
      set("", "认证成功，正在启动 shell…");
      break;
    case "ready":
      banner.className = "pane-banner";
      break;
    case "reconnecting":
      set(
        "",
        `连接中断：${state.reason}；${Math.round((state.delay_ms || 0) / 1000)} 秒后进行第 ${state.attempt}/${state.max_attempts} 次重连`,
        [{ text: "停止重连", run: () => ssh.disconnect(ctrl.id) }]
      );
      break;
    case "error":
      set("error", "连接失败：" + state.message, [
        { text: "重新连接", run: () => ssh.reconnect(ctrl.id) },
        { text: "关闭", run: () => close(ctrl.id) },
      ]);
      break;
    case "closed":
    case "disconnected":
    default:
      set("", (state && state.reason) || "会话已结束", [
        { text: "重新连接", run: () => ssh.reconnect(ctrl.id) },
        { text: "关闭标签", run: () => close(ctrl.id) },
      ]);
      break;
  }
}

async function holdForConfirm(
  ctrl: TerminalController,
  raw: string,
  verdict: { command: string; reason: string | null }
): Promise<void> {
  const confirmed = await confirmDialog({
    command: verdict.command,
    reason: "命中危险命令规则：" + verdict.reason,
  });
  if (confirmed) {
    recordHistory(ctrl, verdict.command);
    send(ctrl, raw);
    mirror(ctrl, raw);
  } else {
    // 用户取消：不发送回车，让远端缓冲区保持原样
    toast("已取消执行该命令", "info");
  }
}

function recordHistory(ctrl: TerminalController, command: string): void {
  const flags = config && config.features && config.features.auxiliary;
  if (!flags || !flags.command_history) return;
  const host = (ctrl.info && ctrl.info.host) || "";
  ipc.pushHistory(command, host, ctrl.id).catch(() => {});
}

function send(ctrl: TerminalController, data: string): void {
  ipc.sshWrite(ctrl.id, data).catch((err) => {
    // 写入失败意味着这些字符没有送达远端：撤回本地预测，
    // 否则屏幕上会留下一条 shell 从未收到的命令。
    ctrl.echo.reset();
    toast(errorText(err), "error");
  });
}

/**
 * 同步输入：把刚输入的数据广播到同一同步组的其它会话（全局模式则广播到全部）。
 * 只写处于就绪状态的目标，避免把字符丢给未连接 / 已断开的会话；源会话仍由 send 负责。
 */
function mirror(ctrl: TerminalController, data: string): void {
  const ids = syncInput.targetsFor(ctrl.id);
  ids.forEach((id) => {
    if (id === ctrl.id) return;
    const target = controllers.get(id);
    if (!target || !isWritable(target)) return;
    ipc.sshWrite(id, data).catch(() => {});
  });
}

function doFit(ctrl: TerminalController & { fitTimer?: any; lastCols?: number }): void {
  if (!ctrl.fitAddon) return;
  // 隐藏的 pane 尺寸为 0，fit 会算出非法行列数
  if (!ctrl.pane.isConnected || ctrl.pane.clientWidth === 0 || ctrl.pane.clientHeight === 0) return;
  // 尺寸变化会重排缓冲，未确认预测的行列不再可信：先撤回，让远端回显重新画
  ctrl.echo.reset();
  try {
    ctrl.fitAddon.fit();
  } catch (_) {
    return;
  }
  ipc.sshResize(ctrl.id, ctrl.term.cols, ctrl.term.rows).catch(() => {});
  ctrl.lastCols = ctrl.term.cols;
}

/**
 * 按 pane 节流。
 * 不能用共享的 debounce：分屏时 fitGroup 会在同一 tick 内对多个 pane 调用 fit，
 * 共享 timer 会把它们合并成一次，只有最后一个 pane 真正 fit，其余 pane 的列数
 * 停留在分屏前的全宽值，导致文字不换行、溢出到相邻 pane 或窗口外。
 */
function fit(ctrl: TerminalController & { fitTimer?: any }): void {
  if (ctrl.fitTimer) clearTimeout(ctrl.fitTimer);
  ctrl.fitTimer = setTimeout(() => {
    ctrl.fitTimer = null;
    doFit(ctrl);
  }, 120);
}

export function activate(id: string): void {
  tabs.activate(id);
}

/** 关闭终端（不负责通知后端）。 */
export function close(id: string): void {
  const ctrl = controllers.get(id);
  if (!ctrl) return;
  controllers.delete(id);
  ctrl.dispose();
  tabs.detach(ctrl);
  // 对话与 SSH 会话绑定：会话关闭后丢弃它那份 AI 对话
  if (ai && typeof ai.forget === "function") ai.forget(id);
  updateEmptyState();
}

export function get(id: string): TerminalController | null {
  return controllers.get(id) || null;
}

export function active(): TerminalController | null {
  const id = tabs.activeIdOf();
  return id ? controllers.get(id) || null : null;
}

export function list(): TerminalController[] {
  return Array.from(controllers.values());
}

export function refitAll(): void {
  controllers.forEach((ctrl) => ctrl.applyConfig());
  const group = tabs.activeGroup();
  if (!group) return;
  group.memberIds.forEach((id: string) => {
    const ctrl = controllers.get(id);
    if (ctrl) ctrl.fit();
  });
}

/** 复制当前终端（活跃会话）的选中内容。无选中返回 false，快捷键派发据此放行按键。 */
export function copySelection(): boolean {
  const ctrl = active();
  return ctrl ? ctrl.copySelection() : false;
}

/** 把剪贴板内容粘贴到当前终端（活跃会话）。返回 false 表示本次不接管按键。 */
export function pasteClipboard(): boolean {
  const ctrl = active();
  return ctrl ? ctrl.pasteClipboard() : false;
}

export { hasTabs };

export function isSupported(): boolean {
  return !!window.Terminal;
}
