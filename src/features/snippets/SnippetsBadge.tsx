import { useT } from "../../hooks/useLocale";
import { openPanel, useSnippets } from "./store";

/** 侧栏功能徽标：显示片段数量，点击打开面板（关闭该功能时整块不渲染）。 */
export function SnippetsBadge() {
  const state = useSnippets();
  const t = useT();

  if (!state.enabled) return null;

  return (
    <button id="snip-status" className="git-status" title={t("common.snippets", "命令片段")} onClick={openPanel}>
      {`片段 ${state.snippets.length}`}
    </button>
  );
}
