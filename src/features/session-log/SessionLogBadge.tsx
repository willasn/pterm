import { useT } from "../../hooks/useLocale";
import { badgeText, openPanel, useSessionLog } from "./store";

/** 侧栏功能徽标：显示日志文件数与记录中的会话，点击打开面板（关闭该功能时整块不渲染）。 */
export function SessionLogBadge() {
  const state = useSessionLog();
  const t = useT();

  if (!state.enabled) return null;

  return (
    <button id="log-status" className="git-status" title={t("common.sessionLog", "会话日志")} onClick={openPanel}>
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
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </svg>
      <span className="git-status-text">{badgeText(state.status)}</span>
    </button>
  );
}
