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
//! <n> [--arrivals <file>] [--room <cups>]`. With `--arrivals`, it appends `<actor hex> <sequence> <place hash hex>` for
//! every intent it takes, in the order taken, so a bench can check each actor's order across restarts, and a client's
//! copy against the place.
//!
//! Its state (R5b, #3164) is a place, whose id is the zone's, holding one room of `--room` cups (default 8). Each intent
//! taken sets one cup's field, in turn; the place is sealed after each, and every record its seals gave is kept, so it
//! answers R5's sync requests (`replica::sync::wire`) for every actor, each granted the place.

use std::collections::{HashMap, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::mpsc;

use std::collections::BTreeMap;

use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, schema_hash,
};
use replica::encode::{Name, Value, decode, encode, from_hex, to_hex};
use replica::ids::{Hash, Id, Purpose, Scope, Version};
use replica::intents::{Answer, INTENT_MOST, Intent};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::sync::{self, Records, Served, wire};
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, parse_kinds};

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
    place: Place,
}

const KINDS: &str = r#"
{1: "souls:place", 2: "place", 11: ["souls:room"]}
{1: "souls:room", 2: "place", 11: ["thing"]}
{1: "souls:cup", 2: "thing"}
"#;

/// The stand-in's state: a place (the zone's id) holding one room of cups, and every record its seals gave.
struct Place {
    tree: Tree,
    header: Header,
    rules: Rules,
    cups: Vec<Id>,
    records: Records,
    entries: u64,
}

impl Place {
    fn new(zone: Id, cups: u64) -> Option<Place> {
        let rules = Rules {
            kinds: parse_kinds(KINDS).ok()?,
            ..Rules::default()
        };
        let kind = |plain: &str| {
            rules
                .kinds
                .keys()
                .find(|k| k.starts_with(&format!("{plain}@")))
                .and_then(|k| Name::new(k))
        };
        let (place, room_kind, cup_kind) = (
            kind("souls:place")?,
            kind("souls:room")?,
            kind("souls:cup")?,
        );
        let header = Header::read(
            &encode(&Value::Map(BTreeMap::from([
                (
                    1,
                    Value::Bytes(Hash::of(Purpose::Fixture, b"gateway-link").to_bytes()),
                ),
                (2, Value::Bytes(schema_hash().to_bytes())),
                (3, Value::Bytes(zone.scope().0.to_vec())),
                (4, zone.to_value()),
                (5, Value::Uint(0)),
                (
                    6,
                    Value::Array(
                        [&place, &room_kind, &cup_kind]
                            .map(|k| Value::Text(k.clone()))
                            .to_vec(),
                    ),
                ),
                (7, Value::Array(Vec::new())),
            ])))
            .ok()?,
        )
        .ok()?;
        let mut p = Place {
            tree: Tree::start(zone, place),
            header,
            rules,
            cups: Vec::new(),
            records: Records::default(),
            entries: 0,
        };
        let room = Id::new(zone.scope(), 1)?;
        let create = |node, kind: &Name, parent, x: u64| Change::Create {
            node,
            kind: kind.clone(),
            pose: Pose {
                frame: Frame {
                    node: parent,
                    slot: None,
                },
                position: Vec3::new(x as i64, 0, 0),
                orientation: Quat::IDENTITY,
                support: Support::Surface {
                    surface: parent,
                    height: 0,
                },
            },
            audience: Audience::Everyone,
            fields: BTreeMap::from([(1, Value::Uint(x))]),
        };
        let mut inside = Vec::new();
        for k in 0..cups {
            let cup = Id::new(zone.scope(), 2 + k)?;
            inside.push(create(cup, &cup_kind, room, k * 1000));
            p.cups.push(cup);
        }
        let entries = vec![
            p.entry(zone, vec![create(room, &room_kind, zone, 0)]),
            p.entry(room, inside),
        ];
        p.commit(entries)?;
        Some(p)
    }

    fn entry(&mut self, node: Id, changes: Vec<Change>) -> Effect {
        self.entries += 1;
        Effect {
            envelope: Envelope {
                sequence: self.entries - 1,
                at: 0,
                cause: Cause::World,
                actor: Actor::World,
                audience: Audience::Everyone,
                node,
            },
            body: Body::Changes(
                changes
                    .into_iter()
                    .map(|change| ChangeRec {
                        change,
                        rest: Rest::new(),
                    })
                    .collect(),
            ),
            events: None,
            rest: Rest::new(),
        }
    }

    /// Commits one part, seals, and keeps the records the seal gave.
    fn commit(&mut self, entries: Vec<Effect>) -> Option<()> {
        let bytes = encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (
                2,
                Value::Array(entries.iter().map(Effect::to_value).collect()),
            ),
        ])))
        .ok()?;
        let part = Part::read(&bytes).ok()?;
        self.tree.commit(&self.header, &part, &self.rules).ok()?;
        let sealed = self.tree.seal().ok()?;
        self.records.keep(&sealed);
        Some(())
    }

    /// Sets the next cup's field to `to`.
    fn set(&mut self, to: u64) -> Option<()> {
        let cup = *self
            .cups
            .get((to % self.cups.len().max(1) as u64) as usize)?;
        let e = self.entry(
            cup,
            vec![Change::Set {
                node: cup,
                field: 1,
                to: Value::Uint(to),
                by: None,
            }],
        );
        self.commit(vec![e])
    }

    /// The place's hash as last sealed, in hex.
    fn hash(&self) -> String {
        let root = self.tree.node(self.tree.root()).and_then(|n| n.sealed());
        root.map_or_else(String::new, |h| to_hex(&h.to_bytes()))
    }
}

