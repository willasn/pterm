//! 主密码加密的本地保险库。
//!
//! 敏感字段（SSH 密码 / 私钥 passphrase / 跳板机密码、AI API Key、Git 远端密码）
//! 统一保存在这里：用主密码经 Argon2id 派生出 32 字节密钥，再用 AES-256-GCM
//! 加密后落盘为配置目录下的 `secrets.json`。
//!
//! `secrets.json` 只含盐值与密文，可随 Git 同步一起分发；在另一台机器上输入
//! 同一主密码即可解开。代价是主密码遗失后无法恢复，只能重置保险库。
//!
//! 免重复输入：首次设置或输入主密码成功后，把派生密钥作为「自动解锁令牌」写入
//! 配置目录下的 `vault.token`（权限 0600），之后启动即可静默解锁，无需再次输入。
//! 该文件里只有派生密钥、没有主密码本身；重置保险库会一并删除。
//!
//! 说明：令牌放系统钥匙串更安全，但 macOS 在应用每次重新签名（开发构建的常态）后
//! 都会重新弹窗索要系统密码，故改存本地文件。因为令牌与 `secrets.json` 同机同目录，
//! 其安全性等同于「本机可读」，请勿把 `vault.token` 随手复制或提交到仓库。
//!
//! 主密码冲突：Git 同步导入的保险库若无法用本机已知密钥解开，说明两台机器用了
//! 不同的主密码。此时不会静默覆盖本地，而是暂存待用户选择「采用远端 / 保留本地 /
//! 暂停同步 secrets.json」。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// 保险库文件格式版本。
const VERSION: u32 = 1;
const KDF: &str = "argon2id";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
/// 校验主密码用的固定明文：能把它解出来即说明密钥正确。
const VERIFIER_PLAIN: &[u8] = b"pshell-vault-v1";

/// 保险库对外状态，供界面决定「设置主密码 / 解锁 / 已就绪 / 处理冲突」。
#[derive(Debug, Clone, Serialize)]
pub struct VaultStatus {
    /// 是否已设置主密码（`secrets.json` 存在且可解析）
    pub configured: bool,
    /// 是否已解锁（内存中持有派生密钥与明文条目）
    pub unlocked: bool,
    /// 是否存在待用户决策的「主密码不一致」冲突
    pub conflict: bool,
}

/// 导入外部保险库（Git 同步）的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportOutcome {
    /// 与本地完全一致，未做任何改动
    Unchanged,
    /// 本地原先没有保险库，已采用外部内容（随后需要输入主密码解锁）
    Adopted,
    /// 外部保险库与本地同一主密码，已导入并保持解锁
    Same,
    /// 本地已有保险库且主密码不同：不覆盖本地，暂存待用户决策
    Conflict,
}

/// 自动解锁令牌文件名，与 `secrets.json` 同目录。
const TOKEN_FILE: &str = "vault.token";

/// 一段密文：AEAD 的随机 nonce + 密文，均以 base64 存放。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Sealed {
    nonce: String,
    ct: String,
}

/// `secrets.json` 的结构。除盐值与密文外不含任何明文。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct VaultFile {
    version: u32,
    kdf: String,
    salt: String,
    verifier: Sealed,
    payload: Sealed,
}

struct Vault {
    path: PathBuf,
    file: Option<VaultFile>,
    key: Option<[u8; KEY_LEN]>,
    entries: BTreeMap<String, String>,
    /// 主密码冲突时暂存的「远端保险库」原始字节，等用户决策后再落盘或丢弃。
    pending: Option<Vec<u8>>,
}

impl Vault {
    /// 读取磁盘上的保险库元信息；此时尚未解锁，明文条目为空。
    fn load(path: PathBuf) -> AppResult<Self> {
        let file = read_file(&path)?;
        Ok(Self {
            path,
            file,
            key: None,
            entries: BTreeMap::new(),
            pending: None,
        })
    }

