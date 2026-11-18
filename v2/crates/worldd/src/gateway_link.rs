//! The world's end of the gateway's local socket (Engine v2 I1, #2683; the gateway's end is `gatewayd`'s
//! `world_link`). Frames both ways are a 4-byte big-endian length and that many bytes: an intent in (T10 rule 2), an
//! answer out as `{1: version, 2: answer}`, the version T3's (lineage, zone, epoch, sequence).
//!
//! The gateway sends an unanswered intent again after a reconnect, so the world drops repeats by (actor, sequence):
//! an intent at or below the actor's last sequence is not taken again, and is answered with the answer it had, if the
//! world still has it. That memory lasts as long as the process; keeping it across a restart is I4's.
//!
//! Until the engine takes intents (I4), this end answers each new intent with a receipt naming one log entry, so the
//! gateway can be run against a world that restarts: `worldd gateway-link --socket <path> --lineage <32 hex> --epoch
//! <n> [--arrivals <file>]`. With `--arrivals`, it appends `<actor hex> <sequence>` for every intent it takes, in the
//! order taken, so a bench can check each actor's order across restarts.

use std::collections::{HashMap, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use replica::effects::Actor;
use replica::encode::{Name, Value, encode, from_hex, to_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Answer, INTENT_MOST, Intent};

/// Answers kept per actor, to answer a repeat with.
const KEPT: usize = 16;

/// What the world remembers of one actor.
#[derive(Default)]
struct Seen {
    last: u64,
    any: bool,
    answers: VecDeque<(u64, Vec<u8>)>,
}

struct World {
    lineage: Scope,
    zone: Id,
    epoch: u64,
    sequence: u64,
    actors: HashMap<Vec<u8>, Seen>,
    arrivals: Option<File>,
}

/// What the world does with one intent's bytes: the answer frame to send, if any.
fn take(w: &mut World, bytes: &[u8]) -> Option<Vec<u8>> {
    let intent = Intent::read(bytes).ok()?;
    let key = encode(&actor_value(intent.actor)).ok()?;
    let seen = w.actors.entry(key.clone()).or_default();
    if seen.any && intent.sequence <= seen.last {
        // A repeat: dropped, and answered as it was if that answer is still kept, else refused by name.
        if let Some((_, a)) = seen.answers.iter().find(|(s, _)| *s == intent.sequence) {
            return Some(a.clone());
        }
        let now = Version {
            lineage: w.lineage,
            zone: w.zone,
            epoch: w.epoch,
            sequence: w.sequence,
        }
        .to_value();
        let answer = Answer::Refused {
            actor: intent.actor,
            sequence: intent.sequence,
            reason: Name::new("intent-repeat")?,
            now: now.clone(),
            changed: Vec::new(),
        };
        return encode(&Value::Map([(1, now), (2, answer.to_value())].into())).ok();
    }
    seen.any = true;
    seen.last = intent.sequence;
    w.sequence += 1;
    let version = Version {
        lineage: w.lineage,
        zone: w.zone,
        epoch: w.epoch,
        sequence: w.sequence,
    };
    let id = Id::new(w.lineage, w.epoch * 1_000_000_000 + w.sequence)?;
    let answer = Answer::Receipt {
        actor: intent.actor,
        sequence: intent.sequence,
        intent: id,
        entries: vec![w.sequence],
    };
    let frame = encode(&Value::Map(
        [(1, version.to_value()), (2, answer.to_value())].into(),
    ))
    .ok()?;
    seen.answers.push_back((intent.sequence, frame.clone()));
    if seen.answers.len() > KEPT {
        seen.answers.pop_front();
    }
    if let Some(f) = w.arrivals.as_mut() {
        // One write per line, unbuffered, so a killed world leaves every line it took.
        let _ = f.write_all(format!("{} {}\n", to_hex(&key), intent.sequence).as_bytes());
    }
    Some(frame)
}

fn actor_value(a: Actor) -> Value {
    match a {
        Actor::Soul(id) => Value::Map([(1, Value::Uint(1)), (2, id.to_value())].into()),
        Actor::Creator(id) => Value::Map([(1, Value::Uint(2)), (2, id.to_value())].into()),
        Actor::World => Value::Map([(1, Value::Uint(3))].into()),
    }
}

fn serve(world: &Mutex<World>, mut stream: UnixStream) {
    let Ok(mut out) = stream.try_clone() else {
        return;
    };
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
        let answer = take(&mut world.lock().unwrap_or_else(|e| e.into_inner()), &bytes);
        if let Some(frame) = answer {
            let len = u32::try_from(frame.len()).unwrap_or(u32::MAX).to_be_bytes();
            if out.write_all(&len).is_err() || out.write_all(&frame).is_err() {
                return;
            }
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
            "usage: worldd gateway-link --socket <path> --lineage <32 hex> --epoch <n> [--arrivals <file>]"
        );
        2
    };
    let (Some(path), Some(lineage), Some(epoch)) = (
        arg("--socket").map(PathBuf::from),
        arg("--lineage").and_then(|h| from_hex(h).ok()?.try_into().ok()),
        arg("--epoch").and_then(|e| e.parse::<u64>().ok()),
    ) else {
        return usage();
    };
    let lineage = Scope(lineage);
    let Some(zone) = Id::new(lineage, 0) else {
        return usage();
    };
    let arrivals = match arg("--arrivals") {
        None => None,
        Some(p) => match OpenOptions::new().create(true).append(true).open(p) {
            Ok(f) => Some(f),
            Err(e) => {
                eprintln!("worldd: arrivals: {e}");
                return 1;
            }
        },
    };
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("worldd: gateway link: {e}");
            return 1;
        }
    };
    let world = Arc::new(Mutex::new(World {
        lineage,
        zone,
        epoch,
        sequence: 0,
        actors: HashMap::new(),
        arrivals,
    }));
    for stream in listener.incoming().flatten() {
        let world = world.clone();
        std::thread::spawn(move || serve(&world, stream));
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::encode::decode;
    use std::collections::BTreeMap;

    fn world() -> World {
        let lineage = Scope([7; 16]);
        World {
            lineage,
            zone: Id::new(lineage, 0).unwrap(),
            epoch: 1,
            sequence: 0,
            actors: HashMap::new(),
            arrivals: None,
        }
    }

    fn intent(sequence: u64) -> Vec<u8> {
        let i = Intent {
            actor: Actor::Soul(Id::new(Scope([1; 16]), 5).unwrap()),
            verb: Name::new("eden:wave").unwrap(),
            target: None,
            parameters: BTreeMap::new(),
            sequence,
            basis: Version {
                lineage: Scope([7; 16]),
                zone: Id::new(Scope([7; 16]), 0).unwrap(),
                epoch: 1,
                sequence: 0,
            }
            .to_value(),
            expiry: 60_000_000,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
        };
        encode(&i.to_value()).unwrap()
    }

    #[test]
    fn a2_a_repeat_is_dropped_and_answered_as_it_was() {
        let mut w = world();
        let first = take(&mut w, &intent(3)).expect("a receipt");
        assert_eq!(
            take(&mut w, &intent(3)),
            Some(first),
            "the same answer again"
        );
        assert_eq!(w.sequence, 1, "the repeat took nothing");
        let later = take(&mut w, &intent(4)).expect("a receipt");
        let Value::Map(m) = decode(&later).unwrap().value else {
            panic!("a map")
        };
        assert!(matches!(m.get(&2), Some(Value::Map(a)) if a.get(&2) == Some(&Value::Uint(4))));
        let old = take(&mut w, &intent(2)).expect("an answer");
        let Value::Map(m) = decode(&old).unwrap().value else {
            panic!("a map")
        };
        let Some(Value::Map(a)) = m.get(&2) else {
            panic!("an answer")
        };
        assert_eq!(
            a.get(&3),
            Some(&Value::Uint(2)),
            "older than the last, not kept: refused"
        );
        assert_eq!(w.sequence, 2, "and not taken");
    }
}
