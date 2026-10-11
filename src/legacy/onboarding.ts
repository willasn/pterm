/* 首次启动引导（核心，不随模块开关）。
 *
 * 新装首次打开时先展示一屏语言选择，选完由后端写一个**本机**标记文件
 * （`onboarding_status` / `onboarding_complete`）。标记不随 Git 同步，因此换一台
 * 机器首次打开会重新引导一次；之后仍可在「设置 → 通用 → 语言」里改。
 *
 * 语言卡片点击即切换界面语言（用户当场看到效果），「开始使用」才写标记并放行启动。 */
(function (PShell) {
  "use strict";

  const { $ } = PShell.util;

  const MASK = "onboarding";
  const BASELINE = "zh-CN";
  const ENGLISH = "en-US";

  /** 当前选中的语言。 */
  let chosen = null;
  /** 等待用户确认的 resolve，让 boot 流程挂起。 */
  let pending = null;
  /** 防止重复绑定。 */
  let bound = false;

  /** 按系统语言预选：中文环境默认简体中文，其余默认英文。 */
  function preferred() {
    const lang = (navigator.language || "").toLowerCase();
    return lang.startsWith("zh") ? BASELINE : ENGLISH;
  }

  /** 更新卡片的选中态。 */
  function highlight(locale) {
    document.querySelectorAll("#" + MASK + " .onboarding-lang").forEach((node) => {
      const active = node.dataset.locale === locale;
      node.classList.toggle("selected", active);
      node.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  /** 选中语言并立即应用，使本页文案跟着切换。 */
  function select(locale) {
    chosen = locale || BASELINE;
    highlight(chosen);
    PShell.i18n.setLocale(chosen);
  }

  function close() {
    const mask = $(MASK);
    if (mask) mask.hidden = true;
    const resolve = pending;
    pending = null;
    if (resolve) resolve(chosen);
  }

  async function confirm() {
    try {
      await PShell.ipc.onboardingComplete();
    } catch (err) {
      // 标记写失败只影响「下次是否再引导」，不该把用户挡在门外
      console.warn("[onboarding] 写入完成标记失败", err);
    }
    close();
  }

  function bind() {
    if (bound) return;
    bound = true;

    document.querySelectorAll("#" + MASK + " .onboarding-lang").forEach((node) => {
      node.addEventListener("click", () => select(node.dataset.locale));
    });
    const start = $("onboarding-start");
    if (start) start.addEventListener("click", confirm);
  }

  /** boot 流程调用：需要引导时展示并等待选择，返回所选语言；无需引导返回 null。 */
  async function run() {
    if (!PShell.ipc.available) return null;
    let first = false;
    try {
      first = await PShell.ipc.onboardingStatus();
    } catch (err) {
      // 状态读不到（后端异常）时静默跳过引导，不要卡住启动
      console.warn("[onboarding] 读取引导状态失败", err);
      return null;
    }
    if (!first) return null;

    bind();
    select(preferred());
    const mask = $(MASK);
    if (mask) mask.hidden = false;
    return new Promise((resolve) => {
      pending = resolve;
    });
  }

  PShell.onboarding = { run };
})(window.PShell);
