import { useEffect, useRef, type ReactNode } from "react";
import { Btn, Field, Note, Section } from "../../components/form";
import { Portal } from "../../components/Portal";
import { useT } from "../../hooks/useLocale";
import {
  cancelEdit,
  closePanel,
  connect,
  currentHome,
  disconnect,
  download,
  humanSize,
  loadListing,
  modeText,
  navigate,
  parentOf,
  remove,
  selectSession,
  setEditorValue,
  setPendingConn,
  startEdit,
  submitEditor,
  timeText,
  transferActive,
  transferAction,
  transferRatio,
  transferStat,
  uploadFiles,
  uploadFolder,
  useSftp,
  type SftpState,
} from "./store";
import type { SftpEntry, TransferItem } from "./types";

/** 行内操作按钮（sftp-act 样式）。 */
function Act({
  danger,
  disabled,
  onClick,
  children,
}: {
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={"sftp-act " + (danger ? "danger" : "")}
      type="button"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** 已连接：一行「当前连接 + 下拉 + 断开」。 */
function SessionSection({ state }: { state: SftpState }) {
  return (
    <div className="settings-section sftp-conn">
      <div className="sftp-conn-row">
        <span className="sftp-conn-label">当前连接</span>
        <select
          className="sftp-picker"
          value={state.currentId || ""}
          onChange={(event) => void selectSession(event.target.value)}
        >
          {state.sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {`${s.name || s.host} · ${s.username}@${s.host}:${s.port}`}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <Btn kind="danger" disabled={state.busy} onClick={() => void disconnect()}>
          断开连接
        </Btn>
      </div>
    </div>
  );
}

/** 未连接：选一个已保存连接建立 SFTP 会话。 */
function ConnectSection({ state }: { state: SftpState }) {
  if (!state.connections.length) {
    return (
      <div className="settings-section">
        <Note>还没有保存的连接，请先在侧栏新建连接。</Note>
      </div>
    );
  }
  return (
    <div className="settings-section">
      <div className="sftp-actions">
        <select
          className="sftp-picker"
          value={state.pendingConn || ""}
          onChange={(event) => setPendingConn(event.target.value)}
        >
          {state.connections.map((c) => (
            <option key={c.id} value={c.id}>
              {`${c.name || c.host} · ${c.username}@${c.host}:${c.port}`}
            </option>
          ))}
        </select>
        <Btn
          kind="primary"
          disabled={state.busy}
          onClick={() => void connect(state.pendingConn || "")}
        >
          建立 SFTP 连接
        </Btn>
      </div>
    </div>
  );
}

/** 重命名 / 改权限的内联编辑器。 */
function EditorSection({ state }: { state: SftpState }) {
  const editorRef = useRef<HTMLInputElement | null>(null);
  const editing = state.editing!;
  const isRename = editing.kind === "rename";
  const hint = isRename
    ? "输入新名称；含 / 时按当前目录下的相对路径处理，可借此移动条目。"
    : "3~4 位八进制权限位，例如 644（文件）、755（目录或可执行文件）。";

  // 只在开启编辑时聚焦并全选；输入过程中 value 变化不应再次选中
  useEffect(() => {
    const node = editorRef.current;
    if (node) {
      node.focus();
      node.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing.kind, editing.entry.path]);

  return (
    <Section title={isRename ? "重命名" : "修改权限"} desc={`${editing.entry.name} · ${hint}`}>
      <Field label={isRename ? "新名称" : "权限位"}>
        <input
          type="text"
          className="sftp-editor-input"
          spellCheck={false}
          value={editing.value}
          ref={editorRef}
          onChange={(event) => setEditorValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void submitEditor();
          }}
        />
      </Field>
      <div className="sftp-actions">
        <Btn kind="primary" disabled={state.busy} onClick={() => void submitEditor()}>
          确定
        </Btn>
        <Btn disabled={state.busy} onClick={cancelEdit}>
          取消
        </Btn>
      </div>
    </Section>
  );
}

/** 工具栏：路径导航与上传入口。 */
function Toolbar({ state, pathRef }: { state: SftpState; pathRef: { current: HTMLInputElement | null } }) {
  const path = state.listing ? state.listing.path : "";
  return (
    <div className="sftp-toolbar">
      <button
        className="btn ghost"
        type="button"
        disabled={state.busy || !state.listing || state.listing.path === "/"}
        onClick={() => void navigate(parentOf(path))}
      >
        ↑ 上级
      </button>
      <input
        // 换目录时重建输入框，使其显示新路径；否则保持用户正在编辑的文本
        key={path}
        type="text"
        className="sftp-path"
        spellCheck={false}
        placeholder="/var/log"
        defaultValue={path}
        ref={pathRef}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void navigate(pathRef.current ? pathRef.current.value.trim() : "");
        }}
      />
      <Btn disabled={state.busy} onClick={() => void navigate(currentHome())}>
        家目录
      </Btn>
      <Btn
        disabled={state.busy}
        onClick={() => void navigate(pathRef.current ? pathRef.current.value.trim() : "")}
      >
        转到
      </Btn>
      <Btn disabled={state.busy} onClick={() => void loadListing(path)}>
        刷新
      </Btn>
      <Btn kind="primary" disabled={state.busy} onClick={uploadFiles}>
        上传
      </Btn>
      <Btn disabled={state.busy} onClick={uploadFolder}>
        上传文件夹
      </Btn>
    </div>
  );
}

/** 单个目录条目。 */
function ItemRow({ state, entry }: { state: SftpState; entry: SftpEntry }) {
  const label = entry.name + (entry.is_dir ? "/" : "") + (entry.is_symlink ? " ↗" : "");
  return (
    <div className="sftp-item">
      <span
        className={"sftp-name" + (entry.is_dir ? " dir" : "")}
        title={entry.path}
        onClick={entry.is_dir ? () => void navigate(entry.path) : undefined}
      >
        {label}
      </span>
      <span className="sftp-size">{entry.is_dir ? "—" : humanSize(entry.size)}</span>
      <span className="sftp-mode">{modeText(entry.mode)}</span>
      <span className="sftp-time">{timeText(entry.modified)}</span>
      <span className="sftp-acts">
        <Act disabled={state.busy} onClick={() => void download(entry)}>
          下载
        </Act>
        <Act disabled={state.busy} onClick={() => startEdit("rename", entry)}>
          重命名
        </Act>
        <Act disabled={state.busy} onClick={() => startEdit("chmod", entry)}>
          权限
        </Act>
        <Act danger disabled={state.busy} onClick={() => void remove(entry)}>
          删除
        </Act>
      </span>
    </div>
  );
}

/** 目录内容区。 */
function FilesSection({ state }: { state: SftpState }) {
  const pathRef = useRef<HTMLInputElement | null>(null);
  const entries = state.listing ? state.listing.entries : [];
  return (
    <div className="settings-section sftp-files">
      <Toolbar state={state} pathRef={pathRef} />
      <div className="sftp-count">{`共 ${entries.length} 个条目`}</div>
      {state.lastError ? <Note kind="error">{state.lastError}</Note> : null}
      {!entries.length ? (
        <Note>该目录为空。</Note>
      ) : (
        <>
          <div className="sftp-head">
            <span>名称</span>
            <span>大小</span>
            <span>权限</span>
            <span>修改时间</span>
            <span>操作</span>
          </div>
          <div className="sftp-list">
            {entries.map((entry) => (
              <ItemRow key={entry.path} state={state} entry={entry} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** 一条传输进度。 */
function TransferRow({ item }: { item: TransferItem }) {
  const ratio = transferRatio(item);
  const active = transferActive(item);
  return (
    <div className="sftp-tr" data-status={item.status}>
      <span className="sftp-tr-dir">{item.direction === "upload" ? "⬆" : "⬇"}</span>
      <span className="sftp-tr-name" title={item.label}>
        {item.label}
      </span>
      <span className="sftp-tr-pct">{Math.round(ratio * 100) + "%"}</span>
      <div className="sftp-tr-bar">
        <div className="sftp-tr-fill" style={{ width: (ratio * 100).toFixed(1) + "%" }} />
      </div>
      <span className="sftp-tr-stat">{transferStat(item)}</span>
      <button
        className="sftp-tr-cancel"
        type="button"
        title={active ? "中断传输" : "移除"}
        onClick={() => transferAction(item.id)}
      >
        ✕
      </button>
    </div>
  );
}

/** SFTP 文件面板（features.connection.sftp 打开时可用）。 */
export function SftpModal() {
  const state = useSftp();
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

  // 未连接时窗口按内容自适应；有会话（或正在建立）时才撑成固定高度，避免切换目录时高度抖动
  const expanded = state.enabled && (state.sessions.length > 0 || state.connecting);

  return (
    <Portal selector="body">
      <div
        className="modal-mask"
        id="modal-sftp"
        onClick={(event) => {
          if (event.target === event.currentTarget) closePanel();
        }}
      >
        <div className={"modal wide sftp" + (expanded ? " expanded" : "")}>
          <header className="modal-head">
            <h2>{t("modal.sftp", "SFTP 文件")}</h2>
            <button className="icon-btn" onClick={closePanel}>
              ✕
            </button>
          </header>
          <div className="modal-body" id="sftp-body">
            {!state.enabled ? (
              <Note>SFTP 已关闭。请在「设置 → 功能开关」中打开「SFTP」。</Note>
            ) : (
              <>
                {state.sessions.length ? <SessionSection state={state} /> : <ConnectSection state={state} />}
                {state.editing ? <EditorSection state={state} /> : null}
                {state.currentId && state.listing ? (
                  <FilesSection state={state} />
                ) : state.currentId ? (
                  <div className="settings-section sftp-files">
                    <Note>正在载入目录…</Note>
                  </div>
                ) : null}
              </>
            )}
          </div>
          {/* 拖拽上传提示：本地文件拖到窗口内时浮现 */}
          <div className={"sftp-dropzone" + (state.dropVisible ? " active" : "")} id="sftp-dropzone">
            <div className="sftp-dropzone-card">
              <span className="sftp-dropzone-icon">⬆</span>
              <span className="sftp-dropzone-title">松开即可上传到当前目录</span>
              <span className="sftp-dropzone-path" id="sftp-dropzone-path">
                {state.listing ? state.listing.path : ""}
              </span>
            </div>
          </div>
          {/* 建立连接过场：避免等待期间看起来像卡住 */}
          <div className="sftp-connecting" id="sftp-connecting" hidden={!state.connecting}>
            <div className="sftp-connecting-card">
              <span className="sftp-spinner" />
              <span className="sftp-connecting-text" id="sftp-connecting-text">
                {state.connectingText}
              </span>
            </div>
          </div>
          <footer className="modal-foot">
            {/* 传输进度与「关闭」同一行 */}
            <div className="sftp-transfers" id="sftp-transfers" hidden={!state.transfers.length}>
              {state.transfers.map((item) => (
                <TransferRow key={item.id} item={item} />
              ))}
            </div>
            <span className="spacer" />
            <Btn onClick={closePanel}>{t("common.close", "关闭")}</Btn>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
