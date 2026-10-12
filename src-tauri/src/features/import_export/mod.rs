//! 连接配置导入导出（FEATURES.md §3）。
//!
//! 导出为带标识的 JSON，**永不携带凭据**：密码 / passphrase 只存在于加密保险库，
//! 既不在 SQLite 也不在导出文件里；导出结构里根本没有这些字段。
//!
//! 导入支持两种来源：
//! - pterm 自身导出的 JSON（按 `format` 字段识别）；
//! - OpenSSH 客户端配置 `~/.ssh/config`（解析 Host / HostName / Port / User /
//!   IdentityFile / ProxyJump，含通配符的块会跳过）。
//!
//! 导入一律**新建**连接：重新分配 id、重置时间戳、清空凭据标记，绝不覆盖已有连接；
//! 与已有连接（按 `名称+主机+端口+用户名`）重复的条目计入 `skipped`。
//!
//! 本模块没有运行期状态，因此 [`ImportExportModule`] 只在初始化时打一条日志，
//! 真正的文件读写发生在命令层（见 `commands.rs`）。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::config::store::{JumpRecord, Store, StoredConnection};
use crate::error::{AppError, AppResult};
use crate::modules::ModuleContext;

pub mod commands;

/// 导出文件的标识与版本，用于导入时校验来源。
const FORMAT_TAG: &str = "pterm-connections";
const FORMAT_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

/// 导出 / 导入时使用的连接结构。**不含 id、时间戳与任何凭据字段**。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ExportedConnection {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    /// ssh | rdp，非法值导入时回退为 ssh
    #[serde(default = "crate::config::store::default_protocol")]
    pub protocol: String,
    /// RDP 域（Windows 域账号）
    #[serde(default)]
    pub domain: Option<String>,
    /// password | private_key | agent | auto，非法值导入时回退为 auto
    #[serde(default)]
    pub auth_kind: String,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub group_name: Option<String>,
    #[serde(default)]
    pub jump: Option<JumpRecord>,
    #[serde(default)]
    pub color: Option<String>,
}

fn default_port() -> u16 {
    22
}

/// 导出文件的根结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportFile {
    pub format: String,
    pub version: u32,
    pub exported_at: String,
    /// 恒为 false。显式写出，便于使用者确认文件中没有凭据。
    pub credentials_included: bool,
    #[serde(default)]
    pub connections: Vec<ExportedConnection>,
}

