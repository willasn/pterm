use serde::{Deserialize, Serialize};

use super::known_hosts::{HostKeyInfo, HostKeyPolicy};

// ---------------------------------------------------------------------------
// 会话类型
// ---------------------------------------------------------------------------

/// 会话类型。SSH 为默认；Local 是本机 PTY 上的本地 shell（不经过网络）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    #[default]
    Ssh,
    Local,
}


// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------

/// 认证方式。
///
/// `password` / `passphrase` 字段允许前端在本次连接时临时传入；为 `None` 时
/// 从加密保险库按 `connection_id` 读取。**任何情况下都不会写盘。**
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthSpec {
    /// 依次尝试 agent → 默认私钥 → 保险库密码
    #[default]
    Auto,
    Password {
        #[serde(default)]
        password: Option<String>,
    },
    PrivateKey {
        key_path: String,
        #[serde(default)]
        passphrase: Option<String>,
    },
    Agent,
    /// 键盘交互认证（keyboard-interactive）：由服务端下发提示（密码 / 动态验证码等），
    /// 逐条应答。有界面时弹窗询问；无界面（SFTP / 端口转发 / 跳板机等后台连接）时
    /// 回退用 `password`（缺省取保险库中的密码）统一应答所有提示。
    KeyboardInteractive {
        #[serde(default)]
        password: Option<String>,
    },
}

/// 跳板机（ProxyJump）配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct JumpSpec {
    pub connection_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthSpec,
}

impl Default for JumpSpec {
    fn default() -> Self {
        Self {
            connection_id: None,
            host: String::new(),
            port: 22,
            username: String::new(),
            auth: AuthSpec::Auto,
        }
    }
}

// ---------------------------------------------------------------------------
// 连接参数
// ---------------------------------------------------------------------------

/// 建立一次 SSH 会话所需的全部参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct ConnectParams {
    /// 会话类型：SSH（默认）或本地终端。
    #[serde(default)]
    pub kind: SessionKind,
    /// 对应 SQLite 中的连接配置 id，用于读取保险库与记录历史。临时连接可为空。
    pub connection_id: Option<String>,
    pub name: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthSpec,
    pub jump: Option<JumpSpec>,
    /// 主机密钥信任策略。默认 `strict`：未记录或不一致一律拒绝。
    /// 前端在用户确认弹窗后置为 `accept_new` / `accept_any` 再重连。
    pub host_key_policy: HostKeyPolicy,
    /// 初始终端列数
    pub cols: u32,
    /// 初始终端行数
    pub rows: u32,
    /// 复用前端已有的标签 id，重连时保持同一个会话标识
    pub session_id: Option<String>,
}

impl Default for ConnectParams {
    fn default() -> Self {
        Self {
            kind: SessionKind::Ssh,
            connection_id: None,
            name: None,
            host: String::new(),
            port: 22,
            username: String::new(),
            auth: AuthSpec::Auto,
            jump: None,
            host_key_policy: HostKeyPolicy::Strict,
            cols: 80,
            rows: 24,
            session_id: None,
        }
    }
}

impl ConnectParams {
    /// 用于日志与界面展示的 `user@host:port`。
    pub fn endpoint(&self) -> String {
        format!("{}@{}:{}", self.username, self.host, self.port)
    }
}

// ---------------------------------------------------------------------------
// 会话状态
// ---------------------------------------------------------------------------

/// 会话状态机。前端根据 `ssh:status:{id}` 事件渲染标签页状态点。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SessionState {
    Connecting,
    Authenticated { method: String },
    Ready,
    Reconnecting {
        attempt: u32,
        max_attempts: u32,
        delay_ms: u64,
        reason: String,
    },
    Disconnected { reason: String, will_reconnect: bool },
    Closed,
    Error {
        message: String,
        /// 是否为「认证被拒」（区别于网络 / 参数错误）。前端据此在快捷连接
        /// 失败后弹框补录密码，而不是把超时、握手失败也当成密码问题。
        auth_failed: bool,
        /// 主机密钥校验未通过时附带的上下文（指纹 / 是否变更），前端据此弹信任确认框。
        #[serde(skip_serializing_if = "Option::is_none")]
        host_key: Option<HostKeyInfo>,
    },
}

impl SessionState {
    /// 是否处于用户可交互状态。
    pub fn is_ready(&self) -> bool {
        matches!(self, SessionState::Ready)
    }
}

/// 会话对外快照。
#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub kind: SessionKind,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub state: SessionState,
    pub created_at: String,
}

/// 会话线程内部命令。
#[derive(Debug)]
pub enum SessionCommand {
    /// 键盘输入（原始字节）
    Write(Vec<u8>),
    /// 终端尺寸变化
    Resize { cols: u32, rows: u32 },
    /// 用户主动关闭：不再重连
    Close,
}

/// shell 泵的结束原因。
#[derive(Debug)]
pub struct ShellEnd {
    /// true 表示用户主动关闭或远端正常退出，不需要重连
    pub clean: bool,
    pub reason: String,
}