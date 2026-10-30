//! 一键生成并部署 SSH 密钥。
//!
//! 流程：本地生成 ed25519 密钥对 → 建连并认证（含主机密钥校验）→ 把公钥
//! 幂等追加到远端 `~/.ssh/authorized_keys` → 另起一次仅私钥认证的会话验证 →
//! 写入本机 `~/.ssh/config`。
//!
//! 设计约束：
//! - `authorized_keys` **只追加不覆盖**，写前备份；同一公钥重复部署时跳过。
//! - 远端写入走 SSH exec + stdin，不依赖 SFTP 子系统，也不让公钥出现在服务器进程列表里。
//! - `~/.ssh/config` 按 Host 段解析匹配，写入前备份并原子替换，避免写坏用户全局配置。

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use ssh2::Session;
use ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey};

use crate::config::store::StoredConnection;
use crate::error::{AppError, AppResult};

use super::auth;
use super::jump::JumpTunnel;
use super::known_hosts::{self, HostKeyPolicy};
use super::session::open_transport;
use super::types::{AuthSpec, ConnectParams, JumpSpec};

/// 远端部署脚本：幂等追加公钥，公钥经 stdin 传入（不拼进命令行）。
const DEPLOY_SCRIPT: &str = r#"set -e
umask 077
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
f="$HOME/.ssh/authorized_keys"
[ -f "$f" ] || : > "$f"
chmod 600 "$f"
key=$(cat)
if [ -z "$key" ]; then echo "STATE=EMPTY"; exit 2; fi
if grep -qF "$key" "$f" 2>/dev/null; then
  echo "STATE=EXISTS"
else
  cp "$f" "$f.bak.$(date +%s)"
  # 原文件末尾没有换行时先补一个，避免与最后一行粘连
  if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then printf '\n' >> "$f"; fi
  printf '%s\n' "$key" >> "$f"
  echo "STATE=ADDED"
fi
command -v restorecon >/dev/null 2>&1 && restorecon -R "$HOME/.ssh" >/dev/null 2>&1 || true
echo "OK"
"#;

// ---------------------------------------------------------------------------
// 对外类型
// ---------------------------------------------------------------------------

/// 密钥生成 / 部署的可选项，全部有默认值。
#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct KeySetupOptions {
    /// 私钥文件名（不含目录）。留空按连接名生成 `id_ed25519_{name}`。
    pub key_name: Option<String>,
    /// 公钥注释（写入公钥行末尾）。留空用连接名或 `user@host`。
    pub comment: Option<String>,
    /// `~/.ssh/config` 中的 Host 别名。留空按连接名生成。
    pub config_alias: Option<String>,
    /// 已存在同目标配置段时的处理方式：ask / overwrite / skip / rename。
    pub config_policy: String,
    /// 目标主机密钥信任策略（首次信任时由前端确认后置为 accept_new）。
    pub host_key_policy: HostKeyPolicy,
}

impl Default for KeySetupOptions {
    fn default() -> Self {
        Self {
            key_name: None,
            comment: None,
            config_alias: None,
            config_policy: "ask".into(),
            host_key_policy: HostKeyPolicy::Strict,
        }
    }
}

/// `~/.ssh/config` 的处理结果。
#[derive(Debug, Clone, Serialize)]
pub struct ConfigOutcome {
    /// written | overwritten | renamed | skipped | conflict
    pub status: String,
    pub path: String,
    pub alias: String,
    pub detail: String,
}

