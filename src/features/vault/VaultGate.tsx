import { useEffect, useRef } from "react";
import { Portal } from "../../components/Portal";
import { useT } from "../../hooks/useLocale";
import {
  adoptRemote,
  keepLocal,
  pauseSecrets,
  resetVault,
  submitGate,
  useVault,
} from "./store";

/**
 * 主密码门禁：设置 / 解锁弹窗 + 主密码冲突弹窗。
 *
 * 两个弹窗都没有关闭按钮：门禁必须由用户提交或处理冲突后才能继续（与迁移前一致，
 * 遮罩点击也不关闭）。冲突弹窗优先展示。
 */
export function VaultGate() {
  const state = useVault();
  const t = useT();
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const password2Ref = useRef<HTMLInputElement | null>(null);
  const conflictRef = useRef<HTMLInputElement | null>(null);

  // 打开（或重置回到首次设置）后聚焦主密码输入框
  useEffect(() => {
    if (state.gateOpen) passwordRef.current?.focus();
  }, [state.gateOpen, state.gateKey]);

  useEffect(() => {
    if (state.conflictOpen) conflictRef.current?.focus();
  }, [state.conflictOpen, state.conflictKey]);

  const onGateEnter = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void submitGate(passwordRef.current?.value || "", password2Ref.current?.value || "");
  };

  return (
    <>
      {state.gateOpen ? (
        <Portal selector="body">
          <div className="modal-mask" id="modal-vault">
            <div className="modal narrow">
              <header className="modal-head">
                <h2 id="vault-title">
                  {state.setup
                    ? t("vault.setupTitle", "设置主密码")
                    : t("vault.unlockTitle", "解锁保险库")}
                </h2>
              </header>
              <div className="modal-body">
                <p className="desc" id="vault-desc">
                  {t(
                    "vault.desc",
                    "SSH 密码 / API Key 等敏感信息以主密码加密保存在本地，并随 Git 同步一起分发。"
                  )}
                </p>
                <div className="field">
                  <div className="field-label">
                    <span className="name">{t("vault.password", "主密码")}</span>
                  </div>
                  <div className="field-control">
                    <input
                      type="password"
                      id="vault-password"
                      autoComplete="off"
                      spellCheck={false}
                      key={state.gateKey}
                      ref={passwordRef}
                      onKeyDown={onGateEnter}
                    />
                  </div>
                </div>
                <div className="field" id="vault-confirm-field" hidden={!state.setup}>
                  <div className="field-label">
                    <span className="name">{t("vault.confirm", "确认主密码")}</span>
                  </div>
                  <div className="field-control">
                    <input
                      type="password"
                      id="vault-password2"
                      autoComplete="off"
                      spellCheck={false}
                      key={`confirm-${state.gateKey}`}
                      ref={password2Ref}
                      onKeyDown={onGateEnter}
                    />
                  </div>
                </div>
                <p className="inline-note error" id="vault-error" hidden={!state.gateError}>
                  {state.gateError}
                </p>
                <p className="inline-note" id="vault-note" hidden={!state.setup}>
                  {t(
                    "vault.warning",
                    "主密码遗失后无法恢复，只能重置保险库并重新输入所有密码。"
                  )}
                </p>
              </div>
              <footer className="modal-foot">
                <button
                  className="btn ghost"
                  id="vault-reset"
                  hidden={state.setup}
                  onClick={() => void resetVault()}
                >
                  {t("vault.reset", "忘记主密码？重置保险库")}
                </button>
                <span className="spacer" />
                <button
                  className="btn primary"
                  id="vault-submit"
                  disabled={state.gateBusy}
                  onClick={() =>
                    void submitGate(passwordRef.current?.value || "", password2Ref.current?.value || "")
                  }
                >
                  {state.setup ? t("vault.setup", "创建保险库") : t("vault.unlock", "解锁")}
                </button>
              </footer>
            </div>
          </div>
        </Portal>
      ) : null}

      {state.conflictOpen ? (
        <Portal selector="body">
          <div className="modal-mask" id="modal-vault-conflict">
            <div className="modal narrow">
              <header className="modal-head warn">
                <h2>{t("vault.conflictTitle", "主密码不一致")}</h2>
              </header>
              <div className="modal-body">
                <p className="desc">
                  Git 同步仓库中的保险库由另一套主密码加密，与本机不一致。为避免丢失数据，做出选择前不会覆盖任何一侧。
                </p>
                <div className="field">
                  <div className="field-label">
                    <span className="name">{t("vault.conflictRemoteLabel", "远端主密码")}</span>
                  </div>
                  <div className="field-control">
                    <input
                      type="password"
                      id="vault-conflict-password"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="选择「采用远端」时填写"
                      key={state.conflictKey}
                      ref={conflictRef}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        void adoptRemote(conflictRef.current?.value || "");
                      }}
                    />
                  </div>
                </div>
                <p className="inline-note error" id="vault-conflict-error" hidden={!state.conflictError}>
                  {state.conflictError}
                </p>
                <p className="inline-note">
                  「采用远端」会用远端保险库替换本机，其它设备上已有的密码即可解锁；「保留本地」会用本机密文重新覆盖远端仓库。
                </p>
              </div>
              <footer className="modal-foot">
                <button
                  className="btn ghost"
                  id="vault-conflict-pause"
                  disabled={state.conflictBusy}
                  onClick={() => void pauseSecrets()}
                >
                  暂停同步 secrets.json
                </button>
                <button
                  className="btn ghost"
                  id="vault-conflict-keep"
                  disabled={state.conflictBusy}
                  onClick={() => void keepLocal()}
                >
                  保留本地并覆盖远端
                </button>
                <span className="spacer" />
                <button
                  className="btn primary"
                  id="vault-conflict-adopt"
                  disabled={state.conflictBusy}
                  onClick={() => void adoptRemote(conflictRef.current?.value || "")}
                >
                  采用远端
                </button>
              </footer>
            </div>
          </div>
        </Portal>
      ) : null}
    </>
  );
}
