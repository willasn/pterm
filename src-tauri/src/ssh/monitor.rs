//! 会话资源监控（CPU / 内存 / 负载 / 磁盘 / 网络）。
//!
//! 与延迟探测一样，在同一条已认证会话上旁路开一条 exec 通道执行只读命令，
//! 采集远端主机的资源占用，供终端右下角的小面板展示。探测通道与用户的 shell
//! 通道互不影响，也不会往终端里写任何字节。
//!
//! **按需采样**：功能开关关闭时，会话线程每轮只做一次原子判断，不打开通道、
//! 不执行任何远端命令；开关打开后才按 [`INTERVAL`] 节流采样。
//!
//! 会话需处于非阻塞模式（shell 泵进入轮询后即如此），`EAGAIN` 按 [`POLL`] 重试。

use std::collections::HashMap;
use std::io::{ErrorKind, Read};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use ssh2::Session;
use tauri::{AppHandle, Emitter};

/// 采样间隔（面板刷新频率）。
pub const INTERVAL: Duration = Duration::from_secs(3);

/// 单次采样整体超时：超时记为一次失败，不阻塞会话线程太久。
const PROBE_TIMEOUT: Duration = Duration::from_millis(2000);
/// 轮询间隔。与延迟探测一致，避免读数被轮询粒度放大。
const POLL: Duration = Duration::from_millis(2);
/// libssh2 在非阻塞模式下表示「稍后重试」的错误码
const EAGAIN: i32 = -37;
/// 连续失败多少次后停止采样（远端可能不支持 / 禁用了 exec）
const MAX_FAILURES: u32 = 3;
/// 单次采样输出上限，防止异常远端刷爆内存
const OUT_LIMIT: usize = 64 * 1024;

/// 采集命令。
///
/// 优先读 Linux 的 `/proc`；否则按 macOS 的 `ps` / `vm_stat` / `netstat` 回退。
/// 整个脚本用单引号包在 `sh -c` 里，脚本内部不出现单引号与需要转义的字符，
/// 因此远端登录 shell 是 fish / zsh / bash 都能正确执行。
const PROBE_CMD: &str = r#"sh -c '
if [ -r /proc/stat ]; then
  echo PT_LINUX
  echo PT_CPU
  head -n 1 /proc/stat
  echo PT_MEM
  head -n 30 /proc/meminfo
  echo PT_LOAD
  cat /proc/loadavg
  echo PT_DISK
  df -Pk / 2>/dev/null | tail -n 1
  echo PT_NET
  cat /proc/net/dev
else
  echo PT_DARWIN
  echo PT_CPU
  ps -A -o %cpu 2>/dev/null
  echo PT_SYS
  sysctl -n hw.ncpu hw.memsize hw.pagesize 2>/dev/null
  echo PT_MEM
  vm_stat 2>/dev/null
  echo PT_LOAD
  sysctl -n vm.loadavg 2>/dev/null
  echo PT_DISK
  df -Pk / 2>/dev/null | tail -n 1
  echo PT_NET
  netstat -ibn 2>/dev/null | head -n 200
fi
'"#;

/// 硬件信息采集命令（打开监控后只执行一次，结果缓存到会话线程）。
///
/// 同样包在 `sh -c` 里；Linux 读 `/proc/cpuinfo`、`dmidecode`（需要 root，
/// 读不到就留空）、`lsblk`；macOS 用 `sysctl` 与 `diskutil`。
const HARDWARE_CMD: &str = r#"sh -c '
if [ -r /proc/cpuinfo ]; then
  echo PT_LINUX
  echo PT_CPU
  head -n 40 /proc/cpuinfo
  echo PT_CORES
  getconf _NPROCESSORS_ONLN 2>/dev/null
  echo PT_DMI
  dmidecode -t 17 2>/dev/null | head -n 240
  echo PT_DISK
  lsblk -dPno NAME,MODEL,SIZE,TYPE 2>/dev/null | head -n 20
