import { useSyncExternalStore } from "react";
import { errorText, featureFlags, toast } from "../../lib/legacy";
import { refresh as refreshConnections } from "../connections/store";
import { ipc } from "../ipc/api";
import type { ImportExportDefaults, ImportFormat, ImportReport } from "./types";

/**
 * 连接导入导出的状态与行为（由原 src/legacy/import_export.ts 迁移而来）。
 *
 * 只在 features.connection.import_export 打开时可用：关闭时侧栏入口隐藏、
 * 面板不加载，后端 command 也会以 ModuleDisabled 拒绝。
 * 导出**永不包含凭据**：密码 / passphrase 只在加密保险库里，导出结构里没有这些字段；
 * 导入一律新建连接（重新分配 id、不覆盖已有配置），支持 pterm 导出文件与
 * OpenSSH 的 ~/.ssh/config。文件读写全部在 Rust 侧完成，前端只负责取路径。
 */

export const FORMATS: { value: ImportFormat; label: string }[] = [
  { value: "auto", label: "自动识别" },
  { value: "pterm", label: "pterm 导出文件" },
  { value: "ssh_config", label: "OpenSSH 配置（ssh config）" },
];

/** 选择集：null 表示全选。 */
type Selection = Set<string> | null;

export interface ImportExportState {
  enabled: boolean;
  busy: boolean;
  connections: any[];
  selection: Selection;
  defaults: ImportExportDefaults | null;
  format: ImportFormat;
  importPath: string;
  report: ImportReport | null;
  lastError: string | null;
  open: boolean;
}

const initialState: ImportExportState = {
  enabled: false,
  busy: false,
  connections: [],
  selection: null,
  defaults: null,
  format: "auto",
  importPath: "",
  report: null,
  lastError: null,
  open: false,
};

let state: ImportExportState = initialState;
const listeners = new Set<() => void>();

function setState(patch: Partial<ImportExportState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): ImportExportState {
  return state;
}

export function useImportExport(): ImportExportState {
  return useSyncExternalStore(subscribe, getState, getState);
}

// ---------------------------------------------------------------------------
// 派生数据与工具
// ---------------------------------------------------------------------------

/** 真正参与导出的连接 id。全选时返回全部。 */
export function selectedIds(): string[] {
  const ids = state.connections.map((c) => c.id);
  if (!state.selection) return ids;
  return ids.filter((id) => state.selection!.has(id));
}

export function isChecked(id: string): boolean {
  return !state.selection || state.selection.has(id);
}

export function formatLabel(value: string): string {
  const hit = FORMATS.filter((f) => f.value === value)[0];
  return hit ? hit.label : String(value || "");
}

/** ssh config 默认路径（未取到 defaults 时为空串）。 */
export function sshConfigPath(): string {
  return (state.defaults && state.defaults.ssh_config_path) || "";
}

function homeDir(): string {
  return (state.defaults && state.defaults.home_dir) || "";
}

function joinPath(dir: string, name: string): string {
  const base = String(dir || "").replace(/[\\/]+$/, "");
  if (!base) return name;
  const sep = base.indexOf("\\") >= 0 && base.indexOf("/") < 0 ? "\\" : "/";
  return base + sep + name;
}

function baseName(path: string): string {
  const parts = String(path || "").split(/[\\/]/);
  return parts[parts.length - 1] || String(path || "");
}

function dialogApi(): any {
  return (window as any).__TAURI__?.dialog || null;
}

// ---------------------------------------------------------------------------
// 选择集变更
// ---------------------------------------------------------------------------

/** 勾选 / 取消勾选一条连接；全选状态在内部归一化为 null。 */
export function toggle(id: string, on: boolean): void {
  const all = state.connections.map((c) => c.id);
  const next = state.selection ? new Set(state.selection) : new Set(all);
  if (on) next.add(id);
  else next.delete(id);
  setState({ selection: next.size === all.length ? null : next });
}

export function selectAll(): void {
  setState({ selection: null });
}

export function selectNone(): void {
  setState({ selection: new Set() });
}

export function setFormat(format: ImportFormat): void {
  setState({ format });
}

