use std::path::{Path, PathBuf};

use ssh2::{KeyboardInteractivePrompt, Prompt, Session};

use crate::config::store::secrets;
use crate::error::{AppError, AppResult};

use super::interactive::{InteractivePrompter, PromptOutcome};
use super::types::{AuthSpec, ConnectParams};

/// 认证成功后返回所用方式的可读名称，供界面展示。
///
/// `prompter` 为 `None` 时（测试连接、SFTP / 端口转发 / 跳板机等后台连接），
/// 键盘交互认证无法弹窗，只能用静态应答（`password` 或保险库中的密码）。
pub fn authenticate(
    sess: &Session,
    params: &ConnectParams,
    prompter: Option<&InteractivePrompter>,
) -> AppResult<String> {
    if sess.authenticated() {
        return Ok("none".into());
    }

    let user = params.username.as_str();
    // 服务端允许的认证方式，形如 "publickey,password"。拿不到时按空串处理（逐一尝试）。
    let methods = match sess.auth_methods(user) {
        Ok(m) => m.to_string(),
        Err(e) => {
            log::debug!("无法获取 {} 的认证方式列表：{e}", params.host);
            String::new()
        }
    };
    log::info!(
        "连接 {} 支持的认证方式：[{}]",
        params.endpoint(),
        if methods.is_empty() { "未知" } else { &methods }
    );

    match &params.auth {
        AuthSpec::Password { password } => {
            let pwd = password
                .clone()
                .or_else(|| stored_secret(params.connection_id.as_deref(), SecretKind::Password));
            let Some(pwd) = pwd else {
                return Err(AppError::Auth(format!(
                    "{}：未提供密码，且保险库中没有记录",
                    params.endpoint()
                )));
            };
            try_password(sess, user, &pwd)?;
            Ok("password".into())
        }

        AuthSpec::PrivateKey {
            key_path,
            passphrase,
        } => {
            let path = expand_home(key_path)?;
            let pass = passphrase
                .clone()
                .or_else(|| stored_secret(params.connection_id.as_deref(), SecretKind::Passphrase));
            try_key(sess, user, &path, pass.as_deref())?;
            Ok(format!("publickey:{}", path.display()))
        }

        AuthSpec::Agent => {
            try_agent(sess, user)?;
            Ok("agent".into())
        }

        AuthSpec::KeyboardInteractive { password } => {
            let answer = password.clone().or_else(|| {
                stored_secret(params.connection_id.as_deref(), SecretKind::Password)
            });
            try_keyboard_interactive(sess, user, prompter, answer.as_deref())?;
            Ok("keyboard-interactive".into())
        }

        AuthSpec::Auto => auto_authenticate(sess, user, params, &methods, prompter),
    }
}

/// 自动模式：agent → 默认私钥 → 保险库密码 → 键盘交互。返回首个成功的方式。
fn auto_authenticate(
    sess: &Session,
    user: &str,
    params: &ConnectParams,
    methods: &str,
    prompter: Option<&InteractivePrompter>,
) -> AppResult<String> {
    let mut failures: Vec<String> = Vec::new();
    // 服务端未声明方法时（部分实现返回空列表）也按顺序尝试
    let unknown = methods.is_empty();
    let allow_key = unknown || methods.contains("publickey");
    let allow_password = unknown || methods.contains("password");
    let allow_kbd = unknown || methods.contains("keyboard-interactive");

    if allow_key {
        match try_agent(sess, user) {
            Ok(()) => return Ok("agent".into()),
            Err(e) => failures.push(e.to_string()),
        }

        let pass = stored_secret(params.connection_id.as_deref(), SecretKind::Passphrase);
        for key in default_key_candidates() {
            match try_key(sess, user, &key, pass.as_deref()) {
                Ok(()) => return Ok(format!("publickey:{}", key.display())),
                Err(e) => failures.push(e.to_string()),
            }
        }
    }

    if allow_password {
        if let Some(pwd) = stored_secret(params.connection_id.as_deref(), SecretKind::Password) {
            match try_password(sess, user, &pwd) {
                Ok(()) => return Ok("password".into()),
                Err(e) => failures.push(e.to_string()),
            }
        } else {
            failures.push("保险库中没有保存密码".into());
        }
    }

    // 键盘交互放最后：多数服务器把它与 password 并列，前面成功就不会走到这里；
    // 纯键盘交互（PAM / 多因素）的服务器才会在此被触发。
    if allow_kbd {
        let answer = stored_secret(params.connection_id.as_deref(), SecretKind::Password);
        match try_keyboard_interactive(sess, user, prompter, answer.as_deref()) {
            Ok(()) => return Ok("keyboard-interactive".into()),
            Err(e) => failures.push(e.to_string()),
        }
    }

    Err(AppError::Auth(format!(
        "无法登录 {}，已尝试：{}",
        params.endpoint(),
        if failures.is_empty() {
            "无可用的认证方式".to_string()
        } else {
            failures.join("；")
        }
    )))
}

