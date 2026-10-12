import { useT } from "../../hooks/useLocale";
import { badgeText, openPanel, useSftp } from "./store";

/** 侧栏功能徽标：显示会话数与当前会话，点击打开面板（关闭该功能时整块不渲染）。 */
export function SftpBadge() {
  const state = useSftp();
  const t = useT();

  if (!state.enabled) return null;

  return (
    <button id="sftp-status" className="git-status" title={t("common.sftp", "SFTP 文件")} onClick={openPanel}>
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
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
      <span className="git-status-text">{badgeText()}</span>
    </button>
  );
}
