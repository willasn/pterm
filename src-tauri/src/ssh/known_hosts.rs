//! 主机密钥校验（known_hosts）。
//!
//! SSH 客户端必须校验服务端主机密钥，否则无法抵御中间人攻击。本模块用配置目录下的
//! `known_hosts.json` 记录「首次信任」过的主机指纹（TOFU），连接时逐次比对：
//!
//! - 已记录且一致 → 通过；
//! - 从未见过 → 默认拒绝，由前端弹窗确认后才写入（`HostKeyPolicy::AcceptNew`）；
//! - 已有记录但不一致 → 默认拒绝（疑似中间人），需用户显式确认才覆盖（`AcceptAny`）。
//!
//! 该文件是本机私有的，不随 Git 同步——不同设备信任的密钥集合本就应当各自维护。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ssh2::Session;

use crate::config::ConfigManager;
use crate::error::{AppError, AppResult};

/// 会话侧声明的主机密钥信任策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostKeyPolicy {
    /// 默认：未见过或不一致一律拒绝。
    #[default]
    Strict,
    /// 接受并记录首次见到的主机密钥（首次连接的「信任并继续」）。
    AcceptNew,
    /// 接受任何主机密钥（含与记录不一致），并覆盖为新的（「我知道我在做什么」）。
    AcceptAny,
}

/// 单次比对的结论。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum HostKeyStatus {
    /// 已有记录且与实际一致
    Match,
    /// 已有记录但实际密钥不同
    Mismatch {
        known_fingerprint: String,
        known_key_type: String,
    },
    /// 从未记录过该主机
    Unknown,
}

/// 传给前端的主机密钥上下文（用于弹窗展示与确认）。
#[derive(Debug, Clone, Serialize)]
pub struct HostKeyInfo {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub status: HostKeyStatus,
}

/// 一条已知主机记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub added_at: String,
}

impl Default for KnownHostEntry {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 22,
            key_type: String::new(),
            fingerprint: String::new(),
            added_at: String::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct KnownHostsFile {
    entries: Vec<KnownHostEntry>,
}

/// 已知主机存储。内存里是一张 `host:port -> entry` 表，落盘为 `known_hosts.json`。
pub struct KnownHostsStore {
    path: PathBuf,
    inner: Mutex<HashMap<String, KnownHostEntry>>,
}

impl KnownHostsStore {
    /// 从磁盘加载；文件缺失或损坏时退回空表（损坏时告警但不阻断启动）。
    pub fn load(path: PathBuf) -> Self {
        let mut map = HashMap::new();
        match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<KnownHostsFile>(&bytes) {
                Ok(file) => {
                    for entry in file.entries {
                        map.insert(Self::key(&entry.host, entry.port), entry);
                    }
                }
                Err(e) => log::warn!("known_hosts.json 解析失败，按空表处理：{e}"),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("读取 known_hosts.json 失败：{e}"),
        }
        Self {
            path,
            inner: Mutex::new(map),
        }
    }

    fn key(host: &str, port: u16) -> String {
        format!("{host}:{port}")
    }

    /// 比对实际主机密钥与记录。
    pub fn check(&self, host: &str, port: u16, key_type: &str, fingerprint: &str) -> HostKeyStatus {
        match self.inner.lock().get(&Self::key(host, port)) {
            Some(entry) if entry.fingerprint == fingerprint => HostKeyStatus::Match,
            Some(entry) => HostKeyStatus::Mismatch {
                known_fingerprint: entry.fingerprint.clone(),
                known_key_type: entry.key_type.clone(),
            },
            None => {
                let _ = key_type; // 未记录时只关心是否见过，无需用到类型
                HostKeyStatus::Unknown
            }
        }
    }

    /// 记录（或覆盖）一台主机的主机密钥。
    pub fn trust(&self, host: &str, port: u16, key_type: &str, fingerprint: &str) -> AppResult<()> {
        let entry = KnownHostEntry {
            host: host.to_string(),
            port,
            key_type: key_type.to_string(),
            fingerprint: fingerprint.to_string(),
            added_at: chrono::Utc::now().to_rfc3339(),
        };
        self.inner.lock().insert(Self::key(host, port), entry);
        self.persist()
    }

    /// 删除一台主机的记录（下次连接会重新走首次信任）。
    pub fn forget(&self, host: &str, port: u16) -> AppResult<()> {
        self.inner.lock().remove(&Self::key(host, port));
        self.persist()
    }

    /// 全部记录，按 host:port 排序，供设置界面展示。
    pub fn list(&self) -> Vec<KnownHostEntry> {
        let mut out: Vec<KnownHostEntry> = self.inner.lock().values().cloned().collect();
        out.sort_by(|a, b| {
            (a.host.as_str(), a.port)
                .cmp(&(b.host.as_str(), b.port))
        });
        out
    }

