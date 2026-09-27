//! SFTP 对外命令。
//!
//! 全部文件操作都会阻塞在网络 I/O 上，因此统一放进 `spawn_blocking`，
//! 避免占住 Tauri 的异步运行时线程。

use tauri::State;

use crate::config::feature_flags::module_id;
use crate::error::{AppError, AppResult};
use crate::ssh::types::ConnectParams;
use crate::state::AppState;

use super::{SftpInfo, SftpListing};

/// 建立独立的 SFTP 连接（不影响终端会话）。
#[tauri::command]
pub async fn sftp_connect(
    state: State<'_, AppState>,
    params: ConnectParams,
) -> AppResult<SftpInfo> {
    state.require_module(module_id::SFTP)?;
    // 跳板机是可关闭的功能点，关闭时不允许使用
    if params.jump.is_some() && !state.flags().connection.jump_host {
        return Err(AppError::ModuleDisabled("跳板机（ProxyJump）".into()));
    }
    let manager = state.sftp.clone();
    spawn(move || manager.connect(params), "建立 SFTP 会话").await
}

/// 关闭 SFTP 连接。
#[tauri::command]
pub async fn sftp_disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.require_module(module_id::SFTP)?;
    let manager = state.sftp.clone();
    spawn(move || manager.disconnect(&id), "关闭 SFTP 会话").await
}

/// 所有活跃 SFTP 连接快照。
#[tauri::command]
pub fn sftp_sessions(state: State<'_, AppState>) -> AppResult<Vec<SftpInfo>> {
    state.require_module(module_id::SFTP)?;
    Ok(state.sftp.list_sessions())
}

/// 浏览远端目录。`path` 为空时使用登录后的家目录。
#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> AppResult<SftpListing> {
    state.require_module(module_id::SFTP)?;
    let manager = state.sftp.clone();
    spawn(move || manager.list(&id, &path), "浏览远端目录").await
}

/// 下载远端文件到本地路径，返回字节数。
#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    id: String,
    remote: String,
    local: String,
) -> AppResult<u64> {
    state.require_module(module_id::SFTP)?;
    let manager = state.sftp.clone();
    spawn(
        move || manager.download(&id, &remote, &local),
        "下载远端文件",
    )
    .await
}

/// 上传本地文件到远端路径，返回字节数。
#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    id: String,
    local: String,
    remote: String,
) -> AppResult<u64> {
    state.require_module(module_id::SFTP)?;
    let manager = state.sftp.clone();
    spawn(move || manager.upload(&id, &local, &remote), "上传本地文件").await
}

/// 删除远端文件或空目录。
#[tauri::command]
pub async fn sftp_delete(state: State<'_, AppState>, id: String, path: String) -> AppResult<()> {
    state.require_module(module_id::SFTP)?;
    let manager = state.sftp.clone();
    spawn(move || manager.delete(&id, &path), "删除远端条目").await
}

/// 重命名 / 移动远端条目。
#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    id: String,
    from: String,
    to: String,
) -> AppResult<()> {
    state.require_module(module_id::SFTP)?;
    let manager = state.sftp.clone();
    spawn(move || manager.rename(&id, &from, &to), "重命名远端条目").await
}

/// 修改远端条目权限位（八进制，仅取低 12 位）。
#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    id: String,
    path: String,
    mode: u32,
) -> AppResult<()> {
    state.require_module(module_id::SFTP)?;
    let manager = state.sftp.clone();
    spawn(move || manager.chmod(&id, &path, mode), "修改远端权限").await
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/// 把阻塞任务搬到专用线程池，并把 panic / 取消统一转成 SFTP 错误。
async fn spawn<T: Send + 'static>(
    job: impl FnOnce() -> AppResult<T> + Send + 'static,
    label: &str,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| AppError::Sftp(format!("{label}任务异常结束：{e}")))?
}