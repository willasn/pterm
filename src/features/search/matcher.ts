import type { SearchHit } from "./types";

/**
 * 模糊匹配：空格分隔的关键词需全部命中（AND），标题命中权重更高。
 * 与原 src/legacy/search.ts 的打分保持一致。
 */

export function termsOf(raw: string): string[] {
  return String(raw || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** 子串打分：命中越靠前、越贴近词首越相关；-1 表示不匹配。 */
export function score(hay: string, term: string): number {
  const idx = hay.indexOf(term);
  if (idx < 0) return -1;
  if (idx === 0) return 100;
  return /[\s/._\-·:|@]/.test(hay.charAt(idx - 1)) ? 60 : 30;
}

/** 任一词不匹配则整体不匹配（-1）。 */
export function rank(item: Pick<SearchHit, "title" | "hay">, terms: string[]): number {
  const title = item.title.toLowerCase();
  let total = 0;
  terms.forEach((term) => {
    const inTitle = score(title, term);
    const inHay = score(item.hay, term);
    if (inTitle < 0 && inHay < 0) {
      total = -1;
      return;
    }
    if (total < 0) return;
    total += inTitle >= 0 ? inTitle + 20 : inHay;
  });
  return total;
}