    fn status(&self) -> VaultStatus {
        VaultStatus {
            configured: self.file.is_some(),
            unlocked: self.key.is_some(),
            conflict: self.pending.is_some(),
        }
    }

    /// 首次设置主密码，创建空保险库并直接解锁。
    fn setup(&mut self, password: &str) -> AppResult<()> {
        if self.file.is_some() {
            return Err(AppError::Vault("主密码已设置，请直接解锁".into()));
        }
        let salt = random_bytes(SALT_LEN)?;
        let key = derive_key(password, &salt)?;
        let entries: BTreeMap<String, String> = BTreeMap::new();
        let payload = seal(&key, &serde_json::to_vec(&entries).map_err(json_err)?)?;
        let file = VaultFile {
            version: VERSION,
            kdf: KDF.into(),
            salt: B64.encode(&salt),
            verifier: seal(&key, VERIFIER_PLAIN)?,
            payload,
        };
        write_file(&self.path, &file)?;
        self.file = Some(file);
        self.key = Some(key);
        self.entries = entries;
        token_store(&self.path, &key);
        log::info!("已创建加密保险库 {}", self.path.display());
        Ok(())
    }

    /// 用主密码解锁：解出校验明文即认为密码正确，再解密全部条目。
    fn unlock(&mut self, password: &str) -> AppResult<()> {
        let file = self
            .file
            .clone()
            .ok_or_else(|| AppError::Vault("尚未设置主密码".into()))?;
        if file.version != VERSION {
            return Err(AppError::Vault(format!(
                "保险库版本 {} 不受支持",
                file.version
            )));
        }
        let salt = B64
            .decode(&file.salt)
            .map_err(|e| AppError::Vault(format!("盐值解析失败：{e}")))?;
        let key = derive_key(password, &salt)?;
        if open(&key, &file.verifier)? != VERIFIER_PLAIN {
            return Err(AppError::Vault("主密码错误".into()));
        }
        let plain = open(&key, &file.payload)?;
        let entries: BTreeMap<String, String> = serde_json::from_slice(&plain)
            .map_err(|e| AppError::Vault(format!("保险库内容解析失败：{e}")))?;
        self.key = Some(key);
        self.entries = entries;
        token_store(&self.path, &key);
        Ok(())
    }

    /// 用本地自动解锁令牌静默解锁。无令牌或令牌对不上当前文件时返回 `false`。
    ///
    /// 令牌是派生密钥本身，因此无需密码即可解密；文件被换成另一套主密码加密的
    /// 保险库（例如 Git 同步导入）时校验失败，交由上层走正常解锁或冲突流程。
    fn auto_unlock(&mut self) -> bool {
        let file = match self.file.as_ref() {
            Some(file) => file.clone(),
            None => return false,
        };
        let key = match token_load(&self.path) {
            Some(key) => key,
            None => return false,
        };
        if open(&key, &file.verifier).ok().as_deref() != Some(VERIFIER_PLAIN) {
            return false;
        }
        let entries: BTreeMap<String, String> = match open(&key, &file.payload)
            .and_then(|plain| serde_json::from_slice(&plain).map_err(json_err))
        {
            Ok(entries) => entries,
            Err(e) => {
                log::warn!("自动解锁令牌无法解开保险库内容：{e}");
                return false;
            }
        };
        self.key = Some(key);
        self.entries = entries;
        true
    }

    /// 本机已知的密钥：优先内存中已解锁的密钥，其次本地令牌文件里的自动解锁令牌。
    /// 用于判断同步导入的保险库是否与本机同一主密码。
    fn known_key(&self) -> Option<[u8; KEY_LEN]> {
        self.key.or_else(|| token_load(&self.path))
    }

    /// 丢弃内存中的密钥与明文，回到未解锁状态。
    fn lock(&mut self) {
        self.key = None;
        self.entries.clear();
    }