/// 一次密钥生成 / 部署的完整结果。
#[derive(Debug, Clone, Serialize)]
pub struct KeySetupResult {
    pub private_key_path: String,
    pub public_key_path: String,
    pub fingerprint: String,
    /// 本次是否新生成（false 表示复用了已有私钥）
    pub key_generated: bool,
    /// added | exists
    pub deploy: String,
    /// ok | failed: 原因
    pub verify: String,
    pub config: ConfigOutcome,
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

pub fn run(
    conn: &StoredConnection,
    jump_enabled: bool,
    options: &KeySetupOptions,
) -> AppResult<KeySetupResult> {
    if conn.protocol.trim() == crate::config::store::PROTOCOL_RDP {
        return Err(AppError::Config(
            "远程桌面（RDP）连接不支持部署 SSH 密钥".into(),
        ));
    }
    if conn.host.trim().is_empty() || conn.username.trim().is_empty() {
        return Err(AppError::Config("连接缺少主机或用户名".into()));
    }

    let home = dirs::home_dir().ok_or_else(|| AppError::Config("无法定位用户主目录".into()))?;
    let ssh_dir = home.join(".ssh");
    ensure_ssh_dir(&ssh_dir)?;

    let key_name = key_file_name(conn, options);
    let comment = comment_text(conn, options);
    let (private_key, public_key, public_line, generated) =
        ensure_key_pair(&ssh_dir, &key_name, &comment)?;
    log::info!(
        "密钥就绪：{}（{}）",
        private_key.display(),
        if generated {
            "新生成"
        } else {
            "复用已有"
        }
    );

    let params = connect_params(conn, jump_enabled);
    // 跳板机隧道在本次流程内复用：部署会话与验证会话各开一条连接
    let tunnel = match &params.jump {
        Some(spec) if !spec.host.trim().is_empty() => Some(JumpTunnel::open(
            spec,
            &params.host,
            params.port,
            0,
            None,
            Some(options.host_key_policy),
        )?),
        _ => None,
    };

    let deploy = {
        let (host, port) = endpoint(&params, tunnel.as_ref());
        let sess = open_transport(&host, port)?;
        // 后台连接无法弹窗确认指纹，未信任时给出可操作提示（与 SFTP 一致）
        known_hosts::verify_session_strict(
            &sess,
            &params.host,
            params.port,
            options.host_key_policy,
        )?;
        let method = auth::authenticate(&sess, &params, None)?;
        log::info!("密钥部署会话认证成功（{method}）");
        deploy_public_key(&sess, public_line.trim())?
    };

    let verify = verify_key_login(
        &params,
        &private_key,
        tunnel.as_ref(),
        options.host_key_policy,
    );
    drop(tunnel);

    let fingerprint = PrivateKey::from_openssh(&fs::read_to_string(&private_key)?)
        .map(|k| k.fingerprint(HashAlg::Sha256).to_string())
        .unwrap_or_else(|_| String::new());

    let config = write_ssh_config(&ssh_dir, conn, options, &key_name)?;

    Ok(KeySetupResult {
        private_key_path: private_key.display().to_string(),
        public_key_path: public_key.display().to_string(),
        fingerprint,
        key_generated: generated,
        deploy,
        verify,
        config,
    })
}

// ---------------------------------------------------------------------------
// 本地密钥
// ---------------------------------------------------------------------------

fn ensure_ssh_dir(dir: &Path) -> AppResult<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn key_file_name(conn: &StoredConnection, options: &KeySetupOptions) -> String {
    if let Some(raw) = options
        .key_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let cleaned = sanitize(raw, '-');
        if !cleaned.is_empty() {
            return if cleaned.starts_with("id_") {
                cleaned
            } else {
                format!("id_ed25519_{cleaned}")
            };
        }
    }
    let base = if conn.name.trim().is_empty() {
        format!("{}_{}", conn.username, conn.host)
    } else {
        conn.name.trim().to_string()
    };
    let slug = sanitize(&base, '-');
    // 连接名全是非 ASCII（如中文）时 sanitize 会得到空串；退回 user_host，
    // 否则不同连接会落到同一个 id_ed25519_ 文件名并互相复用私钥。
    let slug = if slug.is_empty() {
        sanitize(&format!("{}_{}", conn.username, conn.host), '-')
    } else {
        slug
    };
    format!("id_ed25519_{slug}")
}

fn comment_text(conn: &StoredConnection, options: &KeySetupOptions) -> String {
    let raw = options
        .comment
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if conn.name.trim().is_empty() {
                format!("{}@{}", conn.username, conn.host)
            } else {
                conn.name.trim().to_string()
            }
        });
    // 注释会写入公钥行，必须剔除换行等控制字符，避免污染 authorized_keys
    raw.chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

