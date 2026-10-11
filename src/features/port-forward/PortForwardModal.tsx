import { useEffect } from "react";
import { Btn, Field, Note, Section } from "../../components/form";
import { Portal } from "../../components/Portal";
import { useT } from "../../hooks/useLocale";
import {
  KINDS,
  closePanel,
  kindLabel,
  setDraftField,
  start,
  stop,
  usePortForward,
  type PortForwardState,
} from "./store";
import type { RunningForward } from "./types";

/** 新建规则表单。 */
function FormSection({ state }: { state: PortForwardState }) {
  const { draft, connections } = state;

  if (!connections.length) {
    return (
      <Section title="新建规则" desc="转发需要一条独立的 SSH 连接。">
        <Note>还没有保存的连接，请先在侧栏新建连接。</Note>
      </Section>
    );
  }

  const dynamic = draft.kind === "dynamic";
  const hint = dynamic
    ? "本机监听端口可直接作为 SOCKS5 代理使用。"
    : draft.kind === "remote"
      ? "远端转发在 SSH 服务器上监听；该服务器需允许端口转发，不支持经跳板机建立。"
      : "本地转发在本机监听，连接经 SSH 送到目标。";

  return (
    <Section title="新建规则" desc={hint}>
      <Field label="连接">
        <select
          className="pf-picker"
          value={draft.connection_id || ""}
          onChange={(event) => setDraftField("connection_id", event.target.value)}
        >
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {`${c.name || c.host} · ${c.username}@${c.host}:${c.port}`}
            </option>
          ))}
        </select>
      </Field>
      <Field label="类型">
        <select
          className="pf-picker"
          value={draft.kind}
          onChange={(event) => setDraftField("kind", event.target.value as PortForwardState["draft"]["kind"])}
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="监听地址" hint="留空表示 127.0.0.1">
        <input
          type="text"
          spellCheck={false}
          className="pf-input"
          placeholder="127.0.0.1"
          value={draft.bind_host}
          onChange={(event) => setDraftField("bind_host", event.target.value)}
        />
      </Field>
      <Field label="监听端口" hint={dynamic ? "0 表示由系统分配" : "0 表示由系统或服务器分配"}>
        <input
          type="text"
          spellCheck={false}
          className="pf-input"
          placeholder="8080"
          value={draft.bind_port}
          onChange={(event) => setDraftField("bind_port", event.target.value)}
        />
      </Field>
      {dynamic ? (
        <Note>动态转发在本机提供 SOCKS5 代理，目标地址由客户端在握手时指定。</Note>
      ) : (
        <>
          <Field label="目标地址">
            <input
              type="text"
              spellCheck={false}
              className="pf-input"
              placeholder="10.0.0.5"
              value={draft.target_host}
              onChange={(event) => setDraftField("target_host", event.target.value)}
            />
          </Field>
          <Field label="目标端口">
            <input
              type="text"
              spellCheck={false}
              className="pf-input"
              placeholder="80"
              value={draft.target_port}
              onChange={(event) => setDraftField("target_port", event.target.value)}
            />
          </Field>
        </>
      )}
      <Field label="标签" hint="留空时按类型自动生成">
        <input
          type="text"
          spellCheck={false}
          className="pf-input"
          placeholder={kindLabel(draft.kind)}
          value={draft.label}
          onChange={(event) => setDraftField("label", event.target.value)}
        />
      </Field>
      {state.lastError ? <Note kind="error">{state.lastError}</Note> : null}
      <div className="pf-actions">
        <Btn kind="primary" disabled={state.busy} onClick={() => void start()}>
          启动转发
        </Btn>
      </div>
    </Section>
  );
}

/** 一条运行中的规则。 */
function ForwardItem({ info, busy }: { info: RunningForward; busy: boolean }) {
  return (
    <div className="pf-item">
      <span className="pf-label" title={info.label}>
        {info.label}
      </span>
      <span className="pf-kind">{kindLabel(info.kind)}</span>
      <span className="pf-endpoint" title={`${info.username}@${info.host}:${info.port} · ${info.created_at}`}>
        {info.endpoint}
      </span>
      <span className="pf-count">{info.connections + " 连接"}</span>
      <span className="pf-acts">
        <button className="pf-act danger" type="button" disabled={busy} onClick={() => void stop(info)}>
          停止
        </button>
      </span>
    </div>
  );
}

/** 运行中规则列表。 */
function RunningSection({ state }: { state: PortForwardState }) {
  if (!state.forwards.length) {
    return (
      <Section title="运行中">
        <Note>当前没有运行中的转发规则。</Note>
      </Section>
    );
  }
  return (
    <Section title="运行中" desc={`共 ${state.forwards.length} 条规则。`}>
      <div className="pf-head">
        <span>规则</span>
        <span>类型</span>
        <span>转发路径</span>
        <span>累计</span>
        <span>操作</span>
      </div>
      <div className="pf-list">
        {state.forwards.map((info) => (
          <ForwardItem key={info.id} info={info} busy={state.busy} />
        ))}
      </div>
    </Section>
  );
}

/** 端口转发面板（features.connection.port_forward 打开时可用）。 */
export function PortForwardModal() {
  const state = usePortForward();
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
        id="modal-port-forward"
        onClick={(event) => {
          if (event.target === event.currentTarget) closePanel();
        }}
      >
        <div className="modal wide">
          <header className="modal-head">
            <h2>{t("modal.portForward", "端口转发")}</h2>
            <button className="icon-btn" onClick={closePanel}>
              ✕
            </button>
          </header>
          <div className="modal-body" id="pf-body">
            {!state.enabled ? (
              <Note>端口转发已关闭。请在「设置 → 功能开关」中打开「端口转发」。</Note>
            ) : (
              <>
                <FormSection state={state} />
                <RunningSection state={state} />
              </>
            )}
          </div>
          <footer className="modal-foot">
            <span className="muted" id="pf-hint">
              {state.enabled ? `运行中 ${state.forwards.length} 条` : ""}
            </span>
            <span className="spacer" />
            <Btn onClick={closePanel}>{t("common.close", "关闭")}</Btn>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
