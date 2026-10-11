import { useEffect } from "react";
import { GitSyncModal } from "./GitSyncModal";
import { openPanel, refresh, setEnabledFromConfig, subscribeConfigUpdated } from "./store";

/**
 * Git 同步功能入口：侧栏徽标 + 面板 + 配置更新订阅。
 *
 * 同时把命令式 API 挂回 window.PTerm.gitSync——既有调用方（app 的配置派发、
 * 设置面板改密后的自动同步、保险库模块）仍以 PTerm.gitSync.refresh() / setConfig() 驱动它。
 * 待这些调用点一并迁走后删除该桥接。
 */
export function GitSyncFeature() {
  useEffect(() => {
    const p = ((window as any).PTerm = (window as any).PTerm || {});
    p.gitSync = { setConfig: setEnabledFromConfig, open: openPanel, refresh };
    return () => {
      if (p.gitSync && p.gitSync.open === openPanel) delete p.gitSync;
    };
  }, []);

  // 同步导入会改动本地配置，订阅后端的 config-updated 事件重新拉取
  useEffect(() => subscribeConfigUpdated(), []);

  return <GitSyncModal />;
}
