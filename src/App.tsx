import { useEffect } from "react";
import { AppShell } from "./app/AppShell";
import { AiFeature } from "./features/ai";
import { startApp } from "./features/app";
import { ConnectionsFeature } from "./features/connections";
import { ContextMenuFeature } from "./features/context-menu";
import { GitSyncFeature } from "./features/git-sync";
import { HistoryFeature } from "./features/history";
import { ImportExportFeature } from "./features/import-export";
import { OnboardingFeature } from "./features/onboarding";
import { PortForwardFeature } from "./features/port-forward";
import { QuickPanelFeature } from "./features/quick-panel";
import { SearchFeature } from "./features/search";
import { SessionLogFeature } from "./features/session-log";
import { SettingsFeature } from "./features/settings";
import { SftpFeature } from "./features/sftp";
import { SnippetsFeature } from "./features/snippets";
import { SplitFeature } from "./features/split";
import { SyncInputFeature } from "./features/sync-input";
import { TabsFeature } from "./features/tabs";
import { TerminalFeature } from "./features/terminal";
import { VaultFeature } from "./features/vault";

/**
 * 应用入口。
 *
 * 先由 React 渲染外壳（AppShell，即原 skeleton.html 的 JSX 版），再挂载各功能模块的
 * 组件；父组件副作用晚于子组件，待依赖注入等初始化就绪后，由 startApp 在外壳挂载完成
 * 的基础上绑定全局交互并拉取配置引导（见 features/app）。外壳无状态、只渲染一次，
 * 之后的 DOM 变更均由命令式模块（tabs / terminal / app）负责。
 */
export default function App() {
  useEffect(() => startApp(), []);

  return (
    <>
      <AppShell />
      {/* 各组件的 effect 先于下方引导执行：标签 / 终端等依赖注入与订阅在 startApp 前完成 */}
      <TabsFeature />
      <TerminalFeature />
      <ContextMenuFeature />
      <SnippetsFeature />
      <SearchFeature />
      <HistoryFeature />
      <QuickPanelFeature />
      <SessionLogFeature />
      <PortForwardFeature />
      <ImportExportFeature />
      <SftpFeature />
      <SettingsFeature />
      <GitSyncFeature />
      <VaultFeature />
      <OnboardingFeature />
      <SplitFeature />
      <SyncInputFeature />
      <ConnectionsFeature />
      <AiFeature />
    </>
  );
}
