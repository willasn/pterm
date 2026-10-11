import type { ReactNode } from "react";

/**
 * 与既有 util.form 对齐的基础元素。
 *
 * DOM 结构与类名必须与迁移前一致——样式（settings.css / base.css）依赖这些类名，
 * 且外壳（AppShell）与其它组件也用同一套结构，保持视觉与间距统一。
 *
 * 迁移模块变多后可继续在这里补充，但不要为了「可能会用到」提前添加。
 */

export function Note({ kind, children }: { kind?: string; children: ReactNode }) {
  return <p className={"inline-note " + (kind || "")}>{children}</p>;
}

export function Field({
  label,
  hint,
  compact,
  children,
}: {
  label: string;
  hint?: string | null;
  /** 紧凑行（连接编辑表单用）：label 与控件同一行。 */
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={"field" + (compact ? " compact" : "")}>
      <div className="field-label">
        <span className="name">{label}</span>
        {hint ? <span className="hint">{hint}</span> : null}
      </div>
      <div className="field-control">{children}</div>
    </div>
  );
}

/** 一个设置分区：标题 + 说明 + 若干字段。 */
export function Section({ title, desc, children }: { title: string; desc?: string | null; children?: ReactNode }) {
  return (
    <div className="settings-section">
      <h3>{title}</h3>
      {desc ? <p className="desc">{desc}</p> : null}
      {children}
    </div>
  );
}

export function Btn({
  kind = "ghost",
  disabled,
  onClick,
  children,
}: {
  kind?: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button className={"btn " + kind} type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}
