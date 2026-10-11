//! 基于 `git2`（进程内 libgit2）的仓库操作。
//!
//! 本文件只负责「仓库层」：打开 / 克隆 / 抓取 / 合并 / 提交 / 推送 / 状态 / 差异。
//! 与配置、界面相关的编排逻辑在 [`super`] 中；libgit2 明确不支持的场景由
//! [`super::fallback`] 处理。**不依赖系统 git CLI**。

use std::path::Path;

use git2::{
    build::CheckoutBuilder, DiffFormat, IndexAddOption, Oid, Repository, RepositoryInitOptions,
    Signature, StatusOptions,
};

use crate::error::{AppError, AppResult};

use super::auth;

/// 本地分支尚未有提交时使用的主分支名。
const DEFAULT_BRANCH: &str = "main";

/// 默认远端抓取 refspec，用于仓库自身未配置 fetch refspec 时兜底。
fn default_refspec(remote: &str) -> String {
    format!("+refs/heads/*:refs/remotes/{remote}/*")
}

/// 打开仓库；目录不存在时按 `main` 初始化一个空仓库。
pub fn open_or_init(path: &Path) -> AppResult<Repository> {
    if path.join(".git").exists() {
        return Repository::open(path).map_err(|e| AppError::Git(format!("打开仓库失败：{e}")));
    }
    std::fs::create_dir_all(path)?;
    let mut opts = RepositoryInitOptions::new();
    opts.initial_head(DEFAULT_BRANCH);
    Repository::init_opts(path, &opts).map_err(|e| AppError::Git(format!("初始化仓库失败：{e}")))
}

/// 只打开、不初始化。目录不存在或不是仓库时返回 `None`。
pub fn try_open(path: &Path) -> Option<Repository> {
    if !path.join(".git").exists() {
        return None;
    }
    Repository::open(path).ok()
}

