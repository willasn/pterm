import { ipc } from "../ipc/api";
import * as terminalApi from "../terminal/api";
import { b64ToBytes, errorText, toast } from "../util/util";

/**
 * SSH 会话编排（由原 src/legacy/ssh.ts 迁移而来）。
 *
 * 把 Tauri 事件流接到终端实例上，并管理会话生命周期。前端不触碰 SSH 底层，
 * 只调用 command 与订阅 event；终端实例（xterm 封装）已迁至
 * src/features/terminal，经直接导入的终端 API 取用。
 */

/** id -> 取消订阅函数数组 */
const subscriptions = new Map<string, (() => void)[]>();

function eventsFor(id: string): { data: string; status: string; closed: string } {
  return {
    data: `ssh:data:${id}`,
    status: `ssh:status:${id}`,
    closed: `ssh:closed:${id}`,
  };
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
  ]);
  subscriptions.set(id, unlisten);
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
      };
    }
    if (kind === "closed" || kind === "disconnected") {
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
  return ctrl;
}

/** 断开后按原参数重建同名会话（标签 id 不变）。 */
export async function reconnect(id: string): Promise<any> {
  const ctrl = terminalApi.get(id);
  if (!ctrl || !ctrl.params) {
    toast("缺少原始连接参数，无法重连", "error");
    return null;
  }
  try {
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
