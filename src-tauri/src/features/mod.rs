//! 可选功能模块的具体实现（FEATURES.md §3 连接与传输）。
//!
//! 与 [`crate::modules`] 的分工：`modules` 提供模块注册表与生命周期基础设施，
//! 这里是各可选功能的落地实现。所有模块统一通过 [`crate::modules::ModuleRegistry`]
//! 注册，开关关闭时完全不初始化、不占资源。
//!
//! 依赖方向：features → ssh 核心。SSH 核心不依赖任何 features 子模块。

pub mod import_export;
pub mod ime;
pub mod port_forward;
pub mod rdp;
pub mod session_log;
pub mod sftp;