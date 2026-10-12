# pterm

跨平台（Windows / macOS）**SSH 终端客户端**。核心只做 SSH，其余功能全部是可插拔模块，可在设置中单独开关。

- 技术栈：Tauri 2.x（Rust + 系统 WebView）+ Vite + React + TypeScript + xterm.js
- 无 Electron；Node.js 仅用于前端构建，不是运行时依赖
- 前端为 React 渲染：外壳（`src/app/`）与各功能组件 / ES 模块（`src/features/`）均已是 React / TypeScript，跨模块协作以直接 import 为主、少数反向依赖经 `window.PTerm` 桥接（见下方「前端迁移状态」）
- 无云同步：Git 是唯一同步方式，只对接用户自己的远程仓库
- 不内置任何 AI API Key，全部由用户配置

## 功能

完整功能清单（唯一事实来源）：[FEATURES.md](./FEATURES.md)

摘要：

- **核心（不可关闭）**：SSH 连接、密码/密钥/键盘交互认证、终端渲染、终端内搜索、会话管理、配置加密存储、基础设置、界面语言、首次启动引导（语言选择）
- **连接与传输**：多标签、分屏、同步输入、SFTP、端口转发、跳板机、主机密钥校验、本地终端、会话日志、自动重连、连接分组、导入导出、快捷连接、远程桌面（RDP）
- **同步**：Git 同步、同步范围、冲突提示、状态显示、提交模板、多仓库
- **AI**：Ask 提问（右侧停靠面板，建议命令可手动点击运行）、Agent 自动执行（只读命令自动执行，关键操作需授权）、多模型、历史保存（近 30 天）、流式响应、危险提示、上下文注入
- **辅助**：命令片段、全局搜索、命令历史、快捷面板、自动更新、主题、快捷键、崩溃日志
- **系统托盘**：仅 Windows 提供且恒定常驻（无功能开关）；macOS 不支持，关闭窗口后由 Dock 图标恢复

> 笔记功能已明确移除，不实现。

## 目录结构

