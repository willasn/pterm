/** 命令历史条目（与后端聚合查询返回结构一致）。 */
export interface HistoryEntry {
  command: string;
  host: string;
  /** 去重模式下的使用次数（原始记录每条为 1）。 */
  uses: number;
  executed_at: string;
}

/** 列表排序方式：最近使用 / 最常用（非去重模式下频率排序无意义）。 */
export type HistoryOrder = "recent" | "frequent";
