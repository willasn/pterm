//! MCP 工具实现。
//!
//! 五个最小闭环工具：列出连接 / 建立连接 / 执行命令 / 读取输出 / 断开。
//! 凭据始终由 pterm 从加密保险库读取，工具参数与返回值里都不出现明文口令或私钥。

use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::ssh::key_setup;
use crate::ssh::session::SessionDeps;
use crate::ssh::types::{ConnectParams, SessionState};

use super::server::McpState;

/// 单次命令输出最多回传的字节数（客户端一般还有 token 上限）。
const MAX_OUTPUT_BYTES: usize = 32 * 1024;
/// 读取最近输出时的环形缓冲上限
const RECENT_LIMIT: usize = 64 * 1024;
/// 建立连接后等待就绪的默认与上限
const CONNECT_TIMEOUT_MS: u64 = 25_000;
const CONNECT_TIMEOUT_MAX_MS: u64 = 120_000;
/// 执行命令的默认与上限超时
const EXEC_TIMEOUT_MS: u64 = 30_000;
const EXEC_TIMEOUT_MAX_MS: u64 = 120_000;

/// 工具清单。description 就是给外部 AI 的使用说明，需写清适用场景与失败处理。
pub fn schemas() -> Value {
    json!([
        {
            "name": "list_connections",
            "description": "列出 pterm 中已保存的 SSH 连接（不含任何密码或私钥）。调用 connect 前先用它确认可用的连接名称。",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        },
        {
            "name": "connect",
            "description": "按连接名称或 id 建立一条 SSH 会话，由 pterm 代为完成认证（凭据不会返回给调用方）。等待认证完成后返回 session_id。若返回 HOST_KEY_UNTRUSTED，说明该主机指纹尚未在 pterm 界面中被信任，需要用户先在 pterm 中手动连接一次；不要自动重试。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "alias": { "type": "string", "description": "连接名称（name）或连接 id" },
                    "timeout_ms": {
                        "type": "integer",
                        "description": "等待连接就绪的超时毫秒数，默认 25000",
                        "minimum": 5000,
                        "maximum": 120000
                    }
                },
                "required": ["alias"],
                "additionalProperties": false
            }
        },
        {
            "name": "exec",
            "description": "在一个已就绪的会话中执行一条 shell 命令并等待结束，返回退出码与合并后的输出。会话必须停留在普通 shell 提示符下（不要用它操作 vim/top 这类全屏程序）。超时返回 EXEC_TIMEOUT 和已捕获的部分输出，命令可能仍在远端运行。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "connect 返回的会话 id" },
                    "command": { "type": "string", "description": "要执行的 shell 命令，可包含多行" },
                    "timeout_ms": {
                        "type": "integer",
                        "description": "等待命令结束的超时毫秒数，默认 30000，最大 120000",
                        "minimum": 1000,
                        "maximum": 120000
                    }
                },
                "required": ["session_id", "command"],
                "additionalProperties": false
            }
        },
        {
            "name": "read_output",
            "description": "读取会话最近的终端输出（环形缓冲，最多 64 KB）。用于查看仍在运行的长任务的输出，或补齐 exec 超时后的后续内容。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "会话 id" },
                    "max_bytes": {
                        "type": "integer",
                        "description": "最多返回的字节数，默认 16384，最大 65536",
                        "minimum": 1024,
                        "maximum": 65536
                    }
                },
                "required": ["session_id"],
                "additionalProperties": false
            }
        },
        {
            "name": "disconnect",
            "description": "关闭会话并释放资源。任务结束后应主动调用，避免远端残留登录会话。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "会话 id" }
                },
                "required": ["session_id"],
                "additionalProperties": false
            }
        }
    ])
}

/// 执行一次工具调用。返回 JSON 文本；`Err` 表示工具执行失败（MCP 层面回 `isError`）。
pub fn call(name: &str, args: &Value, st: &McpState) -> Result<String, String> {
    let value = match name {
        "list_connections" => list_connections(st),
        "connect" => connect(st, args),
        "exec" => exec(st, args),
        "read_output" => read_output(st, args),
        "disconnect" => disconnect(st, args),
        other => return Err(format!("未知工具：{other}")),
    }?;
    Ok(serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string()))
}

