//! macOS 输入源切换（FEATURES.md §3）。
//!
//! 背景：WKWebView 里简体拼音 / 微信输入法即使切到英文，也会把普通字母键报成
//! `keyCode 229`（"正在组词"），字符只能经隐藏 textarea 的组合输入通道进来——
//! 快打丢字、慢打一个键插两次。系统 ABC 输入法没有这个问题。
//!
//! 之前尝试过在 Web 层把 textarea 设为只读来"挡住输入法"，代价是中文输入一起被废掉，
//! 且 WKWebView 下 readOnly 复位后输入法上下文不会恢复。因此改为这里：终端获得焦点时
//! 把系统输入源切到英文，失去焦点时还原。这样英文命令走 xterm 原生按键通道（既跟手
//! 又不漏字），用户在终端里要用中文时自行切回自己的输入法即可。
//!
//! 非 macOS 平台为空实现：Windows 的 WebView2（Chromium）输入法处理不存在上述问题。

pub mod commands;

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::c_void;
    use std::sync::Mutex;

    type CFTypeRef = *const c_void;

    /// kCFStringEncodingUTF8
    const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    const NO_ERR: i32 = 0;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithBytes(
            alloc: CFTypeRef,
            bytes: *const u8,
            num_bytes: isize,
            encoding: u32,
            is_external: u8,
        ) -> CFTypeRef;
        fn CFRelease(cf: CFTypeRef);
    }

    // TIS 系列 API 位于 Carbon umbrella framework 内（HIToolbox 是其子框架，
    // 不在标准 framework 搜索路径上，必须链接 Carbon 本身）。
    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        fn TISCopyCurrentKeyboardInputSource() -> CFTypeRef;
        fn TISCopyInputSourceForLanguage(language: CFTypeRef) -> CFTypeRef;
        fn TISSelectInputSource(source: CFTypeRef) -> i32;
    }

    /// 进入终端前用户正在用的输入源。存地址而不是裸指针，避免裸指针的非 Send 限制。
    static SAVED: Mutex<Option<usize>> = Mutex::new(None);

    fn cfstr(s: &str) -> CFTypeRef {
        unsafe {
            CFStringCreateWithBytes(
                std::ptr::null(),
                s.as_ptr(),
                s.len() as isize,
                CF_STRING_ENCODING_UTF8,
                0,
            )
        }
    }

    /// 把输入源切到英文。只在第一次调用时记录原始输入源，重复调用不会覆盖。
    pub fn use_ascii() -> bool {
        unsafe {
            let lang = cfstr("en");
            if lang.is_null() {
                return false;
            }
            let target = TISCopyInputSourceForLanguage(lang);
            CFRelease(lang);
            if target.is_null() {
                return false;
            }

            {
                let mut saved = match SAVED.lock() {
                    Ok(g) => g,
                    Err(_) => {
                        CFRelease(target);
                        return false;
                    }
                };
                if saved.is_none() {
                    let cur = TISCopyCurrentKeyboardInputSource();
                    if !cur.is_null() {
                        *saved = Some(cur as usize);
                    }
                }
            }

            let status = TISSelectInputSource(target);
            CFRelease(target);
            status == NO_ERR
        }
    }

    /// 还原进入终端前的输入源。
    pub fn restore() -> bool {
        let saved = match SAVED.lock() {
            Ok(mut g) => g.take(),
            Err(_) => return false,
        };
        match saved {
            Some(addr) => unsafe {
                let src = addr as CFTypeRef;
                let status = TISSelectInputSource(src);
                CFRelease(src);
                status == NO_ERR
            },
            None => false,
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn use_ascii() -> bool {
        false
    }
    pub fn restore() -> bool {
        false
    }
}

/// 本平台是否支持自动切换输入源。
pub fn supported() -> bool {
    cfg!(target_os = "macos")
}
