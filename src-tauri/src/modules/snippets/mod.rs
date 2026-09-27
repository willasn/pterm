//! 命令片段（FEATURES.md §6）。
//!
//! 片段用于保存常用命令，支持 `{{name}}` 变量占位符与快捷插入终端。
//!
//! 数据全部落在 SQLite 的 `snippets` 表（见 `config::store`），模块本身
//! **没有运行期状态**，因此 [`SnippetsModule`] 只在初始化时打一条日志，
//! 真正的读写发生在命令层（见 `commands.rs`）。
//!
//! 占位符的提取与替换只在 Rust 侧实现一份，前端只负责收集变量取值：
//! 新增 / 更新片段时自动重算 `variables`，渲染时未提供值的占位符原样保留，
//! 便于用户在终端里二次编辑。

use std::collections::HashMap;

use crate::config::feature_flags::{module_id, FeatureFlags, PluggableModule};
use crate::error::AppResult;
use crate::modules::ModuleContext;

pub mod commands;

/// 变量名允许的字符：字母、数字、下划线、短横线、点。
fn is_var_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.'
}

/// 从片段内容中提取 `{{name}}` 占位符名，按出现顺序去重。
pub fn extract_variables(content: &str) -> Vec<String> {
    let bytes = content.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'{' && bytes[i + 1] == b'{' {
            if let Some(end) = content[i + 2..].find("}}") {
                let name = content[i + 2..i + 2 + end].trim();
                if !name.is_empty() && name.chars().all(is_var_char) {
                    if !out.iter().any(|v| v == name) {
                        out.push(name.to_string());
                    }
                    i = i + end + 4;
                    continue;
                }
            }
            // 不是合法占位符：只跳过 `{{`，让后面的合法占位符仍能被识别
            i += 2;
            continue;
        }
        i += 1;
    }
    out
}

/// 用 `values` 替换内容中的 `{{name}}`。未提供值的占位符原样保留。
pub fn render(content: &str, values: &HashMap<String, String>) -> String {
    let mut out = content.to_string();
    for name in extract_variables(content) {
        if let Some(value) = values.get(&name) {
            out = out.replace(&format!("{{{{{name}}}}}"), value);
        }
    }
    out
}

/// 命令片段模块。数据落在 SQLite，模块自身无运行期状态。
pub struct SnippetsModule;

impl SnippetsModule {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SnippetsModule {
    fn default() -> Self {
        Self::new()
    }
}

impl PluggableModule for SnippetsModule {
    fn id(&self) -> &'static str {
        module_id::SNIPPETS
    }

    fn is_enabled(&self, flags: &FeatureFlags) -> bool {
        flags.auxiliary.snippets
    }

    fn init(&self, _ctx: &ModuleContext) -> AppResult<()> {
        log::info!("命令片段已启用：支持变量占位符与快捷插入");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_in_order_and_dedupes() {
        let vars = extract_variables("ssh {{user}}@{{host}} -p {{port}} # {{user}}");
        assert_eq!(vars, vec!["user", "host", "port"]);
    }

    #[test]
    fn extracts_only_valid_names() {
        // 空名、含空格的名字一律忽略；未闭合的结尾不会匹配
        let vars = extract_variables("echo {{}} {{a b}} {{ok}} {{no_close");
        assert_eq!(vars, vec!["ok"]);
    }

    #[test]
    fn keeps_scanning_after_invalid_placeholder() {
        let vars = extract_variables("{{未闭合 {{ok}}");
        assert_eq!(vars, vec!["ok"]);
    }

    #[test]
    fn renders_known_values_and_keeps_the_rest() {
        let mut values = HashMap::new();
        values.insert("user".to_string(), "root".to_string());
        let out = render("ssh {{user}}@{{host}}", &values);
        assert_eq!(out, "ssh root@{{host}}");
    }

    #[test]
    fn renders_without_values_is_identity() {
        let out = render("ls -al {{path}}", &HashMap::new());
        assert_eq!(out, "ls -al {{path}}");
    }
}