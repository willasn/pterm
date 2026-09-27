//! 上下文注入（FEATURES.md §5「上下文注入」）。
//!
//! 由 `ai_context_inject` 开关控制：打开时把当前主机、工作目录与最近终端输出
//! 拼成一条 system 消息，帮助模型给出贴合当前环境的结果。

/// 组装 system 消息。开关关闭或无任何有效上下文时返回 `None`——此时请求里
/// 只含 user 消息，不会附加大段环境文本。
pub fn build_system_message(
    enabled: bool,
    host: Option<&str>,
    cwd: Option<&str>,
    recent: Option<&str>,
) -> Option<String> {
    if !enabled {
        return None;
    }

    let mut parts: Vec<String> = vec![
        "你是集成在 SSH 终端里的 AI 助手，帮助用户生成命令、解释报错与分析文本。".into(),
    ];
    if let Some(h) = host.map(str::trim).filter(|h| !h.is_empty()) {
        parts.push(format!("当前主机：{h}"));
    }
    if let Some(c) = cwd.map(str::trim).filter(|c| !c.is_empty()) {
        parts.push(format!("当前目录：{c}"));
    }
    if let Some(r) = recent.map(str::trim).filter(|r| !r.is_empty()) {
        parts.push(format!("最近终端输出片段：\n{r}"));
    }

    if parts.len() == 1 {
        None
    } else {
        Some(parts.join("\n"))
    }
}