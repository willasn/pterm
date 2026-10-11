import { OnboardingGate } from "./OnboardingGate";

/** 首次启动引导入口：语言选择屏（app 已直接 import run）。 */
export function OnboardingFeature() {
  return <OnboardingGate />;
}
