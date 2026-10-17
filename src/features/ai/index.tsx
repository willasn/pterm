import { useEffect } from "react";
import { count } from "../tabs/store";
import { getWidth, subscribeAiEvents, togglePanel, useAiVersion, view } from "./store";

/** 标签栏右侧入口：开启且有会话时才出现；点它开合面板（关闭该功能时整块不渲染）。 */
export function AiBadge() {
  const version = useAiVersion();
  void version;
  const state = view();

  // 入口只在存在终端会话时出现——没有会话时面板无从服务，打开也只是一个空壳。
  // tabs 增删会经 store.renderBadge（即 bump）触发这里重算。
  if (!state.enabled || count() === 0) return null;

  const on = state.panelOpen;
  return (
    <button
      id="ai-status"
      className={"icon-btn" + (on ? " active" : "")}
      title={on ? "收起 AI 助手" : "打开 AI 助手"}
      onClick={togglePanel}
    >
      AI
    </button>
  );
}

/**
 * AI 助手功能入口：停靠面板的订阅与显隐同步。
 *
 * 命令式 API 已由 app / tabs / terminal / settings / shortcuts 直接 import，
 * 故不再挂 window.PTerm 桥接。
 */
export function AiFeature() {
  const version = useAiVersion();
  void version;
  const state = view();

  // Ask 流式事件直连 __TAURI__.event，组件挂载时即可订阅
  useEffect(() => subscribeAiEvents(), []);

  // 面板容器由外壳持有（停靠布局），这里同步显隐与宽度
  useEffect(() => {
    const host = document.querySelector<HTMLElement>("#ai-panel");
    if (!host) return;
    host.hidden = !state.panelOpen;
    if (state.panelOpen) host.style.width = getWidth() + "px";
  }, [version, state.panelOpen]);

  return null;
}
