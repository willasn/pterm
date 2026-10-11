import { ConnectionList } from "../features/connections/ConnectionList";
import { GitSyncBadge } from "../features/git-sync/GitSyncBadge";
import { HistoryBadge } from "../features/history/HistoryBadge";
import { ImportExportBadge } from "../features/import-export/ImportExportBadge";
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
        <SearchBadge />
        <div className="sidebar-head-actions">
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
      <div className="quick-connect" id="quick-connect" hidden>
        <input
          id="quick-input"
          type="text"
          placeholder="user@host:port  回车直达"
          spellCheck={false}
        />
      </div>
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
          <span className="foot-toggle-arrow" aria-hidden="true">
            ▾
          </span>
          <span className="foot-toggle-label" data-i18n="common.footToggle">
            功能
          </span>
          <span className="foot-toggle-count" id="foot-toggle-count" />
        </button>
        <div className="foot-badges" id="foot-badges">
          <GitSyncBadge />
          <SessionLogBadge />
          <SftpBadge />
          <PortForwardBadge />
          <ImportExportBadge />
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
