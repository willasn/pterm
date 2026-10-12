//! AI 助手的 Tauri command 层（FEATURES.md §5）。
//!
//! 全部命令先经 [`AppState::require_module`] 门控（模块关闭直接拒绝）。
//! `ai_ask` 是「同步返回 + 异步执行」：命令立即返回请求 id，真正的网络请求在后台
//! 任务里跑，逐字广播 `ai:chunk`，结束时广播 `ai:done`。这样的设计让前端无需阻塞
//! 等待，也能随时通过 `ai_cancel` 取消。Ask 模式只回答问题，不向终端写入任何内容。
//!
//! `ai_agent_step` 走另一条路：它只做一次「决策」并同步返回动作，循环与执行确认
//! 都在前端——后端永远不会自己往终端写东西。

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::config::app_config::{new_model_id, AiModelConfig};
use crate::config::feature_flags::module_id;
use crate::config::store::secrets;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::client::{self, ChatMessage, ChatOptions};
use super::{agent, danger, protocol, EVENT_AI_CANCELLED, EVENT_AI_DONE, EVENT_AI_ERROR};

/// 一次 AI 提问的入参。Ask 模式没有场景之分，输入即问题。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiAskInput {
    #[serde(default)]
    pub input: String,
    /// 要使用的模型条目 id（设置 → AI 助手中的自定义模型）。留空则用第一条。
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// 用于把历史按会话归组
    #[serde(default)]
    pub session_id: Option<String>,
}

/// `ai_ask` 的同步返回值：前端据此关联后续的流式 / 完成 / 错误事件。
#[derive(Debug, Clone, Serialize)]
pub struct AiAskResult {
    pub id: String,
}

/// 组装 Ask 模式的 user 消息。
///
/// Ask 模式不区分场景：问题原样交给模型，只约定「给出建议与指导」。命令以 ```sh
/// 代码块单独列出，面板会为每个命令块生成「运行」按钮，由用户手动点击后才写入终端——
/// 模型自己不会执行任何命令。
fn build_user_message(input: &AiAskInput) -> AppResult<String> {
    let q = input.input.trim();
    if q.is_empty() {
        return Err(AppError::Ai("请输入你想问的内容".into()));
    }
    Ok(format!(
        "你是终端助手。请回答下面的问题，给出可操作的建议与指导。需要给出 shell 命令时，\
请把每条命令放进 ```sh 代码块单独列出，并简要说明用途与风险——用户会在面板里点击\
「运行」手动执行，你并不会真的执行它。\n\n{q}"
    ))
}

/// 发起一次 AI 补全。同步返回请求 id，后台任务流式 / 一次性产出结果。
#[tauri::command]
pub fn ai_ask(
    app: AppHandle,
    state: State<'_, AppState>,
    input: AiAskInput,
) -> AppResult<AiAskResult> {
    state.require_module(module_id::AI_ASSISTANT)?;

    let flags = state.flags();
    let cfg = state.config.snapshot();

    // 地址与 Key 都挂在模型条目上，因此必须先选出模型才能校验凭据
    let model = client::select_model(&cfg.ai, input.model.as_deref())
        .ok_or_else(|| AppError::Ai("尚未配置任何模型，请在设置 → AI 助手中添加".into()))?
        .clone();

    if !matches!(
        secrets::get(&secrets::ai_model_key_key(&model.id))?,
        Some(v) if !v.is_empty()
    ) {
        return Err(AppError::Ai(format!(
            "模型「{}」未配置 API Key，请在设置 → AI 助手中填写",
            model_display_name(&model)
        )));
    }

    let user_content = build_user_message(&input)?;

    let system = context_message(&state, flags.ai.ai_context_inject, &input, model.context_bytes());

    let mut messages: Vec<ChatMessage> = Vec::new();
    if let Some(sys) = system {
        messages.push(ChatMessage {
            role: "system".into(),
            content: sys,
        });
    }
    messages.push(ChatMessage {
        role: "user".into(),
        content: user_content,
    });

    let id = uuid::Uuid::new_v4().to_string();
    let cancel = state.ai.begin(&id);

    let opts = ChatOptions {
        id: id.clone(),
        messages,
        stream: flags.ai.ai_streaming,
    };

    let ctx = state.ai_context(app.clone());
    let task_app = app.clone();
    let task_id = id.clone();

    tauri::async_runtime::spawn(async move {
        let result = client::chat(&ctx, &model, &opts, cancel.clone()).await;
        ctx.service.end(&task_id);

        match result {
            Ok(Some(text)) => {
                // Ask 模式的输出只用于阅读：不注入终端，因此这里不做危险命令检测
                let _ = task_app.emit(
                    EVENT_AI_DONE,
                    serde_json::json!({ "id": task_id, "text": text }),
                );
            }
            Ok(None) => {
                let _ = task_app.emit(EVENT_AI_CANCELLED, serde_json::json!({ "id": task_id }));
            }
            Err(e) => {
                let _ = task_app.emit(
                    EVENT_AI_ERROR,
                    serde_json::json!({ "id": task_id, "error": e.to_string() }),
                );
            }
        }
    });

    Ok(AiAskResult { id })
}

