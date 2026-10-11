import { Portal } from "../../components/Portal";
import { useT } from "../../hooks/useLocale";
import { confirm, select, useOnboarding } from "./store";

const LANGS = [
  { locale: "zh-CN", name: "简体中文" },
  { locale: "en-US", name: "English" },
];

/** 首次启动引导：仅一屏语言选择（核心，不随模块开关）。 */
export function OnboardingGate() {
  const state = useOnboarding();
  const t = useT();

  if (!state.open) return null;

  return (
    <Portal selector="body">
      <div className="onboarding" id="onboarding">
        <div
          className="onboarding-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="onboarding-title"
        >
          <div className="onboarding-brand">
            <span className="onboarding-mark" aria-hidden="true">
              {">_"}
            </span>
            <h1 className="onboarding-title" id="onboarding-title">
              pterm
            </h1>
            <p className="onboarding-tagline" data-i18n="onboarding.tagline">
              {t("onboarding.tagline", "跨平台 SSH 终端客户端")}
            </p>
          </div>
          <p className="onboarding-question" data-i18n="onboarding.question">
            {t("onboarding.question", "选择界面语言")}
          </p>
          <div className="onboarding-langs" id="onboarding-langs">
            {LANGS.map((lang) => (
              <button
                key={lang.locale}
                className={"onboarding-lang" + (state.chosen === lang.locale ? " selected" : "")}
                type="button"
                data-locale={lang.locale}
                aria-pressed={state.chosen === lang.locale ? "true" : "false"}
                onClick={() => select(lang.locale)}
              >
                <span className="onboarding-lang-name">{lang.name}</span>
                <span className="onboarding-lang-code">{lang.locale}</span>
              </button>
            ))}
          </div>
          <p className="onboarding-note" data-i18n="onboarding.note">
            {t("onboarding.note", "之后可随时在「设置 → 通用 → 语言」中修改。")}
          </p>
          <button
            className="btn primary onboarding-start"
            id="onboarding-start"
            type="button"
            data-i18n="onboarding.start"
            onClick={() => void confirm()}
          >
            {t("onboarding.start", "开始使用")}
          </button>
        </div>
      </div>
    </Portal>
  );
}
