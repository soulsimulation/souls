//! The world's end of the gateway's local socket (Engine v2 I1, #2683; the gateway's end is `gatewayd`'s
//! `world_link`). Frames both ways are a 4-byte big-endian length and that many bytes: an intent in (T10 rule 2), an
//! answer out as `{1: version, 2: answer}`, the version T3's (lineage, zone, epoch, sequence).
//!
//! Each intent goes to the world (`worldd::answers`, I4 #2687): checked, committed at the next tick, logged, and
//! answered after that tick's sync. A repeat gets the answer it had, across restarts too, since the world rebuilds
//! its sequences from the log. The world here is I3's lamps world (`checkers::lamps`), `--rooms` rooms of `--bodies`
//! bodies, each with a lamp; its log is `--log` (default: the socket's path and `.log`). With `--testworld` it also
//! has bodies that move (I4b): N2's test world with one Soul and three chairs (`worldd::testbodies`, B10 #2688).
//!
//! `worldd gateway-link --socket <path> --lineage <32 hex> --epoch <n> [--log <file>] [--rooms <n>] [--bodies <n>]
//! [--testworld] [--arrivals <file>]`. With `--arrivals`, it appends `<actor hex> <sequence>` for every intent it takes, in the
//! order taken, so a bench can check each actor's order across restarts.

use std::fs::OpenOptions;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;

use replica::encode::from_hex;
use replica::ids::Scope;
use sim::log::FileStore;
use worldd::answers::{self, Config};
use worldd::checkers::lamps;

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
             [--bodies <n>] [--testworld] [--arrivals <file>]"
        );
        2
    };
    let count = |name: &str, default: usize| arg(name).map_or(Some(default), |n| n.parse().ok());
    let (Some(path), Some(lineage), Some(epoch), Some(rooms), Some(bodies)) = (
        arg("--socket").map(PathBuf::from),
        arg("--lineage").and_then(|h| from_hex(h).ok()?.try_into().ok()),
        arg("--epoch").and_then(|e| e.parse::<u64>().ok()),
        count("--rooms", 1),
        count("--bodies", 50),
    ) else {
        return usage();
    };
    let log = arg("--log").map_or_else(|| path.with_extension("log"), PathBuf::from);
    let mut cfg = Config::new(Scope(lineage), epoch);
    if args.iter().any(|a| a == "--testworld") {
        cfg.bodies = Some(Box::new(worldd::testbodies::bodies));
    }
    if let Some(p) = arg("--arrivals") {
        match OpenOptions::new().create(true).append(true).open(p) {
            Ok(f) => cfg.arrivals = Some(f),
            Err(e) => {
                eprintln!("worldd: arrivals: {e}");
                return 1;
            }
        }
    }
    let world = FileStore::open(&log).and_then(|store| {
        answers::start(
            lamps::World::build(rooms, bodies, 0).replica,
            lamps::rules(),
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
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("worldd: gateway link: {e}");
            return 1;
        }
    };
    for stream in listener.incoming().flatten() {
        let events = world.events.clone();
        std::thread::spawn(move || answers::serve(events, stream));
    }
    0
}
