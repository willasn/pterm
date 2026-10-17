# pterm 功能清单（FEATURES.md）

> 本文件是 pterm 的**功能索引与唯一事实来源**。
> 任何新增功能必须先在 `feature_flags.rs` 注册开关、并在本文件登记，然后才能实现代码。
> 每个条目使用 `- [ ] / - [x]` 标记实现状态，`FLAG` 列给出配置文件（`config.yaml`）中的开关路径。

---

## 0. 项目定位与技术栈

**定位**：跨平台（Windows / macOS）SSH 终端客户端。核心只做 SSH，其余全部为可插拔模块。

**技术栈**

| 层 | 选型 |
| --- | --- |
| 框架 | Tauri 2.x（Rust 后端 + 系统 WebView 前端） |
| 前端 | Vite + React + TypeScript（构建期需要 Node.js；运行时不依赖 Node） |
| 终端渲染 | xterm.js + xterm-addon-fit |
| SSH 后端 | Rust `ssh2` crate |
| Git 操作 | Rust `git2` crate（进程内 libgit2） |
| AI 集成 | Rust `reqwest`，OpenAI 兼容 API，流式 SSE |
| 本地存储 | SQLite（`rusqlite`）存连接配置；敏感字段用主密码加密后存 `secrets.json`（`argon2` + `aes-gcm`） |
| 配置管理 | YAML（`serde_yaml`）存功能开关与自定义命令 |

---

## 1. 核心功能（不可关闭 / NON-CORE-FEATURES）

> 核心模块**没有 `enabled` 开关**，始终加载、始终可用。`is_enabled()` 对其恒返回 `true`。

| 状态 | 功能 | 说明 | 代码位置 |
| --- | --- | --- | --- |
| [x] | SSH 连接 | 建立到远程主机的 SSH 会话，指定 host/port/user | `src-tauri/src/ssh/session.rs` |
| [x] | 密码认证 | 密码登录，密码经主密码加密后存入本地保险库 | `src-tauri/src/ssh/auth.rs` |
| [x] | 密钥认证 | 私钥文件 + 可选 passphrase，支持 key 探测 | `src-tauri/src/ssh/auth.rs` |
| [x] | 键盘交互认证 | 支持 keyboard-interactive：建连时服务端下发提示（`Password:` / 动态验证码等），弹窗逐条应答后继续认证，覆盖 PAM / 多因素（MFA / OTP）服务器。连接认证方式可选「键盘交互」；`auto` 模式在其它方式失败后也会自动尝试。跳板机提示复用同一会话界面。弹窗全局串行（多会话同时要求输入时排队，不互相顶掉）；**用户取消 / 超时会给出「已取消键盘交互认证」/「等待超时」的明确提示，且不触发补录密码**。SFTP / 端口转发等无界面连接用保险库中保存的密码作为静态应答 | `src-tauri/src/ssh/auth.rs`、`src-tauri/src/ssh/interactive.rs`、`src/features/ssh/api.ts` |
| [x] | 终端渲染 | xterm.js 渲染 ANSI/VT，自适应尺寸（fit addon） | `src/features/terminal/` |
| [x] | 复制 / 粘贴 | 选中即复制可选（`terminal.copy_on_select`）；终端内右击弹出「复制 / 粘贴」菜单（`terminal.right_click_menu`）；复制 / 粘贴可绑定快捷键（动作 `terminal.copy` / `terminal.paste`），无选中文本时复制键原样落到终端；粘贴走 xterm 原生 paste，同样经过危险命令检测。WebView 不提供 `navigator.clipboard` 时（macOS 打包后的 `tauri://` 自定义协议、部分 Linux WebKitGTK）自动回退到 Rust 命令读写系统剪贴板。vim 等开启鼠标上报（`set mouse=a`）的程序中，按住 Option（macOS）/ Shift（Windows / Linux）拖动可强制选中文本 | `src/features/terminal/`、`src/features/shortcuts/`、`src-tauri/src/utils/commands.rs` |
| [x] | 终端内搜索 | 终端内 `Cmd/Ctrl+F` 打开查找条，在回滚缓冲中查找：输入即从当前视口向下定位，Enter 下一个 / Shift+Enter 上一个（环形），`Aa` 切换区分大小写，Esc 关闭。**全部命中项用鲜艳底色高亮**（xterm decoration 半透明色块，不遮字），当前项换橙色并加描边；同时滚动到可视区中部。快捷动作 `terminal.find` | `src/features/terminal/`（`search.ts` + `api.ts`） |
| [x] | 本地即时回显 | 预测性回显：按键先本地上屏，远端回显到达后逐字节比对对齐，不一致则整段撤回重画；回车、Tab、方向键、粘贴不预测。可用 `terminal.local_echo` 关闭 | `src/features/terminal/` |
| [x] | 输入法自动切换 | `ime_auto_switch` | WKWebView 下简体拼音 / 微信输入法等会把普通字母键报成 `keyCode 229`，字符只能经隐藏 textarea 的组合通道进来，快打丢字、慢打重复（系统 ABC 无此问题）。命令模式（默认）在终端获得焦点时把系统输入源切到英文、应用失焦时还原；输入法模式则交还系统输入法以输入中文。终端内 `Cmd/Ctrl+Shift+I` 或点击右下角角标切换，新会话继承上次选择。仅 macOS 生效 | `src-tauri/src/features/ime/`、`src/features/terminal/` |

