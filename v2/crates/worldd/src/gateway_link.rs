//! The world's end of the gateway's local socket (Engine v2 I1, #2683; the gateway's end is `gatewayd`'s
//! `world_link`). Frames both ways are a 4-byte big-endian length and that many bytes: an intent in (T10 rule 2), an
//! answer out as `{1: version, 2: answer}`, the version T3's (lineage, zone, epoch, sequence).
//!
//! Each intent goes to the world (`worldd::answers`, I4 #2687): checked, committed at the next tick, logged, and
//! answered after that tick's sync. A repeat gets the answer it had, across restarts too, since the world rebuilds
//! its sequences from the log. The world here is I3's toggles world (`checkers::toggles`), `--rooms` rooms of `--bodies`
//! bodies, each with a toggle, and `--items` items in each room; its log is `--log` (default: the socket's path and
//! `.log`). With `--testworld` it also has bodies that move (I4b): N2's test world with one Soul and three chairs
//! (`worldd::testbodies`, B10 #2688), and prints `testworld <id> <name>` for the Soul's body, the square and the chairs.
//! With `--creator <32 hex>-<counter>` the world has that creator and the toggles world's pinned kinds
//! (`toggles::kinds`), and commits the creator's edit intents (G1b, #3362): each is checked off the clock thread and
//! committed through `sim::edit`; every other actor's edit is refused `edit.not-the-creator`.
//!
//! `worldd gateway-link --socket <path> --lineage <32 hex> --epoch <n> [--log <file>] [--rooms <n>] [--bodies <n>]
//! [--items <n>] [--testworld] [--creator <32 hex>-<n>] [--arrivals <file>] [--roots <file>] [--health <file>]
//! [--no-measures] [--stall-after <s> --stall-for <s>]`. With `--arrivals`, it appends `<actor hex> <sequence>` for every intent it takes, in the order
//! taken, so a bench can check each actor's order across restarts. With `--roots`, it appends `<version> <place hash
//! hex>` after each tick that changed the world, so a test can check a client's copy against the place. Measures
//! (O4, #2694) are on unless `--no-measures`; `health.json` goes to `--health` (default: the log's path with
//! `.health.json`). `--stall-after` holds the clock thread `--stall-for` seconds, once, that many seconds after
//! start: the stuck-thread run.
//!
//! An intent's words are kept in K16's text store in the folder `<log>.text` (V1b, #3361). With `--www <dir>`, the
//! world is followed by R3's view tier and V1's stream writer, which writes the public view of the place under
//! `<dir>` with a text file beside each part (`worldd::view_out` rule 10), for a page to play: it prints `stream
//! <path under dir>` and `body <scope hex>-<counter>` for each body, and needs a log with no records.
//!
//! The same socket carries R5's sync requests (R5b, #3164; `replica::sync::wire`), which the world answers for every
//! actor over the place (`worldd::answers`).

use std::fs::OpenOptions;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::time::Duration;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use replica::apply::Replica;
use replica::edit;
use replica::encode::{from_hex, to_hex};
use replica::ids::{Id, Minter, Scope};
use replica::views::{Key, Level, Redactions};
use replica::world_model::Audience;
use sim::log::FileStore;
use sim::text::Store;
use worldd::answers::{self, Config, Event, Follow, Offer};
use worldd::checkers::toggles;
use worldd::view_out::{Writer, follow};
use worldd::views::Tier;
use worldd::words;

/// What follows the world when `--www` is given: the view tier over the public view of the place, and the stream
/// writer, with its text files, under `www`. World time is the machine's clock (`answers::now`), so the anchor is
/// that time and the same instant in ms.
fn stream(world: &Replica, www: PathBuf, text: Arc<Store>) -> Follow {
    let header = world.header().clone();
    let start = world.tree().to_state();
    let key = Key {
        node: start.root,
        level: Level::Full,
        audience: Audience::Everyone,
    };
    Box::new(move |durable| {
        let noop: Offer = Box::new(|_, _| {});
        let tier = match Tier::start(
            header.clone(),
            start.clone(),
            Redactions::default(),
            durable,
        ) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("worldd: the view tier did not start: {e}");
                return noop;
            }
        };
        let sub = tier.subscribe(vec![key], 1 << 16);
        let now = answers::now();
        let anchor = (now, u64::try_from(now / 1_000).unwrap_or(0));
        // The world as built is not in the log: the stream's part 0 holds it, as a fork's does (V1 rule 8).
        let writer = match Writer::fork_with_text(&www, &header, &key, anchor, &start, Some(text)) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("worldd: the stream writer did not start: {e}");
                return noop;
            }
        };
        println!(
            "stream {}",
            writer
                .dir()
                .strip_prefix(&www)
                .unwrap_or(writer.dir())
                .display()
        );
        // The writer runs until the process ends.
        drop(follow(writer, sub, Arc::new(AtomicBool::new(false))));
        Box::new(move |n, bytes| tier.offer(n, bytes))
    })
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
             [--bodies <n>] [--items <n>] [--testworld] [--creator <32 hex>-<n>] [--arrivals <file>] [--roots <file>] [--health <file>] [--no-measures] \
             [--stall-after <s> --stall-for <s>] [--www <dir>] [--watchdog-ms <ms>]"
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
        cfg.bodies = Some(Box::new(|_: &worldd::bodies::Placed| {
            worldd::testbodies::bodies()
        }));
        // C10 (#3414): the ids a client acts on, `testworld <id> <name>`.
        for (name, id) in worldd::testbodies::named().unwrap_or_default() {
            println!(
                "testworld {}-{} {name}",
                to_hex(&id.scope().0),
                id.counter()
            );
        }
    }
    if let Some(c) = arg("--creator") {
        let Some(creator) = c.split_once('-').and_then(|(scope, n)| {
            Id::new(
                Scope(from_hex(scope).ok()?.try_into().ok()?),
                n.parse().ok()?,
            )
        }) else {
            return usage();
        };
        cfg.edits = Some(edit::World {
            creator,
            kinds: toggles::kinds(),
        });
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
    let text = match Store::open_dir(
        &log.with_extension("text"),
        Minter::new(words::scope(Scope(lineage))),
    ) {
        Ok(t) => Arc::new(t),
        Err(e) => {
            eprintln!("worldd: the text store: {e}");
            return 1;
        }
    };
    cfg.text = Some(Arc::clone(&text));
    let built = toggles::World::build(rooms, bodies, items);
    if let Some(www) = arg("--www") {
        if std::fs::metadata(&log).is_ok_and(|m| m.len() > 0) {
            eprintln!("worldd: --www needs a log with no records");
            return 1;
        }
        cfg.follow = Some(stream(&built.replica, PathBuf::from(www), text));
        for (b, _) in &built.pairs {
            println!("body {}-{}", to_hex(&b.scope().0), b.counter());
        }
    }
    let world = FileStore::open(&log)
        .and_then(|store| answers::start(built.replica, toggles::rules(), store, cfg));
    let world = match world {
        Ok(w) => w,
        Err(e) => {
            eprintln!("worldd: the world did not start: {e}");
            return 1;
        }
    };
    // K7's watchdog on the world's own loop (K18): no tick for the limit ends the process by name.
    // `--watchdog-ms` widens it for a debug build's big world (C11's Eden-sized sync test), as `worldd --dir` takes.
    let limit = arg("--watchdog-ms")
        .and_then(|m| m.parse().ok())
        .unwrap_or(crate::watchdog::LIMIT_MS);
    crate::watchdog::watch(world.beat.clone(), crate::watchdog::Real::start(), limit);
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
