//! 远程桌面（RDP）对外命令。
//!
//! 全部命令都先经 [`AppState::require_module`] 门控：模块关闭时直接返回
//! `ModuleDisabled`。真正拉起客户端与网络探测会阻塞，统一放进
//! `spawn_blocking`。

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::config::feature_flags::module_id;
use crate::config::store::secrets;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::RdpClientStatus;

/// RDP 默认端口。
const DEFAULT_RDP_PORT: u16 = 3389;

/// 「Windows App」的 Mac App Store 安装页。用 `macappstore://` 直接唤起 App Store，
/// 避免先经浏览器中转。
#[cfg(target_os = "macos")]
const MACOS_APP_STORE_URL: &str = "macappstore://apps.apple.com/app/id1295203466";

fn default_port() -> u16 {
    DEFAULT_RDP_PORT
}

/// 打开远程桌面的入参。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RdpOpenInput {
    /// 已保存连接的 id。有值时若未显式给密码，则从加密保险库读取；
    /// 也是 `.rdp` 文件的稳定文件名来源。
    #[serde(default)]
    pub connection_id: Option<String>,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    /// Windows 域账号的域（可空）
    #[serde(default)]
    pub domain: Option<String>,
    /// 临时密码（未保存或测试用）。空串视为未提供。仅 Windows 使用（写入凭据管理器）。
    #[serde(default)]
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub password: Option<String>,
}

/// 打开结果，供前端提示。
#[derive(Debug, Clone, Serialize)]
pub struct RdpLaunchResult {
    /// 实际使用的客户端：mstsc | windows_app
    pub client: String,
    /// 是否使用了保险库 / 入参提供的密码
    pub used_saved_password: bool,
}

/// 连通性探测结果。
#[derive(Debug, Clone, Serialize)]
pub struct RdpProbeResult {
    pub reachable: bool,
    pub message: String,
}

/// 探测本机是否有可用的 RDP 客户端。只读、无副作用，不设门控，
/// 让设置界面在模块关闭时也能显示状态。
#[tauri::command]
pub fn rdp_client_available() -> RdpClientStatus {
    super::client_status()
}

