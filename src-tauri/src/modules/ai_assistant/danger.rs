//! 危险命令检测（FEATURES.md §5「危险命令提示」）。
//!
//! 这是 AI 生成命令的**权威拦截点**：前端 `js/danger.js` 的规则用于交互提示，
//! 这里在后端再做一次纯字符串检查，把命中的原因随 `ai:done` 事件带给前端。
//! 刻意不引入 `regex` 依赖——规则的健壮程度足以覆盖常见的破坏性命令。
//!
//! [`classify`] 在危险规则之上再补一层「是否需要用户授权」的判定：Agent 模式会
//! 自动执行只读命令，只把会删除 / 修改 / 改动系统状态的关键操作交回用户确认。

/// 一条命令的风险判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Verdict {
    /// 是否需要用户先授权才能执行
    pub requires_auth: bool,
    /// 触发授权的原因；无需授权时为 `None`
    pub reason: Option<&'static str>,
    /// 是否属于破坏性危险命令（前端据此额外高亮并二次确认）
    pub danger: bool,
}

impl Verdict {
    /// 无需授权的只读命令。
    pub const fn safe() -> Self {
        Self { requires_auth: false, reason: None, danger: false }
    }
}

/// 判定一条命令是否需要用户授权。
///
/// 先按破坏性规则检查（[`inspect`]）；未命中再按「删除 / 修改 / 关键操作」等易造成
/// 副作用的模式检查。两者都不命中即视为只读命令，可由 Agent 自动执行。
pub fn classify(command: &str) -> Verdict {
    if let Some(reason) = inspect(command) {
        return Verdict { requires_auth: true, reason: Some(reason), danger: true };
    }
    match mutation_reason(&command.to_ascii_lowercase()) {
        Some(reason) => Verdict { requires_auth: true, reason: Some(reason), danger: false },
        None => Verdict::safe(),
    }
}

/// 命中「会改动系统状态」的模式时返回原因（需用户授权），否则 `None`。
fn mutation_reason(c: &str) -> Option<&'static str> {
    // 写入 / 覆盖文件的重定向
    if has_write_redirect(c) {
        return Some("写入或覆盖文件");
    }
    // sed 就地改写文件
    if has_word(c, "sed") && (c.contains(" -i") || c.contains("--in-place")) {
        return Some("就地修改文件内容");
    }
    // 少数「既可能只读、又可能改动」的命令按子命令区分：只有改动的子命令才需授权
    if let Some(reason) = mutating_subcommand(c) {
        return Some(reason);
    }

    const RULES: &[(&str, &str)] = &[
        // 删除 / 移动 / 改写文件
        ("rm", "删除文件或目录"),
        ("rmdir", "删除目录"),
        ("mv", "移动或重命名文件"),
        ("shred", "不可恢复地擦除文件"),
        ("truncate", "清空或截断文件"),
        ("dd", "直接写入磁盘或文件"),
        ("tee", "写入文件"),
        // 权限 / 属主
        ("chmod", "修改文件权限"),
        ("chown", "修改文件属主"),
        ("chgrp", "修改文件属组"),
        ("setfacl", "修改文件访问控制表"),
        // 软件包
        ("apt", "安装或卸载软件包"),
        ("yum", "安装或卸载软件包"),
        ("dnf", "安装或卸载软件包"),
        ("pacman", "安装或卸载软件包"),
        ("zypper", "安装或卸载软件包"),
        ("apk", "安装或卸载软件包"),
        ("brew", "安装或卸载软件包"),
        ("snap", "安装或卸载软件包"),
        ("pip", "安装或卸载 Python 包"),
        // 服务 / 进程
        ("kill", "结束进程"),
        ("pkill", "结束进程"),
        ("killall", "结束进程"),
        // 用户 / 组
        ("useradd", "新增系统用户"),
        ("usermod", "修改系统用户"),
        ("userdel", "删除系统用户"),
        ("groupadd", "新增用户组"),
        ("groupdel", "删除用户组"),
        ("passwd", "修改账户密码"),
        // 定时任务 / 防火墙
        ("crontab", "修改定时任务"),
        ("iptables", "修改防火墙规则"),
        ("ip6tables", "修改防火墙规则"),
        ("nft", "修改防火墙规则"),
        ("ufw", "修改防火墙规则"),
        ("firewall-cmd", "修改防火墙规则"),
        // 磁盘 / 系统状态
        ("mount", "挂载或卸载文件系统"),
        ("umount", "卸载文件系统"),
        ("mkfs", "格式化文件系统"),
        ("mke2fs", "格式化文件系统"),
        ("fdisk", "修改磁盘分区"),
        ("parted", "修改磁盘分区"),
        ("wipefs", "擦除文件系统签名"),
        ("swapon", "启用交换分区"),
        ("swapoff", "关闭交换分区"),
        ("shutdown", "关机"),
        ("reboot", "重启"),
        ("poweroff", "关机"),
        ("halt", "关机"),
        // 版本库
        ("git push", "推送改动到远端仓库"),
        ("git reset", "回退提交"),
        ("git clean", "清理未跟踪文件"),
        ("git rm", "删除版本库中的文件"),
        ("git checkout", "切换分支或覆盖工作区"),
        ("git rebase", "改写提交历史"),
        ("git merge", "合并分支"),
        // 容器 / 编排
        ("helm", "操作 Kubernetes 发布"),
        // 数据库
        ("drop table", "删除数据库表"),
        ("drop database", "删除数据库"),
        ("drop schema", "删除数据库模式"),
        ("truncate table", "清空数据库表"),
        ("delete from", "删除数据库记录"),
        ("alter table", "修改数据库表结构"),
    ];

    RULES.iter().find(|(needle, _)| has_word(c, needle)).map(|(_, reason)| *reason)
}

