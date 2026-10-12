import { useSyncExternalStore } from "react";
import { errorText, pt, toast } from "../../lib/legacy";
import { inspect } from "../danger/rules";
import { ipc } from "../ipc/api";
import { recentOutput, write } from "../ssh/api";
import { active, refitAll } from "../terminal/api";
import { ask, confirmDialog } from "../util/util";
import type {
  AgentState,
  AiMessage,
  AiModel,
  ComposeState,
  EmptyState,
  MeterData,
  MessageKind,
  SessionView,
} from "./types";

/**
 * AI 助手交互面板（由原 src/legacy/ai.ts 迁移而来）。
 *
 * 只在 features.ai.ai_assistant 打开时可用：关闭时入口隐藏、面板不加载，
 * 后端 command 也会以 ModuleDisabled 拒绝。
 *
 * 内容区是**一条按 SSH 会话隔离的消息流**：每个终端会话各有一份对话，切标签各自
 * 独立、切回仍能看到，会话关闭即清空，不落库。面板只负责「组织提问 → 派发命令 →
 * 订阅事件 → 展示」；提示词组装在 Rust 侧完成。Ask 模式给出建议与命令，命令由用户
 * 手动点击「运行」才写入终端；Agent 模式自动执行只读命令，涉及删除、修改等关键操作
 * 时停下等用户授权，危险命令额外二次确认，循环在前端跑。
 *
 * 迁移说明：消息仍是可变对象（流式期间原地追加文本），React 侧用版本号驱动重绘；
 * 消息按 id 作 key，React 会就地更新文本节点，不会整条重建。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** Agent 单轮循环上限，防止模型反复试探停不下来 */
const MAX_AGENT_STEPS = 10;
/** 模型未配置「最大输入 token」时的兜底上限（对应设置里的输入占位值 128000） */
const DEFAULT_MAX_INPUT_TOKENS = 128000;
/** 没有活动会话时（尚未连接 / 全部关闭）的兜底 key，仅用于显示空状态 */
const NO_SESSION_KEY = "__no_session__";
/** 面板宽度上下限。上限用比例，避免把终端挤没。 */
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_RATIO = 0.7;
const PANEL_WIDTH_KEY = "pterm.aiPanelWidth";
/** 判断终端输出是否安静的轮询间隔：命令输出通常是一段突发，之后趋于平静。 */
const AGENT_QUIET_MS = 1200;
/** 输出一直不安静时的最长等待，避免卡死在长跑命令上 */
const AGENT_MAX_WAIT_MS = 20000;
/** 已派发但请求 id 还没拿回来时的占位值，让「正在回答」立即可见。 */
const PENDING_ASK = "__pending__";

// ---------------------------------------------------------------------------
// 可变状态（非响应式）
// ---------------------------------------------------------------------------

let enabled = false;
let flags: any = {};
let aiConfig: any = {};

/** 面板里选中的模型条目 id；跨面板开关保留，避免每次都要重选 */
let selectedModelId = "";
/** 交互模式：ask 只给建议（命令由用户点击运行），agent 自动执行只读命令、关键操作待授权 */
let mode: "ask" | "agent" = "ask";

const sessionViews = new Map<string, SessionView>();
/** 在途 Ask 请求：requestId -> { key, msg }，事件据此定位要更新的消息。 */
const inflightAsk = new Map<string, { key: string; msg: AiMessage }>();
/** 早到的 Ask 事件暂存区：requestId -> [{ type, payload }]。 */
const earlyEvents = new Map<string, { type: string; payload: any }[]>();

let messageSeq = 0;
let panelOpen = false;
let panelWidth = 420;
let menuOpen = false;

// ---------------------------------------------------------------------------
// 响应式外壳（版本号驱动重绘）
// ---------------------------------------------------------------------------

let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAiVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

// ---------------------------------------------------------------------------
// 基础读取
// ---------------------------------------------------------------------------

function syncFlags(config: any): any {
  return (config && config.features && config.features.ai) || {};
}

export function getPanelOpen(): boolean {
  return panelOpen;
}

export function getWidth(): number {
  return panelWidth;
}

function sessionState(key: string): SessionView {
  let view = sessionViews.get(key);
  if (!view) {
    view = { key, messages: [], askId: null, agent: null };
    sessionViews.set(key, view);
  }
  return view;
}

