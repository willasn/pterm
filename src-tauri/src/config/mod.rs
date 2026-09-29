pub mod app_config;
pub mod commands;
pub mod feature_flags;
pub mod store;
pub mod vault;

use std::path::PathBuf;

use parking_lot::RwLock;

use crate::config::app_config::AppConfig;
use crate::config::feature_flags::FeatureFlags;
use crate::error::AppResult;

/// 配置管理器：持有 `config.yaml` 的内存副本与落盘路径。
///
/// 所有读写都经过这里，避免多处直接操作文件导致状态不一致。
pub struct ConfigManager {
    path: PathBuf,
    inner: RwLock<AppConfig>,
}

impl ConfigManager {
    pub fn load(path: PathBuf) -> AppResult<Self> {
        let cfg = AppConfig::load(&path)?;
        Ok(Self {
            path,
            inner: RwLock::new(cfg),
        })
    }

    pub fn snapshot(&self) -> AppConfig {
        self.inner.read().clone()
    }

    pub fn flags(&self) -> FeatureFlags {
        self.inner.read().features.clone()
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    /// 用闭包修改配置并立即落盘。返回值是闭包的返回值。
    pub fn update<T>(&self, f: impl FnOnce(&mut AppConfig) -> T) -> AppResult<T> {
        let (out, snapshot) = {
            let mut guard = self.inner.write();
            let out = f(&mut guard);
            (out, guard.clone())
        };
        snapshot.save(&self.path)?;
        Ok(out)
    }

    /// 整体替换配置（设置界面保存时使用）并落盘。
    pub fn replace(&self, cfg: AppConfig) -> AppResult<()> {
        cfg.save(&self.path)?;
        *self.inner.write() = cfg;
        Ok(())
    }
}