/// 对「既可能只读、又可能改动」的命令，按子命令判断是否需要授权。
/// 例如 `systemctl status` / `docker ps` 是只读的，`systemctl restart` / `docker rm` 不是。
fn mutating_subcommand(c: &str) -> Option<&'static str> {
    if has_word(c, "systemctl") || has_word(c, "service") {
        if has_subcommand(
            c,
            &[
                "start",
                "stop",
                "restart",
                "reload",
                "enable",
                "disable",
                "mask",
                "unmask",
                "daemon-reload",
                "kill",
            ],
        ) {
            return Some("控制系统服务");
        }
    }
    if has_word(c, "docker") {
        if has_subcommand(
            c,
            &[
                "rm", "rmi", "stop", "kill", "run", "exec", "create", "start", "restart", "prune",
                "build", "push", "pull", "tag", "login", "logout", "compose", "volume", "network",
                "system",
            ],
        ) {
            return Some("操作容器");
        }
    }
    if has_word(c, "kubectl") {
        if has_subcommand(
            c,
            &[
                "delete", "apply", "create", "edit", "patch", "replace", "scale", "rollout",
                "drain", "cordon", "uncordon", "taint", "exec", "label", "annotate", "set",
            ],
        ) {
            return Some("操作 Kubernetes 资源");
        }
    }
    None
}

/// 命令里是否以完整单词形式出现 `verbs` 中任意一个（两侧按空格 / 起止判定）。
fn has_subcommand(c: &str, verbs: &[&str]) -> bool {
    let padded = format!(" {c} ");
    verbs.iter().any(|verb| padded.contains(&format!(" {verb} ")))
}

/// 判断是否存在「写入文件」的重定向。排除 `2>&1` 这类 fd 复制，以及 `2>file` 这类
/// 带 fd 号的重定向，避免把常见的 `cmd 2>/dev/null` 误判为写文件。
fn has_write_redirect(c: &str) -> bool {
    let bytes = c.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] != b'>' {
            continue;
        }
        let prev_digit = i > 0 && bytes[i - 1].is_ascii_digit();
        let next_amp = bytes.get(i + 1) == Some(&b'&');
        if !prev_digit && !next_amp {
            return true;
        }
    }
    false
}

/// `needle` 作为完整单词出现（两侧不是字母 / 数字 / 下划线）。
/// `needle` 可含空格（如 `git push`），按整段短语判定边界。
fn has_word(haystack: &str, needle: &str) -> bool {
    for (idx, _) in haystack.match_indices(needle) {
        let before = haystack[..idx].chars().next_back();
        let after = haystack[idx + needle.len()..].chars().next();
        let ok_before = before.map_or(true, |ch| !ch.is_ascii_alphanumeric() && ch != '_');
        let ok_after = after.map_or(true, |ch| !ch.is_ascii_alphanumeric() && ch != '_');
        if ok_before && ok_after {
            return true;
        }
    }
    false
}

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

    /// 只读命令可由 Agent 自动执行，无需授权。
    #[test]
    fn readonly_commands_need_no_auth() {
        for cmd in [
            "ls -la /var/log",
            "df -h",
            "free -m",
            "cat /etc/os-release",
            "grep -r error /var/log | head",
            "ps aux",
            "systemctl status nginx", // 注意：这是 status，非控制
            "git status",
            "git log --oneline -5",
            "curl -I https://example.com",
            "cmd 2>/dev/null",
        ] {
            assert!(!classify(cmd).requires_auth, "应可自动执行：{cmd}");
        }
    }

    /// 删除 / 修改 / 关键操作需要用户授权。
    #[test]
    fn mutating_commands_need_auth() {
        for cmd in [
            "rm -rf /tmp/build",
            "rm note.txt",
            "mv a.txt b.txt",
            "chmod 644 file",
            "apt-get install nginx",
            "systemctl restart nginx",
            "kill -9 1234",
            "echo hi > out.txt",
            "sed -i 's/a/b/' file",
            "git push origin main",
            "docker rm mycontainer",
            "crontab -e",
        ] {
            let v = classify(cmd);
            assert!(v.requires_auth, "应需要授权：{cmd}");
            assert!(!v.danger, "不应算作破坏性危险：{cmd}");
        }
    }

    /// 破坏性命令既要授权也标记为危险。
    #[test]
    fn destructive_commands_are_dangerous() {
        let v = classify("rm -rf /");
        assert!(v.requires_auth);
        assert!(v.danger);
        assert!(v.reason.is_some());
    }

    /// 词边界必须生效，避免把 `form` / `confirm` 里的 `rm` 误判。
    #[test]
    fn word_boundaries_avoid_false_positives() {
        assert!(!classify("ls -la /tmp/form.txt").requires_auth);
        assert!(!classify("echo confirm done").requires_auth);
        assert!(!classify("docker ps --format '{{.Names}}'").danger);
    }
}