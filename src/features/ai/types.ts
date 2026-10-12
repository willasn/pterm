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