/// 与 client.rs 的展示名规则保持一致：优先名字，其次模型 id。
fn model_display_name(model: &crate::config::app_config::AiModelConfig) -> String {
    let name = model.name.trim();
    if !name.is_empty() {
        return name.to_string();
    }
    let id = model.model.trim();
    if id.is_empty() {
        "未命名模型".to_string()
    } else {
        id.to_string()
    }
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.require_module(module_id::AI_ASSISTANT)?;
    state.ai.cancel(&id);
    Ok(())
}

// ---------------------------------------------------------------------------
// 模型配置：连通性测试 / 单条保存
// ---------------------------------------------------------------------------

/// 连通性测试入参。
///
/// 字段来自设置界面里「还没保存」的表单，因此可以先测再存；`api_key` 留空时
/// 回落到该模型已存进保险库的那把 Key。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiTestModelInput {
    /// 已保存过的模型带上它的 id，才能从保险库取到原有 Key
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub base_url: String,
    /// 协议：决定请求地址后缀、鉴权头与请求 / 响应格式（留空按 OpenAI 兼容）
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

/// 用给定条目发一次最小请求，验证「地址可达 / Key 有效 / 模型名存在」。
#[tauri::command]
pub async fn ai_test_model(
    app: AppHandle,
    state: State<'_, AppState>,
    input: AiTestModelInput,
) -> AppResult<client::TestOutcome> {
    state.require_module(module_id::AI_ASSISTANT)?;
    let model = AiModelConfig {
        id: input.id.unwrap_or_default(),
        name: input.name,
        model: input.model,
        base_url: input.base_url,
        protocol: input.protocol,
        temperature: None,
        max_tokens: None,
        max_input_tokens: None,
        timeout_secs: input.timeout_secs,
        context_bytes: None,
    };
    let ctx = state.ai_context(app);
    client::test_model(&ctx, &model, input.api_key.as_deref()).await
}

/// 返回可选协议清单（值、展示名、路径后缀、说明）。
///
/// 设置界面据此渲染「协议」下拉与「会加什么后缀」提示；是纯静态元数据，
/// 因此不做模块门控——即使 AI 助手关闭也要能显示当前配置用了哪个协议。
#[tauri::command]
pub fn ai_protocols() -> Vec<protocol::ProtocolInfo> {
    protocol::catalog()
}

/// 单条模型的保存入参。
///
/// `api_key` 为 `None` 表示不动保险库；`Some("")` 表示删除该模型的 Key。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiSaveModelInput {
    pub model: AiModelConfig,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiSaveModelResult {
    /// 保存后的完整模型列表：前端据此对齐草稿，避免与磁盘上的列表不一致
    pub models: Vec<AiModelConfig>,
}

/// 把单个模型写入配置的模型列表（新增或覆盖）。Key 依旧只进加密保险库。
///
/// 与全局 `save_config` 分开是为了支持「逐个模型保存」：填好一个、测通一个、存一个，
/// 不必等设置里其它分类的改动一起提交。
#[tauri::command]
pub fn ai_save_model(
    state: State<'_, AppState>,
    input: AiSaveModelInput,
) -> AppResult<AiSaveModelResult> {
    state.require_module(module_id::AI_ASSISTANT)?;

    let mut model = input.model;
    if model.model.trim().is_empty() {
        return Err(AppError::Ai("请先填写模型 ID".into()));
    }
    if model.base_url.trim().is_empty() {
        return Err(AppError::Ai("请先填写 API 地址".into()));
    }
    if model.id.trim().is_empty() {
        model.id = new_model_id();
    }

    // 没有可用 Key 的模型存进去只会让面板报错，这里直接拒绝
    let has_key = match input.api_key.as_deref() {
        Some(k) => !k.trim().is_empty(),
        None => matches!(
            secrets::get(&secrets::ai_model_key_key(&model.id))?,
            Some(v) if !v.is_empty()
        ),
    };
    if !has_key {
        return Err(AppError::Ai(
            "请先为该模型填写 API Key（可留空保存后单独配置，但模型需有凭据才能使用）".into(),
        ));
    }

    // Key 先落保险库：写失败就直接返回，配置里不会留下一个「没有凭据的模型」
    if let Some(key) = input.api_key.as_deref() {
        if key.trim().is_empty() {
            secrets::delete(&secrets::ai_model_key_key(&model.id))?;
        } else {
            secrets::set(&secrets::ai_model_key_key(&model.id), key.trim())?;
        }
    }

    let models = state.config.update(|cfg| {
        match cfg.ai.models.iter_mut().find(|m| m.id == model.id) {
            Some(existing) => *existing = model.clone(),
            None => cfg.ai.models.push(model.clone()),
        }
        cfg.ai.models.clone()
    })?;
    log::info!("已保存 AI 模型 {}（{}）", model.name, model.id);
    Ok(AiSaveModelResult { models })
}

