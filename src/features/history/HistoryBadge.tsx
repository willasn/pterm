import { useT } from "../../hooks/useLocale";
import { openPanel, useHistory } from "./store";

/** 侧栏功能徽标：显示历史条数，点击打开面板（关闭该功能时整块不渲染）。 */
export function HistoryBadge() {
  const state = useHistory();
  const t = useT();

  if (!state.enabled) return null;

  return (
    <button id="hist-status" className="git-status" title={t("common.history", "命令历史")} onClick={openPanel}>
      <svg
        className="git-status-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <polyline points="12 7 12 12 16 14" />
      </svg>
      <span className="git-status-text">{`历史 ${state.entries.length}`}</span>
    </button>
  );
}