/// A sync request's answer (R5b), for an actor granted the place.
fn answer_sync(w: &World, bytes: &[u8]) -> Option<Option<Vec<u8>>> {
    let Value::Map(mut m) = decode(bytes).ok()?.value else {
        return None;
    };
    let n = m.remove(&wire::ASK)?;
    let now = Version {
        lineage: w.lineage,
        zone: w.zone,
        epoch: w.epoch,
        sequence: w.sequence,
    }
    .to_value();
    let mut src = Served {
        tree: &w.place.tree,
        records: &w.place.records,
    };
    let mut a = sync::answer(&mut src, &[w.zone], &m, now);
    a.insert(wire::ASK, n);
    Some(encode(&Value::Map(a)).ok())
}

/// What the world does with one intent's bytes: the answer frame to send, if any.
fn take(w: &mut World, bytes: &[u8]) -> Option<Vec<u8>> {
    if let Some(a) = answer_sync(w, bytes) {
        return a;
    }
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
    w.place.set(w.sequence)?;
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
        let line = format!("{} {} {}\n", to_hex(&key), intent.sequence, w.place.hash());
        let _ = f.write_all(line.as_bytes());
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

/// What a connection hands the world's thread: a frame's bytes, and where its answer goes.
type Taken = (Vec<u8>, mpsc::Sender<Option<Vec<u8>>>);

fn serve(world: &mpsc::Sender<Taken>, mut stream: UnixStream) {
    let Ok(mut out) = stream.try_clone() else {
        return;
    };
    let (back, answers) = mpsc::channel();
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
        if world.send((bytes, back.clone())).is_err() {
            return;
        }
        let Ok(answer) = answers.recv() else {
            return;
        };
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
            "usage: worldd gateway-link --socket <path> --lineage <32 hex> --epoch <n> [--arrivals <file>] [--room <cups>]"
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
    let Some(place) = arg("--room")
        .map_or(Some(8), |n| n.parse::<u64>().ok())
        .and_then(|cups| Place::new(zone, cups))
    else {
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
    let mut world = World {
        lineage,
        zone,
        epoch,
        sequence: 0,
        actors: HashMap::new(),
        arrivals,
        place,
    };
    // One thread per connection reads frames; the world's own thread (this one, since its tree stays on one thread)
    // takes them in turn.
    let (tx, rx) = mpsc::channel::<Taken>();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let tx = tx.clone();
            std::thread::spawn(move || serve(&tx, stream));
        }
    });
    for (bytes, back) in rx {
        let _ = back.send(take(&mut world, &bytes));
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn world() -> World {
        let lineage = Scope([7; 16]);
        World {
            lineage,
            zone: Id::new(lineage, 0).unwrap(),
            epoch: 1,
            sequence: 0,
            actors: HashMap::new(),
            arrivals: None,
            place: Place::new(Id::new(lineage, 0).unwrap(), 4).unwrap(),
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

    fn ask(w: &mut World, m: BTreeMap<u64, Value>) -> BTreeMap<u64, Value> {
        let frame = take(w, &encode(&Value::Map(m)).unwrap()).expect("an answer");
        let Value::Map(a) = decode(&frame).unwrap().value else {
            panic!("a map")
        };
        a
    }

    /// R5b A1, the world's end: a client compares and descends through sync frames alone.
    fn sync_by_frames(w: &mut World, copy: &mut sync::Copy) -> sync::Synced {
        let a = ask(
            w,
            BTreeMap::from([
                (wire::ASK, Value::Uint(1)),
                (wire::IDS, Value::Array(vec![])),
            ]),
        );
        assert_eq!(a.get(&wire::ASK), Some(&Value::Uint(1)));
        let (ids, hashes) = sync::read_hashes(&a).unwrap();
        assert_eq!(ids, vec![w.zone], "granted the place");
        let mut d = copy.compare(&ids, hashes);
        loop {
            let asked = copy.ask(&mut d, wire::RECORDS_MOST);
            if asked.is_empty() {
                return copy.finish(d).unwrap();
            }
            let hs = asked.iter().cloned().map(Value::Bytes).collect();
            let a = ask(
                w,
                BTreeMap::from([
                    (wire::ASK, Value::Uint(2)),
                    (wire::RECORDS, Value::Array(hs)),
                ]),
            );
            copy.take(&mut d, &asked, sync::read_records(&a).unwrap())
                .unwrap();
        }
    }

    #[test]
    fn r5b_a1_answers_sync_requests_for_the_granted_place() {
        let mut w = world();
        let mut copy = sync::Copy::default();
        let first = sync_by_frames(&mut w, &mut copy);
        assert_eq!(first.held, 6, "the place, its room and four cups");
        assert_eq!(first.fetched, 6);
        take(&mut w, &intent(1)).expect("a receipt");
        let s = sync_by_frames(&mut w, &mut copy);
        assert_eq!(
            (s.changed, s.fetched, s.held),
            (1, 3, 6),
            "the place, the room and the one cup set"
        );
        assert_eq!(to_hex(&copy.roots()[&w.zone]), w.place.hash());
        let refused = ask(
            &mut w,
            BTreeMap::from([
                (wire::ASK, Value::Uint(3)),
                (wire::RECORDS, Value::Array(vec![Value::Uint(1)])),
            ]),
        );
        assert!(
            matches!(refused.get(&wire::REFUSED), Some(Value::Text(n)) if n.as_str() == "sync-ask")
        );
        let other = Id::new(Scope([9; 16]), 1).unwrap();
        let a = ask(
            &mut w,
            BTreeMap::from([
                (wire::ASK, Value::Uint(4)),
                (wire::IDS, Value::Array(vec![other.to_value()])),
            ]),
        );
        assert_eq!(sync::read_hashes(&a).unwrap().1, vec![None], "not granted");
    }
}
