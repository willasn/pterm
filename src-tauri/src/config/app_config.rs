use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::config::feature_flags::FeatureFlags;
use crate::error::{AppError, AppResult};

// ---------------------------------------------------------------------------
// 终端
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct TerminalConfig {
    pub font_family: String,
    pub font_size: u16,
    pub line_height: f32,
    pub scrollback: u32,
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub bell: bool,
    pub copy_on_select: bool,
    /// 终端内右击是否弹出「复制 / 粘贴」菜单
    pub right_click_menu: bool,
    pub keepalive_secs: u32,
    /// 终端背景色。留空则跟随主题的 --term-bg
    pub background: String,
    /// 终端前景色。留空则跟随主题的 --term-fg
    pub foreground: String,
    /// 预测性本地回显：按键立即上屏，远端回显到达后再对齐。
    /// 关闭后字符只在远端回显到达时出现（键入有明显延迟，但屏幕必然与远端一致）。
    pub local_echo: bool,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            font_family: "SFMono-Regular, Menlo, Consolas, \"Liberation Mono\", monospace".into(),
            font_size: 13,
            line_height: 1.2,
            scrollback: 5000,
            cursor_style: "block".into(),
            cursor_blink: true,
            bell: false,
            copy_on_select: true,
            right_click_menu: true,
            keepalive_secs: 30,
            background: String::new(),
            foreground: String::new(),
            local_echo: true,
        }
    }
}

// ---------------------------------------------------------------------------
// AI 供应商
// ---------------------------------------------------------------------------

/// 生成参数缺省值。用 `Option` 而非零值表达「用户没填」，因此需要一份权威默认值：
/// 用户留空时的行为必须与不填完全一致。
pub const DEFAULT_TEMPERATURE: f32 = 0.2;
pub const DEFAULT_MAX_TOKENS: u32 = 2048;
pub const DEFAULT_TIMEOUT_SECS: u64 = 60;
pub const DEFAULT_CONTEXT_BYTES: usize = 4096;

/// AI 协议取值。决定请求地址后缀、鉴权头与请求 / 响应格式（见 ai_assistant/protocol.rs）。
/// - [`PROTOCOL_OPENAI`]：OpenAI 兼容 Chat Completions（默认，兼容 DeepSeek / 各类网关）
/// - [`PROTOCOL_OPENAI_RESPONSES`]：OpenAI Responses 接口
/// - [`PROTOCOL_ANTHROPIC`]：Anthropic Messages（Claude 官方）
pub const PROTOCOL_OPENAI: &str = "openai";
pub const PROTOCOL_OPENAI_RESPONSES: &str = "openai_responses";
pub const PROTOCOL_ANTHROPIC: &str = "anthropic";
/// 未填写协议时的默认值：历史配置都按 OpenAI 兼容处理。
pub const DEFAULT_AI_PROTOCOL: &str = PROTOCOL_OPENAI;

/// 单个自定义模型配置。每个模型自带 API 地址、API Key 与生成参数，
/// 可混合不同供应商（OpenAI、DeepSeek、自建网关、本地 Ollama 等）。
///
/// `id` 是稳定标识：API Key 以它作为保险库键名，重命名展示名不会丢 Key。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct AiModelConfig {
    /// 稳定标识，仅用于保险库键名，不展示给用户
    pub id: String,
    /// 展示名，如「DeepSeek 对话」
    pub name: String,
    /// 模型 id，如 deepseek-chat
    pub model: String,
    /// 该模型专用的 API 根地址，如 https://api.deepseek.com/v1
    pub base_url: String,
    /// 请求协议（见 [`DEFAULT_AI_PROTOCOL`]）。决定 base_url 之后拼接的路径后缀、
    /// 鉴权头与请求 / 响应格式。旧配置缺省时按 OpenAI 兼容处理。
    pub protocol: String,
    /// 采样温度。`None` = 用 [`DEFAULT_TEMPERATURE`]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    /// 单次请求最大输出 token。`None` = 用 [`DEFAULT_MAX_TOKENS`]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// 单次请求最大输入 token（模型上下文窗口）。仅用于前端面板估算上下文占比，
    /// 不发往服务端；`None` 时面板按 128000 计。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_input_tokens: Option<u32>,
    /// 请求超时（秒）。`None` = 用 [`DEFAULT_TIMEOUT_SECS`]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    /// 上下文注入时附带的终端输出字节数。`None` = 用 [`DEFAULT_CONTEXT_BYTES`]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_bytes: Option<usize>,
}

