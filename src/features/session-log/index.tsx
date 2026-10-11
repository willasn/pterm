import { SessionLogModal } from "./SessionLogModal";

/** 会话日志入口：面板（connections / tabs 右键菜单、app 配置派发已直接 import store）。 */
export function SessionLogFeature() {
  return <SessionLogModal />;
}
