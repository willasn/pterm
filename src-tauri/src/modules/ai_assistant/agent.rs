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
        "不要先草拟一个动作再改写：整条回复只能出现这一个 JSON 对象。",
        "两种合法形式：",
        r#"{"action":"run","command":"<一条可直接在 shell 中执行的命令>"}"#,
        r#"{"action":"done","summary":"<任务完成情况与结论>"}"#,
        "规则：",
        "- 一次只给一条命令。需要多条时逐步来，你会拿到上一条的执行结果再决定下一步。",
        "- 命令必须是非交互的：不要用需要人工输入、编辑器或分页器的命令。",
        "- 每条命令都在独立的后台非交互通道里执行，不会进入用户当前终端：不要依赖上一条命令的 \
cd、环境变量或 shell 状态；需要固定目录时写成 `cd /path && cmd`，或直接使用绝对路径。",
        "- 目标已经达成、或无法继续时，立刻返回 done 并在 summary 里说明。",
        "- 不要重复执行已经成功执行过的命令。",
    ]
    .join("\n")
}

/// 组装本轮 user 消息：目标 + 已执行步骤 + 当前终端输出。
///
/// `remaining_steps` 是本轮还能执行多少条命令：快用完时提前告知模型收尾，
/// 避免它开启新方向、然后在半路被硬性截断。
pub fn user_prompt(
    goal: &str,
    steps: &[AgentStep],
    terminal_tail: &str,
    remaining_steps: Option<u32>,
) -> String {
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
        "用户当前终端最近输出（仅供参考，不是本任务命令的输出）：暂无".into()
    } else {
        format!(
            "用户当前终端最近输出（仅供参考，不是本任务命令的输出）：\n{}",
            tail(&terminal_tail, 4000)
        )
    });

    parts.push("请给出下一步。".into());

    // 只剩一两步时提示模型收尾：宁可给出阶段性结论，也不要在半路被截断
    if let Some(remaining) = remaining_steps {
        if remaining <= 2 {
            parts.push(format!(
                "注意：本轮最多还能执行 {remaining} 条命令。请优先收尾：用 done 给出已完成的\
内容与阶段性结论；如果任务尚未完成，在 summary 里说明剩余步骤，不要开启新方向。"
            ));
        }
    }

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
/// 先按标准 JSON 解析（容忍 ```json 包裹、夹带解释文字、以及「边想边说」产生多个
/// JSON 对象——从后往前试，取最后一个合法动作）。
///
/// 标准解析失败时再走一次宽松提取：模型常把多行结论直接塞进字符串里（值里出现裸换行），
/// 或写出未转义的引号，这些都会让严格 JSON 解析（以及按引号配对切分的候选提取）失效。
/// 逐字段宽松提取能救回这类「差一点就合法」的回复。
///
/// 两条路都拿不到合法动作时返回错误，并把原文带上——盲目猜一个命令去执行风险太高。
pub fn parse_action(raw: &str) -> AppResult<AgentAction> {
    let text = strip_code_fence(raw);

    let mut json_error: Option<String> = None;
    // 从后往前试：模型「边想边说」时，正式动作通常排在最后。
    for candidate in json_candidates(text).into_iter().rev() {
        match serde_json::from_str::<serde_json::Value>(candidate) {
            Ok(value) => match action_from_value(&value)? {
                Some(action) => return Ok(action),
                // 是合法 JSON 但不是动作对象（多半是夹带的解释片段），继续试更早的候选。
                None => continue,
            },
            Err(e) => json_error = Some(e.to_string()),
        }
    }

    // 有些模型（如 DeepSeek 系）不按提示词回 JSON，而是吐出接口层的「工具调用」标记，
    // 形如 `<｜｜DSML｜｜invoke name="run"><｜｜DSML｜｜parameter name="command">…`。
    // 这类标记与提示词约定的动作语义一致，直接映射成 run / done。
    if let Some(action) = tool_markup_action(text) {
        return Ok(action);
    }

    if let Some(action) = tolerant_action(text) {
        return Ok(action);
    }

    Err(match json_error {
        Some(msg) => AppError::Ai(format!(
            "Agent 返回的动作不是合法 JSON（{msg}）。原文：{}",
            tail(raw, 500)
        )),
        None => AppError::Ai(format!(
            "Agent 未返回合法动作，请重试或改用 Ask 模式。模型原文：{}",
            tail(raw, 500)
        )),
    })
}

