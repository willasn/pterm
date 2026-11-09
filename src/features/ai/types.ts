/** AI 面板涉及的结构类型。 */

export interface AiModel {
  id: string;
  name?: string;
  model?: string;
  max_input_tokens?: number | null;
  [key: string]: unknown;
}

export type MessageRole = "user" | "assistant";
export type MessageKind = "ask" | "agent";
export type MessageState = "" | "pending" | "done" | "skipped" | "stopped";

/** 用户随提问上传的附件：图片或文本文件。 */
export interface AiAttachment {
  id: string;
  kind: "image" | "text";
  name: string;
  mime: string;
  /** 原始文件字节数，仅用于展示。 */
  size: number;
  /** 图片预览 data URL；发送时取其 base64 部分。 */
  preview?: string;
  /** 文本附件正文。 */
  text?: string;
}

/** 消息流里的一条消息（用户提问 / 助手回答 / Agent 命令与结论）。 */
export interface AiMessage {
  id: string;
  role: MessageRole;
  kind: MessageKind;
  text: string;
  note: string;
  noteKind: string;
  /** Agent 待执行 / 已执行的命令；文本回答为空。 */
  command: string;
  /** 命令命中的危险规则说明。 */
  danger: string;
  /** 需要用户授权的原因（删除 / 修改 / 关键操作等）；可自动执行时为空。 */
  authReason: string;
  /** 命令执行后读回的终端输出。 */
  output: string;
  state: MessageState;
  /** 是否仍在流式返回（决定用 <pre> 还是 Markdown 渲染）。 */
  running: boolean;
  /** 因步数上限停下的提示气泡：显示「继续执行」按钮 */
  canContinue: boolean;
  /** 用户提问时随消息上传的附件；助手消息为空。 */
  attachments?: AiAttachment[];
}

/** Agent 循环状态；每个会话独立。 */
export interface AgentState {
  goal: string;
  /** 循环开始时捕获的会话 id：中途切换标签也不会写进别的会话。 */
  sessionId: string;
  host: string | null;
  running: boolean;
  finished: boolean;
  busy: boolean;
  pending: AiMessage | null;
  /** 本轮已产生的命令数：步数上限按「本轮」算，新一轮或点继续时归零。 */
  steps: number;
  /** 上一条命令，用于识别模型原地打转。 */
  lastCommand: string;
  /** 同一条命令连续出现的次数（含本次）。 */
  repeat: number;
  /** 连续失败的命令数。 */
  failStreak: number;
  /** 本轮开始时随目标上传的附件；只在第一步发给模型。 */
  attachments: AiAttachment[];
}

/** 每个终端会话一份面板状态（key = 终端会话 id）。 */
export interface SessionView {
  key: string;
  messages: AiMessage[];
  /** 在途 Ask 请求 id；非空表示正在等回答。 */
  askId: string | null;
  agent: AgentState | null;
}

/** 上下文占比图标的展示数据。 */
export interface MeterData {
  level: "ok" | "warn" | "high";
  pct: number;
  /** 环形进度：dasharray 的实线长度与周长。 */
  dash: string;
  circumference: string;
  ariaLabel: string;
  tipPct: number;
  tipLimit: string;
}

/** 底部发送按钮的展示状态。 */
export interface ComposeState {
  placeholder: string;
  sendText: string;
  sendTitle: string;
  sendDisabled: boolean;
  sendBusy: boolean;
}

/** 空状态卡片。 */
export interface EmptyState {
  icon: string;
  title: string;
  desc: string;
}
