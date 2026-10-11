/** 转发类型：本地 / 远程 / 动态（SOCKS5）。 */
export type PortForwardKind = "local" | "remote" | "dynamic";

/** 新建规则的草稿（空串表示未填写，提交时再转成 null / 数字）。 */
export interface PortForwardDraft {
  connection_id: string | null;
  kind: PortForwardKind;
  bind_host: string;
  bind_port: string;
  target_host: string;
  target_port: string;
  label: string;
}

/** 一条运行中的转发规则（由后端 port_forward_list 返回）。 */
export interface RunningForward {
  id: string;
  kind: PortForwardKind;
  label: string;
  /** 形如 `127.0.0.1:8080 → 10.0.0.5:80` 的可读转发路径。 */
  endpoint: string;
  /** 累计连接数。 */
  connections: number;
  /** 所属连接的信息，用于悬停提示。 */
  username: string;
  host: string;
  port: string | number;
  created_at: string;
}
