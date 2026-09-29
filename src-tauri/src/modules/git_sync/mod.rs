//! Git 同步模块（FEATURES.md §4）。
//!
//! 职责：
//! - 把 `config.yaml` / 连接 / 命令片段 / 加密保险库导出为仓库内的 payload，
//!   提交后推送到用户自己的远程仓库；拉取时反向导入。**不做任何云同步**。
//! - 优先走 [`repo`]（进程内 libgit2，不依赖系统 git）；只有 [`fallback::unsupported_reason`]
//!   明确报告 libgit2 处理不了的场景（变基中、LFS 等）才回退系统 CLI，并记录原因。
//!
//! 同步仅由用户手动触发，统一经过 [`SyncContext::execute`]，
//! 由 [`GitSync::lock`] 串行化，避免并发写同一个仓库。

pub mod auth;
pub mod commands;
pub mod fallback;
pub mod repo;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use git2::Repository;
use parking_lot::{Mutex, MutexGuard};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::config::app_config::AppConfig;
use crate::config::feature_flags::{module_id, FeatureFlags, GitRemoteConfig, PluggableModule, SyncScope};
use crate::config::store::{secrets, SharedStore, SnippetRecord, StoredConnection};
use crate::config::vault::{self, ImportOutcome};
use crate::config::ConfigManager;
use crate::error::{AppError, AppResult};
use crate::modules::ModuleContext;
use crate::utils::Paths;

use repo::ConflictStrategy;

/// 网络操作（fetch / pull / push）超时。
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
/// 本地操作（status / commit / 远端登记）超时。
const LOCAL_TIMEOUT: Duration = Duration::from_secs(30);

/// 同步 payload 文件名。前三个是明文配置，`secrets.json` 是主密码加密的密文。
const FILE_CONFIG: &str = "config.yaml";
const FILE_CONNECTIONS: &str = "connections.json";
const FILE_SNIPPETS: &str = "snippets.json";
const FILE_SECRETS: &str = "secrets.json";

/// 同步导入后配置发生变化时广播，前端据此重新拉取配置。
pub const EVENT_CONFIG_UPDATED: &str = "git:config-updated";

/// 同步导入的保险库与本机主密码不一致时广播，前端据此弹出冲突处理引导。
pub const EVENT_VAULT_CONFLICT: &str = "git:vault-conflict";

// ---------------------------------------------------------------------------
// 服务与上下文
// ---------------------------------------------------------------------------

/// Git 同步服务。由启动流程创建一次并注入 `AppState`，
/// 这样命令层与模块层拿到的是同一个实例（同一把锁、同一个调度器）。
#[derive(Clone)]
pub struct GitSync {
    inner: Arc<GitInner>,
}

struct GitInner {
    /// 串行化所有同步入口，避免两个同步同时改同一个仓库。
    lock: Mutex<()>,
}

impl Default for GitSync {
    fn default() -> Self {
        Self::new()
    }
}

impl GitSync {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(GitInner {
                lock: Mutex::new(()),
            }),
        }
    }

    /// 取得同步互斥锁（跨线程阻塞等待，必须只在后台线程里获取）。
    pub fn lock(&self) -> MutexGuard<'_, ()> {
        self.inner.lock.lock()
    }
}

/// 一次同步操作所需的全部依赖。实现上刻意不依赖 SSH 核心模块。
#[derive(Clone)]
pub struct SyncContext {
    pub app: AppHandle,
    pub config: Arc<ConfigManager>,
    pub store: SharedStore,
    pub paths: Paths,
    pub git: GitSync,
}

