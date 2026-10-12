import { useT } from "../../hooks/useLocale";
import { openPanel, useImportExport } from "./store";

/** 侧栏功能徽标：点击打开面板（关闭该功能时整块不渲染）。 */
export function ImportExportBadge() {
  const state = useImportExport();
  const t = useT();

  if (!state.enabled) return null;

  return (
    <button
      id="ie-status"
      className="git-status"
      title={t("common.importExport", "配置导入导出")}
      onClick={openPanel}
    >
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
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      <span className="git-status-text">导入导出</span>
    </button>
  );
}