> ⚠️ 已知待优化：第三方输入法（简体拼音 / 微信等）在「输入法模式下手动切回英文」时，快打仍会漏字（同 `keyCode 229` 组合输入通道问题）。系统 ABC 输入法、以及命令模式下的英文输入不受影响。待后续探索（候选：更彻底的组合事件去重 / 在输入法模式内软锁定英文态），暂按现状发布。
| [x] | 输入不静默丢弃 | 非就绪或写入失败时明确提示并撤回本地预测；重连前丢弃的输入量记日志 | `src/features/terminal/`、`src-tauri/src/ssh/session.rs` |
| [x] | 会话管理 | 创建 / 列出 / 关闭会话，会话生命周期与资源回收。侧栏连接项右键可「复制会话」，弹出预填的新建弹窗（名称加「副本」后缀，重名自动追加序号），保存时由后端把源连接的保险库凭据（密码 / passphrase / 跳板机密码 / RDP 密码）一并复制到新条目，实现基于已有连接快速新建；SSH / RDP 通用 | `src-tauri/src/ssh/session.rs`、`src-tauri/src/config/commands.rs`、`src/features/connections/` |
| [x] | 配置加密存储 | SQLite 存连接元数据；密码 / passphrase / API Key 等敏感字段由主密码（Argon2id + AES-256-GCM）加密后存 `secrets.json`。新装首次打开时设置主密码，派生密钥作为自动解锁令牌存入同目录的 `vault.token`，之后启动静默解锁、无需重复输入。设置「通用 → 主密码」可校验当前密码后改密（换新盐重算密钥、重新加密全部条目），改密成功后若已启用 Git 同步会自动同步一次，把新密文推到远端 | `src-tauri/src/config/vault.rs` |
| [x] | 主密码冲突处理 | Git 同步导入的 `secrets.json` 若与本机主密码不一致，不静默覆盖本地，而是弹窗让用户选择「采用远端（输入远端主密码）/ 保留本地并覆盖远端 / 暂停同步 secrets.json」 | `src-tauri/src/config/vault.rs`、`src/features/vault/` |
| [x] | 基础设置 | 应用级基础设置面板（默认字体、回滚行数、外壳参数） | `src/features/settings/` |
| [x] | 界面语言 | 中英文界面切换，无开关，作为设置「通用 → 语言」的基础设置；语言包外置，切换立即生效 | `src/features/i18n/` + `src/public/locales/en-US.json` |
| [x] | 首次启动引导 | 新装首次打开时先展示一屏语言选择（按系统语言预选，点击卡片即切换界面语言），确认后写入配置目录下的本机标记文件 `onboarding.done`，之后启动不再出现。标记为本机私有、不随 Git 同步，故换机后会重新引导一次。核心，无开关 | `src/features/onboarding/`、`src-tauri/src/config/commands.rs` |
| [x] | 窗口关闭保活 | 关闭窗口（叉号 / Cmd+W）只隐藏到后台、不退出进程，SSH 会话、端口转发、AI 任务等后台能力持续运行。恢复入口：macOS 点击 Dock 图标；Windows 常驻系统托盘（左键单击或右键「显示」呼出窗口，右键「退出」结束进程）。核心，无开关 | `src-tauri/src/lib.rs` |

