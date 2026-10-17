import { Btn, Note } from "../../components/form";
import { Portal } from "../../components/Portal";
import {
  closeKnownHosts,
  forgetKnownHost,
  getKnownHosts,
  getKnownHostsOpen,
  refreshKnownHosts,
  useSettingsVersion,
} from "./store";

/**
 * 「已知主机」独立弹窗（由「设置 → 连接 → 主机密钥校验」右侧按钮唤起）。
 *
 * 与设置面板分开渲染：关闭本弹窗不影响设置面板，Escape 也由设置面板统一处理为
 * 先关本弹窗。数据与增删逻辑仍复用设置 store。
 */
export function KnownHostsModal() {
  const version = useSettingsVersion();
  void version; // 订阅重绘
  if (!getKnownHostsOpen()) return null;
  const hosts = getKnownHosts();

  return (
    <Portal selector="body">
      <div
        className="modal-mask"
        id="modal-known-hosts"
        onClick={(event) => {
          if (event.target === event.currentTarget) closeKnownHosts();
        }}
      >
        <div className="modal wide">
          <header className="modal-head">
            <h2>已知主机</h2>
            <button className="icon-btn" onClick={closeKnownHosts}>
              ✕
            </button>
          </header>
          <div className="modal-body">
            <p className="desc">
              记录并比对服务端主机密钥指纹，抵御中间人攻击。首次连接或密钥变更时会弹窗确认；记录为本机私有，不随 Git 同步。
            </p>
            <div className="known-hosts">
              {hosts.length === 0 ? (
                <Note>尚无记录。成功连接并信任的主机会出现在这里。</Note>
              ) : (
                hosts.map((item: any) => (
                  <div className="known-host-row" key={`${item.host}:${item.port}`}>
                    <span className="kh-target">
                      {item.host}:{item.port}
                    </span>
                    <span className="kh-fp" title={`${item.key_type} ${item.fingerprint}`}>
                      {item.fingerprint}
                    </span>
                    <Btn onClick={() => forgetKnownHost(item.host, item.port)}>移除</Btn>
                  </div>
                ))
              )}
              <div className="known-host-actions">
                <Btn onClick={() => refreshKnownHosts()}>刷新</Btn>
              </div>
            </div>
          </div>
          <footer className="modal-foot">
            <span className="muted">
              {hosts.length ? `共 ${hosts.length} 台` : ""}
            </span>
            <span className="spacer" />
            <Btn onClick={closeKnownHosts}>关闭</Btn>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
