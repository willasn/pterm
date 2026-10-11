//! Windows 远程桌面（RDP）连接（FEATURES.md §3）。
//!
//! 本模块不实现 RDP 协议本身，而是把连接交给现成的客户端：
//!
//! - Windows：调用系统自带的 `mstsc.exe`。若保险库中存有密码，先用 `cmdkey`
//!   把凭据写进 Windows 凭据管理器，实现免密登录。
//! - macOS：系统没有自带客户端，改用微软官方「Windows App」（原 Microsoft
//!   Remote Desktop）。pterm 只负责**保存会话**——生成 `.rdp` 文件后交给它打开，
//!   认证与凭据由该客户端自行管理；未安装时前端引导用户去 Mac App Store 安装。
//!
//! 协议协商、画面解码、输入回注由客户端完成，这里只做探测与拉起。

pub mod commands;

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::error::AppResult;
use crate::modules::ModuleContext;

/// 本平台 RDP 客户端能力的探测结果。
#[derive(Debug, Clone, serde::Serialize)]
pub struct RdpClientStatus {
    /// 是否可用
    pub available: bool,
    /// 客户端种类：mstsc | windows_app | none
    pub kind: String,
    /// 面向用户的说明
    pub hint: String,
}

/// 探测本机可用的 RDP 客户端。无副作用，故不受模块开关门控。
pub fn client_status() -> RdpClientStatus {
    detect_client()
}

#[cfg(target_os = "windows")]
fn detect_client() -> RdpClientStatus {
    use std::path::Path;

    // mstsc 随系统提供，正常情况下必然存在；仍检查一次以便给出明确提示。
    let path = std::env::var("SystemRoot")
        .map(|root| format!("{root}\\System32\\mstsc.exe"))
        .unwrap_or_else(|_| "mstsc.exe".to_string());
    let available = Path::new(&path).exists();
    RdpClientStatus {
        available,
        kind: "mstsc".to_string(),
        hint: if available {
            "将调用系统远程桌面客户端 mstsc.exe".to_string()
        } else {
            format!("未找到系统远程桌面客户端：{path}")
        },
    }
}

/// macOS 调用微软官方「Windows App」；未安装时给出安装引导。
#[cfg(target_os = "macos")]
fn detect_client() -> RdpClientStatus {
    match client_app_path() {
        Some(path) => RdpClientStatus {
            available: true,
            kind: "windows_app".to_string(),
            hint: format!("将调用微软远程桌面客户端：{}", path.display()),
        },
        None => RdpClientStatus {
            available: false,
            kind: "windows_app".to_string(),
            hint: "未检测到微软「Windows App」（原 Microsoft Remote Desktop），请先在 Mac App Store 安装"
                .to_string(),
        },
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn detect_client() -> RdpClientStatus {
    RdpClientStatus {
        available: false,
        kind: "none".to_string(),
        hint: "当前平台不支持远程桌面".to_string(),
    }
}

/// 在常见安装位置查找微软 RDP 客户端应用，供探测与拉起共用。
///
/// 「Windows App」由原来的 Microsoft Remote Desktop 更名而来，两者目录名不同，
/// 这里逐个探测；只检查系统与用户级的 Applications 目录，不扫全盘。
#[cfg(target_os = "macos")]
pub fn client_app_path() -> Option<std::path::PathBuf> {
    const NAMES: [&str; 2] = ["Windows App.app", "Microsoft Remote Desktop.app"];

    let mut roots = vec![std::path::PathBuf::from("/Applications")];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    for root in roots {
        for name in NAMES {
            let candidate = root.join(name);
            if candidate.is_dir() {
                return Some(candidate);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 模块
// ---------------------------------------------------------------------------

/// RDP 模块。连接按需建立（交给外部客户端），初始化阶段只有一条日志。
pub struct RdpModule;

impl RdpModule {
    pub fn new() -> Self {
        Self
    }
}

impl PluggableModule for RdpModule {
    fn id(&self) -> &'static str {
        module_id::RDP
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.connection.rdp
    }

    fn init(&self, _ctx: &ModuleContext) -> AppResult<()> {
        log::info!("远程桌面（RDP）已启用");
        Ok(())
    }

    fn dispose(&self) -> AppResult<()> {
        Ok(())
    }
}
