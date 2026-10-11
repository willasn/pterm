/** 一条 SFTP 会话（由后端 sftp_connect / sftp_sessions 返回）。 */
export interface SftpSession {
  id: string;
  name: string;
  host: string;
  username: string;
  port: string | number;
  /** 会话建立后默认进入的家目录。 */
  home: string;
}

/** 远端目录条目。 */
export interface SftpEntry {
  name: string;
  path: string;
  size: number;
  mode: number;
  /** Unix 秒。 */
  modified: number;
  is_dir: boolean;
  is_symlink: boolean;
}

/** 一次目录列举的结果。 */
export interface SftpListing {
  path: string;
  entries: SftpEntry[];
}

export type TransferDirection = "upload" | "download";

export type TransferStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "cancelled"
  | "done"
  | "error";

/** 传输队列中的一项。run 由入队方提供，入参是传输 id。 */
export interface TransferItem {
  id: string;
  label: string;
  direction: TransferDirection;
  /** 完成后是否刷新当前目录（上传会改变目录内容）。 */
  refresh: boolean;
  sessionId: string | null;
  status: TransferStatus;
  transferred: number;
  total: number;
  /** 完成后回填的实际字节数。 */
  bytes: number;
  cancelled: boolean;
  error: string | null;
  startedAt: number;
  endedAt: number;
  run: (transferId: string) => Promise<unknown>;
}

/** 入队时提供的描述（id / 状态等由队列补齐）。 */
export interface TransferSpec {
  label: string;
  direction: TransferDirection;
  sessionId?: string | null;
  refresh?: boolean;
  run: (transferId: string) => Promise<unknown>;
}

/** 传输进度事件负载（后端 sftp:progress）。 */
export interface SftpProgressPayload {
  id: string;
  transferred: number;
  total?: number;
}

/** 重命名 / 改权限的内联编辑器。 */
export interface EditorState {
  kind: "rename" | "chmod";
  entry: SftpEntry;
  value: string;
}
