//! AI 供应商调用（FEATURES.md §5「多模型」）。
//!
//! 同一个模型条目由 `protocol` 字段决定用哪套协议，本模块按协议分别处理
//! **地址后缀 / 鉴权头 / 请求体 / 响应与流式解析**：
//! - [`Protocol::OpenAi`]：OpenAI 兼容 Chat Completions，`choices[].delta.content`；
//! - [`Protocol::OpenAiResponses`]：OpenAI Responses，`response.output_text.delta`；
//! - [`Protocol::Anthropic`]：Anthropic Messages，`content_block_delta`。
//!
//! 两种执行路径：
//! - 非流式：一次性返回完整文本；
//! - 流式（SSE）：逐段广播 [`EVENT_AI_CHUNK`]，并在循环内检查取消标志
//!   （命中即返回 `Ok(None)`）。
//!
//! API Key 从加密保险库读取，**绝不落盘**。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::Emitter;

use crate::config::app_config::{AiConfig, AiModelConfig};
use crate::config::store::secrets;
use crate::error::{AppError, AppResult};

use super::protocol::{Protocol, ANTHROPIC_VERSION};
use super::{AiContext, EVENT_AI_CHUNK};

/// 一条对话消息。OpenAI / Responses 用 `system | user | assistant`，
/// Anthropic 只用其中的 `user | assistant`（system 提到顶层字段）。
#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// 一次补全请求的参数。`id` 用于把流式事件与前端某次提问关联。
/// 模型 id / API 地址 / Key / 协议都来自请求时选定的模型条目，不在参数里重复携带。
#[derive(Debug, Clone)]
pub struct ChatOptions {
    pub id: String,
    pub messages: Vec<ChatMessage>,
    pub stream: bool,
}

/// 展示名：优先用户起的名字，其次模型 id，最后兜底成「未命名模型」。
fn display_name(model: &AiModelConfig) -> String {
    let name = model.name.trim();
    if !name.is_empty() {
        return name.to_string();
    }
    let id = model.model.trim();
    if id.is_empty() {
        return "未命名模型".to_string();
    }
    id.to_string()
}

/// 选择本次请求实际使用的模型条目。
///
/// 面板传的是模型条目的 id（不是模型名），这样同名模型配在不同供应商下也能区分。
/// 未传或找不到时退回列表第一条，保证「只要有模型就能用」。
pub fn select_model<'a>(cfg: &'a AiConfig, model_id: Option<&str>) -> Option<&'a AiModelConfig> {
    let want = model_id.map(str::trim).filter(|m| !m.is_empty());
    if let Some(want) = want {
        if let Some(hit) = cfg.models.iter().find(|m| m.id == want) {
            return Some(hit);
        }
    }
    cfg.models.first()
}

/// 连通性测试结果：展示名 + 往返耗时。
#[derive(Debug, Clone, Serialize)]
pub struct TestOutcome {
    pub name: String,
    pub elapsed_ms: u64,
}

/// 连通性测试的超时上限：测试要的是「能不能通」，不该让用户等满模型自己的超时。
const TEST_TIMEOUT_SECS: u64 = 20;

/// 拼出请求地址：`base_url` 去掉尾斜杠后接协议后缀。地址为空时给出可读的错误。
fn endpoint(model: &AiModelConfig) -> AppResult<String> {
    let base = model.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(AppError::Ai(format!(
            "模型「{}」未填写 API 地址",
            display_name(model)
        )));
    }
    Ok(format!("{base}{}", Protocol::from_value(&model.protocol).suffix()))
}

/// 取本次请求要用的 API Key。
///
/// 优先用调用方临时传入的（设置界面里刚输入、还没保存的那把），否则读该模型在
/// 加密保险库里的 Key。两者都没有时给出可直接照做的提示。
fn resolve_key(model: &AiModelConfig, override_key: Option<&str>) -> AppResult<String> {
    if let Some(k) = override_key.map(str::trim).filter(|k| !k.is_empty()) {
        return Ok(k.to_string());
    }
    secrets::get(&secrets::ai_model_key_key(&model.id))?
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            AppError::Ai(format!(
                "模型「{}」未配置 API Key，请在设置 → AI 助手中填写",
                display_name(model)
            ))
        })
}

/// 把 system 消息从对话里拆出来（Anthropic 要求 system 是顶层字段，不在 messages 里）。
/// 返回 `(system 文本, 其余消息)`；没有 system 时前半为 `None`。
fn split_system(messages: &[ChatMessage]) -> (Option<String>, Vec<ChatMessage>) {
    let mut system = String::new();
    let mut chat = Vec::new();
    for msg in messages {
        if msg.role == "system" {
            if !system.is_empty() {
                system.push_str("\n\n");
            }
            system.push_str(&msg.content);
        } else {
            chat.push(msg.clone());
        }
    }
    let system = if system.trim().is_empty() {
        None
    } else {
        Some(system)
    };
    (system, chat)
}

