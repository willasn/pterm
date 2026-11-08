//! 激活码授权（Git 同步的门控）。
//!
//! 授权能力来自 [`zely_license`]（<https://github.com/willasn/zely-issuance>），
//! 以 cargo git 依赖按 tag 引入，服务端为 <https://zely.dev>。本模块负责：
//! - 本地授权状态读写（配置目录下的 `license.json`，带 HMAC 完整性保护）
//! - 激活码在线激活、离线凭证验签、临近到期时静默续签
//! - 向设置 / Git 同步界面提供可展示的状态
//!
//! 公钥来源优先级：
//! 1. 构建期注入的 `ZELY_LICENSE_PUBLIC_KEY`（推荐，离线首启即可验签）
//! 2. 配置目录下已缓存的 `license.pubkey.pem`
//! 3. 首次激活时从 `GET /api/v1/licensing/public-key` 拉取并缓存
//!
//! 注意：第 3 条只作为兜底，首次拉取仍受网络可达性与 TLS 信任影响。

pub mod commands;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

use zely_license as zely;
use zely::Entitlement;

/// 授权服务地址。
const BASE_URL: &str = match option_env!("ZELY_LICENSE_BASE_URL") {
    Some(url) => url,
    None => "https://zely.dev",
};

/// 构建期注入的公钥（未注入时为空）。
const EMBEDDED_PUBLIC_KEY: Option<&str> = option_env!("ZELY_LICENSE_PUBLIC_KEY");

/// 产品标识，必须与服务端签发时写入凭证的 `p` 一致。
/// 三个产品共用同一套 SDK，靠这个字段隔离授权。
const PRODUCT_ID: &str = "pterm";

/// `license.json` 的完整性密钥。生产构建应通过
/// `ZELY_LICENSE_INTEGRITY_KEY` 注入；未注入时退回应用内常量，
/// 仍能挡住手工编辑，但强度弱于注入值。
const INTEGRITY_KEY: &[u8] = match option_env!("ZELY_LICENSE_INTEGRITY_KEY") {
    Some(key) => key.as_bytes(),
    None => b"pterm-license-integrity-v1",
};

/// 上报给服务端的设备名（仅用于设备列表展示）。
const DEVICE_NAME: &str = "PTerm";

/// 激活码授权服务。只持有本机文件路径，可安全 clone 到后台任务。
#[derive(Debug, Clone)]
pub struct LicenseService {
    /// 授权状态文件 `license.json`
    state_path: PathBuf,
    /// 公钥缓存文件 `license.pubkey.pem`
    key_path: PathBuf,
}

