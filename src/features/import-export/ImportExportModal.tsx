import { useEffect, type ReactNode } from "react";
import { Btn, Field, Note, Section } from "../../components/form";
import { Portal } from "../../components/Portal";
import { useT } from "../../hooks/useLocale";
import {
  FORMATS,
  closePanel,
  exportTo,
  formatLabel,
  isChecked,
  pickFile,
  runImport,
  selectAll,
  selectNone,
  selectedIds,
  setFormat,
  setImportPath,
  sshConfigPath,
  toggle,
  useImportExport,
  type ImportExportState,
} from "./store";
import type { ImportFormat } from "./types";

/** 行内操作按钮（ie-act 样式，与主按钮区分）。 */
function Act({
  disabled,
  onClick,
  children,
}: {
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button className="ie-act" type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

/** 导出区：连接多选 + 导出为 JSON。 */
function ExportSection({ state }: { state: ImportExportState }) {
  if (!state.connections.length) {
    return (
      <Section title="导出">
        <Note>还没有保存的连接，请先在侧栏新建连接。</Note>
      </Section>
    );
  }

  const count = selectedIds().length;
  return (
    <Section
      title="导出"
      desc="导出文件只含主机、端口、用户名、认证方式等非敏感字段，不含任何密码或 passphrase。"
    >
      <div className="ie-toolbar">
        <span className="muted">{`已选 ${count} / ${state.connections.length} 个连接`}</span>
        <span className="spacer" />
        <Act disabled={state.busy} onClick={selectAll}>
          全选
        </Act>
        <Act disabled={state.busy} onClick={selectNone}>
          全不选
        </Act>
      </div>
      <div className="ie-list">
        {state.connections.map((c) => (
          <label className="ie-row" key={c.id} title={`${c.host}:${c.port}`}>
            <input
              type="checkbox"
              checked={isChecked(c.id)}
              onChange={(event) => toggle(c.id, event.target.checked)}
            />
            <span className="ie-name">{c.name || c.host}</span>
            <span className="ie-addr">{`${c.username || "—"}@${c.host}:${c.port}`}</span>
          </label>
        ))}
      </div>
      <div className="ie-actions">
        <Btn kind="primary" disabled={state.busy} onClick={() => void exportTo()}>
          导出为 JSON…
        </Btn>
      </div>
    </Section>
  );
}

/** 导入结果报告。 */
function Report({ state }: { state: ImportExportState }) {
  const report = state.report;
  if (!report) return null;
  return (
    <div className="ie-report">
      <p className="inline-note ok">{`格式：${formatLabel(report.format)}`}</p>
      <p className="inline-note">{`新建 ${report.imported} 个，跳过 ${report.skipped} 个。`}</p>
      {report.connections && report.connections.length ? (
        <div className="ie-list">
          {report.connections.map((c, index) => (
            <div className="ie-row" key={`${c.host}:${c.port}:${index}`}>
              <span className="ie-name">{c.name || c.host}</span>
              <span className="ie-addr">{`${c.username || "—"}@${c.host}:${c.port}`}</span>
            </div>
          ))}
        </div>
      ) : null}
      {(report.warnings || []).map((text, index) => (
        <Note kind="warn" key={index}>
          {text}
        </Note>
      ))}
    </div>
  );
}

/** 导入区：来源格式 + 文件路径 + 导入。 */
function ImportSection({ state }: { state: ImportExportState }) {
  return (
    <Section
      title="导入"
      desc={`支持 pterm 导出文件与 OpenSSH 配置（默认位置 ${sshConfigPath() || "~/.ssh/config"}）。`}
    >
      <Field label="来源格式" hint="不确定时保持自动识别">
        <select
          className="ie-picker"
          value={state.format}
          onChange={(event) => setFormat(event.target.value as ImportFormat)}
        >
          {FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="文件">
        <input
          type="text"
          className="ie-path"
          spellCheck={false}
          placeholder={sshConfigPath() || "选择要导入的文件"}
          value={state.importPath}
          onChange={(event) => setImportPath(event.target.value)}
        />
      </Field>
      <div className="ie-toolbar">
        <Act disabled={state.busy} onClick={() => void pickFile()}>
          选择文件…
        </Act>
        <Act disabled={state.busy} onClick={() => setImportPath(sshConfigPath())}>
          使用 ssh config
        </Act>
      </div>
      <Note>导入一律新建连接，不覆盖已有配置；重复条目会被跳过，凭据需要导入后重新填写。</Note>
      <div className="ie-actions">
        <Btn kind="primary" disabled={state.busy} onClick={() => void runImport()}>
          导入
        </Btn>
      </div>
      {state.lastError ? <Note kind="error">{state.lastError}</Note> : null}
      <Report state={state} />
    </Section>
  );
}

/** 配置导入导出面板（features.connection.import_export 打开时可用）。 */
export function ImportExportModal() {
  const state = useImportExport();
  const t = useT();

  useEffect(() => {
    if (!state.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePanel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state.open]);

  if (!state.open) return null;

  return (
    <Portal selector="body">
      <div
        className="modal-mask"
        id="modal-import-export"
        onClick={(event) => {
          if (event.target === event.currentTarget) closePanel();
        }}
      >
        <div className="modal wide">
          <header className="modal-head">
            <h2>{t("modal.importExport", "配置导入导出")}</h2>
            <button className="icon-btn" onClick={closePanel}>
              ✕
            </button>
          </header>
          <div className="modal-body" id="ie-body">
            {!state.enabled ? (
              <Note>配置导入导出已关闭。请在「设置 → 功能开关」中打开「配置导入导出」。</Note>
            ) : (
              <>
                <ExportSection state={state} />
                <ImportSection state={state} />
              </>
            )}
          </div>
          <footer className="modal-foot">
            <span className="muted" id="ie-hint">
              {state.enabled ? `已保存 ${state.connections.length} 个连接` : ""}
            </span>
            <span className="spacer" />
            <Btn onClick={closePanel}>{t("common.close", "关闭")}</Btn>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