---

## 2. 可配置功能总览

所有可配置功能遵循统一接口：

```rust
pub trait PluggableModule {
    fn id(&self) -> &'static str;
    fn init(&self, ctx: &ModuleContext) -> Result<(), ModuleError>;
    fn dispose(&self) -> Result<(), ModuleError>;
    fn is_enabled(&self, flags: &FeatureFlags) -> bool;
}
```

关闭时：不初始化、不注册 Tauri command、不加载对应前端 UI、不产生任何后台任务。

---

## 3. 连接与传输

```yaml
features:
  tabs:            true    # 必开项
  split_view:      true    # 必开项
  sftp:            true
  port_forward:    false
  jump_host:       true
  host_key_check:  true    # 开关在「设置 → 连接」
  local_terminal:  true
  session_log:     false
  auto_reconnect:  true    # 开关在「设置 → 连接」
  connection_group:true    # 必开项
  import_export:   true    # 必开项
  rdp:             true    # 必开项
  quick_connect:   true    # 必开项
  sync_input:      true    # 必开项
```

> 标「必开项」的开关恒为开启、界面不暴露，配置里写成 false 也会被强制拉回
> （见 `FeatureFlags::enforce_mandatory` 与前端 `HIDDEN_FLAGS`）。

| 状态 | 功能 | FLAG | 说明 | 代码位置 |
| --- | --- | --- | --- | --- |
| [x] | 多标签 | `tabs` | 单窗口多会话标签页，标签可拖拽排序、重命名、关闭；标签右键可「克隆会话」，用同一连接参数再开一份独立 SSH 会话（仅 SSH，RDP 不产生标签） | `src/features/tabs/` |
| [x] | 分屏 | `split_view` | 同一标签内水平/垂直分屏，多个终端共享标签 | `src/features/split/` |
| [x] | SFTP | `sftp` | 文件浏览、上传、下载、删除、重命名、权限修改；支持文件夹递归传输、拖拽上传、传输进度与中断 | `src/features/sftp/`、`src-tauri/src/features/sftp/` |
| [x] | 端口转发 | `port_forward` | 本地转发 / 远程转发 / 动态转发（SOCKS5），支持启停与状态查看 | `src/features/port-forward/`、`src-tauri/src/features/port_forward/` |
| [x] | 跳板机 | `jump_host` | 通过 ProxyJump 链式连接（支持多级） | `src-tauri/src/ssh/jump.rs` |
| [x] | 主机密钥校验 | `host_key_check` | 建连握手后、认证前比对服务端主机密钥：首次连接弹窗确认指纹（TOFU），密钥变更时以危险样式二次确认，确认后写入配置目录下的 `known_hosts.json`（本机私有、不随 Git 同步）；未确认一律拒绝，抵御中间人攻击。**校验覆盖终端 / SFTP / 端口转发 / 跳板机**：后三者无法弹窗，未确认或已变更时提示「先在终端中连接该主机完成首次信任」。设置「连接 → 主机密钥校验」可关闭开关，开关右侧「已知主机」按钮打开独立弹窗查看 / 移除已知主机；「测试连接」不校验也不写入 | `src-tauri/src/ssh/known_hosts.rs`、`src-tauri/src/ssh/session.rs`、`src/features/ssh/api.ts`、`src/features/settings/` |
| [x] | 本地终端 | `local_terminal` | 在本机 PTY（Unix pty / Windows ConPTY）上打开一个 shell 标签，不经过网络；复用 SSH 的会话表、事件通道与标签 / 分屏体系，读写 / 改尺寸 / 断开走同一组命令。入口：侧栏按钮与快捷键（默认 `Cmd/Ctrl+Shift+T`）。Windows 优先 PowerShell、回退 cmd | `src-tauri/src/ssh/local.rs`、`src-tauri/src/modules/local_terminal/`、`src/features/local-terminal/` |
| [x] | 会话日志 | `session_log` | 按会话落盘完整终端输出，支持开关、保留天数（默认 10 天）、保留条数（默认 20 条）与单文件大小上限（默认 100 KB，超出丢弃最旧内容）；天数 / 条数 / 上限任一置 0 表示该项不限制。预览按「单个文件」截取末尾 10 KB | `src/features/session-log/`、`src-tauri/src/features/session_log/` |
| [x] | 自动重连 | `auto_reconnect` | 断线后指数退避重连，可配置最大次数与间隔 | `src-tauri/src/ssh/session.rs` |
| [x] | 连接分组 | `connection_group` | 连接按文件夹/标签分组，支持折叠与搜索 | `src-tauri/src/config/app_config.rs` |
| [x] | 导入导出 | `import_export` | 导入/导出连接配置（含 `~/.ssh/config` 解析），导出时排除凭据 | `src/features/import-export/`、`src-tauri/src/features/import_export/` |
| [x] | 快捷连接 | `quick_connect` | `user@host:port` 一行直达，无需先保存配置 | `src/features/connections/` |
| [x] | 同步输入 | `sync_input` | 只在一台终端输入，输入同步广播到**同一同步组**内的其它标签。右键标签菜单：`当前添加到组` / `全部添加到组`（加入组后用同色轮廓 + 组序号徽标标识分组）、`开启 / 关闭组内同步输入`（**每组独立开关**，开启后组内才互相广播，成员标签加同色高亮以区别于普通状态）、`移出同步组`、`移除全部组`（解散所有组）。加入组后组内标签自动聚拢、当前标签移到组的最右侧。分组为会话期临时状态、不落库 | `src/features/sync-input/`、`src/features/tabs/`、`src/features/terminal/` |
| [x] | 远程桌面（RDP） | `rdp` | 新建连接时可选 RDP 协议打开 Windows 远程桌面（不实现 RDP 协议本身）。Windows：生成数据目录下的 `.rdp` 并拉起系统自带 `mstsc`；若保险库存有密码，先用 `cmdkey` 写入 Windows 凭据管理器实现免密登录。macOS：系统无自带客户端，生成同一份 `.rdp` 后交给微软「Windows App」（原 Microsoft Remote Desktop，按探测到的应用路径唤起，兼容新旧目录名）打开，pterm 只负责保存会话，认证与凭据由该客户端管理；未安装时弹窗引导并一键跳转 Mac App Store 安装页。连接条目与 SSH 共用一张表，靠 `protocol` 字段区分 | `src-tauri/src/features/rdp/`、`src/features/rdp/` |

