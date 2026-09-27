//! 危险命令检测（FEATURES.md §5「危险命令提示」）。
//!
//! 这是 AI 生成命令的**权威拦截点**：前端 `js/danger.js` 的规则用于交互提示，
//! 这里在后端再做一次纯字符串检查，把命中的原因随 `ai:done` 事件带给前端。
//! 刻意不引入 `regex` 依赖——规则的健壮程度足以覆盖常见的破坏性命令。

/// 检查命令是否危险。命中返回人类可读的风险描述，否则返回 `None`。
pub fn inspect(command: &str) -> Option<&'static str> {
    let c = command.to_ascii_lowercase();

    // 破坏性删除 / 改写块设备：`rm -rf /` 的 `/` 后必须跟分隔符或结束，
    // 避免把 `rm -rf /tmp` 这类常规清理误判为删根。
    if contains_whole(&c, "rm -rf /") {
        return Some("疑似删除根目录，可能清空整个系统");
    }
    if contains_whole(&c, "rm -fr /") {
        return Some("疑似删除根目录，可能清空整个系统");
    }
    if c.contains("rm -rf --no-preserve-root") {
        return Some("强制删除根目录，可能清空整个系统");
    }

    const SUBSTRING_RULES: &[(&str, &str)] = &[
        ("mkfs", "格式化磁盘，会清除分区数据"),
        ("fdisk", "磁盘分区改写，操作不当会损坏分区表"),
        ("dd if=", "直接写入块设备，可能覆盖磁盘"),
        (":(){ :|:& };:", "fork 炸弹，会耗尽系统资源"),
        ("shutdown", "关机，会中断服务"),
        ("reboot", "重启，会中断服务"),
        ("poweroff", "关机，会中断服务"),
        ("chmod -r 777 /", "对根目录递归开放全部权限"),
        ("chown -r", "递归改写文件属主，可能破坏系统文件"),
        ("drop table", "删除数据库表，会丢失数据"),
        ("delete from", "删除数据库记录，可能丢失数据"),
        ("kill -9 -1", "杀死全部进程"),
    ];

    for (needle, reason) in SUBSTRING_RULES {
        if c.contains(needle) {
            return Some(reason);
        }
    }
    None
}

/// 匹配 `needle`，并要求其后的下一个字符不是文件名字符（字母/数字/下划线/短横线/点）。
/// 用于「以 `/` 结尾」的根目录模式，区分 `rm -rf /` 与 `rm -rf /tmp`。
fn contains_whole(haystack: &str, needle: &str) -> bool {
    for (idx, _) in haystack.match_indices(needle) {
        let after = &haystack[idx + needle.len()..];
        let next = after.chars().next();
        if next.map_or(true, |ch| {
            !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-' && ch != '.'
        }) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_root_deletion() {
        assert!(inspect("rm -rf /").is_some());
        assert!(inspect("rm -rf /*").is_some());
        assert!(inspect("sudo rm -rf --no-preserve-root /").is_some());
    }

    #[test]
    fn does_not_flag_tmp_cleanup() {
        assert!(inspect("rm -rf /tmp/build").is_none());
        assert!(inspect("rm -rf /var/tmp/foo").is_none());
    }

    #[test]
    fn flags_fork_bomb_and_dd() {
        assert!(inspect(":(){ :|:& };:").is_some());
        assert!(inspect("dd if=/dev/zero of=/dev/sda").is_some());
    }

    #[test]
    fn harmless_commands_pass() {
        assert!(inspect("ls -la").is_none());
        assert!(inspect("git status").is_none());
        assert!(inspect("echo hello").is_none());
    }
}