/// 读取某个连接保存在保险库中的 RDP 密码（macOS 上供「复制密码」按钮使用）。
/// 未保存时返回 `None`。
#[tauri::command]
pub fn rdp_saved_password(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Option<String>> {
    state.require_module(module_id::RDP)?;
    Ok(secrets::get(&secrets::rdp_password_key(&connection_id))?.filter(|v| !v.is_empty()))
}

/// 打开远程桌面。密码优先取入参，其次按 `connection_id` 读保险库。
#[tauri::command]
pub async fn rdp_open(
    state: State<'_, AppState>,
    input: RdpOpenInput,
) -> AppResult<RdpLaunchResult> {
    state.require_module(module_id::RDP)?;

    let rdp_dir = state.paths.data_dir.clone();

    tauri::async_runtime::spawn_blocking(move || launch(&input, &rdp_dir))
        .await
        .map_err(|e| AppError::Other(format!("打开远程桌面任务异常结束：{e}")))?
}

/// 打开「Windows App」的安装页（macOS 专用）。
///
/// 探测到未安装时由前端调用：应用内没有 opener 插件，唤起系统 App Store 只能走后端。
#[tauri::command]
pub fn rdp_open_installer(state: State<'_, AppState>) -> AppResult<()> {
    state.require_module(module_id::RDP)?;
    open_installer()
}

#[cfg(target_os = "macos")]
fn open_installer() -> AppResult<()> {
    let status = Command::new("open")
        .arg(MACOS_APP_STORE_URL)
        .status()
        .map_err(|e| AppError::Other(format!("打开 App Store 失败：{e}")))?;
    if !status.success() {
        return Err(AppError::Other("打开 App Store 失败".into()));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn open_installer() -> AppResult<()> {
    Err(AppError::Other(
        "当前平台无需安装远程桌面客户端".into(),
    ))
}

/// 探测目标主机 RDP 端口是否可达。
#[tauri::command]
pub async fn rdp_probe(
    state: State<'_, AppState>,
    host: String,
    port: Option<u16>,
    timeout_ms: Option<u64>,
) -> AppResult<RdpProbeResult> {
    state.require_module(module_id::RDP)?;
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err(AppError::Config("未填写主机地址".into()));
    }
    let port = port.unwrap_or(DEFAULT_RDP_PORT);
    // 夹到 0.2s ~ 30s，避免 0 直接失败或长时间卡住前端
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(3000).clamp(200, 30_000));

    tauri::async_runtime::spawn_blocking(move || probe(&host, port, timeout))
        .await
        .map_err(|e| AppError::Other(format!("探测任务异常结束：{e}")))?
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn launch(input: &RdpOpenInput, rdp_dir: &Path) -> AppResult<RdpLaunchResult> {
    let host = require_host(input)?;

    // 密码优先取入参，其次按 connection_id 读保险库（macOS 不需要密码，因此不读）
    let password = match input.password.clone().filter(|p| !p.is_empty()) {
        Some(p) => Some(p),
        None => match input.connection_id.as_deref() {
            Some(id) => secrets::get(&secrets::rdp_password_key(id))?.filter(|v| !v.is_empty()),
            None => None,
        },
    };

    // 有密码时先写进 Windows 凭据管理器，mstsc 启动后即免密登录
    let mut used_saved = false;
    if let Some(pw) = password.as_deref().filter(|p| !p.is_empty()) {
        store_windows_credential(input, &host, pw)?;
        used_saved = true;
    }

    let content = build_rdp_file(input, used_saved);
    let path = write_rdp_file(rdp_dir, input, &content)?;

    Command::new("mstsc")
        .arg(&path)
        .spawn()
        .map_err(|e| AppError::Other(format!("启动 mstsc 失败：{e}")))?;

    Ok(RdpLaunchResult {
        client: "mstsc".to_string(),
        used_saved_password: used_saved,
    })
}

/// 把凭据写入 Windows 凭据管理器，目标名固定为 `TERMSRV/<host>`。
///
/// 注意：密码会出现在 `cmdkey` 的命令行参数中（本机进程列表短时可见）。
/// 这是 `cmdkey` 的固有限制，也是 mstsc 免密登录最简单可靠的做法。
#[cfg(target_os = "windows")]
fn store_windows_credential(input: &RdpOpenInput, host: &str, password: &str) -> AppResult<()> {
    let user = input.username.trim();
    let domain = input.domain.as_deref().map(str::trim).unwrap_or("");
    let login = match (domain.is_empty(), user.is_empty()) {
        (false, false) => format!("{domain}\\{user}"),
        _ => user.to_string(),
    };

    let mut cmd = Command::new("cmdkey");
    cmd.arg(format!("/generic:TERMSRV/{host}"));
    if !login.is_empty() {
        cmd.arg(format!("/user:{login}"));
    }
    cmd.arg(format!("/pass:{password}"));

    let status = cmd
        .status()
        .map_err(|e| AppError::Other(format!("调用 cmdkey 失败：{e}")))?;
    if !status.success() {
        return Err(AppError::Other(
            "写入 Windows 凭据管理器失败（cmdkey 返回非零）".into(),
        ));
    }
    Ok(())
}

/// 把 `.rdp` 内容写到数据目录下，返回文件路径。
///
/// 用**稳定文件名**而非临时文件 + 延迟删除：客户端可能记住该路径（保存成条目），
/// 文件被删会让条目失效；同一连接复用同一个文件，重复点击也不会堆垃圾文件。
#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn write_rdp_file(
    rdp_dir: &Path,
    input: &RdpOpenInput,
    content: &str,
) -> AppResult<std::path::PathBuf> {
    let dir = rdp_dir.join("rdp");
    std::fs::create_dir_all(&dir)?;

    // 已保存的连接用 id（稳定）；免保存的临时连接退化为 host-port
    let stem = match input.connection_id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => sanitize_stem(id),
        None => sanitize_stem(&format!("{}-{}", input.host.trim(), input.port)),
    };

    let path = dir.join(format!("{stem}.rdp"));
    std::fs::write(&path, content)
        .map_err(|e| AppError::Other(format!("写入 .rdp 文件失败：{e}")))?;
    Ok(path)
}

/// 文件名白名单：只保留 ASCII 字母数字与 `-_.`，其余替换为 `_`，并限制长度。
#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn sanitize_stem(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() {
        return "connection".to_string();
    }
    trimmed.chars().take(80).collect()
}

/// 生成 `.rdp` 文件内容。Windows 的 `mstsc` 与 macOS 的「Windows App」共用这一
/// 格式（同一份生成器），只写两边都认、且影响连接目标的键。
///
/// 刻意不写 `authentication level` / `redirectclipboard` / `audiomode` 等：
/// 省略时客户端用各自默认值（Windows 默认为剪贴板开、音频本地、认证失败告警），
/// 与直接使用客户端一致；而 macOS 客户端对这些键的支持范围与 Windows 不同
/// （例如 `authentication level` 只支持 0/1），写死反而可能出问题。
///
/// `has_password`：凭据已写进 Windows 凭据管理器时才关掉密码框；macOS 恒为 false。
#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn build_rdp_file(input: &RdpOpenInput, has_password: bool) -> String {
    let host = input.host.trim();
    let mut lines = vec![format!("full address:s:{host}:{}", input.port)];

    let user = input.username.trim();
    if !user.is_empty() {
        lines.push(format!("username:s:{user}"));
    }
    if let Some(domain) = input.domain.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        lines.push(format!("domain:s:{domain}"));
    }
    lines.push(format!(
        "prompt for credentials:i:{}",
        if has_password { 0 } else { 1 }
    ));
    lines.join("\r\n")
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