    /// 修改主密码：先用当前密码校验通过，再换新盐重算密钥、重新加密全部条目。
    ///
    /// 已解锁与否都统一走「解密校验 + 重加密」，因此不依赖内存中的明文状态。
    fn change_password(&mut self, current: &str, next: &str) -> AppResult<()> {
        let file = self
            .file
            .clone()
            .ok_or_else(|| AppError::Vault("尚未设置主密码".into()))?;
        let salt = B64
            .decode(&file.salt)
            .map_err(|e| AppError::Vault(format!("盐值解析失败：{e}")))?;
        let old_key = derive_key(current, &salt)?;
        if open(&old_key, &file.verifier)? != VERIFIER_PLAIN {
            return Err(AppError::Vault("当前主密码错误".into()));
        }
        let entries: BTreeMap<String, String> = serde_json::from_slice(&open(&old_key, &file.payload)?)
            .map_err(|e| AppError::Vault(format!("保险库内容解析失败：{e}")))?;

        let new_salt = random_bytes(SALT_LEN)?;
        let new_key = derive_key(next, &new_salt)?;
        let new_file = VaultFile {
            version: VERSION,
            kdf: KDF.into(),
            salt: B64.encode(&new_salt),
            verifier: seal(&new_key, VERIFIER_PLAIN)?,
            payload: seal(&new_key, &serde_json::to_vec(&entries).map_err(json_err)?)?,
        };
        write_file(&self.path, &new_file)?;
        self.file = Some(new_file);
        self.key = Some(new_key);
        self.entries = entries;
        token_store(&self.path, &new_key);
        log::info!("已使用新主密码重新加密保险库 {}", self.path.display());
        Ok(())
    }

    fn set(&mut self, key: &str, value: &str) -> AppResult<()> {
        self.require_unlocked()?;
        self.entries.insert(key.to_string(), value.to_string());
        self.persist()
    }

    fn get(&self, key: &str) -> AppResult<Option<String>> {
        // 还没设置主密码时不可能存在敏感字段；已设置但未解锁必须报错，
        // 否则调用方会把「读不到」误判成「没保存」。
        if self.file.is_none() {
            return Ok(None);
        }
        self.require_unlocked()?;
        Ok(self.entries.get(key).cloned())
    }

    fn delete(&mut self, key: &str) -> AppResult<()> {
        self.require_unlocked()?;
        if self.entries.remove(key).is_none() {
            return Ok(());
        }
        self.persist()
    }

    fn require_unlocked(&self) -> AppResult<()> {
        if self.key.is_some() {
            Ok(())
        } else {
            Err(AppError::Vault("保险库未解锁，请先输入主密码".into()))
        }
    }

