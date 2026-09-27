/* 快捷键：把 config.shortcuts 里的绑定解析成可派发的动作。
 *
 * 绑定表是可编辑的纯数据（config.shortcuts），本模块只做两件事：
 * 1. 按键派发——matches() 判断事件是否命中组合键，命中即调用对应动作；
 * 2. 冲突检测——conflicts() 找出重复组合键、未实现的动作 id 与空缺字段，
 *    供设置界面提示（派发取「首个命中」，重复绑定会让后者变成死键）。
 * Escape 关闭弹窗属于全局交互，仍由 app.js 处理。 */
(function (PShell) {
  "use strict";

  const { $ } = PShell.util;

  let config = null;

  /** action -> { label, hint, run }。只登记前端已实现的动作，其余动作静默忽略。 */
  const ACTIONS = {
    "tab.new": {
      label: "新建标签 / 连接",
      hint: "打开连接选择器",
      run: () => PShell.connections.openPicker(),
    },
    "tab.close": {
      label: "关闭当前会话",
      hint: "断开并移除当前标签中的会话",
      run: () => {
        const ctrl = PShell.terminal.active();
        if (ctrl) PShell.ssh.close(ctrl.id);
      },
    },
    "tab.next": {
      label: "下一个标签",
      hint: "切换到下一个会话标签",
      run: () => {
        const list = PShell.terminal.list();
        if (list.length < 2) return;
        const current = PShell.terminal.active();
        const index = current ? list.indexOf(current) : -1;
        PShell.terminal.activate(list[(index + 1) % list.length].id);
      },
    },
    "app.settings": {
      label: "打开设置",
      hint: "修改配置与功能开关",
      run: () => PShell.settings.open(),
    },
    "app.search": {
      label: "全局搜索",
      hint: "跨连接 / 片段 / 历史 / 设置检索",
      run: () => PShell.search.open(),
    },
    "view.split_h": {
      label: "左右分屏",
      hint: "在当前标签内左右并排两个会话",
      run: () => PShell.split.start("h"),
    },
    "view.split_v": {
      label: "上下分屏",
      hint: "在当前标签内上下堆叠两个会话",
      run: () => PShell.split.start("v"),
    },
    "app.quick_connect": {
      label: "快捷连接",
      hint: "聚焦 user@host:port 输入框",
      run: () => {
        const box = $("quick-input");
        const wrap = $("quick-connect");
        if (box && wrap && !wrap.hidden) box.focus();
      },
    },
    "app.quick_panel": {
      label: "快捷面板",
      hint: "唤出本命令面板（类 Spotlight）",
      run: () => PShell.quickPanel.open(),
    },
    "app.ai": {
      label: "AI 助手",
      hint: "打开 AI 助手面板",
      run: () => PShell.ai.open(),
    },
  };

  const isMac = /mac/i.test(navigator.platform || "") || /mac os x/i.test(navigator.userAgent || "");

  /** 判断事件是否命中 "CmdOrCtrl+Shift+E" 这类组合。 */
  function matches(event, keys) {
    if (!keys) return false;
    const parts = String(keys)
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean);
    let ctrl = false;
    let shift = false;
    let alt = false;
    let meta = false;
    let key = "";

    parts.forEach((part) => {
      const lower = part.toLowerCase();
      if (lower === "cmdorctrl" || lower === "mod") {
        if (isMac) meta = true;
        else ctrl = true;
      } else if (lower === "ctrl" || lower === "control") ctrl = true;
      else if (lower === "shift") shift = true;
      else if (lower === "alt" || lower === "option") alt = true;
      else if (lower === "meta" || lower === "cmd" || lower === "command") meta = true;
      else key = part;
    });

    if (!key) return false;
    if (event.ctrlKey !== ctrl) return false;
    if (event.shiftKey !== shift) return false;
    if (event.altKey !== alt) return false;
    if (event.metaKey !== meta) return false;
    return event.key.toLowerCase() === key.toLowerCase();
  }

  /**
   * 把组合键归一化成可比较的形式：大小写无关、修饰键顺序无关，
   * 并把 CmdOrCtrl 按当前平台解析成 ctrl / meta。无按键部分时返回 ""。
   */
  function normalizedKeys(keys) {
    if (!keys) return "";
    const parts = String(keys)
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean);
    const mods = new Set();
    let key = "";

    parts.forEach((part) => {
      const lower = part.toLowerCase();
      if (lower === "cmdorctrl" || lower === "mod") {
        mods.add(isMac ? "meta" : "ctrl");
      } else if (lower === "ctrl" || lower === "control") mods.add("ctrl");
      else if (lower === "shift") mods.add("shift");
      else if (lower === "alt" || lower === "option") mods.add("alt");
      else if (lower === "meta" || lower === "cmd" || lower === "command") mods.add("meta");
      else key = lower;
    });

    if (!key) return "";
    return ["ctrl", "shift", "alt", "meta"]
      .filter((mod) => mods.has(mod))
      .concat(key)
      .join("+");
  }

  function enabled() {
    return !!(config && config.features && config.features.auxiliary && config.features.auxiliary.shortcuts);
  }

  /** 查询某个动作当前绑定的组合键（无绑定返回空串）。 */
  function curKeys(actionId) {
    const bindings = (config && config.shortcuts) || [];
    const hit = bindings.filter((item) => item && item.action === actionId)[0];
    return (hit && hit.keys) || "";
  }

  /** 派发一次按键。返回 true 表示已识别并执行（调用方无需再处理）。 */
  function handleKeydown(event) {
    if (!enabled()) return false;
    const bindings = (config && config.shortcuts) || [];
    // 取首个命中：同一组合键绑定多个动作时，只有靠前的那条生效
    const hit = bindings.filter((item) => matches(event, item.keys))[0];
    if (!hit) return false;
    const action = ACTIONS[hit.action];
    if (!action || typeof action.run !== "function") return false;
    event.preventDefault();
    action.run();
    return true;
  }

  /**
   * 冲突检测。返回 `[{ level: "error" | "warn", text }]`：
   * - 重复组合键 → error：派发只取首个命中，后者是死键；
   * - 未实现的动作 id → warn：绑定会保存，但当前不会触发；
   * - 缺少动作 id 或组合键 → warn：保存时会被丢弃。
   */
  function conflicts(bindings) {
    const list = Array.isArray(bindings) ? bindings : [];
    const issues = [];
    const seen = new Map();

    list.forEach((item, index) => {
      const no = index + 1;
      const action = ((item && item.action) || "").trim();
      const keys = ((item && item.keys) || "").trim();

      if (!action && !keys) {
        issues.push({ level: "warn", text: `第 ${no} 条：动作与组合键都为空，保存时会被丢弃。` });
        return;
      }
      if (!action) {
        issues.push({ level: "warn", text: `第 ${no} 条：缺少动作 id，保存时会被丢弃。` });
      } else if (!ACTIONS[action]) {
        issues.push({ level: "warn", text: `第 ${no} 条：动作 id「${action}」尚未实现，该绑定不会触发。` });
      }
      if (!keys) {
        issues.push({ level: "warn", text: `第 ${no} 条：缺少组合键，保存时会被丢弃。` });
        return;
      }

      const normalized = normalizedKeys(keys);
      if (!normalized) {
        issues.push({ level: "warn", text: `第 ${no} 条：组合键「${keys}」没有可识别的按键。` });
        return;
      }
      if (seen.has(normalized)) {
        issues.push({
          level: "error",
          text: `第 ${no} 条：组合键「${keys}」与第 ${seen.get(normalized)} 条重复，只有靠前的那条生效。`,
        });
        return;
      }
      seen.set(normalized, no);
    });

    return issues;
  }

  PShell.shortcuts = {
    /** 应用配置变化。 */
    setConfig(next) {
      config = next;
    },
    /** 动作注册表快照，供快捷面板（quick_panel.js）列出可执行命令。 */
    actions() {
      return Object.keys(ACTIONS).map((id) => ({
        id,
        label: ACTIONS[id].label,
        hint: ACTIONS[id].hint || "",
        keys: curKeys(id),
      }));
    },
    /** 直接执行某个动作 id（供快捷面板复用，与快捷键派发走同一入口）。 */
    run(actionId) {
      const action = ACTIONS[actionId];
      if (action && typeof action.run === "function") {
        action.run();
        return true;
      }
      return false;
    },
    handleKeydown,
    matches,
    conflicts,
  };
})(window.PShell);