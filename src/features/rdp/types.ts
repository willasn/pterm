/** 本机 RDP 客户端的探测结果（由后端 rdp_client_available 返回）。 */
export interface RdpClientStatus {
  /** 是否检测到可用客户端。 */
  available: boolean;
  /** 客户端种类：Windows 自带 mstsc / 微软 Windows App。 */
  kind: "mstsc" | "windows_app" | string;
  /** 未检测到时给用户的说明。 */
  hint?: string;
}

/** rdp_open 的入参。Windows 的密码由后端按 connection_id 从保险库读取。 */
export interface RdpOpenInput {
  connection_id: string | null;
  host: string;
  port: number;
  username: string;
  domain: string | null;
  password: string | null;
}

/** rdp_probe 的返回。 */
export interface RdpProbeResult {
  reachable: boolean;
  message: string;
}
