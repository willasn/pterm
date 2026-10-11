/** 导入来源格式。 */
export type ImportFormat = "auto" | "pterm" | "ssh_config";

/** 导入结果报告（由后端 connection_import 返回）。 */
export interface ImportReport {
  format: string;
  /** 新建的连接数。 */
  imported: number;
  /** 因重复等原因跳过的条数。 */
  skipped: number;
  /** 新建连接的摘要，用于展示。 */
  connections: any[];
  /** 解析过程中的告警（如不支持的字段）。 */
  warnings: string[];
}

/** 导入导出相关默认路径（由后端 import_export_defaults 返回）。 */
export interface ImportExportDefaults {
  home_dir: string;
  ssh_config_path: string;
}
