//! 命令历史对外命令。
//!
//! 统一门控：命令历史关闭时全部命令返回 `ModuleDisabled`。
//! 去重与频率统计在存储层用一条聚合查询完成（见 `config::store::Store::list_history`），
//! 命令层只负责参数默认值与门控。

use tauri::State;

use crate::config::feature_flags::module_id;
use crate::config::store::{HistoryEntry, HistoryOrder};
use crate::error::AppResult;
use crate::state::AppState;

/// 检索历史命令。
///
/// - `query`：按命令子串过滤，空表示不筛选；
/// - `dedupe`：为 true 时按命令去重，只保留最近一次执行的那条记录，
///   并在 `uses` 中返回该命令的累计执行次数（缺省为 true）；
/// - `order`：`recent` 按最近执行倒序，`frequent` 按使用频率倒序（缺省为 `recent`）。
#[tauri::command]
pub fn list_history(
    state: State<'_, AppState>,
    limit: Option<u32>,
    query: Option<String>,
    dedupe: Option<bool>,
    order: Option<HistoryOrder>,
) -> AppResult<Vec<HistoryEntry>> {
    state.require_module(module_id::COMMAND_HISTORY)?;
    state.store.list_history(
        limit.unwrap_or(200),
        query.as_deref(),
        dedupe.unwrap_or(true),
        order.unwrap_or_default(),
    )
}

/// 清空全部命令历史。
#[tauri::command]
pub fn clear_history(state: State<'_, AppState>) -> AppResult<()> {
    state.require_module(module_id::COMMAND_HISTORY)?;
    state.store.clear_history()
}

/// 追加一条命令历史。由终端在用户执行命令后调用。
#[tauri::command]
pub fn push_history(
    state: State<'_, AppState>,
    command: String,
    host: String,
    session_id: String,
) -> AppResult<()> {
    state.require_module(module_id::COMMAND_HISTORY)?;
    state.store.push_history(&command, &host, &session_id)
}