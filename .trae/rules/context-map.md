---
alwaysApply: true
---

# 上下文最小化：按需读文件

项目为 Rust(Tauri 2.x) + 原生前端。任何任务开始前必须遵守以下流程，最小化文件读取、降低上下文与限流消耗：

1. 先读 README.md 的「目录结构」段，确认目标改动落在哪个模块。
2. 功能点与开关对应关系查 FEATURES.md；开关统一注册在 src-tauri/src/config/feature_flags.rs。
3. 定位代码一律优先用 Grep / Glob / SearchCodebase 按符号名搜索，禁止一次性 Read 整个目录。
4. 只读与本次改动直接相关的文件：
   - 改可插拔模块：只读 src-tauri/src/modules/<模块>/ 下文件 + 其 command 注册处（lib.rs 的 invoke_handler / 该模块 commands.rs）。
   - 改 SSH 核心：只读 src-tauri/src/ssh/ 下相关文件。
   - 改前端：只读 src/js/<对应>.js 及可能涉及的 styles/。
5. 仅在新增功能时更新 FEATURES.md 登记，结构变动时更新 README.md 目录结构。