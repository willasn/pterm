/* 主密码保险库（核心，不随模块开关）。
 *
 * 敏感字段（SSH 密码 / passphrase / 跳板机密码、AI API Key、Git 远端密码）由后端
 * 以主密码加密保存在配置目录的 secrets.json；派生密钥另存同目录的 vault.token 用于自动解锁。
 *
 * 本文件是「门禁」：新装首次打开时弹出弹窗要求设置主密码，之后启动由后端用本地令牌
 * 静默解锁、不再弹窗；仅在保险库被锁定或缺失时才要求输入。Git 同步导入的保险库若
 * 与本机主密码不一致，后端会广播 `git:vault-conflict`，这里弹出冲突处理弹窗。 */
(function (PShell) {
  "use strict";

  const { $, errorText } = PShell.util;
  const t = PShell.i18n.t;

  const MASK = "modal-vault";
  const PASSWORD = "vault-password";
  const PASSWORD2 = "vault-password2";
  const CONFLICT_MASK = "modal-vault-conflict";

  /** 待解锁时挂起的 resolve，用于让 boot 流程等待用户输入。 */
  let pending = null;
  /** 主密码冲突弹窗待决策的 resolve。 */
  let conflictPending = null;
  /** 是否处于「首次设置」模式（需要两次输入）。 */
  let setupMode = false;
  /** 防止重复绑定。 */
  let bound = false;

  function showError(message) {
    const node = $("vault-error");
    if (!node) return;
    node.textContent = message || "";
    node.hidden = !message;
  }

  /** 按模式渲染文案，并重置输入框。 */
  function render() {
    const title = $("vault-title");
    const submit = $("vault-submit");
    const confirmField = $("vault-confirm-field");
    const note = $("vault-note");
    const reset = $("vault-reset");

    if (setupMode) {
      if (title) title.textContent = t("vault.setupTitle", "设置主密码");
      if (submit) submit.textContent = t("vault.setup", "创建保险库");
    } else {
      if (title) title.textContent = t("vault.unlockTitle", "解锁保险库");
      if (submit) submit.textContent = t("vault.unlock", "解锁");
    }
    if (confirmField) confirmField.hidden = !setupMode;
    // 「忘记主密码」在首次设置时没有意义
    if (reset) reset.hidden = setupMode;
    if (note) note.hidden = !setupMode;

    showError("");
    [PASSWORD, PASSWORD2].forEach((id) => {
      const node = $(id);
      if (node) node.value = "";
    });
  }

  function open(isSetup) {
    setupMode = !!isSetup;
    const mask = $(MASK);
    if (!mask) return Promise.resolve();
    render();
    mask.hidden = false;
    const input = $(PASSWORD);
    if (input) input.focus();
    return new Promise((resolve) => {
      pending = resolve;
    });
  }

  function close() {
    const mask = $(MASK);
    if (mask) mask.hidden = true;
    const resolve = pending;
    pending = null;
    if (resolve) resolve();
  }

  /** 读取两个输入框：返回 [主密码, 错误文案]。 */
  function readPasswords() {
    const password = ($(PASSWORD) || {}).value || "";
    if (!password) return [null, t("vault.empty", "请输入主密码")];
    if (setupMode) {
      const again = ($(PASSWORD2) || {}).value || "";
      if (password !== again) return [null, t("vault.mismatch", "两次输入的主密码不一致")];
    }
    return [password, null];
  }

  async function submit() {
    const [password, message] = readPasswords();
    if (message) {
      showError(message);
      return;
    }
    const button = $("vault-submit");
    if (button) button.disabled = true;
    try {
      if (setupMode) await PShell.ipc.vaultSetup(password);
      else await PShell.ipc.vaultUnlock(password);
      close();
    } catch (err) {
      showError(errorText(err));
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function reset() {
    const ok = await PShell.util.ask(
      t("vault.resetConfirm", "重置后保险库中的所有密码将被清除且无法恢复，确定继续？"),
      {
        title: t("vault.resetTitle", "重置保险库"),
        okText: t("vault.resetOk", "重置"),
        kind: "danger",
      }
    );
    if (!ok) return;
    try {
      await PShell.ipc.vaultReset();
      // 重置即回到「首次设置」
      setupMode = true;
      render();
    } catch (err) {
      showError(errorText(err));
    }
  }

  function showConflictError(message) {
    const node = $("vault-conflict-error");
    if (!node) return;
    node.textContent = message || "";
    node.hidden = !message;
  }

  /** 打开冲突弹窗；已在展示时不重复打开，避免覆盖待决策的 resolve。 */
  function openConflict() {
    const mask = $(CONFLICT_MASK);
    if (!mask || !mask.hidden) return Promise.resolve();
    showConflictError("");
    const input = $("vault-conflict-password");
    if (input) input.value = "";
    mask.hidden = false;
    return new Promise((resolve) => {
      conflictPending = resolve;
    });
  }

  function closeConflict() {
    const mask = $(CONFLICT_MASK);
    if (mask) mask.hidden = true;
    const resolve = conflictPending;
    conflictPending = null;
    if (resolve) resolve();
  }

  /** 采用远端：用远端主密码校验暂存的保险库，通过后落盘并解锁。 */
  async function adoptRemote() {
    const password = ($("vault-conflict-password") || {}).value || "";
    if (!password) {
      showConflictError(t("vault.conflictNeedPassword", "请输入远端主密码"));
      return;
    }
    const button = $("vault-conflict-adopt");
    if (button) button.disabled = true;
    try {
      await PShell.ipc.vaultAdoptPending(password);
      closeConflict();
      PShell.util.toast(t("vault.conflictAdopted", "已采用远端保险库"), "ok");
      await refresh();
    } catch (err) {
      showConflictError(errorText(err));
    } finally {
      if (button) button.disabled = false;
    }
  }

  /** 保留本地：丢弃远端，用本机密文重新覆盖远端仓库并推送。 */
  async function keepLocal() {
    const button = $("vault-conflict-keep");
    if (button) button.disabled = true;
    try {
      await PShell.ipc.vaultDiscardPending();
      await PShell.ipc.gitCommit();
      await PShell.ipc.gitPush();
      closeConflict();
      PShell.util.toast(t("vault.conflictKept", "已保留本地保险库并覆盖远端"), "ok");
      await refresh();
      if (PShell.gitSync && typeof PShell.gitSync.refresh === "function") {
        PShell.gitSync.refresh().catch(() => {});
      }
    } catch (err) {
      showConflictError(errorText(err));
    } finally {
      if (button) button.disabled = false;
    }
  }

  /** 暂停同步：保留本地，并在设置中关闭 secrets.json 同步。 */
  async function pauseSecrets() {
    const button = $("vault-conflict-pause");
    if (button) button.disabled = true;
    try {
      await PShell.ipc.vaultDiscardPending();
      const config = await PShell.ipc.getConfig();
      if (config && config.features && config.features.sync) {
        config.features.sync.git_sync_secrets = false;
      }
      await PShell.ipc.saveConfig(config);
      closeConflict();
      PShell.util.toast(
        t("vault.conflictPaused", "已暂停同步 secrets.json，可在设置中重新开启"),
        "warn"
      );
      await refresh();
    } catch (err) {
      showConflictError(errorText(err));
    } finally {
      if (button) button.disabled = false;
    }
  }

  function bind() {
    if (bound) return;
    bound = true;

    const submitBtn = $("vault-submit");
    if (submitBtn) submitBtn.addEventListener("click", submit);
    const resetBtn = $("vault-reset");
    if (resetBtn) resetBtn.addEventListener("click", reset);

    // 两个输入框都支持回车提交
    [PASSWORD, PASSWORD2].forEach((id) => {
      const node = $(id);
      if (node) {
        node.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        });
      }
    });

    // 冲突弹窗：三个处理方式 + 远端密码回车即采用
    const adoptBtn = $("vault-conflict-adopt");
    if (adoptBtn) adoptBtn.addEventListener("click", adoptRemote);
    const keepBtn = $("vault-conflict-keep");
    if (keepBtn) keepBtn.addEventListener("click", keepLocal);
    const pauseBtn = $("vault-conflict-pause");
    if (pauseBtn) pauseBtn.addEventListener("click", pauseSecrets);
    const conflictInput = $("vault-conflict-password");
    if (conflictInput) {
      conflictInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          adoptRemote();
        }
      });
    }

    // 同步导入新的保险库后会被后端加锁 / 触发冲突，这里重新评估门禁
    PShell.ipc.listen("git:config-updated", () => {
      refresh().catch(() => {});
    });
    PShell.ipc.listen("git:vault-conflict", () => {
      refresh().catch(() => {});
    });
  }

  /** 按后端状态决定是否弹窗：冲突优先，其次未解锁，均已就绪则直接返回。 */
  async function refresh() {
    const status = await PShell.ipc.vaultStatus();
    if (status && status.conflict) {
      await openConflict();
      return true;
    }
    if (status && status.unlocked) return true;
    await open(!(status && status.configured));
    return true;
  }

  /** boot 流程调用：确保应用进入已解锁状态后再继续。 */
  async function ensureUnlocked() {
    bind();
    if (!PShell.ipc.available) return;
    try {
      await refresh();
    } catch (err) {
      // 门禁本身失败（例如 secrets.json 损坏）时不要卡死界面，交给后续操作报错
      console.error("[vault] 初始化失败", err);
      PShell.util.toast(errorText(err), "error");
    }
  }

  /** 手动锁定（设置界面用），锁定后立即弹窗要求重新解锁。 */
  async function lock() {
    await PShell.ipc.vaultLock();
    await refresh();
  }

  PShell.vault = { ensureUnlocked, refresh, lock };
})(window.PShell);
