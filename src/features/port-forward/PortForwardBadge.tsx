import { useT } from "../../hooks/useLocale";
import { badgeText, openPanel, usePortForward } from "./store";

/** 侧栏功能徽标：显示运行中的转发规则数，点击打开面板（关闭该功能时整块不渲染）。 */
export function PortForwardBadge() {
  const state = usePortForward();
  const t = useT();

  if (!state.enabled) return null;

  return (
    <button id="pf-status" className="git-status" title={t("common.portForward", "端口转发")} onClick={openPanel}>
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
        <line x1="3" y1="7" x2="3" y2="17" />
        <line x1="8" y1="12" x2="20" y2="12" />
        <polyline points="15 7 20 12 15 17" />
      </svg>
      <span className="git-status-text">{badgeText(state.forwards)}</span>
    </button>
  );
}