```
pterm/
├── FEATURES.md                  # 功能索引（唯一事实来源）
├── README.md
├── .github/workflows/ci.yml     # CI：安装依赖 + 测试 + 类型检查 + 构建
├── .github/workflows/release.yml # Release：打 v* 标签时打包 macOS / Windows 并发布（需配签名密钥 Secrets 以产出更新包）
├── tests/                       # 前端单元测试（node --test，纯函数）
├── package.json                 # 前端工程（Vite + React + TS）与脚本
├── vite.config.ts               # Vite 配置（root = src，产物输出 ../dist）
├── tsconfig.json
├── src-tauri/                   # Rust 后端
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   └── src/
│       ├── main.rs
│       ├── lib.rs
│       ├── ssh/                 # SSH 核心（不可关闭）
│       │   ├── session.rs       # 会话管理、断线重连（含本地终端会话分发）
│       │   ├── auth.rs          # 密码/密钥/键盘交互认证
│       │   ├── channel.rs       # Shell 通道、数据流
│       │   ├── interactive.rs   # 键盘交互认证的提示应答中枢
│       │   ├── jump.rs          # 跳板机（ProxyJump 隧道）
│       │   ├── known_hosts.rs   # 主机密钥校验（known_hosts / TOFU）
│       │   └── local.rs         # 本地终端运行器（本机 PTY）
│       ├── modules/             # 可插拔模块
│       │   ├── git_sync/        # Git 同步（可开关）
│       │   │   ├── repo.rs      # git2 仓库操作封装
│       │   │   ├── auth.rs      # SSH agent / 密钥 / 凭据链
│       │   │   └── fallback.rs  # 系统 git CLI 回退（边缘场景）
│       │   ├── ai_assistant/    # AI 助手（可开关）
│       │   ├── snippets/        # 命令片段（可开关）
│       │   ├── global_search/   # 全局搜索（可开关，检索逻辑在前端）
│       │   ├── command_history/ # 命令历史（可开关）
│       │   ├── local_terminal/  # 本地终端（可开关，本机 PTY shell）
│       │   ├── quick_panel/     # 快捷面板（可开关）
│       │   ├── system_tray/     # 系统托盘（仅 Windows，恒定常驻）
│       │   ├── auto_update/     # 自动更新（可开关，从 GitHub Releases 检查并安装。Tauri updater）
│       │   ├── theme/           # 主题（可开关，配色在前端 src/styles/theme.css）
│       │   └── shortcuts/       # 快捷键（可开关，派发在前端 src/features/shortcuts/）
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
└── src/                         # Web 前端（Vite + React + TS）
    ├── index.html               # Vite 入口（#root + vendor 脚本 + main.tsx）
    ├── main.tsx                 # React 入口：加载样式并挂载 App
    ├── App.tsx                  # 应用入口：渲染外壳，挂载后启动应用引导（features/app）
    ├── app/                     # 应用外壳（原 skeleton.html 转为 JSX 组件）
    │   ├── AppShell.tsx         # 外壳组合：.app + 弹窗 + 轻提示宿主
    │   ├── Sidebar.tsx          # 侧栏：直嵌连接列表与功能徽标、拖拽条
    │   ├── MainStack.tsx        # 主区：标签栏、panes、空状态、直嵌 AI 面板
    │   └── Dialogs.tsx          # 四个应用内弹窗与 #toast-host
    ├── types/
    │   └── global.d.ts          # xterm（Terminal / FitAddon）全局声明
    ├── components/
    │   ├── Portal.tsx           # 将弹窗内容挂载到 body
    │   └── form.tsx             # 与既有 util.form 对齐的基础元素
    ├── features/
    │   ├── app/                 # 应用引导与外壳（已迁移：store + startApp，无 UI）
    │   ├── snippets/            # 命令片段（已迁移：store + 组件）
    │   ├── search/              # 全局搜索（已迁移：store + matcher + 组件）
    │   ├── history/             # 命令历史（已迁移：store + 组件）
    │   ├── quick-panel/         # 快捷面板（已迁移：store + 组件）
    │   ├── session-log/         # 会话日志（已迁移：store + 组件）
    │   ├── port-forward/        # 端口转发（已迁移：store + 组件）
    │   ├── import-export/       # 配置导入导出（已迁移：store + 组件）
    │   ├── rdp/                 # 远程桌面入口（已迁移：api，无 UI）
    │   ├── local-terminal/      # 本地终端入口（已迁移：api，无 UI，会话编排复用 ssh）
    │   ├── sftp/                # SFTP 文件（已迁移：store + 组件，含传输队列）
    │   ├── settings/            # 设置面板（已迁移：constants + store + 组件）
    │   ├── shortcuts/           # 快捷键（已迁移：api，无 UI）
    │   ├── git-sync/            # Git 同步（已迁移：store + 组件）
    │   ├── vault/               # 主密码保险库门禁（已迁移：store + 组件）
    │   ├── auto-update/         # 自动更新（已迁移：store + 提示条组件，启动按开关检查）
    │   ├── onboarding/          # 首次启动引导（已迁移：store + 组件）
    │   ├── split/               # 分屏（已迁移：store + 组件）
    │   ├── sync-input/          # 同步输入（已迁移：store + 组件）
    │   ├── connections/         # 连接管理（已迁移：store + 组件）
    │   ├── ai/                  # AI 助手（已迁移：store + markdown + 组件）
    │   ├── context-menu/        # 通用右键菜单（已迁移：store + 组件，按需弹出）
    │   ├── danger/              # 危险命令检测（已迁移：rules + tracker，无 UI）
    │   ├── i18n/                # 多语言（已迁移：store，无 UI，直接 import）
    │   ├── ipc/                 # Tauri command/事件封装（已迁移：api，无 UI，直接 import）
    │   ├── ssh/                 # SSH 会话编排（已迁移：api，无 UI，直接 import）
    │   ├── tabs/                # 多标签与分屏布局（已迁移：store + 依赖注入，无 UI）
    │   ├── terminal/            # xterm.js 终端渲染（已迁移：api + 依赖注入，无 UI）
    │   └── util/                # 通用工具与弹窗（已迁移：util，无 UI，直接 import）
    ├── hooks/
    │   └── useLocale.ts         # 语言订阅与翻译函数
    ├── lib/
    │   └── legacy.ts            # 过渡入口：少数仍需 window.PTerm 的取值 + 配置辅助函数
    ├── public/                  # 静态资源（原样拷贝进 dist）
    │   ├── vendor/              # xterm.js 等 vendor 资源
    │   └── locales/             # 语言包（en-US.json）
    └── styles/
        ├── theme.css            # 亮/暗调色板与尺寸变量
        ├── base.css             # 布局、侧栏、标签、弹窗
        ├── terminal.css         # 终端区样式
        ├── settings.css         # 设置面板样式
        └── react-shell.css      # React 外壳宿主样式
```

## 环境要求

- Rust（stable）与 `cargo`
- Tauri CLI：`cargo install tauri-cli --version "^2"`（或使用 `cargo tauri`）
- Node.js 18+ 与 npm（仅前端构建需要，运行时不需要 Node）
- macOS 需 Xcode Command Line Tools；Windows 需 WebView2（Win11 自带）

