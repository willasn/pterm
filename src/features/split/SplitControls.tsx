import { useEffect } from "react";
import { Portal } from "../../components/Portal";
import { useT } from "../../hooks/useLocale";
import { paramsFor } from "../connections/store";
import { closePicker, openInto, start, stop, useSplit } from "./store";

/**
 * 标签栏右侧的分屏方向按钮。
 *
 * 宿主容器 `#split-controls` 由外壳持有（在标签栏内），
 * 这里同步容器的 hidden——CSS 用 `.split-controls[hidden]` 控制整块显隐。
 */
export function SplitControls() {
  const state = useSplit();

  useEffect(() => {
    const host = document.getElementById("split-controls");
    if (host) host.hidden = !state.show;
  }, [state.show]);

  if (!state.show) return null;

  return (
    <>
      <button
        className={"icon-btn split-act" + (state.dir === "h" ? " active" : "")}
        data-act="h"
        title="左右分屏"
        onClick={() => start("h")}
      >
        ⇄
      </button>
      <button
        className={"icon-btn split-act" + (state.dir === "v" ? " active" : "")}
        data-act="v"
        title="上下分屏"
        onClick={() => start("v")}
      >
        ⇅
      </button>
      <button
        className="icon-btn split-act"
        data-act="merge"
        title="取消分屏"
        hidden={!state.split}
        onClick={stop}
      >
        ⊟
      </button>
    </>
  );
}

/** 单个可选目标。 */
function PickerItem({ title, sub, onClick }: { title: string; sub: string; onClick: () => void }) {
  return (
    <div className="split-item" title={sub || title} onClick={onClick}>
      <span className="label">{title}</span>
      <span className="sub">{sub || ""}</span>
    </div>
  );
}

/** 选择要放进新分屏的会话目标。 */
export function SplitPickerModal() {
  const state = useSplit();
  const t = useT();

  useEffect(() => {
    if (!state.pickerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePicker();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state.pickerOpen]);

  if (!state.pickerOpen) return null;

  return (
    <Portal selector="body">
      <div
        className="modal-mask"
        id="modal-split"
        onClick={(event) => {
          if (event.target === event.currentTarget) closePicker();
        }}
      >
        <div className="modal narrow">
          <header className="modal-head">
            <h2 id="split-title">{state.pickerDir === "v" ? "上下分屏" : "左右分屏"}</h2>
            <button className="icon-btn" onClick={closePicker}>
              ✕
            </button>
          </header>
          <div className="modal-body" id="split-body">
            <p className="muted">选择要在新分屏中打开的会话：</p>
            <div className="split-list">
              {state.sameHost ? (
                <PickerItem
                  title={state.sameHost.title}
                  sub={state.sameHost.sub}
                  onClick={() => void openInto(state.sameHost!.params)}
                />
              ) : null}
              {state.connections.length
                ? state.connections.map((conn) => (
                    <PickerItem
                      key={conn.id}
                      title={conn.name || `${conn.username}@${conn.host}`}
                      sub={`${conn.username}@${conn.host}:${conn.port || 22}`}
                      onClick={() => void openInto(paramsFor(conn))}
                    />
                  ))
                : null}
            </div>
            {!state.loading && !state.connections.length ? (
              <p className="muted">还没有已保存的连接，可在左侧新建。</p>
            ) : null}
          </div>
          <footer className="modal-foot">
            <span className="muted" id="split-hint">
              已保存的连接与临时连接均可分屏。
            </span>
            <span className="spacer" />
            <button className="btn ghost" onClick={closePicker}>
              {t("common.cancel", "取消")}
            </button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