/// 从远端克隆到本地目录。目录已有仓库时拒绝，避免覆盖用户数据。
pub fn clone(url: &str, path: &Path, credentials: Vec<auth::Credential>) -> AppResult<()> {
    if path.join(".git").exists() {
        return Err(AppError::Git(format!(
            "目标目录已存在仓库：{}",
            path.display()
        )));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut fetch = git2::FetchOptions::new();
    fetch.remote_callbacks(auth::callbacks(credentials));
    let mut builder = git2::build::RepoBuilder::new();
    builder.fetch_options(fetch);
    builder
        .clone(url, path)
        .map_err(|e| AppError::Git(format!("克隆 {url} 失败：{e}")))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 连接自检
// ---------------------------------------------------------------------------

/// 远端引用探测结果（等价于 `git ls-remote`）。
#[derive(Debug, Clone, Default)]
pub struct RemoteProbe {
    /// 远端引用条目数
    pub refs: usize,
    /// 远端默认分支，如 `refs/heads/main`
    pub default_branch: Option<String>,
}

/// 只连接远端并读取引用列表，用于「测试连接」：一次握手即可同时验证
/// 地址可达、凭据（用户名 / 密码 / 令牌）有效。
///
/// 用一个临时裸仓库承载匿名远端，因此既不读写用户的同步仓库，也不产生提交；
/// 结束后连同临时目录一起清理。
pub fn probe_remote(url: &str, credentials: Vec<auth::Credential>) -> AppResult<RemoteProbe> {
    let dir = std::env::temp_dir().join(format!("pterm-git-probe-{}", uuid::Uuid::new_v4()));
    let outcome = probe_at(&dir, url, credentials);
    let _ = std::fs::remove_dir_all(&dir);
    outcome
}

fn probe_at(dir: &Path, url: &str, credentials: Vec<auth::Credential>) -> AppResult<RemoteProbe> {
    let repo = Repository::init_bare(dir)
        .map_err(|e| AppError::Git(format!("初始化探测仓库失败：{e}")))?;
    let mut remote = repo
        .remote_anonymous(url)
        .map_err(|e| AppError::Git(format!("解析远端地址失败：{e}")))?;
    let connection = remote
        .connect_auth(git2::Direction::Fetch, Some(auth::callbacks(credentials)), None)
        .map_err(|e| AppError::Git(format!("连接 {url} 失败：{e}")))?;
    // 引用列表要等握手（含鉴权）完成后才拿得到，因此读到它就说明凭据通过了
    let refs = connection
        .list()
        .map_err(|e| AppError::Git(format!("读取远端引用失败：{e}")))?
        .len();
    let default_branch = connection
        .default_branch()
        .ok()
        .and_then(|buf| String::from_utf8(buf.to_vec()).ok())
        .filter(|s| !s.trim().is_empty());
    Ok(RemoteProbe {
        refs,
        default_branch,
    })
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/// 仓库状态快照，供界面显示 ahead/behind、脏文件数、冲突。
#[derive(Debug, Clone, Default)]
pub struct RepoStatus {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub dirty: usize,
    pub untracked: usize,
    pub conflicts: Vec<String>,
}

impl RepoStatus {
    pub fn is_clean(&self) -> bool {
        self.dirty == 0 && self.untracked == 0 && self.conflicts.is_empty()
    }
}

/// HEAD 是否还没有任何提交。
pub fn is_unborn(repo: &Repository) -> bool {
    repo.head().is_err()
}

/// 当前分支名。HEAD 尚未有提交时返回默认主分支名。
pub fn current_branch(repo: &Repository) -> String {
    match repo.head() {
        Ok(head) => head.shorthand().unwrap_or("HEAD").to_string(),
        Err(_) => DEFAULT_BRANCH.to_string(),
    }
}

/// 统计工作区状态。`remote` 用于解析 upstream 以计算 ahead/behind。
pub fn status(repo: &Repository, remote: &str) -> AppResult<RepoStatus> {
    let mut out = RepoStatus {
        branch: if is_unborn(repo) {
            None
        } else {
            Some(current_branch(repo))
        },
        ..Default::default()
    };

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .exclude_submodules(true);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| AppError::Git(format!("读取仓库状态失败：{e}")))?;
    for entry in statuses.iter() {
        let s = entry.status();
        let path = entry.path().unwrap_or("").to_string();
        if s.is_conflicted() {
            if !out.conflicts.contains(&path) {
                out.conflicts.push(path);
            }
        } else if s.is_wt_new() {
            out.untracked += 1;
        } else {
            out.dirty += 1;
        }
    }

    if let Some(branch) = out.branch.clone() {
        if let Some((ahead, behind)) = ahead_behind(repo, remote, &branch) {
            out.upstream = Some(format!("{remote}/{branch}"));
            out.ahead = ahead;
            out.behind = behind;
        }
    }
    Ok(out)
}

/// 相对 `remote/branch` 的领先 / 落后提交数。找不到上游引用时返回 `None`。
pub fn ahead_behind(repo: &Repository, remote: &str, branch: &str) -> Option<(usize, usize)> {
    let reference = repo
        .find_reference(&format!("refs/remotes/{remote}/{branch}"))
        .ok()?;
    let upstream = reference.peel_to_commit().ok()?;
    let local = repo.head().ok()?.peel_to_commit().ok()?;
    repo.graph_ahead_behind(local.id(), upstream.id()).ok()
}

// ---------------------------------------------------------------------------
// 提交
// ---------------------------------------------------------------------------

/// 工作区是否有需要提交的内容（含未跟踪文件）。
pub fn has_changes(repo: &Repository) -> AppResult<bool> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| AppError::Git(format!("读取仓库状态失败：{e}")))?;
    Ok(!statuses.is_empty())
}

/// 工作区变更条目数（含未跟踪文件），用于提交信息模板的 `{count}`。
pub fn change_count(repo: &Repository) -> AppResult<usize> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| AppError::Git(format!("读取仓库状态失败：{e}")))?;
    Ok(statuses.len())
}

fn signature(name: &str, email: &str) -> AppResult<Signature<'static>> {
    let name = if name.trim().is_empty() { "pterm" } else { name };
    let email = if email.trim().is_empty() {
        "pterm@localhost"
    } else {
        email
    };
    Signature::now(name, email).map_err(|e| AppError::Git(format!("构造提交签名失败：{e}")))
}