/// 授权状态快照，供前端展示与门控判断。
#[derive(Debug, Clone, Serialize)]
pub struct LicenseStatusView {
    /// free | active | expiring | grace | locked | needs_activation | clock_rollback
    pub state: String,
    /// 是否解锁付费功能（激活 / 即将到期 / 宽限期内）
    pub unlocked: bool,
    pub plan: Option<String>,
    pub expires_at: Option<String>,
    pub grace_ends_at: Option<String>,
    pub days_left: Option<i64>,
    /// 已激活的授权码（脱敏）
    pub key_hint: Option<String>,
    pub device_id: Option<String>,
    /// 面向用户的说明文案
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct PublicKeyEnvelope {
    code: String,
    message: String,
    data: Option<PublicKeyData>,
}

#[derive(Debug, Deserialize)]
struct PublicKeyData {
    #[serde(rename = "publicKeyPEM")]
    public_key_pem: String,
}

impl LicenseService {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            state_path: config_dir.join("license.json"),
            key_path: config_dir.join("license.pubkey.pem"),
        }
    }

    /// 当前授权状态（纯本地，不联网）。
    pub fn status(&self) -> LicenseStatusView {
        let mut stored = self.load_state();
        // 没有可用公钥时，已存在的凭证只能按「需联网激活」处理；
        // 完全没有凭证则仍是免费版。
        let outcome = match self.verifier() {
            Some(verifier) => verifier.check(&stored, zely::now_secs()),
            None if stored.key.is_none() && stored.offline_token.is_none() => {
                zely::CheckOutcome::Entitlement(Entitlement::Free)
            }
            None => zely::CheckOutcome::Entitlement(Entitlement::NeedsActivation),
        };

        if let zely::CheckOutcome::Entitlement(ent) = &outcome {
            if ent.is_paid() {
                // 与上游 SDK 的约定一致：检查通过后才推进心跳时间
                stored.last_seen_at = zely::now_secs();
                if let Err(e) = self.save_state(&stored) {
                    log::warn!("保存授权心跳失败：{e}");
                }
            }
        }
        view_of(outcome, &stored)
    }

    /// 激活 / 更换激活码。成功后把授权码与离线凭证落盘。
    pub async fn activate(&self, key: &str) -> AppResult<LicenseStatusView> {
        let key = key.trim();
        if key.is_empty() {
            return Err(AppError::License("请输入激活码".into()));
        }
        let pem = self.public_key().await?;
        let verifier = zely::LicenseVerifier::from_pem(&pem, PRODUCT_ID).map_err(license_error)?;

        let mut stored = self.load_state();
        let device_id = zely::store::ensure_device_id(&mut stored);
        let fingerprint = zely::store::fingerprint();
        let result = zely::activate(
            BASE_URL,
            key,
            &device_id,
            &fingerprint,
            DEVICE_NAME,
            env!("CARGO_PKG_VERSION"),
        )
        .await
        .map_err(license_error)?;

        // 先验签再落盘：服务端返回的凭证必须能被同一把公钥验证通过，
        // 且产品标识要与本应用一致（防止跨产品凭证误入）。
        verifier
            .verify(&result.offline_token)
            .map_err(license_error)?;

        stored.key = Some(key.to_uppercase());
        stored.offline_token = Some(result.offline_token);
        stored.last_seen_at = zely::now_secs();
        self.save_state(&stored)?;
        log::info!("授权激活成功：{}", mask_key(key));
        Ok(self.status())
    }

    /// 临近到期时静默续签。启动后台任务调用，失败只记日志。
    pub async fn renew_if_due(&self) -> AppResult<bool> {
        let stored = self.load_state();
        let Some(token) = stored.offline_token.clone() else {
            return Ok(false);
        };
        let Some(key) = stored.key.clone() else {
            return Ok(false);
        };
        let pem = match self.public_key().await {
            Ok(pem) => pem,
            Err(e) => {
                log::warn!("自动续签跳过：{e}");
                return Ok(false);
            }
        };
        let verifier = match zely::LicenseVerifier::from_pem(&pem, PRODUCT_ID) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("自动续签跳过：授权公钥无效（{e}）");
                return Ok(false);
            }
        };
        let due = match verifier.verify_signature(&token) {
            Ok(payload) => zely::should_renew(&payload, zely::now_secs()),
            Err(_) => true,
        };
        if !due {
            return Ok(false);
        }
        self.activate(&key).await?;
        log::info!("授权已自动续签");
        Ok(true)
    }

    fn store(&self) -> zely::store::Store {
        zely::store::Store::new(&self.state_path, INTEGRITY_KEY)
    }

    /// 读取授权状态；遇到旧版明文 `license.json` 时迁移为带完整性校验的新格式。
    fn load_state(&self) -> zely::store::LicenseState {
        let store = self.store();
        let state = store.load();
        if state != zely::store::LicenseState::default() {
            return state;
        }

        // 新格式校验失败时，尝试一次旧版明文字段的迁移，避免用户升级后掉授权
        let Ok(raw) = std::fs::read_to_string(&self.state_path) else {
            return state;
        };
        let Ok(legacy) = serde_json::from_str::<zely::store::LicenseState>(&raw) else {
            return state;
        };
        if legacy.key.is_none() && legacy.offline_token.is_none() {
            return state;
        }
        match store.save(&legacy) {
            Ok(()) => log::info!("授权状态已迁移为带完整性校验的格式"),
            Err(e) => log::warn!("迁移旧版授权状态失败：{e}"),
        }
        legacy
    }

    fn save_state(&self, state: &zely::store::LicenseState) -> AppResult<()> {
        self.store()
            .save(state)
            .map_err(|e| AppError::License(format!("保存授权状态失败：{e}")))
    }

    /// 用本地可用公钥构造校验器；公钥缺失或无效时返回 None。
    fn verifier(&self) -> Option<zely::LicenseVerifier> {
        let pem = self.local_public_key()?;
        match zely::LicenseVerifier::from_pem(&pem, PRODUCT_ID) {
            Ok(v) => Some(v),
            Err(e) => {
                log::warn!("授权公钥无效：{e}");
                None
            }
        }
    }

    /// 构建期注入 → 本地缓存 → 联网拉取（并缓存）。
    async fn public_key(&self) -> AppResult<String> {
        if let Some(key) = embedded_public_key() {
            return Ok(key);
        }
        if let Some(key) = self.cached_public_key() {
            return Ok(key);
        }
        let key = self.fetch_public_key().await?;
        if let Err(e) = self.store_public_key(&key) {
            log::warn!("缓存授权公钥失败：{e}");
        }
        Ok(key)
    }

    /// 不联网时能拿到的公钥。
    fn local_public_key(&self) -> Option<String> {
        embedded_public_key().or_else(|| self.cached_public_key())
    }

    fn cached_public_key(&self) -> Option<String> {
        let raw = std::fs::read_to_string(&self.key_path).ok()?;
        let trimmed = raw.trim();
        is_pem(trimmed).then(|| trimmed.to_string())
    }

    fn store_public_key(&self, pem: &str) -> std::io::Result<()> {
        if let Some(parent) = self.key_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&self.key_path, pem)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.key_path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    async fn fetch_public_key(&self) -> AppResult<String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| AppError::License(format!("创建网络请求失败：{e}")))?;
        let res = client
            .get(format!(
                "{}/api/v1/licensing/public-key",
                BASE_URL.trim_end_matches('/')
            ))
            .send()
            .await
            .map_err(|e| AppError::License(format!("获取授权公钥失败：{e}")))?;
        let envelope: PublicKeyEnvelope = res
            .json()
            .await
            .map_err(|e| AppError::License(format!("解析授权公钥失败：{e}")))?;
        if envelope.code != "OK" {
            return Err(AppError::License(format!(
                "获取授权公钥失败：{} - {}",
                envelope.code, envelope.message
            )));
        }
        let pem = envelope
            .data
            .map(|d| d.public_key_pem)
            .unwrap_or_default();
        let pem = pem.trim().to_string();
        if !is_pem(&pem) {
            return Err(AppError::License("授权公钥格式无效".into()));
        }
        Ok(pem)
    }
}

