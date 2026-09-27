//! Agent 模式（FEATURES.md §5「Agent 模式」）。
//!
//! 与 Ask 模式的区别：Agent 会读取终端输出来决定下一步，并请求在会话中执行命令。
//! 这里只负责「提示词组装」与「动作解析」两件纯函数工作：
//!
//! - 模型被要求只输出一个 JSON 动作对象（`run` 或 `done`），不做自由文本解析，
//!   这样模型说再多废话也不会被误当成命令；
//! - 是否真正执行由前端逐条向用户确认后决定，本模块不碰终端。

use crate::error::{AppError, AppResult};

/// 模型返回的动作类型。
pub const ACTION_RUN: &str = "run";
pub const ACTION_DONE: &str = "done";

/// 一次已经执行过的步骤，回填给模型作为下一步的依据。
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct AgentStep {
    pub command: String,
    pub output: String,
}

/// 解析后的动作。
#[derive(Debug, Clone)]
pub struct AgentAction {
    pub action: String,
    pub command: Option<String>,
    pub summary: Option<String>,
}

/// Agent 模式的 system 提示词。约束输出为单个 JSON 对象。
pub fn system_prompt() -> String {
    [
        "你是集成在 SSH 终端里的自动化助手，可以读取终端输出来决定下一步。",
        "你只能输出一个 JSON 对象，不要输出任何解释、Markdown 代码块或多余文字。",
        "两种合法形式：",
        r#"{"action":"run","command":"<一条可直接在 shell 中执行的命令>"}"#,
        r#"{"action":"done","summary":"<任务完成情况与结论>"}"#,
        "规则：",
        "- 一次只给一条命令。需要多条时逐步来，你会拿到上一条的执行结果再决定下一步。",
        "- 命令必须是非交互的：不要用需要人工输入、编辑器或分页器的命令。",
        "- 目标已经达成、或无法继续时，立刻返回 done 并在 summary 里说明。",
        "- 不要重复执行已经成功执行过的命令。",
    ]
    .join("\n")
}

/// 组装本轮 user 消息：目标 + 已执行步骤 + 当前终端输出。
pub fn user_prompt(goal: &str, steps: &[AgentStep], terminal_tail: &str) -> String {
    let mut parts = vec![format!("目标：{}", goal.trim())];

    if steps.is_empty() {
        parts.push("已执行的步骤：暂无".into());
    } else {
        let mut lines = vec!["已执行的步骤：".to_string()];
        for (index, step) in steps.iter().enumerate() {
            lines.push(format!("{}. $ {}", index + 1, step.command));
            lines.push(format!("   输出：{}", tail(&step.output, 2000)));
        }
        parts.push(lines.join("\n"));
    }

    let tail_text = terminal_tail.trim();
    parts.push(if tail_text.is_empty() {
        "当前终端最近输出：暂无".into()
    } else {
        format!("当前终端最近输出：\n{}", tail(&terminal_tail, 4000))
    });

    parts.push("请给出下一步。".into());
    parts.join("\n\n")
}

/// 只保留文本末尾若干字符：终端输出通常「结论在最后」，截头比截尾更有用。
fn tail(text: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max_chars {
        return text.trim().to_string();
    }
    let skipped = chars.len() - max_chars;
    format!("…（省略前 {skipped} 字符）\n{}", chars[skipped..].iter().collect::<String>())
}

/// 从模型回复里解析动作。
///
/// 容忍两种常见偏差：整体被 ```json 包裹、JSON 前后夹带解释文字。
/// 解析不出合法动作时返回错误，并把原文带上——盲目猜一个命令去执行风险太高。
pub fn parse_action(raw: &str) -> AppResult<AgentAction> {
    let text = strip_code_fence(raw);
    let json = extract_json_object(text).ok_or_else(|| {
        AppError::Ai(format!(
            "Agent 未返回合法动作，请重试或改用 Ask 模式。模型原文：{}",
            tail(raw, 500)
        ))
    })?;

    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| {
        AppError::Ai(format!("Agent 返回的动作不是合法 JSON（{e}）。原文：{}", tail(raw, 500)))
    })?;

    let action = value
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();

    match action.as_str() {
        ACTION_RUN => {
            let command = value
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if command.is_empty() {
                return Err(AppError::Ai("Agent 要求执行命令但 command 为空".into()));
            }
            Ok(AgentAction {
                action: ACTION_RUN.into(),
                command: Some(command),
                summary: None,
            })
        }
        ACTION_DONE => Ok(AgentAction {
            action: ACTION_DONE.into(),
            command: None,
            summary: Some(
                value
                    .get("summary")
                    .and_then(|v| v.as_str())
                    .unwrap_or("任务结束")
                    .trim()
                    .to_string(),
            ),
        }),
        other => Err(AppError::Ai(format!(
            "Agent 返回了未知动作「{other}」，只支持 run / done"
        ))),
    }
}

/// 去掉整体包裹的 Markdown 代码块。
fn strip_code_fence(raw: &str) -> &str {
    let text = raw.trim();
    let Some(rest) = text.strip_prefix("```") else {
        return text;
    };
    // 跳过 ``` 后的语言标注（如 json）直到换行
    let rest = match rest.find('\n') {
        Some(pos) => &rest[pos + 1..],
        None => rest,
    };
    rest.trim_end().strip_suffix("```").unwrap_or(rest).trim()
}

/// 取第一个 `{` 到最后一个 `}` 之间的内容，容忍前后夹带的解释文字。
fn extract_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(&text[start..=end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_run_action() {
        let action = parse_action(r#"{"action":"run","command":"df -h"}"#).expect("应能解析");
        assert_eq!(action.action, ACTION_RUN);
        assert_eq!(action.command.as_deref(), Some("df -h"));
    }

    #[test]
    fn parses_fenced_action_with_extra_prose() {
        let raw = "好的，我先看看磁盘：\n```json\n{\"action\": \"run\", \"command\": \"df -h\"}\n```\n";
        let action = parse_action(raw).expect("代码块与多余文字都应被容忍");
        assert_eq!(action.command.as_deref(), Some("df -h"));
    }

    #[test]
    fn parses_done_action() {
        let action = parse_action(r#"{"action":"done","summary":"磁盘还剩 20%"}"#).expect("应能解析");
        assert_eq!(action.action, ACTION_DONE);
        assert_eq!(action.summary.as_deref(), Some("磁盘还剩 20%"));
    }

    #[test]
    fn rejects_run_without_command() {
        assert!(parse_action(r#"{"action":"run"}"#).is_err());
    }

    #[test]
    fn rejects_unknown_action_and_garbage() {
        assert!(parse_action(r#"{"action":"delete"}"#).is_err());
        assert!(parse_action("我先解释一下这个问题").is_err());
    }

    /// 尾部截断要保留结尾，因为终端输出的结论通常在最后。
    #[test]
    fn tail_keeps_the_end() {
        let text = "a".repeat(50) + "重要结论";
        let out = tail(&text, 10);
        assert!(out.ends_with("重要结论"));
    }

    #[test]
    fn user_prompt_marks_empty_steps() {
        let prompt = user_prompt("查看磁盘", &[], "");
        assert!(prompt.contains("已执行的步骤：暂无"));
        assert!(prompt.contains("当前终端最近输出：暂无"));
    }
}
