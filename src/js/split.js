/* 分屏交互：标签栏右侧的方向按钮与「选择分屏目标」弹窗。
 * 布局本身由 tabs.js 的 pane-group 负责，本模块只发起方向设置与新建会话。 */
(function (PShell) {
  "use strict";

  const { el, $, toast, errorText } = PShell.util;

  /** id -> 按钮，首次 sync 时惰性创建 */
  let buttons = null;

  function hasSplit() {
    return PShell.tabs.hasSplit();
  }

  function splitHost() {
    return $("split-controls");
  }

  function ensureButtons() {
    const host = splitHost();
    if (!host || buttons) return;

    const make = (key, title, text, run) =>
      el("button", {
        class: "icon-btn split-act",
        dataset: { act: key },
        title,
        text,
        onclick: run,
      });

    buttons = {
      h: make("h", "左右分屏", "⇄", () => start("h")),
      v: make("v", "上下分屏", "⇅", () => start("v")),
      merge: make("merge", "取消分屏", "⊟", () => stop()),
    };
    host.appendChild(buttons.h);
    host.appendChild(buttons.v);
    host.appendChild(buttons.merge);
  }

  /** 由 tabs.js 在布局变化后调用，刷新按钮可用状态。 */
  function sync() {
    ensureButtons();
    const host = splitHost();
    if (!host || !buttons) return;

    // 没有多标签就没有并存的多个会话，分屏无从谈起
    const show = hasSplit() && PShell.tabs.hasTabs() && PShell.tabs.count() > 0;
    host.hidden = !show;
    if (!show) return;

    const group = PShell.tabs.activeGroup();
    const split = !!(group && group.memberIds.length > 1);
    // 方向按钮常驻：未分屏时用于发起分屏，已分屏时用于就地切换方向
    buttons.h.classList.toggle("active", split && group.dir === "h");
    buttons.v.classList.toggle("active", split && group.dir === "v");
    buttons.merge.hidden = !split;
  }

  /** 分屏开关由 tabs.js 持有；这里只在配置变更时重建按钮。 */
  function setConfig() {
    ensureButtons();
    sync();
  }

  /**
   * 发起分屏。
   * @param {"h"|"v"} dir h 为左右并排，v 为上下堆叠
   */
  function start(dir) {
    if (!hasSplit() || !PShell.tabs.hasTabs()) {
      toast("分屏不可用：需同时开启多标签与分屏", "info");
      return;
    }
    const group = PShell.tabs.activeGroup();
    if (!group) {
      toast("请先打开一个会话再分屏", "info");
      return;
    }
    // 方向要在新 pane 加入之前设好，否则会按旧方向渲染一帧
    PShell.tabs.setDirection(group.id, dir);
    if (group.memberIds.length > 1) return;
    openPicker(group.id, dir);
  }

  function pickerItem(title, sub, run) {
    const node = el("div", { class: "split-item", title: sub || title }, [
      el("span", { class: "label", text: title }),
      el("span", { class: "sub", text: sub || "" }),
    ]);
    node.addEventListener("click", run);
    return node;
  }

  /** 选择要放进新分屏的会话目标。 */
  async function openPicker(groupId, dir) {
    const modal = $("modal-split");
    const body = $("split-body");
    if (!modal || !body) return;

    const title = $("split-title");
    if (title) title.textContent = dir === "v" ? "上下分屏" : "左右分屏";

    body.textContent = "";
    body.appendChild(el("p", { class: "muted", text: "选择要在新分屏中打开的会话：" }));

    const listNode = el("div", { class: "split-list" });
    body.appendChild(listNode);
    const hint = $("split-hint");
    if (hint) hint.textContent = "已保存的连接与临时连接均可分屏。";

    modal.hidden = false;

    const current = PShell.terminal.active();
    if (current && current.params) {
      // 同一主机再开一个会话：复用当前会话的参数，仅清除会话 id
      const params = Object.assign({}, current.params, { session_id: null });
      listNode.appendChild(
        pickerItem(
          `同主机新会话 · ${params.username}@${params.host}`,
          "沿用当前会话的连接参数",
          () => openInto(groupId, params)
        )
      );
    }

    let connections = [];
    try {
      connections = (await PShell.ipc.listConnections()) || [];
    } catch (err) {
      toast(errorText(err), "error");
      if (!modal.hidden) modal.hidden = true;
      return;
    }
    if (modal.hidden) return;

    if (!connections.length) {
      listNode.appendChild(
        el("p", { class: "muted", text: "还没有已保存的连接，可在左侧新建。" })
      );
      return;
    }
    connections.forEach((conn) => {
      listNode.appendChild(
        pickerItem(
          conn.name || `${conn.username}@${conn.host}`,
          `${conn.username}@${conn.host}:${conn.port || 22}`,
          () => openInto(groupId, PShell.connections.paramsFor(conn))
        )
      );
    });
  }

  /** 把新会话并入指定标签，失败时提示但不影响已有会话。 */
  async function openInto(groupId, params) {
    const modal = $("modal-split");
    if (modal) modal.hidden = true;
    try {
      await PShell.ssh.connect(params, { groupId });
    } catch (err) {
      toast(errorText(err), "error");
    }
  }

  /** 取消分屏：把一个标签内的会话拆成独立标签，不断开任何连接。 */
  function stop() {
    const group = PShell.tabs.activeGroup();
    if (!group || group.memberIds.length < 2) return;
    const moved = PShell.tabs.unmerge(group);
    if (moved) toast(`已取消分屏，${moved} 个会话拆分为独立标签`, "info");
  }

  PShell.split = { setConfig, sync, start, stop };
})(window.PShell);
