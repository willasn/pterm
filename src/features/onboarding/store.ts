import { useSyncExternalStore } from "react";
import { setLocale } from "../i18n/store";
import { ipc } from "../ipc/api";

/**
 * 首次启动引导的状态与行为（由原 src/legacy/onboarding.ts 迁移而来）。核心，不随模块开关。
 *
 * 新装首次打开时先展示一屏语言选择，选完由后端写一个**本机**标记文件
 * （`onboarding_status` / `onboarding_complete`）。标记不随 Git 同步，因此换一台
 * 机器首次打开会重新引导一次；之后仍可在「设置 → 通用 → 语言」里改。
 *
 * 语言卡片点击即切换界面语言（用户当场看到效果），「开始使用」才写标记并放行启动。
 */

const BASELINE = "zh-CN";
const ENGLISH = "en-US";

export interface OnboardingState {
  open: boolean;
  /** 当前选中的语言。 */
  chosen: string;
}

let state: OnboardingState = { open: false, chosen: BASELINE };
const listeners = new Set<() => void>();

function setState(patch: Partial<OnboardingState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): OnboardingState {
  return state;
}

export function useOnboarding(): OnboardingState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/** 等待用户确认的 resolve，让 boot 流程挂起。 */
let pendingResolve: ((locale: string | null) => void) | null = null;

/** 按系统语言预选：中文环境默认简体中文，其余默认英文。 */
function preferred(): string {
  const lang = (navigator.language || "").toLowerCase();
  return lang.startsWith("zh") ? BASELINE : ENGLISH;
}

/** 选中语言并立即应用，使本页文案跟着切换。 */
export function select(locale: string): void {
  const chosen = locale || BASELINE;
  setState({ chosen });
  setLocale(chosen);
}

function close(): void {
  setState({ open: false });
  const resolve = pendingResolve;
  pendingResolve = null;
  if (resolve) resolve(state.chosen);
}

export async function confirm(): Promise<void> {
  try {
    await ipc.onboardingComplete();
  } catch (err) {
    // 标记写失败只影响「下次是否再引导」，不该把用户挡在门外
    console.warn("[onboarding] 写入完成标记失败", err);
  }
  close();
}

/** boot 流程调用：需要引导时展示并等待选择，返回所选语言；无需引导返回 null。 */
export async function run(): Promise<string | null> {
  if (!ipc.available) return null;
  let first = false;
  try {
    first = await ipc.onboardingStatus();
  } catch (err) {
    // 状态读不到（后端异常）时静默跳过引导，不要卡住启动
    console.warn("[onboarding] 读取引导状态失败", err);
    return null;
  }
  if (!first) return null;

  select(preferred());
  setState({ open: true });
  return new Promise((resolve) => {
    pendingResolve = resolve;
  });
}