/// 在 macOS 上把连接交给微软官方「Windows App」打开。
///
/// 系统没有自带 RDP 客户端，因此依赖用户自行安装微软的「Windows App」（原
/// Microsoft Remote Desktop）。pshell 只负责**保存会话**：把连接写成 `.rdp`
/// 文件后交给该客户端打开，认证与凭据由它自己管理，所以这里不需要密码。
#[cfg(target_os = "macos")]
fn launch(input: &RdpOpenInput, rdp_dir: &Path) -> AppResult<RdpLaunchResult> {
    require_host(input)?;

    // 用探测到的应用路径而非 bundle id 唤起：新旧名称（Windows App /
    // Microsoft Remote Desktop）目录名不同，路径是唯一可靠的依据。
    let app = super::client_app_path().ok_or_else(|| {
        AppError::Other("未检测到微软「Windows App」，请先在 Mac App Store 安装".into())
    })?;

    let content = build_rdp_file(input, false);
    let path = write_rdp_file(rdp_dir, input, &content)?;

    let status = Command::new("open")
        .arg("-a")
        .arg(&app)
        .arg(&path)
        .status()
        .map_err(|e| AppError::Other(format!("唤起 Windows App 失败：{e}")))?;
    if !status.success() {
        return Err(AppError::Other(
            "唤起 Windows App 失败，请确认已安装微软「Windows App」".into(),
        ));
    }

    Ok(RdpLaunchResult {
        client: "windows_app".to_string(),
        used_saved_password: false,
    })
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

fn require_host(input: &RdpOpenInput) -> AppResult<String> {
    let host = input.host.trim();
    if host.is_empty() {
        return Err(AppError::Config("未填写主机地址".into()));
    }
    Ok(host.to_string())
}

/// TCP 探测目标端口。逐个解析地址尝试，任一成功即视为可达。
fn probe(host: &str, port: u16, timeout: Duration) -> AppResult<RdpProbeResult> {
    use std::net::{TcpStream, ToSocketAddrs};

    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| AppError::Other(format!("无法解析主机 {host}：{e}")))?;

    let mut last = "无可用地址".to_string();
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(_) => {
                return Ok(RdpProbeResult {
                    reachable: true,
                    message: format!("{addr} 可达"),
                })
            }
            Err(e) => last = format!("{addr}：{e}"),
        }
    }
    Ok(RdpProbeResult {
        reachable: false,
        message: format!("无法连接：{last}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> RdpOpenInput {
        RdpOpenInput {
            connection_id: None,
            host: "10.0.0.5".into(),
            port: 3389,
            username: "admin".into(),
            domain: None,
            password: None,
        }
    }

    /// 有密码时关闭密码框，让凭据管理器里的凭据直接生效。
    #[test]
    fn rdp_file_disables_prompt_when_password_present() {
        let content = build_rdp_file(&input(), true);
        assert!(content.contains("full address:s:10.0.0.5:3389"));
        assert!(content.contains("username:s:admin"));
        assert!(content.contains("prompt for credentials:i:0"));
        assert!(!content.contains("domain:s:"));
    }

    /// 无密码时保留密码框，交由系统客户端提示输入。
    #[test]
    fn rdp_file_prompts_without_password() {
        let content = build_rdp_file(&input(), false);
        assert!(content.contains("prompt for credentials:i:1"));
    }

    /// 域非空时写入 domain 行。
    #[test]
    fn rdp_file_includes_domain() {
        let mut inp = input();
        inp.domain = Some("CORP".into());
        let content = build_rdp_file(&inp, false);
        assert!(content.contains("domain:s:CORP"));
    }

    /// 文件名必须剔除路径分隔符，避免主机名 / id 里带 `../` 写到目录外。
    #[test]
    fn sanitize_stem_strips_path_separators() {
        let s = sanitize_stem("../../etc/passwd");
        assert!(!s.contains('/') && !s.contains('\\'));
        assert!(s.contains("etc_passwd"));
    }

    #[test]
    fn sanitize_stem_falls_back_and_keeps_host_port() {
        assert_eq!(sanitize_stem(""), "connection");
        assert_eq!(sanitize_stem("___"), "connection");
        assert_eq!(sanitize_stem("10.0.0.1-3389"), "10.0.0.1-3389");
    }

    /// 同一连接复用同一个 .rdp 文件（内容覆盖），文件名取自连接 id。
    #[test]
    fn write_rdp_file_reuses_stable_name_per_connection() {
        let dir = std::env::temp_dir().join(format!("pshell-rdp-{}", uuid::Uuid::new_v4()));
        let mut inp = input();
        inp.connection_id = Some("conn-123".into());

        let path = write_rdp_file(&dir, &inp, "hello").unwrap();
        assert_eq!(path.file_name().unwrap(), "conn-123.rdp");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");

        let again = write_rdp_file(&dir, &inp, "world").unwrap();
        assert_eq!(path, again, "同一连接应复用同一路径");
        assert_eq!(std::fs::read_to_string(&again).unwrap(), "world");

        std::fs::remove_dir_all(&dir).ok();
    }
}
