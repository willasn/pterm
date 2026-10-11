import { errorText, featureFlags, pt, toast } from "../../lib/legacy";
import { ipc } from "../ipc/api";
import { ask } from "../util/util";
import type { RdpClientStatus, RdpOpenInput, RdpProbeResult } from "./types";

/**
 * 远程桌面（RDP）入口（由原 src/legacy/rdp.ts 迁移而来）。
 *
 * 只在 features.connection.rdp 打开时可用：关闭时前端不显示协议选项与相关菜单，
 * 后端 command 也会以 ModuleDisabled 拒绝。
 *
 * 本模块不解析 RDP 协议，而是把连接交给现成的客户端：
 * - Windows：后端生成 .rdp 文件后拉起系统自带的 mstsc；有密码时先写进系统凭据管理器免密登录。
 * - macOS：后端生成 .rdp 文件后交给微软官方「Windows App」（原 Microsoft Remote
 *   Desktop）打开，pterm 只负责保存会话；未安装时引导用户去 Mac App Store 安装。
 *
 * 无 UI：由 connections 的右键菜单 / 连接打开流程调用，因此不涉及 React 渲染。
 */

/** 后端返回的客户端种类 → 提示文案 */
const CLIENT_LABEL: Record<string, string> = {
  mstsc: "系统远程桌面（mstsc）",
  windows_app: "微软 Windows App",
};

/** features.connection.rdp 是否开启 */
let enabled = false;
/** 缓存的客户端探测结果；null = 尚未探测 */
let clientStatus: RdpClientStatus | null = null;

/** 由 app.ts 在配置变化时调用（启动、保存设置、重置）。 */
export function setEnabledFromConfig(config: unknown): void {
  const next = !!featureFlags(config, "connection").rdp;
  // 关闭再开启时客户端可能已安装 / 卸载，缓存作废
  if (!next) clientStatus = null;
  enabled = next;
}

/** 探测本机 RDP 客户端，结果缓存。 */
export async function available(): Promise<RdpClientStatus | null> {
  if (clientStatus) return clientStatus;
  try {
    clientStatus = (await ipc.rdpClientAvailable()) as RdpClientStatus;
  } catch {
    clientStatus = null;
  }
  return clientStatus;
}

/** StoredConnection → rdp_open 入参。 */
function inputFor(conn: any, extra?: Partial<RdpOpenInput>): RdpOpenInput {
  return Object.assign(
    {
      connection_id: conn.id || null,
      host: (conn.host || "").trim(),
      port: conn.port || 3389,
      username: (conn.username || "").trim(),
      domain: (conn.domain || "").trim() || null,
      password: null,
    },
    extra || {}
  );
}

export async function open(conn: any, extra?: Partial<RdpOpenInput>): Promise<void> {
  if (!enabled) {
    toast("远程桌面已关闭，请在「设置 → 功能开关」中启用", "info");
    return;
  }
  if (!conn.host || !conn.host.trim()) {
    toast("该连接缺少主机地址", "error");
    return;
  }
  const status = await available();
  if (status && !status.available) {
    await guideInstall(status);
    return;
  }
  try {
    const result = (await ipc.rdpOpen(inputFor(conn, extra))) as { client: string };
    const client = CLIENT_LABEL[result.client] || "远程桌面客户端";
    toast(`已用 ${client} 打开 ${conn.host.trim()}`, "ok");
  } catch (err) {
    toast(errorText(err), "error");
  }
}

/**
 * 未检测到 RDP 客户端时的引导。
 *
 * 只有 macOS（kind = windows_app）能一键跳转 Mac App Store 安装；其它平台给不出可执行
 * 的安装动作，直接说明原因即可。
 */
async function guideInstall(status: RdpClientStatus): Promise<void> {
  const hint = (status && status.hint) || "未检测到可用的远程桌面客户端";
  if (!status || status.kind !== "windows_app") {
    toast(hint, "error");
    return;
  }
  const go = await ask(`${hint}。是否现在前往 Mac App Store 安装？`, {
    title: "需要安装远程桌面客户端",
    okText: "前往 App Store",
    cancelText: "暂不",
    kind: "info",
  });
  if (!go) return;
  try {
    await ipc.rdpOpenInstaller();
    // 安装结果无法即时得知，作废缓存，下次点击重新探测
    clientStatus = null;
  } catch (err) {
    toast(errorText(err), "error");
  }
}

/** 探测目标 RDP 端口是否可达。 */
export async function probe(conn: any): Promise<RdpProbeResult | undefined> {
  if (!conn || !conn.host || !conn.host.trim()) {
    toast("请先填写主机", "error");
    return;
  }
  try {
    const result = (await ipc.rdpProbe(
      conn.host.trim(),
      conn.port || 3389,
      3000
    )) as RdpProbeResult;
    toast(
      (result.reachable ? "端口可达：" : "端口不可达：") + result.message,
      result.reachable ? "ok" : "error"
    );
    return result;
  } catch (err) {
    toast(errorText(err), "error");
  }
}

/** 复制连接保存在保险库中的密码。 */
export async function copyPassword(conn: any): Promise<void> {
  if (!conn || !conn.id) {
    toast("请先保存连接后再复制密码", "error");
    return;
  }
  try {
    const password = (await ipc.rdpSavedPassword(conn.id)) as string | null;
    if (!password) {
      toast("该连接尚未保存密码", "info");
      return;
    }
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      toast("当前环境不支持剪贴板", "error");
      return;
    }
    await navigator.clipboard.writeText(password);
    toast("密码已复制到剪贴板", "ok");
  } catch (err) {
    toast(errorText(err), "error");
  }
}
