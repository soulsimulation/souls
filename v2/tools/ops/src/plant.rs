//! The planted bad builds of O7 (#2804): `o7-plant <die|stall|refuse> <state folder> <lineage hex> <bodies>`, what a
//! planted build's `worldd --dir <state>` runs when it is served. In a rehearsal it runs the good world instead (the
//! build's script decides), so each fault is one only serving shows, and the canary must catch it.
//!
//! - `die`: exits at start.
//! - `stall`: serves the world's socket and takes every intent, and never answers: its clock does not tick.
//! - `refuse`: I4's world on the served log, with rules that know no kind, so every act is refused by name, logged.

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::mpsc::{Sender, channel};

use replica::encode::from_hex;
use replica::ids::Scope;
use replica::rules::json::Value;
use sim::log::FileStore;
use worldd::answers::{self, Config, Event};
use worldd::checkers::{Rules, toggles};
use worldd::measures::Stamps;

fn frame(s: &mut UnixStream) -> Option<Vec<u8>> {
    let mut len = [0u8; 4];
    s.read_exact(&mut len).ok()?;
    let mut bytes = vec![0u8; u32::from_be_bytes(len) as usize];
    s.read_exact(&mut bytes).ok()?;
    Some(bytes)
}

/// One gateway connection to the refusing world, as `worldd gateway-link` serves it.
fn serve(world: Sender<Event>, mut stream: UnixStream) {
    let Ok(mut out) = stream.try_clone() else {
        return;
    };
    let (reply, answers) = channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for f in answers {
            let len = u32::try_from(f.len()).unwrap_or(u32::MAX).to_be_bytes();
            if out.write_all(&len).is_err() || out.write_all(&f).is_err() {
                return;
            }
        }
    });
    while let Some(bytes) = frame(&mut stream) {
        let reply = reply.clone();
        // Measures are off here: default stamps and key, as `Door` sends them then.
        let arrival = Event::Arrival {
            bytes,
            reply,
            stamps: Stamps::default(),
            key: 0,
        };
        if world.send(arrival).is_err() {
            return;
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(mode), Some(dir), Some(lineage), Some(bodies)) = (
        args.get(1),
        args.get(2).map(PathBuf::from),
        args.get(3)
            .and_then(|h| from_hex(h).ok()?.try_into().ok())
            .map(Scope),
        args.get(4).and_then(|n| n.parse::<usize>().ok()),
    ) else {
        eprintln!("usage: o7-plant <die|stall|refuse> <state folder> <lineage hex> <bodies>");
        std::process::exit(2);
    };
    eprintln!("o7-plant: planted fault: {mode}");
    let socket = dir.join("gateway.sock");
    let listen = || {
        let _ = std::fs::remove_file(&socket);
        UnixListener::bind(&socket).unwrap_or_else(|e| {
            eprintln!("o7-plant: {e}");
            std::process::exit(1)
        })
    };
    match mode.as_str() {
        "die" => std::process::exit(1),
        "stall" => {
            for mut s in listen().incoming().flatten() {
                std::thread::spawn(move || while frame(&mut s).is_some() {});
            }
        }
        "refuse" => {
            let rules = Rules {
                kinds: Value::Obj(Vec::new()),
                moves: toggles::rules().moves,
            };
            let world = FileStore::open(&dir.join("log")).and_then(|store| {
                answers::start(
                    toggles::World::build(1, bodies, 0).replica,
                    rules,
                    store,
                    Config::new(lineage, 1),
                )
            });
            let world = world.unwrap_or_else(|e| {
                eprintln!("o7-plant: the world did not start: {e}");
                std::process::exit(1)
            });
            for s in listen().incoming().flatten() {
                let events = world.events.clone();
                std::thread::spawn(move || serve(events, s));
            }
        }
        _ => std::process::exit(2),
    }
}
