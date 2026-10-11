import { useEffect, type ReactNode } from "react";
import { Btn, Field, Section } from "../../components/form";
import { Portal } from "../../components/Portal";
import { useT } from "../../hooks/useLocale";
import { errorText, pt, toast } from "../../lib/legacy";
import {
  AUTH_KINDS,
  PROTOCOLS,
  clearSecret,
  closeForm,
  connectionFlags,
  currentIsNew,
  getDraft,
  getDraftValue,
  remove,
  rerenderForm,
  save,
  setDraftValue,
  setJumpEnabled,
  setProtocol,
  setSecret,
  test,
  useConnections,
} from "./store";

/** 非受控文本输入：直接写回草稿，不触发重绘（避免打断输入）。 */
function TextField({
  label,
  hint,
  path,
  placeholder,
}: {
  label: string;
  hint?: string | null;
  path: string;
  placeholder?: string;
}) {
  const current = getDraftValue(path);
  return (
    <Field label={label} hint={hint} compact>
      <input
        type="text"
        placeholder={placeholder}
        defaultValue={current == null ? "" : String(current)}
        onChange={(event) => setDraftValue(path, event.target.value)}
      />
    </Field>
  );
}

/** 非受控数值输入：解析失败回退到 fallback。 */
function PortField({ label, path, fallback, target }: { label: string; path: string; fallback: number; target: any }) {
  const current = getDraftValue(path) ?? target[path];
  return (
    <Field label={label} compact>
      <input
        type="number"
        min={1}
        max={65535}
        defaultValue={current == null ? "" : String(current)}
        onChange={(event) => {
          const n = parseInt(event.target.value, 10);
          setDraftValue(path, Number.isFinite(n) ? n : fallback);
        }}
      />
    </Field>
  );
}

/** 密码 / 口令字段：空串表示不修改，「清除」提交空串表示删除。 */
function SecretField({
  label,
  hint,
  placeholder,
  secretKey,
  showClear,
  onInput,
  onClear,
}: {
  label: string;
  hint: string;
  placeholder: string;
  secretKey: number;
  showClear: boolean;
  onInput: (value: string) => void;
  onClear: () => void;
}) {
  return (
    <Field label={label} hint={hint} compact>
      <div className="input-row">
        <input
          type="password"
          key={secretKey}
          placeholder={placeholder}
          onChange={(event) => onInput(event.target.value)}
        />
        {showClear ? (
          <button className="btn ghost" type="button" onClick={onClear}>
            清除
          </button>
        ) : null}
      </div>
    </Field>
  );
}

/** 私钥路径：文本 + 原生文件选择。 */
function KeyPathField() {
  const dialog = (window as any).__TAURI__?.dialog;
  return (
    <Field label="私钥路径" hint="支持 ~ 开头的路径" compact>
      <div className="input-row">
        <input
          type="text"
          placeholder="~/.ssh/id_ed25519"
          defaultValue={getDraftValue("key_path") == null ? "" : String(getDraftValue("key_path"))}
          onChange={(event) => setDraftValue("key_path", event.target.value)}
        />
        {dialog && typeof dialog.open === "function" ? (
          <button
            className="btn ghost"
            type="button"
            onClick={async () => {
              try {
                const picked = await dialog.open({ multiple: false, directory: false, title: "选择私钥文件" });
                if (typeof picked === "string" && picked) {
                  setDraftValue("key_path", picked);
                  rerenderForm();
                }
              } catch (err) {
                toast(errorText(err), "error");
              }
            }}
          >
            浏览…
          </button>
        ) : null}
      </div>
    </Field>
  );
}

