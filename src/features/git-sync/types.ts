/** Git 同步状态（git_sync_status 返回）。 */
export interface GitRemote {
  name?: string;
  url?: string;
  branch?: string | null;
  username?: string | null;
}

export interface GitStatus {
  remotes: GitRemote[];
  /** 本地领先远端的提交数。 */
  ahead: number;
  /** 落后远端的提交数。 */
  behind: number;
  /** 已跟踪但未提交的改动数。 */
  dirty: number;
  /** 未跟踪文件数。 */
  untracked: number;
  last_sync_at?: string | null;
  last_result?: string | null;
  last_error?: string | null;
  scope?: string;
}

/** 同步 / 解决冲突的返回。 */
export interface SyncOutcome {
  message?: string;
  /** 需要用户决策的冲突文件名（如 connections.json / snippets.json）。 */
  conflicts?: string[];
}

/** 冲突处理方式。 */
export type ConflictChoice = "remote" | "local" | "both";

/** 激活码授权状态（license_status 返回）。 */
export interface LicenseStatus {
  /** free | active | expiring | grace | locked | needs_activation | clock_rollback */
  state: string;
  /** 是否已解锁 Git 同步。 */
  unlocked: boolean;
  plan?: string | null;
  expires_at?: string | null;
  grace_ends_at?: string | null;
  days_left?: number | null;
  /** 已激活授权码（脱敏）。 */
  key_hint?: string | null;
  device_id?: string | null;
  message: string;
}
