/** 会话日志状态（由后端 session_log_status 返回）。 */
export interface SessionLogStatus {
  /** 日志目录。 */
  dir: string;
  /** 保留天数；为空或 0 表示不按天数自动清理。 */
  retention_days: number | null;
  /** 保留条数（最多保留的日志文件数）；为空或 0 表示不按条数自动清理。 */
  retention_count: number | null;
  /** 单个日志文件大小上限（KB）；为空或 0 表示不限。 */
  max_file_kb: number | null;
  /** 日志文件数。 */
  count: number;
  /** 正在记录的会话数。 */
  active: number;
}

/** 单个日志文件。 */
export interface SessionLogEntry {
  name: string;
  size: number;
  /** 修改时间（原样展示，不做格式化）。 */
  modified: string;
  /** 该文件对应的会话是否仍在记录。 */
  active: boolean;
}
