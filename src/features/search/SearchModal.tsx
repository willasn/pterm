import { useEffect, useRef } from "react";
import { Note, Section } from "../../components/form";
import { Portal } from "../../components/Portal";
import { useT } from "../../hooks/useLocale";
import {
  closePanel,
  searchGroups,
  setQuery,
  useSearch,
  type SearchState,
} from "./store";
import type { SearchGroup } from "./types";

/** 结果区顶部的提示：拉取失败、被关闭的模块。 */
function Notices({ state }: { state: SearchState }) {
  const off: string[] = [];
  if (!state.flags.snippets) off.push("命令片段");
  if (!state.flags.command_history) off.push("命令历史");

  return (
    <>
      {state.lastError ? <Note kind="error">{state.lastError}</Note> : null}
      {off.length ? <Note>{`已关闭的模块不参与搜索：${off.join("、")}。`}</Note> : null}
    </>
  );
}

/**
 * 全局搜索（features.auxiliary.global_search 打开时可用）。
 *
 * 与迁移前一致：关闭时侧栏入口隐藏、快捷键 app.search 不响应（由 shortcuts 侧判断）。
 */
export function SearchModal() {
  const state = useSearch();
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** 当前渲染出的命中按钮，供方向键在结果间移动。 */
  const hitRefs = useRef<HTMLButtonElement[]>([]);

  const groups = state.enabled && state.sources ? searchGroups() : [];
  const total = groups.reduce((sum, group) => sum + group.count, 0);

  // 每次渲染重置命中按钮集合（展开渲染阶段填充）
  hitRefs.current = [];

  useEffect(() => {
    if (!state.open) return;
    // 打开后聚焦搜索框，允许直接输入
    inputRef.current?.focus();
  }, [state.open]);

  useEffect(() => {
    if (!state.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePanel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state.open]);

  /** 把焦点移到第 index 个命中（越界时环绕）。 */
  const focusHit = (index: number) => {
    const nodes = hitRefs.current.filter(Boolean);
    if (!nodes.length) return;
    nodes[(index + nodes.length) % nodes.length].focus();
  };

  if (!state.open) return null;

  const renderGroup = (group: SearchGroup) => (
    <Section key={group.label} title={group.label} desc={`命中 ${group.count} 项`}>
      <ul className="log-list">
        {group.hits.map((hit, index) => (
          <li key={`${hit.title}·${hit.meta}·${index}`}>
            <button
              className="log-item"
              type="button"
              title={hit.meta ? `${hit.title} · ${hit.meta}` : hit.title}
              ref={(node) => {
                if (node) hitRefs.current.push(node);
              }}
              onClick={() => hit.activate()}
              onKeyDown={(event) => {
                const dir = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                if (!dir) return;
                event.preventDefault();
                focusHit(hitRefs.current.indexOf(event.currentTarget) + dir);
              }}
            >
              <span className="log-name">{hit.title}</span>
              {hit.meta ? <span className="log-meta">{hit.meta}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );

  return (
    <Portal selector="body">
      <div
        className="modal-mask"
        id="modal-search"
        onClick={(event) => {
          if (event.target === event.currentTarget) closePanel();
        }}
      >
        <div className="modal wide">
          <header className="modal-head">
            <h2>{t("modal.search", "全局搜索")}</h2>
            <input
              className="search-input"
              id="search-input"
              type="text"
              spellCheck={false}
              placeholder="搜索连接 / 命令片段 / 命令历史 / 设置…"
              value={state.query}
              hidden={!state.enabled}
              ref={inputRef}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  focusHit(0);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  focusHit(hitRefs.current.length - 1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  hitRefs.current[0]?.click();
                }
              }}
            />
            <button className="icon-btn" onClick={closePanel}>
              ✕
            </button>
          </header>
          <div className="modal-body" id="search-body">
            {!state.enabled ? (
              <Note>全局搜索已关闭。请在「设置 → 功能开关」中打开「全局搜索」。</Note>
            ) : (
              <>
                <Notices state={state} />
                {state.query.trim() && !total ? (
                  <Note>{`没有匹配「${state.query}」的结果。`}</Note>
                ) : (
                  groups.map(renderGroup)
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}
