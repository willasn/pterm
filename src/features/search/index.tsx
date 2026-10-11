import { useEffect } from "react";
import { SearchModal } from "./SearchModal";
import { openPanel, refresh, setEnabledFromConfig } from "./store";

/**
 * 全局搜索功能入口：侧栏入口 + 面板。
 *
 * 同时把命令式 API 挂回 window.PTerm.search——既有调用方（app 的配置派发、
 * shortcuts 的 app.search 动作）仍以 PTerm.search.open() / setConfig() 驱动它。
 * 待这些调用点一并迁走后删除该桥接。
 */
export function SearchFeature() {
  useEffect(() => {
    const p = ((window as any).PTerm = (window as any).PTerm || {});
    p.search = { setConfig: setEnabledFromConfig, open: openPanel, refresh };
    return () => {
      if (p.search && p.search.open === openPanel) delete p.search;
    };
  }, []);

  return <SearchModal />;
}
