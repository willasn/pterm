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
