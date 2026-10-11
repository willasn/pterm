import { AutoUpdateBanner } from "./AutoUpdateBanner";

/**
 * 自动更新功能入口：右下角更新提示条。
 *
 * 状态与检查逻辑在 store（由 features/app 的启动流程按开关触发），这里只渲染提示。
 */
export function AutoUpdateFeature() {
  return <AutoUpdateBanner />;
}
