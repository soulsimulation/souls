//! D6 (0.132): a world stopped by SIGTERM or SIGINT says so, one line on stderr naming the signal, then ends as it
//! did before: by that signal's default action, so its exit status is unchanged (143 or 130 for a shell). No drain,
//! no save: the log and its checkpoints are what a restart reads, as after any stop.

/// The handler: async-signal-safe calls only (write, signal, raise).
extern "C" fn said(sig: libc::c_int) {
    let line: &[u8] = if sig == libc::SIGTERM {
        b"worldd: stopped by SIGTERM\n"
    } else {
        b"worldd: stopped by SIGINT\n"
    };
    // SAFETY: each call is async-signal-safe; the line is a static byte string.
    unsafe {
        libc::write(2, line.as_ptr().cast(), line.len());
        libc::signal(sig, libc::SIG_DFL);
        libc::raise(sig);
    }
}

/// Installs the handler for SIGTERM and SIGINT.
pub fn install() {
    for sig in [libc::SIGTERM, libc::SIGINT] {
        // SAFETY: `said` is an `extern "C" fn(c_int)` that calls only async-signal-safe functions.
        unsafe {
            libc::signal(
                sig,
                said as extern "C" fn(libc::c_int) as libc::sighandler_t,
            );
        }
    }
}
