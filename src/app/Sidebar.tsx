import { ConnectionList } from "../features/connections/ConnectionList";
import { GitSyncBadge } from "../features/git-sync/GitSyncBadge";
import { HistoryBadge } from "../features/history/HistoryBadge";
import { PortForwardBadge } from "../features/port-forward/PortForwardBadge";
import { SearchBadge } from "../features/search/SearchBadge";
import { SessionLogBadge } from "../features/session-log/SessionLogBadge";
import { SftpBadge } from "../features/sftp/SftpBadge";
import { SnippetsBadge } from "../features/snippets/SnippetsBadge";

/**
 * 侧栏：连接列表（SSH 核心）。
 *
 * 按 id / 类名与命令式逻辑协作；新建 / 设置 / 收起按钮与侧栏拖拽调宽
 * 由 features/app 的 startApp() 在挂载后按 id 绑定。
 */
export function Sidebar() {
  return (
    <aside className="sidebar" id="sidebar">
      <header className="sidebar-head">
        {/* 快捷连接：默认收起为图标，鼠标悬停 / 聚焦时展开输入框（外壳按 id 协作） */}
        <div className="quick-connect" id="quick-connect" hidden>
          <span
            className="quick-connect-icon"
            title="快捷连接：user@host:port"
            aria-hidden="true"
            onClick={() => document.getElementById("quick-input")?.focus()}
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </span>
          <div className="quick-connect-field">
            <input
              id="quick-input"
              type="text"
              placeholder="user@host:port  ⏎"
              spellCheck={false}
            />
          </div>
        </div>
        <SearchBadge />
        <div className="sidebar-head-actions">
          {/* 本地终端：按开关显隐，由 features/local-terminal 的 setEnabledFromConfig 控制 */}
          <button
            id="btn-local-term"
            className="icon-btn"
            title="新建本地终端"
            data-i18n-title="common.localTerminal"
            hidden
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <polyline points="6 9 9 12 6 15" />
              <line x1="12" y1="15" x2="17" y2="15" />
            </svg>
          </button>
          <button id="btn-new-conn" className="icon-btn" title="新建连接" data-i18n-title="common.new">
            ＋
          </button>
          <button id="btn-settings" className="icon-btn" title="设置" data-i18n-title="common.settings">
            ⚙
          </button>
          <button
            id="btn-sidebar-toggle"
            className="icon-btn"
            title="收起侧边栏"
            data-i18n-title="common.sidebarCollapse"
          >
            «
          </button>
        </div>
      </header>
      <nav id="conn-list" className="conn-list">
        <ConnectionList />
      </nav>
      <footer className="sidebar-foot" id="sidebar-foot">
        {/* 功能入口收放按钮：空间不足时自动收起下方徽标，也可手动点击切换（见 app 的 initSidebarFoot） */}
        <button
          id="foot-toggle"
          className="foot-toggle"
          type="button"
          title="显示或隐藏功能入口"
          data-i18n-title="common.footToggleHint"
          hidden
        >
          <span className="foot-toggle-label" data-i18n="common.footToggle">
            功能
          </span>
          <span className="foot-toggle-count" id="foot-toggle-count" />
          <span className="foot-toggle-arrow" aria-hidden="true">
            ▾
          </span>
        </button>
        {/* 功能入口样式变体：foot-badges--tiles = 无图标、居中、带底色的分块样式（去掉该类即回到上一版） */}
        <div className="foot-badges foot-badges--tiles" id="foot-badges">
          <GitSyncBadge />
          <SessionLogBadge />
          <SftpBadge />
          <PortForwardBadge />
          <SnippetsBadge />
          <HistoryBadge />
        </div>
      </footer>
      {/* 右缘拖拽条：左右拖动调整侧栏宽度 */}
      <div
        className="sidebar-resizer"
        id="sidebar-resizer"
        title="拖动调整宽度"
        data-i18n-title="common.sidebarResize"
      />
    </aside>
  );
}
