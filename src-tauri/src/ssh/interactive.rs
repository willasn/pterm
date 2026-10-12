//! 键盘交互认证（keyboard-interactive）的应答中枢。
//!
//! 许多服务器（尤其企业环境的 PAM / 多因素认证）要求键盘交互认证：服务端下发提示
//! （如 `Password:`、`Verification code:`），客户端逐条应答。认证发生在会话线程里，
//! 而提示必须交给界面，因此这里做一次「线程阻塞等待 + 前端回填」的往返：
//!
//! 1. 会话线程调用 [`AuthPromptHub::ask`]：登记等待、推送 `ssh:auth-prompt:{id}` 事件、阻塞；
//! 2. 前端把提示弹给用户，经 `ssh_auth_respond` 回填；
//! 3. `ask` 收到应答后返回，认证继续。
//!
//! 抢跑问题：会话线程可能在 `ssh_connect` 返回、前端订阅之前就发出提示，事件会丢。
//! 因此中枢同时缓存「最近一条未应答的提示」，前端订阅后可用 `ssh_auth_pending` 对齐
//! （与 `ssh_sessions` 对齐会话状态同理）。

use std::collections::HashMap;
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// 等待用户应答的最长时间；超时视为放弃。
const PROMPT_TIMEOUT: Duration = Duration::from_secs(180);

/// 键盘交互提示的事件名。前端按会话 id 订阅。
pub fn prompt_event(id: &str) -> String {
    format!("ssh:auth-prompt:{id}")
}

/// 一条待用户应答的认证提示。
#[derive(Debug, Clone, Serialize)]
pub struct AuthPrompt {
    pub id: String,
    /// 服务端给出的提示语，如 `Password:` / `Verification code:`。
    pub text: String,
    /// 是否回显。false 表示按密码处理（输入不回显）。
    pub echo: bool,
}

/// 一次提问的结果。
#[derive(Debug)]
pub enum PromptOutcome {
    /// 用户输入了内容
    Answered(String),
    /// 用户主动取消
    Cancelled,
    /// 等待超时
    TimedOut,
}

/// 应答中枢。挂在 `AppState` 上，会话线程与命令层共用同一实例。
#[derive(Default)]
pub struct AuthPromptHub {
    /// id -> 等待应答的发送端。发送 `Some(text)` 为答案，`None` 表示取消。
    waiters: Mutex<HashMap<String, Sender<Option<String>>>>,
    /// id -> 最近一条尚未应答的提示（用于前端订阅后的对齐）
    pending: Mutex<HashMap<String, AuthPrompt>>,
}

impl AuthPromptHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// 发起一次提问并阻塞等待应答。
    pub fn ask(&self, app: &AppHandle, id: &str, text: &str, echo: bool) -> PromptOutcome {
        let (tx, rx) = mpsc::channel();
        let payload = AuthPrompt {
            id: id.to_string(),
            text: text.to_string(),
            echo,
        };
        self.waiters.lock().insert(id.to_string(), tx);
        self.pending.lock().insert(id.to_string(), payload.clone());
        // 推送失败（前端尚未订阅）不中止：前端可用 ssh_auth_pending 对齐这条提示
        if let Err(e) = app.emit(&prompt_event(id), &payload) {
            log::warn!("推送键盘交互提示失败：{e}");
        }

        let outcome = match rx.recv_timeout(PROMPT_TIMEOUT) {
            Ok(Some(text)) => PromptOutcome::Answered(text),
            Ok(None) => PromptOutcome::Cancelled,
            Err(_) => {
                log::warn!("会话 {id} 的键盘交互提示等待超时");
                PromptOutcome::TimedOut
            }
        };
        self.waiters.lock().remove(id);
        self.pending.lock().remove(id);
        outcome
    }

    /// 前端回填答案。`None` 表示用户取消。返回 true 表示确有等待中的提问被投递。
    pub fn respond(&self, id: &str, text: Option<String>) -> bool {
        match self.waiters.lock().get(id) {
            Some(tx) => tx.send(text).is_ok(),
            None => false,
        }
    }

    /// 读取某会话当前待应答的提示（前端订阅后对齐用）。
    pub fn pending_of(&self, id: &str) -> Option<AuthPrompt> {
        self.pending.lock().get(id).cloned()
    }

    /// 清掉某会话的残留等待（会话结束 / 取消时调用）。
    pub fn cancel(&self, id: &str) {
        self.waiters.lock().remove(id);
        self.pending.lock().remove(id);
    }
}

/// 会话线程侧的应答器：把提示交给前端，拿回用户的输入。
#[derive(Clone)]
pub struct InteractivePrompter {
    pub app: AppHandle,
    pub id: String,
    pub hub: Arc<AuthPromptHub>,
}

impl InteractivePrompter {
    pub fn new(app: AppHandle, id: String, hub: Arc<AuthPromptHub>) -> Self {
        Self { app, id, hub }
    }

    /// 询问一条提示。
    pub fn ask(&self, text: &str, echo: bool) -> PromptOutcome {
        self.hub.ask(&self.app, &self.id, text, echo)
    }
}
