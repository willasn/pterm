/* SSH 会话编排：把 Tauri 事件流接到终端实例上，并管理会话生命周期。
 * 前端不触碰 SSH 底层，只调用 command 与订阅 event。 */
(function (PShell) {
  "use strict";

  const { toast, errorText } = PShell.util;

  /** id -> 取消订阅函数数组 */
  const subscriptions = new Map();

  function eventsFor(id) {
    return {
      data: `ssh:data:${id}`,
      status: `ssh:status:${id}`,
      closed: `ssh:closed:${id}`,
    };
  }

  async function subscribe(id) {
    if (subscriptions.has(id)) return;
    const names = eventsFor(id);

    const unlisten = await Promise.all([
      PShell.ipc.listen(names.data, (payload) => {
        const target = PShell.terminal.get(id);
        if (!target || !payload || !payload.data) return;
        target.writeBytes(PShell.util.b64ToBytes(payload.data));
      }),
      PShell.ipc.listen(names.status, (state) => {
        const target = PShell.terminal.get(id);
        if (!target || !state) return;
        target.info.state = state;
        target.setState(state);
      }),
      PShell.ipc.listen(names.closed, (payload) => {
        const target = PShell.terminal.get(id);
        if (target) {
          target.setState({
            state: "closed",
            reason: (payload && payload.reason) || "会话已结束",
          });
        }
        unsubscribe(id);
      }),
    ]);
    subscriptions.set(id, unlisten);
  }

  function unsubscribe(id) {
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
  async function resyncState(ctrl) {
    try {
      const list = await PShell.ipc.sshSessions();
      const fresh = (list || []).filter((item) => item.id === ctrl.id)[0];
      if (fresh && fresh.state) ctrl.setState(fresh.state);
    } catch (_) {
      // 对齐失败不影响主流程：后续状态事件仍会更新
    }
  }

  /** 建立连接并打开终端。 */
  async function connect(rawParams, options) {
    const params = Object.assign({}, rawParams);
    if (!PShell.terminal.isSupported()) {
      throw new Error("终端组件未加载（vendor/xterm.js 缺失）");
    }
    if (!PShell.terminal.hasTabs()) {
      // 多标签关闭时同一时刻只允许一个会话
      await closeAll();
    }

    const info = await PShell.ipc.sshConnect(params);
    const ctrl = PShell.terminal.open(info, Object.assign({ params }, options));
    await subscribe(info.id);
    await resyncState(ctrl);
    return ctrl;
  }

  /** 断开后按原参数重建同名会话（标签 id 不变）。 */
  async function reconnect(id) {
    const ctrl = PShell.terminal.get(id);
    if (!ctrl || !ctrl.params) {
      toast("缺少原始连接参数，无法重连", "error");
      return null;
    }
    try {
      const params = Object.assign({}, ctrl.params, { session_id: id });
      const info = await PShell.ipc.sshConnect(params);
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

  function disconnect(id) {
    return PShell.ipc.sshDisconnect(id).catch((err) => {
      toast(errorText(err), "error");
    });
  }

  /** 断开并关闭标签。 */
  async function close(id) {
    const ctrl = PShell.terminal.get(id);
    if (!ctrl) return;
    unsubscribe(id);
    try {
      await PShell.ipc.sshDisconnect(id);
    } catch (_) {
      // 会话可能已经结束，忽略
    }
    PShell.terminal.close(id);
  }

  async function closeAll() {
    const ids = PShell.terminal.list().map((c) => c.id);
    await Promise.all(ids.map((id) => close(id)));
  }

  function write(id, data) {
    return PShell.ipc.sshWrite(id, data);
  }

  function resize(id, cols, rows) {
    return PShell.ipc.sshResize(id, cols, rows);
  }

  function recentOutput(id, maxBytes) {
    return PShell.ipc.sshRecentOutput(id, maxBytes);
  }

  async function test(params) {
    return PShell.ipc.sshTestConnection(params);
  }

  PShell.ssh = {
    connect,
    reconnect,
    disconnect,
    close,
    closeAll,
    write,
    resize,
    recentOutput,
    test,
  };
})(window.PShell);