function activeSession(): any {
  return active();
}

function sessionIdOf(): string | null {
  const ctrl = activeSession();
  return ctrl ? ctrl.id : null;
}

function hostOf(): string {
  const ctrl = activeSession();
  return ctrl && ctrl.info ? ctrl.info.host || "" : "";
}

function currentKey(): string {
  return sessionIdOf() || NO_SESSION_KEY;
}

function currentView(): SessionView {
  return sessionState(currentKey());
}

/** 面板开合会改变终端可用宽度，必须让 xterm 重新计算列数。 */
function refitTerminals(): void {
  refitAll();
}

// ---------------------------------------------------------------------------
// 模型选择
// ---------------------------------------------------------------------------

function models(): AiModel[] {
  return (aiConfig && aiConfig.models) || [];
}

/** 底部控件行里选中的模型条目 id；无模型时返回 null（后端会回退到默认模型）。 */
function selectedModel(): string | null {
  const list = models();
  if (!list.length) return null;
  if (selectedModelId && list.some((m) => m.id === selectedModelId)) return selectedModelId;
  // 未选择 / 选择已失效时与下拉展示保持一致：回退到列表第一条
  return list[0].id;
}

/** 当前选中的模型条目；未选中或找不到时退回列表第一条。 */
function selectedModelConfig(): AiModel | null {
  const list = models();
  const id = selectedModel();
  if (id) {
    const hit = list.filter((m) => m.id === id)[0];
    if (hit) return hit;
  }
  return list[0] || null;
}

export function setSelectedModel(id: string): void {
  selectedModelId = id;
  bump();
}

export function setMenuOpen(open: boolean): void {
  if (menuOpen === open) return;
  menuOpen = open;
  bump();
}

export function setMode(next: "ask" | "agent"): void {
  if (mode === next) return;
  mode = next;
  // 消息流是两种模式共用的，切模式只换底部输入语义，不清空、也不打断在跑的 Agent
  bump();
}

// ---------------------------------------------------------------------------
// 上下文占比（估算，仅提示，不参与请求）
// ---------------------------------------------------------------------------

/** 粗略估算一段文本的 token 数：CJK / 全角字符按 1 token，其余按 4 字符 1 token。 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of String(text)) {
    tokens += (ch.codePointAt(0) as number) >= 0x2e80 ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}

/** 汇总当前会话消息流里所有可见文本的估算 token。 */
function estimateContextTokens(view: SessionView): number {
  let total = 0;
  (view.messages || []).forEach((msg) => {
    total += estimateTokens(msg.text);
    total += estimateTokens(msg.note);
    total += estimateTokens(msg.command);
    total += estimateTokens(msg.output);
  });
  return total;
}

/** 紧凑数字：128000 -> 128K，1000000 -> 1000K，1200 -> 1.2K。 */
function compactNumber(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return (k >= 100 ? Math.round(k) : Math.round(k * 10) / 10) + "K";
  }
  return String(n);
}

function meterData(): MeterData | null {
  const model = selectedModelConfig();
  if (!sessionIdOf() || !model) return null;
  // 输入上限是单次请求的输入预算，也就是这一轮的上下文上限
  const limit = Math.max(1, Number(model.max_input_tokens) || DEFAULT_MAX_INPUT_TOKENS);
  const used = estimateContextTokens(currentView());
  const ratio = Math.min(1, used / limit);
  const pct = Math.round(ratio * 100);
  const level = pct >= 90 ? "high" : pct >= 70 ? "warn" : "ok";
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  return {
    level,
    pct,
    dash: (ratio * circumference).toFixed(2),
    circumference: circumference.toFixed(2),
    ariaLabel:
      "上下文使用率（估算）" + pct + "%：当前窗口约 " + compactNumber(used) + " tokens，输入上限 " + compactNumber(limit) + " tokens",
    tipPct: pct,
    tipLimit: compactNumber(limit),
  };
}

// ---------------------------------------------------------------------------
// 消息构造
// ---------------------------------------------------------------------------

function newMessageId(): string {
  messageSeq += 1;
  return "m" + messageSeq;
}

