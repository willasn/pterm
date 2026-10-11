import { useEffect } from "react";
import { Btn, Field, Note, Section } from "../../components/form";
import { Portal } from "../../components/Portal";
import { useT } from "../../hooks/useLocale";
import {
  HISTORY_LIMIT,
  clearAll,
  closePanel,
  insertEntry,
  insertTitle,
  refresh,
  setDedupe,
  setOrder,
  setQuery,
  shortTime,
  useHistory,
  type HistoryState,
} from "./store";
import type { HistoryOrder } from "./types";

/** 筛选控件：子串过滤 + 去重 + 排序 + 刷新 / 清空。 */
function Controls({ state }: { state: HistoryState }) {
  return (
    <Section title="">
      <Field label={`最多显示最近 ${HISTORY_LIMIT} 条`}>
        <input
          type="text"
          spellCheck={false}
          placeholder="按命令子串过滤…"
          value={state.query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </Field>
      <div className="toggle-row">
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={state.dedupe}
            onChange={(event) => setDedupe(event.target.checked)}
          />
          <span>去重（按命令合并）</span>
        </label>
        <span className="muted">排序</span>
        <select
          value={state.order}
          // 非去重模式下每条记录只出现一次，频率排序没有意义
          disabled={!state.dedupe}
          onChange={(event) => setOrder(event.target.value as HistoryOrder)}
        >
          <option value="recent">最近使用</option>
          <option value="frequent">最常用</option>
        </select>
      </div>
      {state.lastError ? <Note kind="error">{state.lastError}</Note> : null}
      <div className="log-actions">
        <Btn disabled={state.busy} onClick={() => void refresh()}>
          刷新
        </Btn>
        <Btn kind="danger" disabled={state.busy} onClick={() => void clearAll()}>
          清空历史
        </Btn>
      </div>
    </Section>
  );
}

/** 命令列表：空态文案随是否有搜索词变化。 */
function ListSection({ state }: { state: HistoryState }) {
  if (!state.entries.length) {
    return (
      <Section title="命令">
        <Note>
          {state.query
            ? `没有匹配「${state.query}」的历史命令。`
            : "还没有历史命令。连接主机并执行命令后会自动记录。"}
        </Note>
      </Section>
    );
  }

  const title = insertTitle();
  return (
    <Section
      title="命令"
      desc={state.query ? `匹配「${state.query}」的 ${state.entries.length} 条` : `共 ${state.entries.length} 条`}
    >
      <ul className="log-list">
        {state.entries.map((entry, index) => {
          const meta: string[] = [];
          if (entry.uses > 1) meta.push(`×${entry.uses}`);
          if (entry.host) meta.push(entry.host);
          meta.push(shortTime(entry.executed_at));
          return (
            <li key={`${entry.command}·${entry.executed_at}·${index}`}>
              <button
                className="log-item"
                type="button"
                title={title}
                onClick={() => void insertEntry(entry)}
              >
                <span className="log-name">{entry.command}</span>
                <span className="log-meta">{meta.join(" · ")}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <Note>点击命令写入当前会话的输入行，不追加回车；请确认后自行按回车执行。</Note>
    </Section>
  );
}

/** 命令历史面板（features.auxiliary.command_history 打开时可用）。 */
export function HistoryModal() {
  const state = useHistory();
  const t = useT();

  useEffect(() => {
    if (!state.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePanel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state.open]);

  if (!state.open) return null;

  return (
    <Portal selector="body">
      <div
        className="modal-mask"
        id="modal-history"
        onClick={(event) => {
          if (event.target === event.currentTarget) closePanel();
        }}
      >
        <div className="modal wide">
          <header className="modal-head">
            <h2>{t("modal.history", "命令历史")}</h2>
            <button className="icon-btn" onClick={closePanel}>
              ✕
            </button>
          </header>
          <div className="modal-body" id="hist-body">
            {!state.enabled ? (
              <Note>命令历史已关闭。请在「设置 → 功能开关」中打开「命令历史」。</Note>
            ) : (
              <>
                <Controls state={state} />
                <div>
                  <ListSection state={state} />
                </div>
              </>
            )}
          </div>
          <footer className="modal-foot">
            <span className="muted" id="hist-hint">
              {state.enabled ? `已记录 ${state.entries.length} 条` : ""}
            </span>
            <span className="spacer" />
            <Btn onClick={closePanel}>{t("common.close", "关闭")}</Btn>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