/// 从「工具调用」标记里提取动作（兼容 DSML / 普通 XML 两种写法）。
///
/// 典型形态：
/// ```text
/// <｜｜DSML｜｜tool_calls>
/// <｜｜DSML｜｜invoke name="run">
/// <｜｜DSML｜｜parameter name="command" string="true">df -h</｜｜DSML｜｜parameter>
/// </｜｜DSML｜｜invoke>
/// </｜｜DSML｜｜tool_calls>
/// ```
/// 前缀（全角竖线、空格位置）随模型 / 网关而异，因此不按整段标签匹配，
/// 只以 `invoke`、`parameter`、`name="…"` 这些固定片段为锚点。
fn tool_markup_action(text: &str) -> Option<AgentAction> {
    let lower = text.to_ascii_lowercase();
    // 一次回复可能给出多个 invoke（例如先 think 再 run），取第一个能识别的动作
    let mut from = 0;
    while let Some(rel) = lower[from..].find("invoke") {
        let pos = from + rel;
        from = pos + "invoke".len();
        let Some((name, _)) = quoted_value(&text[pos..], &lower[pos..], "name") else {
            continue;
        };
        match name.trim().to_ascii_lowercase().as_str() {
            ACTION_RUN => {
                let Some(raw) = tag_parameter(text, &lower, "command") else {
                    continue;
                };
                let command = raw.trim().to_string();
                if command.is_empty() {
                    continue;
                }
                return Some(AgentAction {
                    action: ACTION_RUN.into(),
                    command: Some(command),
                    summary: None,
                });
            }
            ACTION_DONE => {
                let summary = tag_parameter(text, &lower, "summary")
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "任务结束".to_string());
                return Some(AgentAction {
                    action: ACTION_DONE.into(),
                    command: None,
                    summary: Some(summary),
                });
            }
            _ => {}
        }
    }
    None
}

/// 逐个 `<…parameter …>` 找名为 `name` 的参数，取出它的标签体。
fn tag_parameter(text: &str, lower: &str, name: &str) -> Option<String> {
    let mut from = 0;
    while let Some(rel) = lower[from..].find("parameter") {
        let pos = from + rel;
        let rest = &text[pos..];
        let rest_lower = &lower[pos..];
        if let Some((value, after)) = quoted_value(rest, rest_lower, "name") {
            if value.trim().eq_ignore_ascii_case(name) {
                let open = after + rest[after..].find('>')? + 1;
                let body = &rest[open..];
                let end = closing_tag_start(body).unwrap_or(body.len());
                return Some(body[..end].to_string());
            }
        }
        from = pos + "parameter".len();
    }
    None
}

/// 在片段里找 `attr="…"`，返回值与右引号之后的下标。
fn quoted_value(haystack: &str, lower: &str, attr: &str) -> Option<(String, usize)> {
    let pattern = format!("{attr}=\"");
    let pos = lower.find(&pattern)?;
    let start = pos + pattern.len();
    let end = start + haystack[start..].find('"')?;
    Some((haystack[start..end].to_string(), end + 1))
}

/// 找到参数正文的结束位置：第一个闭合 `parameter` / `invoke` / `calls` 标签的起点。
///
/// 命令正文里也可能出现 `</dev/null`、`</root>` 之类的内容，因此逐个 `</`
/// 检查标签名，只是它们才当结束标记。
fn closing_tag_start(body: &str) -> Option<usize> {
    let lower = body.to_ascii_lowercase();
    let mut from = 0;
    while let Some(rel) = lower[from..].find("</") {
        let pos = from + rel;
        let gt = lower[pos..].find('>')?;
        let tag = &lower[pos + 2..pos + gt];
        if tag.contains("parameter") || tag.contains("invoke") || tag.contains("calls") {
            return Some(pos);
        }
        from = pos + 2;
    }
    None
}

/// 宽松提取动作：不要求字符串是合法 JSON，按提示词约定的形状逐字段取值。
///
/// `action` 取值不含引号，取到其后第一个引号即可；约定里 `run` 的 `command`、
/// `done` 的 `summary` 都是对象里最后一个字段，因此取「开引号 → 对象内最后一个引号」，
/// 即使值里混入了未转义的引号或裸换行也不会像严格解析那样整条失败。
fn tolerant_action(text: &str) -> Option<AgentAction> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    let body = &text[start + 1..end];

    match first_string_field(body, "action")?.trim().to_lowercase().as_str() {
        ACTION_RUN => {
            let command = last_string_field(body, "command")?.trim().to_string();
            if command.is_empty() {
                return None;
            }
            Some(AgentAction {
                action: ACTION_RUN.into(),
                command: Some(command),
                summary: None,
            })
        }
        ACTION_DONE => {
            let summary = last_string_field(body, "summary")
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "任务结束".to_string());
            Some(AgentAction {
                action: ACTION_DONE.into(),
                command: None,
                summary: Some(summary),
            })
        }
        _ => None,
    }
}

