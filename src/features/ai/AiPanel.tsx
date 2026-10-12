import { useEffect, useRef, useState } from "react";
import { Markdown } from "./markdown";
import {
  approveCurrent,
  clearCurrent,
  close,
  persistWidth,
  primaryAction,
  runSuggested,
  setMenuOpen,
  setMode,
  setSelectedModel,
  setWidth,
  skipCurrent,
  useAiVersion,
  view,
  type AiView,
} from "./store";
import type { AiMessage } from "./types";

/** 上下文占比环形图标：紧邻 Agent，鼠标移上弹出明细。 */
function ContextMeter({ data }: { data: AiView["meter"] }) {
  if (!data) return null;
  const radius = 5.5;
  return (
    <span className={"ai-context-meter " + data.level} aria-label={data.ariaLabel}>
      <svg className="ai-meter-ring" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
        <circle className="ai-meter-track" cx="7" cy="7" r={radius} fill="none" strokeWidth="2" />
        <circle
          className="ai-meter-value"
          cx="7"
          cy="7"
          r={radius}
          fill="none"
          strokeWidth="2"
          strokeDasharray={`${data.dash} ${data.circumference}`}
          transform="rotate(-90 7 7)"
        />
      </svg>
      <span className="ai-meter-tip" role="tooltip">
        <span className="ai-meter-tip-title">上下文使用率</span>
        <span className="ai-meter-tip-main">
          {data.tipPct}% of {data.tipLimit}
        </span>
      </span>
    </span>
  );
}

/**
 * 模型下拉：列出设置中定义的自定义模型，value 用条目 id 以便后端定位地址与 Key。
 * 用自定义浮层替代原生 select —— 原生 option 面板无法跟随主题。
 */