impl AiModelConfig {
    pub fn temperature(&self) -> f32 {
        self.temperature.unwrap_or(DEFAULT_TEMPERATURE)
    }

    pub fn max_tokens(&self) -> u32 {
        self.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS)
    }

    /// 超时至少 1 秒：0 会让请求立刻超时，等于永远失败。
    pub fn timeout_secs(&self) -> u64 {
        self.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).max(1)
    }

    pub fn context_bytes(&self) -> usize {
        self.context_bytes.unwrap_or(DEFAULT_CONTEXT_BYTES)
    }
}

impl Default for AiModelConfig {
    fn default() -> Self {
        Self {
            id: new_model_id(),
            name: "默认".into(),
            model: "gpt-4o-mini".into(),
            base_url: "https://api.openai.com/v1".into(),
            protocol: DEFAULT_AI_PROTOCOL.into(),
            temperature: None,
            max_tokens: None,
            max_input_tokens: None,
            timeout_secs: None,
            context_bytes: None,
        }
    }
}

/// 生成一个模型条目的稳定标识。用 uuid 而非序号，避免删除 / 重排后
/// 保险库键名与模型错配。
pub fn new_model_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// AI 供应商配置。**不包含任何 API Key**——Key 全部存加密保险库，
/// 每个模型各有一把，按 [`AiModelConfig::id`] 索引。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct AiConfig {
    /// 自定义模型列表。面板里显式选择用哪个模型，没有隐含的角色划分。
    ///
    /// 这里必须显式标注字段级 `default`：容器级的 `#[serde(default)]` 会用
    /// `AiConfig::default()` 的整条模型去填缺失的键，迁移逻辑就再也分不清
    /// 「配置文件里本来没有 models」和「用户写了 models」，旧版的全局模型会被静默丢掉。
    #[serde(default)]
    pub models: Vec<AiModelConfig>,
    /// 旧版全局字段，仅为兼容历史配置文件保留，不再使用。
    /// 见 `migrate_ai` 中的迁移逻辑。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub base_url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_bytes: Option<usize>,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            models: vec![AiModelConfig::default()],
            base_url: String::new(),
            model: String::new(),
            temperature: None,
            max_tokens: None,
            timeout_secs: None,
            context_bytes: None,
        }
    }
}

// ---------------------------------------------------------------------------
// 主题 / 快捷键
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct ThemeConfig {
    /// light | dark | system
    pub mode: String,
    /// 强调色
    pub accent: String,
}

