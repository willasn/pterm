use serde::{Serialize, Serializer};

use crate::ssh::known_hosts::HostKeyInfo;

/// 全应用统一错误类型。
///
/// 可直接作为 Tauri command 的 `Err` 返回：`Serialize` 实现把错误降级为
/// 人类可读字符串，前端 `invoke` 的 reject 分支即可拿到提示文案。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("SSH 错误：{0}")]
    Ssh(String),

    /// 认证被拒绝。与 `Ssh` 区分开，因为认证失败属于不可重试错误，
    /// 而链路错误（超时、连接重置）需要触发自动重连。
    #[error("认证失败：{0}")]
    Auth(String),

    /// 用户主动取消认证（如取消键盘交互弹窗）。与 `Auth` 区分开：
    /// 前端据此不弹「补录密码」框，也不把取消当成凭据错误。
    #[error("{0}")]
    AuthCancelled(String),

    /// 主机密钥校验未通过。携带指纹等上下文，由会话线程转成状态事件让前端弹窗确认；
    /// 属于不可重试错误（自动重连只会反复失败）。
    #[error("主机密钥校验未通过")]
    HostKey(HostKeyInfo),

    #[error("I/O 错误：{0}")]
    Io(#[from] std::io::Error),

    #[error("配置错误：{0}")]
    Config(String),

    #[error("数据库错误：{0}")]
    Db(String),

    #[error("保险库错误：{0}")]
    Vault(String),

    #[error("Git 错误：{0}")]
    Git(String),

    #[error("AI 错误：{0}")]
    Ai(String),

    #[error("SFTP 错误：{0}")]
    Sftp(String),

    #[error("端口转发错误：{0}")]
    Forward(String),

    #[error("会话不存在：{0}")]
    SessionNotFound(String),

    #[error("模块「{0}」当前已关闭，请在设置中启用")]
    ModuleDisabled(String),

    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Db(e.to_string())
    }
}

impl From<ssh2::Error> for AppError {
    fn from(e: ssh2::Error) -> Self {
        AppError::Ssh(e.to_string())
    }
}

impl From<git2::Error> for AppError {
    fn from(e: git2::Error) -> Self {
        AppError::Git(e.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Ai(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

impl From<serde_yaml::Error> for AppError {
    fn from(e: serde_yaml::Error) -> Self {
        AppError::Config(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;