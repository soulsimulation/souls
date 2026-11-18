//! The view tier (Engine v2 R3, #2697) on T7's and T8's fixture logs, written through K4's log to a disk in memory,
//! one entry a tick: frames encoded follow the keys, not the subscribers (A2); the views rebuilt from the log alone
//! equal the live ones by hash (A3); a removed text is in no frame or snapshot, and a reader that falls behind gets a
//! snapshot with its queue within its bound (A5). A1 and A4 are timed by `v2/tools/bench/view-tier`.
//! Run with `cargo test -p worldd -- --nocapture` to see the numbers.

use super::*;
use replica::effects::{FIXTURE_HEADER, FIXTURES, fixture_bytes};
use replica::encode::decode;
use replica::ids::{Hash, Purpose, Scope as IdScope};
use replica::views::{ORDER, build, entry_part};
use sim::log::{Log, Mem, Storage, recover};

const DAY: &str = include_str!("../../../replica/fixtures/views/1-day.diag");
const AUD_HEADER: &str = include_str!("../../../replica/fixtures/audience/header.diag");
const AUD_LOG: &str = include_str!("../../../replica/fixtures/audience/log.diag");
/// The board's words (T8's fixture store keeps them under reference cc:1). Never in a log.
const BOARD: &str = "meet me at the well at noon";

fn id(scope: u8, counter: u64) -> Id {
    Id::new(IdScope([scope; 16]), counter).expect("an id")
}

/// A fixture log, one entry a part: the header, the zone's start and the parts.
struct Fixture {
    header: Header,
    start: State,
    parts: Vec<Part>,
}

fn one_entry_a_part(header: &Header, stored: &[Part]) -> Vec<Part> {
    stored
        .iter()
        .flat_map(|p| &p.effects)
        .map(|e| entry_part(header, e).expect("its own part"))
        .collect()
}

/// The same entries, `n` a part.
fn regroup(header: &Header, parts: &[Part], n: usize) -> Vec<Part> {
    let entries: Vec<Value> = parts
        .iter()
        .flat_map(|p| &p.effects)
        .map(|e| e.to_value())
        .collect();
    entries
        .chunks(n)
        .map(|c| {
            let v = Value::Map(
                [
                    (1, Value::Bytes(header.hash().to_bytes())),
                    (2, Value::Array(c.to_vec())),
                ]
                .into(),
            );
            Part::read(&encode(&v).expect("bytes")).expect("a part")
        })
        .collect()
}

/// T7's log: T6's base, then the day.
fn views_log() -> Fixture {
    let header = Header::read(&fixture_bytes(FIXTURE_HEADER).expect("bytes")).expect("a header");
    let root = header
        .kinds
        .iter()
        .find(|k| k.as_str().starts_with("souls:place@"))
        .expect("the root's kind")
        .clone();
    let start = State::start(header.zone, root);
    let stored: Vec<Part> = [FIXTURES[0].1, DAY]
        .iter()
        .map(|t| Part::read(&fixture_bytes(t).expect("bytes")).expect("a part"))
        .collect();
    let parts = one_entry_a_part(&header, &stored);
    Fixture {
        header,
        start,
        parts,
    }
}

/// T8's log: a board, speech, a whisper and audiences.
fn audience_log() -> Fixture {
    let header = Header::read(&fixture_bytes(AUD_HEADER).expect("bytes")).expect("a header");
    let start = State::start(header.zone, header.kinds[0].clone());
    let stored = [Part::read(&fixture_bytes(AUD_LOG).expect("bytes")).expect("a part")];
    let parts = one_entry_a_part(&header, &stored);
    Fixture {
        header,
        start,
        parts,
    }
}

/// A clock thread's side: K4's log on a disk in memory, and the tier following it.
struct World {
    log: Log<Mem>,
    tier: Tier,
}

impl World {
    fn new(f: &Fixture, redactions: Redactions) -> World {
        let (log, _) = Log::open(Mem::default(), 1).expect("a log");
        let tier = Tier::start(
            f.header.clone(),
            f.start.clone(),
            redactions,
            log.durable_mark(),
        )
        .expect("a tier");
        World { log, tier }
    }

    /// One tick: its bytes to the log, then to the tier, as the clock thread does.
    fn tick(&mut self, part: &Part) {
        let bytes = part.stored().to_vec();
        let n = self.log.append(bytes.clone()).expect("appended");
        self.tier.offer(n, bytes);
    }

    /// Ends the tier and the log; the tier's stats and the disk's bytes.
    fn close(self) -> (Stats, Vec<u8>) {
        let stats = self.tier.close();
        let mut disk = self.log.close();
        (stats, disk.read().expect("the disk"))
    }
}