else
  echo PT_DARWIN
  echo PT_CPU
  sysctl -n machdep.cpu.brand_string 2>/dev/null
  echo PT_CORES
  sysctl -n hw.ncpu 2>/dev/null
  echo PT_DISK
  diskutil info / 2>/dev/null | head -n 60
fi
'"#;

/// 静态硬件信息，打开监控时采集一次，随后随每轮指标一起下发。
#[derive(Debug, Clone, Default, Serialize)]
pub struct Hardware {
    /// CPU 型号
    pub cpu_model: Option<String>,
    /// CPU 核心数
    pub cpu_cores: Option<u32>,
    /// 内存条型号（Linux 需 dmidecode 可读，通常要求 root；读不到为 None）
    pub mem_model: Option<String>,
    /// 物理磁盘「型号 + 容量」列表
    pub disks: Vec<String>,
}

/// 一次采样的结果。字段为 `None` 表示该平台 / 该轮拿不到。
#[derive(Debug, Clone, Default, Serialize)]
pub struct Metrics {
    /// 静态硬件信息（每轮原样带上，供前端 hover 展示）
    pub hardware: Option<Hardware>,
    /// CPU 使用率（0-100）；首轮没有基线，给 `None`
    pub cpu: Option<f64>,
    /// 已用内存（字节）
    pub mem_used: Option<u64>,
    /// 总内存（字节）
    pub mem_total: Option<u64>,
    /// 1 分钟平均负载
    pub load1: Option<f64>,
    /// 已用磁盘（字节，根分区）
    pub disk_used: Option<u64>,
    /// 总磁盘（字节，根分区）
    pub disk_total: Option<u64>,
    /// 网络接收速率（字节 / 秒）
    pub net_rx: Option<f64>,
    /// 网络发送速率（字节 / 秒）
    pub net_tx: Option<f64>,
}

/// CPU 累计 tick 采样（Linux）。
#[derive(Debug, Clone, Copy)]
struct CpuSample {
    total: u64,
    idle: u64,
}

/// 上一轮采样，用于计算 CPU 占用率与网络速率。
#[derive(Debug, Clone)]
struct Prev {
    at: Instant,
    cpu: Option<CpuSample>,
    net: Option<(u64, u64)>,
}

/// 每个会话持有的采样状态。
pub struct Monitor {
    /// 是否处于开启态：关闭后只保留一个布尔判断，不再取时钟、不再清状态
    active: bool,
    prev: Option<Prev>,
    next: Instant,
    failures: u32,
    gave_up: bool,
    /// 硬件信息只采一次并缓存（同一连接不会变）
    hardware: Option<Hardware>,
    hardware_tried: bool,
}

impl Monitor {
    pub fn new() -> Self {
        Self {
            active: false,
            prev: None,
            next: Instant::now(),
            failures: 0,
            gave_up: false,
            hardware: None,
            hardware_tried: false,
        }
    }

    /// 由 shell 泵在空闲轮调用。
    ///
    /// `enabled` 为 false 时清空基线并直接返回——开关关闭期间不产生任何通道与 IO，
    /// 重新打开后从头累计（首轮只有内存 / 负载 / 磁盘，CPU 与网络从第二轮起有值）。
    pub fn tick(&mut self, app: &AppHandle, id: &str, sess: &Session, enabled: bool) {
        if !enabled {
            // 关闭态：只在刚关闭时清理一次，之后每轮只做这个分支判断
            if !self.active {
                return;
            }
            self.active = false;
            self.prev = None;
            self.failures = 0;
            self.gave_up = false;
            return;
        }
        if !self.active {
            // 刚打开：立刻采一次，不必等满一个间隔
            self.active = true;
            self.next = Instant::now();
        }
        if self.gave_up || Instant::now() < self.next {
            return;
        }
        // 先占位再采样：单次采样即便慢也不会导致下一轮立刻重试
        self.next = Instant::now() + INTERVAL;

        // 硬件信息只在首次采样前取一次；失败也不再重试，避免每轮都白跑命令
        if !self.hardware_tried {
            self.hardware_tried = true;
            self.hardware = probe_hardware(sess);
        }

        match probe_once(sess, &mut self.prev) {
            Ok(mut metrics) => {
                self.failures = 0;
                metrics.hardware = self.hardware.clone();
                if let Err(e) = app.emit(&metrics_event(id), &metrics) {
                    log::warn!("推送会话 {id} 资源监控失败：{e}");
                }
            }
            Err(e) => {
                self.failures += 1;
                log::debug!("会话 {id} 资源采样失败（{}/{}）：{e}", self.failures, MAX_FAILURES);
                if self.failures >= MAX_FAILURES {
                    self.gave_up = true;
                    let payload = serde_json::json!({ "unsupported": true });
                    if let Err(err) = app.emit(&metrics_event(id), payload) {
                        log::warn!("推送会话 {id} 监控不可用事件失败：{err}");
                    }
                    log::info!("会话 {id} 资源监控连续失败，停止采样");
                }
            }
        }
    }
}

