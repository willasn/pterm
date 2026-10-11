import { useT } from "../../hooks/useLocale";
import { badgeText, openPanel, useSessionLog } from "./store";

/** 侧栏功能徽标：显示日志文件数与记录中的会话，点击打开面板（关闭该功能时整块不渲染）。 */
export function SessionLogBadge() {
  const state = useSessionLog();
  const t = useT();

  if (!state.enabled) return null;

  return (
    <button id="log-status" className="git-status" title={t("common.sessionLog", "会话日志")} onClick={openPanel}>
      {badgeText(state.status)}
    </button>
  );
}