fn drain(s: &Subscriber) -> Vec<Delivery> {
    std::iter::from_fn(|| s.try_recv()).collect()
}

fn map(bytes: &[u8]) -> std::collections::BTreeMap<u64, Value> {
    match decode(bytes).expect("decodes").value {
        Value::Map(m) => m,
        v => panic!("not a map: {v:?}"),
    }
}

/// Every key of T7's views test: the root, the room, the body and the crate, at every level, public and aa:1.
fn views_keys() -> Vec<Key> {
    let mut keys = Vec::new();
    for node in [id(0xee, 0), id(0xee, 1), id(0xee, 2), id(0xee, 7)] {
        for level in ORDER {
            for audience in [Audience::Everyone, Audience::Of(id(0xaa, 1))] {
                keys.push(Key {
                    node,
                    level,
                    audience,
                });
            }
        }
    }
    keys
}

#[test]
fn a2_frames_encoded_follow_the_keys_in_use_not_the_subscribers() {
    let f = views_log();
    let keys = views_keys();
    let mut counts = Vec::new();
    for per_key in [1usize, 25] {
        let mut w = World::new(&f, Redactions::default());
        // Each subscriber takes the public key of a node and level and the private one beside it.
        let subs: Vec<Subscriber> = (0..per_key)
            .flat_map(|_| keys.chunks(2).map(|pair| pair.to_vec()))
            .map(|ks| w.tier.subscribe(ks, 10_000))
            .collect();
        for p in &f.parts {
            w.tick(p);
        }
        let (stats, _) = w.close();
        let delivered: usize = subs.iter().map(|s| drain(s).len()).sum();
        println!(
            "{} subscribers on {} keys, {} ticks: {} frames encoded, {} delivered",
            subs.len(),
            keys.len(),
            stats.ticks,
            stats.frames,
            delivered
        );
        assert_eq!(stats.fault, None);
        assert_eq!(stats.ticks, f.parts.len() as u64);
        assert_eq!(stats.frames, stats.ticks * keys.len() as u64);
        assert_eq!(delivered as u64, stats.frames * per_key as u64);
        counts.push(stats.frames);
    }
    assert_eq!(counts[0], counts[1]);
}

#[test]
fn a3_views_rebuilt_from_the_log_alone_equal_the_live_ones_by_hash() {
    // One entry a tick, and four: within a tick an entry goes only to its audience's views and the last to all.
    for n in [1, 4] {
        let mut f = views_log();
        f.parts = regroup(&f.header, &f.parts, n);
        rebuilt_equals_live(&f);
    }
}

fn rebuilt_equals_live(f: &Fixture) {
    let keys = views_keys();
    let mut w = World::new(f, Redactions::default());
    let sub = w.tier.subscribe(keys.clone(), 100_000);
    for p in &f.parts {
        w.tick(p);
    }
    let (stats, disk) = w.close();
    assert_eq!(stats.fault, None);
    // The live views: each key's frames, their records joined, under the last frame's fields 1 to 7.
    let mut live: Vec<std::collections::BTreeMap<u64, Value>> = keys
        .iter()
        .map(|_| std::collections::BTreeMap::new())
        .collect();
    for d in drain(&sub) {
        let Delivery::Frame { key, bytes, .. } = d else {
            panic!("a snapshot to a reader that never fell behind")
        };
        let i = keys.iter().position(|k| *k == key).expect("a key");
        let mut m = map(&bytes);
        let Some(Value::Array(new)) = m.remove(&8) else {
            panic!("a frame's records")
        };
        let mut joined = match live[i].remove(&8) {
            Some(Value::Array(a)) => a,
            _ => Vec::new(),
        };
        joined.extend(new);
        m.insert(8, Value::Array(joined));
        live[i] = m;
    }
    // The views rebuilt: the log's records as the disk holds them, read back and built in one pass.
    let found = recover(&disk).expect("the log reads back");
    assert_eq!(found.records.len(), f.parts.len());
    let parts: Vec<Part> = found
        .records
        .iter()
        .map(|r| Part::read(r).expect("a part"))
        .collect();
    let rebuilt = build(&f.start, &f.header, &parts, &keys, &Redactions::default()).expect("built");
    let mut records = 0;
    for ((key, live), mut again) in keys.iter().zip(live).zip(rebuilt) {
        // A counts view's open second is its last record until a later second closes it: never sent yet.
        if key.level == Level::Counts {
            again.records.pop();
        }
        records += again.records.len();
        let a = Hash::of(Purpose::Fixture, &encode(&Value::Map(live)).expect("bytes"));
        let b = Hash::of(Purpose::Fixture, &again.bytes().expect("bytes"));
        assert_eq!(a, b, "{key:?}");
    }
    println!(
        "{} views, {records} records over {} ticks: live equals rebuilt by hash for every one",
        keys.len(),
        f.parts.len()
    );
}