function pushUserMessage(view: SessionView, text: string, kind: MessageKind): AiMessage {
  const msg: AiMessage = {
    id: newMessageId(),
    role: "user",
    kind,
    text,
    note: "",
    noteKind: "",
    command: "",
    danger: "",
    authReason: "",
    output: "",
    state: "",
    running: false,
  };
  view.messages.push(msg);
  return msg;
}

/**
 * 追加一条助手消息。
 *
 * Ask 的文本回答与 Agent 的命令复用同一结构：先占位（running），拿到内容后再往里
 * 填。这样界面上「思考中 → 结果」始终是同一个气泡，不会跳出一条新的。
 */
function pushAssistantMessage(view: SessionView, patch: Partial<AiMessage>): AiMessage {
  const msg: AiMessage = Object.assign(
    {
      id: newMessageId(),
      role: "assistant",
      kind: "ask",
      text: "",
      note: "",
      noteKind: "",
      command: "",
      danger: "",
      authReason: "",
      output: "",
      state: "",
      running: false,
    },
    patch
  );
  view.messages.push(msg);
  return msg;
}

// ---------------------------------------------------------------------------
// 面板开关
// ---------------------------------------------------------------------------

function savedWidth(): number {
  try {
    const v = parseInt(localStorage.getItem(PANEL_WIDTH_KEY) || "", 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

/** 夹到 [最小值, 主区宽度的 70%]。 */
export function clampWidth(px: number): number {
  const main = document.querySelector(".main");
  const avail = main ? main.getBoundingClientRect().width : window.innerWidth;
  const max = Math.max(PANEL_MIN_WIDTH, Math.round(avail * PANEL_MAX_RATIO));
  return Math.max(PANEL_MIN_WIDTH, Math.min(Math.round(px), max));
}

export function setWidth(px: number): void {
  panelWidth = clampWidth(px);
  bump();
}

export function persistWidth(): void {
  try {
    localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(panelWidth)));
  } catch {
    /* 存储不可用时仅本次会话生效 */
  }
}

export function open(): void {
  if (!enabled) {
    toast("AI 助手已关闭，请在「设置 → 功能开关」中启用", "info");
    return;
  }
  if (panelOpen) return;
  panelOpen = true;
  panelWidth = clampWidth(savedWidth() || 420);
  bump();
  // 面板占了宽度，终端列数要重算，否则右侧会被裁掉
  refitTerminals();
}

export function close(): void {
  if (!panelOpen) return;
  // 面板收起来后 Agent 循环就没有了确认入口（命令确认按钮只在这里），
  // 明确停掉所有会话的循环，避免留下「运行中」却无人推进的状态
  agentStopAll();
  panelOpen = false;
  bump();
  refitTerminals();
}

/** 标签栏入口的语义是开合，而不是只会打开。 */
export function togglePanel(): void {
  if (panelOpen) close();
  else open();
}

/** 由 app 在配置变化时调用（启动、保存设置、重置）。 */
export function setEnabledFromConfig(config: any): void {
  enabled = !!(config && config.features && config.features.ai && config.features.ai.ai_assistant);
  flags = syncFlags(config);
  aiConfig = (config && config.ai) || {};
  // AI 关掉时，所有会话里正在跑的循环都要立刻停：否则它还会继续请求模型并写入
  // 终端，而用户以为自己已经关掉了。消息流保留，重开时还能看到之前到哪一步。
  if (!enabled) {
    agentStopAll();
    // AI 整体关掉时面板没有存在意义，直接收起
    if (panelOpen) {
      panelOpen = false;
      refitTerminals();
    }
  }
  bump();
}

/** tabs 在标签切换 / 增删时调用：会话变了就要换成那个会话自己的记录。 */
export function renderBadge(): void {
  bump();
}

// ---------------------------------------------------------------------------
// Ask 模式：派发与事件
// ---------------------------------------------------------------------------

/** 把一条 Ask 事件交给对应的消息。未登记时先暂存。 */
function dispatchAsk(type: string, payload: any): void {
  if (!payload || !payload.id) return;
  const hit = inflightAsk.get(payload.id);
  if (!hit) {
    const list = earlyEvents.get(payload.id) || [];
    list.push({ type, payload });
    earlyEvents.set(payload.id, list);
    return;
  }
  applyAskEvent(type, payload, hit);
}

/** 回放暂存事件并登记新请求，保证「先到的事件」不丢。 */
function registerAsk(id: string, key: string, msg: AiMessage): void {
  inflightAsk.set(id, { key, msg });
  const buffered = earlyEvents.get(id);
  if (!buffered) return;
  earlyEvents.delete(id);
  buffered.forEach((item) => applyAskEvent(item.type, item.payload, { key, msg }));
}

/** 按事件类型更新消息。 */
function applyAskEvent(type: string, payload: any, hit: { key: string; msg: AiMessage }): void {
  // 会话已关闭或对话已被清空：视图与消息都不在了，只回收在途登记
  const view = sessionViews.get(hit.key);
  if (!view) {
    inflightAsk.delete(payload.id);
    return;
  }

  if (type === "chunk") {
    hit.msg.text += payload.text || "";
    bump();
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
  bump();
}

/**
 * 订阅 AI 事件。
 *
 * 直接走 window.__TAURI__.event：本函数在组件挂载时订阅事件，
 * Tauri 会在页面脚本执行前注入该接口。
 */
export function subscribeAiEvents(): () => void {
  const events = (window as any).__TAURI__?.event;
  if (!events || typeof events.listen !== "function") return () => {};
  const unlisteners: (() => void)[] = [];
  const bind = (name: string, type: string) => {
    events
      .listen(name, (message: any) => dispatchAsk(type, message && message.payload))
      .then((fn: () => void) => unlisteners.push(fn))
      .catch(() => {});
  };
  // Ask 才走流式；Agent 的决策是一次性返回，不产生分片事件
  bind("ai:chunk", "chunk");
  bind("ai:done", "done");
  bind("ai:error", "error");
  bind("ai:cancelled", "cancelled");
  return () => unlisteners.forEach((fn) => fn());
}

/** Ask：把输入内容作为一条用户消息发出去，再开一条助手消息承接流式回答。返回是否已派发。 */
export async function submit(inputText: string): Promise<boolean> {
  const key = currentKey();
  const view = sessionState(key);
  if (view.askId) {
    toast("上一条还在回答中，请等它结束或点击停止", "info");
    return false;
  }
  if (!sessionIdOf()) {
    toast("请先连接一个主机", "error");
    return false;
  }
  const input = (inputText || "").trim();
  if (!input) {
    toast("请输入你想问的内容", "warn");
    return false;
  }

  const payload = {
    input,
    model: selectedModel(),
    host: hostOf() || null,
    cwd: null,
    session_id: sessionIdOf(),
  };

  pushUserMessage(view, input, "ask");
  const msg = pushAssistantMessage(view, { kind: "ask", running: true });
  // 请求 id 要等 ai_ask 返回才知道，先用占位值把「正在回答」标出来
  view.askId = PENDING_ASK;
  bump();

  try {
    const result = await ipc.aiAsk(payload);
    const id = (result && result.id) || null;
    if (!id) throw new Error("后端未返回请求 id");
    view.askId = id;
    // 登记后回放期间可能已经到达的事件（分片 / 完成 / 出错）
    registerAsk(id, key, msg);
    bump();
  } catch (err) {
    view.askId = null;
    msg.running = false;
    msg.noteKind = "error";
    msg.note = errorText(err);
    bump();
    toast(errorText(err), "error");
  }
  return true;
}

export async function cancel(): Promise<void> {
  const view = currentView();
  // 占位值说明请求还在路上，此时无处可取消，等 id 回来后按钮会再变成可停止
  if (!view.askId || view.askId === PENDING_ASK) return;
  try {
    await ipc.aiCancel(view.askId);
  } catch (err) {
    toast(errorText(err), "error");
  }
}

// ---------------------------------------------------------------------------
// Agent 模式：循环在前端，后端只做决策
// ---------------------------------------------------------------------------

/** 读取指定会话的最近输出，失败时退化为空串（不影响循环继续）。 */
async function readTerminal(sessionId: string | null): Promise<string> {
  if (!sessionId) return "";
  try {
    return (await recentOutput(sessionId, 8192)) || "";
  } catch {
    return "";
  }
}

/** 循环是否还应继续：面板关掉就停，避免在后台一直请求模型。 */
function agentLive(view: SessionView): boolean {
  return !!(view && view.agent && view.agent.running) && panelOpen;
}

/** 等终端输出安静下来：连续两轮长度不变即认为命令已执行完。 */
function waitForQuiet(view: SessionView): Promise<void> {
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
 * 直接从消息流推导，不另存一份：否则消息与步骤两处状态容易走偏。
 */
function agentStepsOf(view: SessionView): { command: string; output: string }[] {
  return view.messages
    .filter((m) => m.kind === "agent" && m.command)
    .map((m) => ({ command: m.command, output: m.output }));
}

function agentStop(view: SessionView | undefined | null): void {
  if (view && view.agent) {
    view.agent.running = false;
    view.agent.pending = null;
  }
}

/** 停掉所有会话在跑的循环。关闭面板或模块时必须调，否则会继续请求模型并写终端。 */
function agentStopAll(): void {
  sessionViews.forEach((view) => agentStop(view));
}

/** 用户点「停止」：结束循环，并把仍在等待确认的命令标记为未执行。 */
function agentAbort(key: string): void {
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
  bump();
}

/** 执行一步：请求模型决策，拿到命令后停下来等用户确认。 */
async function agentStep(key: string): Promise<void> {
  const view = sessionState(key);
  const ag = view.agent;
  if (!ag || !agentLive(view) || ag.busy) return;
  ag.busy = true;

  const msg = pushAssistantMessage(view, {
    kind: "agent",
    running: true,
    note: "正在思考下一步…",
  });
  bump();

  let result: any;
  try {
    result = await ipc.aiAgentStep({
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
    bump();
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
    bump();
    return;
  }

  if (result.action === "done") {
    ag.running = false;
    ag.finished = true;
    msg.running = false;
    msg.note = "结论";
    msg.text = result.summary || "任务结束";
    bump();
    return;
  }

  // 复用这条消息，把它从「思考中」变成命令气泡
  msg.running = false;
  msg.command = result.command || "";

  // 需要授权的命令（删除 / 修改 / 关键操作）才停下等用户确认；其余只读命令直接自动执行
  if (!result.requires_auth) {
    msg.danger = "";
    msg.authReason = "";
    msg.note = "自动执行（只读命令，无需授权）";
    bump();
    await agentExecute(key, msg, true);
    return;
  }

  msg.danger = result.danger || "";
  msg.authReason = result.auth_reason || "";
  msg.state = "pending";
  msg.note = msg.danger ? "下一步将执行（危险命令，需二次确认）：" : "下一步需要你授权后执行：";
  ag.pending = msg;
  bump();
}

/**
 * 执行一步命令：写入终端 → 等输出 → 读回 → 推进循环。
 *
 * 自动执行（只读命令）与用户授权后执行共用此函数；`auto` 仅影响提示文案。
 * 这是唯一真正写入终端的地方。
 */
async function agentExecute(key: string, msg: AiMessage, auto: boolean): Promise<void> {
  const view = sessionState(key);
  const ag = view.agent;
  if (!ag) return;

  msg.state = "done";
  msg.note = auto ? "自动执行中…" : "已执行，等待输出…";
  bump();

  try {
    // 直接写入会话（含回车），不经过 terminal 的按键通道：授权判定已在上面完成
    await write(ag.sessionId, msg.command + "\n");
  } catch (err) {
    ag.running = false;
    msg.noteKind = "error";
    msg.note = "写入终端失败：" + errorText(err);
    bump();
    toast(errorText(err), "error");
    return;
  }

  // 写入成功即记入命令历史：即使随后清空对话或关闭会话，命令仍能在「命令历史」里查到。
  ipc.pushHistory(msg.command, ag.host || "", ag.sessionId).catch(() => {});

  await waitForQuiet(view);

  // 输出读回来之前用户可能已经关掉面板：标记停止，但输出仍尽量读一次
  msg.output = await readTerminal(ag.sessionId);
  msg.note = "";

  if (!agentLive(view)) {
    ag.running = false;
    msg.noteKind = "warn";
    msg.note = "面板已关闭，已停止推进。";
    bump();
    return;
  }

  bump();
  if (agentStepsOf(view).length >= MAX_AGENT_STEPS) {
    ag.running = false;
    pushAssistantMessage(view, {
      kind: "agent",
      note: "已达到 " + MAX_AGENT_STEPS + " 步上限，自动停止。",
      noteKind: "warn",
    });
    bump();
    return;
  }
  void agentStep(key);
}

/** 用户授权后执行待确认命令。危险命令额外二次确认。 */
export async function agentApprove(key: string): Promise<void> {
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
  await agentExecute(key, msg, false);
}

export function agentSkip(key: string): void {
  const view = sessionState(key);
  const ag = view.agent;
  if (!ag || !ag.pending) return;
  const msg = ag.pending;
  ag.pending = null;
  // 明确告诉模型「这条不执行」，让它换一条，而不是无声重试同一命令
  msg.state = "skipped";
  msg.output = "（用户拒绝执行该命令）";
  msg.note = "已跳过该命令。";
  bump();
  if (!agentLive(view)) return;
  void agentStep(key);
}

/** 开始一轮 Agent：目标作为用户消息进消息流，随后由模型逐步给出命令。返回是否已启动。 */
export function agentRun(inputText: string): boolean {
  const key = currentKey();
  const view = sessionState(key);
  const goal = (inputText || "").trim();
  if (!goal) {
    toast("请先填写目标", "warn");
    return false;
  }
  if (!sessionIdOf()) {
    toast("请先连接一个主机", "error");
    return false;
  }
  if (view.agent && view.agent.running) {
    toast("当前会话已有 Agent 在运行，请先点击停止", "info");
    return false;
  }

  pushUserMessage(view, goal, "agent");
  const agent: AgentState = {
    goal,
    // 会话在开始时捕获：循环期间切换标签也不会把命令写进别的会话
    sessionId: sessionIdOf() as string,
    host: hostOf() || null,
    running: true,
    finished: false,
    busy: false,
    pending: null,
  };
  view.agent = agent;
  bump();
  void agentStep(key);
  return true;
}

/**
 * 清空当前会话的对话内容（面板右上角按钮）。
 *
 * 先停掉在跑的 Ask / Agent，再清空消息流；命令历史不受影响。
 */
export async function clearCurrent(): Promise<void> {
  const key = currentKey();
  const view = sessionViews.get(key);
  if (!view || !view.messages.length) {
    stopSessionWork(view);
    toast("当前没有可清空的对话", "info");
    return;
  }

  const confirmed = await ask("清空当前会话的 AI 对话内容？此操作不可撤销。", {
    title: "清空对话",
    okText: "清空",
    kind: "danger",
  });
  if (!confirmed) return;

  stopSessionWork(view);
  view.messages = [];
  toast("已清空当前对话", "ok");
  bump();
}

/** 停掉某个会话在跑的 Ask 请求与 Agent 循环；会话已关闭时 view 可能为空。 */
function stopSessionWork(view: SessionView | undefined): void {
  if (!view) return;
  if (view.askId && view.askId !== PENDING_ASK) {
    ipc.aiCancel(view.askId).catch(() => {});
  }
  view.askId = null;
  agentStop(view);
  view.agent = null;
}

/** 会话关闭时丢弃它的对话：由 terminal 在关闭终端后调用。 */
export function forget(id: string): void {
  const view = sessionViews.get(id);
  if (view) stopSessionWork(view);
  sessionViews.delete(id);
  bump();
}

/** 底部圆角主按钮的唯一动作：空闲时发送 / 开始，忙碌时停止。返回是否已派发（供清空输入框）。 */
export function primaryAction(inputText: string): boolean {
  const key = currentKey();
  const view = sessionState(key);
  if (mode === "agent" && view.agent && view.agent.running) {
    agentAbort(key);
    return false;
  }
  if (mode === "ask" && view.askId) {
    void cancel();
    return false;
  }
  if (mode === "agent") return agentRun(inputText);
  void submit(inputText);
  return true;
}

/** Agent 命令气泡上的「执行 / 跳过」。 */
export function approveCurrent(): void {
  void agentApprove(currentKey());
}

export function skipCurrent(): void {
  agentSkip(currentKey());
}

/**
 * Ask 模式回答里命令块上的「运行」：由用户手动点击，把建议命令写入当前会话终端。
 *
 * 点击本身就是授权，普通命令不再额外拦截；命中危险规则时仍要二次确认（全局约束）。
 */
export async function runSuggested(command: string): Promise<void> {
  const cmd = (command || "").trim();
  if (!cmd) return;
  const sessionId = sessionIdOf();
  if (!sessionId) {
    toast("请先连接一个主机", "error");
    return;
  }
  const danger = inspect(cmd);
  if (danger) {
    const ok = await confirmDialog({ command: cmd, reason: "该命令命中危险规则：" + danger });
    if (!ok) return;
  }
  try {
    await write(sessionId, cmd + "\n");
  } catch (err) {
    toast(errorText(err), "error");
    return;
  }
  ipc.pushHistory(cmd, hostOf() || "", sessionId).catch(() => {});
  toast("已发送到终端", "ok");
}

// ---------------------------------------------------------------------------
// 渲染数据（组件在渲染阶段调用；版本号变化时重新计算）
// ---------------------------------------------------------------------------

export interface AiView {
  panelOpen: boolean;
  enabled: boolean;
  mode: "ask" | "agent";
  models: AiModel[];
  selectedModelId: string | null;
  menuOpen: boolean;
  session: { host: string; connected: boolean; label: string };
  messages: AiMessage[];
  /** 是否有 Agent 循环在跑（决定发送按钮是否变成停止）。 */
  agentRunning: boolean;
  /** 当前待确认的命令是否属于本会话（决定是否显示执行 / 跳过）。 */
  compose: ComposeState;
  empty: EmptyState | null;
  meter: MeterData | null;
  /** 消息流里是否有需要展示的「待确认」命令按钮（交给消息组件自行判断）。 */
  key: string;
}

export function view(): AiView {
  const key = currentKey();
  const viewState = sessionState(key);
  const connected = !!sessionIdOf();
  const host = hostOf();
  const list = models();
  const working = mode === "agent" ? !!(viewState.agent && viewState.agent.running) : !!viewState.askId;

  const compose: ComposeState = working
    ? {
        placeholder: mode === "agent" ? "描述你要 Agent 执行的任务…" : "问点什么，或描述你想要的操作…",
        sendText: "■",
        sendTitle: "停止",
        sendDisabled: false,
        sendBusy: true,
      }
    : {
        placeholder: mode === "agent" ? "描述你要 Agent 执行的任务…" : "问点什么，或描述你想要的操作…",
        sendText: mode === "agent" ? "▶" : "↑",
        sendTitle: connected ? (mode === "agent" ? "开始执行" : "发送") : "请先连接一个主机",
        sendDisabled: !connected,
        sendBusy: false,
      };

  let empty: EmptyState | null = null;
  if (!enabled) {
    empty = { icon: "✦", title: "AI 助手已关闭", desc: "请在「设置 → 功能开关」中打开「AI 助手」。" };
  } else if (!list.length) {
    empty = {
      icon: "⚙",
      title: "尚未添加模型",
      desc: "请先在「设置 → AI 助手 → 自定义模型」中添加模型并填写 API Key。",
    };
  } else if (!connected) {
    empty = { icon: "⌁", title: "未连接会话", desc: "连接一个主机后即可开始对话；对话只属于该会话。" };
  } else if (!viewState.messages.length) {
    empty =
      mode === "agent"
        ? {
            icon: "⚡",
            title: "Agent 模式",
            desc: flags.ai_danger_warning
              ? "我会自动分析终端输出并逐步执行命令直到完成：只读命令直接执行，涉及删除、修改等关键操作时会先请你授权，危险命令还会额外二次确认。"
              : "我会自动分析终端输出并逐步执行命令直到完成：只读命令直接执行，涉及删除、修改等关键操作时会先请你授权。",
          }
        : {
            icon: "✦",
            title: "Ask 模式",
            desc: "我可以回答问题、解释报错，并把自然语言转成命令给出建议。回答不会自动执行——命令会以代码块列出，你可点击「运行」手动发送到终端；想全自动请切到 Agent 模式。",
          };
  }

  return {
    panelOpen,
    enabled,
    mode,
    models: list,
    selectedModelId: selectedModel(),
    menuOpen,
    session: { host, connected, label: (host || "未连接会话") + " · " + (mode === "agent" ? "Agent" : "Ask") },
    messages: viewState.messages,
    agentRunning: !!(viewState.agent && viewState.agent.running),
    compose,
    empty,
    meter: meterData(),
    key,
  };
}
