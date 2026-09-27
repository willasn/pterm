/* 多语言 i18n（FEATURES.md §6）。
 *
 * 中文作为内置基线直接写在 HTML / JS 里，英文经 src/locales/en-US.json 外置。
 * `t(key, fallback, params)` 在 i18n 关闭或当前语言为 zh-CN 时直接返回 fallback（中文原文），
 * 否则从当前语言包取 key；`{x}` 形式的占位符用 params 插值。
 *
 * 静态骨架文案用 `data-i18n` / `data-i18n-title` 标记，原文即 fallback；
 * 动态渲染的文案在渲染时用 `t()` 包裹（见 settings.js / app.js）。 */
(function (PShell) {
  "use strict";

  const BASELINE = "zh-CN";
  const DIR = "locales/";

  const state = {
    locale: BASELINE,
    enabled: false,
    dict: null,
    loading: null,
  };

  // 记录节点被替换前的原文，保证切回中文时能复原（HTML 里写的中文即原文）。
  const originals = new WeakMap();

  /** 取翻译：命中语言包用电包文案，否则回落 fallback（未给 fallback 时用 key 本身）。 */
  function t(key, fallback, params) {
    let text;
    if (key && state.dict && Object.prototype.hasOwnProperty.call(state.dict, key)) {
      text = state.dict[key];
    } else {
      text = fallback == null || fallback === "" ? key : String(fallback);
    }
    if (params) {
      text = text.replace(/\{(\w+)\}/g, (match, name) =>
        params[name] != null ? String(params[name]) : match
      );
    }
    return text;
  }

  function original(node) {
    if (!originals.has(node)) {
      originals.set(node, {
        text: node.textContent,
        title: node.getAttribute("title"),
      });
    }
    return originals.get(node);
  }

  /** 同步遍历界面里的 data-i18n 标记并应用当前语言。 */
  function apply() {
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      node.textContent = t(node.dataset.i18n, original(node).text);
    });
    document.querySelectorAll("[data-i18n-title]").forEach((node) => {
      const value = t(node.dataset.i18nTitle, original(node).title || "");
      if (value) node.setAttribute("title", value);
      else node.removeAttribute("title");
    });
  }

  async function load(locale) {
    const resp = await fetch(DIR + locale + ".json");
    if (!resp.ok) throw new Error("i18n: failed to load " + locale);
    return resp.json();
  }

  /** 切换语言：加载语言包或回落中文，然后应用到 DOM。返回加载完成的 Promise。 */
  function setLocale(locale) {
    const next = locale || BASELINE;
    state.locale = next;
    state.loading = (async () => {
      try {
        if (!state.enabled || next === BASELINE) {
          state.dict = null;
        } else {
          state.dict = await load(next);
        }
        document.documentElement.lang = state.enabled && next !== BASELINE ? next : BASELINE;
        apply();
      } catch (err) {
        // 语言包缺失 / 出错时回退中文，不让空白界面卡住用户
        console.warn("[i18n]", (err && err.message) || err);
        state.dict = null;
        apply();
      }
    })();
    return state.loading;
  }

  /** 应用配置：由 app.js 在启动 / 保存设置 / 重置时调用。 */
  function setConfig(config) {
    const features = (config && config.features) || {};
    state.enabled = !!((features.auxiliary || {}).i18n);
    return setLocale((config && config.language) || BASELINE);
  }

  function ready() {
    return state.loading || Promise.resolve();
  }

  PShell.i18n = { t, setLocale, setConfig, apply, ready };
})(window.PShell);