# pshell

跨平台（Windows / macOS）**SSH 终端客户端**。核心只做 SSH，其余功能全部是可插拔模块，可在设置中单独开关。

- 技术栈：Tauri 2.x（Rust + 系统 WebView）+ 原生 HTML/CSS/JS + xterm.js
- 无 Electron、无 Node 运行时依赖
- 无云同步：Git 是唯一同步方式，只对接用户自己的远程仓库
- 不内置任何 AI API Key，全部由用户配置

## 功能

完整功能清单（唯一事实来源）：[FEATURES.md](./FEATURES.md)

摘要：

- **核心（不可关闭）**：SSH 连接、密码/密钥认证、终端渲染、会话管理、配置加密存储、基础设置、界面语言、首次启动引导（语言选择）
- **连接与传输**：多标签、分屏、同步输入、SFTP、端口转发、跳板机、会话日志、自动重连、连接分组、导入导出、快捷连接、远程桌面（RDP）
- **同步**：Git 同步、同步范围、冲突提示、状态显示、提交模板、多仓库
- **AI**：Ask 提问（右侧停靠面板）、Agent 自动执行（每条命令需确认）、多模型、历史保存（近 30 天）、流式响应、危险提示、上下文注入
- **辅助**：命令片段、全局搜索、命令历史、快捷面板、系统托盘、自动更新、主题、快捷键、崩溃日志

> 笔记功能已明确移除，不实现。

## 目录结构

```
pshell/
├── FEATURES.md                  # 功能索引（唯一事实来源）
├── README.md
├── src-tauri/                   # Rust 后端
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   └── src/
│       ├── main.rs
│       ├── lib.rs
│       ├── ssh/                 # SSH 核心（不可关闭）
│       │   ├── session.rs       # 会话管理、断线重连
│       │   ├── auth.rs          # 密码/密钥认证
│       │   ├── channel.rs       # Shell 通道、数据流
│       │   └── jump.rs          # 跳板机（ProxyJump 隧道）
│       ├── modules/             # 可插拔模块
│       │   ├── git_sync/        # Git 同步（可开关）
│       │   │   ├── repo.rs      # git2 仓库操作封装
│       │   │   ├── auth.rs      # SSH agent / 密钥 / 凭据链
│       │   │   └── fallback.rs  # 系统 git CLI 回退（边缘场景）
│       │   ├── ai_assistant/    # AI 助手（可开关）
│       │   ├── snippets/        # 命令片段（可开关）
│       │   ├── global_search/   # 全局搜索（可开关，检索逻辑在前端）
│       │   ├── command_history/ # 命令历史（可开关）
│       │   ├── quick_panel/     # 快捷面板（可开关）
│       │   ├── system_tray/     # 系统托盘（可开关）
│       │   ├── theme/           # 主题（可开关，配色在前端 theme.css）
│       │   └── shortcuts/       # 快捷键（可开关，派发在前端 shortcuts.js）
│       ├── features/            # 用户可配置的功能点
│       │   ├── sftp/
│       │   ├── port_forward/
│       │   ├── session_log/
│       │   ├── rdp/             # Windows 远程桌面（Windows 走 mstsc，macOS 走微软 Windows App）
│       │   └── import_export/
│       ├── config/
│       │   ├── feature_flags.rs # 全局功能开关定义（对照 FEATURES.md）
│       │   ├── vault.rs         # 主密码加密的敏感字段保险库（secrets.json）
│       │   └── app_config.rs
│       └── utils/
└── src/                         # Web 前端（无构建步骤）
    ├── index.html
    ├── js/
    │   ├── terminal.js          # xterm.js 封装
    │   ├── ssh.js               # SSH 会话调用
    │   ├── tabs.js              # 多标签与分屏布局
    │   ├── sync_input.js        # 同步输入（全局 / 同步组广播）
    │   ├── git_sync.js          # Git 同步 UI
    │   ├── ai.js              # AI 助手 UI
    │   ├── shortcuts.js         # 快捷键绑定与冲突检测
    │   ├── vault.js             # 主密码保险库门禁（设置 / 解锁）
    │   └── settings.js          # 设置面板
    └── styles/
        ├── theme.css            # 亮/暗调色板与尺寸变量
        └── base.css             # 布局、侧栏、标签、弹窗
```

## 环境要求

- Rust（stable）与 `cargo`
- Tauri CLI：`cargo install tauri-cli --version "^2"`（或使用 `cargo tauri`）
- macOS 需 Xcode Command Line Tools；Windows 需 WebView2（Win11 自带）

前端为原生 HTML/CSS/JS，**无需 Node.js**。xterm.js 以 vendor 资源形式随仓库提供，运行时通过 Tauri 的资源协议加载。

## 构建与运行

```bash
# 安装 Rust 工具链（若尚未安装）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# 安装 Tauri CLI
cargo install tauri-cli --version "^2"

# 开发模式（热重载 Rust 后端）
cargo tauri dev

# 构建发行包（.app / .dmg / .msi / .exe）
cargo tauri build
```

## 配置

- `config.yaml`：功能开关、模型参数、同步策略
- SQLite：连接配置等非敏感数据
- `secrets.json`：密码、私钥 passphrase、API Key 等敏感字段，由主密码经 Argon2id 派生密钥 + AES-256-GCM 加密，并可随 Git 同步一起分发。新装首次打开时设置主密码；此后派生密钥作为自动解锁令牌存在同目录的 `vault.token`（权限 0600），启动即静默解锁，无需重复输入
- `onboarding.done`：首次启动引导（语言选择）的完成标记，同为配置目录下的本机文件，不随 Git 同步；删除它可在下次启动重新播放引导

## 设计约定

- 每个可选模块实现统一接口：`init()` / `dispose()` / `is_enabled()`。
- 新增功能必须先在 `config/feature_flags.rs` 注册开关，并在 `FEATURES.md` 登记。
- 前端不直接访问 SSH 底层，通过 Tauri command 中介。
- 危险命令（`rm -rf`、`dd`、`mkfs` 等）必须二次确认。
- 终端输入输出通过 Tauri event 流式传输，避免轮询。
- Git 优先走 `git2`，仅在明确不支持时回退系统 CLI，并记录回退原因。
- 主密码只在新装首次打开时输入；派生密钥作为自动解锁令牌写入配置目录下的 `vault.token`，之后启动静默解锁。同一 Git 仓库的多台设备必须共用同一主密码，若同步到的保险库与本机不一致，弹窗由用户选择采用哪一边，绝不静默覆盖。