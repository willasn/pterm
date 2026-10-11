/**
 * 过渡访问入口（渐进式迁移桥接）。
 *
 * 绝大多数模块已可直接 import。这里的 pt() 只服务仍需经 window.PTerm 协作的少数模块
 * （git-sync / search 反向依赖 app，静态 import 会成环；settings / quick-panel 的面板入口），
 * 它们在 App 挂载后才就位，故一律惰性取值，不能在模块顶层解构。
 *
 * 另有 errorText / toast 与 featureFlags / auxiliaryFlags 等纯工具，供各模块直接复用。
 */
export function pt(): any {
  return (window as any).PTerm || {};
}

// 轻提示与错误文案已迁为 ES 模块，直接复用（保证与全局提示样式一致）。
export { errorText, toast } from "../features/util/util";

/** 取配置里某个功能分组的开关集合（如 auxiliary / connection）。 */
export function featureFlags(config: unknown, group: string): Record<string, boolean> {
  const features = (config as any)?.features || {};
  return features[group] || {};
}

/** 取配置里的「辅助功能」开关集合。 */
export function auxiliaryFlags(config: unknown): Record<string, boolean> {
  return featureFlags(config, "auxiliary");
}
