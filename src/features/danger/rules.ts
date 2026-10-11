/**
 * 危险命令判定规则（全局强制约束：rm -rf / dd / mkfs 等必须二次确认）。
 *
 * 由原 src/legacy/danger.ts 迁移而来。命中任意一条即视为危险，reason 会展示给用户。
 */

export interface DangerRule {
  reason: string;
  test: (command: string) => boolean;
}

export const DANGER_RULES: DangerRule[] = [
  {
    reason: "递归强制删除文件或目录（-r 与 -f 同时出现）",
    test: (c) => /\brm\b/.test(c) && /(\s|^)-[a-zA-Z]*r/.test(c) && /(\s|^)-[a-zA-Z]*f/.test(c),
  },
  {
    reason: "强制删除（-f）",
    test: (c) => /\brm\b/.test(c) && /(\s|^)-[a-zA-Z]*f/.test(c),
  },
  {
    reason: "递归删除目录（-r）",
    test: (c) => /\brm\b/.test(c) && /(\s|^)-[a-zA-Z]*r/.test(c),
  },
  {
    reason: "删除根目录、家目录或通配路径",
    test: (c) => /\brm\b/.test(c) && /(\s\/(\*|\s|$)|\s~\/?\*|\s\.\*)/.test(c),
  },
  {
    reason: "直接写入块设备（dd of=/dev/…）",
    test: (c) => /\bdd\b/.test(c) && /of=\/dev\//.test(c),
  },
  {
    reason: "格式化文件系统",
    test: (c) => /\b(mkfs(\.[a-z0-9]+)?|mke2fs|wipefs)\b/.test(c),
  },
  {
    reason: "覆盖块设备内容",
    test: (c) => />\s*\/dev\/(sd|hd|nvme|vd|disk)/.test(c),
  },
  {
    reason: "fork 炸弹",
    test: (c) => /:\(\)\s*\{.*\|.*&.*\}\s*;?\s*:/.test(c) || /\.\(\)\{\s*\.\|\.&\s*\};\./.test(c),
  },
  {
    reason: "关闭或重启主机",
    test: (c) => /\b(shutdown|reboot|poweroff|halt)\b/.test(c) || /\binit\s+(0|6)\b/.test(c),
  },
  {
    reason: "把根目录权限改为 777",
    test: (c) => /\bchmod\b/.test(c) && /-[a-zA-Z]*R/.test(c) && /777/.test(c) && /(\s\/\s|\s\/$)/.test(c),
  },
  {
    reason: "递归修改属主（可能波及整个目录树）",
    test: (c) => /\bch(own|grp)\b/.test(c) && /-[a-zA-Z]*R/.test(c),
  },
  {
    reason: "杀掉所有进程",
    test: (c) => /kill\s+-9\s+-1/.test(c) || /\bkillall5\b/.test(c) || /\bpkill\s+-9\s+\.?/.test(c),
  },
  {
    reason: "把文件移入 /dev/null",
    test: (c) => /\bmv\b/.test(c) && /\/dev\/null/.test(c),
  },
  {
    reason: "清空文件内容",
    test: (c) => /\btruncate\b/.test(c) && /-s\s*0/.test(c),
  },
  {
    reason: "强推覆盖远端提交历史",
    test: (c) => /\bgit\s+push\b/.test(c) && /(--force\b|(\s|^)-f\b)/.test(c),
  },
  {
    reason: "丢弃本地未提交的修改",
    test: (c) => /\bgit\s+reset\b/.test(c) && /--hard\b/.test(c),
  },
  {
    reason: "删除未跟踪文件",
    test: (c) => /\bgit\s+clean\b/.test(c) && /-[a-zA-Z]*[fd]/.test(c),
  },
  {
    reason: "直接把网络脚本管道给 shell 执行",
    test: (c) => /\b(curl|wget)\b/.test(c) && /\|\s*(sudo\s+)?(ba|z|d|k)?sh\b/.test(c),
  },
  {
    reason: "删除匹配到的全部文件",
    test: (c) => /\bfind\b/.test(c) && /(-delete\b|-exec\s+rm\b)/.test(c),
  },
  {
    reason: "删除全部定时任务",
    test: (c) => /\bcrontab\b/.test(c) && /(\s|^)-r\b/.test(c),
  },
  {
    reason: "清空防火墙规则（可能直接暴露主机）",
    test: (c) => /\b(iptables|ip6tables|nft)\b/.test(c) && /(\s|^)-F\b/.test(c),
  },
  {
    reason: "删除数据库或数据表",
    test: (c) => /\b(drop\s+(database|table|schema)|truncate\s+table)\b/i.test(c),
  },
];

/** 检测一条完整命令，返回命中原因或 null。 */
export function inspect(command: string): string | null {
  const text = String(command || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  for (const rule of DANGER_RULES) {
    if (rule.test(text)) return rule.reason;
  }
  return null;
}