impl SyncContext {
    pub fn new(
        app: AppHandle,
        config: Arc<ConfigManager>,
        store: SharedStore,
        paths: Paths,
        git: GitSync,
    ) -> Self {
        Self {
            app,
            config,
            store,
            paths,
            git,
        }
    }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// 一个已配置的远端。
#[derive(Debug, Clone, Serialize)]
pub struct RemoteView {
    pub name: String,
    pub url: String,
    pub branch: Option<String>,
    /// 是否已在加密保险库中保存密码 / 访问令牌
    pub has_credential: bool,
}

/// 同步状态快照，供界面显示（FEATURES.md §4「状态显示」）。
#[derive(Debug, Clone, Serialize)]
pub struct GitStatusView {
    pub enabled: bool,
    pub repo_path: String,
    pub initialized: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub dirty: usize,
    pub untracked: usize,
    pub conflicts: Vec<String>,
    pub remotes: Vec<RemoteView>,
    pub multi_repo: bool,
    pub scope: String,
    pub last_sync_at: Option<String>,
    pub last_result: Option<String>,
    pub last_error: Option<String>,
    /// 检测到的系统 git 版本；未安装为 `None`
    pub cli_version: Option<String>,
    /// libgit2 处理不了当前仓库的原因；为 `None` 表示走 git2 路径
    pub unsupported_reason: Option<String>,
}

/// 一次同步的结果，供界面提示。
#[derive(Debug, Clone, Serialize)]
pub struct SyncOutcomeView {
    pub action: String,
    pub scope: String,
    /// 本次检测到的变更条目数
    pub change_count: usize,
    /// 本次产生的提交 id
    pub commit: Option<String>,
    pub pulled: bool,
    pub pulled_fast_forward: bool,
    pub pushed: bool,
    pub conflicts: Vec<String>,
    /// 从 payload 导入的条目数
    pub imported: usize,
    pub message: String,
    pub used_fallback: bool,
    pub fallback_reason: Option<String>,
}

impl SyncOutcomeView {
    fn new(op: Op, scope: SyncScope) -> Self {
        Self {
            action: op.action().to_string(),
            scope: scope_label(scope).to_string(),
            change_count: 0,
            commit: None,
            pulled: false,
            pulled_fast_forward: false,
            pushed: false,
            conflicts: Vec::new(),
            imported: 0,
            message: String::new(),
            used_fallback: false,
            fallback_reason: None,
        }
    }
}

/// 「测试连接」的输入：地址 / 用户名取自设置表单，密码可临时输入或沿用保险库。
#[derive(Debug, Clone, Deserialize)]
pub struct GitTestInput {
    /// 远端名称，密码缺省时据它回落到保险库中已保存的凭据
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub username: Option<String>,
    /// 明文密码 / 访问令牌；`None` 表示沿用保险库中已保存的
    #[serde(default)]
    pub password: Option<String>,
}

/// 「测试连接」的结果。
#[derive(Debug, Clone, Serialize)]
pub struct GitTestView {
    pub remote: String,
    pub url: String,
    /// 远端引用条目数
    pub refs: usize,
    pub default_branch: Option<String>,
    pub elapsed_ms: u64,
    pub message: String,
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

/// 同步操作类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    /// 完整同步：导出 → 提交 → 拉取 → 导入 → 推送
    Sync,
    /// 只拉取并导入
    Pull,
    /// 只推送
    Push,
    /// 只导出并提交（离线留痕，不触网）
    Commit,
    /// 按策略解决冲突后导入（**不自动推送**，由用户确认后再推）
    Resolve(ConflictStrategy),
}

impl Op {
    fn action(&self) -> &'static str {
        match self {
            Op::Sync => "sync",
            Op::Pull => "pull",
            Op::Push => "push",
            Op::Commit => "commit",
            Op::Resolve(_) => "resolve",
        }
    }

    /// 是否导出 payload
    fn exports(&self) -> bool {
        matches!(self, Op::Sync | Op::Commit)
    }

    /// 是否提交本地变更
    fn commits(&self) -> bool {
        matches!(self, Op::Sync | Op::Commit)
    }

    /// 是否拉取远端
    fn pulls(&self) -> bool {
        matches!(self, Op::Sync | Op::Pull)
    }

    /// 是否推送远端
    fn pushes(&self) -> bool {
        matches!(self, Op::Sync | Op::Push)
    }

    /// 是否把 payload 反向导入本地
    fn imports(&self) -> bool {
        matches!(self, Op::Sync | Op::Pull | Op::Resolve(_))
    }
}

fn scope_label(scope: SyncScope) -> &'static str {
    match scope {
        SyncScope::Config => "config",
        SyncScope::Snippets => "snippets",
        SyncScope::All => "all",
    }
}

fn strategy_label(strategy: ConflictStrategy) -> &'static str {
    match strategy {
        ConflictStrategy::KeepLocal => "keep_local",
        ConflictStrategy::KeepRemote => "keep_remote",
    }
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

impl SyncContext {
    /// 执行一次同步。串行化 + 记录同步状态 + 导入后广播配置变更。
    pub fn execute(&self, op: Op) -> AppResult<SyncOutcomeView> {
        let _guard = self.git.lock();
        let key = self.repo_path().display().to_string();
        let result = self.execute_inner(op);

        match &result {
            Ok(view) => {
                if let Err(e) = self.store.set_sync_state(&key, Some(&view.message), None) {
                    log::warn!("记录同步状态失败：{e}");
                }
            }
            Err(e) => {
                let text = e.to_string();
                log::warn!("{text}");
                if let Err(e) = self.store.set_sync_state(&key, None, Some(&text)) {
                    log::warn!("记录同步错误失败：{e}");
                }
            }
        }

        // 导入改动了本地配置，通知前端重新拉取
        if let Ok(view) = &result {
            if view.imported > 0 && op.imports() {
                if let Err(e) = self.app.emit(EVENT_CONFIG_UPDATED, ()) {
                    log::warn!("广播配置更新事件失败：{e}");
                }
            }
        }
        result
    }