    /// 用内存中的密钥重新加密全部条目并落盘。
    fn persist(&mut self) -> AppResult<()> {
        let key = self
            .key
            .ok_or_else(|| AppError::Vault("保险库未解锁，请先输入主密码".into()))?;
        let plain = serde_json::to_vec(&self.entries).map_err(json_err)?;
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| AppError::Vault("尚未设置主密码".into()))?;
        file.payload = seal(&key, &plain)?;
        let snapshot = file.clone();
        write_file(&self.path, &snapshot)
    }

    /// 落盘文件的原始字节，供 Git 同步导出；未设置主密码时为 `None`。
    fn export_bytes(&self) -> AppResult<Option<Vec<u8>>> {
        if self.path.exists() {
            Ok(Some(std::fs::read(&self.path)?))
        } else {
            Ok(None)
        }
    }

    /// 用外部字节覆盖本地保险库（Git 同步导入）。
    ///
    /// 本地已有保险库、且外部内容无法用本机已知密钥解开时，判定为「主密码不一致」：
    /// 不覆盖本地，改为把外部字节暂存到 `pending`，由用户决定采用哪一边。
    fn import_bytes(&mut self, bytes: &[u8]) -> AppResult<ImportOutcome> {
        if self.path.exists() && std::fs::read(&self.path)? == bytes {
            return Ok(ImportOutcome::Unchanged);
        }
        let incoming = parse_file_bytes(bytes)?
            .ok_or_else(|| AppError::Vault("同步的保险库内容为空".into()))?;
        if self.file.is_some() {
            if let Some(key) = self.known_key() {
                if open(&key, &incoming.verifier).ok().as_deref() == Some(VERIFIER_PLAIN) {
                    // 同一主密码：直接采用，并保持解锁（条目可能来自另一台机器）
                    let entries: BTreeMap<String, String> =
                        serde_json::from_slice(&open(&key, &incoming.payload)?).map_err(json_err)?;
                    self.write_bytes(bytes, incoming, key, entries)?;
                    self.pending = None;
                    return Ok(ImportOutcome::Same);
                }
                log::warn!("同步仓库中的保险库由不同主密码加密，已暂存待用户决策");
                self.pending = Some(bytes.to_vec());
                return Ok(ImportOutcome::Conflict);
            }
            // 既未解锁、也没有本地令牌：无法验证，退化为「直接采用并加锁」
        }
        // 本地原本没有保险库（或无法验证）：采用外部内容，随后需要输入主密码解锁
        std::fs::write(&self.path, bytes)?;
        self.file = read_file(&self.path)?;
        self.lock();
        self.pending = None;
        Ok(ImportOutcome::Adopted)
    }

    /// 用户选择「采用远端」：用远端主密码校验暂存的保险库，通过后落盘并解锁。
    fn adopt_pending(&mut self, password: &str) -> AppResult<()> {
        let bytes = self
            .pending
            .clone()
            .ok_or_else(|| AppError::Vault("当前没有待处理的主密码冲突".into()))?;
        let file = parse_file_bytes(&bytes)?
            .ok_or_else(|| AppError::Vault("待处理的保险库内容为空".into()))?;
        let salt = B64
            .decode(&file.salt)
            .map_err(|e| AppError::Vault(format!("盐值解析失败：{e}")))?;
        let key = derive_key(password, &salt)?;
        if open(&key, &file.verifier)? != VERIFIER_PLAIN {
            return Err(AppError::Vault("远端主密码错误".into()));
        }
        let entries: BTreeMap<String, String> =
            serde_json::from_slice(&open(&key, &file.payload)?).map_err(json_err)?;
        self.write_bytes(&bytes, file, key, entries)?;
        self.pending = None;
        token_store(&self.path, &key);
        log::info!("已采用同步仓库中的保险库，主密码冲突已解决");
        Ok(())
    }

    /// 用户选择「保留本地」或「暂停同步」：丢弃暂存的远端保险库，保持本地不变。
    fn discard_pending(&mut self) {
        self.pending = None;
    }

    /// 是否有待用户决策的主密码冲突。
    fn pending_conflict(&self) -> bool {
        self.pending.is_some()
    }

    /// 把原样字节落盘并切换内存状态（保留字节原文，便于下次同步做「内容相同」判断）。
    fn write_bytes(
        &mut self,
        bytes: &[u8],
        file: VaultFile,
        key: [u8; KEY_LEN],
        entries: BTreeMap<String, String>,
    ) -> AppResult<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&self.path, bytes)?;
        restrict_permissions(&self.path);
        self.file = Some(file);
        self.key = Some(key);
        self.entries = entries;
        Ok(())
    }

    /// 清除保险库（忘记主密码时的兜底）：删除文件、加锁并删除自动解锁令牌。
    fn reset(&mut self) -> AppResult<()> {
        if self.path.exists() {
            std::fs::remove_file(&self.path)?;
        }
        self.file = None;
        self.lock();
        self.pending = None;
        token_clear(&self.path);
        log::warn!("保险库已被重置，原有敏感字段全部清除");
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 全局单例
// ---------------------------------------------------------------------------

static VAULT: OnceLock<Mutex<Vault>> = OnceLock::new();

fn with<R>(f: impl FnOnce(&mut Vault) -> AppResult<R>) -> AppResult<R> {
    let cell = VAULT
        .get()
        .ok_or_else(|| AppError::Vault("保险库尚未初始化".into()))?;
    let mut guard = cell.lock();
    f(&mut guard)
}

/// 启动时调用一次，绑定 `secrets.json` 的落盘路径。
pub fn init(path: PathBuf) -> AppResult<()> {
    let vault = Vault::load(path)?;
    let _ = VAULT.set(Mutex::new(vault));
    Ok(())
}

pub fn status() -> AppResult<VaultStatus> {
    with(|v| Ok(v.status()))
}

/// 启动时尝试用本地自动解锁令牌静默解锁；成功返回 `true`。
pub fn auto_unlock() -> AppResult<bool> {
    with(|v| Ok(v.auto_unlock()))
}

pub fn setup(password: &str) -> AppResult<()> {
    with(|v| v.setup(password))
}

pub fn unlock(password: &str) -> AppResult<()> {
    with(|v| v.unlock(password))
}

/// 修改主密码，成功后内存中保持解锁（用新密钥）。
pub fn change_password(current: &str, next: &str) -> AppResult<()> {
    with(|v| v.change_password(current, next))
}

pub fn lock() -> AppResult<()> {
    with(|v| {
        v.lock();
        Ok(())
    })
}

pub fn set(key: &str, value: &str) -> AppResult<()> {
    with(|v| v.set(key, value))
}

pub fn get(key: &str) -> AppResult<Option<String>> {
    with(|v| v.get(key))
}

pub fn delete(key: &str) -> AppResult<()> {
    with(|v| v.delete(key))
}

pub fn export_bytes() -> AppResult<Option<Vec<u8>>> {
    with(|v| v.export_bytes())
}

pub fn import_bytes(bytes: &[u8]) -> AppResult<ImportOutcome> {
    with(|v| v.import_bytes(bytes))
}

/// 是否存在待用户决策的主密码冲突。
pub fn pending_conflict() -> AppResult<bool> {
    with(|v| Ok(v.pending_conflict()))
}

/// 采用暂存的远端保险库（用户需提供远端主密码）。
pub fn adopt_pending(password: &str) -> AppResult<()> {
    with(|v| v.adopt_pending(password))
}

/// 丢弃暂存的远端保险库，保持本地不变。
pub fn discard_pending() -> AppResult<()> {
    with(|v| {
        v.discard_pending();
        Ok(())
    })
}

pub fn reset() -> AppResult<()> {
    with(|v| v.reset())
}

// ---------------------------------------------------------------------------
// 加密原语
// ---------------------------------------------------------------------------

fn json_err(e: serde_json::Error) -> AppError {
    AppError::Vault(format!("保险库序列化失败：{e}"))
}

fn random_bytes(len: usize) -> AppResult<Vec<u8>> {
    let mut buf = vec![0u8; len];
    getrandom::getrandom(&mut buf).map_err(|e| AppError::Vault(format!("生成随机数失败：{e}")))?;
    Ok(buf)
}

/// Argon2id 派生 32 字节密钥。
fn derive_key(password: &str, salt: &[u8]) -> AppResult<[u8; KEY_LEN]> {
    let mut key = [0u8; KEY_LEN];
    argon2::Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| AppError::Vault(format!("派生密钥失败：{e}")))?;
    Ok(key)
}