/// 资源指标事件名。前端按会话 id 订阅。
pub fn metrics_event(id: &str) -> String {
    format!("ssh:metrics:{id}")
}

// ---------------------------------------------------------------------------
// 远端采样
// ---------------------------------------------------------------------------

/// 执行一条采集命令，返回原始输出。
fn exec_read(sess: &Session, cmd: &str) -> Result<String, String> {
    let deadline = Instant::now() + PROBE_TIMEOUT;

    let mut channel = retry("打开监控通道", deadline, || sess.channel_session())?;
    retry("发送监控命令", deadline, || channel.exec(cmd))?;

    let mut out: Vec<u8> = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match channel.read(&mut buf) {
            // 非阻塞模式下读到 0 表示远端已 EOF
            Ok(0) => break,
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                if out.len() >= OUT_LIMIT {
                    break;
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                if channel.eof() {
                    break;
                }
            }
            Err(e) => {
                let _ = channel.close();
                return Err(format!("读取监控输出失败：{e}"));
            }
        }

        if Instant::now() >= deadline {
            let _ = channel.close();
            return Err(format!("监控命令超时（{}ms）", PROBE_TIMEOUT.as_millis()));
        }
        thread::sleep(POLL);
    }

    let _ = channel.close();
    Ok(String::from_utf8_lossy(&out).into_owned())
}

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

fn probe_once(sess: &Session, prev: &mut Option<Prev>) -> Result<Metrics, String> {
    let text = exec_read(sess, PROBE_CMD)?;
    parse_at(&text, prev, Instant::now())
}

