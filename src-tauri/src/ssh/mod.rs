//! SSH 核心模块（不可关闭）。
//!
//! 职责划分：
//! - [`types`]：连接参数、认证方式、会话状态等对外类型
//! - [`auth`]：密码 / 私钥 / agent / 自动 认证
//! - [`session`]：传输层、会话表、会话线程与自动重连
//! - [`channel`]：shell 通道的数据泵与事件推送
//! - [`jump`]：跳板机（ProxyJump）本地隧道
//! - [`commands`]：暴露给前端的 Tauri command
//!
//! 本模块**不依赖** Git、AI、SFTP 等任何可选模块。

pub mod auth;
pub mod channel;
pub mod commands;
pub mod jump;
pub mod session;
pub mod types;