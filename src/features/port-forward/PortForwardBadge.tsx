import { useT } from "../../hooks/useLocale";
import { badgeText, openPanel, usePortForward } from "./store";

/** 侧栏功能徽标：显示运行中的转发规则数，点击打开面板（关闭该功能时整块不渲染）。 */
export function PortForwardBadge() {
  const state = usePortForward();
  const t = useT();

  if (!state.enabled) return null;

  return (
    <button id="pf-status" className="git-status" title={t("common.portForward", "端口转发")} onClick={openPanel}>
      {badgeText(state.forwards)}
    </button>
  );
}
