import { useEffect, useRef } from "react";
import { Btn, Field, Note } from "../../components/form";
import { Portal } from "../../components/Portal";
import { useT } from "../../hooks/useLocale";
import {
  closePanel,
  filteredActions,
  runAction,
  setQuery,
  useQuickPanel,
} from "./store";
import type { QuickAction } from "./types";

/** 快捷命令面板（features.auxiliary.quick_panel 打开时可用，由快捷键唤起）。 */
export function QuickPanelModal() {
  const state = useQuickPanel();
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** 当前渲染出的命中按钮，供方向键在结果间移动。 */
  const hitRefs = useRef<HTMLButtonElement[]>([]);

  const matched = state.enabled ? filteredActions() : [];

  // 每次渲染重置命中按钮集合（展开渲染阶段填充）
  hitRefs.current = [];

  useEffect(() => {
    if (!state.open) return;
    // 打开后聚焦输入框，允许直接输入
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

  const metaOf = (item: QuickAction) =>
    [item.hint, item.keys ? `快捷键 ${item.keys}` : null].filter(Boolean).join(" · ");

  return (
    <Portal selector="body">
      <div
        className="modal-mask"
        id="modal-quick-panel"
        onClick={(event) => {
          if (event.target === event.currentTarget) closePanel();
        }}
      >
        <div className="modal narrow">
          <header className="modal-head">
            <h2>{t("modal.quickPanel", "快捷面板")}</h2>
            <button className="icon-btn" onClick={closePanel}>
              ✕
            </button>
          </header>
          <div className="modal-body" id="quick-panel-body">
            <Field label="命令" hint="回车执行第一条，↑↓ 在结果间移动">
              <input
                type="text"
                spellCheck={false}
                placeholder="输入命令名称过滤，回车执行第一条…"
                value={state.query}
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
            </Field>
            <div>
              {!state.enabled ? (
                <Note>快捷面板已关闭。请在「设置 → 功能开关」中打开「快捷面板」。</Note>
              ) : !matched.length ? (
                <Note>{`没有匹配「${state.query}」的动作。`}</Note>
              ) : (
                <ul className="log-list">
                  {matched.map((item, index) => {
                    const meta = metaOf(item);
                    return (
                      <li key={`${item.id}·${index}`}>
                        <button
                          className="log-item"
                          type="button"
                          title={meta ? `${item.label} · ${meta}` : item.label}
                          ref={(node) => {
                            if (node) hitRefs.current.push(node);
                          }}
                          onClick={() => {
                            closePanel();
                            runAction(item.id);
                          }}
                          onKeyDown={(event) => {
                            const dir =
                              event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                            if (!dir) return;
                            event.preventDefault();
                            focusHit(hitRefs.current.indexOf(event.currentTarget) + dir);
                          }}
                        >
                          <span className="log-name">{item.label}</span>
                          {meta ? <span className="log-meta">{meta}</span> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
          <footer className="modal-foot">
            <span className="muted" id="quick-panel-hint">
              {state.enabled ? `${state.items.length} 个动作` : ""}
            </span>
            <span className="spacer" />
            <Btn onClick={closePanel}>{t("common.close", "关闭")}</Btn>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