/// 导入来源。`auto` 时按内容自动识别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportFormat {
    Auto,
    Pterm,
    SshConfig,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportReport {
    pub path: String,
    pub count: usize,
    pub bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportReport {
    /// 实际使用的格式：pterm | ssh_config
    pub format: String,
    pub imported: usize,
    pub skipped: usize,
    pub warnings: Vec<String>,
    /// 本次新建的连接，供前端即时刷新列表
    pub connections: Vec<StoredConnection>,
}

/// 供前端预填文件对话框的默认路径。
#[derive(Debug, Clone, Serialize)]
pub struct ImportExportDefaults {
    pub home_dir: String,
    pub ssh_config_path: String,
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/// 把存储中的连接转成可导出的结构（剥离 id / 时间戳 / 凭据标记）。
pub fn exportable(connections: &[StoredConnection]) -> Vec<ExportedConnection> {
    connections
        .iter()
        .map(|c| ExportedConnection {
            name: c.name.clone(),
            host: c.host.clone(),
            port: c.port,
            username: c.username.clone(),
            protocol: c.protocol.clone(),
            domain: c.domain.clone(),
            auth_kind: c.auth_kind.clone(),
            key_path: c.key_path.clone(),
            group_name: c.group_name.clone(),
            jump: c.jump.clone(),
            color: c.color.clone(),
        })
        .collect()
}

/// 组装导出文件。
pub fn export_file(connections: &[StoredConnection]) -> ExportFile {
    ExportFile {
        format: FORMAT_TAG.to_string(),
        version: FORMAT_VERSION,
        exported_at: chrono::Local::now().to_rfc3339(),
        credentials_included: false,
        connections: exportable(connections),
    }
}

/// 写出导出文件，返回字节数。
pub fn write_export(path: &Path, file: &ExportFile) -> AppResult<usize> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let text = serde_json::to_string_pretty(file)?;
    std::fs::write(path, &text)?;
    Ok(text.len())
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

/// 按内容识别实际格式。`Auto` 时：以 `{` 开头视为 pterm JSON，否则按 ssh config。
pub fn resolve_format(format: ImportFormat, text: &str) -> ImportFormat {
    match format {
        ImportFormat::Auto => {
            if text.trim_start().starts_with('{') {
                ImportFormat::Pterm
            } else {
                ImportFormat::SshConfig
            }
        }
        other => other,
    }
}

pub fn format_name(format: ImportFormat) -> String {
    match format {
        ImportFormat::Pterm => "pterm".to_string(),
        ImportFormat::SshConfig => "ssh_config".to_string(),
        ImportFormat::Auto => "auto".to_string(),
    }
}

/// 解析 pterm 导出的 JSON。
pub fn parse_pterm(text: &str) -> AppResult<(Vec<ExportedConnection>, Vec<String>)> {
    let file: ExportFile = serde_json::from_str(text)
        .map_err(|e| AppError::Config(format!("导出文件格式不正确：{e}")))?;
    let mut warnings = Vec::new();
    if file.format != FORMAT_TAG {
        warnings.push(format!(
            "文件标识为「{}」，预期「{FORMAT_TAG}」，仍按 pterm 格式解析。",
            file.format
        ));
    }
    if file.version > FORMAT_VERSION {
        warnings.push(format!(
            "文件版本 {} 高于当前支持的 {FORMAT_VERSION}，未知字段已忽略。",
            file.version
        ));
    }
    if file.credentials_included {
        warnings.push("文件声明包含凭据，但 pterm 不导入任何凭据，请在导入后重新填写。".to_string());
    }
    Ok((file.connections, warnings))
}

/// 解析 `~/.ssh/config`。返回连接候选与解析过程中的提示。
pub fn parse_ssh_config(text: &str) -> (Vec<ExportedConnection>, Vec<String>) {
    let default_user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();

    let mut out = Vec::new();
    let mut warnings = Vec::new();
    let mut block = Block::default();
    let mut has_block = false;

    for raw in text.lines() {
        let line = strip_comment(raw);
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let (key, value) = split_directive(line);
        match key.to_ascii_lowercase().as_str() {
            "host" => {
                if has_block {
                    flush_block(block, &mut out, &mut warnings, &default_user);
                }
                block = Block::default();
                has_block = true;
                for token in value.split_whitespace() {
                    // 含通配符 / 取反的块是给一批主机设默认值，不产生具体连接别名
                    if token.contains('*') || token.contains('?') || token.contains('!') {
                        continue;
                    }
                    block.aliases.push(token.to_string());
                }
            }
            "hostname" => block.hostname = Some(unquote(value)),
            "port" => block.port = value.trim().parse::<u16>().ok(),
            "user" => block.user = Some(unquote(value)),
            "identityfile" => {
                if block.identity.is_none() {
                    block.identity = Some(unquote(value));
                }
            }
            "proxyjump" => block.proxy_jump = Some(unquote(value)),
            "include" => {
                warnings.push(format!("未展开 Include 指令：{}", value.trim()));
            }
            _ => {}
        }
    }
    if has_block {
        flush_block(block, &mut out, &mut warnings, &default_user);
    }
    (out, warnings)
}

/// 把导入候选写入存储：重新分配 id、重置时间戳、清空凭据标记，并按去重键跳过重复。
pub fn import_into(
    store: &Store,
    candidates: Vec<ExportedConnection>,
) -> AppResult<(usize, usize, Vec<StoredConnection>)> {
    let existing = store.list_connections()?;
    let mut seen: HashSet<String> = existing.iter().map(dup_key).collect();
    let now = chrono::Utc::now().to_rfc3339();

    let mut imported = 0usize;
    let mut skipped = 0usize;
    let mut saved = Vec::new();
    for candidate in candidates {
        let conn = into_stored(candidate, &now);
        if conn.host.trim().is_empty() {
            skipped += 1;
            continue;
        }
        if !seen.insert(dup_key(&conn)) {
            skipped += 1;
            continue;
        }
        store.upsert_connection(&conn)?;
        imported += 1;
        saved.push(conn);
    }
    Ok((imported, skipped, saved))
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/// `~/.ssh/config` 的默认位置（不可定位家目录时为空串）。
pub fn ssh_config_path() -> PathBuf {
    match dirs::home_dir() {
        Some(home) => home.join(".ssh").join("config"),
        None => PathBuf::new(),
    }
}

pub fn home_dir_text() -> String {
    dirs::home_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

/// 展开开头的 `~` 并校验非空，供命令层把前端传来的路径转成可用的绝对路径。
pub fn normalize_path(raw: &str) -> AppResult<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Config("未指定文件路径".into()));
    }
    Ok(PathBuf::from(expand_tilde(trimmed)))
}

/// 展开开头的 `~` / `~/`。
pub fn expand_tilde(raw: &str) -> String {
    if raw == "~" {
        return home_dir_text();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).display().to_string();
        }
    }
    raw.to_string()
}

