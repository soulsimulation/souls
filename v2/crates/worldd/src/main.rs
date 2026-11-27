//! The world process (Engine v2, #2635): its clock and watchdog (K7, #2647), what it tells its service manager (O1,
//! #2730), the fork request (K6, #2670), and `serve`, a world from its folder behind the gateway (C1, #3365).

mod compactor;
mod entries_upgrade;
mod fork;
mod gateway_link;
mod serve;
mod sleep;
mod stopped;
mod watchdog;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("gateway-link") => std::process::exit(gateway_link::run(&args)),
        Some("fork") => std::process::exit(fork::run(&args)),
        // A real world from its folder, behind the gateway (C1, #3365); `seed` makes the folder.
        Some("serve") => std::process::exit(serve::run(&args)),
        Some("seed") => std::process::exit(serve::seed(&args)),
        // Where a world's joining Souls arrive: a place its facts name.
        Some("arrival") => std::process::exit(serve::set_arrival(&args)),
        // A running world's entries brought up to a release's (`entries_upgrade`), by the release's move.
        Some("entries") => std::process::exit(entries_upgrade::run(&args)),
        // One person's words taken out of what a stopped world serves (W7, #2826).
        Some("remove-words") => std::process::exit(worldd::removal::run(&args)),
        // The schemas this build reads and writes, by hash (T6), which a rollback compares (O7, #2804).
        Some("schemas") => {
            let h = replica::effects::schema_hash();
            println!("reads {h}\nwrites {h}");
        }
        _ => std::process::exit(watchdog::run(&args)),
    }
}

/// Tells the service manager `state` over the socket `$NOTIFY_SOCKET` names (systemd's notify protocol); nothing
/// when there is none, as when a test or a person runs the process.
fn notify(state: &str) {
    use std::os::unix::net::UnixDatagram;
    let Some(path) = std::env::var_os("NOTIFY_SOCKET") else {
        return;
    };
    let Ok(socket) = UnixDatagram::unbound() else {
        return;
    };
    let bytes = std::os::unix::ffi::OsStrExt::as_bytes(path.as_os_str());
    // A failed notification is the service manager's to notice: no "ready" or no "alive" ends in a restart.
    if let Some(name) = bytes.strip_prefix(b"@") {
        #[cfg(target_os = "linux")]
        {
            use std::os::linux::net::SocketAddrExt;
            if let Ok(addr) = std::os::unix::net::SocketAddr::from_abstract_name(name) {
                let _ = socket.send_to_addr(state.as_bytes(), &addr);
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = name;
    } else {
        let _ = socket.send_to(state.as_bytes(), &path);
    }
}

/// How much longer each progress notice gives the start: worldd@.service's `TimeoutStartSec`, which stays the bound on
/// a load that makes no progress (#4013).
const PROGRESS_US: u64 = 30_000_000;
/// Whether the world said "ready", and when it last said progress. One lock, so no progress notice follows READY=1.
static LOADING: std::sync::Mutex<(bool, Option<std::time::Instant>)> =
    std::sync::Mutex::new((false, None));

/// "Still loading": the start made progress, so the service manager waits `TimeoutStartSec` again from now
/// (`EXTEND_TIMEOUT_USEC`). At most ten a second, so a loop may call it for each record; none once ready.
// Paces notices to the service manager, off the clock: the wall-clock rule (K7) binds the engine, not this.
#[allow(clippy::disallowed_methods)]
pub fn progress() {
    use std::time::{Duration, Instant};
    let mut loading = LOADING.lock().unwrap_or_else(|e| e.into_inner());
    let (ready, last) = &mut *loading;
    if *ready || last.is_some_and(|t| t.elapsed() < Duration::from_millis(100)) {
        return;
    }
    *last = Some(Instant::now());
    notify(&format!("EXTEND_TIMEOUT_USEC={PROGRESS_US}"));
}

/// "Ready": the world started and ticks. Names the build it runs, the hash its launcher checked (`$WORLDD_BUILD`).
pub fn ready() {
    LOADING.lock().unwrap_or_else(|e| e.into_inner()).0 = true;
    let build = std::env::var("WORLDD_BUILD").unwrap_or_else(|_| "unpinned".to_owned());
    println!("build: {build}");
    notify(&format!("READY=1\nSTATUS=build {build}"));
}

/// "Alive": the world owes no tick, or completed one within the watchdog's limit.
pub fn alive() {
    notify("WATCHDOG=1");
}

#[cfg(test)]
mod tests {
    #[test]
    fn builds_as_worldd() {
        assert_eq!(env!("CARGO_PKG_NAME"), "worldd");
    }
}
