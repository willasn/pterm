import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { Btn, Field, Note, Section } from "../../components/form";
import { Portal } from "../../components/Portal";
import { useT } from "../../hooks/useLocale";
import { errorText, toast } from "../../lib/legacy";
import { check as checkUpdate, install as installUpdate, progressPercent, useAutoUpdate } from "../auto-update/store";
import { setLocale } from "../i18n/store";
import { ask } from "../util/util";
import {
  CATEGORIES,
  CURSOR_STYLES,
  FLAG_GROUPS,
  FLAG_META,
  FLAG_MODULE,
  HIDDEN_FLAGS,
  LANGUAGES,
  MODULE_LABELS,
  SCOPE_OPTIONS,
  THEME_MODES,
} from "./constants";
import {
  addModel,
  changeMasterPassword,
  clearTested,
  close,
  deleteModel,
  exportCrashLog,
  getActiveCat,
  getAiModels,
  getConfiguredModelIds,
  getCrashBusy,
  getCrashTail,
  getDraft,
  getFlags,
  getFormKey,
  getGitCredentialNames,
  getInfo,
  getModules,
  getOpen,
  getPath,
  getSavedModelIds,
  getVaultState,
  isTested,
  markGitPasswordClear,
  markTested,
  normalizeModel,
  protocolOptions,
  protocolSpec,
  removeShortcutBinding,
  rerender,
  reset,
  save,
  saveModel,
  setActiveCat,
  setGitPassword,
  setPath,
  shortcutConflicts,
  shortcutRows,
  syncAfterPasswordChange,
  testGitRemote,
  testModel,
  useSettingsVersion,
  viewCrashLog,
} from "./store";
import type { AiModelConfig, ModuleStatus, ShortcutIssue, ShortcutRow, VaultStatus } from "./types";

// ---------------------------------------------------------------------------
// 基础元素
// ---------------------------------------------------------------------------

function Badge({ text, kind }: { text: string; kind?: string }) {
  return <span className={"badge " + (kind || "")}>{text}</span>;
}

/** 把模块状态渲染成徽标。enabled 但未 initialized 说明实现还没落地。 */
function ModuleBadge({ status }: { status?: ModuleStatus }) {
  if (!status) return <Badge text="未注册" kind="off" />;
  if (!status.enabled) return <Badge text="已关闭" kind="off" />;
  if (status.initialized) return <Badge text="已启用" kind="on" />;
  return <Badge text="已启用 · 未初始化" kind="warn" />;
}

/** 非受控开关：直接写回草稿，不触发重绘（与原实现一致，避免打断输入）。 */
function ToggleField({
  label,
  hint,
  path,
  extra,
}: {
  label: string;
  hint?: string | null;
  path: string;
  extra?: ReactNode;
}) {
  const draft = getDraft();
  return (
    <Field label={label} hint={hint}>
      <label className="toggle-row">
        <input
          type="checkbox"
          defaultChecked={!!getPath(draft, path)}
          onChange={(event) => setPath(draft, path, event.target.checked)}
        />
        {extra}
      </label>
    </Field>
  );
}

function TextField({
  label,
  hint,
  path,
  placeholder,
}: {
  label: string;
  hint?: string | null;
  path: string;
  placeholder?: string;
}) {
  const draft = getDraft();
  const current = getPath(draft, path);
  return (
    <Field label={label} hint={hint}>
      <input
        type="text"
        placeholder={placeholder}
        defaultValue={current == null ? "" : String(current)}
        onChange={(event) => setPath(draft, path, event.target.value)}
      />
    </Field>
  );
}

function NumberField({
  label,
  hint,
  path,
  fallback,
  integer,
  attrs,
}: {
  label: string;
  hint?: string | null;
  path: string;
  fallback: number;
  integer?: boolean;
  attrs?: Record<string, unknown>;
}) {
  const draft = getDraft();
  const current = getPath(draft, path);
  const write = (raw: string) => {
    const n = integer === false ? parseFloat(raw) : parseInt(raw, 10);
    setPath(draft, path, Number.isFinite(n) ? n : fallback);
  };
  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        {...(attrs || {})}
        defaultValue={current == null ? "" : String(current)}
        onChange={(event) => write(event.target.value)}
      />
    </Field>
  );
}

