//! AI 协议定义（FEATURES.md §5「多模型」）。
//!
//! 每个模型在设置里单独选择协议，协议决定三件事：
//! - 请求地址：`base_url` 之后拼接的路径后缀；
//! - 鉴权：Bearer 还是 `x-api-key` 等专用头；
//! - 请求体与响应 / 流式格式（具体组装见 `client.rs`）。
//!
//! 这里是协议取值的唯一事实来源：`suffix()` 既用于拼请求地址，也用于设置界面的
//! 「会加什么后缀」提示，两边不会各说各话。

use serde::Serialize;

use crate::config::app_config::{
    PROTOCOL_ANTHROPIC, PROTOCOL_OPENAI, PROTOCOL_OPENAI_RESPONSES,
};

/// Anthropic Messages 要求的版本头，缺失会被服务端拒绝。
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

/// 协议枚举。配置里存的是字符串值，这里做归一化解析。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    /// OpenAI 兼容 Chat Completions
    OpenAi,
    /// OpenAI Responses
    OpenAiResponses,
    /// Anthropic Messages
    Anthropic,
}

impl Protocol {
    /// 解析配置里的协议值。未知值一律退回 OpenAI 兼容，保证旧配置与手改配置可用。
    pub fn from_value(value: &str) -> Protocol {
        match value.trim() {
            PROTOCOL_OPENAI_RESPONSES => Protocol::OpenAiResponses,
            PROTOCOL_ANTHROPIC => Protocol::Anthropic,
            _ => Protocol::OpenAi,
        }
    }

    /// 拼接在 `base_url` 之后的接口路径后缀（含前导 `/`）。
    pub fn suffix(self) -> &'static str {
        match self {
            Protocol::OpenAi => "/chat/completions",
            Protocol::OpenAiResponses => "/responses",
            Protocol::Anthropic => "/messages",
        }
    }
}

/// 协议清单项，交给设置界面渲染下拉与后缀提示。
#[derive(Debug, Clone, Serialize)]
pub struct ProtocolInfo {
    /// 写进配置的值
    pub value: &'static str,
    /// 下拉展示名
    pub label: &'static str,
    /// 拼接在 base_url 之后的路径后缀
    pub suffix: &'static str,
    /// 一句话说明（鉴权 / 适用场景）
    pub note: &'static str,
}

/// 可选协议目录：值、展示名、说明。后缀由 [`Protocol::suffix`] 统一给出，避免重复。
const CATALOG: &[(&str, &str, &str)] = &[
    (
        PROTOCOL_OPENAI,
        "OpenAI 兼容（Chat Completions）",
        "Bearer 鉴权，兼容 OpenAI / DeepSeek / 各类网关",
    ),
    (
        PROTOCOL_OPENAI_RESPONSES,
        "OpenAI Responses",
        "Bearer 鉴权，OpenAI 新版 Responses 接口",
    ),
    (
        PROTOCOL_ANTHROPIC,
        "Anthropic Messages",
        "x-api-key + anthropic-version 头，Claude 官方接口",
    ),
];

/// 返回可选协议清单。
pub fn catalog() -> Vec<ProtocolInfo> {
    CATALOG
        .iter()
        .map(|(value, label, note)| ProtocolInfo {
            value,
            label,
            note,
            suffix: Protocol::from_value(value).suffix(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_protocol_falls_back_to_openai() {
        assert_eq!(Protocol::from_value(""), Protocol::OpenAi);
        assert_eq!(Protocol::from_value("whatever"), Protocol::OpenAi);
        assert_eq!(Protocol::from_value(PROTOCOL_ANTHROPIC), Protocol::Anthropic);
        assert_eq!(
            Protocol::from_value(PROTOCOL_OPENAI_RESPONSES),
            Protocol::OpenAiResponses
        );
    }

    #[test]
    fn catalog_suffix_matches_protocol() {
        let items = catalog();
        assert_eq!(items.len(), 3);
        for item in items {
            assert_eq!(item.suffix, Protocol::from_value(item.value).suffix());
        }
    }
}