fn list_connections(st: &McpState) -> Result<Value, String> {
    let connections = st
        .store
        .list_connections()
        .map_err(|e| format!("读取连接列表失败：{e}"))?;
    let items: Vec<Value> = connections
        .into_iter()
        .filter(|c| c.protocol == crate::config::store::PROTOCOL_SSH)
        .map(|c| {
            json!({
                "id": c.id,
                "name": c.name,
                "host": c.host,
                "port": c.port,
                "username": c.username,
                "group": c.group_name,
                "auth_kind": c.auth_kind,
                "has_saved_password": c.has_password,
                "has_saved_passphrase": c.has_passphrase,
                "via_jump_host": c.jump.as_ref().map(|j| format!("{}:{}", j.host, j.port)),
            })
        })
        .collect();
    Ok(json!({ "connections": items }))
}

fn connect(st: &McpState, args: &Value) -> Result<Value, String> {
    let alias = args
        .get("alias")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if alias.is_empty() {
        return Err("INVALID_ARGUMENT: alias 不能为空".into());
    }
    let timeout = clamp_ms(args.get("timeout_ms"), CONNECT_TIMEOUT_MS, CONNECT_TIMEOUT_MAX_MS);

    let connections = st
        .store
        .list_connections()
        .map_err(|e| format!("读取连接列表失败：{e}"))?;
    let ssh: Vec<_> = connections
        .into_iter()
        .filter(|c| c.protocol == crate::config::store::PROTOCOL_SSH)
        .collect();
    let found = ssh
        .iter()
        .find(|c| c.id == alias || c.name == alias)
        .or_else(|| ssh.iter().find(|c| c.name.eq_ignore_ascii_case(alias)));

    let Some(conn) = found else {
        let names: Vec<String> = ssh.iter().take(20).map(|c| c.name.clone()).collect();
        return Err(format!(
            "CONNECTION_NOT_FOUND: 没有名为「{alias}」的 SSH 连接。可用连接：{}",
            if names.is_empty() {
                "（空）".to_string()
            } else {
                names.join("、")
            }
        ));
    };

    let flags = st.config.flags();
    let params: ConnectParams = key_setup::connect_params(conn, flags.connection.jump_host);
    if params.host.trim().is_empty() || params.username.trim().is_empty() {
        return Err("INVALID_CONNECTION: 该连接缺少主机或用户名，请先在 pterm 中补全".into());
    }
    // MCP 一律使用严格主机密钥策略：不接受静默信任，避免把凭据交给未知主机
    let deps = SessionDeps {
        app: st.app.clone(),
        config: st.config.clone(),
        logger: None,
        auth_hub: st.auth_hub.clone(),
    };
    let info = st
        .sessions
        .create(&deps, params)
        .map_err(|e| format!("CONNECT_FAILED: {e}"))?;

    let deadline = Instant::now() + Duration::from_millis(timeout);
    loop {
        // 会话线程结束时会把句柄从活跃表摘掉，只留一份最终快照；
        // 因此取不到句柄时要回落到快照，否则「主机密钥未信任」「认证失败」这类
        // 立即结束的错误会被误报成「会话在就绪前已结束」。
        let state = match st.sessions.get(&info.id) {
            Some(handle) => handle.state(),
            None => match st
                .sessions
                .list()
                .into_iter()
                .find(|snapshot| snapshot.id == info.id)
            {
                Some(snapshot) => snapshot.state,
                None => return Err("CONNECT_FAILED: 会话在就绪前已结束".into()),
            },
        };
        match state {
            SessionState::Ready => {
                return Ok(json!({
                    "session_id": info.id,
                    "name": info.name,
                    "host": info.host,
                    "port": info.port,
                    "username": info.username,
                }))
            }
            SessionState::Error {
                message,
                auth_failed,
                host_key,
            } => {
                let _ = st.sessions.close(&info.id);
                if host_key.is_some() {
                    return Err(format!(
                        "HOST_KEY_UNTRUSTED: {message}。请在 pterm 界面中手动连接该主机并确认指纹后再试"
                    ));
                }
                if auth_failed {
                    return Err(format!(
                        "AUTH_FAILED: {message}。请在 pterm 中确认该连接已保存密码或私钥，或先在界面登录一次"
                    ));
                }
                return Err(format!("CONNECT_FAILED: {message}"));
            }
            SessionState::Closed => {
                return Err("CONNECT_FAILED: 会话已关闭，可能是远端主动断开".into())
            }
            SessionState::Disconnected { reason, .. } => {
                return Err(format!("CONNECT_FAILED: 连接已断开（{reason}）"))
            }
            _ => {}
        }
        if Instant::now() >= deadline {
            // 认证可能在等待人工应答，先取消挂起提示再关闭，避免线程继续阻塞
            st.auth_hub.cancel(&info.id);
            let _ = st.sessions.close(&info.id);
            return Err(format!(
                "CONNECT_TIMEOUT: {timeout}ms 内未完成认证。若该主机需要交互式验证码 / 二次确认，请先在 pterm 界面完成一次登录"
            ));
        }
        thread::sleep(Duration::from_millis(80));
    }
}