/// 从模型列表里删除一条，并清掉它在保险库里的 Key。
///
/// 与单条保存对称：模型列表由每个模型自己的按钮维护，删除也要立刻生效，
/// 否则面板还会列出已经删掉的模型。返回删除后的完整列表。
#[tauri::command]
pub fn ai_delete_model(state: State<'_, AppState>, model_id: String) -> AppResult<AiSaveModelResult> {
    state.require_module(module_id::AI_ASSISTANT)?;
    let models = state.config.update(|cfg| {
        cfg.ai.models.retain(|m| m.id != model_id);
        cfg.ai.models.clone()
    })?;
    // 配置里已经没有这个模型了，保险库里的 Key 也就没有归属，直接清掉避免残留
    if let Err(e) = secrets::delete(&secrets::ai_model_key_key(&model_id)) {
        log::warn!("删除模型 {model_id} 的 API Key 失败：{e}");
    }
    log::info!("已删除 AI 模型 {model_id}");
    Ok(AiSaveModelResult { models })
}

// ---------------------------------------------------------------------------
// Agent 模式
// ---------------------------------------------------------------------------

/// Agent 模式的一步入参。循环由前端驱动：每执行完一条命令，带着结果再请求下一步，
/// 这样「是否执行」的确认权始终留在用户手里，后端不会自己往终端里写东西。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiAgentStepInput {
    /// 用户目标
    pub goal: String,
    /// 已经执行过的步骤（命令 + 输出），按时间顺序
    #[serde(default)]
    pub steps: Vec<agent::AgentStep>,
    /// 当前终端最近输出
    #[serde(default)]
    pub terminal_tail: String,
    #[serde(default)]
    pub model: Option<String>,
}

/// 一步的结果：要么给出一条命令（可能需授权），要么宣告结束。
#[derive(Debug, Clone, Serialize)]
pub struct AiAgentStepResult {
    /// run | done
    pub action: String,
    pub command: Option<String>,
    pub summary: Option<String>,
    /// 是否需要用户授权后才能执行（删除 / 修改 / 关键操作等）；false 时前端自动执行
    pub requires_auth: bool,
    /// 需要授权的原因；可自动执行时为空
    pub auth_reason: Option<String>,
    /// 命中破坏性危险规则的原因；前端据此额外高亮并二次确认
    pub danger: Option<String>,
    /// 模型原始回复，便于排查解析问题
    pub raw: String,
}

/// Agent 模式的一步：读终端输出 → 让模型决定下一步 → 解析成结构化动作。
///
/// 本命令**不执行任何命令**，只负责决策：连同「这一步是否需要用户授权」一起返回。
/// 可自动执行的只读命令由前端直接写入终端，关键操作则由前端停下等用户确认。
#[tauri::command]
pub async fn ai_agent_step(
    app: AppHandle,
    state: State<'_, AppState>,
    input: AiAgentStepInput,
) -> AppResult<AiAgentStepResult> {
    state.require_module(module_id::AI_ASSISTANT)?;
    if input.goal.trim().is_empty() {
        return Err(AppError::Ai("请先填写目标".into()));
    }

    let cfg = state.config.snapshot();
    let model = client::select_model(&cfg.ai, input.model.as_deref())
        .ok_or_else(|| AppError::Ai("尚未配置任何模型，请在设置 → AI 助手中添加".into()))?
        .clone();

    let messages = vec![
        ChatMessage {
            role: "system".into(),
            content: agent::system_prompt(),
        },
        ChatMessage {
            role: "user".into(),
            content: agent::user_prompt(&input.goal, &input.steps, &input.terminal_tail),
        },
    ];

    let ctx = state.ai_context(app);
    let opts = ChatOptions {
        id: uuid::Uuid::new_v4().to_string(),
        messages,
        stream: false,
    };

    let text = client::chat(&ctx, &model, &opts, Arc::new(AtomicBool::new(false)))
        .await?
        .unwrap_or_default();

    let parsed = agent::parse_action(&text)?;
    let verdict = match parsed.command.as_deref() {
        Some(cmd) => danger::classify(cmd),
        None => danger::Verdict::safe(),
    };

    Ok(AiAgentStepResult {
        action: parsed.action,
        command: parsed.command,
        summary: parsed.summary,
        requires_auth: verdict.requires_auth,
        auth_reason: verdict.reason.map(str::to_string),
        danger: if verdict.danger { verdict.reason.map(str::to_string) } else { None },
        raw: text,
    })
}

/// 上下文注入开关打开时组装 system 消息。
///
/// `context_bytes` 取自所选模型条目：不同模型上下文窗口差别很大，长度上限应随之可调。
/// 读取会话输出失败（会话已结束等）不视为致命错误，退化成只带主机与目录。
fn context_message(
    state: &AppState,
    enabled: bool,
    input: &AiAskInput,
    context_bytes: usize,
) -> Option<String> {
    let recent = if enabled {
        input
            .session_id
            .as_deref()
            .and_then(|id| state.sessions.recent_text(id, context_bytes).ok())
    } else {
        None
    };
    crate::modules::ai_assistant::context::build_system_message(
        enabled,
        input.host.as_deref(),
        input.cwd.as_deref(),
        recent.as_deref(),
    )
}