    fn execute_inner(&self, op: Op) -> AppResult<SyncOutcomeView> {
        let flags = self.flags();
        let scope = flags.sync.git_sync_scope;
        let dir = self.repo_path();
        let remotes = self.effective_remotes();
        let (author, email) = (
            flags.sync.git_author_name.clone(),
            flags.sync.git_author_email.clone(),
        );

        let repository = repo::open_or_init(&dir)?;
        // git2 路径下远端必须显式登记，否则 fetch / push 找不到地址
        for remote in &remotes {
            repo::set_remote(&repository, &remote.name, &remote.url)?;
        }

        // 决定是否需要回退系统 CLI（并记录原因）
        if let Some(reason) = fallback::unsupported_reason(&repository) {
            if !flags.sync.git_cli_fallback {
                return Err(AppError::Git(format!(
                    "{reason}；已在设置中关闭「系统 Git 回退」，无法继续"
                )));
            }
            if !fallback::available() {
                return Err(AppError::Git(format!(
                    "{reason}；且未检测到可用的系统 git，无法回退"
                )));
            }
            log::warn!("Git 同步回退系统 CLI：{reason}");
            return self.execute_cli(op, &dir, &remotes, scope, reason);
        }

        let branch = repo::current_branch(&repository);
        let primary = remotes.first().map(|r| r.name.clone());
        let credentials = self.credentials();
        let mut view = SyncOutcomeView::new(op, scope);
        let mut notes: Vec<String> = Vec::new();

        // 全新客户端（本地仓库还没有任何提交）且配置了远端时，先拉取并导入远端内容。
        // 否则「先导出 + 本地提交、再拉取」会生成一条与远端无共同祖先的根提交，
        // 合并时同一批 payload 在两边都是新增 → add/add 冲突；若用户又关掉冲突
        // 提示，还会按「保留本地」自动解决，把远端已有数据覆盖成空。
        let first_sync = op.pulls() && primary.is_some() && repo::is_unborn(&repository);
        if first_sync {
            let remote_name = primary.as_deref().unwrap_or("origin");
            if !self.pull_remote(&repository, remote_name, &branch, scope, &mut view, &mut notes)? {
                return Ok(view);
            }
            if op.imports() {
                view.imported = self.read_payload(&dir, scope)?;
            }
        }

        if op.exports() {
            self.write_payload(&dir, scope)?;
        }

        if op.commits() {
            let count = repo::change_count(&repository)?;
            view.change_count = count;
            if count > 0 {
                let message = self.commit_message(scope, count);
                if let Some(oid) = repo::commit_all(&repository, &message, &author, &email)? {
                    view.commit = Some(oid.to_string());
                }
            }
        }

        if op.pulls() && !first_sync {
            match &primary {
                Some(remote_name) => {
                    if !self
                        .pull_remote(&repository, remote_name, &branch, scope, &mut view, &mut notes)?
                    {
                        return Ok(view);
                    }
                }
                None => notes.push("未配置远程地址，已跳过拉取与推送".into()),
            }
        }

        if let Op::Resolve(strategy) = op {
            let message = self.conflict_message(scope, 0);
            let resolved =
                repo::resolve_conflicts(&repository, strategy, &message, &author, &email)?;
            notes.push(format!(
                "已按「{}」解决 {resolved} 个冲突，请确认后手动推送",
                strategy_label(strategy)
            ));
        }

        if op.imports() && !first_sync {
            view.imported = self.read_payload(&dir, scope)?;
        }

        if op.pushes() {
            match &primary {
                Some(_) => {
                    for remote in &remotes {
                        repo::push(
                            &repository,
                            &remote.name,
                            &branch,
                            remote.branch.as_deref(),
                            &credentials,
                        )?;
                    }
                    view.pushed = true;
                }
                None => {
                    if notes.is_empty() {
                        notes.push("未配置远程地址，已跳过拉取与推送".into());
                    }
                }
            }
        }

        finish(&mut view, notes);
        Ok(view)
    }

