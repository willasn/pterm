import { t } from "../i18n/store";
import { ipc } from "../ipc/api";
import * as terminalApi from "../terminal/api";
import { ask, b64ToBytes, errorText, promptPassword, toast } from "../util/util";

/**
 * SSH 会话编排（由原 src/legacy/ssh.ts 迁移而来）。
 *
 * 把 Tauri 事件流接到终端实例上，并管理会话生命周期。前端不触碰 SSH 底层，
 * 只调用 command 与订阅 event；终端实例（xterm 封装）已迁至
 * src/features/terminal，经直接导入的终端 API 取用。
 */

/** id -> 取消订阅函数数组 */
const subscriptions = new Map<string, (() => void)[]>();

function eventsFor(id: string): { data: string; status: string; closed: string; prompt: string } {
  return {
    data: `ssh:data:${id}`,
    status: `ssh:status:${id}`,
    closed: `ssh:closed:${id}`,
    prompt: `ssh:auth-prompt:${id}`,
  };
}

/**
 * 正在等待用户应答键盘交互认证的会话。事件推送与订阅后的对齐可能指向同一条提示，
 * 用它去重，避免同一个弹窗被弹两次。
 */
const promptingIds = new Set<string>();

/**
 * 输入弹窗的全局串行队列：同一时刻只弹一个认证输入框。
 * 多个会话同时要求输入时排队依次弹，避免共用一个弹窗时互相顶掉。
 */
