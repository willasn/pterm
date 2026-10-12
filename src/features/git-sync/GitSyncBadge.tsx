import { useT } from "../../hooks/useLocale";
import { badgeText, openPanel, useGitSync } from "./store";

/** 侧栏功能徽标：显示同步状态，点击打开面板（关闭该功能时整块不渲染）。 */
export function GitSyncBadge() {
  const state = useGitSync();
  const t = useT();

  if (!state.enabled) return null;

  return (
    <button id="git-status" className="git-status" title={t("common.gitSync", "Git 同步")} onClick={openPanel}>
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
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
        <path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
      <span className="git-status-text">{badgeText()}</span>
    </button>
  );
}