---

## 4. 同步（Git）

> 同步策略：**只对接用户自己的远程仓库**，无云同步、不上报任何数据。
> 同步内容为 `config.yaml` / `connections.json` / `snippets.json`，以及 **主密码加密后的 `secrets.json`**
> ——SSH 密码 / passphrase / 跳板机密码、AI API Key、Git 远端密码都在其中，均为密文；换机后输入同一主密码即可解开。
> Git 操作优先走 `git2`（自包含，不依赖系统 git）；仅当 libgit2 明确不支持时回退系统 CLI 并记录原因。

```yaml
features:
  git_sync:            true    # 必开项，界面不暴露开关
  git_sync_scope:      "config"   # 界面恒为 all；兼容 config | snippets | all
  git_conflict_prompt: true
  git_status_badge:    true
  git_commit_template: true
  git_multi_repo:      false
```

| 状态 | 功能 | FLAG | 说明 | 代码位置 |
| --- | --- | --- | --- | --- |
| [x] | Git 同步 | `git_sync` | 总开关。界面只暴露一个「同步」按钮：同步范围跟随「设置 → Git 同步」中的配置，点击后直接执行，`clone/pull/push/commit/status` 全部由后端在进程内完成，不向使用者暴露 Git 细节 | `src-tauri/src/modules/git_sync/repo.rs`、`src/features/git-sync/` |
| [x] | 同步范围 | `git_sync_scope` | 「设置 → Git 同步」中为两档选择：**同步全部** / **同步全部（不包含连接密码、API Key）**，两档数据域均为 `all`，区别在是否带上 `secrets.json`。不在功能开关中暴露 | `src-tauri/src/modules/git_sync/mod.rs`、`src/features/settings/` |
| [x] | 同步敏感字段密文 | `git_sync_secrets` | `secrets.json` 是否随 Git 同步，由上面的「同步范围」档位决定（不单独暴露开关）；关闭后本地与远端互不覆盖，用于主密码冲突时临时搁置 | `src-tauri/src/modules/git_sync/mod.rs` |
| [x] | 冲突处理 | `git_conflict_prompt` | 设置与 `secrets.json` 固定「以远端为准」自动解决；`connections.json` / `snippets.json` 冲突时弹窗让用户按数据域选择「远端覆盖 / 本地覆盖 / 两者保留」（两者保留 = 同名条目保留为两条，重复 id 的本地条目另起新 id），解决后自动导入并推送 | `src-tauri/src/modules/git_sync/repo.rs`、`src-tauri/src/modules/git_sync/mod.rs` |
| [x] | 状态徽标 | `git_status_badge` | 侧栏用大白话显示同步状态：已同步 / 待同步 N 项 / 需处理冲突 / 未配置远端；不暴露 ahead/behind 等 Git 概念（内部开关，界面不暴露） | `src/features/git-sync/` |
| [x] | 提交模板 | `git_commit_template` | 自动生成 commit message，模板可配置（支持 `{date}` `{host}` 等占位符）；内部开关，界面不暴露 | `src-tauri/src/modules/git_sync/mod.rs` |
| [x] | 多仓库 | `git_multi_repo` | 支持配置多个远程仓库，分别或同时同步；内部开关，界面不暴露 | `src-tauri/src/modules/git_sync/repo.rs` |
| [x] | 访问凭据 | — | HTTPS 远端可配置用户名 + 密码 / 访问令牌（如 PAT）；密码存加密保险库，用户名随配置保存。仓库内的 `secrets.json` 是其密文副本。设置「Git 同步 → 访问凭据」每行可点「测试连接」：用表单里的地址 / 用户名 / 密码连一次远端并读引用列表，一次校验地址可达与凭据正确（`git ls-remote` 等价，只读、不碰同步仓库） | `src-tauri/src/modules/git_sync/auth.rs`、`src-tauri/src/modules/git_sync/repo.rs` |
| [x] | CLI 回退 | — | libgit2 不支持的边缘场景（复杂 rebase / LFS / 特殊钩子）检测系统 git 并回退，记录回退原因 | `src-tauri/src/modules/git_sync/fallback.rs` |

