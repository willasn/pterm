//! 命令片段对外命令。
//!
//! 统一门控：片段关闭时全部命令返回 `ModuleDisabled`。
//! 变量提取与替换都在模块层（`super::extract_variables` / `super::render`），
//! 命令层只负责补全字段与落库。

use std::collections::HashMap;

use tauri::State;

use crate::config::feature_flags::module_id;
use crate::config::store::SnippetRecord;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::{extract_variables, render};

/// 列出全部片段，按分组与名称排序。
#[tauri::command]
pub fn snippet_list(state: State<'_, AppState>) -> AppResult<Vec<SnippetRecord>> {
    state.require_module(module_id::SNIPPETS)?;
    state.store.list_snippets()
}

/// 新建或更新片段。`id` 为空表示新建；`variables` 由内容自动重算，忽略传入值。
#[tauri::command]
pub fn snippet_save(
    state: State<'_, AppState>,
    snippet: SnippetRecord,
) -> AppResult<SnippetRecord> {
    state.require_module(module_id::SNIPPETS)?;

    let mut record = snippet;
    record.content = record.content.trim_end().to_string();
    if record.content.trim().is_empty() {
        return Err(AppError::Config("片段内容不能为空".into()));
    }
    record.name = normalize_name(&record.name, &record.content);
    record.id = if record.id.trim().is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        record.id.trim().to_string()
    };
    record.group_name = record
        .group_name
        .map(|g| g.trim().to_string())
        .filter(|g| !g.is_empty());
    record.variables = extract_variables(&record.content);
    record.updated_at = chrono::Local::now().to_rfc3339();

    state.store.upsert_snippet(&record)?;
    Ok(record)
}

/// 删除片段。
#[tauri::command]
pub fn snippet_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.require_module(module_id::SNIPPETS)?;
    state.store.delete_snippet(&id)
}

/// 渲染片段内容：把 `{{name}}` 替换为 `values` 中的值。
/// 未提供值的占位符原样保留，便于用户在终端里二次编辑。
#[tauri::command]
pub fn snippet_render(
    state: State<'_, AppState>,
    content: String,
    values: HashMap<String, String>,
) -> AppResult<String> {
    state.require_module(module_id::SNIPPETS)?;
    Ok(render(&content, &values))
}

/// 名称为空时用内容首行，仍为空则回退为「未命名片段」。
fn normalize_name(name: &str, content: &str) -> String {
    let trimmed = name.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    match content.lines().map(str::trim).find(|l| !l.is_empty()) {
        Some(line) => line.chars().take(40).collect(),
        None => "未命名片段".to_string(),
    }
}