//! 系统 `git` CLI 回退。
//!
//! 规范要求「Git 操作优先走 `git2`，仅在明确不支持时回退到系统 CLI，并记录回退原因」。
//! 因此本模块只在两种情况下被使用：
//!
//! 1. [`unsupported_reason`] 明确报告 libgit2 无法正确处理当前仓库状态；
//! 2. libgit2 操作失败且失败原因指向过滤器 / 协议等已知短板。
//!
//! 所有 CLI 调用都带超时，并且强制关闭交互式提示——Tauri 进程没有终端，
//! 任何等待输入的 git 进程都会永久挂起。

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use git2::Repository;

use crate::error::{AppError, AppResult};

/// 系统 git 版本号，如 `git version 2.39.3`。进程内只探测一次。
pub fn version() -> Option<String> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let out = Command::new("git")
                .arg("--version")
                .stdin(Stdio::null())
                .output()
                .ok()?;
            out.status
                .success()
                .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        })
        .clone()
}

/// 系统是否提供可用的 git CLI。
pub fn available() -> bool {
    version().is_some()
}

/// 判断仓库是否处于 libgit2 处理不完整的场景。返回 `None` 表示可以放心用 `git2`。
pub fn unsupported_reason(repo: &Repository) -> Option<String> {
    use git2::RepositoryState as S;
    match repo.state() {
        // 干净的仓库和普通的合并冲突是 pterm 自己处理的，不需要回退
        S::Clean | S::Merge => {}
        S::Rebase | S::RebaseInteractive | S::RebaseMerge => {
            return Some("仓库处于变基中，libgit2 的变基支持不完整".into())
        }
        S::CherryPick | S::CherryPickSequence => return Some("仓库处于 cherry-pick 中".into()),
        S::Revert | S::RevertSequence => return Some("仓库处于 revert 中".into()),
        S::Bisect => return Some("仓库处于 bisect 中".into()),
        S::ApplyMailbox | S::ApplyMailboxOrRebase => return Some("仓库处于 am 补丁应用中".into()),
    }
    if uses_lfs(repo) {
        return Some("仓库启用了 Git LFS，libgit2 不支持 LFS 过滤器".into());
    }
    None
}

/// 仓库是否声明了 LFS 过滤器。
fn uses_lfs(repo: &Repository) -> bool {
    let workdir_marker = repo.workdir().map(|d| d.join(".gitattributes"));
    let info_marker = Some(repo.path().join("info").join("attributes"));
    [workdir_marker, info_marker]
        .into_iter()
        .flatten()
        .any(|p| {
            std::fs::read_to_string(p)
                .map(|text| text.lines().any(|l| l.contains("filter=lfs")))
                .unwrap_or(false)
        })
}

/// 一次 CLI 调用的原始结果。非零退出码也是结果的一部分——`git status`
/// 满索引时会以 1 退出、`git pull` 冲突时也会非零退出，这些都需要拿到输出而非直接报错。
pub struct CliOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

impl CliOutput {
    /// 失败时的可读说明，优先取 stderr。
    pub fn error_detail(&self) -> String {
        let text = if self.stderr.trim().is_empty() {
            &self.stdout
        } else {
            &self.stderr
        };
        text.trim().to_string()
    }

    /// 成功时的标准输出（去掉首尾空白）。
    pub fn out(&self) -> String {
        self.stdout.trim().to_string()
    }
}

/// 在 `workdir` 中执行 git 子命令，返回标准输出。
///
/// 超过 `timeout` 直接杀掉进程并返回错误，满足「Git 网络请求需支持超时」。
pub fn run(workdir: &Path, args: &[&str], timeout: Duration) -> AppResult<String> {
    let out = run_output(workdir, args, timeout)?;
    if !out.success {
        return Err(AppError::Git(format!(
            "git {} 失败：{}",
            args.join(" "),
            out.error_detail()
        )));
    }
    Ok(out.stdout)
}

/// 同 [`run`]，但不把非零退出码当作错误，交由调用方判断。
pub fn run_output(workdir: &Path, args: &[&str], timeout: Duration) -> AppResult<CliOutput> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // 没有终端可交互，必须让 git 立刻失败而不是等待输入
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("GCM_INTERACTIVE", "never")
        .spawn()
        .map_err(|e| AppError::Git(format!("启动系统 git 失败：{e}")))?;

    let out_reader = child.stdout.take().map(|s| spawn_reader(s));
    let err_reader = child.stderr.take().map(|s| spawn_reader(s));

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::Git(format!("等待 git 进程失败：{e}")));
            }
        }
    };

    let stdout = out_reader.map(join_reader).unwrap_or_default();
    let stderr = err_reader.map(join_reader).unwrap_or_default();

    let Some(status) = status else {
        return Err(AppError::Git(format!(
            "git {} 超时（{}s），已终止",
            args.join(" "),
            timeout.as_secs()
        )));
    };

    Ok(CliOutput {
        success: status.success(),
        stdout,
        stderr,
    })
}

fn spawn_reader<R: Read + Send + 'static>(reader: R) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = std::io::BufReader::new(reader).read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    })
}

fn join_reader(handle: std::thread::JoinHandle<String>) -> String {
    handle.join().unwrap_or_default()
}