---

## 5. AI

> **不内置任何 API Key**，全部由用户配置。所有请求支持超时与取消。

```yaml
features:
  ai_assistant:        false
  ai_streaming:        true    # 必开项，界面不暴露开关
  ai_danger_warning:   true    # 必开项，界面不暴露开关
  ai_context_inject:   true    # 开关在 AI 助手面板标题栏（清理图标左侧），不在功能开关中
```

| 状态 | 功能 | FLAG | 说明 | 代码位置 |
| --- | --- | --- | --- | --- |
| [x] | 总开关 | `ai_assistant` | 关闭时不注册任何 AI command、不加载 AI UI | `src-tauri/src/modules/ai_assistant/mod.rs` |
| [x] | Ask 模式 | — | 面板右侧停靠，输入即提问：回答问题、解释报错并给出建议与指导，命令以代码块列出、不自动执行。每个 shell 代码块带「运行」按钮，用户手动点击后才写入当前终端会话（危险命令仍二次确认）。输入框回车即发送、Shift + 回车换行；输入法组词中（中文候选面板打开）回车只上屏、不发送 | `src-tauri/src/modules/ai_assistant/commands.rs`、`src/features/ai/` |
| [x] | 消息流 | — | 内容区是一条**按 SSH 会话隔离**的对话流：每个终端会话各有一份对话，切标签各自独立、切回仍能看到；提问发出后立即进流并清空输入框，模型的思考 / 流式回答 / Agent 每步命令与结论都作为消息依次落进消息框。对话只存内存、不落库，会话关闭即随会话丢弃；面板右上角按钮可二次确认后清空当前对话 | `src/features/ai/store.ts` |
| [x] | 回答渲染 | — | 回答结束后按 Markdown 渲染一次（流式期间仍是纯文本，避免半截语法闪烁）：代码块（语言标签 + 复制按钮 + 注释 / 字符串 / 数字 / 关键字基础配色；shell 家族或无标注语言的代码块额外带「运行」按钮，手动发送到终端）、行内 code、加粗 / 斜体 / 删除线、有序与无序列表、标题、引用、分隔线、http(s) 链接（点击复制链接，应用未装 opener 插件、不唤起浏览器）。白名单子集，DOM 全部由 textContent 构建、不用 innerHTML，模型输出里的标签只会显示为纯文本 | `src/features/ai/markdown.tsx`、`src/styles/settings.css` |
| [x] | 流式响应 | `ai_streaming` | SSE 流式输出，逐字上屏，支持中途取消 | `src-tauri/src/modules/ai_assistant/client.rs` |
| [x] | Agent 模式 | — | 读取终端输出决定下一步，自动执行命令直到完成：只读命令（ls / cat / df / grep / `systemctl status` / `docker ps` 等）直接写入终端无需确认；涉及删除、修改、改动系统状态的关键操作（rm / mv / chmod / 软件包与服务管理 / `git push` / 容器改动 / 数据库写入等）在消息流里单独成条、需用户授权后才执行；危险命令额外二次确认。授权判定在后端（`danger::classify`），循环在前端，后端不写终端。与 Ask 一样由面板切换，不设独立开关；执行过的命令写入「命令历史」（受 `auxiliary.command_history` 门控） | `src-tauri/src/modules/ai_assistant/agent.rs`、`danger.rs`、`src/features/ai/store.ts` |
| [x] | 多模型 | — | 设置里可添加任意多个自定义模型，每个模型独立配置协议、API 地址、API Key（各存加密保险库）与生成参数（温度 / 输入 token 上限 / 输出 token 上限 / 超时 / 上下文字节数，留空用默认值）；面板底部显式选择用哪个 | `src-tauri/src/modules/ai_assistant/client.rs` |
| [x] | 多协议 | — | 每个模型单独选择协议，协议决定 `base_url` 之后拼接的路径后缀、鉴权头与请求 / 响应格式：OpenAI 兼容（`/chat/completions`，Bearer）、OpenAI Responses（`/responses`，Bearer）、Anthropic Messages（`/messages`，`x-api-key` + `anthropic-version`）。流式与非流式均按协议分别解析。设置界面在协议下方实时提示「实际请求地址」（即会加什么后缀） | `src-tauri/src/modules/ai_assistant/protocol.rs`、`client.rs` |
| [x] | 上下文占比 | — | 输入控件行里（Agent 右侧）一个环形图标，显示「上下文使用率」＝当前窗口总 token ÷ 所选模型的输入 token 上限（本地估算，不发往服务端）；鼠标移上弹出「上下文使用率 / {百分比}% of {输入上限}」，占比升高由绿转黄转红；无会话 / 无模型时收起 | `src/features/ai/store.ts` |
| [x] | 连通性测试 | — | 模型必须先点「测试连通性」验证通过才能保存：用该条目的地址 / Key / 模型名发一次最小请求，一次验到地址可达、Key 有效、模型名存在 | `src-tauri/src/modules/ai_assistant/client.rs`（`test_model`）、`src/features/settings/` |
| [x] | 单模型保存 | — | 每个模型卡片自带「保存到模型列表」，新增或覆盖单条，不必等设置里其它分类一起提交；Key 仍只进加密保险库 | `src-tauri/src/modules/ai_assistant/commands.rs`（`ai_save_model`） |
| [x] | 危险提示 | `ai_danger_warning` | Agent 请求执行的命令命中危险模式时高亮警告并二次确认。**必开项**，界面不暴露开关 | `src-tauri/src/modules/ai_assistant/danger.rs` |
| [x] | 上下文注入 | `ai_context_inject` | 注入当前主机、目录、最近终端输出作为上下文。开关在主界面右侧 **AI 助手面板标题栏**（清理图标左侧的 📎 图标），设置「功能开关」中不再展示；切换后由 `ai_set_context_inject` 单独落盘 | `src-tauri/src/modules/ai_assistant/context.rs`、`src/features/ai/AiPanel.tsx` |