fn exec(st: &McpState, args: &Value) -> Result<Value, String> {
    let session_id = args
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if session_id.is_empty() {
        return Err("INVALID_ARGUMENT: session_id 不能为空".into());
    }
    if command.trim().is_empty() {
        return Err("INVALID_ARGUMENT: command 不能为空".into());
    }
    let timeout = clamp_ms(args.get("timeout_ms"), EXEC_TIMEOUT_MS, EXEC_TIMEOUT_MAX_MS);

    let handle = st
        .sessions
        .require(session_id)
        .map_err(|e| format!("SESSION_NOT_FOUND: {e}"))?;
    if !handle.state().is_ready() {
        return Err("SESSION_NOT_READY: 会话当前不可交互，请先 connect".into());
    }

    // 命令前后各打一个唯一标记，用环形缓冲解析输出与退出码；
    // 标记只含十六进制与下划线，可直接放进单引号内。
    let marker = format!("__pterm_mcp_{}__", uuid::Uuid::new_v4().simple());
    let payload = format!(
        "printf '%s:START\\n' {marker}\n{command}\nprintf '%s:EXIT:%s\\n' {marker} \"$?\"\n"
    );
    st.sessions
        .write(session_id, payload.into_bytes())
        .map_err(|e| format!("WRITE_FAILED: {e}"))?;
    log::info!("MCP 执行命令：session={session_id}");

    let start_tag = format!("{marker}:START");
    let exit_tag = format!("{marker}:EXIT:");
    let deadline = Instant::now() + Duration::from_millis(timeout);

    loop {
        let Some(current) = st.sessions.get(session_id) else {
            return Err("SESSION_CLOSED: 会话已断开，命令可能仍在远端运行".into());
        };
        let text = current.recent_text(RECENT_LIMIT);

        // 终端会把我们写入的命令行回显一遍，其中也包含结束标记的字面量；
        // 只有后面紧跟可解析退出码的那一处才是真正的结束输出。
        let exit_at = text.rfind(&exit_tag).filter(|&at| {
            text[at + exit_tag.len()..]
                .split_whitespace()
                .next()
                .and_then(|s| s.parse::<i32>().ok())
                .is_some()
        });

        if let Some(exit_at) = exit_at {
            let exit_code = text[exit_at + exit_tag.len()..]
                .split_whitespace()
                .next()
                .and_then(|s| s.parse::<i32>().ok());
            let output = match text.rfind(&start_tag) {
                Some(start_at) => text[start_at + start_tag.len()..exit_at].to_string(),
                // 输出过长导致起始标记被环形缓冲挤掉：保留缓冲内全部内容
                None => text[..exit_at].to_string(),
            };
            let output = output.trim_start_matches(['\r', '\n']).trim_end().to_string();
            let (output, truncated) = cap_output(output, MAX_OUTPUT_BYTES);
            return Ok(json!({
                "session_id": session_id,
                "exit_code": exit_code,
                "output": output,
                "truncated": truncated,
            }));
        }

        if Instant::now() >= deadline {
            let partial = match text.rfind(&start_tag) {
                Some(start_at) => text[start_at + start_tag.len()..].to_string(),
                None => text.clone(),
            };
            let partial = partial.trim_start_matches(['\r', '\n']).trim_end().to_string();
            let (partial, truncated) = cap_output(partial, MAX_OUTPUT_BYTES);
            return Err(format!(
                "EXEC_TIMEOUT: {timeout}ms 内未结束，命令可能仍在远端运行。已捕获输出：\n{}{}",
                partial,
                if truncated { "\n…（输出已截断）" } else { "" }
            ));
        }
        thread::sleep(Duration::from_millis(60));
    }
}

