import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { toast } from "../../lib/legacy";
import { Markdown } from "./markdown";
import {
  addAttachment,
  agentContinue,
  approveCurrent,
  clearCurrent,
  close,
  newAttachmentId,
  persistWidth,
  primaryAction,
  removeAttachment,
  runSuggested,
  setMenuOpen,
  setMode,
  setSelectedModel,
  setWidth,
  skipCurrent,
  toggleContextInject,
  useAiVersion,
  view,
  type AiView,
} from "./store";
import type { AiAttachment, AiMessage } from "./types";

/** 可上传的图片类型：与主流多模态接口支持的一致。 */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
/** 文本附件扩展名：不少系统给出的 MIME 为空或不准确，用扩展名兜底。 */
const TEXT_FILE_RE =
  /\.(txt|md|markdown|log|json|ya?ml|toml|ini|conf|csv|xml|rs|ts|tsx|js|jsx|py|sh|zsh|bash|go|java|sql|html?|css|scss)$/i;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;

/** 图片读成 data URL：既用于缩略图预览，发送时取逗号后的 base64 部分。 */
function readImage(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** 前端先做类型 / 体积校验并读入内存；不支持的二进制文件在这里直接拦掉。 */
async function readAttachment(file: File): Promise<AiAttachment | null> {
  const id = newAttachmentId();
  // 截图 / 部分来源拿到的文件名可能为空，给个可读的兜底名称
  const name = file.name || (file.type.startsWith("image/") ? "粘贴的图片" : "未命名附件");
  if (IMAGE_TYPES.includes(file.type)) {
    if (file.size > MAX_IMAGE_BYTES) {
      toast(file.name + " 超过 10MB，已跳过", "warn");
      return null;
    }
    const preview = await readImage(file);
    if (!preview) {
      toast("读取图片 " + file.name + " 失败", "error");
      return null;
    }
    return { id, kind: "image", name, mime: file.type, size: file.size, preview };
  }
  if (file.type.startsWith("text/") || TEXT_FILE_RE.test(file.name) || file.type === "application/json") {
    if (file.size > MAX_TEXT_BYTES) {
      toast(file.name + " 超过 512KB，已跳过", "warn");
      return null;
    }
    try {
      const text = await file.text();
      return { id, kind: "text", name, mime: file.type || "text/plain", size: file.size, text };
    } catch {
      toast("读取文件 " + file.name + " 失败", "error");
      return null;
    }
  }
  toast("暂不支持该文件类型：" + name + "（仅支持图片与文本文件）", "warn");
  return null;
}

/** Ask / Agent 合并成一个模式选择器：默认 Agent，点击向上弹出切换。 */
function ModeSelect({ mode }: { mode: "ask" | "agent" }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const options = [
    { value: "agent", name: "Agent", sub: "自动执行命令，关键操作先授权" },
    { value: "ask", name: "Ask", sub: "只给建议与命令，手动运行" },
  ] as const;

  return (
    <div className={"ai-mode-select ai-model-select" + (open ? " open" : "")} ref={wrapRef}>
      <button
        className="ai-model-trigger"
        type="button"
        title="选择交互模式"
        aria-haspopup="listbox"
        aria-expanded={open ? "true" : "false"}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        <span className="ai-model-trigger-name">{mode === "agent" ? "Agent" : "Ask"}</span>
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
      <div className="ai-model-menu ai-mode-menu" role="listbox" aria-label="选择交互模式" hidden={!open}>
        {options.map((opt) => {
          const on = mode === opt.value;
          return (
            <button
              key={opt.value}
              className={"ai-model-option" + (on ? " selected" : "")}
              type="button"
              role="option"
              aria-selected={on ? "true" : "false"}
              onClick={() => {
                setMode(opt.value);
                setOpen(false);
              }}
            >
              <span className="ai-model-option-text">
                <span className="ai-model-option-name">{opt.name}</span>
                <span className="ai-model-option-sub">{opt.sub}</span>
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

/** 上下文占比环形图标：紧邻模式选择器，鼠标移上弹出明细。 */
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
            <summary>查看执行输出</summary>
            <pre className="log-preview">{msg.output}</pre>
          </details>
        ) : null}
        {msg.canContinue ? (
          <div className="log-actions">
            <button className="btn primary" type="button" onClick={agentContinue}>
              继续执行
            </button>
          </div>
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
          // 回答结束，一次性渲染成结构化 DOM；命令块附带「运行」按钮（后台通道执行）
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
          {msg.attachments && msg.attachments.length ? (
            <div className="ai-msg-attachments">
              {msg.attachments.map((att) =>
                att.kind === "image" && att.preview ? (
                  <img key={att.id} className="ai-msg-attach-img" src={att.preview} alt={att.name} title={att.name} />
                ) : (
                  <span key={att.id} className="ai-msg-attach-file" title={att.name}>
                    📄 {att.name}
                  </span>
                )
              )}
            </div>
          ) : null}
          {msg.text ? <p className="ai-msg-text">{msg.text}</p> : null}
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
  const fileRef = useRef<HTMLInputElement | null>(null);
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

  /** 选择文件后逐个读取；清空 value 让同一个文件可以再次选择。 */
  const pickFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files;
    if (!picked || !picked.length) return;
    const files = Array.from(picked);
    event.target.value = "";
    for (const file of files) {
      const att = await readAttachment(file);
      if (att && !addAttachment(att)) break;
    }
  };

  /** 粘贴：剪贴板里是文件（截图、复制的文件）就转成附件；普通文本保持默认粘贴。 */
  const pasteFiles = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const data = event.clipboardData;
    if (!data) return;
    const files: File[] = [];
    if (data.files && data.files.length) {
      files.push(...Array.from(data.files));
    } else {
      const items = data.items;
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind !== "file") continue;
        const file = items[i].getAsFile();
        if (file) files.push(file);
      }
    }
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) {
      const att = await readAttachment(file);
      if (att && !addAttachment(att)) break;
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
        <button
          className={"icon-btn" + (state.contextInject ? " active" : "")}
          id="ai-context-inject-btn"
          type="button"
          aria-pressed={state.contextInject ? "true" : "false"}
          title={
            state.contextInject
              ? "上下文注入：已开启（点击关闭）——提问时会带上当前主机、目录与最近终端输出"
              : "上下文注入：已关闭（点击开启）——提问时只发送你的问题"
          }
          onClick={toggleContextInject}
        >
          📎
        </button>
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
          <input
            ref={fileRef}
            className="ai-file-input"
            type="file"
            multiple
            hidden
            accept={
              "image/png,image/jpeg,image/webp,image/gif," +
              ".txt,.md,.markdown,.log,.json,.yaml,.yml,.toml,.ini,.conf,.csv,.xml," +
              ".rs,.ts,.tsx,.js,.jsx,.py,.sh,.zsh,.bash,.go,.java,.sql,.html,.css,.scss"
            }
            onChange={(event) => void pickFiles(event)}
          />
          {state.attachments.length ? (
            <div className="ai-attachments">
              {state.attachments.map((att) => (
                <span className="ai-attachment" key={att.id}>
                  {att.kind === "image" && att.preview ? (
                    <img src={att.preview} alt={att.name} title={att.name} />
                  ) : (
                    <span className="ai-attachment-icon">📄</span>
                  )}
                  <span className="ai-attachment-name" title={att.name}>
                    {att.name}
                  </span>
                  <button
                    className="ai-attachment-remove"
                    type="button"
                    title="移除附件"
                    onClick={() => removeAttachment(att.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            id="ai-input"
            rows={2}
            spellCheck={false}
            placeholder={state.compose.placeholder}
            ref={inputRef}
            onInput={grow}
            onPaste={(event) => void pasteFiles(event)}
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
            <ModeSelect mode={state.mode} />
            <button
              className="ai-attach-btn"
              type="button"
              title="上传图片或附件（图片 ≤ 10MB，文本文件 ≤ 512KB）"
              aria-label="上传图片或附件"
              disabled={!state.session.connected}
              onClick={() => fileRef.current?.click()}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                  d="M8 3.5v9M3.5 8h9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
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
