import { useState } from "react";
import { Btn, Field, Note, Section } from "../../components/form";
import { activateLicense, refreshLicense, useGitSync } from "./store";

/** 授权状态 → 展示名。 */
const STATE_LABELS: Record<string, string> = {
  free: "未激活",
  active: "已激活",
  expiring: "即将到期",
  grace: "宽限期",
  locked: "已过期",
  needs_activation: "需重新激活",
  clock_rollback: "系统时间异常",
};

function formatDate(raw?: string | null): string {
  if (!raw) return "";
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return raw;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * 激活码输入与授权状态展示。
 *
 * 同时用于 Git 同步面板（未激活时）与「设置 → Git 同步」页；
 * 状态来自 git-sync store，激活成功后侧栏徽标与面板会立即刷新。
 */
export function LicenseSection() {
  const state = useGitSync();
  const [key, setKey] = useState("");
  const license = state.license;
  const unlocked = !!license && license.unlocked;
  const label = license ? STATE_LABELS[license.state] || license.state : "读取中…";

  const submit = async () => {
    const ok = await activateLicense(key);
    if (ok) setKey("");
  };

  if (unlocked) {
    return (
      <Section
        title="功能激活"
        desc="Git 同步已激活。断网时使用本地离线授权，临近到期会自动联网续签。"
      >
        <Field label="授权状态">
          <span className="muted">
            {label}
            {license && license.plan ? ` · ${license.plan}` : ""} · {license?.message}
          </span>
        </Field>
        {license?.expires_at ? (
          <Field label="订阅到期">
            <span className="muted">{formatDate(license.expires_at)}</span>
          </Field>
        ) : null}
        {license?.days_left != null ? (
          <Field label="剩余天数">
            <span className="muted">{license.days_left} 天</span>
          </Field>
        ) : null}
        {license?.key_hint ? (
          <Field label="激活码" hint="已保存在本机，不随 Git 同步">
            <span className="muted">{license.key_hint}</span>
          </Field>
        ) : null}
        <div className="git-actions">
          <Btn onClick={() => void refreshLicense()}>刷新授权状态</Btn>
        </div>
      </Section>
    );
  }

  return (
    <Section
      title="功能激活"
      desc="Git 同步为激活码付费功能。输入激活码激活后可在断网状态下使用，临近到期会自动联网续签。"
    >
      <Field label="激活码" hint="形如 PTRM-XXXX-XXXX-XXXX">
        <div className="input-row">
          <input
            type="text"
            value={key}
            placeholder="请输入激活码"
            disabled={state.licenseBusy}
            onChange={(event) => setKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
          />
          <Btn kind="primary" disabled={state.licenseBusy || !key.trim()} onClick={() => void submit()}>
            {state.licenseBusy ? "激活中…" : "激活"}
          </Btn>
        </div>
      </Field>
      {state.licenseError ? (
        <Note kind="error">{state.licenseError}</Note>
      ) : (
        <Note>{license ? license.message : "正在读取授权状态…"}</Note>
      )}
      {license && license.state !== "free" ? <Note>当前状态：{label}</Note> : null}
      <div className="git-actions">
        <Btn onClick={() => void refreshLicense()}>刷新授权状态</Btn>
      </div>
    </Section>
  );
}