/// 暂存全部改动并提交。无改动时返回 `None`。
pub fn commit_all(
    repo: &Repository,
    message: &str,
    name: &str,
    email: &str,
) -> AppResult<Option<Oid>> {
    if !has_changes(repo)? {
        return Ok(None);
    }
    let mut index = repo
        .index()
        .map_err(|e| AppError::Git(format!("打开索引失败：{e}")))?;
    // 先加入新增/修改文件，再同步删除，保证索引与工作区一致
    index
        .add_all(vec!["*".to_string()], IndexAddOption::DEFAULT, None)
        .map_err(|e| AppError::Git(format!("暂存文件失败：{e}")))?;
    index
        .update_all(vec!["*".to_string()], None)
        .map_err(|e| AppError::Git(format!("同步索引失败：{e}")))?;
    index
        .write()
        .map_err(|e| AppError::Git(format!("写入索引失败：{e}")))?;
    let tree_id = index
        .write_tree()
        .map_err(|e| AppError::Git(format!("写入 tree 失败：{e}")))?;
    let tree = repo
        .find_tree(tree_id)
        .map_err(|e| AppError::Git(format!("读取 tree 失败：{e}")))?;

    // HEAD 可能尚未有提交（首次同步），此时提交没有父节点
    let parent = match repo.head() {
        Ok(head) => head.peel_to_commit().ok(),
        Err(_) => None,
    };

    // 内容与父提交完全一致时不再产生空提交
    if let Some(parent) = &parent {
        if parent.tree_id() == tree_id {
            return Ok(None);
        }
    }

    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let sig = signature(name, email)?;
    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| AppError::Git(format!("提交失败：{e}")))?;
    Ok(Some(oid))
}

// ---------------------------------------------------------------------------
// 抓取与合并
// ---------------------------------------------------------------------------

/// 抓取远端更新。
pub fn fetch(
    repo: &Repository,
    remote_name: &str,
    credentials: &[auth::Credential],
) -> AppResult<()> {
    let mut remote = repo
        .find_remote(remote_name)
        .map_err(|e| AppError::Git(format!("找不到远端 {remote_name}：{e}")))?;
    // 仓库未配置 fetch refspec 时（如仅设置了 push url）用默认规则兜底
    let configured: Vec<String> = remote
        .fetch_refspecs()
        .map_err(|e| AppError::Git(format!("读取 fetch refspec 失败：{e}")))?
        .iter()
        .flatten()
        .map(|s| s.to_string())
        .collect();
    let owned = if configured.is_empty() {
        vec![default_refspec(remote_name)]
    } else {
        configured
    };
    let refspecs: Vec<&str> = owned.iter().map(|s| s.as_str()).collect();

    let mut opts = git2::FetchOptions::new();
    opts.remote_callbacks(auth::callbacks(credentials.to_vec()));
    remote
        .fetch(&refspecs, Some(&mut opts), None)
        .map_err(|e| AppError::Git(format!("抓取 {remote_name} 失败：{e}")))
}

/// 一次 pull 的结果。
#[derive(Debug, Clone, Default)]
pub struct PullOutcome {
    /// 是否有更新落地
    pub updated: bool,
    /// 是否为快进合并
    pub fast_forward: bool,
    /// 合并冲突文件（非空表示仓库停在冲突状态，等待用户选择策略）
    pub conflicts: Vec<String>,
}

/// 拉取远端更新到当前分支。
///
/// 能快进则快进；需要真正的合并时执行 `merge`，若产生冲突则**不自动解决**，
/// 直接返回冲突列表，仓库保持冲突状态，交由用户选择保留策略。
pub fn pull(
    repo: &Repository,
    remote_name: &str,
    branch: &str,
    name: &str,
    email: &str,
    credentials: &[auth::Credential],
) -> AppResult<PullOutcome> {
    fetch(repo, remote_name, credentials)?;

    // FETCH_HEAD 不是普通引用（内容是 `oid\t\t描述`），用 `find_reference` 会被
    // libgit2 当作松散引用解析并报「corrupted loose reference file」。
    // 因此改走 fetchhead API，按远端分支名取本次抓取到的提交。
    let Some(oid) = fetch_head_target(repo, branch)? else {
        // 远端没有同名分支（或本次未抓到任何引用）：视为无可合并更新，
        // 保持本地不动，后续推送会把本地分支建到远端。
        return Ok(PullOutcome::default());
    };
    let target = repo
        .find_annotated_commit(oid)
        .map_err(|e| AppError::Git(format!("解析远端提交失败：{e}")))?;

    if is_unborn(repo) {
        adopt(repo, &target, branch)?;
        return Ok(PullOutcome {
            updated: true,
            fast_forward: true,
            conflicts: Vec::new(),
        });
    }

    let (analysis, _) = repo
        .merge_analysis(&[&target])
        .map_err(|e| AppError::Git(format!("分析合并类型失败：{e}")))?;

    if analysis.is_up_to_date() {
        return Ok(PullOutcome::default());
    }
    if analysis.is_fast_forward() {
        adopt(repo, &target, branch)?;
        return Ok(PullOutcome {
            updated: true,
            fast_forward: true,
            conflicts: Vec::new(),
        });
    }

    // 正常合并：先合并进索引与工作区
    repo.merge(&[&target], None, None)
        .map_err(|e| AppError::Git(format!("合并失败：{e}")))?;
    let conflicts = collect_conflicts(repo)?;
    if !conflicts.is_empty() {
        return Ok(PullOutcome {
            updated: true,
            fast_forward: false,
            conflicts,
        });
    }

    // 无冲突，直接生成合并提交
    let mut index = repo.index()?;
    let tree = repo.find_tree(
        index
            .write_tree()
            .map_err(|e| AppError::Git(format!("写入 tree 失败：{e}")))?,
    )?;
    let head = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| AppError::Git(format!("读取 HEAD 失败：{e}")))?;
    let theirs = repo
        .find_commit(target.id())
        .map_err(|e| AppError::Git(format!("读取远端提交失败：{e}")))?;
    let sig = signature(name, email)?;
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        &format!("merge: 合并远端 {remote_name}/{branch}"),
        &tree,
        &[&head, &theirs],
    )
    .map_err(|e| AppError::Git(format!("生成合并提交失败：{e}")))?;
    repo.cleanup_state()
        .map_err(|e| AppError::Git(format!("清理合并状态失败：{e}")))?;
    Ok(PullOutcome {
        updated: true,
        fast_forward: false,
        conflicts: Vec::new(),
    })
}