    fn persist(&self) -> AppResult<()> {
        let file = KnownHostsFile {
            entries: self.inner.lock().values().cloned().collect(),
        };
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_vec_pretty(&file)?;
        std::fs::write(&self.path, text)?;
        Ok(())
    }
}

/// 计算 OpenSSH 风格的 SHA256 指纹：`SHA256:<base64(sha256(blob))>`（去掉 base64 填充）。
pub fn fingerprint(blob: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(blob);
    let digest = hasher.finalize();
    let b64 = BASE64.encode(digest);
    format!("SHA256:{}", b64.trim_end_matches('='))
}

/// 从 SSH 公钥线格式（`string keytype` + 数据）里取出算法名，如 `ssh-ed25519`。
/// 直接解析可避免依赖 ssh2 的 `KeyType` 枚举定义。
fn key_type_from_blob(blob: &[u8]) -> String {
    if blob.len() < 4 {
        return "unknown".into();
    }
    let len = u32::from_be_bytes([blob[0], blob[1], blob[2], blob[3]]) as usize;
    if len == 0 || 4 + len > blob.len() {
        return "unknown".into();
    }
    String::from_utf8_lossy(&blob[4..4 + len]).into_owned()
}

/// 读取会话协商出的主机密钥，返回 `(算法, 指纹)`。
pub fn session_host_key(sess: &Session) -> AppResult<(String, String)> {
    match sess.host_key() {
        // ssh2 返回 (公钥线格式字节, 密钥类型枚举)
        Some((blob, _kt)) => Ok((key_type_from_blob(blob), fingerprint(blob))),
        None => Err(AppError::Ssh("无法获取服务端主机密钥".into())),
    }
}

/// 按策略校验一次会话的主机密钥；通过返回信息，未通过返回 [`AppError::HostKey`]。
pub fn verify(
    sess: &Session,
    store: &KnownHostsStore,
    host: &str,
    port: u16,
    policy: HostKeyPolicy,
) -> AppResult<HostKeyInfo> {
    let (key_type, fingerprint) = session_host_key(sess)?;
    let status = store.check(host, port, &key_type, &fingerprint);

    let info = HostKeyInfo {
        host: host.to_string(),
        port,
        key_type: key_type.clone(),
        fingerprint: fingerprint.clone(),
        status: status.clone(),
    };

    match status {
        HostKeyStatus::Match => Ok(info),
        HostKeyStatus::Unknown => {
            if matches!(policy, HostKeyPolicy::AcceptNew | HostKeyPolicy::AcceptAny) {
                store.trust(host, port, &key_type, &fingerprint)?;
                log::info!("已信任 {host}:{port} 的主机密钥（{key_type} {fingerprint}）");
                Ok(info)
            } else {
                Err(AppError::HostKey(info))
            }
        }
        HostKeyStatus::Mismatch { .. } => {
            if policy == HostKeyPolicy::AcceptAny {
                store.trust(host, port, &key_type, &fingerprint)?;
                log::warn!("已按用户确认覆盖 {host}:{port} 的主机密钥（{key_type} {fingerprint}）");
                Ok(info)
            } else {
                Err(AppError::HostKey(info))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 全局校验器
// ---------------------------------------------------------------------------

/// 全局校验器：启动时安装一次，供所有建连路径（终端 / SFTP / 端口转发 / 跳板机）共用，
/// 避免把「存储 + 配置」一路透传到每个模块。风格与 `config::vault` 的全局单例一致。
struct Verifier {
    store: Arc<KnownHostsStore>,
    config: Arc<ConfigManager>,
}

static VERIFIER: OnceLock<Verifier> = OnceLock::new();

/// 安装全局校验器。启动时调用一次，重复调用无副作用。
pub fn install(store: Arc<KnownHostsStore>, config: Arc<ConfigManager>) {
    let _ = VERIFIER.set(Verifier { store, config });
}

/// 按当前配置与连接策略校验会话的主机密钥。
///
/// 校验开关关闭、或未安装校验器（如单元测试）时直接通过。
pub fn verify_session(
    sess: &Session,
    host: &str,
    port: u16,
    policy: HostKeyPolicy,
) -> AppResult<HostKeyInfo> {
    let Some(verifier) = VERIFIER.get() else {
        return session_host_key(sess).map(|(key_type, fingerprint)| HostKeyInfo {
            host: host.to_string(),
            port,
            key_type,
            fingerprint,
            status: HostKeyStatus::Match,
        });
    };
    if !verifier.config.flags().connection.host_key_check {
        return session_host_key(sess).map(|(key_type, fingerprint)| HostKeyInfo {
            host: host.to_string(),
            port,
            key_type,
            fingerprint,
            status: HostKeyStatus::Match,
        });
    }
    verify(sess, &verifier.store, host, port, policy)
}

/// 后台连接（SFTP / 端口转发 / 跳板机）专用：这些路径**无法弹窗**让用户确认指纹，
/// 未确认 / 已变更时给出可操作的提示，而不是泛泛的「校验未通过」。
pub fn verify_session_strict(
    sess: &Session,
    host: &str,
    port: u16,
    policy: HostKeyPolicy,
) -> AppResult<()> {
    match verify_session(sess, host, port, policy) {
        Ok(_) => Ok(()),
        Err(AppError::HostKey(info)) => {
            let reason = match &info.status {
                HostKeyStatus::Mismatch { .. } => {
                    "主机密钥已变更，存在中间人风险；请在终端中连接该主机并确认后再试"
                }
                _ => "主机密钥尚未确认；请先在终端中连接该主机完成首次信任后再试",
            };
            Err(AppError::Ssh(format!(
                "{}:{} {}（{} {}）",
                info.host, info.port, reason, info.key_type, info.fingerprint
            )))
        }
        Err(e) => Err(e),
    }
}
