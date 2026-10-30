//! SSH 核心模块（不可关闭）。
//!
//! 职责划分：
//! - [`types`]：连接参数、认证方式、会话状态等对外类型
//! - [`auth`]：密码 / 私钥 / agent / 自动 认证
//! - [`session`]：传输层、会话表、会话线程与自动重连
//! - [`channel`]：shell 通道的数据泵与事件推送
//! - [`latency`]：会话延迟探测（旁路 exec 通道测往返）
//! - [`jump`]：跳板机（ProxyJump）本地隧道
//! - [`known_hosts`]：主机密钥校验（TOFU / known_hosts）
//! - [`local`]：本地终端会话运行器（本机 PTY）
//! - [`interactive`]：键盘交互认证（keyboard-interactive）的提示应答中枢
//! - [`key_setup`]：一键生成并部署 SSH 密钥（本地生成 / 远端 authorized_keys / ~/.ssh/config）
//! - [`commands`]：暴露给前端的 Tauri command
//!
//! 本模块**不依赖** Git、AI、SFTP 等任何可选模块。

pub mod auth;
pub mod channel;
pub mod commands;
pub mod interactive;
pub mod jump;
pub mod key_setup;
pub mod known_hosts;
pub mod latency;
pub mod local;
pub mod session;
pub mod types;