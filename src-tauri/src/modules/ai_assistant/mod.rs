//! AI 助手模块（FEATURES.md §5）。
//!
//! 职责概述：
//! - 通过 OpenAI 兼容的 Chat Completions 接口完成「提问 / 解答」与 Agent 自动执行
//!   两种模式（见 `client.rs`、`agent.rs`）。
//! - 请求**不内置任何 API Key**，Key 存加密保险库，由用户配置。
//! - 流式响应走 SSE，逐字广播 `ai:chunk` 事件，支持中途取消（见 `client.rs`）。
//! - Agent 给出的命令经 `danger.rs` 做权威危险检测，命中时附带原因，
//!   前端据此高亮并在写入终端前二次确认。
//! - 对话只按会话保存在前端内存里：随 SSH 会话关闭而丢弃，不落库。

pub mod agent;
pub mod client;
pub mod commands;
pub mod context;
pub mod danger;
pub mod protocol;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::AppHandle;

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::config::store::SharedStore;
use crate::config::ConfigManager;
use crate::error::AppResult;
use crate::modules::ModuleContext;

/// 一次 AI 请求的流式事件。前端据此逐字上屏 / 汇总 / 提示错误。
pub const EVENT_AI_CHUNK: &str = "ai:chunk";
pub const EVENT_AI_DONE: &str = "ai:done";
pub const EVENT_AI_ERROR: &str = "ai:error";
pub const EVENT_AI_CANCELLED: &str = "ai:cancelled";

/// AI 服务。命令层与模块层共用同一实例（同一个 HTTP 客户端、同一张取消表）。
#[derive(Clone)]
pub struct AiService {
    client: reqwest::Client,
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl Default for AiService {
    fn default() -> Self {
        Self::new()
    }
}

impl AiService {
    pub fn new() -> Self {
        Self {
            // 客户端只复用连接、不做 TLS 之外的额外设置：超时按请求粒度下发（见 client::chat）
            client: reqwest::Client::builder()
                .build()
                .expect("构建 AI HTTP 客户端失败"),
            cancels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    /// 登记一个在途请求，返回其取消标志。
    pub fn begin(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.cancels.lock().insert(id.to_string(), flag.clone());
        flag
    }

    /// 请求取消某个在途请求。
    pub fn cancel(&self, id: &str) {
        if let Some(flag) = self.cancels.lock().get(id) {
            flag.store(true, Ordering::SeqCst);
        }
    }

    /// 注销某个请求（完成 / 出错后清理）。
    pub fn end(&self, id: &str) {
        self.cancels.lock().remove(id);
    }
}

/// 一次 AI 调用所需的全部依赖。与 [`ModuleContext`] 不同，它多带了 [`AiService`]。
#[derive(Clone)]
pub struct AiContext {
    pub app: AppHandle,
    pub config: Arc<ConfigManager>,
    pub store: SharedStore,
    pub service: AiService,
}

/// AI 助手模块。启用后注册后台 HTTP 客户端；由于请求都是短生命周期任务，
/// 模块的 `init` / `dispose` 只负责生命周期日志与取消在途请求。
pub struct AiAssistantModule {
    service: AiService,
}

impl AiAssistantModule {
    pub fn new(service: AiService) -> Self {
        Self { service }
    }
}

impl PluggableModule for AiAssistantModule {
    fn id(&self) -> &'static str {
        module_id::AI_ASSISTANT
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.ai.ai_assistant
    }

    fn init(&self, _ctx: &ModuleContext) -> AppResult<()> {
        log::info!("AI 助手已启用：兼容 OpenAI Chat Completions，支持流式与取消");
        Ok(())
    }

    fn dispose(&self) -> AppResult<()> {
        // 关闭模块时取消全部在途请求，避免任务继续向后端写事件 / 落库
        let ids: Vec<String> = self.service.cancels.lock().keys().cloned().collect();
        for id in ids {
            self.service.cancel(&id);
        }
        Ok(())
    }
}