/** 归一化后的命中项：各数据源统一成这个形状后再打分与渲染。 */
export interface SearchHit {
  title: string;
  meta: string;
  /** 用于匹配的小写全文。 */
  hay: string;
  activate: () => void;
}

/** 一个数据源分组的命中结果。 */
export interface SearchGroup {
  label: string;
  /** 该分组命中的总条数（渲染时最多取前 PER_SOURCE 条）。 */
  count: number;
  hits: SearchHit[];
}

/** 设置项搜索索引项（由 legacy settings 模块的 searchIndex() 提供）。 */
export interface SettingIndexItem {
  title: string;
  subtitle?: string;
  keywords?: string;
  category: string;
}

/** 打开面板时一次性拉齐的数据源。 */
export interface SearchSources {
  connections: any[];
  snippets: any[];
  history: any[];
  settings: SettingIndexItem[];
}