    /// 拉取远端并处理冲突（普通同步与首次同步共用）。
    ///
    /// 返回 `Ok(false)` 表示检测到冲突且用户开着冲突提示，同步应暂停，
    /// 调用方需直接返回当前 `view`；`Ok(true)` 表示可以继续后续步骤。
    /// 关闭冲突提示时按「保留本地」自动解决，并把提示追加到 `notes`。
    fn pull_remote(
        &self,
        repository: &Repository,
        remote_name: &str,
        branch: &str,
        scope: SyncScope,
        view: &mut SyncOutcomeView,
        notes: &mut Vec<String>,
    ) -> AppResult<bool> {
        let flags = self.flags();
        let (author, email) = (
            flags.sync.git_author_name.clone(),
            flags.sync.git_author_email.clone(),
        );
        let credentials = self.credentials();
        let outcome = repo::pull(repository, remote_name, branch, &author, &email, &credentials)?;
        view.pulled = outcome.updated;
        view.pulled_fast_forward = outcome.fast_forward;
        if outcome.conflicts.is_empty() {
            return Ok(true);
        }

        view.conflicts = outcome.conflicts;
        if flags.sync.git_conflict_prompt {
            view.message = format!(
                "检测到 {} 个文件冲突，同步已暂停，请选择保留策略",
                view.conflicts.len()
            );
            return Ok(false);
        }
        // 关闭冲突提示时按「保留本地」自动解决，保证同步不中断
        let merge_message = self.conflict_message(scope, view.conflicts.len());
        let resolved = repo::resolve_conflicts(
            repository,
            ConflictStrategy::KeepLocal,
            &merge_message,
            &author,
            &email,
        )?;
        notes.push(format!("已按「保留本地」自动解决 {resolved} 个冲突"));
        Ok(true)
    }

    /// 系统 CLI 回退路径。仅在 libgit2 明确不支持当前仓库时进入。
    fn execute_cli(
        &self,
        op: Op,
        dir: &Path,
        remotes: &[GitRemoteConfig],
        scope: SyncScope,
        reason: String,
    ) -> AppResult<SyncOutcomeView> {
        let flags = self.flags();
        let (author, email) = (
            flags.sync.git_author_name.clone(),
            flags.sync.git_author_email.clone(),
        );
        let identity: Vec<String> = vec![
            "-c".to_string(),
            format!("user.name={author}"),
            "-c".to_string(),
            format!("user.email={email}"),
        ];
        let branch = cli_branch(dir);
        let primary = remotes.first().map(|r| r.name.clone());
        let mut view = SyncOutcomeView::new(op, scope);
        let mut notes: Vec<String> = Vec::new();
        view.used_fallback = true;
        view.fallback_reason = Some(reason);

        // 逐条登记远端地址
        for remote in remotes {
            let current = fallback::run_output(
                dir,
                &["remote", "get-url", &remote.name],
                LOCAL_TIMEOUT,
            )?;
            if current.success {
                if current.out() != remote.url {
                    fallback::run(
                        dir,
                        &["remote", "set-url", &remote.name, &remote.url],
                        LOCAL_TIMEOUT,
                    )?;
                }
            } else {
                fallback::run(
                    dir,
                    &["remote", "add", &remote.name, &remote.url],
                    LOCAL_TIMEOUT,
                )?;
            }
        }

        if op.exports() {
            self.write_payload(dir, scope)?;
        }

        if op.commits() {
            let status = fallback::run(dir, &["status", "--porcelain"], LOCAL_TIMEOUT)?;
            let count = status.lines().filter(|l| !l.trim().is_empty()).count();
            view.change_count = count;
            if count > 0 {
                let message = self.commit_message(scope, count);
                let mut args = identity.clone();
                args.extend(["add".to_string(), "-A".to_string()]);
                fallback::run(dir, &as_args(&args), LOCAL_TIMEOUT)?;
                let mut args = identity.clone();
                args.extend(["commit".to_string(), "-m".to_string(), message]);
                fallback::run(dir, &as_args(&args), LOCAL_TIMEOUT)?;
                let head = fallback::run(dir, &["rev-parse", "HEAD"], LOCAL_TIMEOUT)?;
                view.commit = Some(head.trim().to_string());
            }
        }

        if op.pulls() {
            match &primary {
                Some(remote_name) => {
                    let pulled = fallback::run_output(
                        dir,
                        &["pull", "--no-rebase", remote_name, &branch],
                        NETWORK_TIMEOUT,
                    )?;
                    view.pulled = true;
                    if !pulled.success {
                        let conflicts = cli_conflicts(dir)?;
                        if conflicts.is_empty() {
                            return Err(AppError::Git(format!(
                                "git pull 失败：{}",
                                pulled.error_detail()
                            )));
                        }
                        view.conflicts = conflicts.clone();
                        if flags.sync.git_conflict_prompt {
                            view.message = format!(
                                "检测到 {} 个文件冲突，同步已暂停，请选择保留策略",
                                conflicts.len()
                            );
                            return Ok(view);
                        }
                        fallback::run(dir, &["checkout", "--ours", "--", "."], LOCAL_TIMEOUT)?;
                        fallback::run(dir, &["add", "-A"], LOCAL_TIMEOUT)?;
                        let mut args = identity.clone();
                        args.extend(["commit".to_string(), "--no-edit".to_string()]);
                        fallback::run(dir, &as_args(&args), LOCAL_TIMEOUT)?;
                        notes.push(format!(
                            "已按「保留本地」自动解决 {} 个冲突",
                            conflicts.len()
                        ));
                    }
                }
                None => notes.push("未配置远程地址，已跳过拉取与推送".into()),
            }
        }

        if let Op::Resolve(strategy) = op {
            let flag = match strategy {
                ConflictStrategy::KeepLocal => "--ours",
                ConflictStrategy::KeepRemote => "--theirs",
            };
            let conflicts = cli_conflicts(dir)?;
            if !conflicts.is_empty() {
                fallback::run(dir, &["checkout", flag, "--", "."], LOCAL_TIMEOUT)?;
                fallback::run(dir, &["add", "-A"], LOCAL_TIMEOUT)?;
                let mut args = identity.clone();
                args.extend(["commit".to_string(), "--no-edit".to_string()]);
                fallback::run(dir, &as_args(&args), LOCAL_TIMEOUT)?;
            }
            notes.push(format!(
                "已按「{}」解决 {} 个冲突，请确认后手动推送",
                strategy_label(strategy),
                conflicts.len()
            ));
        }

        if op.imports() {
            view.imported = self.read_payload(dir, scope)?;
        }

        if op.pushes() {
            match &primary {
                Some(_) => {
                    for remote in remotes {
                        let target = remote.branch.clone().unwrap_or_else(|| branch.clone());
                        fallback::run(
                            dir,
                            &["push", &remote.name, &format!("HEAD:refs/heads/{target}")],
                            NETWORK_TIMEOUT,
                        )?;
                    }
                    view.pushed = true;
                }
                None => {
                    if notes.is_empty() {
                        notes.push("未配置远程地址，已跳过拉取与推送".into());
                    }
                }
            }
        }

        finish(&mut view, notes);
        Ok(view)
    }

