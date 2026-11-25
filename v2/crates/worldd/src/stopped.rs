//! D6 (0.132): a world stopped by SIGTERM or SIGINT says so, one line on stderr naming the signal, then ends as it
//! did before: by that signal's default action, so its exit status is unchanged (143 or 130 for a shell). No save:
//! the log and its checkpoints are what a restart reads, as after any stop. R15: once a stop hook is set
//! ([`on_stop`], the public stream's backup drain), the signal is handed to a thread that runs it first, bounded by
//! the hook itself, and then ends the process the same way.

use std::sync::atomic::{AtomicI32, Ordering};

/// The pipe's write end the handler hands a signal to, once [`on_stop`] has set a hook; -1 before.
static HOOK: AtomicI32 = AtomicI32::new(-1);

fn line(sig: libc::c_int) -> &'static [u8] {
    if sig == libc::SIGTERM {
        b"worldd: stopped by SIGTERM\n"
    } else {
        b"worldd: stopped by SIGINT\n"
    }
}

/// Says the line and ends by the signal's default action.
fn end(sig: libc::c_int) {
    let line = line(sig);
    // SAFETY: each call is async-signal-safe; the line is a static byte string.
    unsafe {
        libc::write(2, line.as_ptr().cast(), line.len());
        libc::signal(sig, libc::SIG_DFL);
        libc::raise(sig);
    }
}

/// The handler: async-signal-safe calls only (write, signal, raise).
extern "C" fn said(sig: libc::c_int) {
    let fd = HOOK.load(Ordering::Relaxed);
    if fd >= 0 {
        let b = sig as u8;
        // SAFETY: write is async-signal-safe; `b` lives for the call.
        unsafe {
            libc::write(fd, (&b as *const u8).cast(), 1);
        }
        return;
    }
    end(sig);
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

/// R15: runs `hook` (which bounds its own wait) when SIGTERM or SIGINT comes, before the process ends by it. Once.
pub fn on_stop(hook: impl FnOnce() + Send + 'static) {
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: `fds` has room for the two descriptors pipe writes.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return;
    }
    let read = fds[0];
    let spawned = std::thread::Builder::new()
        .name("stopping".into())
        .spawn(move || {
            let mut b = 0u8;
            // SAFETY: reads one byte into `b` from the pipe this thread owns.
            let n = unsafe { libc::read(read, (&mut b as *mut u8).cast(), 1) };
            let sig = if n == 1 {
                libc::c_int::from(b)
            } else {
                libc::SIGTERM
            };
            hook();
            end(sig);
        });
    if spawned.is_ok() {
        HOOK.store(fds[1], Ordering::Relaxed);
    }
}
