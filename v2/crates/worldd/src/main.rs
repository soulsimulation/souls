//! The world process (Engine v2, #2635): so far its clock and watchdog (K7, #2647).

mod watchdog;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    std::process::exit(watchdog::run(&args));
}

#[cfg(test)]
mod tests {
    #[test]
    fn builds_as_worldd() {
        assert_eq!(env!("CARGO_PKG_NAME"), "worldd");
    }
}
