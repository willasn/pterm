use std::panic;
use std::path::PathBuf;

use crate::error::AppResult;

pub mod commands;

/// 应用运行期使用的目录集合。所有目录在启动时确保存在。
#[derive(Debug, Clone)]
pub struct Paths {
    /// 配置目录（config.yaml 所在地）
    pub config_dir: PathBuf,
    /// 数据目录（SQLite 所在地）
    pub data_dir: PathBuf,
    /// 会话日志目录
    pub log_dir: PathBuf,
    /// 崩溃日志文件
    pub crash_log: PathBuf,
}

impl Paths {
    pub fn resolve() -> AppResult<Self> {
        let base = dirs::config_dir()
            .ok_or_else(|| crate::error::AppError::Config("无法定位系统配置目录".into()))?
            .join("pterm");
        let data = dirs::data_dir()
            .ok_or_else(|| crate::error::AppError::Config("无法定位系统数据目录".into()))?
            .join("pterm");

        let paths = Paths {
            config_dir: base.clone(),
            data_dir: data.clone(),
            log_dir: data.join("sessions"),
            crash_log: base.join("crash.log"),
        };
        paths.ensure()?;
        Ok(paths)
    }

    fn ensure(&self) -> AppResult<()> {
        for dir in [&self.config_dir, &self.data_dir, &self.log_dir] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(())
    }

    pub fn config_file(&self) -> PathBuf {
        self.config_dir.join("config.yaml")
    }

    pub fn database_file(&self) -> PathBuf {
        self.data_dir.join("pterm.db")
    }
}

/// 初始化日志。`crash_log` 开关关闭时不写崩溃文件，但 panic 依旧打印到 stderr。
pub fn init_logging(enable_crash_log: bool, crash_log_path: PathBuf) {
    let _ = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("pterm_lib=info,warn"),
    )
    .try_init();

    let default_hook = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "未知 panic".to_string());
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "未知位置".to_string());
        let line = format!(
            "[{}] panic at {} :: {}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            location,
            payload
        );

        log::error!("应用崩溃：{}", line.trim_end());
        if enable_crash_log {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&crash_log_path)
            {
                let _ = f.write_all(line.as_bytes());
            }
        }
        default_hook(info);
    }));
}