function SelectField({
  label,
  hint,
  path,
  options,
}: {
  label: string;
  hint?: string | null;
  path: string;
  options: { value: string; label: string }[];
}) {
  const draft = getDraft();
  const current = getPath(draft, path);
  return (
    <Field label={label} hint={hint}>
      <select
        defaultValue={current == null ? "" : String(current)}
        onChange={(event) => setPath(draft, path, event.target.value)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

// ---------------------------------------------------------------------------
// 通用：主密码
// ---------------------------------------------------------------------------

function MasterPasswordSection() {
  const vault = getVaultState() as VaultStatus | null;
  const configured = !!(vault && vault.configured);
  const unlocked = !!(vault && vault.unlocked);

  const currentRef = useRef<HTMLInputElement | null>(null);
  const nextRef = useRef<HTMLInputElement | null>(null);
  const againRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<{ text: string; kind: string }>({ text: "", kind: "" });
  const [busy, setBusy] = useState(false);

  const setStatusText = (text: string, kind: string) => setStatus({ text, kind });

  const change = async () => {
    const current = currentRef.current?.value || "";
    const next = nextRef.current?.value || "";
    if (!current) return setStatusText("请输入当前主密码", "error");
    if (!next) return setStatusText("请输入新主密码", "error");
    if (next !== (againRef.current?.value || "")) {
      return setStatusText("两次输入的新主密码不一致", "error");
    }
    const confirmed = await ask(
      "修改主密码后，本机保险库会立即用新密码重新加密。其它设备需要同步后用新主密码解锁，旧密码将失效。确定继续？",
      { title: "修改主密码", okText: "继续" }
    );
    if (!confirmed) return;

    setBusy(true);
    setStatusText("正在重新加密保险库…", "");
    try {
      await changeMasterPassword(current, next);
      if (currentRef.current) currentRef.current.value = "";
      if (nextRef.current) nextRef.current.value = "";
      if (againRef.current) againRef.current.value = "";
      setStatusText("主密码已修改。", "ok");
      toast("主密码已修改", "ok");
      const extra = await syncAfterPasswordChange();
      if (extra) setStatus((prev) => ({ ...prev, text: prev.text + extra }));
    } catch (err) {
      const message = "修改失败：" + errorText(err);
      setStatusText(message, "error");
      toast(errorText(err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="主密码"
      desc="SSH 密码 / API Key / Git 凭据等都以此密码加密保存在本地，并随 Git 同步以密文分发。改密后需要让新的密文同步出去，其它设备才能用新密码解锁。"
    >
      <p className="inline-note">
        {configured
          ? unlocked
            ? "保险库已设置并解锁。"
            : "保险库已设置，当前处于锁定状态。"
          : "尚未设置主密码。"}
      </p>
      <Field label="当前主密码">
        <input type="password" placeholder="当前主密码" autoComplete="off" ref={currentRef} />
      </Field>
      <Field label="新主密码" hint="仅本机生效，其它设备需用新密码解锁">
        <input type="password" placeholder="新主密码" autoComplete="off" ref={nextRef} />
      </Field>
      <Field label="确认新主密码">
        <input type="password" placeholder="再次输入新主密码" autoComplete="off" ref={againRef} />
      </Field>
      <div className="log-actions">
        <button className="btn primary" type="button" onClick={() => void change()} disabled={busy}>
          修改主密码
        </button>
      </div>
      <p className={"inline-note" + (status.kind ? " " + status.kind : "")}>{status.text}</p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 分类：通用
// ---------------------------------------------------------------------------

function GeneralCategory() {
  const t = useT();
  const draft = getDraft();
  const themeOn = !!(draft.features && draft.features.auxiliary && draft.features.auxiliary.theme);

  const languageNode = (
    <select
      defaultValue={draft.language == null ? "" : String(draft.language)}
      onChange={(event) => {
        draft.language = event.target.value;
        // 改动后立即切换语言并重绘设置面板与模块概览
        setLocale(draft.language).then(() => rerender(true));
      }}
    >
      {LANGUAGES.map((l) => (
        <option key={l.value} value={l.value}>
          {l.label}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <MasterPasswordSection />
      <Section title={t("settings.section.ui", "界面")}>
        <Field label={t("settings.language", "语言")} hint={t("settings.language.hint", "切换后立即生效。")}>
          {languageNode}
        </Field>
      </Section>
      <Section title={t("settings.section.theme", "主题")} desc={themeOn ? null : "「主题」开关已关闭，以下设置暂不生效。"}>
        <SelectField label="明暗模式" hint="「跟随系统」会响应系统外观变化" path="theme.mode" options={THEME_MODES} />
        <TextField label="强调色" hint="CSS 颜色值，留空则用默认强调色" path="theme.accent" placeholder="#4ade80" />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// 分类：终端
// ---------------------------------------------------------------------------

function TerminalCategory() {
  return (
    <Section title="终端外观" desc="保存后立即作用于所有已打开的终端。">
      <TextField label="字体" hint="CSS font-family 列表" path="terminal.font_family" />
      <NumberField label="字号" hint="像素" path="terminal.font_size" fallback={13} attrs={{ min: 6, max: 40 }} />
      <NumberField
        label="行高"
        hint="倍数，如 1.2"
        path="terminal.line_height"
        fallback={1.2}
        integer={false}
        attrs={{ step: "0.05", min: 1, max: 3 }}
      />
      <NumberField label="回滚缓冲" hint="保留的历史行数" path="terminal.scrollback" fallback={5000} attrs={{ min: 0 }} />
      <SelectField label="光标样式" path="terminal.cursor_style" options={CURSOR_STYLES} />
      <ToggleField label="光标闪烁" path="terminal.cursor_blink" />
      <ToggleField label="响铃" hint="远端触发 BEL 时发出提示音" path="terminal.bell" />
      <ToggleField label="选中即复制" hint="选中文本自动写入剪贴板" path="terminal.copy_on_select" />
      <ToggleField label="右击菜单" hint="终端内右击弹出「复制 / 粘贴」菜单" path="terminal.right_click_menu" />
      <ToggleField
        label="本地回显"
        hint="按键立即上屏，远端回显到达后再对齐；关闭后字符只在远端回显到达时出现"
        path="terminal.local_echo"
      />
      <TextField label="TERM" hint="传给远端的终端类型" path="terminal.term_type" />
      <TextField label="背景色" hint="CSS 颜色值，留空则跟随主题" path="terminal.background" placeholder="#16181d" />
      <TextField label="前景色" hint="CSS 颜色值，留空则跟随主题" path="terminal.foreground" placeholder="#dfe3ea" />
      <NumberField label="心跳间隔" hint="秒；由 SSH 核心用于保活" path="terminal.keepalive_secs" fallback={30} attrs={{ min: 0 }} />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 分类：连接
// ---------------------------------------------------------------------------

function ConnectionCategory() {
  const draft = getDraft();
  const sessionLogOn = !!(draft.features && draft.features.connection && draft.features.connection.session_log);
  return (
    <>
      <Section title="自动重连" desc="断线后按指数退避重试，直到达到最大次数。">
        <ToggleField label="启用自动重连" path="features.connection.auto_reconnect" />
        <NumberField
          label="最大尝试次数"
          hint="超过后进入「连接失败」，可手动重连"
          path="features.connection.auto_reconnect_max_attempts"
          fallback={5}
          attrs={{ min: 0, max: 100 }}
        />
        <NumberField
          label="基础退避间隔"
          hint="毫秒；实际间隔按 2^n 增长，上限 30 秒"
          path="features.connection.auto_reconnect_base_delay_ms"
          fallback={1000}
          attrs={{ min: 100, step: "100" }}
        />
      </Section>
      <Section title="会话日志" desc={sessionLogOn ? null : "「会话日志」开关已关闭，该设置暂不生效。"}>
        <NumberField
          label="保留天数"
          hint="超过该天数的日志会被清理"
          path="features.connection.session_log_retention_days"
          fallback={30}
          attrs={{ min: 1 }}
        />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// 分类：功能开关
// ---------------------------------------------------------------------------

function FlagsCategory() {
  const t = useT();
  const list = getFlags();
  const modules = getModules();
  return (
    <div className="settings-section">
      <p className="inline-note">开关与 FEATURES.md 一一对应。新增功能必须先在 feature_flags.rs 注册，再登记文档。</p>
      {FLAG_GROUPS.map((group) => {
        const entries = list.filter(
          (entry) => entry.path.indexOf(group.key + ".") === 0 && !HIDDEN_FLAGS.has(entry.path)
        );
        if (!entries.length) return null;
        return (
          <div key={group.key}>
            <div className="flag-group-title">{t("flags.group." + group.key, group.title)}</div>
            {entries.map((entry) => {
              const meta: { label?: string; hint?: string } = FLAG_META[entry.path] || {};
              const label = t("flags." + entry.path, meta.label || entry.path);
              const moduleId = FLAG_MODULE[entry.path];
              const status = moduleId ? modules.filter((m) => m.id === moduleId)[0] : undefined;
              return (
                <ToggleField
                  key={entry.path}
                  label={label}
                  hint={meta.hint || ""}
                  path={"features." + entry.path}
                  extra={moduleId ? <ModuleBadge status={status} /> : null}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 分类：AI 助手（含逐条模型编辑）
// ---------------------------------------------------------------------------

/** 单个模型的一组生成参数；全部可留空，留空即用默认值。 */
function ModelParamFields({ model }: { model: AiModelConfig }) {
  const optional = (
    label: string,
    hint: string,
    path: string,
    integer: boolean,
    attrs: Record<string, unknown>
  ) => {
    const current = (model as any)[path] as number | null;
    return (
      <Field label={label} hint={hint}>
        <input
          type="number"
          {...attrs}
          defaultValue={current == null ? "" : String(current)}
          onChange={(event) => {
            const raw = event.target.value.trim();
            if (raw === "") {
              (model as any)[path] = null;
              return;
            }
            const n = integer ? parseInt(raw, 10) : parseFloat(raw);
            (model as any)[path] = Number.isFinite(n) ? n : null;
          }}
        />
      </Field>
    );
  };
  return (
    <>
      {optional("采样温度", "0 ~ 2；留空用默认值", "temperature", false, { step: "0.1", min: 0, max: 2, placeholder: "0.2" })}
      {optional("最大输出 token", "单次回复的 max_tokens 上限；留空用默认值", "max_tokens", true, { min: 1, placeholder: "2048" })}
      {optional(
        "最大输入 token",
        "模型上下文窗口；用于 AI 面板底部估算上下文占比，留空用默认值",
        "max_input_tokens",
        true,
        { min: 1, placeholder: "128000" }
      )}
      {optional("请求超时", "秒；留空用默认值", "timeout_secs", true, { min: 1, placeholder: "60" })}
      {optional("上下文注入", "附带最近多少字节的终端输出；留空用默认值", "context_bytes", true, { min: 0, placeholder: "4096" })}
    </>
  );
}

/**
 * 单个自定义模型卡片：字段 + 该条目自己的「测试连通性 / 保存 / 删除」。
 *
 * 逐条保存让「测通一个、存一个」成为最短路径；新增条目在测通之前保存按钮保持禁用，
 * 避免把地址 / Key / 模型名有误的条目写进配置，之后在面板里反复报错。
 */
function ModelRow({ model, index }: { model: AiModelConfig; index: number }) {
  if (!model.id) model.id = "m-" + Math.random().toString(36).slice(2, 10);
  const id = model.id;
  const stored = getConfiguredModelIds().has(id);
  const isSaved = getSavedModelIds().has(id);

  const keyRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<{ text: string; kind: string }>({ text: "", kind: "" });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [endpointHint, setEndpointHint] = useState("");

  const syncEndpointHint = () => {
    const base = (model.base_url || "").trim().replace(/\/+$/, "");
    const shown = base || "（未填 API 地址）";
    const spec = protocolSpec(model.protocol);
    setEndpointHint(
      spec
        ? "实际请求地址：" + shown + spec.suffix + (spec.note ? "；" + spec.note : "")
        : "实际请求地址：" + shown
    );
  };

  // 初始与协议/地址变化时刷新后缀提示
  useEffect(() => {
    syncEndpointHint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 地址 / 模型名 / Key 一变，之前的测试结论就不再对应当前配置，必须重新测。 */
  const invalidate = () => {
    clearTested(id);
    setStatus({ text: "", kind: "" });
  };

  const apiKeyPayload = (): string | null => {
    const typed = (keyRef.current?.value || "").trim();
    return typed === "" ? null : typed;
  };

  const runTest = async () => {
    const payload = {
      id,
      name: (model.name || "").trim(),
      model: (model.model || "").trim(),
      base_url: (model.base_url || "").trim(),
      protocol: model.protocol || "openai",
      api_key: apiKeyPayload(),
      timeout_secs: model.timeout_secs == null ? null : model.timeout_secs,
    };
    if (!payload.model) return toast("请先填写模型 ID", "warn");
    if (!payload.base_url) return toast("请先填写 API 地址", "warn");
    if (payload.api_key == null && !getConfiguredModelIds().has(id)) {
      return toast("请先填写该模型的 API Key", "warn");
    }

    setTesting(true);
    setStatus({ text: "正在测试连通性…", kind: "" });
    try {
      const outcome = await testModel(payload);
      markTested(id);
      const cost = outcome && outcome.elapsed_ms != null ? "（" + outcome.elapsed_ms + " ms）" : "";
      setStatus({ text: "连通性测试通过" + cost + "，可以保存。", kind: "ok" });
      toast("连通性测试通过", "ok");
    } catch (err) {
      clearTested(id);
      setStatus({ text: "测试失败：" + errorText(err), kind: "error" });
      toast(errorText(err), "error");
    } finally {
      setTesting(false);
    }
  };

  const runSave = async () => {
    if (!isSaved && !isTested(id)) {
      return toast("请先点击「测试连通性」，验证通过后再保存", "warn");
    }
    const payload = normalizeModel(model);
    if (!payload.model) return toast("请先填写模型 ID", "warn");
    if (!payload.base_url) return toast("请先填写 API 地址", "warn");
    const apiKey = apiKeyPayload();
    if (apiKey == null && !getConfiguredModelIds().has(id)) {
      return toast("请先填写该模型的 API Key", "warn");
    }

    setSaving(true);
    try {
      await saveModel(model, apiKey);
      if (keyRef.current) keyRef.current.value = "";
      toast("已保存模型「" + (payload.name || payload.model) + "」", "ok");
      setStatus({ text: "已保存。", kind: "ok" });
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setSaving(false);
    }
  };

  const runDelete = async () => {
    const label = (model.name || model.model || "该模型").trim();
    const confirmed = await ask(
      "删除模型「" + label + "」？若已保存，保险库中的 API Key 也会一并清除。",
      { title: "删除确认", okText: "删除", kind: "danger" }
    );
    if (!confirmed) return;
    try {
      await deleteModel(id);
      toast("已删除模型「" + label + "」", "ok");
    } catch (err) {
      toast(errorText(err), "error");
    }
  };

  const gated = !isSaved && !isTested(id);
  const statusText = status.text || (gated ? "新增模型：请先点击「测试连通性」，通过后才能保存。" : "");

  return (
    <div className="ai-model-row">
      <div className="ai-model-head">
        <span className="ai-model-title">{"模型 " + (index + 1)}</span>
        <div className="ai-model-head-actions">
          {isSaved ? <Badge text="已保存" kind="on" /> : <Badge text="未保存" kind="warn" />}
          <button className="btn ghost" type="button" onClick={() => void runDelete()}>
            删除
          </button>
        </div>
      </div>
      <Field label="展示名">
        <input
          type="text"
          placeholder="如「DeepSeek 对话」"
          defaultValue={model.name || ""}
          onChange={(event) => {
            model.name = event.target.value;
            invalidate();
          }}
        />
      </Field>
      <Field label="模型 ID">
        <input
          type="text"
          placeholder="如 deepseek-chat"
          defaultValue={model.model || ""}
          onChange={(event) => {
            model.model = event.target.value;
            invalidate();
          }}
        />
      </Field>
      <Field label="API 地址">
        <input
          type="text"
          placeholder="如 https://api.deepseek.com/v1"
          defaultValue={model.base_url || ""}
          onChange={(event) => {
            model.base_url = event.target.value;
            syncEndpointHint();
            invalidate();
          }}
        />
      </Field>
      <Field label="协议" hint="决定请求地址后缀与请求 / 响应格式">
        <select
          title="决定请求地址后缀与请求 / 响应格式"
          defaultValue={model.protocol || "openai"}
          onChange={(event) => {
            model.protocol = event.target.value;
            syncEndpointHint();
            invalidate();
          }}
        >
          {protocolOptions().map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </Field>
      <p className="inline-note">{endpointHint}</p>
      <Field label="API Key" hint="留空则沿用保险库中已保存的 Key">
        <div>
          <input
            type="password"
            ref={keyRef}
            placeholder={stored ? "已保存在加密保险库，留空则不修改" : "粘贴该模型的 API Key"}
            onChange={invalidate}
          />
          <p className="inline-note">
            {stored ? <Badge text="已配置" kind="on" /> : <Badge text="未配置" kind="off" />}
            <span>{stored ? " 保险库中已有该模型的 Key" : " 尚未保存 Key"}</span>
          </p>
        </div>
      </Field>
      <ModelParamFields model={model} />
      <div className="log-actions">
        <button className="btn ghost" type="button" onClick={() => void runTest()} disabled={testing}>
          {testing ? "测试中…" : "测试连通性"}
        </button>
        <button
          className="btn primary"
          type="button"
          onClick={() => void runSave()}
          disabled={gated || saving}
          title={gated ? "新增模型需先通过连通性测试" : "保存该模型到模型列表"}
        >
          保存
        </button>
      </div>
      <p className={"inline-note" + (status.kind ? " " + status.kind : "")}>{statusText}</p>
    </div>
  );
}

function ModelsSection() {
  const models = getAiModels();
  return (
    <Section
      title="自定义模型"
      desc="每个模型独立配置协议、API 地址、API Key 与生成参数，可混合不同供应商（OpenAI、DeepSeek、Anthropic、自建网关等）。协议决定请求地址后缀与请求 / 响应格式，下方会实时给出「实际请求地址」。每个模型单独「测试连通性 → 保存」，新增模型必须先测试通过才能保存；Key 只写入加密保险库；生成参数留空即使用默认值。"
    >
      <div className="ai-model-list">
        {models.length ? (
          models.map((model, index) => <ModelRow key={model.id} model={model} index={index} />)
        ) : (
          <Note>尚未添加模型。添加后即可在 AI 助手面板中选择使用。</Note>
        )}
      </div>
      <div className="log-actions">
        <button className="btn ghost" type="button" onClick={addModel}>
          添加模型
        </button>
      </div>
    </Section>
  );
}

function AiCategory() {
  const draft = getDraft();
  const aiFlags = (draft.features && draft.features.ai) || {};
  return (
    <>
      {!aiFlags.ai_assistant ? (
        <Note>
          AI 助手当前已关闭：请先在「功能开关」中打开「AI 助手」并保存，「测试连通性 / 保存」才会生效。
        </Note>
      ) : null}
      <ModelsSection />
    </>
  );
}

// ---------------------------------------------------------------------------
// 分类：Git 同步
// ---------------------------------------------------------------------------

/** 远端名规范化，与后端 git_sync::normalize_remote_name 保持一致。 */
function remoteName(remote: any): string {
  const name = ((remote && remote.name) || "").trim();
  return name || "origin";
}

/** 单个远端的访问凭据：用户名随配置保存，密码 / 令牌只进加密保险库。 */
function CredentialRow({ remote, index }: { remote: any; index: number }) {
  const name = remoteName(remote);
  const stored = getGitCredentialNames().has(name);
  const draft = getDraft();
  const pwdRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<{ text: string; kind: string }>({ text: "", kind: "" });
  const [testing, setTesting] = useState(false);
  const [cleared, setCleared] = useState(false);

  const userPath = `features.sync.git_remotes.${index}.username`;

  /**
   * 用当前表单里的地址 / 用户名 / 密码连一次远端并读引用列表：
   * 一次即可验证地址可达与凭据正确。密码已输入就用输入的，否则后端回落保险库。
   */
  const runTest = async () => {
    const url = (((draft.features.sync.git_remotes || [])[index] || {}).url || "").trim();
    if (!url) return toast("请先填写远程地址", "warn");
    setTesting(true);
    setStatus({ text: "正在连接 " + url + " …", kind: "" });
    try {
      const userValue = (getPath(draft, userPath) || "").trim();
      const pwdValue = pwdRef.current?.value ?? "";
      const result = await testGitRemote({
        name,
        url,
        username: userValue || null,
        password: pwdValue === "" ? null : pwdValue,
      });
      setStatus({ text: "连接成功：" + result.message + "（" + result.elapsed_ms + " ms）", kind: "ok" });
      toast("Git 远端连接与凭据均正常", "ok");
    } catch (err) {
      setStatus({ text: "测试失败：" + errorText(err), kind: "error" });
      toast(errorText(err), "error");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="git-credential-row">
      <Field label="用户名" hint={`远端 ${name}`}>
        <input
          type="text"
          placeholder="用户名，如 your-name 或 x-access-token"
          defaultValue={getPath(draft, userPath) || ""}
          onChange={(event) => setPath(draft, userPath, event.target.value)}
        />
      </Field>
      <Field label="密码 / 令牌" hint="留空即不修改；可先点「测试连接」验证地址与凭据">
        <div>
          <div className="input-row">
            <input
              type="password"
              ref={pwdRef}
              placeholder={
                cleared
                  ? "保存后将删除保险库中的密码"
                  : stored
                    ? "已保存在加密保险库，留空则不修改"
                    : "密码或访问令牌（PAT）"
              }
              onChange={(event) => setGitPassword(name, event.target.value)}
            />
            <button className="btn ghost" type="button" onClick={() => void runTest()} disabled={testing}>
              {testing ? "测试中…" : "测试连接"}
            </button>
            <button
              className="btn ghost"
              type="button"
              onClick={() => {
                markGitPasswordClear(name);
                if (pwdRef.current) pwdRef.current.value = "";
                setCleared(true);
              }}
            >
              清除
            </button>
          </div>
          <p className="inline-note">
            {stored ? <Badge text="已保存" kind="on" /> : <Badge text="未保存" kind="off" />}
            <span>{stored ? " 保险库中已有凭据" : " 尚未保存凭据"}</span>
          </p>
          <p className={"inline-note" + (status.kind ? " " + status.kind : "")}>{status.text}</p>
        </div>
      </Field>
    </div>
  );
}

/** 单仓库模式下保证 git_remotes 至少有一条 origin，供字段绑定。 */
function ensureOrigin(): any {
  const draft = getDraft();
  const sync = draft.features.sync;
  if (!Array.isArray(sync.git_remotes)) sync.git_remotes = [];
  if (!sync.git_remotes.length) {
    sync.git_remotes.push({ name: "origin", url: "", branch: null, username: null });
  }
  const origin = sync.git_remotes[0];
  if (!origin.name) origin.name = "origin";
  if (origin.branch === undefined) origin.branch = null;
  if (origin.username === undefined) origin.username = null;
  return origin;
}

function RepoPathField() {
  const draft = getDraft();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialog = (window as any).__TAURI__?.dialog;
  return (
    <Field label="仓库路径" hint="留空则使用应用数据目录下的 sync">
      <div className="input-row">
        <input
          type="text"
          placeholder="~/.pterm/sync"
          ref={inputRef}
          defaultValue={getPath(draft, "features.sync.git_repo_path") || ""}
          onChange={(event) => setPath(draft, "features.sync.git_repo_path", event.target.value)}
        />
        {dialog && typeof dialog.open === "function" ? (
          <button
            className="btn ghost"
            type="button"
            onClick={async () => {
              try {
                const picked = await dialog.open({ directory: true, multiple: false, title: "选择 Git 仓库目录" });
                if (typeof picked === "string" && picked) {
                  if (inputRef.current) inputRef.current.value = picked;
                  draft.features.sync.git_repo_path = picked;
                }
              } catch (err) {
                toast(errorText(err), "error");
              }
            }}
          >
            选择目录…
          </button>
        ) : null}
      </div>
    </Field>
  );
}

function GitCategory() {
  const draft = getDraft();
  const sync = draft.features.sync;
  // 单仓库模式：绑到第一条远端，保证「填个地址就能用」的路径最短
  ensureOrigin();
  // 同步范围只有「全部」两档，数据域恒为 all
  sync.git_sync_scope = "all";
  const remotes: any[] = sync.git_remotes || [];
  return (
    <>
      {!sync.git_sync ? (
        <Note>Git 同步当前已关闭，以下配置在启用后生效（可在「功能开关」中开启）。</Note>
      ) : null}
      <Section title="仓库" desc="pterm 用 Git 仓库在多台设备之间同步配置，不做任何云同步。">
        <RepoPathField />
        <Field label="同步范围" hint="决定同步哪些内容；连接密码与 API Key 属于敏感信息，可单独排除">
          <select
            defaultValue={sync.git_sync_secrets === false ? "all_no_secrets" : "all"}
            onChange={(event) => {
              sync.git_sync_scope = "all";
              sync.git_sync_secrets = event.target.value === "all";
            }}
          >
            {SCOPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </Field>
      </Section>
      <Section title="远程仓库" desc="填写你的 Git 仓库地址；留空则只在本地提交留痕，不推送。">
        <TextField
          label="远程地址"
          hint="SSH 或 HTTPS 地址"
          path="features.sync.git_remotes.0.url"
          placeholder="git@github.com:you/pterm-config.git"
        />
        <TextField
          label="目标分支"
          hint="留空则推送与本地同名的分支"
          path="features.sync.git_remotes.0.branch"
          placeholder="main"
        />
      </Section>
      <Section
        title="访问凭据"
        desc="HTTPS 远端需要用户名与密码 / 访问令牌（如 GitHub PAT）。密码只写入加密保险库，不写入配置文件；它会以密文随 Git 同步一起分发。SSH 远端请改用 ssh-agent 或 ~/.ssh 私钥。填好后可点「测试连接」验证地址可达、凭据正确。"
      >
        {remotes.length ? (
          remotes.map((remote, index) => (
            <CredentialRow key={remoteName(remote) + index} remote={remote} index={index} />
          ))
        ) : (
          <Note>暂未配置远端地址，填写后即可配置凭据。</Note>
        )}
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// 分类：快捷键
// ---------------------------------------------------------------------------

function ShortcutEditor() {
  const [issues, setIssues] = useState<ShortcutIssue[]>(() => shortcutConflicts() as ShortcutIssue[]);
  const rows: ShortcutRow[] = shortcutRows();
  const labels: Record<string, string> = {};
  rows.forEach((row) => {
    if (!labels[row.binding.action]) labels[row.binding.action] = row.label;
  });

  const refreshReport = () => setIssues(shortcutConflicts() as ShortcutIssue[]);

  return (
    <Section
      title="键盘快捷键"
      desc="组合键写法如 CmdOrCtrl+T（macOS 上是 ⌘，其他平台是 Ctrl），多个修饰键用 + 连接；也可直接写 Cmd / Ctrl / Shift / Alt。"
    >
      <div className="list-editor">
        {rows.map((row, index) => (
          <div
            className="list-row"
            key={row.binding.action + ":" + index}
            style={{ gridTemplateColumns: row.removable ? "1fr 28px" : "1fr 54px 210px" }}
          >
            <div className="field-label">
              <span className="name">{row.label}</span>
              <span className="hint">{row.hint}</span>
            </div>
            {!row.removable ? (
              <>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    title="关闭后该组合键不再派发动作，按键原样交给终端"
                    defaultChecked={row.binding.enabled}
                    onChange={(event) => {
                      row.binding.enabled = event.target.checked;
                      refreshReport();
                    }}
                  />
                </label>
                <input
                  type="text"
                  placeholder="留空 = 未绑定"
                  defaultValue={row.binding.keys || ""}
                  onChange={(event) => {
                    row.binding.keys = event.target.value;
                    refreshReport();
                  }}
                />
              </>
            ) : (
              <button
                className="icon-btn"
                title="删除该条目"
                onClick={() => {
                  removeShortcutBinding(row.binding);
                  refreshReport();
                }}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
      <div>
        {!issues.length ? (
          <p className="inline-note ok">未发现冲突。</p>
        ) : (
          issues.map((issue, index) => {
            const who = labels[issue.action] || issue.action;
            let text = (who ? "「" + who + "」：" : "") + issue.text;
            if (issue.duplicateOf) {
              text += "（与「" + (labels[issue.duplicateOf] || issue.duplicateOf) + "」冲突）";
            }
            return (
              <p className={"inline-note " + issue.level} key={index}>
                {text}
              </p>
            );
          })
        )}
      </div>
    </Section>
  );
}

function ShortcutsCategory() {
  return (
    <ShortcutEditor />
  );
}

// ---------------------------------------------------------------------------
// 分类：关于
// ---------------------------------------------------------------------------

function CrashLogSection() {
  const draft = getDraft();
  const tail = getCrashTail();
  const busy = getCrashBusy();
  if (!draft.features.auxiliary.crash_log) {
    return (
      <Section title="崩溃日志">
        <Note>崩溃日志已关闭。打开后 pterm 会把 panic 信息写入本地日志，可在此查看与导出。</Note>
      </Section>
    );
  }
  return (
    <Section title="崩溃日志" desc="关闭时后端命令会被门控拒绝。">
      <Note>panic hook 捕获的崩溃信息写入本地日志。反馈问题时导出该文件即可。</Note>
      <div className="log-actions">
        <button className="btn ghost" type="button" disabled={busy} onClick={() => void viewCrashLog()}>
          查看
        </button>
        <button className="btn ghost" type="button" disabled={busy} onClick={() => void exportCrashLog()}>
          导出
        </button>
      </div>
      {tail ? (
        <>
          <Note>
            {tail.exists
              ? `${tail.path}（${tail.bytes} 字节${tail.truncated ? "，仅显示末尾部分" : ""}）`
              : "暂无崩溃日志，应用尚未崩溃过。"}
          </Note>
          {tail.exists ? <pre className="log-preview">{tail.content || "（文件为空）"}</pre> : null}
        </>
      ) : null}
    </Section>
  );
}

/** 软件更新：当前版本 / 检查状态 / 手动检查与安装入口。 */
function UpdateSection() {
  const state = useAutoUpdate();
  const draft = getDraft();
  const info = (getInfo() || {}) as any;
  if (!draft.features.auxiliary.auto_update) {
    return (
      <Section title="软件更新">
        <Note>自动更新已关闭。打开后 pterm 会从 GitHub 检查新版本并提示安装。</Note>
      </Section>
    );
  }
  const percent = progressPercent(state);
  const busy = state.status === "checking" || state.status === "downloading";
  const statusText = (() => {
    switch (state.status) {
      case "checking":
        return "正在检查…";
      case "downloading":
        return percent === null ? "正在下载…" : `正在下载 ${percent}%`;
      case "available":
        return `发现新版本 ${state.latest}`;
      case "latest":
        return "已是最新版本";
      case "error":
        return state.lastError || "检查失败";
      default:
        return "尚未检查";
    }
  })();
  return (
    <Section title="软件更新" desc="从 GitHub 检查新版本，下载安装完成后自动重启。">
      <Field label="当前版本">
        <span className="muted">{info.version || state.current || "—"}</span>
      </Field>
      <Field label="状态">
        <span className="muted">{statusText}</span>
      </Field>
      <div className="log-actions">
        <button
          className="btn ghost"
          type="button"
          disabled={busy}
          onClick={() => void checkUpdate({ manual: true })}
        >
          检查更新
        </button>
        {state.status === "available" || state.status === "error" ? (
          <button className="btn primary" type="button" disabled={busy} onClick={() => void installUpdate()}>
            立即更新
          </button>
        ) : null}
      </div>
      {state.notes ? <Note>{state.notes}</Note> : null}
    </Section>
  );
}

function AboutCategory() {
  const t = useT();
  const source = (getInfo() || {}) as any;
  const modules = getModules();
  const rows: [string, string][] = [
    ["应用", source.name || "pterm"],
    ["版本", source.version || "—"],
    ["配置文件", source.config_file || "—"],
    ["数据库", source.database_file || "—"],
    ["日志目录", source.log_dir || "—"],
  ];
  return (
    <>
      <Section title="应用信息" desc="配置为纯文本 YAML，可直接编辑。">
        {rows.map((pair) => (
          <Field label={pair[0]} key={pair[0]}>
            <span className="muted">{pair[1]}</span>
          </Field>
        ))}
      </Section>
      <Section title="模块状态" desc="可选模块在 Rust 侧统一实现 init / dispose / is_enabled。">
        {modules.length ? (
          modules.map((status) => (
            <Field key={status.id} label={t("module." + status.id, MODULE_LABELS[status.id] || status.id)}>
              <span>
                <ModuleBadge status={status} />
                {status.note ? <span className="muted">{" " + status.note}</span> : null}
              </span>
            </Field>
          ))
        ) : (
          <Note>尚未注册任何可插拔模块实现（ModuleRegistry 为空）。</Note>
        )}
      </Section>
      <CrashLogSection />
      <UpdateSection />
    </>
  );
}

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------

function CategoryBody() {
  switch (getActiveCat()) {
    case "terminal":
      return <TerminalCategory />;
    case "connection":
      return <ConnectionCategory />;
    case "flags":
      return <FlagsCategory />;
    case "ai":
      return <AiCategory />;
    case "git":
      return <GitCategory />;
    case "shortcuts":
      return <ShortcutsCategory />;
    case "about":
      return <AboutCategory />;
    case "general":
    default:
      return <GeneralCategory />;
  }
}

/** 设置面板（配置驱动的表单 + 功能开关一览 + 模块状态）。 */
export function SettingsModal() {
  const t = useT();
  const version = useSettingsVersion();
  void version; // 订阅重绘
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const activeCat = getActiveCat();
  const formKey = getFormKey();
  const info = getInfo();

  useEffect(() => {
    if (!getOpen()) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [version]);

  // 切分类 / 重建表单后回到顶部
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [activeCat, formKey, version]);

  if (!getOpen()) return null;

  return (
    <Portal selector="body">
      <div
        className="modal-mask"
        id="modal-settings"
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div className="modal wide settings">
          <header className="modal-head">
            <h2>{t("modal.settings", "设置")}</h2>
            <button className="icon-btn" onClick={close}>
              ✕
            </button>
          </header>
          <div className="settings-layout">
            <nav className="settings-nav" id="settings-nav">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  className={cat.id === activeCat ? "active" : ""}
                  onClick={() => setActiveCat(cat.id)}
                >
                  {t("settings.cat." + cat.id, cat.label)}
                </button>
              ))}
            </nav>
            <div className="modal-body" id="settings-body" ref={bodyRef} key={`${activeCat}:${formKey}`}>
              <CategoryBodyBoundary>
                <CategoryBody />
              </CategoryBodyBoundary>
            </div>
          </div>
          <footer className="modal-foot">
            <span className="muted" id="settings-hint">
              {"配置文件：" + (info && info.config_file ? info.config_file : "—")}
            </span>
            <span className="spacer" />
            <button className="btn ghost" id="settings-reset" onClick={() => void reset()}>
              {t("common.reset", "恢复默认")}
            </button>
            <button className="btn ghost" onClick={close}>
              {t("common.cancel", "取消")}
            </button>
            <button className="btn primary" id="settings-save" onClick={() => void save()}>
              {t("common.save", "保存")}
            </button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

/** 单个分类渲染失败时把错误显示在面板里：否则整页空白，用户只看到「打不开」。 */
class CategoryBodyBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[settings] 渲染分类失败", error);
  }

  render() {
    if (this.state.error) {
      return <p className="inline-note error">{"该页渲染失败：" + errorText(this.state.error)}</p>;
    }
    return this.props.children;
  }
}