---

## 6. 辅助

> 系统托盘**仅 Windows 提供、恒定常驻，不设功能开关**（设置里不再出现「系统托盘」项，macOS 不支持系统托盘）。

```yaml
features:
  snippets:        true    # 必开项
  global_search:   true    # 必开项
  command_history: true    # 必开项
  quick_panel:     true    # 必开项
  auto_update:     true    # 开关在「设置 → 关于 → 软件更新」
  theme:           true    # 必开项
  shortcuts:       true    # 总开关在「设置 → 快捷键」
  crash_log:       true    # 必开项
```

| 状态 | 功能 | FLAG | 说明 | 代码位置 |
| --- | --- | --- | --- | --- |
| [x] | 命令片段 | `snippets` | 保存常用命令片段，支持变量占位符（`{{name}}`）与快捷插入 | `src-tauri/src/modules/snippets/` |
| [x] | 全局搜索 | `global_search` | 跨连接 / 片段 / 历史 / 设置的统一模糊搜索 | `src/features/search/`、`src-tauri/src/modules/global_search/` |
| [x] | 命令历史 | `command_history` | 记录并检索历史执行的命令，支持去重与频率排序 | `src/features/history/`、`src-tauri/src/modules/command_history/` |
| [x] | 快捷面板 | `quick_panel` | 全局快捷键唤起的命令面板（类 Spotlight）；必开项，设置「功能开关」中不再展示 | `src/features/quick-panel/`、`src-tauri/src/modules/quick_panel/` |
| [x] | 自动更新 | `auto_update` | 开关控制启动后自动从 GitHub Releases 检查新版本（结果按天缓存）并在发现新版时右下角提示；开关在「设置 → 关于 → 软件更新」栏，页内「检查更新」按钮始终可用，关闭开关也能主动手动检查。确认后下载、校验签名并安装，装完重启应用（Tauri updater） | `src-tauri/src/modules/auto_update/`、`src/features/auto-update/` |
| [x] | 主题 | `theme` | 内置亮/暗主题 + 自定义配色，终端配色独立配置 | `src/styles/theme.css`、`src-tauri/src/modules/theme/` |
| [x] | 快捷键 | `shortcuts` | 全部操作可绑定快捷键；设置页每个动作固定一行，左侧只读描述，可逐条启用 / 禁用、改键或清空解绑，附冲突检测 | `src/features/shortcuts/`、`src/features/settings/`、`src-tauri/src/modules/shortcuts/` |
| [x] | 崩溃日志 | `crash_log` | panic hook 捕获崩溃信息写本地日志，设置「关于」页可查看与导出 | `src-tauri/src/utils/mod.rs` + `src-tauri/src/utils/commands.rs` |