impl Default for ThemeConfig {
    fn default() -> Self {
        Self {
            mode: "dark".into(),
            accent: "#4ade80".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct ShortcutBinding {
    /// 动作 id，如 "app.settings"
    pub action: String,
    /// 组合键，如 "CmdOrCtrl+,"
    pub keys: String,
    /// 是否启用。关闭后按键不再派发该动作，直接交给终端处理。
    pub enabled: bool,
}

impl Default for ShortcutBinding {
    fn default() -> Self {
        Self {
            action: String::new(),
            keys: String::new(),
            // 必须为 true：旧配置文件里没有这个字段，容器级 serde(default)
            // 会取这里的值。若给 false，升级后所有快捷键会被静默禁用。
            enabled: true,
        }
    }
}

pub fn default_shortcuts() -> Vec<ShortcutBinding> {
    // 复制 / 粘贴的默认键按平台给：macOS 沿用系统习惯的 ⌘C / ⌘V；
    // Windows 用 Ctrl+Shift+C / V，把 Ctrl+C 的中断语义完整留给终端。
    let (copy_keys, paste_keys) = if cfg!(target_os = "macos") {
        ("Cmd+C", "Cmd+V")
    } else {
        ("Ctrl+Shift+C", "Ctrl+Shift+V")
    };
    let pairs = [
        ("tab.new", "CmdOrCtrl+T"),
        ("tab.close", "CmdOrCtrl+W"),
        ("tab.next", "CmdOrCtrl+Tab"),
        ("app.settings", "CmdOrCtrl+,"),
        ("app.quick_connect", "CmdOrCtrl+K"),
        ("app.quick_panel", "CmdOrCtrl+Shift+P"),
        ("app.search", "CmdOrCtrl+Shift+F"),
        ("app.ai", "CmdOrCtrl+I"),
        ("view.split_h", "CmdOrCtrl+Shift+E"),
        ("view.split_v", "CmdOrCtrl+Shift+O"),
        ("terminal.copy", copy_keys),
        ("terminal.paste", paste_keys),
    ];
    pairs
        .into_iter()
        .map(|(action, keys)| ShortcutBinding {
            action: action.into(),
            keys: keys.into(),
            enabled: true,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 应用配置根
// ---------------------------------------------------------------------------

/// 应用配置根对象，序列化为 `config.yaml`。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct AppConfig {
    /// 配置版本，便于将来迁移
    pub version: u32,
    pub features: FeatureFlags,
    pub terminal: TerminalConfig,
    pub ai: AiConfig,
    pub theme: ThemeConfig,
    pub shortcuts: Vec<ShortcutBinding>,
    /// 界面语言：zh-CN | en-US
    pub language: String,
}

impl AppConfig {
    /// 生成一份带完整默认值的配置（首次启动时落盘，便于用户直接编辑）。
    pub fn with_defaults() -> Self {
        let mut cfg = Self {
            version: 1,
            features: FeatureFlags::default(),
            terminal: TerminalConfig::default(),
            ai: AiConfig::default(),
            theme: ThemeConfig::default(),
            shortcuts: default_shortcuts(),
            language: "zh-CN".into(),
        };
        // 「必开项」恒为开启，默认值里可能被写成关闭的一并修正
        cfg.features.enforce_mandatory();
        cfg
    }

    pub fn load(path: &Path) -> AppResult<Self> {
        if !path.exists() {
            let cfg = AppConfig::with_defaults();
            cfg.save(path)?;
            log::info!("已生成默认配置：{}", path.display());
            return Ok(cfg);
        }
        let text = std::fs::read_to_string(path)?;
        let mut cfg: AppConfig = serde_yaml::from_str(&text)
            .map_err(|e| AppError::Config(format!("解析 {} 失败：{e}", path.display())))?;
        // 用户可能删掉了某些键，补齐默认值并回写，保证文件始终是完整可编辑的。
        // 必须落盘：迁移会给模型条目生成稳定 id，而 API Key 以 id 为保险库键名，
        // 不落盘的话每次启动 id 都会变，已保存的 Key 就全部失联。
        if cfg.fill_missing() {
            cfg.save(path)?;
            log::info!("已补齐并回写配置：{}", path.display());
        }
        Ok(cfg)
    }

    pub fn save(&self, path: &Path) -> AppResult<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_yaml::to_string(self)
            .map_err(|e| AppError::Config(format!("序列化配置失败：{e}")))?;
        std::fs::write(path, text)?;
        Ok(())
    }

    /// 补齐缺失的斜杠命令与快捷键（仅在列表为空时补默认，避免覆盖用户清空的操作）。
    /// 返回是否发生了改动——调用方据此决定要不要回写文件。
    fn fill_missing(&mut self) -> bool {
        let mut changed = false;
        if self.version == 0 {
            self.version = 1;
            changed = true;
        }
        if self.language.is_empty() {
            self.language = "zh-CN".into();
            changed = true;
        }
        changed |= self.migrate_ai();
        // 「必开项」恒为开启：配置文件里若被改成关闭，加载时强制拉回并回写
        changed |= self.features.enforce_mandatory();
        changed
    }

    /// 把旧版的「全局 base_url / model + 无地址的模型列表」迁移成
    /// 「每个模型自带地址」的新结构，保证升级后原有配置不丢。
    /// 返回是否发生了改动。
    fn migrate_ai(&mut self) -> bool {
        let mut changed = false;

        let legacy_base = std::mem::take(&mut self.ai.base_url);
        let legacy_model = std::mem::take(&mut self.ai.model);
        changed |= !legacy_base.is_empty() || !legacy_model.is_empty();

        // 旧版只支持单个全局模型（没有 models 键）：先用旧值补出这条记录，
        // 否则下面按「地址为空」补地址的循环无事可做，用户填过的模型名与地址都会丢。
        if self.ai.models.is_empty() && !legacy_model.is_empty() {
            let mut model = AiModelConfig::default();
            model.model = legacy_model;
            // 地址留空，交给下面的循环按 legacy_base 统一补齐（默认值非空，不清掉就轮不到 legacy_base）
            model.base_url = String::new();
            self.ai.models.push(model);
        }

        // 补齐稳定 id 与 API 地址。id 必须落盘，否则每次启动都会变，
        // 以 id 为键名的保险库 API Key 会全部失联。
        let fallback_base = AiModelConfig::default().base_url;
        for model in self.ai.models.iter_mut() {
            if model.id.is_empty() {
                model.id = new_model_id();
                changed = true;
            }
            if model.base_url.is_empty() {
                model.base_url = if legacy_base.is_empty() {
                    fallback_base.clone()
                } else {
                    legacy_base.clone()
                };
                changed = true;
            }
        }

        // 生成参数从全局下放到模型：第一个模型继承旧值，其余保持「未填」用默认。
        // 只在用户确实填过（Some）时搬，避免把默认值写死成显式配置。
        let legacy_temp = std::mem::take(&mut self.ai.temperature);
        let legacy_max = std::mem::take(&mut self.ai.max_tokens);
        let legacy_timeout = std::mem::take(&mut self.ai.timeout_secs);
        let legacy_ctx = std::mem::take(&mut self.ai.context_bytes);
        changed |= legacy_temp.is_some()
            || legacy_max.is_some()
            || legacy_timeout.is_some()
            || legacy_ctx.is_some();
        if let Some(first) = self.ai.models.first_mut() {
            first.temperature = legacy_temp;
            first.max_tokens = legacy_max;
            first.timeout_secs = legacy_timeout;
            first.context_bytes = legacy_ctx;
        }

        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 配置是用户可手改的 YAML，升级后新增的字段在旧文件里必然缺失。
    /// 缺失时必须落到 `Default` 的取值，而不是字段类型的零值——
    /// `bool` 的零值是 false，会让新功能被静默关掉且毫无提示。
    #[test]
    fn missing_terminal_field_falls_back_to_struct_default() {
        let yaml = "version: 1\nterminal:\n  font_size: 15\n";
        let cfg: AppConfig = serde_yaml::from_str(yaml).expect("应能解析缺字段的配置");
        assert_eq!(cfg.terminal.font_size, 15, "显式给出的字段应被保留");
        assert!(
            cfg.terminal.local_echo,
            "缺失 local_echo 时必须取 Default 的 true，否则本地回显会被静默关闭"
        );
        assert!(cfg.terminal.copy_on_select, "其余缺失字段也应取 Default");
        assert!(cfg.terminal.right_click_menu, "右击菜单默认开启");
    }

    /// 升级前写入的快捷键绑定没有 `enabled` 字段，缺失时必须取 Default 的 true，
    /// 否则用户已有的自定义快捷键会被静默禁用。
    #[test]
    fn missing_shortcut_enabled_falls_back_to_true() {
        let yaml = "version: 1\nshortcuts:\n  - action: tab.new\n    keys: CmdOrCtrl+T\n";
        let cfg: AppConfig = serde_yaml::from_str(yaml).expect("应能解析缺 enabled 的快捷键配置");
        assert_eq!(cfg.shortcuts.len(), 1, "显式给出的绑定不应被丢掉");
        assert_eq!(cfg.shortcuts[0].action, "tab.new");
        assert!(cfg.shortcuts[0].enabled, "缺失 enabled 时必须视为启用");
    }

    /// 空配置（用户把内容删光）不能导致解析失败。
    #[test]
    fn empty_config_parses_to_defaults() {
        let cfg: AppConfig = serde_yaml::from_str("{}").expect("空配置应可解析");
        assert!(cfg.terminal.local_echo);
    }

    /// 模型参数留空时必须落到权威默认值，而不是 f32 / u32 的零值——
    /// 温度 0 会让模型输出完全确定，与「没填」是完全不同的行为。
    #[test]
    fn model_params_fall_back_to_defaults_when_absent() {
        let model = AiModelConfig {
            id: "m1".into(),
            name: "测试".into(),
            model: "gpt-4o-mini".into(),
            base_url: "https://example.com/v1".into(),
            protocol: DEFAULT_AI_PROTOCOL.into(),
            temperature: None,
            max_tokens: None,
            max_input_tokens: None,
            timeout_secs: None,
            context_bytes: None,
        };
        assert_eq!(model.temperature(), DEFAULT_TEMPERATURE);
        assert_eq!(model.max_tokens(), DEFAULT_MAX_TOKENS);
        assert_eq!(model.timeout_secs(), DEFAULT_TIMEOUT_SECS);
        assert_eq!(model.context_bytes(), DEFAULT_CONTEXT_BYTES);
    }

    /// 超时 0 会让请求立刻失败，必须夹到至少 1 秒。
    #[test]
    fn model_timeout_is_clamped_to_at_least_one_second() {
        let mut model = AiModelConfig::default();
        model.timeout_secs = Some(0);
        assert_eq!(model.timeout_secs(), 1);
    }

    /// 旧配置把生成参数放在全局 ai 段，升级后必须搬进第一个模型，不能静默丢失。
    #[test]
    fn legacy_global_params_migrate_into_first_model() {
        let yaml = concat!(
            "version: 1\n",
            "ai:\n",
            "  base_url: https://api.deepseek.com/v1\n",
            "  model: deepseek-chat\n",
            "  temperature: 0.9\n",
            "  max_tokens: 512\n",
        );
        let mut cfg: AppConfig = serde_yaml::from_str(yaml).expect("应能解析旧配置");
        assert!(cfg.fill_missing(), "旧配置应触发迁移");
        assert_eq!(cfg.ai.models.len(), 1);
        let model = &cfg.ai.models[0];
        assert_eq!(model.model, "deepseek-chat");
        assert_eq!(model.base_url, "https://api.deepseek.com/v1");
        assert_eq!(model.temperature, Some(0.9));
        assert_eq!(model.max_tokens, Some(512));
        assert_eq!(model.timeout_secs, None, "未填过的参数应保持未填");
        assert_eq!(model.timeout_secs(), DEFAULT_TIMEOUT_SECS);
        assert!(cfg.ai.base_url.is_empty(), "旧字段迁移后应清空");
        assert!(cfg.ai.model.is_empty());
    }

    /// 迁移必须幂等：第二次加载不应再改动，也不该换掉模型 id。
    #[test]
    fn migration_is_idempotent_and_keeps_model_id() {
        let yaml = "version: 1\nai:\n  base_url: https://api.openai.com/v1\n  model: gpt-4o-mini\n";
        let mut cfg: AppConfig = serde_yaml::from_str(yaml).expect("应能解析");
        assert!(cfg.fill_missing());
        let id = cfg.ai.models[0].id.clone();
        assert!(!id.is_empty(), "迁移必须生成稳定 id");
        assert!(!cfg.fill_missing(), "第二次不应再有改动");
        assert_eq!(cfg.ai.models[0].id, id, "id 必须稳定，否则保险库 Key 会失联");
    }
}