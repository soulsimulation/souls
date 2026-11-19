//! Operations tools in Rust (Engine v2), run from `v2/`:
//!
//! - `cargo run -p ops --release -- move <root> <even|uneven> <seed> [--kill <source|target>:<step>]`: moves a live
//!   world from one process to another (O9, #2828), two processes on one machine standing in for two machines, under
//!   1,000 scripted agents; prints one row of the move table (or, with `--kill`, of the kill table). `move.rs`.
//! - `cargo run -p ops --release -- restore <root> <even|uneven> <seed>`: a world restored from the bucket alone
//!   after its machine is lost (O12, #2807); prints one row of the restore table. `restore.rs`; the restore command
//!   itself is `ops world target <dir> <bucket> <t0> <machine> --restore`.
//! - `ship`, `rebuild` and `ship-count`: O3's drill and count (#2732), `drill.rs` (store from `ARCHIVE_STORE_*`).
//! - `ops world ...`: one world process of a move or a restore, which `move` and `restore` start (`world.rs`).
//!
//! The shell tools beside it (`o1-*.sh`, `o3-kill.sh`, `o9-move.sh`) drive these and systemd. Runbook:
//! `v2/docs/runbook/move-a-world.md`.

mod drill;
mod load;
mod moving;
mod restore;
mod world;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let out = match args.first().map(String::as_str) {
        Some("world") => world::run(&args[1..]),
        Some("move") => moving::run(&args[1..]),
        Some("restore") => restore::run(&args[1..]),
        Some("ship") => archive::store().and_then(|s| {
            let arg = |i: usize| args.get(i).cloned().unwrap_or_default();
            drill::ship(
                s,
                std::path::Path::new(&arg(1)),
                std::path::Path::new(&arg(2)),
                &arg(3),
                arg(4).parse().unwrap_or(0),
                arg(5).parse().unwrap_or(1),
            )
        }),
        Some("rebuild") => archive::store().and_then(|s| {
            let arg = |i: usize| args.get(i).cloned().unwrap_or_default();
            drill::rebuild(s, std::path::Path::new(&arg(1)), &arg(2))
        }),
        Some("ship-count") => drill::count(std::path::Path::new(args.get(1).map_or("", |a| a))),
        _ => {
            eprintln!(
                "usage: ops move|restore|world|ship|rebuild|ship-count ... (see the crate's docs)"
            );
            std::process::exit(2);
        }
    };
    if let Err(e) = out {
        eprintln!("ops: {}: {}", e.name, e.detail);
        std::process::exit(1);
    }
}