impl Default for LicenseService {
    fn default() -> Self {
        Self::new(Path::new("."))
    }
}

fn embedded_public_key() -> Option<String> {
    EMBEDDED_PUBLIC_KEY
        .map(str::trim)
        .filter(|key| is_pem(key))
        .map(|key| key.to_string())
}

fn is_pem(key: &str) -> bool {
    key.contains("BEGIN PUBLIC KEY") && key.contains("END PUBLIC KEY")
}

/// 把 SDK 错误转成可读的应用错误。
fn license_error(err: zely::LicenseError) -> AppError {
    let text = match &err {
        zely::LicenseError::Api { code, message } => match code.as_str() {
            "INVALID_KEY" => "激活码无效，请检查后重试".to_string(),
            "LICENSE_REVOKED" => "该激活码已被吊销".to_string(),
            "LICENSE_EXPIRED" => "该激活码已过期".to_string(),
            "SEAT_LIMIT" => "该激活码绑定的设备数已达上限，请先在其它设备上解绑".to_string(),
            "RATE_LIMITED" => "请求过于频繁，请稍后再试".to_string(),
            "BAD_REQUEST" => format!("激活请求无效：{message}"),
            _ => format!("授权校验失败（{code}）：{message}"),
        },
        other => other.to_string(),
    };
    AppError::License(text)
}

/// 把检查结果转成前端视图。
fn view_of(outcome: zely::CheckOutcome, stored: &zely::store::LicenseState) -> LicenseStatusView {
    let key_hint = stored.key.as_deref().map(mask_key);
    let device_id = stored.device_id.clone();

    match outcome {
        zely::CheckOutcome::ClockRollback => LicenseStatusView {
            state: "clock_rollback".into(),
            unlocked: false,
            plan: None,
            expires_at: None,
            grace_ends_at: None,
            days_left: None,
            key_hint,
            device_id,
            message: "检测到系统时间异常，请校准时间后联网重新激活".into(),
        },
        zely::CheckOutcome::Entitlement(entitlement) => {
            let (state, plan, expires_at, grace_ends_at, days_left, message) = match &entitlement {
                Entitlement::Active {
                    plan,
                    expires_at,
                    days_left,
                    ..
                } => (
                    "active",
                    Some(plan.clone()),
                    Some(*expires_at),
                    None,
                    Some(*days_left),
                    format!("授权有效，剩余 {days_left} 天"),
                ),
                Entitlement::ExpiringSoon {
                    plan,
                    expires_at,
                    days_left,
                    ..
                } => (
                    "expiring",
                    Some(plan.clone()),
                    Some(*expires_at),
                    None,
                    Some(*days_left),
                    format!("授权即将到期，剩余 {days_left} 天；临近到期会自动联网续签"),
                ),
                Entitlement::Grace {
                    plan,
                    expires_at,
                    grace_ends_at,
                    days_left,
                    ..
                } => (
                    "grace",
                    Some(plan.clone()),
                    Some(*expires_at),
                    Some(*grace_ends_at),
                    Some(*days_left),
                    format!("订阅已到期，宽限期剩余 {days_left} 天，请尽快续费"),
                ),
                Entitlement::Locked { plan, expires_at } => (
                    "locked",
                    Some(plan.clone()),
                    Some(*expires_at),
                    None,
                    None,
                    "订阅已过期，Git 同步已锁定；续费后请重新激活".into(),
                ),
                Entitlement::NeedsActivation => (
                    "needs_activation",
                    None,
                    None,
                    None,
                    None,
                    "离线授权已过期或无效，请联网后重新激活".into(),
                ),
                Entitlement::Free => (
                    "free",
                    None,
                    None,
                    None,
                    None,
                    "尚未激活。输入激活码后即可使用 Git 同步。".into(),
                ),
            };
            LicenseStatusView {
                state: state.into(),
                unlocked: entitlement.is_paid(),
                plan,
                expires_at: expires_at.and_then(format_ts),
                grace_ends_at: grace_ends_at.and_then(format_ts),
                days_left,
                key_hint,
                device_id,
                message,
            }
        }
    }
}

fn format_ts(secs: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(secs, 0).map(|at| at.to_rfc3339())
}

/// 激活码脱敏：保留前 4 位与后 4 位。
fn mask_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 8 {
        return "****".into();
    }
    let head: String = chars.iter().take(4).collect();
    let tail: String = chars.iter().skip(chars.len() - 4).collect();
    format!("{head}****{tail}")
}
