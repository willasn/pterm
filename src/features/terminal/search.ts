/**
 * 终端内搜索（scrollback 查找）。
 *
 * xterm.js 核心不含搜索能力（vendor 里只有 fit 插件），这里直接基于 buffer API
 * 扫描：逐行 `translateToString` 后做子串匹配，命中项记录「行 + 列 + 长度」，
 * 由调用方用 `term.select()` 高亮当前命中并滚动到可视区。
 *
 * 纯函数，不触碰 DOM / 终端状态，便于单测。
 */

export interface SearchMatch {
  /** 缓冲区行号（含回滚，0 为最顶端） */
  row: number;
  /** 行内起始列（0 基） */
  col: number;
  /** 命中长度（字符数，与查询串等长） */
  len: number;
}

/**
 * 在终端缓冲区（含回滚）中查找全部命中项。
 *
 * @param term xterm 实例
 * @param query 查询串；为空返回空数组
 * @param caseSensitive 是否区分大小写
 */
export function collectMatches(term: any, query: string, caseSensitive: boolean): SearchMatch[] {
  const out: SearchMatch[] = [];
  if (!query) return out;
  const buffer = term && term.buffer && term.buffer.active;
  if (!buffer || typeof buffer.getLine !== "function") return out;

  const needle = caseSensitive ? query : query.toLowerCase();
  const total = buffer.length;
  for (let row = 0; row < total; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    // trimRight=true：去掉行尾空白，避免回滚缓冲里的填充空格影响匹配
    const text = line.translateToString(true);
    if (!text) continue;
    const hay = caseSensitive ? text : text.toLowerCase();
    let at = hay.indexOf(needle);
    while (at !== -1) {
      out.push({ row, col: at, len: query.length });
      at = hay.indexOf(needle, at + needle.length);
    }
  }
  return out;
}

/**
 * 从 `fromRow` 开始向后找第一个命中项的下标；找不到则回绕到首个命中。
 * 无命中返回 -1。用于「输入即从当前位置向下定位」的交互。
 */
export function firstIndexFrom(matches: SearchMatch[], fromRow: number): number {
  if (!matches.length) return -1;
  const hit = matches.findIndex((m) => m.row >= fromRow);
  return hit >= 0 ? hit : 0;
}
