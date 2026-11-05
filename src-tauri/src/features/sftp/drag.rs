//! 远端条目拖出到系统文件管理器。
//!
//! 系统级拖拽只能携带本地已存在的文件，因此先把远端条目下载到应用缓存，
//! 再交给原生拖拽（macOS 的 NSDraggingSession / Windows 的 OLE 拖放）。
//! 缓存按「会话 + 远端路径 + 大小 + 修改时间」复用，同一文件重复拖出不再下载。

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::feature_flags::module_id;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::commands::EVENT_SFTP_PROGRESS;

/// 原生拖拽结束事件（松手或取消）。`error` 非空表示启动失败。
pub const EVENT_SFTP_DRAG_END: &str = "sftp:drag-end";

/// 拖出缓存目录（位于应用缓存下）。
const CACHE_DIR: &str = "sftp-drag";
/// 缓存保留时长：过期的缓存目录在下次拖出时清理。
const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// 拖拽时跟随鼠标的缩略图。
const DRAG_IMAGE: &[u8] = include_bytes!("../../../icons/icon.png");

/// 把远端条目拖出到系统文件管理器。
///
/// 先下载到缓存（进度走 [`EVENT_SFTP_PROGRESS`]），再启动原生拖拽；
/// 返回写入的字节数。`size` / `modified` 只用于区分缓存版本。
#[tauri::command]
pub async fn sftp_drag_out(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    remote: String,
    name: String,
    size: u64,
    modified: f64,
    transfer_id: String,
) -> AppResult<u64> {
    state.require_module(module_id::SFTP)?;
    let manager = state.sftp.clone();
    let cancel = manager.begin_transfer(&transfer_id);

    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Sftp(format!("无法定位缓存目录：{e}")))?
        .join(CACHE_DIR);
    let dir = cache_root.join(cache_key(&id, &remote, size, modified));
    let target = dir.join(safe_name(&name));

    let job_root = cache_root.clone();
    let job_dir = dir.clone();
    let job_target = target.clone();
    let job_app = app.clone();
    let job_tid = transfer_id.clone();
    let job_manager = manager.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        clean_expired(&job_root);
        prepare(
            &job_app, &job_manager, &id, &remote, &job_dir, &job_target, cancel.as_ref(), &job_tid,
        )
    })
    .await
    .map_err(|e| AppError::Sftp(format!("准备拖出文件异常结束：{e}")))?;
    manager.end_transfer(&transfer_id);
    let bytes = result?;

    launch(&app, target, transfer_id.clone())?;
    Ok(bytes)
}

/// 缓存未命中时下载到 `<目标>.part`，完成后再改名，避免半成品被复用。
fn prepare(
    app: &AppHandle,
    manager: &super::SftpManager,
    id: &str,
    remote: &str,
    dir: &Path,
    target: &Path,
    cancel: &std::sync::atomic::AtomicBool,
    transfer_id: &str,
) -> AppResult<u64> {
    if target.exists() {
        // 命中缓存：直接复用，字节数按缓存内容回报
        return Ok(std::fs::metadata(target).map(|m| m.len()).unwrap_or(0));
    }
    std::fs::create_dir_all(dir)?;
    let part = part_path(target);
    remove_path(&part);

    let local = part.to_string_lossy().to_string();
    let mut on_progress = |transferred: u64, total: u64| {
        let _ = app.emit(
            EVENT_SFTP_PROGRESS,
            serde_json::json!({ "id": transfer_id, "transferred": transferred, "total": total }),
        );
    };
    match manager.download(id, remote, &local, cancel, &mut on_progress) {
        Ok(bytes) => {
            std::fs::rename(&part, target)?;
            Ok(bytes)
        }
        Err(err) => {
            remove_path(&part);
            Err(err)
        }
    }
}

/// 启动原生拖拽。macOS 必须回到主线程；Windows 交给常驻的 OLE 线程。
fn launch(app: &AppHandle, path: PathBuf, transfer_id: String) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        launch_macos(app, path, transfer_id)
    }
    #[cfg(target_os = "windows")]
    {
        launch_windows(app, path, transfer_id)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (app, path, transfer_id);
        Err(AppError::Sftp("当前平台不支持拖出下载".into()))
    }
}