// ---------------------------------------------------------------------------
// 模块
// ---------------------------------------------------------------------------

/// 导入导出模块。功能为纯函数式文件 IO，无运行期状态，仅保留生命周期日志。
pub struct ImportExportModule;

impl ImportExportModule {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ImportExportModule {
    fn default() -> Self {
        Self::new()
    }
}

impl PluggableModule for ImportExportModule {
    fn id(&self) -> &'static str {
        module_id::IMPORT_EXPORT
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.connection.import_export
    }

    fn init(&self, _ctx: &ModuleContext) -> AppResult<()> {
        log::info!(
            "连接导入导出已启用：默认 ssh config 位置 {}",
            ssh_config_path().display()
        );
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/// 单个 `Host` 块解析出的字段。
#[derive(Default)]
struct Block {
    aliases: Vec<String>,
    hostname: Option<String>,
    port: Option<u16>,
    user: Option<String>,
    identity: Option<String>,
    proxy_jump: Option<String>,
}

/// 收束一个 `Host` 块：含通配符或没有具体别名时跳过。
fn flush_block(
    block: Block,
    out: &mut Vec<ExportedConnection>,
    warnings: &mut Vec<String>,
    default_user: &str,
) {
    if block.aliases.is_empty() {
        return;
    }
    let alias = block.aliases[0].clone();
    let host = block.hostname.clone().unwrap_or_else(|| alias.clone());
    let username = match block.user.clone() {
        Some(u) if !u.trim().is_empty() => u,
        _ => default_user.to_string(),
    };
    let (auth_kind, key_path) = match block.identity.as_ref() {
        Some(path) if !path.trim().is_empty() => ("private_key".to_string(), Some(expand_tilde(path))),
        _ => ("auto".to_string(), None),
    };
    let jump = block.proxy_jump.as_ref().and_then(|raw| {
        let value = raw.trim();
        if value.is_empty() || value.eq_ignore_ascii_case("none") {
            return None;
        }
        if value.contains(',') {
            warnings.push(format!(
                "「{alias}」的 ProxyJump 含多级跳板机，导入时仅保留第一跳：{value}"
            ));
        }
        parse_jump(value.split(',').next().unwrap_or(value))
    });

    out.push(ExportedConnection {
        name: alias,
        host,
        port: block.port.unwrap_or(22),
        username,
        protocol: crate::config::store::default_protocol(),
        domain: None,
        auth_kind,
        key_path,
        group_name: None,
        jump,
        color: None,
    });
}

/// 解析 `[user@]host[:port]` 形态的 ProxyJump 目标。
fn parse_jump(raw: &str) -> Option<JumpRecord> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    let (user, rest) = match value.split_once('@') {
        Some((u, h)) => (Some(u.trim().to_string()), h.trim()),
        None => (None, value),
    };
    if rest.is_empty() {
        return None;
    }
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => (h.trim(), p.trim().parse::<u16>().unwrap_or(22)),
        _ => (rest, 22),
    };
    if host.is_empty() {
        return None;
    }
    Some(JumpRecord {
        host: host.to_string(),
        port,
        username: user.unwrap_or_default(),
        auth_kind: "auto".to_string(),
        key_path: None,
    })
}

/// 去掉行内注释。`#` 之后一律视为注释。
fn strip_comment(line: &str) -> &str {
    match line.find('#') {
        Some(idx) => &line[..idx],
        None => line,
    }
}

/// 拆出指令名与值，兼容 `Key Value` 与 `Key=Value`。
fn split_directive(line: &str) -> (&str, &str) {
    match line.find(|c: char| c.is_whitespace() || c == '=') {
        Some(idx) => {
            let key = &line[..idx];
            let value = line[idx..].trim_start().trim_start_matches('=').trim_start();
            (key, value)
        }
        None => (line, ""),
    }
}

/// 去掉值两端成对的引号。
fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