---

## 7. 已移除 / 不实现

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 笔记 | **已移除** | 不实现，UI 中不出现任何入口 |

---

## 8. 全局约束（禁止事项）

- ❌ 不引入 Electron，也不把 Node.js 作为**运行时**依赖（Node 仅用于前端构建）。
- ❌ 不内置任何 AI API Key，全部由用户配置。
- ❌ 不做云同步，Git 是唯一同步方式。
- ❌ 不实现「笔记」功能。
- ❌ 无明确理由不引入系统 git CLI 依赖（Git 默认走 `git2`）。
- ⚠️ 危险命令（`rm -rf`、`dd`、`mkfs` 等）必须二次确认。
- ⚠️ 主机密钥校验不得静默放行：首次连接 / 密钥变更必须由用户显式确认后才写入 `known_hosts.json`。
- ⚠️ 所有网络请求（AI、Git）必须支持超时与取消。
- ⚠️ 终端输入输出通过 Tauri event 流式传输，避免轮询。
- ⚠️ 前端不直接访问 SSH 底层，一律经 Tauri command 中介。

---

## 9. 架构原则

1. **模块隔离**：SSH 核心不依赖 Git / AI / 其他模块；可选模块通过事件总线或 Tauri command 注入。
2. **功能开关**：每个非核心模块有 `enabled` 标志；关闭时不初始化、不加载 UI。
3. **配置驱动**：模型参数、同步策略、快捷键等由配置文件定义，代码不硬编码。
4. **无云依赖**：Git 只对接用户自己的远程仓库，不上报任何数据。
5. **前后端分离**：前端只管 UI 与交互；SSH / Git / 文件操作全部由 Rust 执行。
6. **Git 自包含**：优先 `git2` 进程内完成，不依赖系统 Git；边缘场景才回退 CLI 并明确提示。

---

## 10. 开发流程约定

新增功能时依次执行：

1. 在 `src-tauri/src/config/feature_flags.rs` 的 `FeatureFlags` 中注册开关字段与默认值。
2. 在本文件 `FEATURES.md` 对应章节新增一行登记（状态、功能、FLAG、说明、代码位置）。
3. 在 `config.yaml` 示例中补充默认值。
4. 实现 Rust 侧模块并实现 `init()` / `dispose()` / `is_enabled()`。
5. 实现前端 UI，并在设置面板中暴露开关。
6. 为开关的 `false` 分支补充验证：确认不注册 command、不加载 UI、无后台任务。