/// 生成（或复用）密钥对，返回 (私钥路径, 公钥路径, 公钥行, 是否新生成)。
fn ensure_key_pair(
    ssh_dir: &Path,
    name: &str,
    comment: &str,
) -> AppResult<(PathBuf, PathBuf, String, bool)> {
    let private_path = ssh_dir.join(name);
    let public_path = ssh_dir.join(format!("{name}.pub"));

    if private_path.exists() {
        // 复用已有私钥：公钥缺失时从私钥导出，保证两侧一致
        if !public_path.exists() {
            let text = fs::read_to_string(&private_path)?;
            let key = PrivateKey::from_openssh(&text)
                .map_err(|e| AppError::Ssh(format!("已有私钥无法解析：{e}")))?;
            let line = format!(
                "{} {comment}",
                key.public_key()
                    .to_openssh()
                    .map_err(|e| AppError::Ssh(format!("导出公钥失败：{e}")))?
            );
            write_file_mode(&public_path, line.as_bytes(), 0o644)?;
        }
        let line = first_line(&fs::read_to_string(&public_path)?);
        return Ok((private_path, public_path, line, false));
    }

    let key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519)
        .map_err(|e| AppError::Ssh(format!("生成 ed25519 密钥失败：{e}")))?;
    let openssh = key
        .to_openssh(LineEnding::LF)
        .map_err(|e| AppError::Ssh(format!("序列化私钥失败：{e}")))?;
    write_file_mode(&private_path, openssh.as_bytes(), 0o600)?;

    let line = format!(
        "{} {comment}",
        key.public_key()
            .to_openssh()
            .map_err(|e| AppError::Ssh(format!("导出公钥失败：{e}")))?
    );
    write_file_mode(&public_path, line.as_bytes(), 0o644)?;
    Ok((private_path, public_path, line, true))
}

fn write_file_mode(path: &Path, bytes: &[u8], mode: u32) -> AppResult<()> {
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = opts.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or("").trim().to_string()
}

// ---------------------------------------------------------------------------
// 建连参数
// ---------------------------------------------------------------------------

pub(crate) fn connect_params(conn: &StoredConnection, jump_enabled: bool) -> ConnectParams {
    let jump = if jump_enabled {
        conn.jump.as_ref().map(|record| JumpSpec {
            // 带上连接 id，跳板机密码才能从保险库对应条目读取
            connection_id: Some(conn.id.clone()),
            host: record.host.clone(),
            port: record.port,
            username: record.username.clone(),
            auth: auth_spec(&record.auth_kind, record.key_path.as_deref()),
        })
    } else {
        None
    };
    ConnectParams {
        connection_id: Some(conn.id.clone()),
        name: Some(conn.name.clone()),
        host: conn.host.trim().to_string(),
        port: conn.port,
        username: conn.username.trim().to_string(),
        auth: auth_spec(&conn.auth_kind, conn.key_path.as_deref()),
        jump,
        ..Default::default()
    }
}

pub(crate) fn auth_spec(kind: &str, key_path: Option<&str>) -> AuthSpec {
    match kind {
        "password" => AuthSpec::Password { password: None },
        "private_key" => AuthSpec::PrivateKey {
            key_path: key_path.unwrap_or("").to_string(),
            passphrase: None,
        },
        "agent" => AuthSpec::Agent,
        "keyboard_interactive" => AuthSpec::KeyboardInteractive { password: None },
        _ => AuthSpec::Auto,
    }
}

fn endpoint(params: &ConnectParams, tunnel: Option<&JumpTunnel>) -> (String, u16) {
    match tunnel {
        Some(t) => ("127.0.0.1".to_string(), t.local_port()),
        None => (params.host.clone(), params.port),
    }
}

// ---------------------------------------------------------------------------
// 远端部署
// ---------------------------------------------------------------------------

fn deploy_public_key(sess: &Session, public_line: &str) -> AppResult<String> {
    let mut channel = sess
        .channel_session()
        .map_err(|e| AppError::Ssh(format!("无法打开 SSH 通道：{e}")))?;
    channel
        .exec(DEPLOY_SCRIPT)
        .map_err(|e| AppError::Ssh(format!("无法执行部署脚本：{e}")))?;
    channel
        .write_all(format!("{public_line}\n").as_bytes())
        .map_err(|e| AppError::Ssh(format!("写入公钥失败：{e}")))?;
    channel
        .send_eof()
        .map_err(|e| AppError::Ssh(format!("发送公钥失败：{e}")))?;

    let mut stdout = String::new();
    channel
        .read_to_string(&mut stdout)
        .map_err(|e| AppError::Ssh(format!("读取部署结果失败：{e}")))?;
    let mut stderr = String::new();
    let _ = channel.stderr().read_to_string(&mut stderr);
    channel
        .wait_close()
        .map_err(|e| AppError::Ssh(format!("等待部署结束失败：{e}")))?;
    let code = channel.exit_status().unwrap_or(-1);

    if code != 0 || !stdout.contains("STATE=") {
        return Err(AppError::Ssh(format!(
            "远端写入 authorized_keys 失败（退出码 {code}）：{}",
            stderr.trim()
        )));
    }
    if stdout.contains("STATE=EXISTS") {
        Ok("exists".into())
    } else if stdout.contains("STATE=ADDED") {
        Ok("added".into())
    } else {
        Err(AppError::Ssh("远端返回了无法识别的部署结果".into()))
    }
}