/// 采集静态硬件信息；失败不视为监控失败（只是 hover 详情少几项）。
fn probe_hardware(sess: &Session) -> Option<Hardware> {
    let text = exec_read(sess, HARDWARE_CMD).ok()?;
    parse_hardware(&text)
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/// 把带 `PT_*` 标记的输出切成「平台 + 各段内容」。
fn collect_sections(text: &str) -> (&'static str, HashMap<&'static str, Vec<&str>>) {
    let mut platform: &'static str = "";
    let mut section: &'static str = "";
    let mut sections: HashMap<&'static str, Vec<&str>> = HashMap::new();

    for raw in text.lines() {
        let line = raw.trim_end();
        match line.trim() {
            "PT_LINUX" => {
                platform = "linux";
                section = "";
            }
            "PT_DARWIN" => {
                platform = "darwin";
                section = "";
            }
            "PT_CPU" => section = "cpu",
            "PT_SYS" => section = "sys",
            "PT_MEM" => section = "mem",
            "PT_LOAD" => section = "load",
            "PT_DISK" => section = "disk",
            "PT_NET" => section = "net",
            "PT_CORES" => section = "cores",
            "PT_DMI" => section = "dmi",
            _ => {
                if !section.is_empty() && !line.trim().is_empty() {
                    sections.entry(section).or_default().push(line);
                }
            }
        }
    }

    (platform, sections)
}

fn parse_at(text: &str, prev: &mut Option<Prev>, now: Instant) -> Result<Metrics, String> {
    let (platform, sections) = collect_sections(text);
    if platform.is_empty() {
        return Err("无法识别远端系统".into());
    }

    let cpu_ticks;
    let mut cpu_percent = None;
    let mut mem_used = None;
    let mut mem_total = None;
    let mut load1 = None;
    let mut disk_used = None;
    let mut disk_total = None;
    let mut net_now = None;

    if platform == "linux" {
        cpu_ticks = sections
            .get("cpu")
            .and_then(|lines| lines.first())
            .and_then(|line| parse_linux_cpu(line));

        let kv = parse_meminfo(sections.get("mem").map(|v| v.as_slice()).unwrap_or(&[]));
        if let Some(&total) = kv.get("MemTotal") {
            let avail = kv.get("MemAvailable").copied().or_else(|| {
                let free = kv.get("MemFree")?;
                Some(free + kv.get("Buffers").copied().unwrap_or(0) + kv.get("Cached").copied().unwrap_or(0))
            });
            mem_total = Some(total.saturating_mul(1024));
            if let Some(avail) = avail {
                mem_used = Some(total.saturating_sub(avail).saturating_mul(1024));
            }
        }

        load1 = sections
            .get("load")
            .and_then(|lines| lines.first())
            .and_then(|line| parse_first_f64(line));

        if let Some((total, used)) = sections
            .get("disk")
            .and_then(|lines| lines.first())
            .and_then(|line| parse_df(line))
        {
            disk_total = Some(total);
            disk_used = Some(used);
        }

        net_now = parse_linux_net(sections.get("net").map(|v| v.as_slice()).unwrap_or(&[]));
    } else {
        cpu_ticks = None;
        let sys = sections.get("sys").map(|v| v.as_slice()).unwrap_or(&[]);
        let ncpu = sys
            .first()
            .and_then(|v| v.trim().parse::<f64>().ok())
            .unwrap_or(1.0)
            .max(1.0);
        let mem_size = sys.get(1).and_then(|v| v.trim().parse::<u64>().ok());
        let page_size = sys
            .get(2)
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(4096);

        let cpu_sum: f64 = sections
            .get("cpu")
            .map(|lines| {
                lines
                    .iter()
                    .filter_map(|line| line.trim().parse::<f64>().ok())
                    .sum()
            })
            .unwrap_or(0.0);
        cpu_percent = Some((cpu_sum / ncpu).clamp(0.0, 100.0));

        let (active, wired, compressor) =
            parse_vm_stat(sections.get("mem").map(|v| v.as_slice()).unwrap_or(&[]));
        mem_total = mem_size;
        mem_used = Some(
            active
                .saturating_add(wired)
                .saturating_add(compressor)
                .saturating_mul(page_size),
        );

        load1 = sections
            .get("load")
            .and_then(|lines| lines.first())
            .and_then(|line| parse_first_f64(line));

        if let Some((total, used)) = sections
            .get("disk")
            .and_then(|lines| lines.first())
            .and_then(|line| parse_df(line))
        {
            disk_total = Some(total);
            disk_used = Some(used);
        }

        net_now = parse_darwin_net(sections.get("net").map(|v| v.as_slice()).unwrap_or(&[]));
    }

    // CPU：Linux 用前后两次累计 tick 的差值；macOS 已在上面直接算出
    let cpu = match (prev.as_ref().and_then(|p| p.cpu), cpu_ticks) {
        (Some(before), Some(current)) => {
            let total = current.total.saturating_sub(before.total);
            let idle = current.idle.saturating_sub(before.idle);
            if total == 0 {
                None
            } else {
                Some((100.0 * (1.0 - idle as f64 / total as f64)).clamp(0.0, 100.0))
            }
        }
        _ => cpu_percent,
    };

    // 网络速率：用两轮累计字节差除以实际间隔
    let mut net_rx = None;
    let mut net_tx = None;
    if let (Some(before), Some((rx, tx))) = (prev.as_ref(), net_now) {
        let secs = now.saturating_duration_since(before.at).as_secs_f64();
        if let Some((prx, ptx)) = before.net {
            if secs > 0.2 {
                net_rx = Some(rx.saturating_sub(prx) as f64 / secs);
                net_tx = Some(tx.saturating_sub(ptx) as f64 / secs);
            }
        }
    }

    *prev = Some(Prev {
        at: now,
        cpu: cpu_ticks,
        net: net_now,
    });

    Ok(Metrics {
        hardware: None,
        cpu,
        mem_used,
        mem_total,
        load1,
        disk_used,
        disk_total,
        net_rx,
        net_tx,
    })
}

/// `/proc/stat` 第一行的 CPU 累计 tick。total 取前 8 个字段，idle 含 iowait。
fn parse_linux_cpu(line: &str) -> Option<CpuSample> {
    let mut parts = line.split_whitespace();
    if parts.next()? != "cpu" {
        return None;
    }
    let vals: Vec<u64> = parts.take(8).filter_map(|v| v.parse().ok()).collect();
    if vals.len() < 4 {
        return None;
    }
    let total = vals.iter().sum();
    let idle = vals[3] + vals.get(4).copied().unwrap_or(0);
    Some(CpuSample { total, idle })
}

/// 解析 `/proc/meminfo` 的 `Key: value kB` 行。
fn parse_meminfo<'a>(lines: &[&'a str]) -> HashMap<&'a str, u64> {
    let mut out = HashMap::new();
    for line in lines {
        if let Some((key, rest)) = line.split_once(':') {
            if let Some(value) = rest
                .split_whitespace()
                .next()
                .and_then(|v| v.parse::<u64>().ok())
            {
                out.insert(key.trim(), value);
            }
        }
    }
    out
}