/// 按协议组装一次请求：地址、鉴权头与请求体都在这里落地。
///
/// `key_override` 允许设置界面用「刚输入、尚未保存」的 Key 先测通再保存。
fn build_request(
    ctx: &AiContext,
    model: &AiModelConfig,
    messages: &[ChatMessage],
    stream: bool,
    max_tokens: u32,
    key_override: Option<&str>,
) -> AppResult<reqwest::RequestBuilder> {
    if model.model.trim().is_empty() {
        return Err(AppError::Ai(format!(
            "模型「{}」未填写模型 ID",
            display_name(model)
        )));
    }
    let key = resolve_key(model, key_override)?;
    let url = endpoint(model)?;
    let protocol = Protocol::from_value(&model.protocol);

    let body = match protocol {
        Protocol::OpenAi => serde_json::json!({
            "model": model.model.trim(),
            "messages": messages,
            "temperature": model.temperature(),
            "max_tokens": max_tokens,
            "stream": stream,
        }),
        // Responses 用 input 承载对话、max_output_tokens 承载输出上限
        Protocol::OpenAiResponses => serde_json::json!({
            "model": model.model.trim(),
            "input": messages,
            "temperature": model.temperature(),
            "max_output_tokens": max_tokens,
            "stream": stream,
        }),
        Protocol::Anthropic => {
            let (system, chat) = split_system(messages);
            let mut body = serde_json::json!({
                "model": model.model.trim(),
                "messages": chat,
                "max_tokens": max_tokens,
                "temperature": model.temperature(),
                "stream": stream,
            });
            if let Some(sys) = system {
                body["system"] = serde_json::Value::String(sys);
            }
            body
        }
    };

    let request = ctx
        .service
        .client()
        .post(&url)
        .timeout(Duration::from_secs(model.timeout_secs()))
        .json(&body);

    Ok(match protocol {
        // Anthropic 用专用头鉴权，且必须带版本号
        Protocol::Anthropic => request
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION),
        _ => request.bearer_auth(key),
    })
}