    // -- 只读操作 ---------------------------------------------------------

    /// 当前同步状态快照。
    pub fn status(&self) -> AppResult<GitStatusView> {
        let flags = self.flags();
        let dir = self.repo_path();
        let remotes: Vec<RemoteView> = self
            .effective_remotes()
            .into_iter()
            .map(|r| {
                let has_credential = stored_password(&r.name).is_some();
                RemoteView {
                    name: r.name,
                    url: r.url,
                    branch: r.branch,
                    has_credential,
                }
            })
            .collect();

        let repository = repo::try_open(&dir);
        let primary = remotes
            .first()
            .map(|r| r.name.clone())
            .unwrap_or_else(|| "origin".to_string());

        let mut view = GitStatusView {
            enabled: flags.sync.git_sync,
            repo_path: dir.display().to_string(),
            initialized: repository.is_some(),
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            dirty: 0,
            untracked: 0,
            conflicts: Vec::new(),
            remotes,
            multi_repo: flags.sync.git_multi_repo,
            scope: scope_label(flags.sync.git_sync_scope).to_string(),
            last_sync_at: None,
            last_result: None,
            last_error: None,
            cli_version: fallback::version(),
            unsupported_reason: None,
        };

        if let Some(repository) = &repository {
            let state = repo::status(repository, &primary)?;
            view.branch = state.branch;
            view.upstream = state.upstream;
            view.ahead = state.ahead;
            view.behind = state.behind;
            view.dirty = state.dirty;
            view.untracked = state.untracked;
            view.conflicts = state.conflicts;
            view.unsupported_reason = fallback::unsupported_reason(repository);
        }

        if let Some(record) = self.store.sync_state(&view.repo_path)? {
            view.last_sync_at = record.last_sync_at;
            view.last_result = record.last_result;
            view.last_error = record.last_error;
        }
        Ok(view)
    }

    /// 初始化同步仓库（目录已是仓库时直接复用）。
    pub fn init_repo(&self) -> AppResult<GitStatusView> {
        let dir = self.repo_path();
        repo::open_or_init(&dir)?;
        self.status()
    }

    /// 从远端克隆到同步目录。已有仓库时拒绝，避免覆盖本地数据。
    pub fn clone_repo(&self, url: &str) -> AppResult<GitStatusView> {
        let url = url.trim();
        if url.is_empty() {
            return Err(AppError::Config("未填写远程地址".into()));
        }
        let dir = self.repo_path();
        if dir.join(".git").exists() {
            return Err(AppError::Git(format!(
                "同步目录已存在仓库，请先清空或改用拉取：{}",
                dir.display()
            )));
        }
        repo::clone(url, &dir, self.credentials())?;
        self.status()
    }

    /// 工作区相对 HEAD 的差异文本。
    pub fn diff(&self) -> AppResult<String> {
        let dir = self.repo_path();
        let repository = repo::try_open(&dir)
            .ok_or_else(|| AppError::Git(format!("同步仓库尚未初始化：{}", dir.display())))?;
        repo::diff(&repository)
    }

