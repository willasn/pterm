/* Git 同步面板（FEATURES.md §4）。
 *
 * 只在 features.sync.git_sync 打开时可用：关闭时侧栏入口隐藏、面板不加载，
 * 后端 command 也会以 ModuleDisabled 拒绝。
 * 仓库操作全部经 Tauri command 交给 Rust：优先 git2（进程内 libgit2），
 * 仅在 libgit2 明确不支持的仓库上回退系统 git CLI，并把原因显示出来。 */
(function (PShell) {
  "use strict";

  const { el, $, toast, errorText, ask } = PShell.util;
  const { field, section } = PShell.form;

  let enabled = false;
  let badgeOn = true;
  let busy = false;
  let status = null;
  let diffText = null;

  function syncFlags(config) {
    return (config && config.features && config.features.sync) || {};
  }

  function isOpen() {
    const mask = $("modal-git");
    return !!mask && !mask.hidden;
  }

  // -------------------------------------------------------------------------
  // 侧栏状态徽标
  // -------------------------------------------------------------------------

  function badgeText() {
    if (!status) return "Git …";
    if (!status.initialized) return "Git 未初始化";
    const marks = [];
    if (status.ahead) marks.push("↑" + status.ahead);
    if (status.behind) marks.push("↓" + status.behind);
    const changes = (status.dirty || 0) + (status.untracked || 0);
    if (changes) marks.push("●" + changes);
    if (status.conflicts && status.conflicts.length) marks.push("冲突 " + status.conflicts.length);
    return "Git " + (status.branch || "—") + (marks.length ? " " + marks.join(" ") : " ✓");
  }

  function renderBadge() {
    const node = $("git-status");
    if (!node) return;
    if (!enabled || !badgeOn) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    node.textContent = badgeText();
  }

  // -------------------------------------------------------------------------
  // 面板
  // -------------------------------------------------------------------------

  function note(text, kind) {
    return el("p", { class: "inline-note " + (kind || ""), text });
  }

  function info(label, value) {
    return field(label, null, el("span", { class: "muted", text: value }));
  }

  function button(label, onclick, kind) {
    return el("button", {
      class: "btn " + (kind || "ghost"),
      type: "button",
      text: label,
      disabled: busy,
      onclick,
    });
  }

  function stateSection(s) {
    const rows = [
      info("仓库路径", s.repo_path),
      info("状态", s.initialized ? "已初始化" : "未初始化"),
    ];
    if (s.initialized) {
      rows.push(info("分支", s.branch || "—"));
      rows.push(info("上游", s.upstream || "未设置"));
      rows.push(info("领先 / 落后", `${s.ahead} / ${s.behind}`));
      rows.push(info("变更", `${s.dirty} 个已跟踪 · ${s.untracked} 个未跟踪`));
      rows.push(info("同步范围", s.scope));
    }
    rows.push(
      info(
        "远端",
        s.remotes.length
          ? s.remotes
              .map((r) => `${r.name} → ${r.url}${r.has_credential ? "（已配置凭据）" : ""}`)
              .join("；")
          : "未配置（本次仅本地提交留痕）"
      )
    );
    rows.push(info("上次同步", s.last_sync_at || "—"));
    if (s.last_result) rows.push(info("上次结果", s.last_result));
    if (s.last_error) {
      rows.push(field("上次错误", null, el("span", { class: "inline-note error", text: s.last_error })));
    }
    if (s.unsupported_reason) {
      rows.push(
        field(
          "libgit2 不支持",
          null,
          el("span", { class: "inline-note", text: s.unsupported_reason + "；本次将回退系统 git CLI" })
        )
      );
    }
    rows.push(info("系统 git", s.cli_version || "未检测到（回退不可用）"));
    return section("状态", s.multi_repo ? "多仓库模式：推送会依次写入每个远端。" : null, rows);
  }

  function conflictSection(s) {
    const list = el(
      "ul",
      { class: "git-conflicts" },
      s.conflicts.map((file) => el("li", { text: file }))
    );
    return section("冲突待处理", "同步已暂停，选择保留策略后才会继续。", [
      list,
      el("div", { class: "git-actions" }, [
        button("保留本地", () => run("解决冲突", () => PShell.ipc.gitResolve("keep_local")), "primary"),
        button("保留远端", () => run("解决冲突", () => PShell.ipc.gitResolve("keep_remote")), "ghost"),
      ]),
      note("解决冲突后不会自动推送，请确认差异后再手动推送。"),
    ]);
  }

  function actionSection(s) {
    if (!s.initialized) {
      return section("操作", "首次使用：初始化一个空仓库，或从已有远端克隆。", [
        el("div", { class: "git-actions" }, [
          button("初始化仓库", () => run("初始化", () => PShell.ipc.gitInit()), "primary"),
          button("从远端克隆", cloneFromRemote, "ghost"),
        ]),
        note("克隆使用「设置 → Git 同步」中填写的远程地址；HTTPS 远端需先在该页的「访问凭据」中填写用户名与密码 / 令牌。"),
      ]);
    }
    return section("操作", "同步 = 导出 → 提交 → 拉取 → 导入 → 推送。", [
      el("div", { class: "git-actions" }, [
        button("立即同步", () => run("同步", () => PShell.ipc.gitSyncNow()), "primary"),
        button("仅拉取", () => run("拉取", () => PShell.ipc.gitPull()), "ghost"),
        button("仅推送", () => run("推送", () => PShell.ipc.gitPush()), "ghost"),
        button("仅提交", () => run("提交", () => PShell.ipc.gitCommit()), "ghost"),
      ]),
      note("HTTPS 远端提示凭据错误时，请在「设置 → Git 同步 → 访问凭据」填写用户名与密码 / 访问令牌。"),
    ]);
  }

  function diffSection() {
    const nodes = [
      el("div", { class: "git-actions" }, [
        button("查看差异", showDiff, "ghost"),
        diffText != null
          ? button(
              "隐藏差异",
              () => {
                diffText = null;
                renderBody();
              },
              "ghost"
            )
          : null,
      ]),
    ];
    if (diffText != null) {
      nodes.push(el("pre", { class: "git-diff", text: diffText.trim() || "工作区与最近一次提交一致，无差异。" }));
    }
    return section("差异", "工作区（含未跟踪文件）相对最近一次提交的 unified diff。", nodes);
  }

  function renderBody() {
    const host = $("git-body");
    if (!host) return;
    const hint = $("git-hint");
    if (hint) hint.textContent = status ? "仓库：" + status.repo_path : "";

    host.textContent = "";
    if (!enabled) {
      host.appendChild(note("Git 同步已关闭。请在「设置 → 功能开关」中打开「Git 同步」。"));
      return;
    }
    if (!status) {
      host.appendChild(note("正在读取同步状态…"));
      return;
    }

    host.appendChild(stateSection(status));
    if (status.conflicts && status.conflicts.length) host.appendChild(conflictSection(status));
    host.appendChild(actionSection(status));
    host.appendChild(diffSection());
  }

  // -------------------------------------------------------------------------
  // 行为
  // -------------------------------------------------------------------------

  async function refresh() {
    if (!enabled) {
      status = null;
    } else {
      try {
        status = await PShell.ipc.gitStatus();
      } catch (err) {
        status = null;
        if (isOpen()) toast(errorText(err), "error");
      }
    }
    renderBadge();
    if (isOpen()) renderBody();
  }

  async function run(label, fn) {
    if (busy) return;
    busy = true;
    renderBody();
    try {
      const outcome = await fn();
      const pending = outcome && outcome.conflicts && outcome.conflicts.length;
      toast((outcome && outcome.message) || label + "完成", pending ? "info" : "ok");
      diffText = null;
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      busy = false;
      await refresh();
    }
  }

  async function showDiff() {
    try {
      diffText = await PShell.ipc.gitDiff();
    } catch (err) {
      toast(errorText(err), "error");
      return;
    }
    renderBody();
  }

  async function cloneFromRemote() {
    const remote = (status && status.remotes && status.remotes[0]) || null;
    const url = remote && remote.url ? remote.url : "";
    if (!url) {
      toast("请先在「设置 → Git 同步」中填写远程地址", "info");
      return;
    }
    const confirmed = await ask(
      `从 ${url} 克隆到同步目录？仓库中的同名文件会覆盖本地内容，敏感字段不在仓库中。`
    );
    if (!confirmed) return;
    run("克隆", () => PShell.ipc.gitClone(url));
  }

  async function open() {
    if (!enabled) {
      toast("Git 同步已关闭，请在「设置 → 功能开关」中启用", "info");
      return;
    }
    const mask = $("modal-git");
    if (!mask || isOpen()) return;
    diffText = null;
    mask.hidden = false;
    renderBody();
    await refresh();
  }

  /** 由 app.js 在配置变化时调用（启动、保存设置、重置）。 */
  function setConfig(config) {
    const sync = syncFlags(config);
    enabled = !!sync.git_sync;
    badgeOn = !!sync.git_status_badge;
    renderBadge();
    if (enabled) {
      refresh();
    } else {
      status = null;
      renderBadge();
      if (isOpen()) renderBody();
    }
  }

  /** 同步导入会改动本地配置，后端广播后这里重新拉取一次。 */
  function subscribe() {
    PShell.ipc
      .listen("git:config-updated", async () => {
        try {
          const config = await PShell.ipc.getConfig();
          if (PShell.app && typeof PShell.app.applyConfig === "function") {
            PShell.app.applyConfig(config);
          }
          if (PShell.connections && typeof PShell.connections.refresh === "function") {
            PShell.connections.refresh().catch(() => {});
          }
          toast("已从同步仓库导入配置", "info");
        } catch (err) {
          toast(errorText(err), "error");
        }
      })
      .catch(() => {});
  }

  const badgeNode = $("git-status");
  if (badgeNode) badgeNode.addEventListener("click", open);
  subscribe();

  PShell.gitSync = { setConfig, open, refresh };
})(window.PShell);