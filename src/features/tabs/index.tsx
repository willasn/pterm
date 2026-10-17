import { useEffect } from "react";
import { wireDependencies } from "./store";
import { renderBadge } from "../ai/store";
import { openPanel as openPortForward } from "../port-forward/store";
import { openFor as openSftpFor, openPanel as openSftp } from "../sftp/store";
import { openPanel as openSnippets } from "../snippets/store";
import * as split from "../split/store";
import * as ssh from "../ssh/api";
import * as syncInput from "../sync-input/store";
import * as terminal from "../terminal/api";

/** 标签依赖在应用启动前由子组件 effect 注入。 */
export function TabsFeature() {
  useEffect(() => {
    wireDependencies({
      terminal,
      ssh,
      split,
      syncInput,
      sftp: { open: openSftp, openFor: openSftpFor },
      portForward: { open: openPortForward },
      snippets: { open: openSnippets },
      ai: { renderBadge },
    });
  }, []);
  return null;
}
