//! AI 供应商调用（OpenAI 兼容 Chat Completions）。
//!
//! 支持两种模式：
//! - 非流式：一次性返回完整文本；
//! - 流式（SSE）：逐字解析 `choices[0].delta.content`，每段广播 [`EVENT_AI_CHUNK`]，
//!   并在循环内检查取消标志，命中即返回 `Ok(None)`。
//!
//! API Key 从系统钥匙串读取，**绝不落盘**；请求 URL 由 `base_url` + `/chat/completions`
//! 拼接而成，兼容所有 OpenAI 协议的网关。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::Emitter;

use crate::config::app_config::{AiConfig, AiModelConfig};
use crate::config::store::secrets;
use crate::error::{AppError, AppResult};

use super::{AiContext, EVENT_AI_CHUNK};

/// 一条对话消息。OpenAI 协议中 `role` 为 `system | user | assistant`。
#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// 一次补全请求的参数。`id` 用于把流式事件与前端某次提问关联。
/// 模型 id / API 地址 / Key 都来自请求时选定的模型条目，不在参数里重复携带。
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

/// 拼出 chat/completions 地址。地址为空时给出可读的错误。
fn endpoint(model: &AiModelConfig) -> AppResult<String> {
    let base = model.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(AppError::Ai(format!(
            "模型「{}」未填写 API 地址",
            display_name(model)
        )));
    }
    Ok(format!("{base}/chat/completions"))
}

/// 取本次请求要用的 API Key。
///
/// 优先用调用方临时传入的（设置界面里刚输入、还没保存的那把），否则读该模型在
/// 系统钥匙串里的 Key。两者都没有时给出可直接照做的提示。
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

/// 连通性测试：用给定条目的地址、Key 与模型名发一次最小的非流式请求。
///
/// 与正式请求共用同一套地址拼装与鉴权，因此一次调用就同时验到
/// 「地址可达 / Key 有效 / 模型名存在」三件事；失败原因原样返回，
/// 设置界面直接展示，用户照着改配置即可。
///
/// `key_override` 允许传表单里刚输入、尚未保存的 Key，做到「先测通再保存」。
pub async fn test_model(
    ctx: &AiContext,
    model: &AiModelConfig,
    key_override: Option<&str>,
) -> AppResult<TestOutcome> {
    if model.model.trim().is_empty() {
        return Err(AppError::Ai(format!(
            "模型「{}」未填写模型 ID",
            display_name(model)
        )));
    }
    let key = resolve_key(model, key_override)?;
    let url = endpoint(model)?;

    // 只发一个最小请求：够验证鉴权与模型名，又几乎不消耗额度
    let body = serde_json::json!({
        "model": model.model.trim(),
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 1,
        "stream": false,
    });

    let started = std::time::Instant::now();
    let response = ctx
        .service
        .client()
        .post(&url)
        .bearer_auth(&key)
        .timeout(Duration::from_secs(model.timeout_secs().min(TEST_TIMEOUT_SECS)))
        .json(&body)
        .send()
        .await?;
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

/// 调用 Chat Completions。
///
/// 地址与 API Key 都取自所选模型条目，因此不同模型可以指向不同供应商。
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
    let key = resolve_key(model, None)?;
    let url = endpoint(model)?;

    // 采样温度 / 输出上限 / 超时都取自该模型条目，各模型可独立调参
    let body = serde_json::json!({
        "model": &model.model,
        "messages": &opts.messages,
        "temperature": model.temperature(),
        "max_tokens": model.max_tokens(),
        "stream": opts.stream,
    });

    let request = ctx
        .service
        .client()
        .post(&url)
        .bearer_auth(&key)
        .timeout(Duration::from_secs(model.timeout_secs()))
        .json(&body);

    if opts.stream {
        stream_response(ctx, opts, cancel, request).await
    } else {
        let response = request.send().await?;
        let response = check_status(response).await?;
        let value: serde_json::Value = response.json().await?;
        let text = extract_text(&value).unwrap_or_default();
        if text.trim().is_empty() {
            return Err(AppError::Ai("AI 服务未返回有效内容".into()));
        }
        Ok(Some(text))
    }
}

/// SSE 流式路径：逐行解析 `data:` 事件，累积并广播增量。
async fn stream_response(
    ctx: &AiContext,
    opts: &ChatOptions,
    cancel: Arc<AtomicBool>,
    request: reqwest::RequestBuilder,
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
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(delta) = extract_delta(&value) {
                    out.push_str(&delta);
                    emit_chunk(&ctx.app, &opts.id, &delta);
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

/// 非流式回复正文：`choices[0].message.content`。
fn extract_text(value: &serde_json::Value) -> Option<String> {
    value
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()
        .map(str::to_string)
}

/// 流式增量：`choices[0].delta.content`。
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