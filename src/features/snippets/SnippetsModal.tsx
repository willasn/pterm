import { Fragment, useEffect, type ReactNode } from "react";
import { Btn, Field, Note, Section } from "../../components/form";
import { Portal } from "../../components/Portal";
import { useT } from "../../hooks/useLocale";
import { active } from "../terminal/api";
import {
  backToList,
  closePanel,
  filteredSnippets,
  groupNames,
  insert,
  remove,
  save,
  selectSnippet,
  setDraftField,
  setQuery,
  setValue,
  startNew,
  useSnippets,
  type SnippetsState,
} from "./store";

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/** 片段库：分组列表 + 新建 / 关闭。 */
function ListView({ state }: { state: SnippetsState }) {
  const list = filteredSnippets();

  let body: ReactNode;
  if (!state.snippets.length) {
    body = <Note>还没有保存任何片段。点击「新建片段」开始。</Note>;
  } else if (!list.length) {
    body = <Note>没有匹配的片段。</Note>;
  } else {
    body = (
      <ul className="log-list">
        {groupNames(list).map((group) => (
          <Fragment key={group || "__ungrouped"}>
            <li className="snip-group">{group || "未分组"}</li>
            {list
              .filter((snippet) => (snippet.group_name || "") === group)
              .map((snippet) => {
                const count = (snippet.variables || []).length;
                return (
                  <li key={snippet.id}>
                    <button
                      className={"log-item snip-item" + (snippet.id === state.selectedId ? " current" : "")}
                      type="button"
                      title={snippet.description || snippet.content}
                      onClick={() => selectSnippet(snippet.id)}
                    >
                      <span className="log-name">{snippet.name || "未命名片段"}</span>
                      <span className="log-meta">{count ? `${count} 个变量` : "无变量"}</span>
                    </button>
                  </li>
                );
              })}
          </Fragment>
        ))}
      </ul>
    );
  }

  return (
    <div className="settings-section">
      <div id="snip-list">{body}</div>
      <div className="log-actions">
        <Btn kind="primary" disabled={state.busy} onClick={startNew}>
          新建片段
        </Btn>
        <Btn disabled={state.busy} onClick={closePanel}>
          关闭
        </Btn>
      </div>
    </div>
  );
}

/** 插入到终端：变量取值 + 预览 + 插入。 */
function InsertSection({ state, draft }: { state: SnippetsState; draft: SnippetsState["draft"] }) {
  if (!draft || !draft.id) {
    return (
      <Section title="插入到终端">
        <Note>先保存片段，才能插入到终端。</Note>
      </Section>
    );
  }

  const ctrl = active();
  const vars = draft.variables || [];
  const text = state.preview || draft.content;
  const risky = String(text).indexOf("\n") >= 0;
  const sessionLabel = (ctrl && (ctrl.info?.name || ctrl.info?.host || String(ctrl.id || "").slice(0, 8))) || "";

  return (
    <Section title="插入到终端" desc={ctrl ? `目标会话：${sessionLabel}` : null}>
      {!ctrl ? <Note>当前没有打开的会话，请先连接一个主机。</Note> : null}
      {!vars.length ? (
        <Note>该片段没有变量，可直接插入。</Note>
      ) : (
        vars.map((name) => (
          <Field key={name} label={name}>
            <input
              type="text"
              spellCheck={false}
              placeholder={"{{" + name + "}}"}
              value={state.values[name] == null ? "" : state.values[name]}
              onChange={(event) => setValue(name, event.target.value)}
            />
          </Field>
        ))
      )}
      <pre className="log-preview" id="snip-preview">
        {text}
      </pre>
      {risky ? <Note kind="warn">内容含换行，送入终端后会逐行执行，请确认后再插入。</Note> : null}
      <div className="log-actions">
        <Btn kind="primary" disabled={state.busy} onClick={() => void insert()}>
          插入到终端
        </Btn>
      </div>
      <Note>只写入终端输入行，不追加回车；请确认后自行按回车执行。</Note>
    </Section>
  );
}

