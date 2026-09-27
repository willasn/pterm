//! 远端凭据回调。
//!
//! 凭据来源优先级：
//! 1. 用户在「设置 → Git 同步 → 访问凭据」中配置的用户名 + 密码 / 访问令牌
//!    （HTTPS 场景；密码只存系统钥匙串，由调用方读入后传入本回调）；
//! 2. ssh-agent → 3. `~/.ssh` 私钥 → 4. git credential helper → 5. 仅用户名。
//!
//! 之所以先试 ssh-agent：日常使用中私钥通常已加载进 agent，命中后可以避免
//! 读取磁盘私钥，也不会因为私钥带 passphrase 而弹不出交互式密码框（Tauri 进程
//! 没有终端，任何交互式提示都会直接失败）。

use std::path::PathBuf;

use git2::{Config, Cred, CredentialType, RemoteCallbacks};

/// 依次尝试的默认私钥文件名。
const SSH_KEY_NAMES: [&str; 3] = ["id_ed25519", "id_ecdsa", "id_rsa"];

/// 一条显式配置的远端凭据。用户名来自配置，密码来自系统钥匙串。
#[derive(Debug, Clone)]
pub struct Credential {
    /// 对应的远端地址，用于与回调收到的 url 匹配
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// 构造带凭据回调的远端回调集合，供 clone / fetch / push 复用。
pub fn callbacks(credentials: Vec<Credential>) -> RemoteCallbacks<'static> {
    let mut cb = RemoteCallbacks::new();
    cb.credentials(move |url, username, allowed| {
        // 1) 用户在设置里显式配置的 HTTPS 账号 / 令牌。仅对 HTTP(S) 远端生效，
        //    避免覆盖 SSH 地址应有的用户名推断（如 `git@host`）。
        if is_http(url) {
            if let Some(cred) = credentials.iter().find(|c| same_remote(&c.url, url)) {
                if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
                    if let Some(password) = cred.password.as_deref() {
                        let user = cred
                            .username
                            .as_deref()
                            .filter(|u| !u.is_empty())
                            .or(username)
                            .unwrap_or_else(|| default_user(url));
                        return Cred::userpass_plaintext(user, password);
                    }
                }
                if allowed.contains(CredentialType::USERNAME) {
                    if let Some(user) = cred.username.as_deref().filter(|u| !u.is_empty()) {
                        return Cred::username(user);
                    }
                }
            }
        }

        let user = username.unwrap_or_else(|| default_user(url));

        // 2) ssh-agent：需要环境里存在 agent socket
        if allowed.contains(CredentialType::SSH_KEY) && agent_available() {
            match Cred::ssh_key_from_agent(user) {
                Ok(cred) => return Ok(cred),
                Err(e) => log::debug!("ssh-agent 不可用，继续尝试私钥：{e}"),
            }
        }

        // 3) ~/.ssh 下的默认私钥
        if allowed.contains(CredentialType::SSH_KEY) {
            if let Some(cred) = ssh_key_credential(user) {
                return Ok(cred);
            }
        }

        // 4) git credential helper（HTTPS 场景，读取系统存储的 token / 密码）
        if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            if let Ok(config) = Config::open_default() {
                match Cred::credential_helper(&config, url, username) {
                    Ok(cred) => return Ok(cred),
                    Err(e) => log::debug!("credential helper 未命中：{e}"),
                }
            }
        }

        // 5) HTTPS 走完以上分支仍无凭据：立刻给出可操作的提示，
        //    否则 libgit2 只会反复重试后报一句含糊的「认证失败」。
        //    若服务端同时接受 SSH 公钥，则继续走第 6 步，不提前失败。
        if is_http(url)
            && allowed.contains(CredentialType::USER_PASS_PLAINTEXT)
            && !allowed.contains(CredentialType::SSH_KEY)
        {
            return Err(git2::Error::from_str(&format!(
                "无法为 {url} 提供凭据：HTTPS 远端请在「设置 → Git 同步 → 访问凭据」填写用户名与密码 / 访问令牌，\
                 或在本机配置 git credential helper"
            )));
        }

        // 6) 只提供用户名，交由上层继续协商（例如 SSH 的 publickey 试探）
        if allowed.contains(CredentialType::USERNAME) {
            return Cred::username(user);
        }

        Err(git2::Error::from_str(&format!(
            "无法为 {url} 提供凭据，请配置「设置 → Git 同步 → 访问凭据」、ssh-agent 或 git credential helper"
        )))
    });
    cb
}

/// 回调收到的 url 是否与配置的远端地址一致。忽略首尾空白与末尾斜杠。
fn same_remote(configured: &str, incoming: &str) -> bool {
    normalize_url(configured) == normalize_url(incoming)
}

fn normalize_url(url: &str) -> &str {
    url.trim().trim_end_matches('/')
}

/// 是否为 HTTP(S) 远端。SSH / scp 风格地址不适用用户名密码分支。
fn is_http(url: &str) -> bool {
    let trimmed = url.trim();
    trimmed.starts_with("http://") || trimmed.starts_with("https://")
}

/// ssh-agent 是否可能可用。
fn agent_available() -> bool {
    std::env::var_os("SSH_AUTH_SOCK").is_some()
}

/// 从远端地址推断登录用户名。`git@github.com:foo/bar.git` 与
/// `ssh://git@host/path` 都会给出 `git`；无用户名时回退 `git`。
fn default_user(url: &str) -> &str {
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    // authority 在第一个 '/' 或 ':' 处结束（scp 风格：git@host:path）
    let authority = after_scheme.split(['/', ':']).next().unwrap_or(after_scheme);
    match authority.split_once('@') {
        Some((user, _)) if !user.is_empty() => user,
        _ => "git",
    }
}

/// 在 `~/.ssh` 中查找第一个存在的默认私钥并构造凭据。
fn ssh_key_credential(user: &str) -> Option<Cred> {
    let dir = ssh_dir()?;
    for name in SSH_KEY_NAMES {
        let private = dir.join(name);
        if !private.is_file() {
            continue;
        }
        let public = dir.join(format!("{name}.pub"));
        let public = if public.is_file() { Some(public) } else { None };
        // 带 passphrase 的私钥这里会失败，交由后续分支继续尝试
        match Cred::ssh_key(user, public.as_deref(), &private, None) {
            Ok(cred) => return Some(cred),
            Err(e) => log::debug!("私钥 {} 不可用：{e}", private.display()),
        }
    }
    None
}

fn ssh_dir() -> Option<PathBuf> {
    let dir = dirs::home_dir()?.join(".ssh");
    dir.is_dir().then_some(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_remote_ignores_whitespace_and_trailing_slash() {
        assert!(same_remote(
            " https://example.com/a/b.git/",
            "https://example.com/a/b.git"
        ));
        assert!(!same_remote(
            "https://example.com/a.git",
            "https://example.com/b.git"
        ));
    }

    #[test]
    fn detects_http_urls_only() {
        assert!(is_http("https://github.com/you/config.git"));
        assert!(is_http("http://host/repo.git"));
        assert!(!is_http("git@github.com:you/config.git"));
        assert!(!is_http("ssh://git@host/repo.git"));
    }
}
