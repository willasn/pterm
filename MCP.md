# MCP 服务开发记录

> 给外部 AI（TRAE / CodeBuddy 等支持 MCP 的客户端）使用的本地 MCP 服务。
> AI 只表达「连哪台机器、执行什么命令」，凭据始终留在本机加密保险库，
> 由 pterm 代为完成 SSH 认证——密码 / 私钥不会进入模型上下文。

**当前状态：最小闭环（阶段一）已完成，默认关闭。**

---

## 1. 范围与目标

阶段一只做一条可验证的闭环：

`列出连接 → 建立连接（pterm 代认证）→ 执行一条命令 → 读取输出 → 断开`

不在阶段一范围内：文件上传下载、交互式全屏程序、命令级审批弹窗、stdio 传输、
设置界面开关（先通过 `config.yaml` 启用）。这些能力已纳入后续阶段，详见
[第 9 节路线图](#9-进度与路线图)。

---

## 2. 架构

```
外部 AI 客户端
   │  POST http://127.0.0.1:39217/mcp   （Bearer 令牌，JSON-RPC 2.0，无状态）
   ▼
modules/mcp/server.rs   —— 本地 HTTP 传输、令牌校验
   │
modules/mcp/rpc.rs      —— initialize / tools/list / tools/call 分发
   │
modules/mcp/tools.rs    —— 5 个工具的实现
   │
ssh::session::SessionManager（核心，不可关闭）
   │  -- 复用已有的认证、known_hosts、跳板机、会话表
   ▼
远端 SSH 主机
```

关键决策：

- **复用现有 SSH 核心**，不为 MCP 单独实现一条连接链路。因此主机密钥校验、
  跳板机、键盘交互认证、断线重连的行为与界面完全一致。
- **无状态传输**：不实现 `Mcp-Session-Id` 和服务端 SSE 推送（`GET /mcp` 返回 405），
  降低实现与调试成本；客户端都支持退回 POST。
- **凭证不落工具层**：工具参数只有连接别名与会话 id，密码 / passphrase 由
  `ssh::auth` 从保险库按 `connection_id` 读取。

代码位置：

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/modules/mcp/mod.rs` | 可插拔模块：启停 HTTP 服务 |
| `src-tauri/src/modules/mcp/server.rs` | 绑定 127.0.0.1、令牌、`/mcp` 与 `/health` |
| `src-tauri/src/modules/mcp/rpc.rs` | JSON-RPC 分发与服务端 `instructions` |
| `src-tauri/src/modules/mcp/tools.rs` | 5 个工具、输出截断、超时处理 |

开关：`FeatureFlags.mcp`（`enabled` / `port`），模块标识 `mcp`，默认 `enabled = false`。

---

## 3. 启用与配置

**方式一（推荐）：设置 → MCP 服务**

打开开关后点「保存」即可启动服务（模块会在保存时立即初始化 / 销毁，无需重启）。
同一页可以直接看到服务状态、端点地址、访问令牌，并用「复制 JSON 配置」一键拿到
可直接粘贴到客户端的配置内容。

**方式二：编辑配置文件**

`config.yaml`（macOS：`~/Library/Application Support/pterm/config.yaml`）的
`features` 下增加：

```yaml
features:
  mcp:
    enabled: true
    port: 39217   # 仅绑定 127.0.0.1；改端口后需重启应用才生效
```

改端口需要重启 pterm（模块初始化时绑定端口，运行期不重新绑定）。

首次启动会在配置目录生成 `mcp.token`（权限 `0600`，不随 Git 同步）：

- macOS：`~/Library/Application Support/pterm/mcp.token`
- Windows：`%APPDATA%\pterm\mcp.token`
- Linux：`~/.config/pterm/mcp.token`

令牌只用于本机回环地址，不要在截图、日志或仓库里泄露。

---

## 4. 客户端接入

### TRAE

项目级 `.trae/mcp.json`（或 IDE 设置里的 MCP 面板）配置一个 HTTP 类型服务：

```json
{
  "mcpServers": {
    "pterm": {
      "type": "http",
      "url": "http://127.0.0.1:39217/mcp",
      "headers": {
        "Authorization": "Bearer <mcp.token 的内容>"
      }
    }
  }
}
```

### CodeBuddy

```bash
codebuddy mcp add-json --scope project pterm \
  '{"type":"http","url":"http://127.0.0.1:39217/mcp","headers":{"Authorization":"Bearer <mcp.token 的内容>"}}'
```

> 各客户端对 HTTP 类型的字段名（`type` / `url` / `headers`）可能略有差异，
> 以对应版本文档为准。`command` 类 stdio 配置不适用于阶段一。

---

## 5. 工具清单

| 工具 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `list_connections` | 无 | `{connections:[{id,name,host,port,username,group,auth_kind,has_saved_password,has_saved_passphrase,via_jump_host}]}` | 只返回 SSH 连接，绝不含凭据 |
| `connect` | `alias`（name 或 id）、`timeout_ms?` | `{session_id,name,host,port,username}` | 等待认证完成才返回；主机密钥一律严格校验 |
| `exec` | `session_id`、`command`、`timeout_ms?`（默认 30s，上限 120s） | `{session_id,exit_code,output,truncated}` | 单条命令，返回合并输出；会话必须停在普通 shell |
| `read_output` | `session_id`、`max_bytes?`（默认 16KB，上限 64KB） | `{session_id,state,output}` | 读最近终端输出，用于长任务或 exec 超时后续看 |
| `disconnect` | `session_id` | `{session_id,closed:true}` | 释放远端会话 |

`exec` 的实现方式：向终端写入一段带唯一标记的命令（`printf` 打开始/结束标记），
轮询会话的最近输出环形缓冲，用标记切出命令输出并解析 `$?`。因此：

- 输出缓冲上限约 32 KB（超出时保留末尾，`truncated=true`）；
- 命令里的多行、管道、重定向都正常；
- 不适合 `vim` / `top` / `less` 这类全屏交互程序。

---

## 6. 错误码（工具结果 `isError: true` 时的文本前缀）

| 错误码 | 含义 | AI 应如何处理 |
| --- | --- | --- |
| `CONNECTION_NOT_FOUND` | 没有匹配的连接别名 | 重新 `list_connections`，不要猜主机 |
| `HOST_KEY_UNTRUSTED` | 主机指纹未在 pterm 中信任 | 停止，请用户在界面手动连接一次 |
| `AUTH_FAILED` | 保险库中没有可用凭据或凭据被拒 | 停止，请用户检查连接保存的密码 / 私钥 |
| `CONNECT_TIMEOUT` | 认证未在超时内完成（可能需要验证码 / 二次确认） | 停止，请用户先在界面登录一次 |
| `EXEC_TIMEOUT` | 命令未在超时内结束 | 不要重复执行，用 `read_output` 继续查看 |
| `SESSION_NOT_FOUND` / `SESSION_NOT_READY` | 会话不存在或未就绪 | 重新 `connect` |
| `SESSION_CLOSED` | 会话已断开 | 报告用户，不要自动重连 |
| `INVALID_ARGUMENT` | 参数缺失或非法 | 修正参数后重试一次 |

`rpc.rs` 的 `instructions` 已把这些约定写给客户端，模型通常会自动遵循。

> 后续阶段还会新增：`CONNECTION_NOT_ALLOWED`（阶段二连接白名单）、
> `POLICY_DENIED` / `RATE_LIMITED`（阶段四策略与限流）、
> `TOO_MANY_SESSIONS` / `TOO_MANY_JOBS`（阶段三并发上限）、
> `FORWARD_CONFLICT`（阶段五端口转发）。届时同步更新本表与 `instructions`。

---

## 7. 安全边界

- 只监听 `127.0.0.1`，不对外网暴露；默认关闭，需显式开启。
- 所有 `/mcp` 请求必须携带 `Authorization: Bearer <token>`（或 `X-Pterm-Token`）。
- 工具层拿不到任何明文凭据；认证全部在 pterm 内部完成。
- 主机密钥严格校验（`HostKeyPolicy::Strict`），MCP **不接受静默信任新主机**。
- 每次 `exec` / `disconnect` 写一条 `log::info` 审计日志（会话 id + 命令，不含输出）。
- 阶段一**没有命令级拦截**：等价于给客户端一个受限 shell。请在可信客户端使用，
  并优先使用低权限账号。

---

## 8. 已知限制

1. 会话由 MCP 创建，**不会出现在 pterm 的标签页里**（后台会话，界面无感知）。
2. 键盘交互认证若需要人工输入，`connect` 会在 25 秒后超时并取消挂起提示；
   需要先在界面完成一次登录。
3. 输出缓冲约 32 KB，长输出只保留末尾。
4. 客户端侧可能有更短的 MCP 工具超时（如 CodeBuddy 的 `MCP_TOOL_TIMEOUT`），
   长命令建议调大客户端超时或改用 `read_output` 轮询。
5. stdio 传输未实现：Tauri GUI 进程不能作为别的客户端的 stdio 子进程，
   需要先把 SSH 核心与 `AppHandle` 解耦。
6. 端口目前只能在 `config.yaml` 里改（改完重启生效）；设置界面只展示，不提供编辑。

---

## 9. 进度与路线图

路线图按「设置运维 → 会话执行 → 策略审计 → 文件传输 → 传输形态」推进，
每阶段都保持向后兼容：新增能力以可选参数 / 新工具的形式叠加，不破坏阶段一的 5 个工具契约。

已完成（阶段一）：

- [x] 功能开关 `features.mcp`（默认关闭）与模块注册
- [x] 本地 Streamable HTTP 端点 + 令牌鉴权（`mcp.token`，0600）
- [x] 5 个工具：`list_connections` / `connect` / `exec` / `read_output` / `disconnect`
- [x] 复用现有 SSH 核心（认证、known_hosts、跳板机、会话表）
- [x] 稳定的错误码 + 服务端 `instructions` 行为约束
- [x] 设置界面「MCP 服务」：开关、运行状态、端点、令牌复制、一键复制客户端 JSON 配置
- [x] 单元测试：工具 schema 完整性、开关默认关闭、输出截断 UTF-8 安全

### 9.1 阶段二：设置与运维完善

目标：把阶段一「只能改配置文件」的部分收进界面，并让服务可用性可控。
全部属于 `modules/mcp/` 与设置页，不改变工具契约。

| 功能点 | 说明 | 备注 |
| --- | --- | --- |
| 端口在线编辑 | 设置页直接修改端口，保存后卸载并重新绑定监听，无需重启应用 | 需把 `server::start` 拆成可重启的句柄；端口占用时回滚旧端口并提示 |
| 端口占用自动降级 | 首选端口被占用时按 +1 递增尝试，成功后写回配置并在界面提示实际端口 | 需同步刷新「复制 JSON 配置」里的 URL |
| 重置访问令牌 | 一键生成新 `mcp.token`（仍 0600），旧令牌立即失效，界面提示重新粘贴客户端配置 | 删除文件后重启的老办法废弃 |
| 多客户端令牌 | 按客户端名生成多枚令牌，可单独命名 / 查看创建时间 / 吊销；`mcp.token` 保留为主令牌 | 令牌存配置目录 `mcp.tokens.json`，不随 Git 同步 |
| 连接白名单 | 在设置页勾选允许 MCP 使用的连接；`list_connections` 只返回白名单内的条目，`connect` 越界返回 `CONNECTION_NOT_ALLOWED` | 默认全选以保持兼容；白名单是后续命令策略的基础 |
| 运行状态面板 | 展示监听状态、实际端口、活跃 MCP 会话数、累计调用次数、最近一次错误（时间 + 错误码） | 状态由模块内存计数提供，不落盘 |
| 客户端配置导出 | 「复制 JSON 配置」同时给出 HTTP 与（阶段六之后的）stdio 两种片段，支持选择是否内联令牌 | 不内联时提示用户自行填写 |
| 联通自检 | 界面内执行一次 `initialize` + `tools/list`，校验令牌与端点是否可用 | 仅本机调用，结果只展示成功/失败 |

### 9.2 阶段三：会话与执行能力

目标：让长任务、多会话和后台会话可见可控，减少对客户端超时的依赖。

| 功能点 | 说明 | 备注 |
| --- | --- | --- |
| `list_sessions` | 返回 MCP 创建的后台会话：`session_id`、连接别名、创建时间、空闲时长、状态、当前任务 | 为「界面接管后台会话」做铺垫 |
| 会话与界面联动 | 设置页 / 主界面能看到 MCP 后台会话，可选择「接管为标签页」或强制关闭 | 需要在 `SessionManager` 上暴露 MCP 会话标记，避免与用户标签页冲突 |
| 长任务模型 | `exec` 支持 `async: true`，立即返回 `job_id`；新增 `get_job`（增量输出 + 状态）、`wait_job`（带超时）、`cancel_job` | 保留现有同步语义作为默认，避免破坏阶段一客户端 |
| 增量输出 | `get_job` / `read_output` 支持 `cursor` 或 `offset`，只回传上次之后的新增内容，降低重复传输 | 输出仍受 32 KB 上限约束，超出时给出 `dropped_bytes` |
| 空闲回收 | MCP 会话可配置空闲超时（默认 30 分钟）自动断开；长任务运行中不回收 | 超时时间在设置页可调 |
| 并发上限 | 限制同时存在的 MCP 会话数与每会话并发任务数，超出返回 `TOO_MANY_SESSIONS` / `TOO_MANY_JOBS` | 与界面共享 `SessionManager` 配额 |
| `exec` 参数增强 | 支持 `cwd`、`env`、`shell`（bash/sh）参数，不再要求调用方手写 `cd` 前缀 | 通过命令前缀注入，需转义 |
| 标记冲突加固 | 结束标记改为随机 nonce，并校验标记行独占一行，降低命令输出误匹配概率 | 修复阶段一已知的边界情况 |
| 交互式输入 | `send_input`（向当前会话写入原始字节）与 `interrupt`（发送 Ctrl-C），用于配合 `read_output` 操作菜单类程序 | 明确不支持全屏编辑器；默认不开启，需设置页显式允许 |
| 会话断线处理 | 记录断开原因；可选「自动重连」开关，重连后返回新 `session_id` 与原会话的映射 | 自动重连默认关闭，避免掩盖网络问题 |

### 9.3 阶段四：策略、审批与审计

目标：从「受限 shell」升级为可治理的执行通道，满足多人 / 生产环境使用。

| 功能点 | 说明 | 备注 |
| --- | --- | --- |
| 命令策略引擎 | 支持三类规则：危险命令黑名单（正则，如 `rm -rf /`、`mkfs`、`shutdown`）、只读模式（仅允许查询类命令白名单）、主机白名单 | 规则存 `config.yaml` 的 `features.mcp.policy`，设置页可视化编辑 |
| 只读模式 | 开关打开后只放行白名单命令，其余返回 `POLICY_DENIED`；与连接白名单叠加生效 | 面向「让 AI 查问题但不改机器」的常见诉求 |
| 人工审批 | 命中策略的命令通过桌面通知 / 弹窗请求确认，选项：拒绝 / 仅本次允许 / 本会话允许 / 永久允许 | 审批在 `tools::exec` 前置钩子中阻塞，超时默认拒绝 |
| 审批规则沉淀 | 「永久允许」写入规则列表，可在设置页查看和撤销；记录审批来源（命令 / 客户端） | 避免弹窗泛滥 |
| 审计日志落盘 | JSON Lines 写入配置目录 `mcp-audit.log`：时间、令牌名、会话、连接、命令、退出码、耗时、审批结果，**不含输出** | 按大小滚动、保留份数可配置；设置页提供打开目录 / 清空 |
| 频率限制 | 每令牌每分钟调用上限、单会话命令并发上限，超限返回 `RATE_LIMITED` | 防止客户端死循环刷命令 |
| 权限作用域 | 令牌分级：`read`（只读工具）/ `exec`（执行）/ `files`（文件能力）/ `admin`（全部）；工具按作用域过滤 `tools/list` | 阶段二多令牌的延伸，一令牌一作用域 |
| 危险操作二次确认 | 对 `delete_file`、`close_forward`、`cancel_job` 等破坏性工具统一走审批通道 | 与文件 / 转发阶段一起启用 |
| 合规开关 | 「禁止 MCP 访问保密连接」「禁止 MCP 读取凭据」等硬开关，任何策略都不能绕过 | 默认关闭限制以保持可用 |

### 9.4 阶段五：文件与传输能力

目标：把 pterm 已有的 SFTP 与端口转发能力暴露给 AI，复用现有实现与权限模型。

| 功能点 | 说明 | 备注 |
| --- | --- | --- |
| SFTP 目录浏览 | `list_dir`（路径、类型、大小、mtime、权限）、`stat` | 复用 `features/sftp`，走同一套会话与认证 |
| 文件读取 | `read_file`：文本按行区间返回，二进制转 base64；单次上限约 256 KB，超出返回 `truncated` | 需要设置页可调上限 |
| 文件写入 | `write_file`：文本或 base64，支持 `append` / `overwrite`，写入前校验大小上限 | 默认关闭，属破坏性操作 |
| 上传 / 下载 | `upload` / `download`：本地路径限定在工作区白名单目录内，禁止任意路径 | 与「敏感信息隔离」规则一致，禁止上传凭据文件 |
| 文件管理 | `mkdir` / `rename` / `delete`（默认禁用，需审批） | 删除操作必须走阶段四审批 |
| 断点续传 | 大文件传输返回 `job_id`，用 `get_job` 查询进度，支持 `cancel_job` | 依赖阶段三的任务模型 |
| 端口转发 | `open_forward` / `list_forwards` / `close_forward`，复用 `features/port_forward`（本地 / 远程 / 动态） | 端口占用与界面冲突时返回 `FORWARD_CONFLICT` |
| 本地命令 | 复用 `ssh/local.rs` 的本地终端能力，提供 `exec_local`（默认关闭，仅工作区目录内） | 需单独策略，不与 SSH 命令策略混用 |

### 9.5 阶段六：传输形态与生态

目标：覆盖只支持 stdio 的客户端，并把连接信息、命令模板沉淀为 MCP 资源与提示。

| 功能点 | 说明 | 备注 |
| --- | --- | --- |
| stdio 传输 | 可执行文件新增子命令 `pterm mcp-stdio`，以 headless 方式加载配置与保险库，只走 stdio 不启 GUI | 需先解耦 SSH 核心与 `AppHandle`，是全表最重的改造 |
| stdio 与 GUI 共存 | 同一台机器上 GUI 已运行时，stdio 进程通过本地令牌复用已有会话表（或独立建连并声明） | 明确二者会话是否共享，避免重复登录 |
| 有状态传输 | 支持 `Mcp-Session-Id` 与 `GET /mcp` 的 SSE 流，用于服务端推送长任务进度、审批事件 | 阶段一曾主动放弃，能力补齐后可作为可选模式 |
| MCP resources | 把连接列表、snippets、常用命令模板暴露为 resources，客户端可直接引用而无需工具调用 | 只读，不含凭据 |
| MCP prompts | 内置场景模板（排障、日志巡检、部署检查），客户端可直接选用 | 与 resources 同源配置 |
| snippets 工具 | `list_snippets` / `run_snippet`（按名称执行已保存命令模板，参数占位符替换） | 复用现有 snippets 存储 |
| 多客户端隔离 | 按令牌区分客户端，会话与任务归属可见，支持单客户端整体断开 | 配合阶段二多令牌、阶段四作用域 |
| 文档与示例 | 补充 Claude Desktop / Cursor / VS Code 等客户端的接入示例与排障手册 | 只在本文档内增补，不新增独立文件 |

### 9.6 阶段排期与依赖

| 阶段 | 主题 | 主要依赖 | 交付判据 |
| --- | --- | --- | --- |
| 二 | 设置与运维 | 无 | 端口 / 令牌 / 白名单均可在界面完成，无需改 YAML |
| 三 | 会话与执行 | 阶段二的白名单 | 30 分钟以上的长任务可被可靠跟踪与取消 |
| 四 | 策略与审计 | 阶段三的任务钩子 | 危险命令默认被拦截，且每次执行都有落盘记录 |
| 五 | 文件与传输 | 阶段三任务模型、阶段四审批 | AI 可完成「查日志 → 改配置 → 上传」闭环且受策略约束 |
| 六 | 传输与生态 | 阶段一～五稳定 | 只支持 stdio 的客户端可零配置接入 |

> 阶段之间不要求严格串行：阶段二的设置项可先行，阶段六的 stdio 解耦工作量大，
> 建议在阶段的空档并行推进。

---

## 10. 本地验证

启用后重启 pterm，然后：

```bash
TOKEN=$(cat ~/Library/Application\ Support/pterm/mcp.token)

# 1. 健康检查
curl -s http://127.0.0.1:39217/health

# 2. 初始化
curl -s http://127.0.0.1:39217/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 3. 工具清单
curl -s http://127.0.0.1:39217/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 4. 列出连接
curl -s http://127.0.0.1:39217/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_connections","arguments":{}}}'
```

未带令牌应返回 `401`。
