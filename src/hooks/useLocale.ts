import { useCallback, useEffect, useState } from "react";
import { t } from "../features/i18n/store";

/**
 * 当前界面语言。
 *
 * 既有的 i18n 在切换语言时会把语言写到 <html lang>，这里监听该属性变化来驱动 React 重渲染，
 * 从而不必改动既有模块、也能让已迁移的组件跟随语言切换。
 */
export function useLocale(): string {
  const [locale, setLocale] = useState(() => document.documentElement.lang || "zh-CN");

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setLocale(document.documentElement.lang || "zh-CN");
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    return () => observer.disconnect();
  }, []);

  return locale;
}

/** 翻译函数；语言切换时其引用会变化，从而触发使用方重渲染。 */
export function useT(): (key: string, fallback?: string, params?: Record<string, unknown>) => string {
  const locale = useLocale();
  return useCallback(
    (key: string, fallback?: string, params?: Record<string, unknown>) => {
      return t(key, fallback, params);
    },
    // locale 参与依赖：语言变化时生成新的 t，促使组件重渲染
    [locale]
  );
}