/// 从 FETCH_HEAD 中取出本次抓取到、且与本地分支同名的远端提交。
///
/// FETCH_HEAD 不是普通引用（内容是 `oid\t<not-for-merge>\t描述`），用
/// `find_reference` 会被 libgit2 当作松散引用解析并报「corrupted loose
/// reference file」。所以这里走 fetchhead API，并且只认 `refs/heads/{branch}`：
/// 通配 refspec 下 FETCH_HEAD 会带上远端所有分支，按名字筛选才不会把别的分支
/// 合并进来。没有匹配项即表示远端没有同名分支，返回 `None`。
fn fetch_head_target(repo: &Repository, branch: &str) -> AppResult<Option<Oid>> {
    // 远端为空时 libgit2 可能根本不写 FETCH_HEAD，缺文件按「无更新」处理
    if !repo.path().join("FETCH_HEAD").is_file() {
        return Ok(None);
    }
    let want = format!("refs/heads/{branch}");
    let mut found: Option<Oid> = None;
    repo.fetchhead_foreach(|name, _url, oid, _is_merge| {
        if name == want || name == branch {
            found = Some(*oid);
            return false; // 命中目标分支，无需继续遍历
        }
        true
    })
    .map_err(|e| AppError::Git(format!("读取 FETCH_HEAD 失败：{e}")))?;
    Ok(found)
}

/// 把分支指向远端提交并检出（快进 / 首次落地）。
fn adopt(repo: &Repository, target: &git2::AnnotatedCommit, branch: &str) -> AppResult<()> {
    let refname = format!("refs/heads/{branch}");
    match repo.find_reference(&refname) {
        Ok(mut reference) => {
            reference
                .set_target(target.id(), "pterm: fast-forward")
                .map_err(|e| AppError::Git(format!("更新分支失败：{e}")))?;
        }
        Err(_) => {
            repo.reference(&refname, target.id(), true, "pterm: 创建分支")
                .map_err(|e| AppError::Git(format!("创建分支失败：{e}")))?;
        }
    }
    repo.set_head(&refname)
        .map_err(|e| AppError::Git(format!("切换 HEAD 失败：{e}")))?;
    let mut checkout = CheckoutBuilder::new();
    checkout.force();
    repo.checkout_head(Some(&mut checkout))
        .map_err(|e| AppError::Git(format!("检出工作区失败：{e}")))?;
    Ok(())
}

/// 索引中的冲突文件列表。
pub fn collect_conflicts(repo: &Repository) -> AppResult<Vec<String>> {
    let mut index = repo.index()?;
    let mut out: Vec<String> = Vec::new();
    let conflicts = index
        .conflicts()
        .map_err(|e| AppError::Git(format!("读取冲突失败：{e}")))?;
    for conflict in conflicts {
        let conflict = conflict.map_err(|e| AppError::Git(format!("读取冲突失败：{e}")))?;
        if let Some(entry) = conflict
            .our
            .as_ref()
            .or(conflict.their.as_ref())
            .or(conflict.ancestor.as_ref())
        {
            let path = String::from_utf8_lossy(&entry.path).into_owned();
            if !out.contains(&path) {
                out.push(path);
            }
        }
    }
    Ok(out)
}