/// 连通性测试：用给定条目的地址、Key 与模型名发一次最小的非流式请求。
///
/// 与正式请求共用同一套地址拼装、鉴权与请求体，因此一次调用就同时验到
/// 「地址可达 / Key 有效 / 模型名存在」三件事；失败原因原样返回，
/// 设置界面直接展示，用户照着改配置即可。
///
/// `key_override` 允许传表单里刚输入、尚未保存的 Key，做到「先测通再保存」。
pub async fn test_model(
    ctx: &AiContext,
    model: &AiModelConfig,
    key_override: Option<&str>,
) -> AppResult<TestOutcome> {
    let messages = vec![ChatMessage {
        role: "user".into(),
        content: "ping".into(),
    }];
    // 只发一个最小请求：够验证鉴权与模型名，又几乎不消耗额度
    let request = build_request(ctx, model, &messages, false, 1, key_override)?
        .timeout(Duration::from_secs(model.timeout_secs().min(TEST_TIMEOUT_SECS)));

    let started = std::time::Instant::now();
    let response = request.send().await?;
    let response = check_status(response).await?;

    // 有些网关用 200 包着一个 error 字段，这里一并当成失败
    let value: serde_json::Value = response
        .json()
        .await
        .unwrap_or(serde_json::Value::Null);
    if let Some(err) = value.get("error") {
        return Err(AppError::Ai(format!("AI 服务返回错误：{err}")));
    }

    Ok(TestOutcome {
        name: display_name(model),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// 调用一次补全。
///
/// 地址、API Key 与协议都取自所选模型条目，因此不同模型可以指向不同供应商。
///
/// 返回值：
/// - `Ok(Some(text))`：请求成功，`text` 为完整回复；
/// - `Ok(None)`：中途被取消；
/// - `Err(e)`：请求出错（网络 / HTTP / 无 Key / 无有效内容等）。
pub async fn chat(
    ctx: &AiContext,
    model: &AiModelConfig,
    opts: &ChatOptions,
    cancel: Arc<AtomicBool>,
) -> AppResult<Option<String>> {
    let protocol = Protocol::from_value(&model.protocol);
    // 采样温度 / 输出上限 / 超时 / 协议都取自该模型条目，各模型可独立调参
    let request = build_request(ctx, model, &opts.messages, opts.stream, model.max_tokens(), None)?;

    if opts.stream {
        stream_response(ctx, opts, cancel, request, protocol).await
    } else {
        let response = request.send().await?;
        let response = check_status(response).await?;
        let value: serde_json::Value = response.json().await?;
        let text = extract_text(protocol, &value).unwrap_or_default();
        if text.trim().is_empty() {
            return Err(AppError::Ai("AI 服务未返回有效内容".into()));
        }
        Ok(Some(text))
    }
}

/// SSE 流式路径：逐行解析 `data:` 事件，按协议取增量并广播。
async fn stream_response(
    ctx: &AiContext,
    opts: &ChatOptions,
    cancel: Arc<AtomicBool>,
    request: reqwest::RequestBuilder,
    protocol: Protocol,
) -> AppResult<Option<String>> {
    let response = request.send().await?;
    let response = check_status(response).await?;

    let mut stream = response.bytes_stream();
    let mut out = String::new();

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let bytes = chunk.map_err(|e| AppError::Ai(e.to_string()))?;
        for line in String::from_utf8_lossy(&bytes).lines() {
            let line = line.trim();
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                return Ok(Some(out));
            }
            if data.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            match protocol {
                Protocol::OpenAi => {
                    if let Some(delta) = extract_delta(&value) {
                        out.push_str(&delta);
                        emit_chunk(&ctx.app, &opts.id, &delta);
                    }
                }
                Protocol::OpenAiResponses => {
                    match value.get("type").and_then(|v| v.as_str()) {
                        Some("response.output_text.delta") => {
                            if let Some(delta) = value.get("delta").and_then(|v| v.as_str()) {
                                out.push_str(delta);
                                emit_chunk(&ctx.app, &opts.id, delta);
                            }
                        }
                        // 终止事件：拿到完整文本即可收工
                        Some("response.completed") => return Ok(Some(out)),
                        _ => {}
                    }
                }
                Protocol::Anthropic => {
                    match value.get("type").and_then(|v| v.as_str()) {
                        Some("content_block_delta") => {
                            if let Some(text) = value
                                .get("delta")
                                .and_then(|d| d.get("text"))
                                .and_then(|v| v.as_str())
                            {
                                out.push_str(text);
                                emit_chunk(&ctx.app, &opts.id, text);
                            }
                        }
                        Some("message_stop") => return Ok(Some(out)),
                        _ => {}
                    }
                }
            }
        }
    }
    Ok(Some(out))
}

/// 非 2xx 一律视为失败，把服务端错误正文带给前端。
/// 成功时把响应原样还回，供调用方继续消费正文 / 流。
async fn check_status(response: reqwest::Response) -> AppResult<reqwest::Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let detail = response.text().await.unwrap_or_default();
    Err(AppError::Ai(format!("AI 服务返回 {status}：{detail}")))
}

/// 非流式回复正文，按协议从不同的响应结构里取。
fn extract_text(protocol: Protocol, value: &serde_json::Value) -> Option<String> {
    match protocol {
        // choices[0].message.content
        Protocol::OpenAi => value
            .get("choices")?
            .get(0)?
            .get("message")?
            .get("content")?
            .as_str()
            .map(str::to_string),
        // output[].content[].text（type = output_text）
        Protocol::OpenAiResponses => {
            if let Some(text) = value.get("output_text").and_then(|v| v.as_str()) {
                if !text.trim().is_empty() {
                    return Some(text.to_string());
                }
            }
            let mut out = String::new();
            if let Some(items) = value.get("output").and_then(|v| v.as_array()) {
                for item in items {
                    let Some(parts) = item.get("content").and_then(|v| v.as_array()) else {
                        continue;
                    };
                    for part in parts {
                        if part.get("type").and_then(|v| v.as_str()) == Some("output_text") {
                            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                                out.push_str(text);
                            }
                        }
                    }
                }
            }
            non_empty(out)
        }
        // content[].text（type = text）
        Protocol::Anthropic => {
            let mut out = String::new();
            if let Some(parts) = value.get("content").and_then(|v| v.as_array()) {
                for part in parts {
                    if part.get("type").and_then(|v| v.as_str()) == Some("text") {
                        if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                            out.push_str(text);
                        }
                    }
                }
            }
            non_empty(out)
        }
    }
}

/// 空串一律当作「没取到」，交给上层报「未返回有效内容」。
fn non_empty(text: String) -> Option<String> {
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// OpenAI Chat Completions 的流式增量：`choices[0].delta.content`。
fn extract_delta(value: &serde_json::Value) -> Option<String> {
    value
        .get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()
        .map(str::to_string)
}

fn emit_chunk(app: &tauri::AppHandle, id: &str, text: &str) {
    if let Err(e) = app.emit(EVENT_AI_CHUNK, serde_json::json!({ "id": id, "text": text })) {
        log::warn!("广播 AI 流式事件失败：{e}");
    }
}
