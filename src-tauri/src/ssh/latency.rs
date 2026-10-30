//! 会话延迟探测。
//!
//! libssh2 的 keepalive 只发送、不回传耗时，拿不到 RTT，因此在同一条已认证
//! 会话上旁路开一条 exec 通道执行 `true`，从发起到远端 EOF 计时。探测通道与
//! 用户的 shell 通道互不影响，也不会往终端里写任何字节。
//!
//! 会话需处于非阻塞模式（shell 泵进入轮询后即如此），`EAGAIN` 按 [`POLL`] 重试。

use std::io::{ErrorKind, Read};
use std::thread;
use std::time::{Duration, Instant};

use ssh2::Session;

/// 单次探测的整体超时：超时不推数值，由调用方按失败累计。
const PROBE_TIMEOUT: Duration = Duration::from_millis(3000);
/// 轮询间隔。比数据泵的 15ms 更细，避免读数被轮询粒度放大。
const POLL: Duration = Duration::from_millis(2);
/// 探测命令。`true` 是内建命令，不依赖远端安装任何东西，也没有输出。
const PROBE_CMD: &str = "true";
/// libssh2 在非阻塞模式下表示「稍后重试」的错误码
const EAGAIN: i32 = -37;

/// 探测一次往返耗时（毫秒）。
///
/// 返回值包含服务端 fork 执行命令的开销，比 ICMP 略高，作为强度指示足够。
/// 失败时返回可读原因，调用方只做计数与日志。
pub(crate) fn probe_once(sess: &Session) -> Result<u32, String> {
    let deadline = Instant::now() + PROBE_TIMEOUT;

    let mut channel = retry("打开探测通道", deadline, || sess.channel_session())?;
    let start = Instant::now();
    retry("发送探测命令", deadline, || channel.exec(PROBE_CMD))?;

    let mut buf = [0u8; 128];
    loop {
        match channel.read(&mut buf) {
            // 非阻塞模式下读到 0 表示远端已 EOF
            Ok(0) => break,
            Ok(_) => continue,
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                if channel.eof() {
                    break;
                }
            }
            Err(e) => {
                let _ = channel.close();
                return Err(format!("读取探测响应失败：{e}"));
            }
        }

        if Instant::now() >= deadline {
            let _ = channel.close();
            return Err(format!("探测超时（{}ms）", PROBE_TIMEOUT.as_millis()));
        }
        thread::sleep(POLL);
    }

    let elapsed = start.elapsed();
    let _ = channel.close();
    Ok(elapsed.as_millis() as u32)
}

/// 在非阻塞会话上重试一个可能返回 `EAGAIN` 的调用。
fn retry<T>(
    what: &str,
    deadline: Instant,
    mut call: impl FnMut() -> Result<T, ssh2::Error>,
) -> Result<T, String> {
    loop {
        match call() {
            Ok(value) => return Ok(value),
            Err(e) if e.code() == ssh2::ErrorCode::Session(EAGAIN) => {
                if Instant::now() >= deadline {
                    return Err(format!("{what}超时（{}ms）", PROBE_TIMEOUT.as_millis()));
                }
                thread::sleep(POLL);
            }
            Err(e) => return Err(format!("{what}失败：{e}")),
        }
    }
}