/// 单个冲突文件的解决方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictPick {
    /// 保留本地版本
    Ours,
    /// 保留远端版本
    Theirs,
    /// 保留双方：按 JSON 数组按 `id` 合并，同 id 时保留远端、本地那份另起新 id 一并保留
    Union,
}

/// 冲突两侧的索引条目（oid + 文件模式）。
type SideEntry = Option<(Oid, u32)>;

/// 按文件逐个决定解决方式并生成合并提交。返回解决的文件数。
///
/// `picker` 收到冲突文件路径（相对仓库根，如 `connections.json`），返回该文件的处理方式；
/// 未登记的路径由调用方决定。非 `Union` 时直接取对应版本的 blob，`Union` 则解析两侧
/// JSON 数组合并后写入新 blob。
pub fn resolve_conflicts_with<F>(
    repo: &Repository,
    picker: F,
    message: &str,
    name: &str,
    email: &str,
) -> AppResult<usize>
where
    F: Fn(&str) -> ConflictPick,
{
    let mut index = repo.index()?;
    // `IndexEntry` 未实现 `Clone`，这里只保留计算所需的路径 / oid / 模式
    let mut items: Vec<(String, SideEntry, SideEntry, SideEntry)> = Vec::new();
    {
        let conflicts = index
            .conflicts()
            .map_err(|e| AppError::Git(format!("读取冲突失败：{e}")))?;
        for conflict in conflicts {
            let conflict = conflict.map_err(|e| AppError::Git(format!("读取冲突失败：{e}")))?;
            let entry_side = |e: Option<&git2::IndexEntry>| e.map(|e| (e.id, e.mode));
            let path = conflict
                .our
                .as_ref()
                .or(conflict.their.as_ref())
                .or(conflict.ancestor.as_ref())
                .map(|e| String::from_utf8_lossy(&e.path).into_owned());
            let Some(path) = path else { continue };
            items.push((
                path,
                entry_side(conflict.our.as_ref()),
                entry_side(conflict.their.as_ref()),
                entry_side(conflict.ancestor.as_ref()),
            ));
        }
    }
    if items.is_empty() {
        return Ok(0);
    }

    let mut chosen: Vec<(String, Oid, u32)> = Vec::new();
    for (path, ours, theirs, ancestor) in &items {
        match picker(path) {
            ConflictPick::Ours => {
                if let Some((oid, mode)) = ours.or(*ancestor) {
                    chosen.push((path.clone(), oid, mode));
                }
            }
            ConflictPick::Theirs => {
                if let Some((oid, mode)) = theirs.or(*ancestor) {
                    chosen.push((path.clone(), oid, mode));
                }
            }
            ConflictPick::Union => {
                let oid = merge_union_blob(repo, ours.map(|s| s.0), theirs.map(|s| s.0))?;
                let mode = ours.or(*theirs).or(*ancestor).map(|s| s.1).unwrap_or(0o100644);
                chosen.push((path.clone(), oid, mode));
            }
        }
    }

    // 先清掉三路索引条目，再写入 stage-0 条目
    for (path, _, _, _) in &items {
        let _ = index.remove_path(Path::new(path));
    }
    for (path, oid, mode) in &chosen {
        let entry = git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: *mode,
            uid: 0,
            gid: 0,
            file_size: 0,
            id: *oid,
            flags: 0,
            flags_extended: 0,
            path: path.as_bytes().to_vec(),
        };
        index
            .add(&entry)
            .map_err(|e| AppError::Git(format!("写入冲突解决结果失败：{e}")))?;
    }
    index
        .write()
        .map_err(|e| AppError::Git(format!("写入索引失败：{e}")))?;

    // 让工作区与索引一致（否则文件里仍留着冲突标记）
    let mut checkout = CheckoutBuilder::new();
    checkout.force();
    repo.checkout_index(Some(&mut index), Some(&mut checkout))
        .map_err(|e| AppError::Git(format!("检出解决结果失败：{e}")))?;

    let tree = repo.find_tree(
        index
            .write_tree()
            .map_err(|e| AppError::Git(format!("写入 tree 失败：{e}")))?,
    )?;
    let sig = signature(name, email)?;
    let head = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|e| AppError::Git(format!("读取 HEAD 失败：{e}")))?;
    let merge_heads: Vec<git2::Commit> = merge_head_ids(repo)
        .into_iter()
        .filter_map(|id| repo.find_commit(id).ok())
        .collect();
    let mut parents: Vec<&git2::Commit> = vec![&head];
    parents.extend(merge_heads.iter());
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| AppError::Git(format!("生成合并提交失败：{e}")))?;
    repo.cleanup_state()
        .map_err(|e| AppError::Git(format!("清理合并状态失败：{e}")))?;
    Ok(chosen.len())
}

