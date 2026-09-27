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
    let name = if name.trim().is_empty() { "pshell" } else { name };
    let email = if email.trim().is_empty() {
        "pshell@localhost"
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
                .set_target(target.id(), "pshell: fast-forward")
                .map_err(|e| AppError::Git(format!("更新分支失败：{e}")))?;
        }
        Err(_) => {
            repo.reference(&refname, target.id(), true, "pshell: 创建分支")
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

/// 冲突保留策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictStrategy {
    /// 保留本地版本
    KeepLocal,
    /// 保留远端版本
    KeepRemote,
}

/// 按策略解决全部冲突并生成合并提交。返回解决的文件数。
pub fn resolve_conflicts(
    repo: &Repository,
    strategy: ConflictStrategy,
    message: &str,
    name: &str,
    email: &str,
) -> AppResult<usize> {
    let mut index = repo.index()?;
    // `IndexEntry` 未实现 `Clone`，因此把选中的条目从 `IndexConflict` 中直接移出
    let mut chosen: Vec<git2::IndexEntry> = Vec::new();
    {
        let conflicts = index
            .conflicts()
            .map_err(|e| AppError::Git(format!("读取冲突失败：{e}")))?;
        for conflict in conflicts {
            let mut conflict = conflict.map_err(|e| AppError::Git(format!("读取冲突失败：{e}")))?;
            let picked = match strategy {
                ConflictStrategy::KeepLocal => conflict.our.take().or(conflict.ancestor.take()),
                ConflictStrategy::KeepRemote => conflict.their.take().or(conflict.ancestor.take()),
            };
            if let Some(mut entry) = picked {
                // 清除 stage 位（GIT_INDEX_ENTRY_STAGEMASK = 0x3000），使其成为 stage-0 条目
                entry.flags &= !0x3000;
                chosen.push(entry);
            }
        }
    }
    if chosen.is_empty() {
        return Ok(0);
    }

    // 先清掉三路索引条目，再写入选定的 stage-0 条目
    for entry in &chosen {
        let path = String::from_utf8_lossy(&entry.path).into_owned();
        let _ = index.remove_path(Path::new(&path));
    }
    for entry in &chosen {
        index
            .add(entry)
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
        let dir = std::env::temp_dir().join(format!("pshell-git-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        (repo, dir)
    }

    fn oid(hex: char) -> Oid {
        Oid::from_str(&hex.to_string().repeat(40)).unwrap()
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