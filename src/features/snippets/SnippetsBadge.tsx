import { useT } from "../../hooks/useLocale";
import { openPanel, useSnippets } from "./store";

/** 侧栏功能徽标：显示片段数量，点击打开面板（关闭该功能时整块不渲染）。 */
export function SnippetsBadge() {
  const state = useSnippets();
  const t = useT();

  if (!state.enabled) return null;

  return (
    <button id="snip-status" className="git-status" title={t("common.snippets", "命令片段")} onClick={openPanel}>
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
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
      <span className="git-status-text">{`片段 ${state.snippets.length}`}</span>
    </button>
  );
}