/// 另起一条仅私钥认证的会话，验证公钥确实生效。返回 `ok` 或 `failed: 原因`。
fn verify_key_login(
    params: &ConnectParams,
    key_path: &Path,
    tunnel: Option<&JumpTunnel>,
    policy: HostKeyPolicy,
) -> String {
    let attempt = || -> AppResult<String> {
        let (host, port) = endpoint(params, tunnel);
        let sess = open_transport(&host, port)?;
        known_hosts::verify_session_strict(&sess, &params.host, params.port, policy)?;
        let mut verify_params = params.clone();
        // 不带连接 id：避免复用登记在保险库里的旧 passphrase
        verify_params.connection_id = None;
        verify_params.auth = AuthSpec::PrivateKey {
            key_path: key_path.display().to_string(),
            passphrase: None,
        };
        auth::authenticate(&sess, &verify_params, None)?;
        let mut channel = sess
            .channel_session()
            .map_err(|e| AppError::Ssh(format!("无法打开验证通道：{e}")))?;
        channel
            .exec("echo PTERM_KEY_OK")
            .map_err(|e| AppError::Ssh(format!("无法执行验证命令：{e}")))?;
        let mut out = String::new();
        channel.read_to_string(&mut out)?;
        channel.wait_close()?;
        if out.contains("PTERM_KEY_OK") {
            Ok("ok".into())
        } else {
            Err(AppError::Ssh("远端未返回预期输出".into()))
        }
    };
    match attempt() {
        Ok(v) => v,
        Err(e) => format!("failed: {e}"),
    }
}

// ---------------------------------------------------------------------------
// 本机 ~/.ssh/config
// ---------------------------------------------------------------------------

/// 解析出的一段 Host 配置。
struct HostBlock {
    start: usize,
    end: usize,
    alias: String,
    host: String,
    port: u16,
    user: Option<String>,
}

fn write_ssh_config(
    ssh_dir: &Path,
    conn: &StoredConnection,
    options: &KeySetupOptions,
    key_name: &str,
) -> AppResult<ConfigOutcome> {
    let path = ssh_dir.join("config");
    let original = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(AppError::Config(format!("读取 ~/.ssh/config 失败：{e}"))),
    };
    let lines: Vec<&str> = original.lines().collect();
    let blocks = parse_blocks(&lines);

    let host = conn.host.trim();
    let port = conn.port;
    let user = conn.username.trim();
    let mut alias = options
        .config_alias
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| sanitize(s, '-'))
        .unwrap_or_else(|| {
            let base = if conn.name.trim().is_empty() {
                format!("{}-{}", user, host)
            } else {
                conn.name.trim().to_string()
            };
            sanitize(&base, '-')
        });
    if alias.is_empty() {
        alias = sanitize(&format!("{user}-{host}"), '-');
    }

    let identity = format!("~/.ssh/{key_name}");
    let matched = blocks.iter().find(|b| {
        b.host.eq_ignore_ascii_case(host) && b.port == port && b.user.as_deref() == Some(user)
    });
    let alias_taken = blocks.iter().any(|b| b.alias.eq_ignore_ascii_case(&alias));

    let policy = options.config_policy.as_str();
    let existing_desc = matched.map(|b| {
        format!(
            "已有 Host {} 指向 {}@{}:{}",
            b.alias,
            b.user.as_deref().unwrap_or(""),
            b.host,
            b.port
        )
    });

    // 同目标已存在配置段
    if let Some(block) = matched {
        match policy {
            "overwrite" => {
                // 沿用原有别名，避免覆盖后凭空改掉用户已记住的 Host 名
                let alias = block.alias.clone();
                let replaced = replace_block(
                    &lines,
                    block.start,
                    block.end,
                    &block_text(&alias, host, port, user, &identity),
                );
                backup_config(&path)?;
                atomic_write(&path, &replaced)?;
                return Ok(ConfigOutcome {
                    status: "overwritten".into(),
                    path: path.display().to_string(),
                    alias,
                    detail: format!("已覆盖原有的 Host {} 配置段", block.alias),
                });
            }
            "skip" => {
                return Ok(ConfigOutcome {
                    status: "skipped".into(),
                    path: path.display().to_string(),
                    alias: block.alias.clone(),
                    detail: existing_desc.unwrap_or_default(),
                });
            }
            "rename" => {
                alias = unique_alias(&blocks, &alias);
            }
            // 未决策：不写盘，把冲突信息交给前端
            _ => {
                return Ok(ConfigOutcome {
                    status: "conflict".into(),
                    path: path.display().to_string(),
                    alias: block.alias.clone(),
                    detail: existing_desc.unwrap_or_default(),
                });
            }
        }
    } else if alias_taken {
        // 别名已被别的目标占用：不允许覆盖，改成唯一别名追加
        if policy == "skip" {
            return Ok(ConfigOutcome {
                status: "skipped".into(),
                path: path.display().to_string(),
                alias: alias.clone(),
                detail: format!("别名 {alias} 已被其它主机占用，已跳过写入"),
            });
        }
        if policy == "ask" {
            return Ok(ConfigOutcome {
                status: "conflict".into(),
                path: path.display().to_string(),
                alias: alias.clone(),
                detail: format!("别名 {alias} 已被其它主机占用"),
            });
        }
        alias = unique_alias(&blocks, &alias);
    }

    let mut content = original.clone();
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    if !content.is_empty() {
        content.push('\n');
    }
    content.push_str(&block_text(&alias, host, port, user, &identity));

    backup_config(&path)?;
    atomic_write(&path, &content)?;
    Ok(ConfigOutcome {
        status: if matched.is_some() {
            "renamed".into()
        } else {
            "written".into()
        },
        path: path.display().to_string(),
        alias,
        detail: String::new(),
    })
}

