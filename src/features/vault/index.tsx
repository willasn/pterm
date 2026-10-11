import { VaultGate } from "./VaultGate";

/** 主密码保险库功能入口：门禁弹窗（app 已直接 import ensureUnlocked）。 */
export function VaultFeature() {
  return <VaultGate />;
}