/// 读取 MERGE_HEAD 中的提交 id 列表（仓库处于合并中时有值）。
///
/// git2 0.19 未提供 `Repository::mergehead()`，只有需要 `&mut self` 的
/// `mergehead_foreach`，这里直接读文件更简单。
fn merge_head_ids(repo: &Repository) -> Vec<Oid> {
    let path = repo.path().join("MERGE_HEAD");
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines().filter_map(|l| l.trim().parse().ok()).collect()
}

/// 读取 blob 内容。oid 缺失或读取失败时返回空。
fn blob_content(repo: &Repository, oid: Option<Oid>) -> Vec<u8> {
    oid.and_then(|oid| repo.find_blob(oid).ok())
        .map(|blob| blob.content().to_vec())
        .unwrap_or_default()
}

/// 把冲突两侧的 JSON 数组合并成一个新 blob。
fn merge_union_blob(repo: &Repository, ours: Option<Oid>, theirs: Option<Oid>) -> AppResult<Oid> {
    let ours = blob_content(repo, ours);
    let theirs = blob_content(repo, theirs);
    let merged = union_json_arrays(&ours, &theirs);
    repo.blob(&merged)
        .map_err(|e| AppError::Git(format!("写入合并结果失败：{e}")))
}

/// 合并两个 JSON 数组（连接 / 片段等 payload）。
///
/// 远端条目在前、保留其 `id`；本地条目逐个并入，遇到与远端相同的 `id` 时
/// 说明同一条记录两边都改过，「两者保留」下给本地那份另起一个新 `id` 并一并保留
/// （因此可能出现重名条目）。任一侧不是可解析的 JSON 数组时退回远端内容。
pub fn union_json_arrays(ours: &[u8], theirs: &[u8]) -> Vec<u8> {
    use std::collections::HashSet;

    let local: serde_json::Value = serde_json::from_slice(ours).unwrap_or(serde_json::Value::Null);
    let remote: serde_json::Value =
        serde_json::from_slice(theirs).unwrap_or(serde_json::Value::Null);
    let (serde_json::Value::Array(local), serde_json::Value::Array(remote)) = (local, remote) else {
        return if theirs.is_empty() { ours.to_vec() } else { theirs.to_vec() };
    };

    let id_of = |v: &serde_json::Value| -> Option<String> {
        v.get("id").and_then(|x| x.as_str()).map(str::to_string)
    };

    let mut out = remote.clone();
    let mut seen: HashSet<String> = remote.iter().filter_map(id_of).collect();
    for item in local {
        match id_of(&item) {
            Some(id) if seen.contains(&id) => {
                let mut copy = item;
                let new_id = uuid::Uuid::new_v4().to_string();
                if let serde_json::Value::Object(map) = &mut copy {
                    map.insert("id".to_string(), serde_json::Value::String(new_id.clone()));
                }
                seen.insert(new_id);
                out.push(copy);
            }
            Some(id) => {
                seen.insert(id);
                out.push(item);
            }
            None => out.push(item),
        }
    }
    serde_json::to_vec_pretty(&serde_json::Value::Array(out))
        .unwrap_or_else(|_| theirs.to_vec())
}

// ---------------------------------------------------------------------------
// 推送
// ---------------------------------------------------------------------------