    /// 测试远端连通性并校验凭据：一次握手 + 读引用列表，同时验证地址可达、
    /// 用户名 / 密码（令牌）有效。只读，不读写用户的同步仓库、不产生提交。
    pub fn test_connection(&self, input: &GitTestInput) -> AppResult<GitTestView> {
        let url = input.url.trim();
        if url.is_empty() {
            return Err(AppError::Config("未填写远程地址".into()));
        }
        let name = normalize_remote_name(&input.name);
        // 表单里新输入的密码优先；未输入则回落到保险库中已保存的凭据
        let password = match input.password.as_deref().map(str::trim) {
            Some("") => None,
            Some(value) => Some(value.to_string()),
            None => stored_password(&name),
        };
        let username = input
            .username
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .map(|u| u.to_string());
        let credential = auth::Credential {
            url: url.to_string(),
            username,
            password,
        };

        let started = std::time::Instant::now();
        let probe = repo::probe_remote(url, vec![credential])?;
        let elapsed_ms = started.elapsed().as_millis() as u64;

        let mut message = format!("连接成功，远端共有 {} 个引用", probe.refs);
        if let Some(branch) = probe.default_branch.as_deref() {
            message.push_str(&format!("，默认分支 {branch}"));
        }
        Ok(GitTestView {
            remote: name,
            url: url.to_string(),
            refs: probe.refs,
            default_branch: probe.default_branch,
            elapsed_ms,
            message,
        })
    }

    // -- 内部工具 ---------------------------------------------------------

    fn flags(&self) -> FeatureFlags {
        self.config.flags()
    }

    /// 同步仓库路径：配置为空时用数据目录下的 `sync` 子目录。
    fn repo_path(&self) -> PathBuf {
        let configured = self.flags().sync.git_repo_path;
        let path = match configured.as_deref().map(str::trim) {
            Some(value) if !value.is_empty() => expand_tilde(value),
            _ => self.paths.data_dir.join("sync"),
        };
        if let Err(e) = std::fs::create_dir_all(&path) {
            log::warn!("创建同步目录 {} 失败：{e}", path.display());
        }
        path
    }

    /// 生效的远端列表：过滤掉未填地址的条目；未开启多仓库时只保留第一条。
    fn effective_remotes(&self) -> Vec<GitRemoteConfig> {
        let flags = self.flags();
        let mut out: Vec<GitRemoteConfig> = flags
            .sync
            .git_remotes
            .iter()
            .filter(|r| !r.url.trim().is_empty())
            .map(|r| GitRemoteConfig {
                name: normalize_remote_name(&r.name),
                url: r.url.trim().to_string(),
                branch: r
                    .branch
                    .as_deref()
                    .map(str::trim)
                    .filter(|b| !b.is_empty())
                    .map(|b| b.to_string()),
                username: r
                    .username
                    .as_deref()
                    .map(str::trim)
                    .filter(|u| !u.is_empty())
                    .map(|u| u.to_string()),
            })
            .collect();
        if !flags.sync.git_multi_repo {
            out.truncate(1);
        }
        out
    }

    /// 收集各远端在加密保险库中已保存的密码 / 访问令牌，供 git2 凭据回调使用。
    /// 用户名与密码都没有的远端不产生条目，让回调继续尝试本机既有凭据。
    fn credentials(&self) -> Vec<auth::Credential> {
        self.effective_remotes()
            .into_iter()
            .filter_map(|remote| {
                let password = stored_password(&remote.name);
                (remote.username.is_some() || password.is_some()).then(|| auth::Credential {
                    url: remote.url,
                    username: remote.username,
                    password,
                })
            })
            .collect()
    }

    /// 按模板生成提交信息。支持 `{date} {time} {host} {count} {scope}`。
    fn commit_message(&self, scope: SyncScope, count: usize) -> String {
        let flags = self.flags();
        if !flags.sync.git_commit_template || flags.sync.git_commit_template_text.trim().is_empty() {
            return format!("pshell sync ({})", scope_label(scope));
        }
        let now = chrono::Local::now();
        flags
            .sync
            .git_commit_template_text
            .replace("{date}", &now.format("%Y-%m-%d").to_string())
            .replace("{time}", &now.format("%H:%M").to_string())
            .replace("{host}", &hostname())
            .replace("{count}", &count.to_string())
            .replace("{scope}", scope_label(scope))
    }

    fn conflict_message(&self, scope: SyncScope, count: usize) -> String {
        format!(
            "resolve({}): 解决 {} 个冲突 @ {}",
            scope_label(scope),
            count,
            chrono::Local::now().format("%Y-%m-%d %H:%M")
        )
    }