/// Whether every reference to `r` in `v` is marked removed, counting them.
fn marked(v: &Value, r: Id, seen: &mut u64) -> bool {
    match v {
        Value::Map(m) => {
            if m.get(&replica::audience::REFERENCE) == Some(&r.to_value()) {
                *seen += 1;
                return m.get(&replica::audience::REMOVED) == Some(&Value::Uint(1))
                    && !m.contains_key(&replica::audience::WORDS);
            }
            m.values().all(|x| marked(x, r, seen))
        }
        Value::Array(a) => a.iter().all(|x| marked(x, r, seen)),
        _ => true,
    }
}

#[test]
fn a5_a_removed_text_is_in_no_frame_or_snapshot() {
    let f = audience_log();
    let removed = id(0xcc, 1);
    let audiences = [
        Audience::Everyone,
        Audience::Of(id(0x77, 1)),
        Audience::Of(id(0x88, 1)),
        Audience::Of(id(0xee, 8)),
        Audience::Of(id(0xee, 13)),
        Audience::Of(id(0xdd, 101)),
    ];
    let keys: Vec<Key> = ORDER
        .iter()
        .flat_map(|level| {
            audiences.iter().map(|audience| Key {
                node: id(0xee, 0),
                level: *level,
                audience: *audience,
            })
        })
        .collect();
    let mut w = World::new(&f, Redactions::new([removed]));
    let early = w.tier.subscribe(keys.clone(), 100_000);
    let half = f.parts.len() / 2;
    for p in &f.parts[..half] {
        w.tick(p);
    }
    // One who joins halfway is handed snapshots first.
    let late = w.tier.subscribe(keys.clone(), 100_000);
    for p in &f.parts[half..] {
        w.tick(p);
    }
    let (stats, _) = w.close();
    assert_eq!(stats.fault, None);
    let (mut seen, mut frames, mut snapshots) = (0, 0, 0);
    for d in drain(&early).into_iter().chain(drain(&late)) {
        let bytes = match d {
            Delivery::Frame { bytes, .. } => {
                frames += 1;
                bytes
            }
            Delivery::Snapshot { bytes, .. } => {
                snapshots += 1;
                bytes
            }
            Delivery::Index { .. } => unreachable!("no index subscriber here"),
        };
        assert!(!bytes.windows(BOARD.len()).any(|x| x == BOARD.as_bytes()));
        let v = decode(&bytes).expect("decodes").value;
        assert!(marked(&v, removed, &mut seen), "an unmarked reference");
    }
    println!(
        "{frames} frames and {snapshots} snapshots: the removed reference appears {seen} times, every one marked removed, its words never"
    );
    assert!(seen > 0 && snapshots > 0);
}

#[test]
fn a5_a_reader_that_falls_behind_gets_a_snapshot_and_its_queue_stays_bounded() {
    let f = views_log();
    let key = Key {
        node: id(0xee, 0),
        level: Level::Full,
        audience: Audience::Everyone,
    };
    let bound = 4;
    let mut w = World::new(&f, Redactions::default());
    let slow = w.tier.subscribe(vec![key], bound);
    let fast = w.tier.subscribe(vec![key], 100_000);
    for p in &f.parts {
        w.tick(p);
    }
    let (stats, _) = w.close();
    assert_eq!(stats.fault, None);
    let fast_got = drain(&fast);
    println!(
        "{} ticks: the reader that never read held at most {} of its bound {bound}, was handed {} snapshots; the other got {} frames",
        stats.ticks,
        slow.most(),
        slow.snapshots(),
        fast_got.len()
    );
    assert!(slow.most() <= bound);
    assert!(slow.snapshots() > 0);
    assert_eq!(fast_got.len() as u64, stats.ticks);
    assert!(fast_got.iter().all(|d| matches!(d, Delivery::Frame { .. })));
    // What the slow reader holds starts with a snapshot at a position, then frames after it.
    let held = drain(&slow);
    let Some(Delivery::Snapshot { record, bytes, .. }) = held.first() else {
        panic!("the slow reader's queue starts with a snapshot")
    };
    assert!(map(bytes).contains_key(&9));
    for (i, d) in held.iter().enumerate().skip(1) {
        let Delivery::Frame { record: r, .. } = d else {
            panic!("frames follow the snapshot")
        };
        assert_eq!(*r, record + i as u64);
    }
}
