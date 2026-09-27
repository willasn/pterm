use std::path::{Path, PathBuf};

use ssh2::Session;

use crate::config::store::secrets;
use crate::error::{AppError, AppResult};

use super::types::{AuthSpec, ConnectParams};

/// 认证成功后返回所用方式的可读名称，供界面展示。
pub fn authenticate(sess: &Session, params: &ConnectParams) -> AppResult<String> {
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
                    "{}：未提供密码，且钥匙串中没有记录",
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

        AuthSpec::Auto => auto_authenticate(sess, user, params, &methods),
    }
}

/// 自动模式：agent → 默认私钥 → 钥匙串密码。返回首个成功的方式。
fn auto_authenticate(
    sess: &Session,
    user: &str,
    params: &ConnectParams,
    methods: &str,
) -> AppResult<String> {
    let mut failures: Vec<String> = Vec::new();
    // 服务端未声明方法时（部分实现返回空列表）也按顺序尝试
    let unknown = methods.is_empty();
    let allow_key = unknown || methods.contains("publickey");
    let allow_password = unknown || methods.contains("password");

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
            failures.push("钥匙串中没有保存密码".into());
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
            log::warn!("读取钥匙串 {key} 失败：{e}");
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