/// 解析 `vm_stat` 的活跃 / 常驻 / 压缩页数。
fn parse_vm_stat(lines: &[&str]) -> (u64, u64, u64) {
    let mut active = 0;
    let mut wired = 0;
    let mut compressor = 0;
    for line in lines {
        if let Some((key, rest)) = line.split_once(':') {
            let value = rest.trim().trim_end_matches('.').parse::<u64>().unwrap_or(0);
            match key.trim() {
                "Pages active" => active = value,
                "Pages wired down" => wired = value,
                "Pages occupied by compressor" => compressor = value,
                _ => {}
            }
        }
    }
    (active, wired, compressor)
}

/// 解析 `df -Pk` 的一行，返回（总字节，已用字节）。
fn parse_df(line: &str) -> Option<(u64, u64)> {
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 3 {
        return None;
    }
    let total = parts[1].parse::<u64>().ok()?;
    let used = parts[2].parse::<u64>().ok()?;
    Some((total.saturating_mul(1024), used.saturating_mul(1024)))
}

/// 解析 `/proc/net/dev`：跳过两行表头，累加除 lo 以外的收发字节。
fn parse_linux_net(lines: &[&str]) -> Option<(u64, u64)> {
    let mut rx = 0u64;
    let mut tx = 0u64;
    let mut any = false;
    for line in lines.iter().skip(2) {
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        if name.trim() == "lo" {
            continue;
        }
        let vals: Vec<u64> = rest.split_whitespace().filter_map(|v| v.parse().ok()).collect();
        if vals.len() < 9 {
            continue;
        }
        rx += vals[0];
        tx += vals[8];
        any = true;
    }
    any.then_some((rx, tx))
}

/// 解析 macOS `netstat -ibn`：每个接口会按地址重复多行，只取首行避免重复计数。
fn parse_darwin_net(lines: &[&str]) -> Option<(u64, u64)> {
    let mut rx = 0u64;
    let mut tx = 0u64;
    let mut any = false;
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for line in lines.iter().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 || fields[0] == "lo0" {
            continue;
        }
        // 同一接口后续地址行的字节数会重复出现，按接口名去重
        if !seen.insert(fields[0]) {
            continue;
        }
        let (Ok(r), Ok(t)) = (fields[6].parse::<u64>(), fields[9].parse::<u64>()) else {
            continue;
        };
        rx += r;
        tx += t;
        any = true;
    }
    any.then_some((rx, tx))
}