fn seal(key: &[u8; KEY_LEN], plain: &[u8]) -> AppResult<Sealed> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| AppError::Vault(format!("初始化加密器失败：{e}")))?;
    let nonce = random_bytes(NONCE_LEN)?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plain)
        .map_err(|e| AppError::Vault(format!("加密失败：{e}")))?;
    Ok(Sealed {
        nonce: B64.encode(&nonce),
        ct: B64.encode(&ct),
    })
}

fn open(key: &[u8; KEY_LEN], sealed: &Sealed) -> AppResult<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| AppError::Vault(format!("初始化解密器失败：{e}")))?;
    let nonce = B64
        .decode(&sealed.nonce)
        .map_err(|e| AppError::Vault(format!("nonce 解析失败：{e}")))?;
    if nonce.len() != NONCE_LEN {
        return Err(AppError::Vault("nonce 长度非法".into()));
    }
    let ct = B64
        .decode(&sealed.ct)
        .map_err(|e| AppError::Vault(format!("密文解析失败：{e}")))?;
    cipher
        .decrypt(Nonce::from_slice(&nonce), ct.as_ref())
        .map_err(|_| AppError::Vault("主密码错误或保险库数据已损坏".into()))
}

fn read_file(path: &Path) -> AppResult<Option<VaultFile>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path)?;
    parse_file_bytes(&bytes)
}