function ModelSelect({ state }: { state: AiView }) {
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const open = state.menuOpen;

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // 打开后把焦点移到当前选中项，键盘可直接上下选择
  useEffect(() => {
    if (!open) return;
    const idx = Math.max(0, state.models.findIndex((m) => m.id === state.selectedModelId));
    optionRefs.current[idx]?.focus();
  }, [open]);

  if (!state.models.length) {
    return <span className="ai-model-label">未配置模型</span>;
  }

  const current = state.models.filter((m) => m.id === state.selectedModelId)[0] || state.models[0];

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      if (!open) return;
      setMenuOpen(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!open) {
      setMenuOpen(true);
      return;
    }
    const opts = optionRefs.current.filter(Boolean) as HTMLButtonElement[];
    const idx = opts.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (idx + 1) % opts.length : (idx - 1 + opts.length) % opts.length;
    opts[next].focus();
  };

  return (
    <div className={"ai-model-select" + (open ? " open" : "")} ref={wrapRef} onKeyDown={onKeyDown}>
      <button
        className="ai-model-trigger"
        type="button"
        title="选择模型"
        aria-haspopup="listbox"
        aria-expanded={open ? "true" : "false"}
        onClick={() => setMenuOpen(!open)}
      >
        <span className="ai-model-trigger-name">{current ? current.name || current.model || "未命名模型" : ""}</span>
        <span className="ai-model-chevron">
          <svg viewBox="0 0 14 14" width="10" height="10" aria-hidden="true">
            <path
              d="M3.5 5.25 7 8.75l3.5-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      <div className="ai-model-menu" role="listbox" aria-label="选择模型" hidden={!open}>
        {state.models.map((m, index) => {
          const name = m.name || m.model || "未命名模型";
          const sub = m.name && m.model ? m.model : "";
          const on = m.id === state.selectedModelId;
          return (
            <button
              key={m.id}
              className={"ai-model-option" + (on ? " selected" : "")}
              type="button"
              role="option"
              aria-selected={on ? "true" : "false"}
              data-value={m.id}
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              onClick={() => {
                setSelectedModel(m.id);
                setMenuOpen(false);
              }}
            >
              <span className="ai-model-option-text">
                <span className="ai-model-option-name">{name}</span>
                {sub ? <span className="ai-model-option-sub">{sub}</span> : null}
              </span>
              <span className="ai-model-option-check">
                <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
                  <path
                    d="M3 7.5 6 10.5 11 4.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 助手消息的正文：可能是命令气泡，也可能是文本回答 / 结论。 */
function AssistantBody({ msg }: { msg: AiMessage }) {
  // note 是独立的状态说明行，命令气泡与文本消息都可能带，故两种分支都先渲染它
  const note = msg.note ? <p className={"inline-note " + (msg.noteKind || "")}>{msg.note}</p> : null;

  // 命令气泡：Agent 待确认 / 已执行的命令
  if (msg.command) {
    return (
      <div className="ai-msg-body">
        {note}
        <pre className="log-preview">{msg.command}</pre>
        {msg.danger ? (
          <p className="inline-note warn">{"⚠ 命中危险规则：" + msg.danger + "，确认时会再次询问。"}</p>
        ) : msg.authReason ? (
          <p className="inline-note warn">{"此命令会" + msg.authReason + "，需要你授权后执行。"}</p>
        ) : null}
        {msg.state === "pending" ? (
          <div className="log-actions">
            <button className="btn primary" type="button" onClick={approveCurrent}>
              执行
            </button>
            <button className="btn ghost" type="button" onClick={skipCurrent}>
              跳过这条
            </button>
          </div>
        ) : msg.state === "done" && msg.output ? (
          <details className="ai-agent-step">
            <summary>查看终端输出</summary>
            <pre className="log-preview">{msg.output}</pre>
          </details>
        ) : null}
      </div>
    );
  }

  // 文本消息：Ask 回答、Agent 结论，或仅有一句状态说明（如「正在思考下一步…」）
  const placeholder = msg.kind === "agent" ? "（思考中…）" : "（返回中…）";
  const text = msg.text || (msg.running && !msg.note ? placeholder : "");
  return (
    <div className="ai-msg-body">
      {note}
      {text ? (
        msg.running ? (
          // 流式阶段保持纯文本：半截的 Markdown 会渲染成乱码块
          <pre className="log-preview">{text}</pre>
        ) : (
          // 回答结束，一次性渲染成结构化 DOM；命令块附带「运行」按钮（手动发送到终端）
          <Markdown text={text} onRun={(command) => void runSuggested(command)} />
        )
      ) : null}
    </div>
  );
}

/** 渲染一条消息。用户消息居右，助手消息居左。 */
function MessageView({ msg }: { msg: AiMessage }) {
  const isUser = msg.role === "user";
  return (
    <div className={"ai-msg " + (isUser ? "user" : "assistant") + (msg.kind === "agent" ? " agent" : "")}>
      <div className="ai-msg-role">{isUser ? "我" : msg.kind === "agent" ? "AI · Agent" : "AI"}</div>
      {isUser ? (
        <div className="ai-msg-body">
          <p className="ai-msg-text">{msg.text}</p>
        </div>
      ) : (
        <AssistantBody msg={msg} />
      )}
    </div>
  );
}

/** AI 助手停靠面板（features.ai.ai_assistant 打开时可用）。 */
export function AiPanel() {
  const version = useAiVersion();
  void version;
  const state = view();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composing = useRef(false);
  const [dragging, setDragging] = useState(false);

  const grow = () => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = node.scrollHeight + "px";
  };

  // 打开面板时聚焦输入框并复位高度
  useEffect(() => {
    if (!state.panelOpen) return;
    grow();
    inputRef.current?.focus();
  }, [state.panelOpen]);

  // 贴底时才自动跟随：用户向上翻阅时不被强行拉回
  useEffect(() => {
    const host = scrollRef.current;
    if (!host || !state.panelOpen) return;
    const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 48;
    if (nearBottom) host.scrollTop = host.scrollHeight;
  }, [version, state.panelOpen]);

  if (!state.panelOpen) return null;

  const dispatch = () => {
    const text = inputRef.current ? inputRef.current.value : "";
    const sent = primaryAction(text);
    if (sent) {
      if (inputRef.current) inputRef.current.value = "";
      grow();
    }
  };

  return (
    <>
      <div
        className={"ai-panel-resizer" + (dragging ? " dragging" : "")}
        id="ai-resizer"
        title="拖动调整宽度"
        onPointerDown={(event) => {
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (!dragging) return;
          const main = document.querySelector(".main");
          if (!main) return;
          // 面板贴主区右缘：宽度 = 主区右边界 - 指针 x
          setWidth(main.getBoundingClientRect().right - event.clientX);
        }}
        onPointerUp={(event) => {
          if (!dragging) return;
          setDragging(false);
          try {
            event.currentTarget.releasePointerCapture(event.pointerId);
          } catch {
            /* 指针已释放，忽略 */
          }
          persistWidth();
        }}
        onPointerCancel={() => {
          if (!dragging) return;
          setDragging(false);
          persistWidth();
        }}
      />
      <header className="ai-panel-head">
        <span className={"ai-session-dot" + (state.session.connected ? " on" : "")} id="ai-session-dot" />
        <span className="ai-panel-title" id="ai-hint">
          {state.session.label}
        </span>
        <span className="spacer" />
        <button className="icon-btn" id="ai-clear-btn" title="清空当前对话" onClick={() => void clearCurrent()}>
          🧹
        </button>
        <button className="icon-btn" id="ai-close" title="关闭" onClick={close}>
          ✕
        </button>
      </header>
      <div className="ai-panel-scroll" id="ai-body" ref={scrollRef}>
        {state.empty ? (
          <div className="ai-empty">
            <div className="ai-empty-icon">{state.empty.icon}</div>
            <div className="ai-empty-title">{state.empty.title}</div>
            <div className="ai-empty-desc">{state.empty.desc}</div>
          </div>
        ) : null}
        <div className="ai-stream">
          {state.messages.map((msg) => (
            <MessageView key={msg.id} msg={msg} />
          ))}
        </div>
      </div>
      <div className="ai-panel-compose">
        <div className="ai-composer">
          <textarea
            id="ai-input"
            rows={2}
            spellCheck={false}
            placeholder={state.compose.placeholder}
            ref={inputRef}
            onInput={grow}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              // 输入法组词中（中文候选面板打开）时，Enter 用于上屏，不触发发送
              if (event.key !== "Enter" || event.shiftKey) return;
              if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              dispatch();
            }}
          />
          <div className="ai-composer-bar">
            <div className="ai-mode-switch" id="ai-mode-switch" role="group" aria-label="AI 交互模式">
              <button
                className={"btn " + (state.mode === "ask" ? "primary" : "ghost")}
                type="button"
                data-mode="ask"
                aria-pressed={state.mode === "ask" ? "true" : "false"}
                title="给出建议与命令，命令可手动点击「运行」发送到终端，不会自动执行"
                onClick={() => setMode("ask")}
              >
                Ask
              </button>
              <button
                className={"btn " + (state.mode === "agent" ? "primary" : "ghost")}
                type="button"
                data-mode="agent"
                aria-pressed={state.mode === "agent" ? "true" : "false"}
                title="读取终端输出并自动执行命令，涉及删除、修改等关键操作时会请你授权"
                onClick={() => setMode("agent")}
              >
                Agent
              </button>
            </div>
            <ContextMeter data={state.meter} />
            <span className="ai-model-host" id="ai-model-host">
              <ModelSelect state={state} />
            </span>
            <button
              className={"ai-send" + (state.compose.sendBusy ? " busy" : "")}
              id="ai-send"
              type="button"
              title={state.compose.sendTitle}
              disabled={state.compose.sendDisabled}
              onClick={dispatch}
            >
              {state.compose.sendText}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
