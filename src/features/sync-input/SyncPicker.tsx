import { useEffect } from "react";
import { Portal } from "../../components/Portal";
import {
  chooseCreate,
  chooseGroup,
  chooseLeave,
  closePicker,
  useSyncInputPicker,
} from "./store";

/**
 * 选组弹框：把标签加入已有组 / 新建组 / 移出组。
 *
 * 弹框挂在 body 上（与迁移前一致），Escape 在捕获阶段拦截并关闭，
 * 避免连带关掉它背后可能存在的弹窗。
 */
export function SyncPicker() {
  const picker = useSyncInputPicker();

  useEffect(() => {
    if (!picker.open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closePicker();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [picker.open]);

  if (!picker.open) return null;

  return (
    <Portal selector="body">
      <div
        className="sync-picker-mask"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closePicker();
        }}
      >
        <div className="sync-picker">
          <div className="sync-picker-head">{picker.title}</div>
          <p className="sync-picker-desc">
            加入后组的标签会用同色标识；开启「组内同步输入」后，只在一台终端输入即可同步到组内其余标签。
          </p>
          <div className="sync-picker-list">
            {picker.rows.map((row) => (
              <button
                key={row.id}
                className="sync-picker-row"
                type="button"
                onClick={() => chooseGroup(row.id)}
              >
                <span className="sync-swatch" style={{ background: row.color }} />
                <span className="name">{`同步组 ${row.index}`}</span>
                <span className="muted">
                  {`${row.liveCount} 个标签 · ${row.active ? "同步中" : "未同步"}`}
                </span>
              </button>
            ))}
            <button className="sync-picker-row create" type="button" onClick={chooseCreate}>
              <span className="ico">＋</span>
              <span className="name">新建同步组</span>
            </button>
          </div>
          {picker.common ? (
            <button className="sync-picker-row" type="button" onClick={chooseLeave}>
              <span className="ico">－</span>
              <span className="name">{`移出同步组 ${picker.common.index}`}</span>
            </button>
          ) : null}
        </div>
      </div>
    </Portal>
  );
}
