/** 命令片段（与后端 snippet 结构一致）。 */
export interface Snippet {
  id: string;
  name: string;
  description: string;
  content: string;
  group_name: string | null;
  /** `{{name}}` 占位符名列表；识别在后端完成。 */
  variables: string[];
  updated_at: string;
}

/** 编辑中的草稿：字段与 Snippet 相同，新建时 id 为空串。 */
export type SnippetDraft = Snippet;

/** 面板视图：list = 片段库，edit = 单个片段的编辑 / 插入，两者不同时展示。 */
export type SnippetsView = "list" | "edit";