    // -- payload 导出 -----------------------------------------------------

    fn write_payload(&self, dir: &Path, scope: SyncScope) -> AppResult<()> {
        std::fs::create_dir_all(dir)?;
        if matches!(scope, SyncScope::Config | SyncScope::All) {
            self.export_config(dir)?;
            self.export_connections(dir)?;
            if self.flags().sync.git_sync_secrets {
                self.export_secrets(dir)?;
            } else {
                log::info!("已按设置暂停同步 secrets.json，跳过导出");
            }
        }
        if matches!(scope, SyncScope::Snippets | SyncScope::All) {
            self.export_snippets(dir)?;
        }
        Ok(())
    }

    fn export_config(&self, dir: &Path) -> AppResult<()> {
        // 配置文件里不含任何凭据（AI Key 等在加密保险库），可直接导出
        let cfg = self.config.snapshot();
        cfg.save(&dir.join(FILE_CONFIG))
    }

    fn export_connections(&self, dir: &Path) -> AppResult<()> {
        // 密码 / passphrase 存在加密保险库（secrets.json），连接本身只带标记
        let list = self.store.list_connections()?;
        write_json(&dir.join(FILE_CONNECTIONS), &list)
    }

    /// 把敏感字段的密文保险库一并复制到仓库，实现跨设备同步。
    /// 未设置主密码（例如刚重置过保险库）时删掉仓库里的旧密文，避免它被再次导入。
    /// 存在未解决的「主密码冲突」时不导出，避免用本地密文覆盖远端造成数据丢失。
    fn export_secrets(&self, dir: &Path) -> AppResult<()> {
        if vault::pending_conflict()? {
            log::warn!("存在未解决的主密码冲突，暂不导出 secrets.json");
            return Ok(());
        }
        let target = dir.join(FILE_SECRETS);
        match vault::export_bytes()? {
            Some(bytes) => std::fs::write(target, bytes)?,
            None => {
                if target.exists() {
                    std::fs::remove_file(target)?;
                }
            }
        }
        Ok(())
    }

    fn export_snippets(&self, dir: &Path) -> AppResult<()> {
        let list = self.store.list_snippets()?;
        write_json(&dir.join(FILE_SNIPPETS), &list)
    }

    // -- payload 导入 -----------------------------------------------------

    fn read_payload(&self, dir: &Path, scope: SyncScope) -> AppResult<usize> {
        let mut imported = 0;
        if matches!(scope, SyncScope::Config | SyncScope::All) {
            imported += self.import_config(dir)?;
            imported += self.import_connections(dir)?;
            if self.flags().sync.git_sync_secrets {
                self.import_secrets(dir)?;
            } else {
                log::info!("已按设置暂停同步 secrets.json，跳过导入");
            }
        }
        if matches!(scope, SyncScope::Snippets | SyncScope::All) {
            imported += self.import_snippets(dir)?;
        }
        Ok(imported)
    }

    fn import_config(&self, dir: &Path) -> AppResult<usize> {
        let path = dir.join(FILE_CONFIG);
        if !path.exists() {
            return Ok(0);
        }
        let text = std::fs::read_to_string(&path)?;
        let mut incoming: AppConfig = serde_yaml::from_str(&text)
            .map_err(|e| AppError::Config(format!("解析同步的 {} 失败：{e}", path.display())))?;
        let local = self.config.snapshot();
        // 同步设置本身是机器本地的（仓库路径、远端地址、作者），保留本地值，
        // 否则两台机器会把对方的路径覆盖过来。
        incoming.features.sync = local.features.sync.clone();
        self.config.replace(incoming)?;
        log::info!("已从同步仓库导入配置");
        Ok(1)
    }

    fn import_connections(&self, dir: &Path) -> AppResult<usize> {
        let path = dir.join(FILE_CONNECTIONS);
        if !path.exists() {
            return Ok(0);
        }
        let text = std::fs::read_to_string(&path)?;
        let incoming: Vec<StoredConnection> = serde_json::from_str(&text)
            .map_err(|e| AppError::Config(format!("解析同步的 {} 失败：{e}", path.display())))?;
        let count = incoming.len();
        for conn in &incoming {
            self.store.upsert_connection(conn)?;
        }
        Ok(count)
    }