fn read_output(st: &McpState, args: &Value) -> Result<Value, String> {
    let session_id = args
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if session_id.is_empty() {
        return Err("INVALID_ARGUMENT: session_id 不能为空".into());
    }
    let max_bytes = clamp_usize(args.get("max_bytes"), 16 * 1024, 64 * 1024);
    let handle = st
        .sessions
        .require(session_id)
        .map_err(|e| format!("SESSION_NOT_FOUND: {e}"))?;
    let text = handle.recent_text(max_bytes);
    Ok(json!({
        "session_id": session_id,
        "state": handle.state(),
        "output": text,
    }))
}

fn disconnect(st: &McpState, args: &Value) -> Result<Value, String> {
    let session_id = args
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if session_id.is_empty() {
        return Err("INVALID_ARGUMENT: session_id 不能为空".into());
    }
    st.auth_hub.cancel(session_id);
    st.sessions
        .close(session_id)
        .map_err(|e| format!("DISCONNECT_FAILED: {e}"))?;
    log::info!("MCP 关闭会话：{session_id}");
    Ok(json!({ "session_id": session_id, "closed": true }))
}

fn clamp_ms(value: Option<&Value>, default: u64, max: u64) -> u64 {
    value
        .and_then(|v| v.as_u64())
        .unwrap_or(default)
        .clamp(1_000, max)
}

fn clamp_usize(value: Option<&Value>, default: usize, max: usize) -> usize {
    value
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(default)
        .clamp(1_024, max)
}

/// 限制输出体积。超限时保留末尾（日志与报错通常在尾部），并按字符边界截断。
fn cap_output(text: String, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text, false);
    }
    let mut cut = text.len() - max_bytes;
    while cut < text.len() && !text.is_char_boundary(cut) {
        cut += 1;
    }
    (format!("…（已省略前 {cut} 字节）\n{}", &text[cut..]), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schemas_cover_the_minimal_loop() {
        let tools = schemas();
        let names: Vec<&str> = tools
            .as_array()
            .expect("工具清单应为数组")
            .iter()
            .filter_map(|t| t.get("name").and_then(|n| n.as_str()))
            .collect();
        for expected in [
            "list_connections",
            "connect",
            "exec",
            "read_output",
            "disconnect",
        ] {
            assert!(names.contains(&expected), "缺少工具 {expected}");
        }
        // 每个工具都要有输入 schema，否则客户端无法生成调用参数
        for tool in tools.as_array().unwrap() {
            assert!(
                tool.get("inputSchema")
                    .map(|s| s.is_object())
                    .unwrap_or(false),
                "工具 {} 缺少 inputSchema",
                tool.get("name").and_then(|n| n.as_str()).unwrap_or("?")
            );
        }
    }

    #[test]
    fn cap_output_keeps_tail_and_breaks_on_char_boundary() {
        let text = "起点".repeat(10);
        let (out, truncated) = cap_output(text, 8);
        assert!(truncated);
        // 截断后仍是合法 UTF-8，且保留原文末尾
        assert!(out.ends_with("起点"));
    }
}
