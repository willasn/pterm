import { openMenu } from "../context-menu/store";
import {
  connMenu,
  connectTo,
  connectionState,
  groupEnabled,
  groupedList,
  openForm,
  useConnections,
  useSessionVersion,
} from "./store";

const isRdp = (conn: any) => !!conn && conn.protocol === "rdp";

/** 单条连接。 */
function ConnItem({ conn }: { conn: any }) {
  /** 第二行：用户名@主机:端口，一眼看出连到哪台机器。 */
  const address = `${conn.username ? conn.username + "@" : ""}${conn.host}:${conn.port}`;
  const title = isRdp(conn)
    ? `${conn.domain ? conn.domain + "\\" : ""}${conn.username} → ${conn.host}:${conn.port}`
    : `${conn.username}@${conn.host}:${conn.port}`;

  return (
    <div
      className="conn-item"
      // 有会话在跑时带上状态，让状态点沿用标签栏那套状态色（见 styles/terminal.css 的 [data-state]）
      data-state={connectionState(conn.id) || undefined}
      title={title}
      onClick={() => void connectTo(conn)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openMenu(event.clientX, event.clientY, connMenu(conn));
      }}
    >
      <span className="dot" style={conn.color ? { background: conn.color } : undefined} />
      {/* 顺序即网格放置顺序：名称第一列，协议徽标第一行右端，地址横跨两列落到第二行 */}
      <span className="conn-text">
        <span className="label">{conn.name}</span>
        {isRdp(conn) ? (
          <span className="proto" title="远程桌面（RDP）">
            RDP
          </span>
        ) : null}
        <span className="sub">{address}</span>
      </span>
      <button
        className="icon-btn edit"
        title="编辑该连接"
        onClick={(event) => {
          event.stopPropagation();
          openForm(conn);
        }}
      >
        ✎
      </button>
    </div>
  );
}

/** 侧栏连接列表（渲染进外壳的 #conn-list）。 */
export function ConnectionList() {
  const state = useConnections();
  // 订阅会话状态版本：会话增删 / 状态变化时重渲染，让连接点的状态色跟上
  useSessionVersion();

  return (
    <>
      {!state.list.length ? (
        <p className="inline-note">还没有连接，点击右上角 ＋ 新建。</p>
      ) : !groupEnabled() ? (
        state.list.map((conn) => <ConnItem key={conn.id} conn={conn} />)
      ) : (
        groupedList().map((group) => (
          <div key={group.key}>
            <div className="conn-group-title">{group.key}</div>
            {group.items.map((conn) => (
              <ConnItem key={conn.id} conn={conn} />
            ))}
          </div>
        ))
      )}
    </>
  );
}
