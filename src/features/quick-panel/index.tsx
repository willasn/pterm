import { useEffect } from "react";
import { QuickPanelModal } from "./QuickPanelModal";
import { openPanel, setEnabledFromConfig } from "./store";

/**
 * 快捷面板功能入口（无侧栏徽标，仅由快捷键 app.quick_panel 唤起）。
 *
 * 同时把命令式 API 挂回 window.PTerm.quickPanel——既有调用方（app 的配置派发、
 * shortcuts 的 app.quick_panel 动作）仍以 PTerm.quickPanel.open() / setConfig() 驱动它。
 * 待这些调用点一并迁走后删除该桥接。
 */
export function QuickPanelFeature() {
  useEffect(() => {
    const p = ((window as any).PTerm = (window as any).PTerm || {});
    p.quickPanel = { setConfig: setEnabledFromConfig, open: openPanel };
    return () => {
      if (p.quickPanel && p.quickPanel.open === openPanel) delete p.quickPanel;
    };
  }, []);

  return <QuickPanelModal />;
}