/// 取一行里的第一个浮点数（兼容 macOS `vm.loadavg` 输出的 `{ 1.2 3.4 }`）。
fn parse_first_f64(line: &str) -> Option<f64> {
    let cleaned = line.trim().trim_matches(|c| c == '{' || c == '}');
    cleaned.split_whitespace().next()?.parse::<f64>().ok()
}

// ---------------------------------------------------------------------------
// 硬件信息解析
// ---------------------------------------------------------------------------

fn parse_hardware(text: &str) -> Option<Hardware> {
    let (platform, sections) = collect_sections(text);
    if platform.is_empty() {
        return None;
    }
    let mut hw = Hardware::default();

    let cpu_lines = sections.get("cpu").map(|v| v.as_slice()).unwrap_or(&[]);
    let disk_lines = sections.get("disk").map(|v| v.as_slice()).unwrap_or(&[]);

    if platform == "linux" {
        // /proc/cpuinfo：x86 用 model name，ARM 常见 Model / Hardware
        for line in cpu_lines {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            let key = key.trim();
            let value = value.trim();
            if value.is_empty() {
                continue;
            }
            if key.eq_ignore_ascii_case("model name") || key == "Model" || key == "Hardware" {
                hw.cpu_model = Some(value.to_string());
                break;
            }
        }
        hw.mem_model = parse_dimms(sections.get("dmi").map(|v| v.as_slice()).unwrap_or(&[]));
        hw.disks = parse_lsblk(disk_lines);
    } else {
        hw.cpu_model = cpu_lines
            .iter()
            .map(|line| line.trim())
            .find(|line| !line.is_empty())
            .map(|line| line.to_string());
        hw.disks = parse_diskutil(disk_lines);
    }

    hw.cpu_cores = sections
        .get("cores")
        .and_then(|lines| lines.first())
        .and_then(|line| line.trim().parse::<u32>().ok());

    Some(hw)
}

/// 从 `dmidecode -t 17` 里取出已安装内存条的型号 / 类型 / 频率（通常需要 root）。
fn parse_dimms(lines: &[&str]) -> Option<String> {
    let mut blocks: Vec<Vec<&str>> = Vec::new();
    for line in lines {
        if line.trim().starts_with("Memory Device") {
            blocks.push(Vec::new());
            continue;
        }
        if let Some(block) = blocks.last_mut() {
            block.push(line);
        }
    }

    let mut out: Vec<String> = Vec::new();
    for block in blocks {
        let mut size = "";
        let mut ty = "";
        let mut speed = "";
        let mut maker = "";
        for line in block {
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            match key.trim() {
                "Size" => size = value.trim(),
                "Type" => ty = value.trim(),
                "Speed" => speed = value.trim(),
                "Manufacturer" => maker = value.trim(),
                _ => {}
            }
        }
        if size.is_empty() || size.contains("No Module") || size == "Unknown" {
            continue;
        }
        let mut parts: Vec<String> = Vec::new();
        if !maker.is_empty() && maker != "Unknown" && maker != "Not Specified" {
            parts.push(maker.to_string());
        }
        parts.push(size.to_string());
        if !ty.is_empty() && ty != "Unknown" && ty != "Other" {
            parts.push(ty.to_string());
        }
        if !speed.is_empty() && !speed.contains("Unknown") {
            parts.push(speed.to_string());
        }
        out.push(parts.join(" "));
        if out.len() >= 4 {
            break;
        }
    }

    (!out.is_empty()).then(|| out.join(" / "))
}

/// 解析 `lsblk -dPno NAME,MODEL,SIZE,TYPE` 的 `KEY="value"` 行，只保留物理磁盘。
fn parse_lsblk(lines: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in lines {
        let mut name = String::new();
        let mut model = String::new();
        let mut size = String::new();
        let mut kind = String::new();
        for (key, value) in parse_pairs(line) {
            match key.as_str() {
                "NAME" => name = value,
                "MODEL" => model = value,
                "SIZE" => size = value,
                "TYPE" => kind = value,
                _ => {}
            }
        }
        if kind != "disk" || size.is_empty() {
            continue;
        }
        let label = if model.trim().is_empty() { name.trim() } else { model.trim() };
        out.push(format!("{label} {size}"));
        if out.len() >= 4 {
            break;
        }
    }
    out
}

