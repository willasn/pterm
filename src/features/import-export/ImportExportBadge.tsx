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
      导入导出
    </button>
  );
}
