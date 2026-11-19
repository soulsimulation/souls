//! The world's end of the gateway's local socket (Engine v2 I1, #2683; the gateway's end is `gatewayd`'s
//! `world_link`). Frames both ways are a 4-byte big-endian length and that many bytes: an intent in (T10 rule 2), an
//! answer out as `{1: version, 2: answer}`, the version T3's (lineage, zone, epoch, sequence).
//!
//! Each intent goes to the world (`worldd::answers`, I4 #2687): checked, committed at the next tick, logged, and
//! answered after that tick's sync. A repeat gets the answer it had, across restarts too, since the world rebuilds
//! its sequences from the log. The world here is I3's toggles world (`checkers::toggles`), `--rooms` rooms of `--bodies`
//! bodies, each with a toggle, and `--items` items in each room; its log is `--log` (default: the socket's path and
//! `.log`). With `--testworld` it also has bodies that move (I4b): N2's test world with one Soul and three chairs
//! (`worldd::testbodies`, B10 #2688).
//!
//! `worldd gateway-link --socket <path> --lineage <32 hex> --epoch <n> [--log <file>] [--rooms <n>] [--bodies <n>]
//! [--items <n>] [--testworld] [--arrivals <file>] [--roots <file>] [--health <file>] [--no-measures] [--stall-after <s>
//! --stall-for <s>]`. With `--arrivals`, it appends `<actor hex> <sequence>` for every intent it takes, in the order
//! taken, so a bench can check each actor's order across restarts. With `--roots`, it appends `<version> <place hash
//! hex>` after each tick that changed the world, so a test can check a client's copy against the place. Measures
//! (O4, #2694) are on unless `--no-measures`; `health.json` goes to `--health` (default: the log's path with
//! `.health.json`). `--stall-after` holds the clock thread `--stall-for` seconds, once, that many seconds after
//! start: the stuck-thread run.
//!
//! The same socket carries R5's sync requests (R5b, #3164; `replica::sync::wire`), which the world answers for every
//! actor over the place (`worldd::answers`).

use std::fs::OpenOptions;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::time::Duration;

use replica::encode::from_hex;
use replica::ids::Scope;
use sim::log::FileStore;
use worldd::answers::{self, Config, Event};
use worldd::checkers::toggles;

/// `worldd gateway-link ...`: listens for the gateway until killed.
pub fn run(args: &[String]) -> i32 {
    let arg = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|k| args.get(k + 1))
    };
    let usage = || {
        eprintln!(
            "usage: worldd gateway-link --socket <path> --lineage <32 hex> --epoch <n> [--log <file>] [--rooms <n>] \
             [--bodies <n>] [--items <n>] [--testworld] [--arrivals <file>] [--roots <file>] [--health <file>] [--no-measures] \
             [--stall-after <s> --stall-for <s>]"
        );
        2
    };
    let count = |name: &str, default: usize| arg(name).map_or(Some(default), |n| n.parse().ok());
    let (Some(path), Some(lineage), Some(epoch), Some(rooms), Some(bodies), Some(items)) = (
        arg("--socket").map(PathBuf::from),
        arg("--lineage").and_then(|h| from_hex(h).ok()?.try_into().ok()),
        arg("--epoch").and_then(|e| e.parse::<u64>().ok()),
        count("--rooms", 1),
        count("--bodies", 50),
        count("--items", 0),
    ) else {
        return usage();
    };
    let log = arg("--log").map_or_else(|| path.with_extension("log"), PathBuf::from);
    let mut cfg = Config::new(Scope(lineage), epoch);
    if args.iter().any(|a| a == "--testworld") {
        cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| worldd::testbodies::bodies()));
    }
    cfg.measures = !args.iter().any(|a| a == "--no-measures");
    cfg.health =
        Some(arg("--health").map_or_else(|| log.with_extension("health.json"), PathBuf::from));
    let stall = arg("--stall-after")
        .and_then(|a| a.parse::<f64>().ok())
        .zip(arg("--stall-for").and_then(|f| f.parse::<f64>().ok()));
    for (flag, to) in [
        ("--arrivals", &mut cfg.arrivals),
        ("--roots", &mut cfg.roots),
    ] {
        if let Some(p) = arg(flag) {
            match OpenOptions::new().create(true).append(true).open(p) {
                Ok(f) => *to = Some(f),
                Err(e) => {
                    eprintln!("worldd: {}: {e}", &flag[2..]);
                    return 1;
                }
            }
        }
    }
    let world = FileStore::open(&log).and_then(|store| {
        answers::start(
            toggles::World::build(rooms, bodies, items).replica,
            toggles::rules(),
            store,
            cfg,
        )
    });
    let world = match world {
        Ok(w) => w,
        Err(e) => {
            eprintln!("worldd: the world did not start: {e}");
            return 1;
        }
    };
    // K7's watchdog on the world's own loop (K18): no tick for the limit ends the process by name.
    crate::watchdog::watch(
        world.beat.clone(),
        crate::watchdog::Real::start(),
        crate::watchdog::LIMIT_MS,
    );
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("worldd: gateway link: {e}");
            return 1;
        }
    };
    if let Some((after, hold)) = stall {
        let events = world.events.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs_f64(after));
            let _ = events.send(Event::Stall(Duration::from_secs_f64(hold)));
        });
    }
    for stream in listener.incoming().flatten() {
        let door = world.door();
        std::thread::spawn(move || answers::serve(door, stream));
    }
    0
}
