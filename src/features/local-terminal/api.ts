import { $ } from "../util/util";
import * as ssh from "../ssh/api";

/**
 * 本地终端（本机 PTY shell）。
 *
 * 会话编排完全复用 `ssh` 模块（同一套会话表 / 事件通道 / 标签体系），
 * 这里只负责入口按钮的显隐与发起，避免重复实现终端装配逻辑。
 */

/** 按功能开关显隐入口按钮。由 app 在配置变化时调用。 */
export function setEnabledFromConfig(config: any): void {
  const on = !!(
    config &&
    config.features &&
    config.features.connection &&
    config.features.connection.local_terminal
  );
  const btn = $("btn-local-term");
  if (btn) btn.hidden = !on;
}

/** 新建一个本地终端标签。 */
export function open(): void {
  void ssh.openLocal();
}