/** 认证方式下拉：切换后重建表单，以便显示 / 隐藏专属字段。 */
function AuthSelect({ label, target, path, rerender }: { label: string; target: any; path: string; rerender: () => void }) {
  const current = target[path] == null ? "" : String(target[path]);
  return (
    <Field label={label} compact>
      <select
        defaultValue={current}
        onChange={(event) => {
          setDraftValue(path, event.target.value);
          rerender();
        }}
      >
        {AUTH_KINDS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function ConnectionForm() {
  const state = useConnections();
  const t = useT();
  const draft = getDraft();

  useEffect(() => {
    if (!state.formOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeForm();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state.formOpen]);

  if (!state.formOpen || !draft) return null;

  const flags = connectionFlags();
  const rdp = draft.protocol === "rdp";
  const isNew = currentIsNew();

  const passwordPlaceholder =
    state.secrets.password === ""
      ? "保存后将删除已存密码"
      : draft.has_password
        ? "已保存在保险库，留空则不修改"
        : "尚未保存";
  const passphrasePlaceholder =
    state.secrets.passphrase === ""
      ? "保存后将删除已存口令"
      : draft.has_passphrase
        ? "已保存在保险库，留空则不修改"
        : "私钥无口令可留空";

  const basics: ReactNode[] = [];
  if (flags.rdp || rdp) {
    basics.push(
      <Field key="protocol" label="协议" hint="SSH 终端或 Windows 远程桌面（RDP）" compact>
        <select defaultValue={draft.protocol} onChange={(event) => setProtocol(event.target.value)}>
          {PROTOCOLS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  basics.push(
    <TextField key="name" label="名称" path="name" placeholder="例如 生产环境" />,
    <TextField key="host" label="主机" path="host" placeholder="域名或 IP，例如 10.0.0.1" />,
    <PortField key="port" label="端口" path="port" fallback={rdp ? 3389 : 22} target={draft} />,
    <TextField
      key="username"
      label="用户名"
      path="username"
      placeholder={rdp ? "域账号用户名（可留空）" : "root"}
    />
  );
  if (rdp) {
    basics.push(
      <TextField key="domain" label="域" hint="Windows 域账号填写，留空使用本机账号" path="domain" placeholder="例如 CORP" />
    );
  }

  return (
    <Portal selector="body">
      <div
        className="modal-mask"
        id="modal-connection"
        onClick={(event) => {
          if (event.target === event.currentTarget) closeForm();
        }}
      >
        <div className="modal">
          <header className="modal-head">
            <h2 id="conn-modal-title">
              {isNew ? t("modal.connection", "新建连接") : t("modal.connectionEdit", "编辑连接")}
            </h2>
            <button className="icon-btn" onClick={closeForm}>
              ✕
            </button>
          </header>
          <div className="modal-body" id="conn-form" key={state.formKey}>
            <Section title="基础">{basics}</Section>

            {rdp ? (
              <Section
                title="凭据"
                desc="密码保存在加密保险库中，不写入配置文件。Windows 写入系统凭据管理器交给 mstsc 免密登录；macOS 由「Windows App」自行管理凭据，这里的密码供「复制密码」使用。"
              >
                <SecretField
                  label="密码"
                  hint="仅写入加密保险库"
                  placeholder={passwordPlaceholder}
                  secretKey={state.secretKey}
                  showClear={draft.has_password && state.secrets.password === null}
                  onInput={(v) => setSecret("password", v)}
                  onClear={() => clearSecret("password")}
                />
              </Section>
            ) : (
              <Section title="认证" desc="密码与 passphrase 保存在加密保险库中，不写入配置文件。">
                <AuthSelect label="认证方式" target={draft} path="auth_kind" rerender={rerenderForm} />
                {draft.auth_kind === "private_key" ? <KeyPathField /> : null}
                {draft.auth_kind === "password" ? (
                  <SecretField
                    label="密码"
                    hint="仅写入加密保险库"
                    placeholder={passwordPlaceholder}
                    secretKey={state.secretKey}
                    showClear={draft.has_password && state.secrets.password === null}
                    onInput={(v) => setSecret("password", v)}
                    onClear={() => clearSecret("password")}
                  />
                ) : null}
                {draft.auth_kind === "private_key" ? (
                  <SecretField
                    label="私钥口令"
                    hint="仅写入加密保险库"
                    placeholder={passphrasePlaceholder}
                    secretKey={state.secretKey}
                    showClear={draft.has_passphrase && state.secrets.passphrase === null}
                    onInput={(v) => setSecret("passphrase", v)}
                    onClear={() => clearSecret("passphrase")}
                  />
                ) : null}
              </Section>
            )}

            {flags.connection_group ? (
              <Section title="分组">
                <TextField label="分组名" path="group_name" placeholder="留空将归入「未分组」" />
              </Section>
            ) : null}

            {!rdp && flags.jump_host ? <JumpSection draft={draft} secretKey={state.secretKey} /> : null}
          </div>
          <footer className="modal-foot">
            <button className="btn danger" id="conn-delete" hidden={isNew} onClick={() => void remove()}>
              {t("common.delete", "删除")}
            </button>
            <span className="spacer" />
            <button className="btn ghost" id="conn-test" disabled={state.testing} onClick={() => void test()}>
              {state.testing ? "测试中…" : t("common.test", "测试连接")}
            </button>
            <button className="btn ghost" onClick={closeForm}>
              {t("common.cancel", "取消")}
            </button>
            <button className="btn primary" id="conn-save" onClick={() => void save()}>
              {t("common.save", "保存")}
            </button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

/** 跳板机分组（仅 SSH 且开关打开时出现）。 */
function JumpSection({ draft, secretKey }: { draft: any; secretKey: number }) {
  const enabled = !!draft.jump;
  const jump = draft.jump;
  return (
    <Section title="跳板机">
      <Field label="启用跳板机" compact>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setJumpEnabled(event.target.checked)}
          />
        </label>
      </Field>
      {enabled ? (
        <>
          <Field label="跳板机主机" compact>
            <input
              type="text"
              defaultValue={jump.host || ""}
              onChange={(event) => setDraftValue("jump.host", event.target.value)}
            />
          </Field>
          <Field label="跳板机端口" compact>
            <input
              type="number"
              min={1}
              max={65535}
              defaultValue={jump.port == null ? "" : String(jump.port)}
              onChange={(event) => {
                const n = parseInt(event.target.value, 10);
                setDraftValue("jump.port", Number.isFinite(n) ? n : 22);
              }}
            />
          </Field>
          <Field label="跳板机用户" compact>
            <input
              type="text"
              defaultValue={jump.username || ""}
              onChange={(event) => setDraftValue("jump.username", event.target.value)}
            />
          </Field>
          <AuthSelect label="跳板机认证" target={jump} path="auth_kind" rerender={rerenderForm} />
          {jump.auth_kind === "private_key" ? (
            <Field label="跳板机私钥" hint="留空则使用默认私钥" compact>
              <input
                type="text"
                defaultValue={jump.key_path || ""}
                onChange={(event) => setDraftValue("jump.key_path", event.target.value)}
              />
            </Field>
          ) : null}
          {jump.auth_kind === "password" ? (
            <Field label="跳板机密码" hint="仅写入加密保险库" compact>
              <input
                type="password"
                key={secretKey}
                placeholder="留空则不修改已保存的密码"
                onChange={(event) => setSecret("jump_password", event.target.value)}
              />
            </Field>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}
