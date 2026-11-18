//! The world process (Engine v2, #2635): so far its clock and watchdog (K7, #2647), what it tells its service
//! manager (O1, #2730), and the fork request (K6, #2670).

mod fork;
mod gateway_link;
mod watchdog;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("gateway-link") => std::process::exit(gateway_link::run(&args)),
        Some("fork") => std::process::exit(fork::run(&args)),
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

/// "Ready": the world started and ticks. Names the build it runs, the hash its launcher checked (`$WORLDD_BUILD`).
pub fn ready() {
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