    /// 用仓库里的加密保险库覆盖本地。
    ///
    /// 主密码一致时保持解锁、直接采用；不一致时暂存到保险库并广播冲突事件，
    /// 由前端引导用户选择「采用远端 / 保留本地 / 暂停同步」。
    fn import_secrets(&self, dir: &Path) -> AppResult<()> {
        let path = dir.join(FILE_SECRETS);
        if !path.exists() {
            return Ok(());
        }
        let bytes = std::fs::read(&path)?;
        match vault::import_bytes(&bytes)? {
            ImportOutcome::Conflict => {
                log::warn!("同步仓库中的保险库使用不同主密码，已广播冲突事件等待用户决策");
                if let Err(e) = self.app.emit(EVENT_VAULT_CONFLICT, ()) {
                    log::warn!("广播保险库冲突事件失败：{e}");
                }
            }
            ImportOutcome::Adopted => {
                log::info!("已导入加密保险库，需要输入主密码解锁")
            }
            ImportOutcome::Same => log::info!("已采用同步仓库中的保险库（主密码一致）"),
            ImportOutcome::Unchanged => {}
        }
        Ok(())
    }

    fn import_snippets(&self, dir: &Path) -> AppResult<usize> {
        let path = dir.join(FILE_SNIPPETS);
        if !path.exists() {
            return Ok(0);
        }
        let text = std::fs::read_to_string(&path)?;
        let incoming: Vec<SnippetRecord> = serde_json::from_str(&text)
            .map_err(|e| AppError::Config(format!("解析同步的 {} 失败：{e}", path.display())))?;
        let count = incoming.len();
        for snippet in &incoming {
            self.store.upsert_snippet(snippet)?;
        }
        Ok(count)
    }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/// 汇总本次同步的结果文案。冲突 / 跳过等已显式设置 `message` 时不覆盖。
fn finish(view: &mut SyncOutcomeView, notes: Vec<String>) {
    if !view.message.is_empty() {
        return;
    }
    let mut parts: Vec<String> = Vec::new();
    if let Some(sha) = &view.commit {
        parts.push(format!("提交 {}", &sha[..sha.len().min(7)]));
    }
    if view.pulled {
        parts.push(if view.pulled_fast_forward {
            "已快进拉取".to_string()
        } else {
            "已拉取并合并".to_string()
        });
    }
    if view.pushed {
        parts.push("已推送".to_string());
    }
    if view.imported > 0 {
        parts.push(format!("导入 {} 项", view.imported));
    }
    if parts.is_empty() && notes.is_empty() {
        parts.push("已是最新，无变更".to_string());
    }
    let mut message = parts.join("，");
    if !notes.is_empty() {
        if !message.is_empty() {
            message.push('，');
        }
        message.push_str(&notes.join("；"));
    }
    view.message = message;
}

/// 远端名规范化：留空时回退 `origin`。凭据按该名称存入加密保险库，两侧必须一致。
pub fn normalize_remote_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        "origin".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 读取某远端在加密保险库中的密码 / 访问令牌。不存在或读失败视为未配置。
fn stored_password(remote_name: &str) -> Option<String> {
    match secrets::get(&secrets::git_password_key(remote_name)) {
        Ok(Some(value)) if !value.is_empty() => Some(value),
        Ok(_) => None,
        Err(e) => {
            log::warn!("读取 Git 凭据失败（{remote_name}）：{e}");
            None
        }
    }
}

/// 把 `~` / `~/xxx` 展开为家目录。其余路径原样返回。
fn expand_tilde(input: &str) -> PathBuf {
    if input == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(input));
    }
    if let Some(rest) = input.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(input)
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(value)?;
    std::fs::write(path, text)?;
    Ok(())
}

fn hostname() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "localhost".to_string())
}

/// CLI 路径下的当前分支名。HEAD 尚无提交时 `symbolic-ref` 依旧可用。
fn cli_branch(dir: &Path) -> String {
    fallback::run(dir, &["symbolic-ref", "--short", "HEAD"], LOCAL_TIMEOUT)
        .map(|s| s.trim().to_string())
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "main".to_string())
}

/// CLI 路径下的未解决冲突文件。
fn cli_conflicts(dir: &Path) -> AppResult<Vec<String>> {
    let out = fallback::run(
        dir,
        &["diff", "--name-only", "--diff-filter=U"],
        LOCAL_TIMEOUT,
    )?;
    Ok(out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

fn as_args(owned: &[String]) -> Vec<&str> {
    owned.iter().map(|s| s.as_str()).collect()
}

// ---------------------------------------------------------------------------
// 模块接线
// ---------------------------------------------------------------------------

/// Git 同步模块。同步仅由用户手动触发，无后台任务、无运行期状态。
pub struct GitSyncModule;

impl GitSyncModule {
    pub fn new() -> Self {
        Self
    }
}

impl PluggableModule for GitSyncModule {
    fn id(&self) -> &'static str {
        module_id::GIT_SYNC
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.sync.git_sync
    }

    fn init(&self, _ctx: &ModuleContext) -> AppResult<()> {
        Ok(())
    }

    fn dispose(&self) -> AppResult<()> {
        Ok(())
    }
}