/// 导入候选 → 存储记录：新 id、新时间戳、无凭据。
fn into_stored(candidate: ExportedConnection, now: &str) -> StoredConnection {
    let name = candidate.name.trim().to_string();
    let host = candidate.host.trim().to_string();
    let protocol = normalize_protocol(&candidate.protocol);
    // 端口未给时按协议取默认值：SSH 22、RDP 3389
    let default_port = if protocol == crate::config::store::PROTOCOL_RDP {
        3389
    } else {
        22
    };
    StoredConnection {
        id: uuid::Uuid::new_v4().to_string(),
        name: if name.is_empty() { host.clone() } else { name },
        host,
        port: if candidate.port == 0 {
            default_port
        } else {
            candidate.port
        },
        username: candidate.username.trim().to_string(),
        protocol,
        domain: candidate.domain,
        auth_kind: normalize_auth(&candidate.auth_kind),
        key_path: candidate.key_path,
        group_name: candidate.group_name,
        has_password: false,
        has_passphrase: false,
        jump: candidate.jump,
        color: candidate.color,
        created_at: now.to_string(),
        updated_at: now.to_string(),
    }
}

const AUTH_KINDS: [&str; 5] = [
    "password",
    "private_key",
    "agent",
    "keyboard_interactive",
    "auto",
];

fn normalize_auth(raw: &str) -> String {
    let value = raw.trim();
    match AUTH_KINDS.iter().find(|k| **k == value) {
        Some(hit) => (*hit).to_string(),
        None => "auto".to_string(),
    }
}

/// 只接受 ssh / rdp，其余（含缺失）回退为 ssh。
fn normalize_protocol(raw: &str) -> String {
    if raw.trim() == crate::config::store::PROTOCOL_RDP {
        crate::config::store::PROTOCOL_RDP.to_string()
    } else {
        crate::config::store::PROTOCOL_SSH.to_string()
    }
}

