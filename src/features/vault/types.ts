/** 保险库状态（vault_status 返回）。 */
export interface VaultStatus {
  /** 是否已设置主密码。 */
  configured: boolean;
  /** 当前是否已解锁。 */
  unlocked: boolean;
  /** Git 同步导入的保险库与本机主密码不一致。 */
  conflict?: boolean;
}
