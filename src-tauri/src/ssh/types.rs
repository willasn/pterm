use serde::{Deserialize, Serialize};

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
    /// 对应 SQLite 中的连接配置 id，用于读取保险库与记录历史。临时连接可为空。
    pub connection_id: Option<String>,
    pub name: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthSpec,
    pub jump: Option<JumpSpec>,
    /// 初始终端列数
    pub cols: u32,
    /// 初始终端行数
    pub rows: u32,
    /// 覆盖配置中的 TERM 类型
    pub term_type: Option<String>,
    /// 复用前端已有的标签 id，重连时保持同一个会话标识
    pub session_id: Option<String>,
}

impl Default for ConnectParams {
    fn default() -> Self {
        Self {
            connection_id: None,
            name: None,
            host: String::new(),
            port: 22,
            username: String::new(),
            auth: AuthSpec::Auto,
            jump: None,
            cols: 80,
            rows: 24,
            term_type: None,
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