/// 推送当前分支到远端。`target_branch` 为空时推送到同名分支。
pub fn push(
    repo: &Repository,
    remote_name: &str,
    branch: &str,
    target_branch: Option<&str>,
    credentials: &[auth::Credential],
) -> AppResult<()> {
    let mut remote = repo
        .find_remote(remote_name)
        .map_err(|e| AppError::Git(format!("找不到远端 {remote_name}：{e}")))?;
    let target = target_branch.unwrap_or(branch);
    let refspec = format!("refs/heads/{branch}:refs/heads/{target}");
    let mut opts = git2::PushOptions::new();
    opts.remote_callbacks(auth::callbacks(credentials.to_vec()));
    remote
        .push(&[refspec.as_str()], Some(&mut opts))
        .map_err(|e| AppError::Git(format!("推送 {remote_name}/{target} 失败：{e}")))
}

/// 远端是否已存在于仓库配置中。
pub fn has_remote(repo: &Repository, name: &str) -> bool {
    repo.find_remote(name).is_ok()
}

/// 登记或更新远端地址。已存在时更新 URL，不报错。
pub fn set_remote(repo: &Repository, name: &str, url: &str) -> AppResult<()> {
    match repo.find_remote(name) {
        Ok(existing) => {
            if existing.url() != Some(url) {
                repo.remote_set_url(name, url)
                    .map_err(|e| AppError::Git(format!("更新远端 {name} 失败：{e}")))?;
            }
        }
        Err(_) => {
            repo.remote(name, url)
                .map_err(|e| AppError::Git(format!("配置远端 {name} 失败：{e}")))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 差异
// ---------------------------------------------------------------------------

/// 工作区 + 索引相对 HEAD 的 unified diff。
///
/// 必须显式以 HEAD 的 tree 为基线并开启未跟踪文件：只有 payload 全是新增文件时
/// （首次同步），以索引为基线会得到一份空白差异。
pub fn diff(repo: &Repository) -> AppResult<String> {
    let mut opts = git2::DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let diff = repo
        .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))
        .map_err(|e| AppError::Git(format!("生成差异失败：{e}")))?;
    let mut out = String::new();
    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        if matches!(origin, '+' | '-' | ' ') {
            out.push(origin);
        }
        out.push_str(&String::from_utf8_lossy(line.content()));
        true
    })
    .map_err(|e| AppError::Git(format!("输出差异失败：{e}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    /// 建一个临时空仓库。返回仓库与目录，测试结束由调用方清理。
    fn temp_repo(tag: &str) -> (Repository, PathBuf) {
        let dir = std::env::temp_dir().join(format!("pterm-git-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        (repo, dir)
    }

    fn oid(hex: char) -> Oid {
        Oid::from_str(&hex.to_string().repeat(40)).unwrap()
    }

    /// 连接探测应能连上远端并拿到引用列表（用本地裸仓库替代网络远端）。
    #[test]
    fn probe_remote_lists_refs() {
        let dir = std::env::temp_dir().join(format!("pterm-git-probe-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let repo = Repository::init_bare(&dir).unwrap();
        let sig = git2::Signature::now("t", "t@localhost").unwrap();
        let tree_id = repo.index().unwrap().write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(Some("refs/heads/main"), &sig, &sig, "init", &tree, &[])
            .unwrap();
        drop(tree);

        let probe = probe_remote(dir.to_str().unwrap(), Vec::new()).unwrap();
        assert!(probe.refs >= 1, "至少应看到 refs/heads/main");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 通配 refspec 下 FETCH_HEAD 含多个分支，必须只挑出与本地分支同名的那条。
    /// 回归：旧实现用 `find_reference("FETCH_HEAD")` 会报
    /// 「corrupted loose reference file: FETCH_HEAD」。
    #[test]
    fn fetch_head_target_picks_matching_branch() {
        let (repo, dir) = temp_repo("fetchhead");
        let dev = oid('1');
        let main = oid('2');
        let body = format!(
            "{dev}\tnot-for-merge\tbranch 'dev' of https://example.com/r.git\n\
             {main}\t\tbranch 'main' of https://example.com/r.git\n"
        );
        std::fs::write(repo.path().join("FETCH_HEAD"), body).unwrap();

        assert_eq!(fetch_head_target(&repo, "main").unwrap(), Some(main));
        assert_eq!(fetch_head_target(&repo, "dev").unwrap(), Some(dev));
        // 远端没有同名分支时不应误合并其它分支
        assert_eq!(fetch_head_target(&repo, "feature").unwrap(), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 远端为空（libgit2 不写 FETCH_HEAD）时应视为无更新，而不是报错。
    #[test]
    fn fetch_head_target_missing_file_is_noop() {
        let (repo, dir) = temp_repo("fetchhead-missing");
        assert_eq!(fetch_head_target(&repo, "main").unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}