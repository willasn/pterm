/**
 * 应用内弹窗与轻提示宿主。
 *
 * 这些节点由 features/util 的弹窗函数（confirmDialog / ask / choose / promptPassword）
 * 与 toast 按 id 命令式驱动：读取 / 写入文案、切换 hidden、并自行绑定遮罩点击与 Escape，
 * 因此这里只渲染结构，不接管交互。
 */

/** 危险命令图标（三角警告），通用确认与危险命令确认共用。 */
function WarnIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function Dialogs() {
  return (
    <>
      {/* 密码补录：快捷连接认证不通过时手动输入密码，由 util.ts 的 promptPassword() 驱动 */}
      <div className="modal-mask" id="modal-password" hidden>
        <div
          className="modal dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="password-title"
          aria-describedby="password-message"
        >
          <div className="dialog-head">
            <span className="dialog-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </span>
            <div className="dialog-titles">
              <h2 className="dialog-title" id="password-title">
                输入密码
              </h2>
              <p className="dialog-message" id="password-message" />
            </div>
          </div>
          <div className="field compact">
            <div className="field-label">
              <span className="name" id="password-label">
                密码
              </span>
            </div>
            <div className="field-control">
              <input type="password" id="password-input" autoComplete="off" spellCheck={false} />
            </div>
          </div>
          <footer className="dialog-foot">
            <button className="btn ghost" id="password-cancel">
              取消
            </button>
            <button className="btn primary" id="password-ok">
              连接
            </button>
          </footer>
        </div>
      </div>

      {/* 通用二次确认：统一替代系统原生确认框，由 util.ts 的 ask() 驱动 */}
      <div className="modal-mask" id="modal-confirm" hidden>
        <div
          className="modal dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          aria-describedby="confirm-message"
        >
          <div className="dialog-head">
            <span className="dialog-icon warn" id="confirm-icon" aria-hidden="true">
              <WarnIcon />
            </span>
            <div className="dialog-titles">
              <h2 className="dialog-title" id="confirm-title">
                确认操作
              </h2>
              <p className="dialog-message" id="confirm-message" />
            </div>
          </div>
          <footer className="dialog-foot">
            <button className="btn ghost" id="confirm-cancel">
              取消
            </button>
            <button className="btn primary" id="confirm-ok">
              确定
            </button>
          </footer>
        </div>
      </div>

      {/* 通用选项弹窗：需要用户从若干方案中选一个时使用，由 util.ts 的 choose() 驱动 */}
      <div className="modal-mask" id="modal-choose" hidden>
        <div
          className="modal dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="choose-title"
          aria-describedby="choose-message"
        >
          <div className="dialog-head">
            <span className="dialog-icon" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="9" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            </span>
            <div className="dialog-titles">
              <h2 className="dialog-title" id="choose-title">
                请选择
              </h2>
              <p className="dialog-message" id="choose-message" />
            </div>
          </div>
          <div className="dialog-body" id="choose-body" />
          <footer className="dialog-foot">
            <button className="btn ghost" id="choose-cancel">
              取消
            </button>
          </footer>
        </div>
      </div>

      {/* 危险命令二次确认（与通用确认弹窗同一视觉语言） */}
      <div className="modal-mask" id="modal-danger" hidden>
        <div className="modal dialog" role="alertdialog" aria-modal="true">
          <div className="dialog-head">
            <span className="dialog-icon danger" aria-hidden="true">
              <WarnIcon />
            </span>
            <div className="dialog-titles">
              <h2 className="dialog-title danger" data-i18n="modal.danger">
                危险命令确认
              </h2>
              <p className="dialog-message" data-i18n="danger.desc">
                即将在远端执行以下命令，其影响不可撤销：
              </p>
            </div>
          </div>
          <div className="dialog-body">
            <pre className="danger-cmd" id="danger-cmd" />
            <p className="danger-reason" id="danger-reason" />
          </div>
          <footer className="dialog-foot">
            <button className="btn ghost" id="danger-cancel" data-i18n="common.cancel">
              取消
            </button>
            <button className="btn danger-solid" id="danger-confirm" data-i18n="common.confirm">
              确认执行
            </button>
          </footer>
        </div>
      </div>

      <div className="toast-host" id="toast-host" />
    </>
  );
}