/// 解析 `KEY="value"` 形式的一行（值里可能带空格）。
fn parse_pairs(line: &str) -> Vec<(String, String)> {
    let bytes = line.as_bytes();
    let mut out: Vec<(String, String)> = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        while i < bytes.len() && bytes[i] == b' ' {
            i += 1;
        }
        let key_start = i;
        while i < bytes.len() && bytes[i] != b'=' {
            i += 1;
        }
        if i >= bytes.len() || key_start == i {
            break;
        }
        let key = line[key_start..i].to_string();
        i += 1;
        if i < bytes.len() && bytes[i] == b'"' {
            i += 1;
            let value_start = i;
            while i < bytes.len() && bytes[i] != b'"' {
                i += 1;
            }
            out.push((key, line[value_start..i].to_string()));
            if i < bytes.len() {
                i += 1;
            }
        } else {
            let value_start = i;
            while i < bytes.len() && bytes[i] != b' ' {
                i += 1;
            }
            out.push((key, line[value_start..i].to_string()));
        }
    }
    out
}

/// 从 `diskutil info /` 取介质名称与容量。
fn parse_diskutil(lines: &[&str]) -> Vec<String> {
    let mut media = "";
    let mut size = "";
    for line in lines {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "Device / Media Name" => media = value,
            "Disk Size" if !value.is_empty() => {
                size = value.split(" (").next().unwrap_or(value);
            }
            _ => {}
        }
    }
    let text = format!("{} {}", media, size).trim().to_string();
    if text.is_empty() {
        Vec::new()
    } else {
        vec![text]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINUX_SAMPLE: &str = "PT_LINUX\n\
PT_CPU\n\
cpu  100 0 100 800 0 0 0 0 0 0\n\
PT_MEM\n\
MemTotal:       1000000 kB\n\
MemFree:         200000 kB\n\
MemAvailable:    400000 kB\n\
PT_LOAD\n\
0.42 0.30 0.20 1/100 1234\n\
PT_DISK\n\
/dev/sda1 10000 4000 6000 40% /\n\
PT_NET\n\
Inter-|   Receive                                                |  Transmit\n\
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n\
eth0: 1000 1 0 0 0 0 0 0 500 1 0 0 0 0 0 0\n";

    #[test]
    fn parses_linux_metrics_and_deltas() {
        let mut prev = None;
        let base = Instant::now();
        let first = parse_at(LINUX_SAMPLE, &mut prev, base).unwrap();
        assert_eq!(first.mem_total, Some(1_000_000 * 1024));
        assert_eq!(first.mem_used, Some(600_000 * 1024));
        assert_eq!(first.load1, Some(0.42));
        assert_eq!(first.disk_total, Some(10_000 * 1024));
        assert_eq!(first.disk_used, Some(4_000 * 1024));
        // 首轮没有 CPU / 网络基线
        assert!(first.cpu.is_none());
        assert!(first.net_rx.is_none());

        let second_text = LINUX_SAMPLE
            .replace("cpu  100 0 100 800", "cpu  200 0 100 900")
            .replace("eth0: 1000 1 0 0 0 0 0 0 500", "eth0: 3000 1 0 0 0 0 0 0 2500");
        let second = parse_at(&second_text, &mut prev, base + Duration::from_secs(2)).unwrap();
        // 总 tick 1000 -> 1200（+200），idle 800 -> 900（+100）
        let expected = 100.0 * (1.0 - 100.0 / 200.0);
        assert!((second.cpu.unwrap() - expected).abs() < 0.01);
        // 接收 +2000 字节 / 2 秒
        assert!((second.net_rx.unwrap() - 1000.0).abs() < 0.01);
        assert!((second.net_tx.unwrap() - 1000.0).abs() < 0.01);
    }

    #[test]
    fn parses_darwin_metrics() {
        let text = "PT_DARWIN\n\
PT_CPU\n\
%CPU\n\
12.5\n\
37.5\n\
PT_SYS\n\
8\n\
17179869184\n\
16384\n\
PT_MEM\n\
Mach Virtual Memory Statistics:\n\
Pages active:                            1000.\n\
Pages wired down:                         500.\n\
Pages occupied by compressor:             100.\n\
PT_LOAD\n\
{ 1.50 1.20 1.10 }\n\
PT_DISK\n\
/dev/disk1s1 10000 2500 7500 25% /\n\
PT_NET\n\
Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll\n\
en0 1500 <Link#4> aa:bb 10 0 1000 20 0 500 0\n\
en0 1500 192.168.1/24 192.168.1.2 10 - 1000 20 - 500 -\n";

        let mut prev = None;
        let metrics = parse_at(text, &mut prev, Instant::now()).unwrap();
        // (12.5 + 37.5) / 8
        assert!((metrics.cpu.unwrap() - 6.25).abs() < 0.01);
        assert_eq!(metrics.mem_total, Some(17_179_869_184));
        assert_eq!(metrics.mem_used, Some((1000 + 500 + 100) * 16384));
        assert_eq!(metrics.load1, Some(1.5));
        assert_eq!(metrics.disk_total, Some(10_000 * 1024));
        // 只累加带数字字节的首行，重复地址行不重复计算
        assert_eq!(prev.as_ref().unwrap().net, Some((1000, 500)));
    }

    #[test]
    fn rejects_unknown_platform() {
        let mut prev = None;
        assert!(parse_at("", &mut prev, Instant::now()).is_err());
    }

    #[test]
    fn parses_linux_hardware() {
        let text = "PT_LINUX\n\
PT_CPU\n\
processor   : 0\n\
model name  : Intel(R) Xeon(R) Gold 6248R CPU @ 3.00GHz\n\
processor   : 1\n\
model name  : Intel(R) Xeon(R) Gold 6248R CPU @ 3.00GHz\n\
PT_CORES\n\
8\n\
PT_DMI\n\
Memory Device\n\
\tSize: 16 GB\n\
\tType: DDR4\n\
\tSpeed: 2933 MT/s\n\
\tManufacturer: Samsung\n\
Memory Device\n\
\tSize: No Module Installed\n\
PT_DISK\n\
NAME=\"sda\" MODEL=\"Samsung SSD 860 EVO 500GB\" SIZE=\"465.8G\" TYPE=\"disk\"\n\
NAME=\"loop0\" MODEL=\"\" SIZE=\"1G\" TYPE=\"loop\"\n";

        let hw = parse_hardware(text).unwrap();
        assert_eq!(hw.cpu_model.as_deref(), Some("Intel(R) Xeon(R) Gold 6248R CPU @ 3.00GHz"));
        assert_eq!(hw.cpu_cores, Some(8));
        assert_eq!(hw.mem_model.as_deref(), Some("Samsung 16 GB DDR4 2933 MT/s"));
        assert_eq!(hw.disks, vec!["Samsung SSD 860 EVO 500GB 465.8G".to_string()]);
    }

    #[test]
    fn parses_darwin_hardware() {
        let text = "PT_DARWIN\n\
PT_CPU\n\
Apple M2 Pro\n\
PT_CORES\n\
12\n\
PT_DISK\n\
   Device / Media Name:       APPLE SSD AP0512Q\n\
   Disk Size:                 500.3 GB (500277790720 Bytes)\n";

        let hw = parse_hardware(text).unwrap();
        assert_eq!(hw.cpu_model.as_deref(), Some("Apple M2 Pro"));
        assert_eq!(hw.cpu_cores, Some(12));
        assert_eq!(hw.disks, vec!["APPLE SSD AP0512Q 500.3 GB".to_string()]);
    }
}
