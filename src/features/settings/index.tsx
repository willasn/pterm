import { useEffect } from "react";
import { KnownHostsModal } from "./KnownHostsModal";
import { SettingsModal } from "./SettingsModal";
import { open, reset, save, searchIndex } from "./store";

/**
 * 设置功能入口：面板 + 命令式 API 桥接。
 *
 * 既有调用方仍以 PTerm.settings.open() / save() / reset() / searchIndex() 驱动它：
 * app 的侧栏设置按钮与快捷键、全局搜索的设置索引与「打开某分类」。
 * 待这些调用点一并迁走后删除该桥接。
 */
export function SettingsFeature() {
  useEffect(() => {
    const p = ((window as any).PTerm = (window as any).PTerm || {});
    p.settings = { open, save, reset, searchIndex };
    return () => {
      if (p.settings && p.settings.open === open) delete p.settings;
    };
  }, []);

  return (
    <>
      <SettingsModal />
      <KnownHostsModal />
    </>
  );
}
