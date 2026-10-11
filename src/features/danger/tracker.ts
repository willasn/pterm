import { inspect } from "./rules";

/**
 * 终端输入追踪器（由原 src/legacy/danger.ts 迁移而来）。
 *
 * 终端输入在本模块被本地追踪成「当前命令行」，用户按下回车时先做匹配，命中则返回
 * 判定结果，由调用方暂缓发送并弹出确认框。
 *
 * 已知局限（见 FEATURES.md）：
 * - 通过 shell 历史（↑）召回、光标移动后编辑的命令无法被完整追踪，此时标记为 stale
 *   并跳过检测；追踪不完整的输入不予拦截，避免给出错误的「已检查」印象。
 * - 粘贴内容中的回车会导致整段输入一起被挂起等待确认。
 * - 真正权威的拦截点在 AI 助手生成的命令上（生成后先确认再注入终端）。
 */

export interface DangerVerdict {
  /** 结算出的完整命令行（已 trim）。 */
  command: string;
  /** 命中的危险规则说明；非空表示调用方必须暂缓发送本段输入并等待用户确认。 */
  reason: string | null;
  /** 追踪是否已不可信（历史召回、光标移动等）；stale 时不拦截。 */
  stale: boolean;
}

export interface InputTracker {
  /** 喂入一段终端输入。返回 null 表示本段可原样发送；返回判定结果表示其中出现了回车。 */
  feed(data: string): DangerVerdict | null;
  readonly line: string;
  readonly stale: boolean;
  reset(): void;
}

const CTRL_C = "\x03";
const CTRL_U = "\x15";
const CTRL_W = "\x17";
const CTRL_D = "\x04";
const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";

/** 跳过以 i 开头的转义序列，返回消耗的长度（至少 1）。 */
function consumeEscape(text: string, i: number): number {
  const rest = text.slice(i);
  const csi = /^\x1b\[[0-9;?]*[a-zA-Z]/.exec(rest);
  if (csi) return csi[0].length;
  const ss3 = /^\x1bO./.exec(rest);
  if (ss3) return ss3[0].length;
  return rest.length > 1 ? 2 : 1;
}

/** 找到下一个转义序列的起点，返回普通文本的结束位置。 */
function nextEscape(text: string, i: number): number {
  const idx = text.indexOf("\x1b", i);
  return idx === -1 ? text.length : idx;
}

/** 创建一个输入追踪器。每个终端会话一个实例。 */
export function createTracker(): InputTracker {
  let line = "";
  let stale = false;

  function reset(): void {
    line = "";
    stale = false;
  }

  function pushText(text: string): void {
    // 粘贴进来的多行内容：逐字符喂入，回车处直接结算
    for (const ch of text) {
      if (ch === "\r" || ch === "\n") continue;
      line += ch;
    }
  }

  function feed(data: string): DangerVerdict | null {
    const text = String(data == null ? "" : data);
    if (!text) return null;

    const pastes: string[] = [];
    let i = 0;
    while (i < text.length) {
      const ch = text[i];

      if (ch === "\r" || ch === "\n") {
        const command = line.trim();
        const reason = stale ? null : inspect(command);
        const result: DangerVerdict = { command, reason, stale };
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
