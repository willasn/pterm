/* 多标签与分屏布局。
 * 一个标签 = 一个 pane 组（group）：未分屏时组内只有 1 个会话，分屏后组内多个会话并排共享同一标签。
 * 本模块只负责标签与布局，终端实例本身仍由 terminal.js 持有（controllers）。 */
(function (PShell) {
  "use strict";

  const { el, $, toast, ask, errorText } = PShell.util;

  /** groupId -> group；group 结构见 createGroup */
  const groups = new Map();
  /** groupId 的渲染顺序，始终与标签 DOM 顺序一致 */
  let order = [];
  let activeGroupId = null;
  let activeId = null;
  let config = null;
  let seq = 0;
  /** 正在拖拽排序的 groupId */
  let dragging = null;

  // ---------------------------------------------------------------------------
  // 状态查询
  // ---------------------------------------------------------------------------

  function ctrlOf(id) {
    return PShell.terminal ? PShell.terminal.get(id) : null;
  }

  function hasTabs() {
    return !!(config && config.features && config.features.connection.tabs);
  }

  function hasSplit() {
    return !!(config && config.features && config.features.connection.split_view);
  }

  function activeIdOf() {
    return activeId;
  }

  function groupOf(id) {
    let found = null;
    groups.forEach((group) => {
      if (!found && group.memberIds.indexOf(id) !== -1) found = group;
    });
    return found;
  }

  function activeGroup() {
    return activeGroupId ? groups.get(activeGroupId) || null : null;
  }

  function groupList() {
    return order.map((id) => groups.get(id)).filter(Boolean);
  }

  function count() {
    return groups.size;
  }

  /** 标签顺序快照（同步组重排时用）。 */
  function orderIds() {
    return order.slice();
  }

  /** 按给定顺序重排标签；未列出但仍存在的标签按原顺序追加在后面。 */
  function setOrder(ids) {
    const seen = new Set();
    const next = [];
    (ids || []).forEach((id) => {
      if (groups.has(id) && !seen.has(id)) {
        seen.add(id);
        next.push(id);
      }
    });
    order.forEach((id) => {
      if (!seen.has(id) && groups.has(id)) next.push(id);
    });
    order = next;
    render();
  }

  /** 按标签（组）id 取分组对象。 */
  function byId(groupId) {
    return groups.get(groupId) || null;
  }

  function setConfig(next) {
    config = next;
    enforcePolicies();
    render();
  }

  // ---------------------------------------------------------------------------
  // 组与标签
  // ---------------------------------------------------------------------------

  function createGroup() {
    seq += 1;
    const id = "g" + seq;
    const paneEl = el("div", {
      class: "pane-group",
      dataset: { group: id, dir: "h", split: "0" },
    });
    const host = $("panes");
    if (host) host.appendChild(paneEl);
    const group = { id, dir: "h", memberIds: [], activeId: null, label: null, paneEl, tab: null };
    groups.set(id, group);
    order.push(id);
    return group;
  }

  function tabHost() {
    return $("tab-list") || $("tabbar");
  }

  function buildTab(group) {
    const tab = el(
      "div",
      { class: "tab", dataset: { group: group.id, state: "connecting" }, draggable: "true" },
      [
        el("span", { class: "dot" }),
        el("span", { class: "name" }),
        el("span", { class: "count", hidden: true }),
        el("button", {
          class: "close",
          title: "关闭标签",
          text: "✕",
          onclick: (event) => {
            event.stopPropagation();
            closeGroup(group);
          },
        }),
      ]
    );
    tab.addEventListener("click", () => activateGroup(group.id));
    tab.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      startRename(group, tab, tab.querySelector(".name"));
    });
    tab.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // 先激活被右击的标签，后续分屏 / 关闭等动作才会作用于它
      activateGroup(group.id);
      PShell.menu.open(event.clientX, event.clientY, tabMenu(group, tab));
    });
    bindDrag(group, tab);
    return tab;
  }

  /** 标签的右键菜单：只放与这个标签及其会话相关的动作，入口按功能开关隐藏。 */
  function tabMenu(group, tab) {
    const features = (config && config.features) || {};
    const conn = features.connection || {};
    const aux = features.auxiliary || {};
    const ctrl = ctrlOf(group.activeId);
    const state = (ctrl && ctrl.info && ctrl.info.state && ctrl.info.state.state) || "";
    const running = state === "ready" || state === "connecting";

    const items = [
      { label: "重命名标签", icon: "✎", run: () => startRename(group, tab, tab.querySelector(".name")) },
    ];
    // 克隆会话只针对 SSH：只有 SSH 会话带原始连接参数（RDP 走外部客户端、不产生标签）
    if (ctrl && ctrl.params) {
      items.push({ label: "克隆会话", icon: "❐", run: () => cloneSession(ctrl) });
    }
    if (group.activeId && state && !running) {
      items.push({ label: "重新连接", icon: "⟲", run: () => PShell.ssh.reconnect(group.activeId) });
    }

    if (hasSplit() && hasTabs()) {
      items.push(
        { sep: true },
        { label: "左右分屏", icon: "⇄", run: () => PShell.split.start("h") },
        { label: "上下分屏", icon: "⇅", run: () => PShell.split.start("v") }
      );
      if (group.memberIds.length > 1) {
        items.push({ label: "取消分屏", icon: "⊟", run: () => PShell.split.stop() });
      }
    }

    // 同步输入：组内同步开关 + 组的增删（分组后组内输入互相广播）
    if (PShell.syncInput && PShell.syncInput.enabled()) {
      const allTabs = groupList().map((item) => item.id);
      const syncGroup = PShell.syncInput.groupOfTab(group.id);
      items.push(
        { sep: true },
        {
          label: syncGroup && syncGroup.active ? "关闭组内同步输入" : "开启组内同步输入",
          icon: "⇋",
          run: () => PShell.syncInput.toggleSync(group.id),
        },
        { label: "当前添加到组", icon: "＋", run: () => PShell.syncInput.pick([group.id], group.id) },
        { label: "全部添加到组", icon: "⧉", run: () => PShell.syncInput.pick(allTabs, group.id) }
      );
      if (syncGroup) {
        items.push({ label: "移出同步组", icon: "－", run: () => PShell.syncInput.leave(group.id) });
      }
      if (PShell.syncInput.hasGroups()) {
        items.push({
          label: "移除全部组",
          icon: "⊘",
          danger: true,
          run: () => PShell.syncInput.clearAll(),
        });
      }
    }

    const modules = [
      conn.sftp ? { label: "打开 SFTP", icon: "⇅", run: () => openModule(PShell.sftp) } : null,
      conn.port_forward ? { label: "端口转发", icon: "⇄", run: () => openModule(PShell.portForward) } : null,
      conn.session_log ? { label: "会话日志", icon: "▤", run: () => openModule(PShell.sessionLog) } : null,
      aux.snippets ? { label: "命令片段", icon: "⌘", run: () => openModule(PShell.snippets) } : null,
      aux.command_history ? { label: "命令历史", icon: "⟲", run: () => openModule(PShell.history) } : null,
    ].filter(Boolean);
    if (modules.length) items.push({ sep: true }, ...modules);

    items.push(
      { sep: true },
      { label: "关闭标签", icon: "✕", run: () => closeGroup(group) },
      { label: "关闭其他标签", icon: "⊘", danger: true, run: () => closeOthers(group) }
    );
    return items;
  }

  /** 模块可能未启用或未加载，open 不可用时静默跳过。 */
  function openModule(mod) {
    if (mod && typeof mod.open === "function") mod.open();
  }

  /**
   * 克隆会话：用同一份连接参数再开一个独立的 SSH 会话（新标签）。
   * 清空 session_id 让后端分配新会话，并按当前终端尺寸初始化。
   */
  function cloneSession(ctrl) {
    if (!ctrl || !ctrl.params) return;
    const params = Object.assign({}, ctrl.params, {
      session_id: null,
      cols: ctrl.term.cols,
      rows: ctrl.term.rows,
    });
    Promise.resolve(PShell.ssh.connect(params)).catch((err) => toast(errorText(err), "error"));
  }

  /** 标签上的标题与状态取自组内当前活跃会话，重命名后以自定义名为准。 */
  function syncTab(group) {
    const tab = group.tab;
    if (!tab) return;
    const ctrl = ctrlOf(group.activeId);
    const state = (ctrl && ctrl.info && ctrl.info.state && ctrl.info.state.state) || "connecting";
    const name = group.label || (ctrl && ctrl.info && ctrl.info.name) || "会话";
    const size = group.memberIds.length;

    tab.dataset.state = state;
    tab.title = size > 1 ? `${name} · ${size} 个分屏会话` : name;

    const nameNode = tab.querySelector(".name");
    if (nameNode && !nameNode.dataset.renaming) nameNode.textContent = name;

    const countNode = tab.querySelector(".count");
    if (countNode) {
      countNode.textContent = String(size);
      countNode.hidden = size < 2;
    }

    applySyncStyle(tab, group);
  }

  /** #rrggbb 转 rgba(...)，用于给同步中的标签叠加同色浅底。 */
  function hexToRgba(hex, alpha) {
    const value = String(hex || "").replace("#", "");
    if (value.length !== 6) return "transparent";
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /**
   * 标签的同步组外观：
   * - 已分组：同色轮廓 + 组序号徽标（用于区分不同组）。
   * - 组内同步已开启：额外叠加同色浅底与加粗轮廓，和普通状态明显区分。
   */
  function applySyncStyle(tab, group) {
    const info =
      PShell.syncInput && typeof PShell.syncInput.styleFor === "function"
        ? PShell.syncInput.styleFor(group.id)
        : null;
    if (!info) {
      delete tab.dataset.sync;
      delete tab.dataset.syncActive;
      tab.style.removeProperty("--tab-sync-color");
      tab.style.removeProperty("--tab-sync-tint");
      const stale = tab.querySelector(".sync-badge");
      if (stale) stale.remove();
      return;
    }
    tab.dataset.sync = "1";
    tab.style.setProperty("--tab-sync-color", info.color);
    if (info.active) {
      tab.dataset.syncActive = "1";
      tab.style.setProperty("--tab-sync-tint", hexToRgba(info.color, 0.16));
    } else {
      delete tab.dataset.syncActive;
      tab.style.removeProperty("--tab-sync-tint");
    }
    let badge = tab.querySelector(".sync-badge");
    if (!badge) {
      badge = el("span", { class: "sync-badge" });
      const countNode = tab.querySelector(".count");
      if (countNode) tab.insertBefore(badge, countNode);
      else tab.appendChild(badge);
    }
    badge.textContent = String(info.index);
    badge.style.background = info.color;
    badge.title = info.active ? `同步组 ${info.index}（同步输入已开启）` : `同步组 ${info.index}`;
  }

  /** 只刷新一个标签（会话状态变化时调用，避免整栏重排）。 */
  function touch(ctrl) {
    const group = ctrl ? groupOf(ctrl.id) : null;
    if (group) syncTab(group);
  }

  /** 重绘标签栏：补齐/移除标签、按 order 排列。 */
  function render() {
    const tabbar = $("tabbar");
    const list = tabHost();
    if (!tabbar || !list) return;
    tabbar.hidden = !(hasTabs() && groups.size > 0);

    Array.from(list.querySelectorAll(".tab")).forEach((node) => {
      if (!groups.has(node.dataset.group)) node.remove();
    });
    order.forEach((id) => {
      const group = groups.get(id);
      if (!group) return;
      if (!group.tab) group.tab = buildTab(group);
      list.appendChild(group.tab);
    });
    syncLayout();
  }

  /** 同步 pane 组显隐、分屏方向与 pane 归属。 */
  function syncLayout() {
    groups.forEach((group) => {
      const on = group.id === activeGroupId;
      group.paneEl.dataset.dir = group.dir;
      group.paneEl.dataset.split = group.memberIds.length > 1 ? "1" : "0";
      group.paneEl.classList.toggle("active", on);
      if (group.tab) group.tab.classList.toggle("active", on);
      group.memberIds.forEach((id) => {
        const ctrl = ctrlOf(id);
        if (ctrl && ctrl.pane.parentNode !== group.paneEl) group.paneEl.appendChild(ctrl.pane);
      });
      syncTab(group);
    });
    notifySplit();
    notifyAi();
  }

  /** 通知分屏工具栏刷新（split.js 可能尚未加载）。 */
  function notifySplit() {
    if (PShell.split && typeof PShell.split.sync === "function") PShell.split.sync();
  }

  /** 通知 AI 入口刷新：它的按钮只在存在会话时出现，见 ai.js 的 renderBadge。 */
  function notifyAi() {
    if (PShell.ai && typeof PShell.ai.renderBadge === "function") PShell.ai.renderBadge();
  }

  function fitGroup(group) {
    group.memberIds.forEach((id) => {
      const ctrl = ctrlOf(id);
      if (ctrl) ctrl.fit();
    });
  }

  // ---------------------------------------------------------------------------
  // 会话的接入与移除
  // ---------------------------------------------------------------------------

  /**
   * 把一个终端接入标签体系。
   * @param {object} ctrl terminal.js 的控制器
   * @param {object} options `{ groupId }`：分屏时指定并入的标签；未开启分屏时忽略
   */
  function attach(ctrl, options) {
    const opts = options || {};
    const wanted = hasSplit() && opts.groupId ? groups.get(opts.groupId) || null : null;
    const group = wanted || createGroup();

    if (wanted) {
      if (group.memberIds.indexOf(ctrl.id) === -1) group.memberIds.push(ctrl.id);
    } else {
      group.memberIds = [ctrl.id];
    }
    group.activeId = ctrl.id;
    activeGroupId = group.id;
    activeId = ctrl.id;

    group.paneEl.appendChild(ctrl.pane);
    render();
    fitGroup(group);
    if (ctrl.focus) ctrl.focus();
    return group;
  }

  function detach(ctrl) {
    const group = groupOf(ctrl.id);
    if (!group) return;

    group.memberIds = group.memberIds.filter((id) => id !== ctrl.id);
    if (group.activeId === ctrl.id) {
      group.activeId = group.memberIds[group.memberIds.length - 1] || null;
    }

    if (!group.memberIds.length) {
      const index = order.indexOf(group.id);
      groups.delete(group.id);
      order = order.filter((id) => id !== group.id);
      group.paneEl.remove();
      if (group.tab) group.tab.remove();
      // 标签彻底消失：清理它在同步组里的成员关系
      if (PShell.syncInput && typeof PShell.syncInput.onTabGone === "function") {
        PShell.syncInput.onTabGone(group.id);
      }
      if (activeGroupId === group.id) {
        activeGroupId = null;
        activeId = null;
        const next = order[Math.min(index, order.length - 1)];
        if (next) {
          activateGroup(next);
          return;
        }
      }
      render();
      return;
    }

    // 只剩一个会话时方向无意义，复位以免下次分屏沿用旧方向
    if (group.memberIds.length === 1) group.dir = "h";
    if (activeGroupId === group.id) activateGroup(group.id);
    else render();
  }

  // ---------------------------------------------------------------------------
  // 激活与关闭
  // ---------------------------------------------------------------------------

  function activateGroup(groupId) {
    const group = groups.get(groupId);
    if (!group) return;
    activeGroupId = groupId;
    if (group.memberIds.indexOf(group.activeId) === -1) {
      group.activeId = group.memberIds[group.memberIds.length - 1] || null;
    }
    activeId = group.activeId;
    syncLayout();
    fitGroup(group);
    const ctrl = ctrlOf(activeId);
    if (ctrl && ctrl.focus) ctrl.focus();
  }

  /** 激活某个会话（同时激活它所在的标签）。 */
  function activate(id) {
    const group = groupOf(id);
    if (!group) return;
    group.activeId = id;
    activateGroup(group.id);
  }

  /** 关闭整个标签：组内多个会话时先征求确认，避免误断多条连接。 */
  async function closeGroup(group) {
    if (!group || !group.memberIds.length) return;
    const ids = group.memberIds.slice();
    if (ids.length > 1) {
      const ok = await ask(`该标签内有 ${ids.length} 个会话，关闭将全部断开，是否继续？`);
      if (!ok) return;
    }
    ids.forEach((id) => PShell.ssh.close(id));
  }

  /** 关闭除指定标签外的所有标签（会断开其中的会话，先征求确认）。 */
  async function closeOthers(keep) {
    const others = groupList().filter((group) => group !== keep && group.memberIds.length);
    if (!others.length) return;
    const ok = await ask(`关闭其他 ${others.length} 个标签？其中的会话将全部断开，是否继续？`);
    if (!ok) return;
    others.forEach((group) => group.memberIds.slice().forEach((id) => PShell.ssh.close(id)));
  }

  // ---------------------------------------------------------------------------
  // 分屏
  // ---------------------------------------------------------------------------

  function setDirection(groupId, dir) {
    const group = groups.get(groupId);
    if (!group) return;
    group.dir = dir === "v" ? "v" : "h";
    syncLayout();
    fitGroup(group);
  }

  /** 取消分屏：组内其余会话各自独立成标签，不关闭任何会话。返回拆出的数量。 */
  function unmerge(group) {
    if (!group || group.memberIds.length < 2) return 0;
    const [first, ...rest] = group.memberIds;
    group.memberIds = [first];
    group.activeId = first;
    group.dir = "h";

    const created = rest.map((id) => {
      const extra = createGroup();
      extra.memberIds = [id];
      extra.activeId = id;
      return extra.id;
    });
    const at = order.indexOf(group.id) + 1;
    order = order.filter((id) => created.indexOf(id) === -1);
    order.splice(at, 0, ...created);

    // 拆出来的新标签继承原标签的同步组成员关系，避免同步链路被分屏取消切断
    if (PShell.syncInput && typeof PShell.syncInput.onTabsFromSplit === "function") {
      PShell.syncInput.onTabsFromSplit(group.id, created);
    }

    render();
    return rest.length;
  }

  // ---------------------------------------------------------------------------
  // 开关关闭时的降级
  // ---------------------------------------------------------------------------

  function enforcePolicies() {
    if (hasTabs() && hasSplit()) return;

    if (!hasTabs()) {
      // 多标签关闭时同一时刻只允许一个会话，其余按用户意图关闭
      if (!PShell.terminal || PShell.terminal.list().length <= 1) return;
      const keep = activeId;
      const extra = PShell.terminal
        .list()
        .map((ctrl) => ctrl.id)
        .filter((id) => id !== keep);
      if (!extra.length) return;
      extra.forEach((id) => PShell.ssh.close(id));
      toast(`多标签已关闭，仅保留当前会话，另关闭 ${extra.length} 个`, "info");
      return;
    }

    // 分屏关闭时把同一标签内的会话拆成独立标签，不断开连接
    let moved = 0;
    Array.from(groups.values())
      .filter((group) => group.memberIds.length > 1)
      .forEach((group) => {
        moved += unmerge(group);
      });
    if (moved) toast(`分屏已关闭，${moved} 个会话已拆分为独立标签`, "info");
  }

  // ---------------------------------------------------------------------------
  // 标签重命名与拖拽排序
  // ---------------------------------------------------------------------------

  function startRename(group, tab, nameNode) {
    if (!nameNode || nameNode.dataset.renaming) return;
    nameNode.dataset.renaming = "1";
    tab.draggable = false;

    const input = el("input", { class: "rename", type: "text", spellcheck: "false" });
    input.value = nameNode.textContent;
    nameNode.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) {
        const value = input.value.trim();
        group.label = value || null;
      }
      delete nameNode.dataset.renaming;
      input.replaceWith(nameNode);
      tab.draggable = true;
      syncTab(group);
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }

  function bindDrag(group, tab) {
    tab.addEventListener("dragstart", (event) => {
      dragging = group.id;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", group.id);
      }
    });

    tab.addEventListener("dragover", (event) => {
      if (!dragging || dragging === group.id) return;
      const moved = groups.get(dragging);
      if (!moved || !moved.tab) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      const rect = tab.getBoundingClientRect();
      if (event.clientX > rect.left + rect.width / 2) tab.after(moved.tab);
      else tab.before(moved.tab);
      syncOrder();
    });

    tab.addEventListener("drop", (event) => {
      event.preventDefault();
      dragging = null;
      syncOrder();
    });

    tab.addEventListener("dragend", () => {
      dragging = null;
      syncOrder();
    });
  }

  /** 从 DOM 回读标签顺序，保持 order 与界面一致。 */
  function syncOrder() {
    const list = tabHost();
    if (!list) return;
    const ids = Array.from(list.querySelectorAll(".tab"))
      .map((node) => node.dataset.group)
      .filter((id) => groups.has(id));
    if (ids.length) order = ids;
  }

  PShell.tabs = {
    setConfig,
    attach,
    detach,
    activate,
    activateGroup,
    setDirection,
    unmerge,
    touch,
    render,
    activeId: activeIdOf,
    activeGroup,
    groupOf,
    list: groupList,
    count,
    byId,
    orderIds,
    setOrder,
    hasTabs,
    hasSplit,
  };
})(window.PShell);