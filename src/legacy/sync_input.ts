/* 同步输入：只在一台终端输入，把按键同步广播到同一同步组内的其它标签。
 *
 * 同步以「标签」为单位（分屏时一个标签含多个会话，整组一起同步）。
 * 每个组各有一个同步开关：关闭时只着色标识分组，开启后组内才互相广播，
 * 并给成员标签加上高亮。标签的着色、高亮、序号徽标与聚拢排序由 tabs.js 呈现，
 * 本模块只维护分组状态、计算广播目标，并在加入组后驱动标签重排（当前标签落到组的最右侧）。 */
(function (PShell) {
  "use strict";

  const { el, toast } = PShell.util;

  /** 分组配色：同一组同色，不同组按创建顺序取不同色。 */
  const PALETTE = [
    "#e5a84b",
    "#4b9fe5",
    "#7bc86c",
    "#c07be0",
    "#e56b6b",
    "#3fbfb0",
    "#d98cc4",
    "#8a8ae5",
  ];

  let config = null;
  /** 组序号自增，用作 id 与展示编号 */
  let seq = 0;
  /** groupId -> { id, index, color, active: bool, tabs: Set<tabGroupId> }
   *  active 为该组的「同步输入」开关：关闭时只着色，开启后组内广播。 */
  const groups = new Map();

  // ---------------------------------------------------------------------------
  // 基础状态
  // ---------------------------------------------------------------------------

  /** 功能开关是否启用（config.yaml 的 features.connection.sync_input）。 */
  function enabled() {
    const conn = (config && config.features && config.features.connection) || {};
    return conn.sync_input !== false;
  }

  /** 标签是否仍存在（关掉的标签会从 tabs 里移除）。 */
  function tabExists(tabId) {
    return !!(PShell.tabs && typeof PShell.tabs.byId === "function" && PShell.tabs.byId(tabId));
  }

  function orderIds() {
    return PShell.tabs && typeof PShell.tabs.orderIds === "function" ? PShell.tabs.orderIds() : [];
  }

  /** 组内仍存活的标签，按标签栏顺序返回。 */
  function liveTabs(group) {
    return orderIds().filter((id) => group.tabs.has(id) && tabExists(id));
  }

  function groupOfTab(tabId) {
    let found = null;
    groups.forEach((group) => {
      if (!found && group.tabs.has(tabId)) found = group;
    });
    return found;
  }

  function groupList() {
    return Array.from(groups.values()).sort((a, b) => a.index - b.index);
  }

  /** 丢弃已不存在标签的成员；组内无成员时连同组一起删除。 */
  function prune() {
    groups.forEach((group) => {
      Array.from(group.tabs).forEach((id) => {
        if (!tabExists(id)) group.tabs.delete(id);
      });
    });
    groups.forEach((group, id) => {
      if (!group.tabs.size) groups.delete(id);
    });
  }

  // ---------------------------------------------------------------------------
  // 广播目标
  // ---------------------------------------------------------------------------

  /**
   * 计算某个会话的同步目标会话 id 列表。
   * - 功能关闭：只有自己。
   * - 在该标签所属的同步组且该组「同步输入」已开启：组内所有标签的全部会话。
   * - 否则：只有自己。
   */
  function targetsFor(sessionId) {
    if (!enabled() || !sessionId) return sessionId ? [sessionId] : [];

    const tab = PShell.tabs.groupOf(sessionId);
    const group = tab ? groupOfTab(tab.id) : null;
    if (!group || !group.active) return [sessionId];

    const ids = [];
    liveTabs(group).forEach((tabId) => {
      const target = PShell.tabs.byId(tabId);
      (target ? target.memberIds : []).forEach((id) => ids.push(id));
    });
    return ids.length ? ids : [sessionId];
  }

  // ---------------------------------------------------------------------------
  // 分组操作
  // ---------------------------------------------------------------------------

  /** 把若干标签并入指定组：先退出各自的旧组，再加入新组，最后重排。 */
  function join(groupId, tabIds, currentTabId) {
    const group = groups.get(groupId);
    if (!group) return;
    tabIds.forEach((id) => {
      const other = groupOfTab(id);
      if (other && other !== group) other.tabs.delete(id);
      group.tabs.add(id);
    });
    prune();
    arrange(group.id, currentTabId);
    const count = liveTabs(group).length;
    toast(
      group.active
        ? `已加入同步组 ${group.index}（${count} 个标签，同步输入已开启）`
        : `已加入同步组 ${group.index}（${count} 个标签，可在右键菜单开启同步输入）`,
      "info"
    );
  }

  /** 新建一个组并把目标标签加入。syncActive 决定建组时是否即开启组内同步。 */
  function createGroup(tabIds, currentTabId, syncActive) {
    seq += 1;
    const id = "sg" + seq;
    const group = {
      id,
      index: seq,
      color: PALETTE[(seq - 1) % PALETTE.length],
      active: !!syncActive,
      tabs: new Set(),
    };
    groups.set(id, group);
    join(id, tabIds, currentTabId);
  }

  /** 把标签移出它所在的组（组空则删除）。 */
  function leave(tabId) {
    const group = groupOfTab(tabId);
    if (!group) return;
    group.tabs.delete(tabId);
    groups.forEach((item, id) => {
      if (!item.tabs.size) groups.delete(id);
    });
    PShell.tabs.render();
  }

  /** 解散全部同步组：清空所有标签的组标记与配色。 */
  function clearAll() {
    if (!groups.size) return;
    groups.clear();
    PShell.tabs.render();
    toast("已移除全部同步组", "info");
  }

  function hasGroups() {
    return groups.size > 0;
  }

  /**
   * 切换当前标签所在组的「同步输入」开关。
   * 标签尚未分组时，直接以它新建一个已开启同步的组。
   */
  function toggleSync(tabId) {
    if (!enabled()) {
      toast("同步输入已在设置中关闭", "info");
      return;
    }
    const group = groupOfTab(tabId);
    if (!group) {
      // join 内部会给出提示
      createGroup([tabId], tabId, true);
      return;
    }
    group.active = !group.active;
    PShell.tabs.render();
    toast(
      group.active
        ? `同步组 ${group.index} 已开启：组内输入会互相广播`
        : `同步组 ${group.index} 已关闭组内同步输入`,
      "info"
    );
  }

  /**
   * 需求 5：组内标签聚拢到一起，且当前标签落到组的最右侧。
   * 其余成员保持原有相对顺序；块整体挪到原第一个成员所在的位置。
   */
  function arrange(groupId, currentTabId) {
    const group = groups.get(groupId);
    if (!group) return;
    const all = orderIds();
    const members = all.filter((id) => group.tabs.has(id));
    if (!members.length) {
      PShell.tabs.render();
      return;
    }
    if (members.length === 1) {
      PShell.tabs.render();
      return;
    }
    const firstIndex = all.findIndex((id) => group.tabs.has(id));
    const rest = all.filter((id) => !group.tabs.has(id));
    const block = members.filter((id) => id !== currentTabId);
    if (currentTabId && members.indexOf(currentTabId) !== -1) block.push(currentTabId);
    // 块的目标插入位置 = 原第一个成员之前、非成员标签的数量
    const before = all.slice(0, firstIndex).filter((id) => !group.tabs.has(id)).length;
    const next = rest.slice(0, before).concat(block, rest.slice(before));
    PShell.tabs.setOrder(next);
  }

  /** 标签关闭时清理它的组成员关系。 */
  function onTabGone(tabId) {
    let changed = false;
    groups.forEach((group, id) => {
      if (group.tabs.delete(tabId)) changed = true;
      if (!group.tabs.size) {
        groups.delete(id);
        changed = true;
      }
    });
    return changed;
  }

  /** 分屏被取消、一个标签拆成多个标签时，新标签继承原标签的组成员关系。 */
  function onTabsFromSplit(originalTabId, newTabIds) {
    const group = groupOfTab(originalTabId);
    if (!group) return;
    (newTabIds || []).forEach((id) => group.tabs.add(id));
  }

  /** 供 tabs.js 渲染：标签所属组的颜色、序号与同步开关；不在组里返回 null。 */
  function styleFor(tabId) {
    if (!enabled()) return null;
    const group = groupOfTab(tabId);
    if (!group) return null;
    return { color: group.color, index: group.index, active: group.active };
  }

  // ---------------------------------------------------------------------------
  // 选组弹框
  // ---------------------------------------------------------------------------

  let pickerNode = null;

  function closePicker() {
    if (!pickerNode) return;
    pickerNode.remove();
    pickerNode = null;
    document.removeEventListener("keydown", onPickerKey, true);
  }

  function onPickerKey(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closePicker();
  }

  function row(children, onClick, extraClass) {
    const node = el("button", { class: "sync-picker-row" + (extraClass ? " " + extraClass : ""), type: "button" }, children);
    node.addEventListener("click", onClick);
    return node;
  }

  /**
   * 打开选组弹框：把 tabIds 加入已有组或新建组。
   * @param {string[]} tabIds 待加入的标签（全部添加到组时是全部标签）
   * @param {string} currentTabId 当前右击的标签，加入后落到组的最右侧
   */
  function pick(tabIds, currentTabId) {
    if (!enabled()) {
      toast("同步输入已在设置中关闭", "info");
      return;
    }
    prune();
    const ids = (tabIds || []).filter((id) => tabExists(id));
    if (!ids.length) return;
    closePicker();

    const currentOnly = ids.length === 1 && ids[0] === currentTabId;
    const title = currentOnly ? "添加当前标签到同步组" : `添加全部 ${ids.length} 个标签到同步组`;

    const mask = el("div", { class: "sync-picker-mask" });
    const card = el("div", { class: "sync-picker" }, [
      el("div", { class: "sync-picker-head", text: title }),
      el("p", {
        class: "sync-picker-desc",
        text: "加入后组的标签会用同色标识；开启「组内同步输入」后，只在一台终端输入即可同步到组内其余标签。",
      }),
    ]);
    const list = el("div", { class: "sync-picker-list" });
    groupList().forEach((group) => {
      const swatch = el("span", { class: "sync-swatch" });
      swatch.style.background = group.color;
      list.appendChild(
        row(
          [
            swatch,
            el("span", { class: "name", text: `同步组 ${group.index}` }),
            el("span", {
              class: "muted",
              text: `${liveTabs(group).length} 个标签 · ${group.active ? "同步中" : "未同步"}`,
            }),
          ],
          () => {
            closePicker();
            join(group.id, ids, currentTabId);
          }
        )
      );
    });
    list.appendChild(
      row(
        [
          el("span", { class: "ico", text: "＋" }),
          el("span", { class: "name", text: "新建同步组" }),
        ],
        () => {
          closePicker();
          createGroup(ids, currentTabId);
        },
        "create"
      )
    );
    card.appendChild(list);

    // 目标标签当前全在同一组时，额外提供「移出组」入口
    let common = groupOfTab(ids[0]) || null;
    for (let i = 1; common && i < ids.length; i++) {
      if (groupOfTab(ids[i]) !== common) common = null;
    }
    if (common) {
      card.appendChild(
        row(
          [
            el("span", { class: "ico", text: "－" }),
            el("span", { class: "name", text: `移出同步组 ${common.index}` }),
          ],
          () => {
            closePicker();
            ids.forEach((id) => leave(id));
          }
        )
      );
    }

    mask.appendChild(card);
    mask.addEventListener("mousedown", (event) => {
      if (event.target === mask) closePicker();
    });
    document.body.appendChild(mask);
    pickerNode = mask;
    document.addEventListener("keydown", onPickerKey, true);
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  function setConfig(next) {
    config = next;
    if (!enabled()) {
      // 功能被关掉：清空状态，让标签恢复原样（广播在 targetsFor 里已被门控）
      groups.clear();
      if (PShell.tabs) PShell.tabs.render();
    }
  }

  PShell.syncInput = {
    setConfig,
    enabled,
    toggleSync,
    clearAll,
    hasGroups,
    targetsFor,
    pick,
    join,
    leave,
    onTabGone,
    onTabsFromSplit,
    styleFor,
    groupOfTab,
    list: groupList,
  };
})(window.PShell);
