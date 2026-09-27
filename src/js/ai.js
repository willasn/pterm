/* AI 助手交互面板（FEATURES.md §5）。
 *
 * 只在 features.ai.ai_assistant 打开时可用：关闭时入口隐藏、面板不加载，
 * 后端 command 也会以 ModuleDisabled 拒绝。
 *
 * 内容区是**一条按 SSH 会话隔离的消息流**：每个终端会话各有一份对话，切标签各自
 * 独立、切回仍能看到，会话关闭即清空，不落库。用户提问原样进流，模型的流式回答 /
 * Agent 的每步命令与结论也依次进流。提问发出后输入框立即清空，避免消息看起来还停
 * 在输入框里。
 *
 * 面板只负责「组织提问 → 派发命令 → 订阅事件 → 展示」；提示词组装在 Rust 侧完成，
 * 前端不重复实现语义。Ask 模式的输出只读，不注入终端；Agent 模式的每条命令都要
 * 用户确认，危险命令额外二次确认，循环在前端跑（后端只做决策）。 */
(function (PShell) {
  "use strict";

  const { el, $, toast, ask, errorText, confirmDialog } = PShell.util;
  const { select } = PShell.form;

  let enabled = false;
  let flags = {};
  let aiConfig = {};

  /** 面板里选中的模型条目 id；跨面板开关保留，避免每次都要重选 */
  let selectedModelId = "";
  /** 交互模式：ask 只回答，agent 可读终端并请求执行命令 */
  let mode = "ask";
  /** Agent 单轮循环上限，防止模型反复试探停不下来 */
  const MAX_AGENT_STEPS = 10;

  /** 没有活动会话时（尚未连接 / 全部关闭）的兜底 key，仅用于显示空状态 */
  const NO_SESSION_KEY = "__no_session__";

  /**
   * 每个终端会话一份面板状态（key = 终端会话 id）：
   *   messages  消息流（用户提问 / 助手回答 / Agent 命令与结论）
   *   askId     在途 Ask 请求 id；非空表示正在等回答
   *   agent     Agent 循环状态；未运行过为 null
   *
   * 对话与 SSH 会话绑定：切标签各自独立、切回仍能看到；会话关闭即从表中删除
   * （见 forget）。只存在内存里，不落库。
   */
  const sessionViews = new Map();

  function sessionState(key) {
    let view = sessionViews.get(key);
    if (!view) {
      view = { key: key, messages: [], askId: null, agent: null };
      sessionViews.set(key, view);
    }
    return view;
  }

  /** 当前活动会话对应的 key。 */
  function currentKey() {
    return sessionIdOf() || NO_SESSION_KEY;
  }

  function currentView() {
    return sessionState(currentKey());
  }

  /**
   * 当前内容区（中部可滚动区域）的节点集合。
   * 面板骨架是静态 HTML（见 index.html），这里只持有随模式 / 会话重建的内容节点。
   */
  let body = null;
  /** 消息流目前渲染的是哪个会话；切换标签时据此判断需要重建 */
  let renderedKey = null;

  /** 面板宽度上下限。上限用比例，避免把终端挤没。 */
  const PANEL_MIN_WIDTH = 320;
  const PANEL_MAX_RATIO = 0.7;
  const PANEL_WIDTH_KEY = "pshell.aiPanelWidth";

  function syncFlags(config) {
    return (config && config.features && config.features.ai) || {};
  }

  function panelNode() {
    return $("ai-panel");
  }

  function isOpen() {
    const p = panelNode();
    return !!p && !p.hidden;
  }

  function inputNode() {
    return $("ai-input");
  }

  function inputValue() {
    const node = inputNode();
    return node ? node.value : "";
  }

  /** 输入框随内容长高；上限由 CSS 的 max-height 控制，超出后由 textarea 自己滚动。 */
  function autoGrow() {
    const node = inputNode();
    if (!node) return;
    node.style.height = "auto";
    node.style.height = node.scrollHeight + "px";
  }

  /** 发送后清空输入框并复位高度，不留上一条问题。 */
  function clearInput() {
    const node = inputNode();
    if (!node) return;
    node.value = "";
    autoGrow();
  }

  /** 底部控件行里选中的模型条目 id；下拉不存在时返回 null（后端会回退到默认模型）。 */
  function selectedModel() {
    const host = $("ai-model-host");
    const node = host ? host.querySelector("select") : null;
    return node && node.value ? node.value : null;
  }

  function activeSession() {
    return PShell.terminal.active();
  }

  function hostOf() {
    const ctrl = activeSession();
    return ctrl && ctrl.info ? ctrl.info.host || "" : "";
  }

  function sessionIdOf() {
    const ctrl = activeSession();
    return ctrl ? ctrl.id : null;
  }

  /** 面板开合会改变终端可用宽度，必须让 xterm 重新计算列数。 */
  function refitTerminals() {
    if (PShell.terminal && typeof PShell.terminal.refitAll === "function") {
      PShell.terminal.refitAll();
    }
  }

  // -------------------------------------------------------------------------
  // 停靠面板：开关、宽度记忆、拖拽调宽
  // -------------------------------------------------------------------------

  function savedWidth() {
    try {
      const v = parseInt(localStorage.getItem(PANEL_WIDTH_KEY) || "", 10);
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (_) {
      return 0;
    }
  }

  /** 应用面板宽度。越界时夹到 [最小值, 主区宽度的 70%]。 */
  function applyWidth(px) {
    const p = panelNode();
    if (!p) return 0;
    const main = document.querySelector(".main");
    const avail = main ? main.getBoundingClientRect().width : window.innerWidth;
    const max = Math.max(PANEL_MIN_WIDTH, Math.round(avail * PANEL_MAX_RATIO));
    const w = Math.max(PANEL_MIN_WIDTH, Math.min(Math.round(px), max));
    p.style.width = w + "px";
    return w;
  }

  function persistWidth() {
    const p = panelNode();
    if (!p) return;
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(p.getBoundingClientRect().width)));
    } catch (_) {
      /* 存储不可用时仅本次会话生效 */
    }
  }

  /** 左缘拖拽调宽。只绑定一次。 */
  function bindResizer() {
    const handle = $("ai-resizer");
    if (!handle || handle.dataset.bound) return;
    handle.dataset.bound = "1";

    let dragging = false;
    handle.addEventListener("pointerdown", (event) => {
      dragging = true;
      handle.classList.add("dragging");
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const main = document.querySelector(".main");
      if (!main) return;
      // 面板贴主区右缘：宽度 = 主区右边界 - 指针 x
      applyWidth(main.getBoundingClientRect().right - event.clientX);
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
      persistWidth();
      refitTerminals();
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  function focusInput() {
    const node = inputNode();
    if (node) node.focus();
  }

  function close() {
    const p = panelNode();
    if (!p || p.hidden) return;
    // 面板收起来后 Agent 循环就没有了确认入口（命令确认按钮只在这里），
    // 明确停掉所有会话的循环，避免留下「运行中」却无人推进的状态
    agentStopAll();
    p.hidden = true;
    body = null;
    renderedKey = null;
    renderBadge();
    refitTerminals();
  }

  // -------------------------------------------------------------------------
  // 标签栏右侧入口
  // -------------------------------------------------------------------------

  /** 入口按钮：开启且有会话时才出现；点它开合面板。 */
  function renderBadge() {
    // tabs.js 在标签切换 / 增删时调这里，顺带对齐消息流：会话变了就要换成那个
    // 会话自己的记录，否则会看到上一个会话的对话
    if (isOpen() && renderedKey !== currentKey()) renderScroll();

    const node = $("ai-status");
    if (!node) return;
    const hasSession = !!(PShell.tabs && PShell.tabs.hasTabs());
    node.hidden = !(enabled && hasSession);
    node.textContent = "AI";
    const on = isOpen();
    node.classList.toggle("active", on);
    node.title = on ? "收起 AI 助手" : "打开 AI 助手";
  }

  // -------------------------------------------------------------------------
  // 面板
  // -------------------------------------------------------------------------

  /** 模型下拉：列出设置中定义的自定义模型，value 用条目 id 以便后端定位地址与 Key。 */
  function buildModelSelect() {
    const models = (aiConfig && aiConfig.models) || [];
    const options = models.map((m) => {
      const label = m.name || m.model || "未命名模型";
      return { value: m.id, label: m.model && m.name ? `${label}（${m.model}）` : label };
    });
    const node = select(options, {});
    if (selectedModelId && models.some((m) => m.id === selectedModelId)) {
      node.value = selectedModelId;
    }
    node.title = "选择模型";
    node.addEventListener("change", () => {
      selectedModelId = node.value;
    });
    return node;
  }

  /** 模式切换控件（Ask / Agent），填进底部控件行的固定挂载点。 */
  function renderModeSwitch() {
    const host = $("ai-mode-switch");
    if (!host) return;
    host.textContent = "";
    host.setAttribute("role", "group");
    host.setAttribute("aria-label", "AI 交互模式");
    const make = (value, label, hint) =>
      el("button", {
        class: "btn " + (mode === value ? "primary" : "ghost"),
        type: "button",
        text: label,
        title: hint,
        // 选中态同时落到类名、data 与 aria 上：视觉、样式钩子与读屏都能确认切换已生效
        "data-mode": value,
        "aria-pressed": mode === value ? "true" : "false",
        onclick: () => setMode(value),
      });
    host.appendChild(make("ask", "Ask", "只回答问题，不向终端写入任何内容"));
    // 两种模式都由面板自由切换，不再受设置里的开关限制
    host.appendChild(make("agent", "Agent", "读取终端输出并在会话中执行命令，每条都需你确认"));
  }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    // 消息流是两种模式共用的，切模式只换底部输入语义，不清空、也不打断在跑的 Agent：
    // 待确认的命令仍留在流里，切回来（或就在 Ask 下）继续点「执行 / 跳过」即可
    renderPanel();
    // 控件被重建过，焦点会掉回 body；手动落回刚选中的那个按钮，
    // 让「点一下没反应」的错觉消失，键盘用户也能继续操作
    const host = $("ai-mode-switch");
    const active = host ? host.querySelector('button[data-mode="' + next + '"]') : null;
    if (active) active.focus();
  }

  /** 重绘面板：会话行、底部控件、中部内容区。 */
  function renderPanel() {
    if (!isOpen()) return;
    renderSessionRow();
    renderModeSwitch();
    renderModelSelect();
    renderCompose();
    renderScroll();
  }

  /** 会话行：当前主机 + 连接状态点 + 当前模式。 */
  function renderSessionRow() {
    const dot = $("ai-session-dot");
    const hint = $("ai-hint");
    const host = hostOf();
    if (dot) dot.classList.toggle("on", !!host);
    // 模式写进这一行：切换按钮很小，这里能持续确认当前处在哪个模式
    if (hint) hint.textContent = (host || "未连接会话") + " · " + (mode === "agent" ? "Agent" : "Ask");
  }

  /** 模型下拉填进底部控件行。 */
  function renderModelSelect() {
    const host = $("ai-model-host");
    if (!host) return;
    host.textContent = "";
    if (!((aiConfig && aiConfig.models) || []).length) {
      host.appendChild(el("span", { class: "ai-model-label", text: "未配置模型" }));
      return;
    }
    host.appendChild(buildModelSelect());
  }

  /** 底部输入区：占位符随模式变化。 */
  function renderCompose() {
    const node = inputNode();
    if (node) {
      node.placeholder =
        mode === "agent"
          ? "描述你要 Agent 执行的任务…"
          : "问点什么，或描述你想要的操作…";
    }
    syncComposeState();
  }

  /**
   * 底部那一个圆角主按钮：空闲时是「发送 / 开始」，忙碌时变成「停止」。
   * 合并成一个按钮是为了让状态一眼可见，也避免 Ask / Agent 各挂一排按钮。
   * 忙碌与否看**当前会话**的状态：切到别的标签不该看到上一个会话的「停止」。
   */
  function syncComposeState() {
    const send = $("ai-send");
    if (!send) return;
    const view = currentView();
    const hasSession = !!sessionIdOf();
    const working = mode === "agent" ? !!(view.agent && view.agent.running) : !!view.askId;

    if (working) {
      send.textContent = "■";
      send.title = "停止";
      send.classList.add("busy");
      send.disabled = false;
      return;
    }

    send.textContent = mode === "agent" ? "▶" : "↑";
    send.title = hasSession ? (mode === "agent" ? "开始执行" : "发送") : "请先连接一个主机";
    send.classList.remove("busy");
    send.disabled = !hasSession;
  }

  /** 大图标空状态。 */
  function emptyState(icon, title, desc) {
    return el("div", { class: "ai-empty" }, [
      el("div", { class: "ai-empty-icon", text: icon }),
      el("div", { class: "ai-empty-title", text: title }),
      el("div", { class: "ai-empty-desc", text: desc }),
    ]);
  }

  /** 空状态与消息流互斥：该会话只要有过对话，就收起介绍性空状态。 */
  function syncEmpty() {
    if (!body || !body.emptyHost) return;
    body.emptyHost.hidden = !!(body.view && body.view.messages.length);
  }

  /** 重建中部可滚动内容区：当前 SSH 会话的消息流。 */
  function renderScroll() {
    const host = $("ai-body");
    if (!host) return;
    host.textContent = "";
    body = { scrollHost: host };
    renderedKey = null;

    if (!enabled) {
      host.appendChild(
        emptyState("✦", "AI 助手已关闭", "请在「设置 → 功能开关」中打开「AI 助手」。")
      );
      return;
    }
    // 模型是硬依赖：没有模型就没有地址与 Key，提问必然失败，直接给出可操作的指引
    if (!((aiConfig && aiConfig.models) || []).length) {
      host.appendChild(
        emptyState(
          "⚙",
          "尚未添加模型",
          "请先在「设置 → AI 助手 → 自定义模型」中添加模型并填写 API Key。"
        )
      );
      return;
    }
    // 对话绑定当前 SSH 会话：没有活动会话时不做任何提问，只提示先连接
    if (!sessionIdOf()) {
      host.appendChild(
        emptyState("⌁", "未连接会话", "连接一个主机后即可开始对话；对话只属于该会话。")
      );
      return;
    }

    body.key = currentKey();
    body.view = sessionState(body.key);
    renderedKey = body.key;

    body.emptyHost = el("div");
    host.appendChild(body.emptyHost);
    body.emptyHost.appendChild(
      mode === "agent"
        ? emptyState(
            "⚡",
            "Agent 模式",
            flags.ai_danger_warning
              ? "我可以自动分析终端输出、诊断问题并建议命令。每条命令都需你确认后才会写入终端，危险命令会额外二次确认。"
              : "我可以自动分析终端输出、诊断问题并建议命令。每条命令都需你确认后才会写入终端。"
          )
        : emptyState(
            "✦",
            "Ask 模式",
            "我可以回答问题、解释报错、把自然语言转成命令。提问与回答都会留在上面的消息流里；回答不会写入终端，要自动执行请切到 Agent 模式。"
          )
    );

    body.streamHost = el("div", { class: "ai-stream" });
    host.appendChild(body.streamHost);

    renderStream();
  }

  // -------------------------------------------------------------------------
  // 消息流渲染
  //
  // 每条消息都是对象（见 pushUserMessage / pushAssistantMessage），DOM 由它渲染出来。
  // 流式回答只改对应节点里的文本，不整条重绘，避免逐字刷新时闪烁。
  // -------------------------------------------------------------------------

  /** 内容区是否贴近底部。贴底才自动跟随，用户向上翻阅时不被强行拉回。 */
  function isNearBottom() {
    const host = body && body.scrollHost;
    if (!host) return true;
    return host.scrollHeight - host.scrollTop - host.clientHeight < 48;
  }

  function scrollToBottom() {
    const host = body && body.scrollHost;
    if (host) host.scrollTop = host.scrollHeight;
  }

  /** 消息流当前渲染的是不是这个会话；不是就别动 DOM（数据仍在内存里）。 */
  function isRendered(key) {
    return !!body && body.key === key && isOpen();
  }

  /** 结构变化（新消息 / 命令状态变化）后刷新：渲染中就重绘，否则只对齐底部按钮。 */
  function refresh(key) {
    if (isRendered(key)) renderStream();
    else if (key === currentKey()) syncComposeState();
  }

  /** 重绘当前会话的整条消息流。 */
  function renderStream() {
    if (!body || !body.streamHost || !body.view) return;
    const host = body.streamHost;
    const stick = isNearBottom();
    host.textContent = "";

    (body.view.messages || []).forEach((msg) => {
      host.appendChild(messageNode(msg, body.key));
    });

    syncEmpty();
    syncComposeState();
    if (stick) scrollToBottom();
  }

  /** 助手消息的正文：可能是命令气泡，也可能是文本回答 / 结论。 */
  function assistantBody(msg, key) {
    const wrap = el("div", { class: "ai-msg-body" });

    if (msg.note) {
      wrap.appendChild(el("p", { class: "inline-note " + (msg.noteKind || ""), text: msg.note }));
    }

    if (msg.command) {
      wrap.appendChild(el("pre", { class: "log-preview", text: msg.command }));
      if (msg.danger) {
        wrap.appendChild(
          el("p", {
            class: "inline-note warn",
            text: "⚠ 命中危险规则：" + msg.danger + "，确认时会再次询问。",
          })
        );
      }
      if (msg.state === "pending") {
        // 待确认命令的两个动作。这是写终端的唯一入口。
        wrap.appendChild(
          el("div", { class: "log-actions" }, [
            el("button", {
              class: "btn primary",
              type: "button",
              text: "执行",
              onclick: () => agentApprove(key),
            }),
            el("button", {
              class: "btn ghost",
              type: "button",
              text: "跳过这条",
              onclick: () => agentSkip(key),
            }),
          ])
        );
      } else if (msg.state === "done") {
        // 输出是等终端安静后才读回来的，读取期间 note 顶着「已执行，等待输出…」，
        // 此时先不折叠块，避免短暂闪出一条「（无输出）」
        if (msg.output) {
          wrap.appendChild(
            el("details", { class: "ai-agent-step" }, [
              el("summary", { text: "查看终端输出" }),
              el("pre", { class: "log-preview", text: msg.output }),
            ])
          );
        }
      }
      return wrap;
    }

    const placeholder = msg.kind === "agent" ? "（思考中…）" : "（返回中…）";
    const text = msg.text || (msg.running ? placeholder : "");
    if (text) {
      // 流式阶段只改这个节点的文本，所以要把引用留在消息对象上
      msg.textNode = el("pre", { class: "log-preview", text });
      wrap.appendChild(msg.textNode);
    }
    return wrap;
  }

  /** 渲染一条消息。用户消息居右，助手消息居左。 */
  function messageNode(msg, key) {
    const isUser = msg.role === "user";
    return el(
      "div",
      {
        class: "ai-msg " + (isUser ? "user" : "assistant") + (msg.kind === "agent" ? " agent" : ""),
      },
      [
        el("div", { class: "ai-msg-role", text: isUser ? "我" : modeLabel(msg) }),
        isUser
          ? el("div", { class: "ai-msg-body" }, [el("p", { class: "ai-msg-text", text: msg.text })])
          : assistantBody(msg, key),
      ]
    );
  }

  /** 助手消息的角色标签：Agent 相关标注来源，便于回看时区分两类交互。 */
  function modeLabel(msg) {
    return msg.kind === "agent" ? "AI · Agent" : "AI";
  }

  // -------------------------------------------------------------------------
  // 行为
  // -------------------------------------------------------------------------

  let messageSeq = 0;

  function newMessageId() {
    messageSeq += 1;
    return "m" + messageSeq;
  }

  /** 追加一条用户消息：用户发出去的内容必须原样进消息流，而不是只留在输入框里。 */
  function pushUserMessage(view, text, kind) {
    const msg = { id: newMessageId(), role: "user", text: text, kind: kind };
    view.messages.push(msg);
    return msg;
  }

  /**
   * 追加一条助手消息。
   *
   * Ask 的文本回答与 Agent 的命令复用同一结构：先占位（running），拿到内容后再往里
   * 填。这样界面上「思考中 → 结果」始终是同一个气泡，不会跳出一条新的。
   */
  function pushAssistantMessage(view, patch) {
    const msg = Object.assign(
      {
        id: newMessageId(),
        role: "assistant",
        kind: "ask",
        text: "",
        note: "",
        noteKind: "",
        command: "",
        danger: "",
        output: "",
        state: "",
        running: false,
        textNode: null,
      },
      patch || {}
    );
    view.messages.push(msg);
    return msg;
  }

  /**
   * Ask：把输入框内容作为一条用户消息发出去，再开一条助手消息承接流式回答。
   *
   * 输入框在派发前就清空——消息已经进消息流了，留在输入框里会让人以为没发出去。
   */
  async function submit() {
    const key = currentKey();
    const view = sessionState(key);
    if (view.askId) {
      toast("上一条还在回答中，请等它结束或点击停止", "info");
      return;
    }
    if (!sessionIdOf()) {
      toast("请先连接一个主机", "error");
      return;
    }

    const input = inputValue().trim();
    if (!input) {
      toast("请输入你想问的内容", "warn");
      return;
    }

    const payload = {
      input: input,
      model: selectedModel(),
      host: hostOf() || null,
      cwd: null,
      session_id: sessionIdOf(),
    };

    clearInput();
    pushUserMessage(view, input, "ask");
    // 只靠正文里的「（返回中…）」表达等待，不再叠一条同样的状态行
    const msg = pushAssistantMessage(view, { kind: "ask", running: true });
    // 请求 id 要等 ai_ask 返回才知道，先用占位值把「正在回答」标出来：
    // 否则这段空档里按钮还是「发送」，可能被再点一次
    view.askId = PENDING_ASK;
    refresh(key);

    try {
      const result = await PShell.ipc.aiAsk(payload);
      const id = (result && result.id) || null;
      if (!id) throw new Error("后端未返回请求 id");
      view.askId = id;
      // 登记后回放期间可能已经到达的事件（分片 / 完成 / 出错）
      registerAsk(id, key, msg);
      refresh(key);
    } catch (err) {
      view.askId = null;
      msg.running = false;
      msg.noteKind = "error";
      msg.note = errorText(err);
      refresh(key);
      toast(errorText(err), "error");
    }
  }

  async function cancel() {
    const view = currentView();
    // 占位值说明请求还在路上，此时无处可取消，等 id 回来后按钮会再变成可停止
    if (!view.askId || view.askId === PENDING_ASK) return;
    try {
      await PShell.ipc.aiCancel(view.askId);
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  // -------------------------------------------------------------------------
  // Agent 模式：循环在前端，后端只做决策
  //
  // 每一步的流程是「请求决策 → 展示命令 → 用户确认 → 写入终端 → 等终端安静 →
  // 读回输出 → 进入下一步」。把循环放在前端是为了让每一步都能被用户拦住：
  // 后端始终不知道如何写终端，也就没有绕开确认的可能。
  //
  // 循环状态挂在会话上（view.agent），终端读写都用启动时捕获的会话 id，
  // 因此中途切换标签不会把命令写进别的会话。
  // -------------------------------------------------------------------------

  /** 在途 Ask 请求：requestId -> { key, msg }，事件据此定位要更新的消息。 */
  const inflightAsk = new Map();

  /** 已派发但请求 id 还没拿回来时的占位值，让「正在回答」立即可见。 */
  const PENDING_ASK = "__pending__";

  /**
   * 早到的 Ask 事件暂存区：requestId -> [{ type, payload }]。
   *
   * `ai_ask` 是「同步返回 id + 后台执行」，事件可能早于 invoke 的 Promise 结算，
   * 此时还不知道要写哪条消息。按 id 先攒着，登记后一次性回放；否则会丢开头分片，
   * 甚至因为漏掉 `done` 让按钮永远停在「停止」。
   */
  const earlyEvents = new Map();

  /** 把一条 Ask 事件交给对应的消息。未登记时先暂存。 */
  function dispatchAsk(type, payload) {
    if (!payload || !payload.id) return;
    const hit = inflightAsk.get(payload.id);
    if (!hit) {
      const list = earlyEvents.get(payload.id) || [];
      list.push({ type: type, payload: payload });
      earlyEvents.set(payload.id, list);
      return;
    }
    applyAskEvent(type, payload, hit);
  }

  /** 回放暂存事件并登记新请求，保证「先到的事件」不丢。 */
  function registerAsk(id, key, msg) {
    inflightAsk.set(id, { key: key, msg: msg });
    const buffered = earlyEvents.get(id);
    if (!buffered) return;
    earlyEvents.delete(id);
    buffered.forEach((item) => applyAskEvent(item.type, item.payload, { key: key, msg: msg }));
  }

  /** 按事件类型更新消息。chunk 只改文本节点，其余类型改状态后整条重绘。 */
  function applyAskEvent(type, payload, hit) {
    // 会话已关闭或对话已被清空：视图与消息都不在了，只回收在途登记
    const view = sessionViews.get(hit.key);
    if (!view) {
      inflightAsk.delete(payload.id);
      return;
    }

    if (type === "chunk") {
      hit.msg.text += payload.text || "";
      if (!isRendered(hit.key)) return;
      if (hit.msg.textNode) {
        // 只改文本节点，避免逐字刷新时整条消息重绘导致闪烁
        const stick = isNearBottom();
        hit.msg.textNode.textContent = hit.msg.text;
        if (stick) scrollToBottom();
      } else {
        renderStream();
      }
      return;
    }

    inflightAsk.delete(payload.id);
    if (view.askId === payload.id) view.askId = null;
    hit.msg.running = false;

    if (type === "done") {
      hit.msg.note = "";
      // 非流式时后端一次性给全文，这里兜住（流式下 payload.text 也是全量）
      hit.msg.text = payload.text || hit.msg.text;
    } else if (type === "error") {
      hit.msg.noteKind = "error";
      hit.msg.note = payload.error || "请求出错";
      toast(payload.error || "AI 请求出错", "error");
    } else {
      // cancelled：已收到的部分答案保留，只补一句说明
      hit.msg.noteKind = "";
      hit.msg.note = "已取消。";
    }
    refresh(hit.key);
  }

  /** 判断终端输出是否安静的轮询间隔：命令输出通常是一段突发，之后趋于平静。 */
  const AGENT_QUIET_MS = 1200;
  /** 输出一直不安静时的最长等待，避免卡死在长跑命令上 */
  const AGENT_MAX_WAIT_MS = 20000;

  /** 读取指定会话的最近输出，失败时退化为空串（不影响循环继续）。 */
  async function readTerminal(sessionId) {
    if (!sessionId) return "";
    try {
      return (await PShell.ssh.recentOutput(sessionId, 8192)) || "";
    } catch (_) {
      return "";
    }
  }

  /** 循环是否还应继续：面板关掉就停，避免在后台一直请求模型。 */
  function agentLive(view) {
    return !!(view && view.agent && view.agent.running) && isOpen();
  }

  /**
   * 等终端输出安静下来。
   *
   * 靠轮询最近输出的长度变化判断：连续两轮长度不变即认为命令已执行完。
   * 比在 xterm 上挂钩子可靠——命令输出可能很长，轮询只需看总量。
   */
  function waitForQuiet(view) {
    const sessionId = view.agent ? view.agent.sessionId : null;
    return new Promise((resolve) => {
      let last = -1;
      let stable = 0;
      const started = Date.now();
      const tick = async () => {
        if (!agentLive(view)) return resolve();
        const text = await readTerminal(sessionId);
        if (text.length === last) stable += 1;
        else {
          stable = 0;
          last = text.length;
        }
        if (stable >= 2 || Date.now() - started > AGENT_MAX_WAIT_MS) return resolve();
        setTimeout(tick, AGENT_QUIET_MS);
      };
      setTimeout(tick, AGENT_QUIET_MS);
    });
  }

  /**
   * 已执行 / 已跳过的命令，转成后端要的步骤列表。
   *
   * 直接从消息流推导，不另存一份：否则消息与步骤两处状态容易走偏。
   */
  function agentStepsOf(view) {
    return view.messages
      .filter((m) => m.kind === "agent" && m.command)
      .map((m) => ({ command: m.command, output: m.output }));
  }

  /** 停掉某个会话的 Agent 循环（切模式 / 主动停止 / 关闭面板 / 关闭模块）。 */
  function agentStop(view) {
    if (view && view.agent) {
      view.agent.running = false;
      view.agent.pending = null;
    }
  }

  /** 停掉所有会话在跑的循环。关闭面板或模块时必须调，否则会继续请求模型并写终端。 */
  function agentStopAll() {
    sessionViews.forEach((view) => agentStop(view));
  }

  /** 用户点「停止」：结束循环，并把仍在等待确认的命令标记为未执行。 */
  function agentAbort(key) {
    const view = sessionState(key);
    const ag = view.agent;
    if (!ag) return;
    const pending = ag.pending;
    agentStop(view);
    if (pending) {
      pending.state = "stopped";
      pending.noteKind = "warn";
      pending.note = "已停止，未执行。";
    } else {
      pushAssistantMessage(view, { kind: "agent", note: "已停止。", noteKind: "warn" });
    }
    refresh(key);
  }

  /** 执行一步：请求模型决策，拿到命令后停下来等用户确认。 */
  async function agentStep(key) {
    const view = sessionState(key);
    const ag = view.agent;
    if (!agentLive(view) || ag.busy) return;
    ag.busy = true;

    const msg = pushAssistantMessage(view, {
      kind: "agent",
      running: true,
      note: "正在思考下一步…",
    });
    refresh(key);

    let result;
    try {
      result = await PShell.ipc.aiAgentStep({
        goal: ag.goal,
        steps: agentStepsOf(view),
        terminal_tail: await readTerminal(ag.sessionId),
        model: selectedModel(),
      });
    } catch (err) {
      ag.busy = false;
      ag.running = false;
      msg.running = false;
      msg.noteKind = "error";
      msg.note = "出错：" + errorText(err);
      refresh(key);
      toast(errorText(err), "error");
      return;
    }
    ag.busy = false;

    // 请求期间用户可能已停止、关闭面板或关掉模块
    if (!agentLive(view)) {
      msg.running = false;
      if (ag.running) {
        ag.running = false;
        msg.noteKind = "warn";
        msg.note = "面板关闭，循环已停止。";
      }
      refresh(key);
      return;
    }

    if (result.action === "done") {
      ag.running = false;
      ag.finished = true;
      msg.running = false;
      msg.note = "结论";
      msg.text = result.summary || "任务结束";
      refresh(key);
      return;
    }

    // 复用这条消息，把它从「思考中」变成待确认的命令气泡
    msg.running = false;
    msg.command = result.command || "";
    msg.danger = result.danger || "";
    msg.state = "pending";
    msg.note = "下一步将执行：";
    ag.pending = msg;
    refresh(key);
  }

  /** 用户确认后把待执行命令写入终端。这是唯一真正写入终端的地方。 */
  async function agentApprove(key) {
    const view = sessionState(key);
    const ag = view.agent;
    if (!ag || !ag.pending) return;
    const msg = ag.pending;

    // 命中危险规则时必须再确认一次，这次确认无法被跳过
    if (msg.danger) {
      const ok = await confirmDialog({
        command: msg.command,
        reason: "Agent 要执行的命令命中危险规则：" + msg.danger,
      });
      // 取消二次确认时保留这条待确认命令，用户还能改选「跳过这条」
      if (!ok) return;
    }

    ag.pending = null;
    msg.state = "done";
    msg.note = "已执行，等待输出…";
    refresh(key);

    try {
      // 直接写入会话（含回车），不经过 terminal.js 的按键通道：
      // 危险检测与确认已在上面完成，这里只是投递最终结果
      await PShell.ssh.write(ag.sessionId, msg.command + "\n");
    } catch (err) {
      ag.running = false;
      msg.noteKind = "error";
      msg.note = "写入终端失败：" + errorText(err);
      refresh(key);
      toast(errorText(err), "error");
      return;
    }

    // 写入成功即记入命令历史：即使随后清空对话或关闭会话，命令仍能在「命令历史」里查到。
    // 命令历史模块关闭时后端拒绝该命令，这里静默忽略即可。
    PShell.ipc.pushHistory(msg.command, ag.host || "", ag.sessionId).catch(() => {});

    await waitForQuiet(view);

    // 输出读回来之前用户可能已经关掉面板：标记停止，但输出仍尽量读一次
    msg.output = await readTerminal(ag.sessionId);
    msg.note = "";

    if (!agentLive(view)) {
      ag.running = false;
      msg.noteKind = "warn";
      msg.note = "面板已关闭，已停止推进。";
      refresh(key);
      return;
    }

    refresh(key);
    if (agentStepsOf(view).length >= MAX_AGENT_STEPS) {
      ag.running = false;
      pushAssistantMessage(view, {
        kind: "agent",
        note: "已达到 " + MAX_AGENT_STEPS + " 步上限，自动停止。",
        noteKind: "warn",
      });
      refresh(key);
      return;
    }
    agentStep(key);
  }

  function agentSkip(key) {
    const view = sessionState(key);
    const ag = view.agent;
    if (!ag || !ag.pending) return;
    const msg = ag.pending;
    ag.pending = null;
    // 明确告诉模型「这条不执行」，让它换一条，而不是无声重试同一命令
    msg.state = "skipped";
    msg.output = "（用户拒绝执行该命令）";
    msg.note = "已跳过该命令。";
    refresh(key);
    if (!agentLive(view)) return;
    agentStep(key);
  }

  /** 开始一轮 Agent：目标作为用户消息进消息流，随后由模型逐步给出命令。 */
  function agentRun() {
    const key = currentKey();
    const view = sessionState(key);
    const goal = inputValue().trim();
    if (!goal) {
      toast("请先填写目标", "warn");
      return;
    }
    if (!sessionIdOf()) {
      toast("请先连接一个主机", "error");
      return;
    }
    if (view.agent && view.agent.running) {
      toast("当前会话已有 Agent 在运行，请先点击停止", "info");
      return;
    }

    clearInput();
    pushUserMessage(view, goal, "agent");
    view.agent = {
      goal: goal,
      // 会话在开始时捕获：循环期间切换标签也不会把命令写进别的会话
      sessionId: sessionIdOf(),
      host: hostOf() || null,
      running: true,
      finished: false,
      busy: false,
      pending: null,
    };
    refresh(key);
    agentStep(key);
  }

  /**
   * 清空当前会话的对话内容（面板右上角按钮）。
   *
   * 先停掉在跑的 Ask / Agent，再清空消息流；命令历史不受影响——AI 执行过的命令
   * 已经写进「命令历史」了（见 agentApprove）。
   */
  async function clearCurrent() {
    const key = currentKey();
    const view = sessionViews.get(key);
    if (!view || !view.messages.length) {
      stopSessionWork(view);
      toast("当前没有可清空的对话", "info");
      return;
    }

    const confirmed = await ask("清空当前会话的 AI 对话内容？此操作不可撤销。");
    if (!confirmed) return;

    stopSessionWork(view);
    view.messages = [];
    toast("已清空当前对话", "ok");
    refresh(key);
  }

  /** 停掉某个会话在跑的 Ask 请求与 Agent 循环；会话已关闭时 view 可能为空。 */
  function stopSessionWork(view) {
    if (!view) return;
    if (view.askId && view.askId !== PENDING_ASK) {
      PShell.ipc.aiCancel(view.askId).catch(() => {});
    }
    view.askId = null;
    agentStop(view);
    view.agent = null;
  }

  /**
   * 会话关闭时丢弃它的对话：由 terminal.js 在关闭终端后调用。
   * 对话与 SSH 会话绑定，会话没了对话也就没了。
   */
  function forget(id) {
    const view = sessionViews.get(id);
    if (view) stopSessionWork(view);
    sessionViews.delete(id);
  }

  function open() {
    if (!enabled) {
      toast("AI 助手已关闭，请在「设置 → 功能开关」中启用", "info");
      return;
    }
    const p = panelNode();
    if (!p || isOpen()) return;
    p.hidden = false;
    applyWidth(savedWidth() || 420);
    renderPanel();
    renderBadge();
    // 面板占了宽度，终端列数要重算，否则右侧会被裁掉
    refitTerminals();
    focusInput();
  }

  /** 标签栏入口的语义是开合，而不是只会打开。 */
  function togglePanel() {
    if (isOpen()) close();
    else open();
  }

  /** 由 app.js 在配置变化时调用（启动、保存设置、重置）。 */
  function setConfig(cfg) {
    enabled = !!(cfg && cfg.features && cfg.features.ai && cfg.features.ai.ai_assistant);
    flags = syncFlags(cfg);
    aiConfig = (cfg && cfg.ai) || {};
    // AI 关掉时，所有会话里正在跑的循环都要立刻停：否则它还会继续请求模型并写入
    // 终端，而用户以为自己已经关掉了。消息流保留，重开时还能看到之前到哪一步。
    if (!enabled) agentStopAll();
    // AI 整体关掉时面板没有存在意义，直接收起
    if (!enabled) {
      const p = panelNode();
      if (p && !p.hidden) {
        p.hidden = true;
        refitTerminals();
      }
    }
    renderBadge();
    if (isOpen()) renderPanel();
    else body = null;
  }

  // -------------------------------------------------------------------------
  // 事件订阅：流式分片 / 完成 / 取消 / 错误
  // -------------------------------------------------------------------------

  function subscribe() {
    PShell.ipc
      .listen("ai:chunk", (payload) => {
        // Ask 才走流式；Agent 的决策是一次性返回，不产生分片事件
        dispatchAsk("chunk", payload);
      })
      .catch(() => {});

    PShell.ipc
      .listen("ai:done", (payload) => {
        dispatchAsk("done", payload);
      })
      .catch(() => {});

    PShell.ipc
      .listen("ai:error", (payload) => {
        dispatchAsk("error", payload);
      })
      .catch(() => {});

    PShell.ipc
      .listen("ai:cancelled", (payload) => {
        dispatchAsk("cancelled", payload);
      })
      .catch(() => {});
  }

  // -------------------------------------------------------------------------
  // 绑定
  // -------------------------------------------------------------------------

  const badgeNode = $("ai-status");
  if (badgeNode) badgeNode.addEventListener("click", togglePanel);

  const closeBtn = $("ai-close");
  if (closeBtn) closeBtn.addEventListener("click", close);

  const clearBtn = $("ai-clear-btn");
  if (clearBtn) clearBtn.addEventListener("click", clearCurrent);

  /** 底部圆角主按钮的唯一动作：空闲时发送 / 开始，忙碌时停止。 */
  function onPrimaryAction() {
    const key = currentKey();
    const view = sessionState(key);
    if (mode === "agent" && view.agent && view.agent.running) {
      agentAbort(key);
      return;
    }
    if (mode === "ask" && view.askId) {
      cancel();
      return;
    }
    if (mode === "agent") agentRun();
    else submit();
  }

  const sendBtn = $("ai-send");
  if (sendBtn) sendBtn.addEventListener("click", onPrimaryAction);

  const input = inputNode();
  if (input) {
    input.addEventListener("input", autoGrow);
    // Ctrl / Cmd + Enter 等同于点主按钮
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      onPrimaryAction();
    });
  }

  bindResizer();
  applyWidth(savedWidth() || 420);
  subscribe();

  PShell.ai = { setConfig, open, close, toggle: togglePanel, forget, renderBadge };
})(window.PShell);