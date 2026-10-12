import { useEffect } from "react";
import { Btn, Field, Note, Section } from "../../components/form";
import { Portal } from "../../components/Portal";
import { useT } from "../../hooks/useLocale";
import {
  closePanel,
  resolveConflicts,
  startSync,
  useGitSync,
  type GitSyncState,
} from "./store";

/** 已同步的细节行。 */
function Details({ state }: { state: GitSyncState }) {
  const status = state.status!;
  const nodes = [];
  if (status.last_sync_at) {
    nodes.push(
      <Field label="上次同步" key="last_sync_at">
        <span className="muted">{status.last_sync_at}</span>
      </Field>
    );
  }
  if (status.last_result) {
    nodes.push(
      <Field label="上次结果" key="last_result">
        <span className="muted">{status.last_result}</span>
      </Field>
    );
  }
  if (status.last_error) {
    nodes.push(
      <Field label="上次错误" key="last_error">
        <span className="inline-note error">{status.last_error}</span>
      </Field>
    );
  }
  return nodes.length ? <div>{nodes}</div> : null;
}

/** Git 同步面板（features.sync.git_sync 打开时可用）。 */
export function GitSyncModal() {
  const state = useGitSync();
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

  const remotes = (state.status && state.status.remotes) || [];

  return (
    <Portal selector="body">
      <div
        className="modal-mask"
        id="modal-git"
        onClick={(event) => {
          if (event.target === event.currentTarget) closePanel();
        }}
      >
        <div className="modal wide">
          <header className="modal-head">
            <h2>{t("modal.git", "Git 同步")}</h2>
            <button className="icon-btn" onClick={closePanel}>
              ✕
            </button>
          </header>
          <div className="modal-body" id="git-body">
            {!state.enabled ? (
              <Note>Git 同步已关闭。请在「设置 → 功能开关」中打开「Git 同步」。</Note>
            ) : !state.status ? (
              <Note>正在读取同步状态…</Note>
            ) : state.pendingConflicts ? (
              <Section
                title="需要确认的冲突"
                desc="同一份连接或命令片段在两处都被修改过，选择如何保留。"
              >
                <div className="git-actions">
                  <Btn kind="primary" disabled={state.busy} onClick={() => void resolveConflicts()}>
                    {state.busy ? "处理中…" : "处理冲突"}
                  </Btn>
                </div>
              </Section>
            ) : (
              <>
                <Section
                  title="同步"
                  desc="把你的设置、连接与命令片段同步到 Git 仓库，并在多台设备间保持一致。"
                >
                  <div className="git-actions">
                    <Btn kind="primary" disabled={state.busy} onClick={() => void startSync()}>
                      {state.busy ? "同步中…" : "同步"}
                    </Btn>
                  </div>
                  <Details state={state} />
                </Section>
                {!remotes.length ? (
                  <Note>
                    尚未配置远程仓库，同步只会在本机留痕。请到「设置 → Git 同步」填写远程地址。
                  </Note>
                ) : null}
              </>
            )}
          </div>
          <footer className="modal-foot">
            <span className="muted" id="git-hint">
              {state.busy ? "同步中…" : ""}
            </span>
            <span className="spacer" />
            <Btn onClick={closePanel}>{t("common.close", "关闭")}</Btn>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
