//! MCP 的 JSON-RPC 2.0 分发层（无状态）。
//!
//! 只实现外部 AI 需要的子集：`initialize` / `ping` / `tools/*`，
//! 以及几个通用 `list` 方法（返回空列表，避免客户端在握手阶段报错）。

use serde_json::{json, Value};

use super::server::McpState;
use super::tools;

/// 服务端自述的能力说明。工具描述之外的行为约束集中写在这里，
/// 客户端通常会把这段文本注入到模型的系统提示中。
const INSTRUCTIONS: &str = "\
pterm 通过本 MCP 服务提供 SSH 连接能力。凭据由本机保管，不会返回给调用方。

使用约定：
1. 先调用 list_connections 确认可用连接，再用 connect 建立会话；不要猜测主机名。
2. 一次只做一件事：先 connect，再 exec，最后 disconnect。任务结束务必 disconnect。
3. 命令失败或超时不要自动重试；把错误码和输出原样反馈给用户。
4. 遇到以下错误码时停止并请用户处理：
   - HOST_KEY_UNTRUSTED：需要用户在 pterm 界面手动连接一次该主机完成指纹信任。
   - AUTH_FAILED：需要用户检查该连接已保存的密码 / 私钥。
   - CONNECT_TIMEOUT：主机可能需要交互式验证码或二次确认，需先在界面完成登录。
   - EXEC_TIMEOUT：命令可能仍在远端运行，可用 read_output 继续查看，不要重复执行。
5. 会话停留在普通 shell 提示符下，不要用 exec 操作 vim / top / less 等全屏程序。
6. 执行破坏性命令（删除、覆盖、重启服务）前，先向用户确认。
";

pub async fn handle(payload: Value, state: &McpState) -> (Vec<Value>, bool) {
    match payload {
        Value::Array(items) => {
            let mut responses = Vec::new();
            for item in items {
                if let Some(response) = handle_one(item, state).await {
                    responses.push(response);
                }
            }
            (responses, true)
        }
        single => (handle_one(single, state).await.into_iter().collect(), false),
    }
}

async fn handle_one(message: Value, state: &McpState) -> Option<Value> {
    let method = message
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    if method.is_empty() {
        // 客户端对本服务端请求的应答；本服务不主动发请求，直接忽略
        return None;
    }
    // 没有 id 的是通知（如 notifications/initialized），不需要响应
    let id = message.get("id")?.clone();
    let params = message.get("params").cloned().unwrap_or(Value::Null);

    match dispatch(&method, &params, state).await {
        Ok(result) => Some(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
        Err((code, message)) => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message }
        })),
    }
}

async fn dispatch(
    method: &str,
    params: &Value,
    state: &McpState,
) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => {
            let protocol = params
                .get("protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("2025-06-18");
            Ok(json!({
                "protocolVersion": protocol,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": {
                    "name": "pterm",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "instructions": INSTRUCTIONS,
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools::schemas() })),
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or((-32602, "缺少工具名 name".to_string()))?
                .to_string();
            let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);
            let state = state.clone();
            let outcome =
                tokio::task::spawn_blocking(move || tools::call(&name, &arguments, &state))
                    .await
                    .map_err(|e| (-32603, format!("工具执行异常结束：{e}")))?;

            match outcome {
                Ok(text) => Ok(json!({
                    "content": [{ "type": "text", "text": text }],
                    "isError": false,
                })),
                // 工具自身失败：按 MCP 规范放在 result.isError，而不是 JSON-RPC error
                Err(text) => Ok(json!({
                    "content": [{ "type": "text", "text": text }],
                    "isError": true,
                })),
            }
        }
        "resources/list" | "resources/templates/list" => Ok(json!({ "resources": [] })),
        "prompts/list" => Ok(json!({ "prompts": [] })),
        "logging/setLevel" => Ok(json!({})),
        other => Err((-32601, format!("不支持的方法：{other}"))),
    }
}
