/** 面板里列出的一条动作（来自 legacy shortcuts 的动作注册表快照）。 */
export interface QuickAction {
  id: string;
  label: string;
  hint: string;
  /** 当前为该动作绑定的组合键；未绑定时为空串。 */
  keys: string;
}