fn block_text(alias: &str, host: &str, port: u16, user: &str, identity: &str) -> String {
    format!(
        "Host {alias}\n    HostName {host}\n    Port {port}\n    User {user}\n    IdentityFile {identity}\n    IdentitiesOnly yes\n"
    )
}

fn parse_blocks(lines: &[&str]) -> Vec<HostBlock> {
    let mut blocks = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let Some(alias) = keyword_value(lines[i], "host") else {
            i += 1;
            continue;
        };
        let start = i;
        let mut end = i + 1;
        while end < lines.len()
            && keyword_value(lines[end], "host").is_none()
            && keyword_value(lines[end], "match").is_none()
        {
            end += 1;
        }
        let mut host = alias.clone();
        let mut port = 22u16;
        let mut user = None;
        for line in &lines[start + 1..end] {
            let Some((key, value)) = split_kv(line) else {
                continue;
            };
            match key.to_ascii_lowercase().as_str() {
                "hostname" => host = value,
                "port" => {
                    if let Ok(p) = value.parse() {
                        port = p;
                    }
                }
                "user" => user = Some(value),
                _ => {}
            }
        }
        blocks.push(HostBlock {
            start,
            end,
            alias,
            host,
            port,
            user,
        });
        i = end;
    }
    blocks
}

/// 行首关键字匹配（`Host xxx` / `Match ...`），返回第一个参数值。
fn keyword_value(line: &str, keyword: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.starts_with('#') {
        return None;
    }
    let mut parts = trimmed.split_whitespace();
    let head = parts.next()?;
    if !head.eq_ignore_ascii_case(keyword) {
        return None;
    }
    let value = parts.next()?;
    Some(value.trim_matches('"').to_string())
}

/// 拆分 `Key value` 或 `Key=value`。
fn split_kv(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let (key, value) = match trimmed.split_once('=') {
        Some((k, v)) => (k.trim(), v.trim()),
        None => {
            let mut parts = trimmed.splitn(2, char::is_whitespace);
            (parts.next()?.trim(), parts.next().unwrap_or("").trim())
        }
    };
    if key.is_empty() {
        return None;
    }
    Some((key.to_string(), value.trim_matches('"').to_string()))
}

