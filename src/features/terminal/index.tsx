import { useEffect } from "react";
import { wireDependencies } from "./api";
import * as ai from "../ai/store";
import * as connections from "../connections/store";
import * as ssh from "../ssh/api";
import * as syncInput from "../sync-input/store";

/** 终端依赖在应用启动前由子组件 effect 注入。 */
export function TerminalFeature() {
  useEffect(() => {
    wireDependencies({ ssh, syncInput, ai, connections });
  }, []);
  return null;
}
