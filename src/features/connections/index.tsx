import { useEffect } from "react";
import { openPanel as openHistory } from "../history/store";
import { openPanel as openPortForward } from "../port-forward/store";
import { openPanel as openSessionLog } from "../session-log/store";
import { openPanel as openSftp } from "../sftp/store";
import { openPanel as openSnippets } from "../snippets/store";
import { ConnectionForm } from "./ConnectionForm";
import { useConnections, wireDependencies } from "./store";

/**
 * 连接管理功能入口：侧栏列表 + 编辑弹窗 + 快捷连接显隐。
 *
 * 命令式 API 已由 app / tabs / sftp / port-forward / split / search / settings /
 * import-export / git-sync 直接 import，故不再挂 window.PTerm 桥接。
 */
export function ConnectionsFeature() {
  const state = useConnections();

  useEffect(() => {
    wireDependencies({
      sftp: { open: openSftp },
      portForward: { open: openPortForward },
      sessionLog: { open: openSessionLog },
      snippets: { open: openSnippets },
      history: { open: openHistory },
    });
  }, []);

  // 「快捷连接」输入框的容器由外壳持有，这里只同步它的显隐
  useEffect(() => {
    const quick = document.getElementById("quick-connect");
    if (quick) quick.hidden = !state.quickVisible;
  }, [state.quickVisible]);

  return <ConnectionForm />;
}
