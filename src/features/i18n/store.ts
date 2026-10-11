/**
 * 多语言 i18n（由原 src/legacy/i18n.ts 迁移而来）。
 *
 * 中文作为内置基线直接写在 HTML / JS 里，英文经 src/public/locales/en-US.json 外置。
 * `t(key, fallback, params)` 在当前语言为 zh-CN（基线）时直接返回 fallback（中文原文），
 * 否则从当前语言包取 key；`{x}` 形式的占位符用 params 插值。
 *
 * 外壳文案用 `data-i18n` / `data-i18n-title` 标记，原文即 fallback；
 * 动态渲染的文案在渲染时用 `t()` 包裹。语言写入 `<html lang>`，React 侧由
 * src/hooks/useLocale.ts 监听该属性变化重渲染。
 */

const BASELINE = "zh-CN";
const DIR = "locales/";

export type TranslateParams = Record<string, unknown>;

interface State {
  locale: string;
  dict: Record<string, string> | null;
  loading: Promise<void> | null;
}

const state: State = {
  locale: BASELINE,
  dict: null,
  loading: null,
};

// 记录节点被替换前的原文，保证切回中文时能复原（HTML 里写的中文即原文）。
const originals = new WeakMap<Element, { text: string | null; title: string | null }>();

/** 取翻译：命中语言包用电文，否则回落 fallback（未给 fallback 时用 key 本身）。 */
export function t(key: string, fallback?: string | null, params?: TranslateParams): string {
  let text: string;
  if (key && state.dict && Object.prototype.hasOwnProperty.call(state.dict, key)) {
    text = state.dict[key];
  } else {
    text = fallback == null || fallback === "" ? key : String(fallback);
  }
  if (params) {
    text = text.replace(/\{(\w+)\}/g, (match, name: string) =>
      params[name] != null ? String(params[name]) : match
    );
  }
  return text;
}

function original(node: Element): { text: string | null; title: string | null } {
  if (!originals.has(node)) {
    originals.set(node, {
      text: node.textContent,
      title: node.getAttribute("title"),
    });
  }
  return originals.get(node) as { text: string | null; title: string | null };
}

/** 同步遍历界面里的 data-i18n 标记并应用当前语言。 */
export function apply(): void {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n ?? "", original(node).text);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((node) => {
    const value = t(node.dataset.i18nTitle ?? "", original(node).title || "");
    if (value) node.setAttribute("title", value);
    else node.removeAttribute("title");
  });
}

async function load(locale: string): Promise<Record<string, string>> {
  const resp = await fetch(DIR + locale + ".json");
  if (!resp.ok) throw new Error("i18n: failed to load " + locale);
  return resp.json();
}

/** 切换语言：加载语言包或回落中文，然后应用到 DOM。返回加载完成的 Promise。 */
export function setLocale(locale?: string | null): Promise<void> {
  const next = locale || BASELINE;
  state.locale = next;
  state.loading = (async () => {
    try {
      if (next === BASELINE) {
        state.dict = null;
      } else {
        state.dict = await load(next);
      }
      document.documentElement.lang = next;
      apply();
    } catch (err) {
      // 语言包缺失 / 出错时回退中文，不让空白界面卡住用户
      console.warn("[i18n]", (err as Error)?.message || err);
      state.dict = null;
      apply();
    }
  })();
  return state.loading;
}

/** 应用配置：由 app 在启动 / 保存设置 / 重置时调用。 */
export function setConfig(config: unknown): Promise<void> {
  return setLocale((config as { language?: string } | null)?.language || BASELINE);
}

export function ready(): Promise<void> {
  return state.loading || Promise.resolve();
}
