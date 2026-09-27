/* 危险命令检测（全局强制约束：rm -rf / dd / mkfs 等必须二次确认）。
 *
 * 终端输入在本模块被本地追踪成「当前命令行」，用户按下回车时先做匹配，
 * 命中则不发送回车，改为弹出确认框；确认后由调用方把原始输入整段发往远端。
 *
 * 已知局限（在 FEATURES.md 中有记录）：
 * - 通过 shell 历史（↑）召回、光标移动后编辑的命令无法被完整追踪，此时标记
 *   为 stale 并跳过检测；追踪不完整的输入不予拦截，避免给出错误的「已检查」印象。
 * - 粘贴内容中的回车会导致整段输入一起被挂起等待确认。
 * - 真正权威的拦截点在 AI 助手生成的命令上（生成后先确认再注入终端）。
 */
(function (PShell) {
  "use strict";

  /** 判定规则。命中任意一条即视为危险，reason 会展示给用户。 */
  const RULES = [
    {
      reason: "递归强制删除文件或目录（-r 与 -f 同时出现）",
      test: (c) =>
        /\brm\b/.test(c) &&
        /(\s|^)-[a-zA-Z]*r/.test(c) &&
        /(\s|^)-[a-zA-Z]*f/.test(c),
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

  const CTRL_C = "\x03";
  const CTRL_U = "\x15";
  const CTRL_W = "\x17";
  const CTRL_D = "\x04";
  const BRACKET_PASTE_START = "\x1b[200~";
  const BRACKET_PASTE_END = "\x1b[201~";

  /** 检测一条完整命令，返回命中原因或 null。 */
  function inspect(command) {
    const text = String(command || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return null;
    for (const rule of RULES) {
      if (rule.test(text)) return rule.reason;
    }
    return null;
  }

  /**
   * 创建输入追踪器。每个终端会话一个实例。
   *
   * `feed(data)` 返回：
   * - `null`：本段输入可以原样发送
   * - `{ command, reason, stale }`：本段输入中出现了回车。`reason` 非空表示
   *   命中了危险规则，调用方必须**暂缓发送本段输入**并等待用户确认。
   */
  function createTracker() {
    let line = "";
    let stale = false;

    function reset() {
      line = "";
      stale = false;
    }

    function pushText(text) {
      // 粘贴进来的多行内容：逐字符喂入，回车处直接结算
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") continue;
        line += ch;
      }
    }

    function feed(data) {
      const text = String(data == null ? "" : data);
      if (!text) return null;

      const pastes = [];
      let i = 0;
      while (i < text.length) {
        const ch = text[i];

        if (ch === "\r" || ch === "\n") {
          const command = line.trim();
          const reason = stale ? null : inspect(command);
          const result = { command, reason, stale };
          reset();
          return result;
        }

        if (ch === "\x7f" || ch === "\b") {
          line = line.slice(0, -1);
          i += 1;
          continue;
        }

        if (ch === CTRL_C || ch === CTRL_U) {
          line = "";
          i += 1;
          continue;
        }

        if (ch === CTRL_W) {
          line = line.replace(/\S+\s*$/, "");
          i += 1;
          continue;
        }

        if (ch === "\x1b") {
          if (text.startsWith(BRACKET_PASTE_START, i)) {
            i += BRACKET_PASTE_START.length;
            continue;
          }
          if (text.startsWith(BRACKET_PASTE_END, i)) {
            i += BRACKET_PASTE_END.length;
            continue;
          }
          // 光标移动、历史召回等序列无法追踪，之后的行内容不可信
          stale = true;
          i += consumeEscape(text, i);
          continue;
        }

        if (ch < " ") {
          // Tab 补全、Ctrl+A/E 等会改变缓冲区内容，无法继续追踪
          if (ch !== CTRL_D) stale = true;
          i += 1;
          continue;
        }

        // 普通可见字符（含粘贴内容）
        const next = nextEscape(text, i);
        pastes.push(text.slice(i, next));
        i = next;
      }

      pastes.forEach(pushText);
      return null;
    }

    return {
      feed,
      get line() {
        return line;
      },
      get stale() {
        return stale;
      },
      reset,
    };
  }

  /** 跳过以 i 开头的转义序列，返回消耗的长度（至少 1）。 */
  function consumeEscape(text, i) {
    const rest = text.slice(i);
    const csi = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(rest);
    if (csi) return csi[0].length;
    const ss3 = /^\x1bO./.exec(rest);
    if (ss3) return ss3[0].length;
    return rest.length > 1 ? 2 : 1;
  }

  /** 找到下一个转义序列的起点，返回普通文本的结束位置。 */
  function nextEscape(text, i) {
    const idx = text.indexOf("\x1b", i);
    return idx === -1 ? text.length : idx;
  }

  PShell.danger = { inspect, createTracker, rules: RULES };
})(window.PShell);