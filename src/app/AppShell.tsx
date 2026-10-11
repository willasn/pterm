import { Dialogs } from "./Dialogs";
import { MainStack } from "./MainStack";
import { Sidebar } from "./Sidebar";

/**
 * 应用外壳（由原 skeleton.html 逐字转为 JSX 组件）。
 *
 * 保持命令式模块（tabs / terminal / app 引导）依赖的 id / 类名；
 * 连接列表、功能入口与停靠面板在外壳中直接渲染，弹窗继续挂到 body。
 */
export function AppShell() {
  return (
    <>
      <div className="app" id="app">
        <Sidebar />
        <MainStack />
      </div>
      <Dialogs />
    </>
  );
}
