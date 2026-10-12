import { useEffect } from "react";
import { Btn, Field, Note, Section } from "../../components/form";
import { Portal } from "../../components/Portal";
import { useT } from "../../hooks/useLocale";
import {
  clearAll,
  clearPreview,
  closePanel,
  humanSize,
  refresh,
  selectLog,
  useSessionLog,
  type SessionLogState,
} from "./store";
import type { SessionLogStatus } from "./types";

/** 状态区：目录、保留天数 / 条数、单文件上限、文件数、记录中的会话。 */
function StateSection({ status }: { status: SessionLogStatus }) {
  return (
    <Section title="状态">
      <Field label="日志目录">
        <span className="muted">{status.dir}</span>
      </Field>
      <Field label="保留天数">
        <span className="muted">{status.retention_days ? `${status.retention_days} 天` : "不按天数清理"}</span>
      </Field>
      <Field label="保留条数">
        <span className="muted">{status.retention_count ? `${status.retention_count} 条` : "不按条数清理"}</span>
      </Field>
      <Field label="单文件大小上限">
        <span className="muted">{status.max_file_kb ? `${status.max_file_kb} KB` : "不限"}</span>
      </Field>
      <Field label="文件数">
        <span className="muted">{`${status.count} 个`}</span>
      </Field>
      <Field label="记录中的会话">
        <span className="muted">{status.active ? `${status.active} 个` : "无"}</span>
      </Field>
      <Note>日志包含终端全部输出，可能含敏感内容，请按需清理。</Note>
    </Section>
  );
}

/** 文件列表：点击文件名查看该单个文件的尾部内容。 */
function FilesSection({ state }: { state: SessionLogState }) {
  return (
    <Section
      title="日志文件"
      desc={
        state.entries.length
          ? "点击文件名查看该文件的末尾内容（仅单个文件，最多截取末尾 10 KB，不代表全部日志总量）。"
          : null
      }
    >
      {!state.entries.length ? (
        <Note>还没有日志文件。打开一个 SSH 会话后会自动开始记录。</Note>
      ) : (
        <ul className="log-list">
          {state.entries.map((entry, index) => (
            <li key={`${entry.name}·${index}`}>
              <button
                className={"log-item" + (entry.name === state.selected ? " current" : "")}
                type="button"
                title={entry.modified}
                onClick={() => void selectLog(entry.name)}
              >
                <span className="log-name">{entry.name}</span>
                <span className="log-meta">
                  {(entry.active ? "记录中 · " : "") + humanSize(entry.size)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="log-actions">
        <Btn disabled={state.busy} onClick={() => void refresh()}>
          刷新
        </Btn>
        <Btn kind="danger" disabled={state.busy} onClick={() => void clearAll()}>
          清空全部
        </Btn>
      </div>
    </Section>
  );
}

/** 预览区：展示所选文件尾部内容。 */
function PreviewSection({ state }: { state: SessionLogState }) {
  return (
    <Section title="预览" desc={state.selected ? "文件：" + state.selected : null}>
      {state.preview == null ? (
        <Note>尚未选择日志文件。</Note>
      ) : (
        <>
          <pre className="log-preview">{state.preview || "（该文件为空）"}</pre>
          <div className="log-actions">
            <Btn disabled={state.busy} onClick={clearPreview}>
              关闭预览
            </Btn>
          </div>
        </>
      )}
    </Section>
  );
}

/** 会话日志面板（features.connection.session_log 打开时可用）。 */
export function SessionLogModal() {
  const state = useSessionLog();
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
        id="modal-session-log"
        onClick={(event) => {
          if (event.target === event.currentTarget) closePanel();
        }}
      >
        <div className="modal wide">
          <header className="modal-head">
            <h2>{t("modal.sessionLog", "会话日志")}</h2>
            <button className="icon-btn" onClick={closePanel}>
              ✕
            </button>
          </header>
          <div className="modal-body" id="log-body">
            {!state.enabled ? (
              <Note>会话日志已关闭。请在「设置 → 功能开关」中打开「会话日志」。</Note>
            ) : !state.status ? (
              <Note>正在读取日志状态…</Note>
            ) : (
              <>
                <StateSection status={state.status} />
                <FilesSection state={state} />
                <PreviewSection state={state} />
              </>
            )}
          </div>
          <footer className="modal-foot">
            <span className="muted" id="log-hint">
              {state.status ? "目录：" + state.status.dir : ""}
            </span>
            <span className="spacer" />
            <Btn onClick={closePanel}>{t("common.close", "关闭")}</Btn>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
