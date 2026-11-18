//! The world process (Engine v2, #2635): so far its clock and watchdog (K7, #2647), the gateway's socket (I4, #2687)
//! and the fork request (K6, #2670).

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

#[cfg(test)]
mod tests {
    #[test]
    fn builds_as_worldd() {
        assert_eq!(env!("CARGO_PKG_NAME"), "worldd");
    }
}