// ---------------------------------------------------------------------------
// 单种方式
// ---------------------------------------------------------------------------

fn try_password(sess: &Session, user: &str, password: &str) -> AppResult<()> {
    sess.userauth_password(user, password)
        .map_err(|e| AppError::Auth(format!("密码被拒绝：{e}")))
}

fn try_key(sess: &Session, user: &str, path: &Path, passphrase: Option<&str>) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::Auth(format!("私钥不存在：{}", path.display())));
    }
    sess.userauth_pubkey_file(user, None, path, passphrase)
        .map_err(|e| AppError::Auth(format!("私钥 {} 被拒绝：{e}", path.display())))
}

fn try_agent(sess: &Session, user: &str) -> AppResult<()> {
    sess.userauth_agent(user)
        .map_err(|e| AppError::Auth(format!("SSH agent 认证失败：{e}")))
}

fn try_keyboard_interactive(
    sess: &Session,
    user: &str,
    prompter: Option<&InteractivePrompter>,
    static_answer: Option<&str>,
) -> AppResult<()> {
    // 既不能弹窗、又没有可用的静态应答时直接给出明确原因，不发送空应答
    if prompter.is_none() && static_answer.is_none() {
        return Err(AppError::Auth(
            "该服务器要求键盘交互认证（如动态验证码），但当前无法交互输入".into(),
        ));
    }
    let mut helper = KbdPrompter {
        prompter,
        static_answer,
        aborted: None,
    };
    match sess.userauth_keyboard_interactive(user, &mut helper) {
        Ok(()) => Ok(()),
        // 用户取消 / 超时时不报「被拒绝」——那不是凭据错误，给出明确原因
        Err(_) => match helper.aborted {
            Some(reason) => Err(AppError::AuthCancelled(reason.to_string())),
            None => Err(AppError::Auth("键盘交互认证被拒绝".into())),
        },
    }
}

/// 键盘交互应答器：有界面时逐条询问用户，否则用静态应答（保险库密码等）统一回应。
struct KbdPrompter<'a> {
    prompter: Option<&'a InteractivePrompter>,
    static_answer: Option<&'a str>,
    /// 用户取消 / 超时后记录原因；此后不再询问，认证失败时据此给出明确文案。
    aborted: Option<&'static str>,
}

impl<'a> KbdPrompter<'a> {
    fn answer(&mut self, prompt: &Prompt) -> String {
        // 已经取消：剩余提示不再询问，避免连弹多个框
        if self.aborted.is_some() {
            return String::new();
        }
        match self.prompter {
            Some(prompter) => match prompter.ask(prompt.text.as_ref(), prompt.echo) {
                PromptOutcome::Answered(text) => text,
                PromptOutcome::Cancelled => {
                    self.aborted = Some("已取消键盘交互认证");
                    String::new()
                }
                PromptOutcome::TimedOut => {
                    self.aborted = Some("键盘交互认证等待超时");
                    String::new()
                }
            },
            None => self.static_answer.unwrap_or("").to_string(),
        }
    }
}

impl<'a> KeyboardInteractivePrompt for KbdPrompter<'a> {
    fn prompt(&mut self, _username: &str, instructions: &str, prompts: &[Prompt]) -> Vec<String> {
        if !instructions.trim().is_empty() {
            log::info!("键盘交互认证说明：{instructions}");
        }
        prompts.iter().map(|p| self.answer(p)).collect()
    }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

enum SecretKind {
    Password,
    Passphrase,
}

fn stored_secret(connection_id: Option<&str>, kind: SecretKind) -> Option<String> {
    let id = connection_id?;
    let key = match kind {
        SecretKind::Password => secrets::conn_password_key(id),
        SecretKind::Passphrase => secrets::conn_passphrase_key(id),
    };
    match secrets::get(&key) {
        Ok(v) => v.filter(|s| !s.is_empty()),
        Err(e) => {
            log::warn!("读取保险库 {key} 失败：{e}");
            None
        }
    }
}

/// 默认私钥候选，仅返回实际存在的文件。顺序即尝试顺序。
fn default_key_candidates() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|name| home.join(".ssh").join(name))
        .filter(|p| p.is_file())
        .collect()
}

/// 展开 `~` 前缀。用户手填路径时常见。
fn expand_home(raw: &str) -> AppResult<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Auth("未填写私钥路径".into()));
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        let home = dirs::home_dir().ok_or_else(|| AppError::Auth("无法定位用户主目录".into()))?;
        return Ok(home.join(rest));
    }
    Ok(PathBuf::from(trimmed))
}