/** 编辑视图：返回条 + 编辑器 + 插入区。 */
function EditView({ state, draft }: { state: SnippetsState; draft: SnippetsState["draft"] }) {
  if (!draft) return <ListView state={state} />;
  const vars = draft.variables || [];

  return (
    <div>
      <div className="log-actions snip-back">
        <Btn disabled={state.busy} onClick={backToList}>
          ← 返回片段库
        </Btn>
        <span className="muted">{draft.id ? "编辑已有片段" : "未保存的新片段"}</span>
      </div>

      <Section
        title={draft.id ? "编辑片段" : "新建片段"}
        desc={draft.id ? null : "填写内容后点击「保存为新片段」。"}
      >
        <Field label="名称">
          <input
            type="text"
            spellCheck={false}
            placeholder="留空则取内容首行"
            value={draft.name}
            onChange={(event) => setDraftField("name", event.target.value)}
          />
        </Field>
        <Field label="分组">
          <input
            type="text"
            spellCheck={false}
            placeholder="可选，用于归类"
            value={draft.group_name || ""}
            onChange={(event) => setDraftField("group_name", event.target.value)}
          />
        </Field>
        <Field label="说明">
          <input
            type="text"
            spellCheck={false}
            placeholder="可选，说明用途"
            value={draft.description}
            onChange={(event) => setDraftField("description", event.target.value)}
          />
        </Field>
        <Field label="内容">
          <textarea
            rows={6}
            spellCheck={false}
            placeholder="例如：tail -n {{lines}} -f {{path}}"
            value={draft.content}
            onChange={(event) => setDraftField("content", event.target.value)}
          />
        </Field>
        {vars.length ? (
          <Note>已识别变量：{vars.map((v) => "{{" + v + "}}").join("、")}</Note>
        ) : (
          <Note>尚未识别到变量。保存后会自动提取 {"{{name}}"} 形式的占位符。</Note>
        )}
        <div className="log-actions">
          <Btn kind="primary" disabled={state.busy} onClick={() => void save()}>
            {draft.id ? "保存修改" : "保存为新片段"}
          </Btn>
          {draft.id ? (
            <Btn kind="danger" disabled={state.busy} onClick={() => void remove()}>
              删除
            </Btn>
          ) : null}
        </div>
        {state.lastError ? <Note kind="error">{state.lastError}</Note> : null}
      </Section>

      <InsertSection state={state} draft={draft} />
    </div>
  );
}

/** 命令片段面板（features.auxiliary.snippets 打开时可用）。 */
export function SnippetsModal() {
  const state = useSnippets();
  const t = useT();
  const open = state.open;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePanel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return (
    <Portal selector="body">
      <div
        className="modal-mask"
        id="modal-snippets"
        onClick={(event) => {
          if (event.target === event.currentTarget) closePanel();
        }}
      >
        <div className="modal wide">
          <header className="modal-head">
            <h2>{t("modal.snippets", "命令片段")}</h2>
            <span id="snip-count" className="muted snip-count">
              {state.enabled ? `共 ${state.snippets.length} 个片段` : ""}
            </span>
            {state.view === "list" ? (
              <label className="snip-search-wrap" id="snip-search-wrap">
                <svg
                  viewBox="0 0 24 24"
                  width="14"
                  height="14"
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
                <input
                  id="snip-search"
                  type="text"
                  spellCheck={false}
                  placeholder="筛选片段…"
                  aria-label="筛选片段"
                  value={state.query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setQuery("");
                  }}
                />
              </label>
            ) : null}
            <button className="icon-btn" onClick={closePanel}>
              ✕
            </button>
          </header>
          <div className="modal-body" id="snip-body">
            {!state.enabled ? (
              <Note>命令片段已关闭。请在「设置 → 功能开关」中打开「命令片段」。</Note>
            ) : state.view === "edit" ? (
              <EditView state={state} draft={state.draft} />
            ) : (
              <ListView state={state} />
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}