fn replace_block(lines: &[&str], start: usize, end: usize, block: &str) -> String {
    let mut out = String::new();
    for line in &lines[..start] {
        out.push_str(line);
        out.push('\n');
    }
    out.push_str(block);
    for line in &lines[end..] {
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn unique_alias(blocks: &[HostBlock], base: &str) -> String {
    for n in 2..1000 {
        let candidate = format!("{base}-{n}");
        if !blocks
            .iter()
            .any(|b| b.alias.eq_ignore_ascii_case(&candidate))
        {
            return candidate;
        }
    }
    format!("{base}-{}", chrono::Local::now().timestamp())
}

fn backup_config(path: &Path) -> AppResult<()> {
    if !path.exists() {
        return Ok(());
    }
    let stamp = chrono::Local::now().format("%Y%m%d%H%M%S");
    let backup = path.with_file_name(format!("config.bak.{stamp}"));
    fs::copy(path, &backup)
        .map_err(|e| AppError::Config(format!("备份 ~/.ssh/config 失败：{e}")))?;
    Ok(())
}

fn atomic_write(path: &Path, content: &str) -> AppResult<()> {
    let tmp = path.with_file_name(format!(".pterm-config-{}", uuid::Uuid::new_v4()));
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let result = (|| -> std::io::Result<()> {
        let mut file = opts.open(&tmp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::Config(format!("写入 ~/.ssh/config 失败：{e}")));
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        AppError::Config(format!("替换 ~/.ssh/config 失败：{e}"))
    })?;
    Ok(())
}

/// 把任意文本收敛成安全标识（仅保留 ASCII 字母数字与 `._-`）。
fn sanitize(raw: &str, filler: char) -> String {
    let mapped: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                filler
            }
        })
        .collect();
    mapped.trim_matches(filler).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_host_blocks_and_fields() {
        let text =
            "Host a\n  HostName 1.2.3.4\n  Port 2222\n  User root\n\nHost b\n  HostName=5.6.7.8\n";
        let lines: Vec<&str> = text.lines().collect();
        let blocks = parse_blocks(&lines);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].alias, "a");
        assert_eq!(blocks[0].host, "1.2.3.4");
        assert_eq!(blocks[0].port, 2222);
        assert_eq!(blocks[0].user.as_deref(), Some("root"));
        assert_eq!(blocks[1].alias, "b");
        assert_eq!(blocks[1].host, "5.6.7.8");
        // 缺省端口按 22 处理
        assert_eq!(blocks[1].port, 22);
    }

    #[test]
    fn match_block_terminates_previous_host_block() {
        let text = "Host a\n  HostName 1.2.3.4\nMatch host 5.6.7.8\n  User root\n";
        let lines: Vec<&str> = text.lines().collect();
        let blocks = parse_blocks(&lines);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].end, 2);
    }

    #[test]
    fn sanitize_drops_unsafe_characters() {
        assert_eq!(sanitize("生产 服务器", '-'), "");
        assert_eq!(sanitize("生产 服务器/1", '-'), "1");
        assert_eq!(sanitize("prod-01.example.com", '-'), "prod-01.example.com");
        assert_eq!(sanitize("a b", '-'), "a-b");
    }

    fn sample_connection(name: &str) -> StoredConnection {
        StoredConnection {
            id: "c1".into(),
            name: name.into(),
            host: "10.0.0.8".into(),
            port: 22,
            username: "root".into(),
            protocol: "ssh".into(),
            domain: None,
            auth_kind: "auto".into(),
            key_path: None,
            group_name: None,
            note: None,
            has_password: false,
            has_passphrase: false,
            jump: None,
            color: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn key_name_uses_connection_name_and_falls_back_for_non_ascii() {
        let options = KeySetupOptions::default();
        assert_eq!(
            key_file_name(&sample_connection("prod web"), &options),
            "id_ed25519_prod-web"
        );
        // 纯中文连接名不能塌缩成 id_ed25519_（会与其它连接共用同一个私钥文件）
        assert_eq!(
            key_file_name(&sample_connection("生产服务器"), &options),
            "id_ed25519_root_10.0.0.8"
        );
        // 未填名字时按 user_host
        assert_eq!(
            key_file_name(&sample_connection("  "), &options),
            "id_ed25519_root_10.0.0.8"
        );
    }

    #[test]
    fn unique_alias_appends_suffix() {
        let text = "Host prod\n  HostName 1.2.3.4\n";
        let lines: Vec<&str> = text.lines().collect();
        let blocks = parse_blocks(&lines);
        assert_eq!(unique_alias(&blocks, "prod"), "prod-2");
        assert_eq!(unique_alias(&blocks, "other"), "other-2");
    }
}