前端由 Vite 构建、React 渲染、TypeScript 编写。xterm.js 以 vendor 资源形式随仓库提供（`src/public/vendor`），运行时经 Tauri 资源协议加载。`src-tauri/tauri.conf.json` 已配置 `beforeDevCommand` / `beforeBuildCommand`，`cargo tauri dev|build` 会自动拉起 Vite。

## 前端迁移状态

前端已从「原生 HTML/CSS/JS」迁移到「Vite + React + TypeScript」：原 `src/js/*.js` 全部改写为 `src/features/` 下的 ES 模块 / React 组件，原静态骨架 `skeleton.html` 也转为 `src/app/` 下的 React 组件，`src/legacy/` 已移除。

- **外壳**：`src/main.tsx` 挂载 React，`src/App.tsx` 渲染 `AppShell`（`src/app/`，即原 `skeleton.html` 的 JSX 版），挂载完成后调用 `features/app` 的 `startApp()` 拉取配置、装配主题并绑定全局交互。
- **形态**：有界面的功能为 `store`（状态与行为）+ React 组件订阅渲染；纯基础设施（util / ipc / ssh / terminal / tabs / app 等）为 `api` 或 `store`，不渲染界面。跨模块调用以直接 import 为主；`terminal`、`tabs`、`connections` 对会反向依赖它们的模块（如 sftp / port-forward / split / sync-input）改用启动期依赖注入（`wireDependencies`），避免 ESM 环。仅 `window.PTerm` 上保留 git-sync / search（反向依赖 app）与 settings / quick-panel 的少量面板入口桥接。
- **外壳 DOM**：`AppShell` 直接渲染侧栏连接列表、功能徽标、分屏按钮及 AI 停靠面板；`#panes` / `#tab-list` / `#sidebar` 等容器仍由命令式模块按 id 操作。弹窗继续通过 `Portal` 挂到 body。
- **构建链**：Vite `root` 指向 `src/`，产物输出到 `dist/`；Tauri 的 `frontendDist` 相应指向 `../dist`。

## 构建与运行

```bash
# 安装 Rust 工具链（若尚未安装）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# 安装 Tauri CLI
cargo install tauri-cli --version "^2"

# 安装前端依赖
npm install

# 开发模式（Vite 热更新 + 热重载 Rust 后端）
cargo tauri dev          # 或 npm run tauri dev

# 只调试前端（在浏览器打开；无 Tauri 宿主时后端能力不可用）
npm run dev

# 类型检查 / 构建前端产物到 dist/
npm run typecheck
npm run build

# 单元测试（node --test）/ 轻量检查（同 typecheck）
npm test
npm run lint

# 构建发行包（.app / .dmg / .msi / .exe）
cargo tauri build        # 或 npm run tauri build
```

## 配置

- `config.yaml`：功能开关、模型参数、同步策略
- SQLite：连接配置等非敏感数据
- `secrets.json`：密码、私钥 passphrase、API Key 等敏感字段，由主密码经 Argon2id 派生密钥 + AES-256-GCM 加密，并可随 Git 同步一起分发。新装首次打开时设置主密码；此后派生密钥作为自动解锁令牌存在同目录的 `vault.token`（权限 0600），启动即静默解锁，无需重复输入
- `onboarding.done`：首次启动引导（语言选择）的完成标记，同为配置目录下的本机文件，不随 Git 同步；删除它可在下次启动重新播放引导
- `known_hosts.json`：主机密钥校验（TOFU）记录的已知主机指纹，本机私有、不随 Git 同步

## 设计约定

- 每个可选模块实现统一接口：`init()` / `dispose()` / `is_enabled()`。
- 新增功能必须先在 `config/feature_flags.rs` 注册开关，并在 `FEATURES.md` 登记。
- 前端不直接访问 SSH 底层，通过 Tauri command 中介。
- 危险命令（`rm -rf`、`dd`、`mkfs` 等）必须二次确认。
- 终端输入输出通过 Tauri event 流式传输，避免轮询。
- Git 优先走 `git2`，仅在明确不支持时回退系统 CLI，并记录回退原因。
- 主密码只在新装首次打开时输入；派生密钥作为自动解锁令牌写入配置目录下的 `vault.token`，之后启动静默解锁。同一 Git 仓库的多台设备必须共用同一主密码，若同步到的保险库与本机不一致，弹窗由用户选择采用哪一边，绝不静默覆盖。