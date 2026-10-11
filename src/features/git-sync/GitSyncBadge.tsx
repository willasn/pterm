import { useT } from "../../hooks/useLocale";
import { badgeText, openPanel, useGitSync } from "./store";

/** 侧栏功能徽标：显示同步状态，点击打开面板（关闭该功能时整块不渲染）。 */
export function GitSyncBadge() {
  const state = useGitSync();
  const t = useT();

  if (!state.enabled) return null;

  return (
    <button id="git-status" className="git-status" title={t("common.gitSync", "Git 同步")} onClick={openPanel}>
      {badgeText()}
    </button>
  );
}