/// 解析保险库文件字节；空文件视为「尚未设置主密码」。
fn parse_file_bytes(bytes: &[u8]) -> AppResult<Option<VaultFile>> {
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(None);
    }
    let file: VaultFile = serde_json::from_slice(bytes)
        .map_err(|e| AppError::Vault(format!("解析保险库失败：{e}")))?;
    Ok(Some(file))
}

fn write_file(path: &Path, file: &VaultFile) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(file).map_err(json_err)?;
    std::fs::write(path, text)?;
    restrict_permissions(path);
    Ok(())
}

/// 保险库即便只是密文，也限制为仅本人可读（仅 Unix）。
fn restrict_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

// ---------------------------------------------------------------------------
// 自动解锁令牌：派生密钥落盘为本地文件（与 `secrets.json` 同目录）
// ---------------------------------------------------------------------------
//
// 早先存在系统钥匙串（macOS Keychain / Windows 凭据管理器），但 macOS 在应用
// 每次重新签名（开发构建的常态）后都会重新弹窗索要系统密码，故改为普通文件 +
// 0600 权限：开发期无需反复授权，代价是令牌与本机可读的密文同处一地。

/// 令牌文件路径：与保险库文件同目录。
fn token_path(vault_path: &Path) -> PathBuf {
    vault_path.with_file_name(TOKEN_FILE)
}

/// 读取自动解锁令牌。任何失败都视为「没有令牌」，交由用户输入主密码。
fn token_load(vault_path: &Path) -> Option<[u8; KEY_LEN]> {
    // 测试不触碰真实令牌文件，避免污染开发者环境
    if cfg!(test) {
        return None;
    }
    let text = std::fs::read_to_string(token_path(vault_path)).ok()?;
    let raw = B64.decode(text.trim()).ok()?;
    if raw.len() != KEY_LEN {
        return None;
    }
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(&raw);
    Some(key)
}

/// 把自动解锁令牌写入本地文件。失败只记日志，不影响主密码流程。
fn token_store(vault_path: &Path, key: &[u8; KEY_LEN]) {
    if cfg!(test) {
        return;
    }
    let path = token_path(vault_path);
    if let Err(e) = std::fs::write(&path, B64.encode(key)) {
        log::warn!("写入自动解锁令牌失败：{e}");
        return;
    }
    restrict_permissions(&path);
}

