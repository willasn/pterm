import { useT } from "../../hooks/useLocale";
import { openPanel, useHistory } from "./store";

/** 侧栏功能徽标：显示历史条数，点击打开面板（关闭该功能时整块不渲染）。 */
export function HistoryBadge() {
  const state = useHistory();
  const t = useT();

  if (!state.enabled) return null;

  return (
    <button id="hist-status" className="git-status" title={t("common.history", "命令历史")} onClick={openPanel}>
      {`历史 ${state.entries.length}`}
    </button>
  );
}