let promptChain: Promise<unknown> = Promise.resolve();
function enqueuePrompt<T>(task: () => Promise<T>): Promise<T> {
  const run = promptChain.then(task, task);
  promptChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * 弹窗询问一条键盘交互认证提示（密码 / 动态验证码等），把答案回填给后端。
 * 用户取消时回填 null，后端以「已取消键盘交互认证」结束，而不是报成凭据错误。
 */
async function showAuthPrompt(id: string, prompt: any): Promise<void> {
  if (promptingIds.has(id) || !terminalApi.get(id)) return;
  promptingIds.add(id);
  try {
    const text = await enqueuePrompt(() =>
      promptPassword(prompt.text || "请输入认证信息", {
        title: "键盘交互认证",
        label: prompt.echo ? "输入" : "密码 / 验证码",
        okText: "提交",
        cancelText: "取消",
      })
    );
    await ipc.sshAuthRespond(id, text == null ? null : text).catch(() => {});
  } finally {
    promptingIds.delete(id);
  }
}

async function subscribe(id: string): Promise<void> {
  if (subscriptions.has(id)) return;
  const names = eventsFor(id);

  const unlisten = await Promise.all([
    ipc.listen(names.data, (payload: any) => {
      const target = terminalApi.get(id);
      if (!target || !payload || !payload.data) return;
      target.writeBytes(b64ToBytes(payload.data));
    }),
    ipc.listen(names.status, (state: any) => {
      const target = terminalApi.get(id);
      if (!target || !state) return;
      target.info.state = state;
      target.setState(state);
    }),
    ipc.listen(names.closed, (payload: any) => {
      const target = terminalApi.get(id);
      if (target) {
        // 已是错误态时保留它：后端在认证被拒后会紧接着发 closed，
        // 用「会话已结束」盖掉具体错误会丢失原因，也让密码补录无从判断。
        const current = target.info && target.info.state;
        if (!current || current.state !== "error") {
          target.setState({
            state: "closed",
            reason: (payload && payload.reason) || "会话已结束",
          });
        }
      }
      unsubscribe(id);
    }),
    // 键盘交互认证提示：会话线程阻塞等待，这里弹窗收集答案再回填
    ipc.listen(names.prompt, (prompt: any) => {
      if (prompt) showAuthPrompt(id, prompt);
    }),
  ]);
  subscriptions.set(id, unlisten);

  // 对齐抢跑：会话线程可能在订阅前就发出了提示，事件会丢，这里主动取一次
  ipc
    .sshAuthPending(id)
    .then((prompt: any) => {
      if (prompt) showAuthPrompt(id, prompt);
    })
    .catch(() => {});
}

function unsubscribe(id: string): void {
  const list = subscriptions.get(id);
  if (!list) return;
  subscriptions.delete(id);
  list.forEach((fn) => {
    try {
      fn();
    } catch (_) {}
  });
}

/**
 * 订阅后做一次状态对齐。连接可能在 `subscribe` 完成前就已就绪，
 * 漏掉那次事件会让前端一直停在「连接中」（输入门控依赖该状态）。
 */
async function resyncState(ctrl: any): Promise<void> {
  try {
    const list = await ipc.sshSessions();
    const fresh = (list || []).filter((item: any) => item.id === ctrl.id)[0];
    if (fresh && fresh.state) ctrl.setState(fresh.state);
  } catch (_) {
    // 对齐失败不影响主流程：后续状态事件仍会更新
  }
}

export interface SshOutcome {
  ok: boolean;
  authFailed: boolean;
  message: string;
  /** 主机密钥未通过时后端附带的指纹上下文（见 known_hosts）。 */
  hostKey?: any;
}

/**
 * 等待会话进入首个终态：`ok` 表示已就绪，否则为连接失败。
 *
 * 失败时 `authFailed` 表明后端判定为认证被拒（而非超时 / 握手失败），
 * 调用方可据此弹框补录密码。会话结束后后端仍保留一段结束快照，
 * 因此订阅前就失败的会话也能对齐；标签仍在，补录密码后可用
 * `reconnect(id)` 在同一标签内重试。
 */
export function awaitOutcome(id: string): Promise<SshOutcome> {
  const ctrl = terminalApi.get(id);
  // 标签已被关掉时不再等待，直接按失败处理
  if (!ctrl) return Promise.resolve({ ok: false, authFailed: false, message: "" });
  const read = (): SshOutcome | null => {
    const state = (ctrl && ctrl.info && ctrl.info.state) || null;
    const kind = state && state.state;
    if (kind === "ready") return { ok: true, authFailed: false, message: "" };
    if (kind === "error") {
      return {
        ok: false,
        authFailed: !!state.auth_failed,
        message: state.message || "",
        hostKey: state.host_key || undefined,
      };
    }
    if (kind === "closed" || kind === "disconnected") {
      return { ok: false, authFailed: false, message: state.reason || "" };
    }
    // 进入重连循环也算「本轮有了结论」：不是认证失败，也不该继续阻塞等待
    // （否则调用方会在自动重连的整段时间里一直挂着）。
    if (kind === "reconnecting") {
      return { ok: false, authFailed: false, message: state.reason || "" };
    }
    return null;
  };

  const settled = read();
  if (settled) return Promise.resolve(settled);

  const names = eventsFor(id);
  return new Promise((resolve) => {
    let offs: (() => void)[] | null = null;
    let done = false;
    const finish = (result: SshOutcome) => {
      if (done) return;
      done = true;
      resolve(result);
      if (offs) offs.forEach(stop);
    };
    const check = () => {
      const result = read();
      if (result) finish(result);
    };
    Promise.all([ipc.listen(names.status, check), ipc.listen(names.closed, check)]).then((unlistens) => {
      offs = unlistens;
      if (done) {
        offs.forEach(stop);
        return;
      }
      // 注册前可能已经进入终态（订阅前发出的事件会整批丢失），
      // 向后端对齐一次，避免一直在「连接中」上等下去。
      resyncState(ctrl).then(check);
    });
  });
}

function stop(fn: () => void): void {
  try {
    fn();
  } catch (_) {}
}

/** 建立连接并打开终端。 */
export async function connect(rawParams: any, options?: any): Promise<any> {
  const params = Object.assign({}, rawParams);
  if (!terminalApi.isSupported()) {
    throw new Error("终端组件未加载（vendor/xterm.js 缺失）");
  }
  if (!terminalApi.hasTabs()) {
    // 多标签关闭时同一时刻只允许一个会话
    await closeAll();
  }

  const info = await ipc.sshConnect(params);
  const ctrl = terminalApi.open(info, Object.assign({ params }, options));
  await subscribe(info.id);
  await resyncState(ctrl);

  // 主机密钥校验：后端拒绝（首次 / 变更）时弹窗确认，确认后在原标签内用放行策略重连。
  // 开关关闭时后端不会返回 hostKey，这里自然跳过。
  const outcome = await awaitOutcome(info.id);
  if (!outcome.ok && outcome.hostKey) {
    const accepted = await confirmHostKey(outcome.hostKey);
    if (accepted) {
      const kind = outcome.hostKey.status && outcome.hostKey.status.status;
      ctrl.params.host_key_policy = kind === "mismatch" ? "accept_any" : "accept_new";
      return reconnect(info.id);
    }
    await close(info.id);
    return null;
  }
  return ctrl;
}

/** 打开一个本地终端（本机 PTY shell），复用与 SSH 相同的终端装配与订阅流程。 */
export async function openLocal(): Promise<any> {
  try {
    if (!terminalApi.isSupported()) {
      throw new Error("终端组件未加载（vendor/xterm.js 缺失）");
    }
    if (!terminalApi.hasTabs()) {
      await closeAll();
    }
    const current = terminalApi.active();
    const cols = current ? current.term.cols : 80;
    const rows = current ? current.term.rows : 24;
    const info = await ipc.localTerminalOpen(cols, rows, null);
    const name = t("modal.localTerminal", "本地终端");
    if (info) info.name = name;
    const ctrl = terminalApi.open(info, { params: { kind: "local", name, cols, rows } });
    await subscribe(info.id);
    await resyncState(ctrl);
    return ctrl;
  } catch (err) {
    toast(errorText(err), "error");
    return null;
  }
}

/**
 * 主机密钥确认弹窗：首次连接只提示指纹，密钥变更时用危险样式强调风险。
 * 返回 true 表示用户确认信任。
 */
async function confirmHostKey(info: any): Promise<boolean> {
  const target = `${info.host}:${info.port}`;
  const status = info.status || {};
  const mismatch = status.status === "mismatch";
  const message = mismatch
    ? `警告：${target} 的主机密钥已变更。已记录 ${status.known_fingerprint}（${status.known_key_type}），本次收到 ${info.fingerprint}（${info.key_type}）。这可能是服务器重装，也可能是中间人攻击，仅在确认无误时继续。`
    : `首次连接 ${target}，主机密钥指纹（${info.key_type}）为 ${info.fingerprint}。无法自动验证该主机身份，确认信任并继续？`;
  return ask(message, {
    title: mismatch ? "主机密钥已变更" : "确认主机密钥",
    okText: mismatch ? "信任并继续" : "信任并连接",
    kind: mismatch ? "danger" : "warn",
  });
}

/** 断开后按原参数重建同名会话（标签 id 不变）。 */
export async function reconnect(id: string): Promise<any> {
  const ctrl = terminalApi.get(id);
  if (!ctrl) {
    toast("会话不存在，无法重连", "error");
    return null;
  }
  try {
    // 本地终端没有连接参数，按同一 id 重开一个本机 shell
    if (ctrl.info && ctrl.info.kind === "local") {
      const info = await ipc.localTerminalOpen(ctrl.term.cols, ctrl.term.rows, id);
      info.name = t("modal.localTerminal", "本地终端");
      ctrl.info = info;
      ctrl.setState(info.state || { state: "connecting" });
      await subscribe(id);
      await resyncState(ctrl);
      return ctrl;
    }
    if (!ctrl.params) {
      toast("缺少原始连接参数，无法重连", "error");
      return null;
    }
    const params = Object.assign({}, ctrl.params, { session_id: id });
    const info = await ipc.sshConnect(params);
    ctrl.info = info;
    ctrl.setState(info.state || { state: "connecting" });
    await subscribe(id);
    await resyncState(ctrl);
    return ctrl;
  } catch (err) {
    toast(errorText(err), "error");
    return null;
  }
}

export function disconnect(id: string): Promise<void> {
  return ipc.sshDisconnect(id).catch((err: unknown) => {
    toast(errorText(err), "error");
  });
}

/** 断开并关闭标签。 */
export async function close(id: string): Promise<void> {
  const ctrl = terminalApi.get(id);
  if (!ctrl) return;
  unsubscribe(id);
  try {
    await ipc.sshDisconnect(id);
  } catch (_) {
    // 会话可能已经结束，忽略
  }
  terminalApi.close(id);
}

export async function closeAll(): Promise<void> {
  const ids = terminalApi.list().map((c) => c.id);
  await Promise.all(ids.map((id: string) => close(id)));
}

export function write(id: string, data: string): Promise<void> {
  return ipc.sshWrite(id, data);
}

export function resize(id: string, cols: number, rows: number): Promise<void> {
  return ipc.sshResize(id, cols, rows);
}

export function recentOutput(id: string, maxBytes: number): Promise<string> {
  return ipc.sshRecentOutput(id, maxBytes);
}

export async function test(params: any): Promise<any> {
  return ipc.sshTestConnection(params);
}