#[cfg(target_os = "macos")]
fn launch_macos(app: &AppHandle, path: PathBuf, transfer_id: String) -> AppResult<()> {
    let window = app.get_webview_window("main").ok_or_else(missing_window)?;
    let app_cb = app.clone();
    let tid_cb = transfer_id;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    app.run_on_main_thread(move || {
        let result = drag::start_drag(
            &window,
            drag::DragItem::Files(vec![path]),
            drag::Image::Raw(DRAG_IMAGE.to_vec()),
            move |outcome, _| {
                let _ = app_cb.emit(
                    EVENT_SFTP_DRAG_END,
                    serde_json::json!({
                        "id": tid_cb,
                        "dropped": matches!(outcome, drag::DragResult::Dropped),
                    }),
                );
            },
            drag::Options::default(),
        )
        .map_err(|e| e.to_string());
        let _ = tx.send(result);
    })
    .map_err(|e| AppError::Sftp(format!("无法在主线程启动拖拽：{e}")))?;

    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(AppError::Sftp(format!("启动系统拖拽失败：{e}"))),
        Err(_) => Err(AppError::Sftp("启动系统拖拽超时".into())),
    }
}

#[cfg(target_os = "windows")]
fn launch_windows(app: &AppHandle, path: PathBuf, transfer_id: String) -> AppResult<()> {
    let window = app.get_webview_window("main").ok_or_else(missing_window)?;
    let app_cb = app.clone();
    // 提交到常驻线程的闭包必须 'static，不能再借用外部 app 引用。
    let app_err = app.clone();
    let tid_cb = transfer_id.clone();
    // DoDragDrop 会一直阻塞到松手，所以异步提交，启动失败再通过事件回报。
    drag_thread::submit(Box::new(move || {
        let result = drag::start_drag(
            &window,
            drag::DragItem::Files(vec![path]),
            drag::Image::Raw(DRAG_IMAGE.to_vec()),
            move |outcome, _| {
                let _ = app_cb.emit(
                    EVENT_SFTP_DRAG_END,
                    serde_json::json!({
                        "id": tid_cb,
                        "dropped": matches!(outcome, drag::DragResult::Dropped),
                    }),
                );
            },
            drag::Options::default(),
        );
        if let Err(err) = result {
            let _ = app_err.emit(
                EVENT_SFTP_DRAG_END,
                serde_json::json!({ "id": transfer_id, "error": format!("启动系统拖拽失败：{err}") }),
            );
        }
    }));
    Ok(())
}

/// Windows：OLE 拖放要求调用线程已初始化 STA。`drag` crate 只在首次调用时
/// `OleInitialize`，因此固定用一条常驻线程执行，避免线程退出后 OLE 失效。
#[cfg(target_os = "windows")]
mod drag_thread {
    use std::sync::mpsc::{channel, Sender};
    use std::sync::OnceLock;

    type Job = Box<dyn FnOnce() + Send + 'static>;

    static SENDER: OnceLock<Sender<Job>> = OnceLock::new();

    pub fn submit(job: Job) {
        let sender = SENDER.get_or_init(|| {
            let (tx, rx) = channel::<Job>();
            std::thread::spawn(move || {
                for job in rx {
                    job();
                }
            });
            tx
        });
        let _ = sender.send(job);
    }
}

fn missing_window() -> AppError {
    AppError::Sftp("找不到主窗口".into())
}

fn cache_key(id: &str, remote: &str, size: u64, modified: f64) -> String {
    let mut hasher = DefaultHasher::new();
    id.hash(&mut hasher);
    remote.hash(&mut hasher);
    size.hash(&mut hasher);
    modified.to_bits().hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// 只保留文件名，避免远端名称里带分隔符导致缓存写到目录外。
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if base.is_empty() || base == "." || base == ".." {
        "download".into()
    } else {
        base.to_string()
    }
}

fn part_path(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    target.with_file_name(format!("{name}.part"))
}

fn remove_path(path: &Path) {
    if path.is_dir() {
        let _ = std::fs::remove_dir_all(path);
    } else if path.exists() {
        let _ = std::fs::remove_file(path);
    }
}

/// 清理超过 [`CACHE_TTL`] 的拖出缓存。
fn clean_expired(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::now());
        let expired = SystemTime::now()
            .duration_since(modified)
            .map(|age| age > CACHE_TTL)
            .unwrap_or(false);
        if expired {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}