/// 去重键：名称 + 主机 + 端口 + 用户名（全部小写、去空白），与 id 无关。
fn dup_key(c: &StoredConnection) -> String {
    format!(
        "{}\u{0}{}\u{0}{}\u{0}{}",
        c.name.trim().to_lowercase(),
        c.host.trim().to_lowercase(),
        c.port,
        c.username.trim().to_lowercase()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(name: &str, host: &str) -> StoredConnection {
        StoredConnection {
            id: "existing-id".into(),
            name: name.into(),
            host: host.into(),
            port: 22,
            username: "root".into(),
            protocol: "ssh".into(),
            domain: None,
            auth_kind: "password".into(),
            key_path: None,
            group_name: None,
            has_password: true,
            has_passphrase: true,
            jump: None,
            color: None,
            created_at: "t0".into(),
            updated_at: "t0".into(),
        }
    }

    #[test]
    fn export_excludes_credentials_and_ids() {
        let file = export_file(&[stored("生产", "10.0.0.1")]);
        assert!(!file.credentials_included);
        let json = serde_json::to_string(&file).unwrap();
        assert!(!json.contains("has_password"));
        assert!(!json.contains("has_passphrase"));
        assert!(!json.contains("existing-id"));
        assert_eq!(file.connections.len(), 1);
        assert_eq!(file.connections[0].host, "10.0.0.1");
    }

    #[test]
    fn resolve_format_detects_json_by_leading_brace() {
        assert_eq!(
            resolve_format(ImportFormat::Auto, "  {\"format\":\"pterm-connections\"}"),
            ImportFormat::Pterm
        );
        assert_eq!(
            resolve_format(ImportFormat::Auto, "Host web\n  HostName 1.2.3.4"),
            ImportFormat::SshConfig
        );
        assert_eq!(
            resolve_format(ImportFormat::Pterm, "Host web"),
            ImportFormat::Pterm
        );
    }

    #[test]
    fn parse_ssh_config_maps_fields_and_skips_wildcards() {
        let text = "\
# 注释行
Host *
  User default-user
  ForwardAgent yes

Host web prod=web
  HostName 10.0.0.10
  Port 2222
  User deploy
  IdentityFile ~/.ssh/id_ed25519
";
        let (conns, warnings) = parse_ssh_config(text);
        assert!(warnings.is_empty());
        assert_eq!(conns.len(), 1);
        let c = &conns[0];
        assert_eq!(c.name, "web");
        assert_eq!(c.host, "10.0.0.10");
        assert_eq!(c.port, 2222);
        assert_eq!(c.username, "deploy");
        assert_eq!(c.auth_kind, "private_key");
        assert!(c.key_path.as_deref().unwrap_or("").ends_with(".ssh/id_ed25519"));
    }

    #[test]
    fn parse_ssh_config_keeps_first_jump_and_warns_on_multi() {
        let text = "Host db\n  HostName 10.0.0.20\n  ProxyJump a@jump1:2200,jump2\n";
        let (conns, warnings) = parse_ssh_config(text);
        assert_eq!(conns.len(), 1);
        assert_eq!(warnings.len(), 1);
        let jump = conns[0].jump.as_ref().expect("应解析出跳板机");
        assert_eq!(jump.host, "jump1");
        assert_eq!(jump.port, 2200);
        assert_eq!(jump.username, "a");
    }

    #[test]
    fn parse_ssh_config_falls_back_to_alias_without_hostname() {
        let text = "Host bare\n  Port=2200\n  User=someone\n";
        let (conns, _) = parse_ssh_config(text);
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0].host, "bare");
        assert_eq!(conns[0].port, 2200);
        assert_eq!(conns[0].username, "someone");
        assert_eq!(conns[0].auth_kind, "auto");
    }

    #[test]
    fn import_assigns_new_ids_and_skips_duplicates() {
        let dir = std::env::temp_dir().join(format!("pterm-ie-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("test.db")).unwrap();
        store.upsert_connection(&stored("生产", "10.0.0.1")).unwrap();

        let candidates = vec![
            // 与既有连接完全同名同址：应跳过
            ExportedConnection {
                name: "生产".into(),
                host: "10.0.0.1".into(),
                port: 22,
                username: "root".into(),
                protocol: "ssh".into(),
                domain: None,
                auth_kind: "password".into(),
                key_path: None,
                group_name: None,
                jump: None,
                color: None,
            },
            // 新连接：应导入，且 id 与既有不同、不带凭据
            ExportedConnection {
                name: "新主机".into(),
                host: "10.0.0.2".into(),
                port: 22,
                username: "root".into(),
                protocol: "ssh".into(),
                domain: None,
                auth_kind: "不存在的类型".into(),
                key_path: None,
                group_name: None,
                jump: None,
                color: None,
            },
        ];
        let (imported, skipped, saved) = import_into(&store, candidates).unwrap();
        assert_eq!((imported, skipped), (1, 1));
        assert_eq!(saved.len(), 1);
        assert_ne!(saved[0].id, "existing-id");
        assert!(!saved[0].has_password);
        assert_eq!(saved[0].auth_kind, "auto");
        assert_eq!(store.list_connections().unwrap().len(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_pterm_warns_on_unknown_tag() {
        let text = r#"{"format":"other","version":9,"exported_at":"t","credentials_included":true,"connections":[]}"#;
        let (conns, warnings) = parse_pterm(text).unwrap();
        assert!(conns.is_empty());
        assert_eq!(warnings.len(), 3);
    }

    /// RDP 条目导入后协议、域须保留，且未给端口时按 3389 兜底。
    #[test]
    fn import_keeps_rdp_protocol_and_defaults_port_to_3389() {
        let candidate = ExportedConnection {
            name: "桌面".into(),
            host: "10.0.0.9".into(),
            port: 0,
            username: "admin".into(),
            protocol: "rdp".into(),
            domain: Some("CORP".into()),
            auth_kind: "password".into(),
            key_path: None,
            group_name: None,
            jump: None,
            color: None,
        };
        let saved = into_stored(candidate, "t");
        assert_eq!(saved.protocol, crate::config::store::PROTOCOL_RDP);
        assert_eq!(saved.domain.as_deref(), Some("CORP"));
        assert_eq!(saved.port, 3389);
    }

    /// 未知协议值一律回退为 ssh，避免脏数据让连接进入无效协议分支。
    #[test]
    fn import_falls_back_to_ssh_for_unknown_protocol() {
        let candidate = ExportedConnection {
            name: "x".into(),
            host: "h".into(),
            port: 0,
            username: "u".into(),
            protocol: "telnet".into(),
            domain: None,
            auth_kind: "auto".into(),
            key_path: None,
            group_name: None,
            jump: None,
            color: None,
        };
        let saved = into_stored(candidate, "t");
        assert_eq!(saved.protocol, crate::config::store::PROTOCOL_SSH);
        assert_eq!(saved.port, 22);
    }
}