import { dismiss, install, progressPercent, useAutoUpdate } from "./store";

/**
 * 右下角更新提示条。
 *
 * 仅在「发现新版本」「下载中」或「安装失败」时出现；点「稍后」本次会话内不再展示。
 * 下载进度经 Rust 侧的 update 事件回传（见 auto-update/store）。
 */
export function AutoUpdateBanner() {
  const state = useAutoUpdate();
  if (!state.enabled || state.dismissed) return null;

  const downloading = state.status === "downloading";
  const failed = state.status === "error" && !!state.latest;
  if (state.status !== "available" && !downloading && !failed) return null;

  const percent = progressPercent(state);
  const published = state.publishedAt
    ? new Date(state.publishedAt * 1000).toLocaleDateString()
    : "";

  return (
    <div className="update-banner" id="update-banner" role="status" title={state.notes || ""}>
      <div className="update-banner-text">
        <strong>{failed ? "更新失败" : `发现新版本 ${state.latest}`}</strong>
        <span className="muted">
          {failed
            ? state.lastError
            : downloading
              ? percent === null
                ? "正在下载…"
                : `正在下载 ${percent}%`
              : `当前 ${state.current}${published ? ` · ${published} 发布` : ""}`}
        </span>
      </div>
      <div className="update-banner-actions">
        <button className="btn ghost" type="button" disabled={downloading} onClick={dismiss}>
          稍后
        </button>
        <button
          className="btn primary"
          type="button"
          disabled={downloading}
          onClick={() => void install()}
        >
          {downloading ? "下载中" : failed ? "重试" : "立即更新"}
        </button>
      </div>
    </div>
  );
}
