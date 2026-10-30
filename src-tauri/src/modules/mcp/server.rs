//! MCP 的本地 HTTP 传输层。
//!
//! 只做三件事：绑定 127.0.0.1、校验本地令牌、把 JSON-RPC 交给 [`super::rpc`]。
//! 会话状态全部无状态化，因此不需要 `Mcp-Session-Id`，也不提供服务端主动推送
//! （`GET /mcp` 返回 405，客户端会退回 POST 模式）。

use std::io::Write;
use std::path::Path;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};

use crate::config::store::SharedStore;
use crate::config::ConfigManager;
use crate::error::{AppError, AppResult};
use crate::modules::ModuleContext;
use crate::ssh::interactive::AuthPromptHub;
use crate::ssh::session::SessionManager;

use super::rpc;

/// 本地令牌文件名（位于配置目录，权限 0600，不随 Git 同步）。
pub const TOKEN_FILE: &str = "mcp.token";

/// 请求体上限。MCP 请求本身很小，这里只防意外的大包。
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

/// 一次工具调用可用的共享状态。
#[derive(Clone)]
pub struct McpState {
    pub app: tauri::AppHandle,
    pub config: Arc<ConfigManager>,
    pub store: SharedStore,
    pub sessions: SessionManager,
    pub auth_hub: Arc<AuthPromptHub>,
    token: Arc<String>,
}

/// 已启动的服务句柄：关闭时先触发优雅退出，再中止任务兜底。
pub struct Running {
    pub port: u16,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Running {
    pub fn shutdown(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        self.task.abort();
    }
}

/// 启动 HTTP 服务。端口占用等错误在此同步返回，便于模块初始化时直接记录。
pub fn start(ctx: &ModuleContext) -> AppResult<Running> {
    let port = ctx.config.flags().mcp.port;
    let token = load_or_create_token(&ctx.paths.config_dir.join(TOKEN_FILE))?;

    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).map_err(|e| {
        AppError::Other(format!(
            "MCP 服务无法监听 127.0.0.1:{port}：{e}（可在 config.yaml 的 features.mcp.port 改端口）"
        ))
    })?;
    listener.set_nonblocking(true)?;

    let state = McpState {
        app: ctx.app.clone(),
        config: ctx.config.clone(),
        store: ctx.store.clone(),
        sessions: ctx.sessions.clone(),
        auth_hub: ctx.auth_hub.clone(),
        token: Arc::new(token),
    };

    let router = Router::new()
        .route("/health", get(health))
        .route("/mcp", post(handle_mcp).get(handle_get).delete(handle_delete))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state);

    let (tx, rx) = tokio::sync::oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(e) => {
                log::error!("MCP 服务监听失败：{e}");
                return;
            }
        };
        let served = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
        if let Err(e) = served {
            log::error!("MCP 服务异常退出：{e}");
        }
    });

    Ok(Running {
        port,
        shutdown: Some(tx),
        task,
    })
}

/// 读取或首次生成令牌。令牌只存在本机配置目录，不进入仓库与日志。
fn load_or_create_token(path: &Path) -> AppResult<String> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        let token = existing.trim().to_string();
        if !token.is_empty() {
            return Ok(token);
        }
    }

    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|e| AppError::Other(format!("无法写入 MCP 令牌文件 {}：{e}", path.display())))?;
    file.write_all(token.as_bytes())?;
    file.flush()?;
    Ok(token)
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    if let Some(value) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        if let Some(bearer) = value.strip_prefix("Bearer ") {
            if bearer.trim() == token {
                return true;
            }
        }
    }
    headers
        .get("x-pterm-token")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim() == token)
        .unwrap_or(false)
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn handle_get() -> Response {
    // 不提供服务端主动推送：按 MCP 规范返回 405，客户端会继续用 POST。
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [("allow", "POST, DELETE")],
        "SSE 流未启用，请使用 POST /mcp",
    )
        .into_response()
}

async fn handle_delete() -> Response {
    // 无状态服务：会话终止请求直接确认即可
    StatusCode::OK.into_response()
}

async fn handle_mcp(State(state): State<McpState>, headers: HeaderMap, body: Bytes) -> Response {
    if !authorized(&headers, &state.token) {
        return (
            StatusCode::UNAUTHORIZED,
            [("www-authenticate", "Bearer")],
            "缺少或无效的 MCP 令牌（见配置目录下 mcp.token）",
        )
            .into_response();
    }

    let payload: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return json_response(json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": { "code": -32700, "message": format!("请求不是合法 JSON：{e}") }
            }))
        }
    };

    let (responses, batch) = rpc::handle(payload, &state).await;
    if responses.is_empty() {
        // 全部是通知：按规范返回 202，无响应体
        return StatusCode::ACCEPTED.into_response();
    }
    let body = if batch {
        Value::Array(responses)
    } else {
        responses.into_iter().next().unwrap_or(Value::Null)
    };
    json_response(body)
}

fn json_response(body: Value) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}
