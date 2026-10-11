import { useT } from "../../hooks/useLocale";
import { badgeText, openPanel, useSftp } from "./store";

/** 侧栏功能徽标：显示会话数与当前会话，点击打开面板（关闭该功能时整块不渲染）。 */
export function SftpBadge() {
  const state = useSftp();
  const t = useT();

  if (!state.enabled) return null;

  return (
    <button id="sftp-status" className="git-status" title={t("common.sftp", "SFTP 文件")} onClick={openPanel}>
      {badgeText()}
    </button>
  );
}
