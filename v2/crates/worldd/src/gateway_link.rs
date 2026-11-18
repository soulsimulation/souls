//! The world's end of the gateway's local socket (Engine v2 I1, #2683; the gateway's end is `gatewayd`'s
//! `world_link`). Frames both ways are a 4-byte big-endian length and that many bytes: an intent in (T10 rule 2), an
//! answer out as `{1: version, 2: answer}`, the version T3's (lineage, zone, epoch, sequence).
//!
//! Each intent goes to the world (`worldd::answers`, I4 #2687): checked, committed at the next tick, logged, and
//! answered after that tick's sync. A repeat gets the answer it had, across restarts too, since the world rebuilds
//! its sequences from the log. The world here is I3's lamps world (`checkers::toggles`), `--rooms` rooms of `--bodies`
//! bodies, each with a toggle; its log is `--log` (default: the socket's path and `.log`).
//!
//! `worldd gateway-link --socket <path> --lineage <32 hex> --epoch <n> [--log <file>] [--rooms <n>] [--bodies <n>]
//! [--arrivals <file>]`. With `--arrivals`, it appends `<actor hex> <sequence>` for every intent it takes, in the
//! order taken, so a bench can check each actor's order across restarts.

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::mpsc::{Sender, channel};

use replica::encode::from_hex;
use replica::ids::Scope;
use replica::intents::INTENT_MOST;
use sim::log::FileStore;
use worldd::answers::{self, Config, Event};
use worldd::checkers::toggles;

fn serve(world: Sender<Event>, mut stream: UnixStream) {
    let Ok(mut out) = stream.try_clone() else {
        return;
    };
    let (reply, answers) = channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for frame in answers {
            let len = u32::try_from(frame.len()).unwrap_or(u32::MAX).to_be_bytes();
            if out.write_all(&len).is_err() || out.write_all(&frame).is_err() {
                return;
            }
        }
    });
    loop {
        let mut len = [0u8; 4];
        if stream.read_exact(&mut len).is_err() {
            return;
        }
        let len = u32::from_be_bytes(len) as usize;
        if len > INTENT_MOST as usize {
            return;
        }
        let mut bytes = vec![0u8; len];
        if stream.read_exact(&mut bytes).is_err() {
            return;
        }
        let reply = reply.clone();
        if world.send(Event::Arrival { bytes, reply }).is_err() {
            return;
        }
    }
}

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
             [--bodies <n>] [--arrivals <file>]"
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
            toggles::World::build(rooms, bodies, 0).replica,
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
        std::thread::spawn(move || serve(events, stream));
    }
    0
}