export function setImportPath(importPath: string): void {
  setState({ importPath });
}

// ---------------------------------------------------------------------------
// 行为
// ---------------------------------------------------------------------------

async function loadConnections(): Promise<void> {
  let connections: any[] = [];
  try {
    connections = ((await ipc.listConnections()) || []) as any[];
  } catch {
    connections = [];
  }
  setState({ connections, selection: null });
}

async function loadDefaults(): Promise<void> {
  let defaults: ImportExportDefaults | null = null;
  try {
    defaults = (await ipc.importExportDefaults()) as ImportExportDefaults;
  } catch {
    defaults = null;
  }
  setState({ defaults });
  if (!state.importPath) setState({ importPath: (defaults && defaults.ssh_config_path) || "" });
}

export async function refresh(): Promise<void> {
  if (!state.enabled) {
    setState({ connections: [], selection: null, importPath: "", report: null, lastError: null });
    return;
  }
  await loadConnections();
}

async function pickSavePath(): Promise<string | null> {
  const dialog = dialogApi();
  if (!dialog || typeof dialog.save !== "function") {
    toast("当前环境不支持文件保存对话框", "error");
    return null;
  }
  try {
    return await dialog.save({
      title: "导出连接配置",
      defaultPath: joinPath(homeDir(), "pterm-connections.json"),
    });
  } catch (err) {
    toast(errorText(err), "error");
    return null;
  }
}

export async function exportTo(): Promise<void> {
  if (state.busy) return;
  const ids = selectedIds();
  if (!ids.length) {
    toast("请至少选择一个连接", "error");
    return;
  }
  const target = await pickSavePath();
  if (!target) return;
  setState({ busy: true });
  try {
    const info = (await ipc.connectionExport(target, ids)) as { count: number; path: string };
    toast(`已导出 ${info.count} 个连接到 ${baseName(info.path)}`, "ok");
  } catch (err) {
    toast(errorText(err), "error");
  } finally {
    setState({ busy: false });
    await refresh();
  }
}

export async function pickFile(): Promise<void> {
  const dialog = dialogApi();
  if (!dialog || typeof dialog.open !== "function") {
    toast("当前环境不支持文件选择对话框", "error");
    return;
  }
  let picked: string | string[] | null = null;
  try {
    picked = await dialog.open({
      title: "选择要导入的文件",
      multiple: false,
      directory: false,
      defaultPath: state.importPath || sshConfigPath(),
    });
  } catch (err) {
    toast(errorText(err), "error");
    return;
  }
  const path = Array.isArray(picked) ? picked[0] : picked;
  if (!path) return;
  setState({ importPath: path, report: null });
}

export async function runImport(): Promise<void> {
  if (state.busy) return;
  const path = String(state.importPath || "").trim();
  if (!path) {
    toast("请先选择要导入的文件", "error");
    return;
  }
  setState({ busy: true });
  try {
    const report = (await ipc.connectionImport(path, state.format)) as ImportReport;
    setState({ report, lastError: null });
    const detail = report.skipped ? `，跳过 ${report.skipped} 个重复` : "";
    toast(`导入完成：新建 ${report.imported} 个连接${detail}`, "ok");
    if (report.imported > 0) await refreshConnections();
  } catch (err) {
    const message = errorText(err);
    setState({ report: null, lastError: message });
    toast(message, "error");
  } finally {
    setState({ busy: false });
    await refresh();
  }
}

export function openPanel(): void {
  if (!state.enabled) {
    toast("配置导入导出已关闭，请在「设置 → 功能开关」中启用", "info");
    return;
  }
  setState({ open: true, report: null, lastError: null });
  void loadDefaults().then(() => refresh());
}

export function closePanel(): void {
  setState({ open: false });
}

/** 由 app.ts 在配置变化时调用（启动、保存设置、重置）。 */
export function setEnabledFromConfig(config: unknown): void {
  const enabled = !!featureFlags(config, "connection").import_export;
  if (!enabled) {
    setState({
      enabled: false,
      connections: [],
      selection: null,
      importPath: "",
      report: null,
      lastError: null,
    });
    return;
  }
  setState({ enabled: true });
  void refresh();
}
