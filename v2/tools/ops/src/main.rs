//! Operations tools in Rust (Engine v2), run from `v2/`:
//!
//! - `cargo run -p ops --release -- move <root> <even|uneven> <seed> [--kill <source|target>:<step>]`: moves a live
//!   world from one process to another (O9, #2828), two processes on one machine standing in for two machines, under
//!   1,000 scripted agents; prints one row of the move table (or, with `--kill`, of the kill table). `move.rs`.
//! - `ops world ...`: one world process of a move, which `move` starts (`world.rs`).
//!
//! The shell tools beside it (`o1-*.sh`, `o3-kill.sh`, `o9-move.sh`) drive these and systemd. Runbook:
//! `v2/docs/runbook/move-a-world.md`.

mod load;
mod moving;
mod world;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let out = match args.first().map(String::as_str) {
        Some("world") => world::run(&args[1..]),
        Some("move") => moving::run(&args[1..]),
        _ => {
            eprintln!("usage: ops move|world ... (see the crate's docs)");
            std::process::exit(2);
        }
    };
    if let Err(e) = out {
        eprintln!("ops: {}: {}", e.name, e.detail);
        std::process::exit(1);
    }
}