/// 取某个键的字符串值，值到其后第一个引号为止（适用于不含引号的值，如 `action`）。
fn first_string_field(body: &str, key: &str) -> Option<String> {
    let (open, rest) = field_value_start(body, key)?;
    let close = open + rest.find('"')?;
    Some(unescape_loose(&body[open..close]))
}

/// 取某个键的字符串值，值到对象内最后一个引号为止（适用于排在最后的 `command` / `summary`）。
fn last_string_field(body: &str, key: &str) -> Option<String> {
    let (open, _) = field_value_start(body, key)?;
    let close = body.rfind('"')?;
    if close < open {
        return None;
    }
    Some(unescape_loose(&body[open..close]))
}

/// 定位键值对里字符串值的起点：返回「开引号之后」的字节下标，以及从该处到末尾的切片。
fn field_value_start<'a>(body: &'a str, key: &str) -> Option<(usize, &'a str)> {
    let key_pat = format!("\"{key}\"");
    let key_pos = body.find(&key_pat)?;
    let after = &body[key_pos + key_pat.len()..];
    let colon = after.find(':')?;
    let rest = after[colon + 1..].trim_start().strip_prefix('"')?;
    Some((body.len() - rest.len(), rest))
}

/// 还原 JSON 字符串的转义。宽松场景下值里也可能混有未转义的引号与裸换行，
/// 未转义部分按字面保留，只处理常见的反斜杠转义序列。
fn unescape_loose(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some('/') => out.push('/'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// 把已解析的 JSON 值转成动作；不是动作对象（缺 `action` 字段）时返回 `None`。
fn action_from_value(value: &serde_json::Value) -> AppResult<Option<AgentAction>> {
    let Some(action) = value.get("action").and_then(|v| v.as_str()) else {
        return Ok(None);
    };

    match action.trim().to_lowercase().as_str() {
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
            Ok(Some(AgentAction {
                action: ACTION_RUN.into(),
                command: Some(command),
                summary: None,
            }))
        }
        ACTION_DONE => Ok(Some(AgentAction {
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
        })),
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

/// 按配对花括号切出候选 JSON 对象。
///
/// 模型偶尔会「边想边说」：先给一个草稿动作，再补一句解释，最后给正式动作。
/// 若只取「首 `{` 到末 `}`」，会把这些对象与夹带的解释文字混在一起导致解析失败，
/// 所以这里逐个切出配对的 `{...}`（跳过字符串内的花括号与转义），交给调用方逐个尝试。
fn json_candidates(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (index, byte) in text.bytes().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' => {
                if depth == 0 {
                    start = Some(index);
                }
                depth += 1;
            }
            b'}' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    if let Some(s) = start {
                        out.push(&text[s..=index]);
                    }
                }
            }
            _ => {}
        }
    }
    out
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

    /// 模型「边想边说」时会先给草稿再给正式动作，应取最后那个。
    #[test]
    fn parses_last_action_among_multiple_objects() {
        let raw = concat!(
            r#"{"action":"run","command":"df -h"} Actually let me just do one command combining. "#,
            r#"That's fine.{"action":"run","command":"df -h; free -m"}"#
        );
        let action = parse_action(raw).expect("多个 JSON 对象时应取最后一个");
        assert_eq!(action.command.as_deref(), Some("df -h; free -m"));
    }

    /// 夹带的花括号不得干扰切片：字符串内的 `{`/`}` 要按字面处理。
    #[test]
    fn braces_inside_command_string_do_not_confuse() {
        let raw = r#"{"action":"run","command":"echo \"{not json}\" | awk '{print $1}'"}"#;
        let action = parse_action(raw).expect("字符串内的花括号不应影响配对");
        assert_eq!(
            action.command.as_deref(),
            Some(r#"echo "{not json}" | awk '{print $1}'"#)
        );
    }

    #[test]
    fn rejects_run_without_command() {
        assert!(parse_action(r#"{"action":"run"}"#).is_err());
    }

    /// 模型把多行结论直接塞进字符串（值里是裸换行）时，严格 JSON 会失败，
    /// 宽松提取应能救回，且换行原样保留。
    #[test]
    fn recovers_done_with_raw_newlines() {
        let raw = "{\"action\":\"done\",\"summary\":\"已获取：\n- CPU：4 核\n- 内存：3.8GiB\"}";
        let action = parse_action(raw).expect("裸换行应能宽松提取");
        assert_eq!(action.action, ACTION_DONE);
        assert!(action.summary.as_deref().unwrap_or("").contains("\n- CPU：4 核"));
    }

    /// 字符串里出现未转义引号（奇偶都可能）会破坏严格解析与候选切分，
    /// 宽松提取应按形状取出完整值。
    #[test]
    fn recovers_done_with_unescaped_quotes() {
        let raw = r#"{"action":"done","summary":"运行 "uptime" 的输出正常"}"#;
        let action = parse_action(raw).expect("未转义引号应能宽松提取");
        assert_eq!(action.action, ACTION_DONE);
        assert_eq!(action.summary.as_deref(), Some(r#"运行 "uptime" 的输出正常"#));
    }

    #[test]
    fn recovers_run_with_unescaped_quotes() {
        let raw = r#"{"action":"run","command":"echo "hi""}"#;
        let action = parse_action(raw).expect("命令里的引号应能宽松提取");
        assert_eq!(action.action, ACTION_RUN);
        assert_eq!(action.command.as_deref(), Some(r#"echo "hi""#));
    }

    #[test]
    fn rejects_unknown_action_and_garbage() {
        assert!(parse_action(r#"{"action":"delete"}"#).is_err());
        assert!(parse_action("我先解释一下这个问题").is_err());
    }

    /// 有些模型不改 JSON，只吐接口层的工具调用标记（DSML 前缀 + 全角竖线）。
    #[test]
    fn parses_dsml_tool_call() {
        let raw = concat!(
            "<｜｜DSML｜｜tool_calls>\n",
            "<｜｜DSML｜｜invoke name=\"run\">\n",
            "<｜｜DSML｜｜parameter name=\"command\" string=\"true\">",
            "echo \"cpu.max: $(cat /sys/fs/cgroup/cpu.max 2>/dev/null)\"; nproc",
            "</｜｜DSML｜｜ parameter>\n",
            "</｜｜DSML｜｜ invoke>\n",
            "</｜｜DSML｜｜ calls>"
        );
        let action = parse_action(raw).expect("工具调用标记应能解析");
        assert_eq!(action.action, ACTION_RUN);
        assert_eq!(
            action.command.as_deref(),
            Some(r#"echo "cpu.max: $(cat /sys/fs/cgroup/cpu.max 2>/dev/null)"; nproc"#)
        );
    }

    /// 一次回复里有多个 invoke 时，跳过不认识的动作（如 think）继续找。
    #[test]
    fn skips_unknown_dsml_invoke() {
        let raw = concat!(
            "<｜｜DSML｜｜invoke name=\"think\"><｜｜DSML｜｜parameter name=\"content\">",
            "先看看负载</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>",
            "<｜｜DSML｜｜invoke name=\"run\"><｜｜DSML｜｜parameter name=\"command\">uptime",
            "</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>"
        );
        let action = parse_action(raw).expect("应跳过 think 取 run");
        assert_eq!(action.command.as_deref(), Some("uptime"));
    }

    #[test]
    fn parses_dsml_done_with_multiline_summary() {
        let raw = concat!(
            "<｜｜DSML｜｜invoke name=\"done\">",
            "<｜｜DSML｜｜parameter name=\"summary\" string=\"true\">CPU 为共享：\n",
            "- 4 核 1 线程\n- steal 为 0</｜｜DSML｜｜parameter>",
            "</｜｜DSML｜｜invoke>"
        );
        let action = parse_action(raw).expect("工具调用标记应能解析");
        assert_eq!(action.action, ACTION_DONE);
        assert_eq!(
            action.summary.as_deref(),
            Some("CPU 为共享：\n- 4 核 1 线程\n- steal 为 0")
        );
    }

    /// 命令里的 `</dev/null` 不能被当成结束标签。
    #[test]
    fn dsml_command_keeps_redirection() {
        let raw = concat!(
            "<invoke name=\"run\"><parameter name=\"command\">",
            "grep cpu /proc/cpuinfo </dev/null >/tmp/out",
            "</parameter></invoke>"
        );
        let action = parse_action(raw).expect("普通 XML 写法也应兼容");
        assert_eq!(
            action.command.as_deref(),
            Some("grep cpu /proc/cpuinfo </dev/null >/tmp/out")
        );
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
        let prompt = user_prompt("查看磁盘", &[], "", None);
        assert!(prompt.contains("已执行的步骤：暂无"));
        assert!(prompt.contains("用户当前终端最近输出（仅供参考，不是本任务命令的输出）：暂无"));
    }

    /// 只剩一两步时才提示收尾，避免每轮都出现一条干扰信息。
    #[test]
    fn user_prompt_hints_wrap_up_near_the_limit() {
        let near = user_prompt("查看磁盘", &[], "", Some(2));
        assert!(near.contains("最多还能执行 2 条命令"));
        let far = user_prompt("查看磁盘", &[], "", Some(10));
        assert!(!far.contains("最多还能执行"));
    }
}
