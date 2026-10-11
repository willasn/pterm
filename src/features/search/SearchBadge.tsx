import { useT } from "../../hooks/useLocale";
import { openPanel, useSearch } from "./store";

/** 侧栏搜索入口：关闭全局搜索时整块不渲染。 */
export function SearchBadge() {
  const state = useSearch();
  const t = useT();

  if (!state.enabled) return null;

  return (
    <button id="search-status" className="icon-btn" title={t("common.search", "全局搜索")} onClick={openPanel}>
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="16.5" y1="16.5" x2="21" y2="21" />
      </svg>
    </button>
  );
}
