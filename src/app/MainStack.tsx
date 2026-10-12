import { AiBadge } from "../features/ai";
import { AiPanel } from "../features/ai/AiPanel";
import { SplitControls } from "../features/split/SplitControls";

/**
 * 主区：左侧终端栈（标签栏 + pane 容器 + 空状态）+ 右侧 AI 停靠面板。
 * #tab-list / #panes 由 tabs、terminal 命令式操作；#ai-panel 由 ai 同步显隐与宽度。
 */
export function MainStack() {
  return (
    <main className="main">
      <div className="main-stack" id="main-stack">
        {/* 侧栏收起后主区左上角的展开入口 */}
        <button
          id="btn-sidebar-show"
          className="icon-btn sidebar-show"
          title="展开侧边栏"
          data-i18n-title="common.sidebarExpand"
          hidden
        >
          »
        </button>
        <div className="tabbar" id="tabbar" hidden>
          <div className="tab-list" id="tab-list" />
          <button className="tab-add" id="tab-add-btn" title="新建连接" data-i18n-title="common.new">
            ＋
          </button>
          <div className="split-controls" id="split-controls" hidden>
            <SplitControls />
          </div>
          <div className="tab-actions" id="tab-actions">
            <AiBadge />
          </div>
        </div>
        <div className="panes" id="panes" />
        <div className="empty-state" id="empty-state">
          <h1>pterm</h1>
          {/* 卡通终端吉祥物：纯 HTML/CSS 绘制，眨眼 + 轻微浮动动画 */}
          <div className="empty-art" aria-hidden="true">
            <div className="empty-art-window">
              <div className="empty-art-bar">
                <span className="empty-art-dot" />
                <span className="empty-art-dot" />
                <span className="empty-art-dot" />
              </div>
              <div className="empty-art-face">
                <div className="empty-art-eyes">
                  <span className="empty-art-eye" />
                  <span className="empty-art-eye" />
                </div>
                <span className="empty-art-smile" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* AI 助手停靠面板容器：显隐与宽度由 AiFeature 同步 */}
      <aside className="ai-panel" id="ai-panel" hidden>
        <AiPanel />
      </aside>
    </main>
  );
}
