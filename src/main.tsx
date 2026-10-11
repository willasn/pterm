import { createRoot } from "react-dom/client";
import App from "./App";

// 样式加载顺序与原 index.html 的 <link> 保持一致（后加载者优先级更高）
import "./styles/theme.css";
import "./styles/base.css";
import "./styles/terminal.css";
import "./styles/settings.css";
import "./styles/react-shell.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("缺少 #root 挂载点");
}

// 不使用 StrictMode：命令式模块（tabs / terminal / app 引导）在开发模式下的双重执行会重复绑定事件/会话。
createRoot(container).render(<App />);