/// 删除本地自动解锁令牌。
fn token_clear(vault_path: &Path) {
    if cfg!(test) {
        return;
    }
    let _ = std::fs::remove_file(token_path(vault_path));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("pshell-vault-{tag}-{}.json", uuid::Uuid::new_v4()))
    }

    #[test]
    fn setup_then_unlock_roundtrip() {
        let path = temp_path("roundtrip");
        let mut vault = Vault::load(path.clone()).unwrap();
        assert!(!vault.status().configured);
        vault.setup("s3cret").unwrap();
        assert!(vault.status().configured && vault.status().unlocked);
        vault.set("conn:a:password", "pw").unwrap();

        let mut reopened = Vault::load(path.clone()).unwrap();
        assert!(reopened.status().configured && !reopened.status().unlocked);
        // 未解锁时读取必须报错，而不是当成「未保存」
        assert!(reopened.get("conn:a:password").is_err());
        reopened.unlock("s3cret").unwrap();
        assert_eq!(
            reopened.get("conn:a:password").unwrap().as_deref(),
            Some("pw")
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn wrong_password_is_rejected() {
        let path = temp_path("wrongpw");
        let mut vault = Vault::load(path.clone()).unwrap();
        vault.setup("right").unwrap();

        let mut reopened = Vault::load(path.clone()).unwrap();
        assert!(reopened.unlock("wrong").is_err());
        assert!(!reopened.status().unlocked);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn change_password_reencrypts_and_rejects_old() {
        let path = temp_path("change-pw");
        let mut vault = Vault::load(path.clone()).unwrap();
        vault.setup("old-pw").unwrap();
        vault.set("k", "v").unwrap();
        vault.change_password("old-pw", "new-pw").unwrap();
        // 已解锁且用新密钥，条目仍在
        assert_eq!(vault.get("k").unwrap().as_deref(), Some("v"));

        let mut reopened = Vault::load(path.clone()).unwrap();
        assert!(reopened.unlock("old-pw").is_err());
        reopened.unlock("new-pw").unwrap();
        assert_eq!(reopened.get("k").unwrap().as_deref(), Some("v"));

        // 当前密码错误时不得改动文件
        assert!(reopened.change_password("bogus", "x").is_err());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn delete_removes_entry() {
        let path = temp_path("delete");
        let mut vault = Vault::load(path.clone()).unwrap();
        vault.setup("pw").unwrap();
        vault.set("k", "v").unwrap();
        vault.delete("k").unwrap();
        assert_eq!(vault.get("k").unwrap(), None);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn import_replaces_and_relocks() {
        let src = temp_path("src");
        let dst = temp_path("dst");
        let mut a = Vault::load(src.clone()).unwrap();
        a.setup("pw").unwrap();
        a.set("k", "v").unwrap();
        let bytes = a.export_bytes().unwrap().unwrap();

        let mut b = Vault::load(dst.clone()).unwrap();
        assert_eq!(b.import_bytes(&bytes).unwrap(), ImportOutcome::Adopted);
        assert!(b.status().configured && !b.status().unlocked);
        // 内容一致时不重复覆盖
        assert_eq!(b.import_bytes(&bytes).unwrap(), ImportOutcome::Unchanged);
        b.unlock("pw").unwrap();
        assert_eq!(b.get("k").unwrap().as_deref(), Some("v"));

        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn import_with_different_master_password_is_conflict() {
        let src = temp_path("conflict-src");
        let dst = temp_path("conflict-dst");
        let mut remote = Vault::load(src.clone()).unwrap();
        remote.setup("remote-pw").unwrap();
        remote.set("k", "remote-value").unwrap();
        let bytes = remote.export_bytes().unwrap().unwrap();

        let mut local = Vault::load(dst.clone()).unwrap();
        local.setup("local-pw").unwrap();
        local.set("k", "local-value").unwrap();

        // 本地已有保险库且主密码不同：不覆盖本地，暂存冲突
        assert_eq!(local.import_bytes(&bytes).unwrap(), ImportOutcome::Conflict);
        assert!(local.status().conflict);
        assert_eq!(local.get("k").unwrap().as_deref(), Some("local-value"));

        // 用错密码不能采用远端
        assert!(local.adopt_pending("local-pw").is_err());
        assert!(local.status().conflict);

        // 用远端主密码采用远端
        local.adopt_pending("remote-pw").unwrap();
        assert!(!local.status().conflict);
        assert_eq!(local.get("k").unwrap().as_deref(), Some("remote-value"));

        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    #[test]
    fn discard_pending_keeps_local() {
        let src = temp_path("discard-src");
        let dst = temp_path("discard-dst");
        let mut remote = Vault::load(src.clone()).unwrap();
        remote.setup("remote-pw").unwrap();
        let bytes = remote.export_bytes().unwrap().unwrap();

        let mut local = Vault::load(dst.clone()).unwrap();
        local.setup("local-pw").unwrap();
        local.set("k", "local-value").unwrap();
        assert_eq!(local.import_bytes(&bytes).unwrap(), ImportOutcome::Conflict);

        local.discard_pending();
        assert!(!local.status().conflict);
        assert_eq!(local.get("k").unwrap().as_deref(), Some("local-value"));

        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }
}
