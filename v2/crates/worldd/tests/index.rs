//! The world-wide index and the Soul list through the view tier (Engine v2 E1, #2708).
//!
//! - `a_small_town`: a named area, a room, a thing in each and a walking body: the copy built from the file and the
//!   changes equals the world's index byte for byte, and the body's Soul is found in the area it walked into.
//! - `eden` (ignored; needs `.local/import-eden/eden-2026.facts.json` from `v2/tools/import-eden/export`): the four
//!   measures on Eden 2026, two repeats. A1 queries on the copy, 99th percentile of 1,000 seeded queries; A2 how far
//!   behind the world the copy's Soul list ever is, in world time; A3 the index file's bytes (written to
//!   `.local/e1/index.bin`, to compress beside today's catalog); A4 the Soul list's bytes a world second with 1,000
//!   bodies walking. Run from `v2/`:
//!   `cargo test -p worldd --release --test index -- --ignored --nocapture`.

// The Eden measures time their queries: the wall-clock rule (K7) binds the engine, not this test.
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, State, schema_hash,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Purpose, Scope as IdScope, sha256};
use replica::index::{Config, Index, Role, SoulChanges, Souls, Spot, file_name};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::views::Redactions;
use replica::world_model::{Audience, End, plain};
use sim::log::{Log, Mem};
use worldd::views::index::IndexPart;
use worldd::views::{Delivery, Subscriber, Tier};

const BODY: &str =
    "souls:body@1220ee1ad75a34f067112ef6d2a095fe5bd3e121a75611a1a95ba85198efcb131cb2";
const BODY_OF: &str = "souls:body-of";
const TICK_US: i64 = 50_000;

fn name(s: &str) -> Name {
    Name::new(s).expect("a name")
}

/// A test kind pinned as a log names it: `namespace:name@1220` and a hash.
fn pin(k: &str) -> String {
    format!("{k}@1220{}", replica::encode::to_hex(&sha256(k.as_bytes())))
}

fn soul(n: u64) -> Id {
    Id::new(IdScope([0x50; 16]), n).expect("an id")
}

fn pose(frame: Id, x: i64, z: i64) -> Pose {
    Pose {
        frame: Frame {
            node: frame,
            slot: None,
        },
        position: Vec3::new(x, 0, z),
        orientation: Quat::IDENTITY,
        support: Support::Surface {
            surface: frame,
            height: 0,
        },
    }
}

fn header(zone: Id, kinds: &BTreeSet<String>) -> Header {
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"e1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(zone.scope().0.to_vec())),
        (4, zone.to_value()),
        (5, Value::Uint(0)),
        (
            6,
            Value::Array(kinds.iter().map(|k| Value::Text(name(k))).collect()),
        ),
        (7, Value::Array(Vec::new())),
    ]));
    Header::read(&encode(&v).expect("bytes")).expect("a header")
}

/// The clock thread's side: entries, parts, K4's log in memory and the tier following it.
struct World {
    header: Header,
    seq: u64,
    at: i64,
    log: Log<Mem>,
    tier: Tier,
    /// The world's own state, index and Soul list, tick by tick: what the copy must agree with.
    state: State,
    truth: Index,
    souls: Souls,
    cfg: Config,
}

impl World {
    fn new(header: Header, start: State, cfg: impl Fn() -> Config) -> World {
        let (log, _) = Log::open(Mem::default(), 1).expect("a log");
        let tier = Tier::start_with_index(
            header.clone(),
            start.clone(),
            Redactions::new([]),
            log.durable_mark(),
            Some(cfg()),
        )
        .expect("a tier");
        let c = cfg();
        let truth = Index::build(&start, &c);
        let mut souls = Souls::default();
        souls.relink(&start, &truth);
        World {
            header,
            seq: start.next,
            at: 0,
            log,
            tier,
            state: start,
            truth,
            souls,
            cfg: c,
        }
    }

    fn entry(&mut self, node: Id, changes: Vec<Change>) -> Effect {
        let e = Effect {
            envelope: Envelope {
                sequence: self.seq,
                at: self.at,
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
        };
        self.seq += 1;
        e
    }

    fn body(&mut self, frame: Id, body: Id, link: Id, who: Id, at: [i64; 2]) -> Effect {
        self.entry(
            frame,
            vec![
                Change::Create {
                    node: body,
                    kind: name(BODY),
                    pose: pose(frame, at[0], at[1]),
                    audience: Audience::Everyone,
                    fields: BTreeMap::new(),
                },
                Change::Link {
                    link,
                    ty: name(BODY_OF),
                    ends: [body, who],
                    owner: End::First,
                    audience: Audience::Everyone,
                },
            ],
        )
    }

    fn walk(&mut self, frame: Id, body: Id, at: [i64; 2], v: [i64; 2]) -> Effect {
        let h = HandOff {
            node: body,
            at: self.at,
            from: Owner::Mover,
            to: Owner::Mover,
            pose: pose(frame, at[0], at[1]),
            linear: Vec3::new(v[0], 0, v[1]),
            angular: Vec3::ZERO,
        };
        self.entry(body, vec![Change::Motion(h)])
    }

    /// One tick: to the log, to the tier, and to the world's own state; gives the Soul list's changes.
    fn tick(&mut self, effects: Vec<Effect>) -> SoulChanges {
        let v = Value::Map(
            [
                (1, Value::Bytes(self.header.hash().to_bytes())),
                (
                    2,
                    Value::Array(effects.iter().map(Effect::to_value).collect()),
                ),
            ]
            .into(),
        );
        let part = Part::read(&encode(&v).expect("bytes")).expect("a part");
        let bytes = part.stored().to_vec();
        let n = self.log.append(bytes.clone()).expect("appended");
        self.tier.offer(n, bytes);
        let mut touched = BTreeSet::new();
        let mut links = false;
        for e in &part.effects {
            self.state.apply_entry(&self.header, e).expect("applies");
            touched.insert(e.envelope.node);
            if let Body::Changes(cs) = &e.body {
                for c in cs {
                    match &c.change {
                        Change::Create { node, .. } => {
                            touched.insert(*node);
                        }
                        Change::Link { .. } => links = true,
                        _ => {}
                    }
                }
            }
        }
        self.truth.update(&self.state, &self.cfg, &touched, false);
        let mut out = if links {
            self.souls.relink(&self.state, &self.truth)
        } else {
            SoulChanges::default()
        };
        out.merge(self.souls.moved(&self.state, &self.truth, &touched));
        self.at += TICK_US;
        out
    }
}

/// A subscriber's copy: the file, then changes.
#[derive(Default)]
struct Copy {
    index: Option<Index>,
    souls: Souls,
    /// Bytes received, by kind of part.
    bytes: BTreeMap<&'static str, u64>,
}

impl Copy {
    fn take(&mut self, d: &Delivery) {
        let Delivery::Index { part, bytes, .. } = d else {
            panic!("an index subscriber gets index parts")
        };
        let what = match part {
            IndexPart::File => {
                self.index = Some(Index::read(bytes).expect("an index"));
                self.souls = Souls::default();
                "file"
            }
            IndexPart::Souls => {
                let ix = self.index.as_ref().expect("the file first");
                let c =
                    SoulChanges::read(&decode(bytes).expect("decodes").value, ix).expect("souls");
                self.souls.apply(&c);
                "souls"
            }
            IndexPart::Changes => {
                let ix = self.index.as_mut().expect("the file first");
                let c = ix
                    .read_changes(&decode(bytes).expect("decodes").value)
                    .expect("changes");
                ix.apply(&c);
                "changes"
            }
            IndexPart::Moves => {
                let ix = self.index.as_ref().expect("the file first");
                let c =
                    SoulChanges::read(&decode(bytes).expect("decodes").value, ix).expect("moves");
                self.souls.apply(&c);
                "moves"
            }
        };
        *self.bytes.entry(what).or_default() += bytes.len() as u64;
    }
}

fn drain(s: &Subscriber) -> Vec<Delivery> {
    let mut out = Vec::new();
    while let Some(d) = s.recv_timeout(Duration::from_millis(500)) {
        out.push(d);
    }
    out
}

fn cfg_of(
    words: &BTreeMap<[u8; 32], String>,
    places: &'static [&'static str],
    skip: &'static [&'static str],
) -> Config {
    Config {
        name: 4,
        outline: 11,
        outline_um: 1_000,
        aliases: None,
        role: Box::new(move |k: &str| {
            let p = plain(k);
            if places.contains(&p) {
                Role::Place
            } else if skip.contains(&p) || p == "souls:body" {
                Role::Skip
            } else {
                Role::Thing
            }
        }),
        words: words.clone(),
    }
}

#[test]
fn a_small_town() {
    let scope = IdScope([3; 16]);
    let id = |n: u64| Id::new(scope, n).expect("an id");
    let (root, ground, square, hall, bench, post) = (id(0), id(1), id(2), id(3), id(4), id(5));
    let words: BTreeMap<[u8; 32], String> = ["Town Square", "The Hall", "Old Bench"]
        .iter()
        .map(|t| (sha256(t.as_bytes()), (*t).to_owned()))
        .collect();
    let named = |t: &str| Value::Bytes(sha256(t.as_bytes()).to_vec());
    let square_mm = |lo: i64, hi: i64| {
        Value::Array(
            [[lo, lo], [hi, lo], [hi, hi], [lo, hi]]
                .iter()
                .map(|p| Value::Array(vec![Value::Uint(p[0] as u64), Value::Uint(p[1] as u64)]))
                .collect(),
        )
    };
    let mut kinds: BTreeSet<String> = [
        "t:world", "t:ground", "t:area", "t:room", "t:bench", "t:post",
    ]
    .iter()
    .map(|k| pin(k))
    .collect();
    kinds.insert(BODY.to_owned());
    let header = header(root, &kinds);
    let mut start = State::start(root, name(&pin("t:world")));
    let mut node = |id: Id, kind: &str, parent: Id, at: [i64; 2], fields: Vec<(u64, Value)>| {
        start.nodes.insert(
            id,
            replica::effects::NodeState {
                kind: name(kind),
                parent: Some(parent),
                slot: None,
                audience: Audience::Everyone,
                fields: fields.into_iter().collect(),
                place: Some(Value::Map(BTreeMap::from([(
                    2,
                    Value::Array(vec![
                        Value::Uint(at[0] as u64),
                        Value::Uint(0),
                        Value::Uint(at[1] as u64),
                    ]),
                )]))),
                motion: None,
            },
        );
    };
    node(ground, &pin("t:ground"), root, [0, 0], vec![]);
    node(
        square,
        &pin("t:area"),
        ground,
        [0, 0],
        vec![(4, named("Town Square")), (11, square_mm(0, 20_000))],
    );
    node(
        hall,
        &pin("t:room"),
        ground,
        [50_000_000, 0],
        vec![(4, named("The Hall")), (11, square_mm(0, 10_000))],
    );
    node(
        bench,
        &pin("t:bench"),
        ground,
        [5_000_000, 5_000_000],
        vec![(4, named("Old Bench"))],
    );
    node(post, &pin("t:post"), hall, [1_000_000, 1_000_000], vec![]);
    let cfg = || cfg_of(&words, &["t:area", "t:room"], &["t:world", "t:ground"]);
    let mut w = World::new(header, start, cfg);
    let sub = w.tier.subscribe_index(1_000);

    // The index: two places and two things, each in its named place.
    assert_eq!(w.truth.len(), 4);
    assert_eq!(w.truth.find("bench", 5), vec![bench]);
    assert_eq!(w.truth.find("town sq", 5), vec![square]);
    assert_eq!(w.truth.find("post", 5), vec![post]);
    let place = |ix: &Index, id: Id| match ix.row(id) {
        Some(replica::index::Row::Thing(t)) => t.place,
        _ => None,
    };
    assert_eq!(place(&w.truth, bench), Some(square));
    assert_eq!(place(&w.truth, post), Some(hall));

    // A Soul's body appears outside the square and walks into it, then a thing is made in the hall.
    let (maya, body, link, cup) = (soul(1), id(10), id(11), id(12));
    let e = w.body(ground, body, link, maya, [30_000_000, 30_000_000]);
    w.tick(vec![e]);
    assert_eq!(
        w.souls.spot(maya),
        Some(Spot {
            node: ground,
            place: None
        })
    );
    for s in 0..40 {
        let x = 30_000_000 - s * 500_000;
        let e = w.walk(ground, body, [x, x], [-1_000_000, -1_000_000]);
        let mut es = vec![e];
        if s == 20 {
            es.push(w.entry(
                hall,
                vec![Change::Create {
                    node: cup,
                    kind: name(&pin("t:bench")),
                    pose: pose(hall, 2_000_000, 2_000_000),
                    audience: Audience::Everyone,
                    fields: BTreeMap::new(),
                }],
            ));
        }
        w.tick(es);
    }
    assert_eq!(
        w.souls.spot(maya),
        Some(Spot {
            node: ground,
            place: Some(square)
        })
    );
    // One more world second so the last moves are sent.
    for _ in 0..21 {
        w.tick(Vec::new());
    }
    let stats = w.tier.stats();
    assert_eq!(stats.fault, None);
    let mut copy = Copy::default();
    for d in drain(&sub) {
        copy.take(&d);
    }
    let ix = copy.index.as_ref().expect("a file");
    assert_eq!(
        file_name(&ix.to_bytes().expect("bytes")),
        file_name(&w.truth.to_bytes().expect("bytes")),
        "the copy is the world's index"
    );
    assert_eq!(place(ix, cup), Some(hall));
    assert_eq!(
        copy.souls.spot(maya),
        Some(Spot {
            node: ground,
            place: Some(square)
        })
    );
    println!("small town: {:?}", copy.bytes);
}

// --- Eden 2026 ----------------------------------------------------------------------------------------------------

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() % (hi - lo).max(1) as u64) as i64
    }
}

fn pct(v: &mut [u64], q: usize) -> u64 {
    v.sort_unstable();
    v[((v.len() * q).div_ceil(100))
        .saturating_sub(1)
        .min(v.len() - 1)]
}

#[test]
#[ignore = "needs .local/import-eden/eden-2026.facts.json"]
fn eden() {
    let local = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../.local");
    let path = format!("{local}/import-eden/eden-2026.facts.json");
    let text = std::fs::read_to_string(path).expect("the facts file (v2/tools/import-eden/export)");
    let im = import_eden::load(&text).expect("imports");
    let start = im.tree.to_state();
    let mut kinds: BTreeSet<String> = start
        .nodes
        .values()
        .map(|n| n.kind.as_str().to_owned())
        .collect();
    kinds.insert(
        start
            .nodes
            .get(&start.root)
            .map_or(String::new(), |n| n.kind.as_str().to_owned()),
    );
    kinds.insert(BODY.to_owned());
    let ground = start
        .nodes
        .iter()
        .find(|(_, n)| plain(n.kind.as_str()) == import_eden::GROUND)
        .map(|(id, _)| *id)
        .expect("the open ground");
    const PLACES: &[&str] = &[import_eden::PLACE, import_eden::ROOM];
    const SKIP: &[&str] = &[
        import_eden::WORLD,
        import_eden::GROUND,
        import_eden::FLOOR,
        import_eden::WINDOW,
        import_eden::DOORWAY,
    ];
    let cfg = || cfg_of(&im.texts, PLACES, SKIP);
    std::fs::create_dir_all(format!("{local}/e1")).expect("a folder");

    for repeat in 0..2u64 {
        let header = header(start.root, &kinds);
        let mut w = World::new(header, start.clone(), cfg);
        let sub = w.tier.subscribe_index(10_000_000);

        // A3: the file.
        let file = w.truth.to_bytes().expect("bytes");
        std::fs::write(format!("{local}/e1/index.bin"), &file).expect("written");
        let (mut places, mut things) = (0, 0);
        for id in start.nodes.keys() {
            match w.truth.row(*id) {
                Some(replica::index::Row::Place(_)) => places += 1,
                Some(replica::index::Row::Thing(_)) => things += 1,
                None => {}
            }
        }
        println!(
            "A3 repeat {repeat}: index file {} bytes raw ({places} places, {things} things), named {}",
            file.len(),
            &file_name(&file)[..16]
        );

        // A1: 1,000 seeded queries on a copy read from the file: a word or two of a row's name or kind, or a prefix.
        let mut copy = Index::read(&file).expect("a copy");
        let rows: Vec<Id> = start
            .nodes
            .keys()
            .filter(|id| copy.row(**id).is_some())
            .copied()
            .collect();
        let mut r = Lcg(2708 + repeat);
        let queries: Vec<String> = (0..1_000)
            .map(|_| {
                let row = copy
                    .row(rows[r.range(0, rows.len() as i64) as usize])
                    .expect("a row");
                let (name, kind) = match row {
                    replica::index::Row::Place(p) => (p.name.clone(), p.kind.clone()),
                    replica::index::Row::Thing(t) => (t.name.clone(), t.kind.clone()),
                };
                let ws = replica::index::words_of(&format!(
                    "{name} {}",
                    kind.split(':').nth(1).unwrap_or("")
                ));
                let a = &ws[r.range(0, ws.len() as i64) as usize];
                match r.range(0, 3) {
                    0 => a.clone(),
                    1 => a[..a.len().min(3)].to_owned(),
                    _ => format!("{a} {}", ws[r.range(0, ws.len() as i64) as usize]),
                }
            })
            .collect();
        let t0 = Instant::now();
        copy.find("warm", 10); // the search map is built once, on the first query
        let build_us = t0.elapsed().as_micros();
        let mut us = Vec::new();
        let mut found = 0;
        for q in &queries {
            let t = Instant::now();
            let hits = copy.find(q, 20);
            us.push(t.elapsed().as_nanos() as u64);
            found += usize::from(!hits.is_empty());
        }
        println!(
            "A1 repeat {repeat}: 1,000 queries, p50 {} µs, p99 {} µs, max {} µs; {found} found something; search map built in {build_us} µs",
            pct(&mut us, 50) / 1_000,
            pct(&mut us, 99) / 1_000,
            us.iter().max().copied().unwrap_or(0) / 1_000,
        );

        // A2 and A4: 1,000 bodies walk the town at 1.4 m/s for 120 world seconds, a motion sample each a world second.
        let mut lo = [i64::MAX; 2];
        let mut hi = [i64::MIN; 2];
        for id in start.nodes.keys() {
            if let Some(replica::index::Row::Place(p)) = w.truth.row(*id)
                && p.parent == Some(ground)
            {
                for q in &p.outline {
                    for k in 0..2 {
                        lo[k] = lo[k].min(q[k] * 100_000);
                        hi[k] = hi[k].max(q[k] * 100_000);
                    }
                }
            }
        }
        // the middle of the town: half of the named areas' bounds each way
        for k in 0..2 {
            let (m, h) = ((lo[k] + hi[k]) / 2, (hi[k] - lo[k]) / 4);
            lo[k] = m - h;
            hi[k] = m + h;
        }
        const BODIES: u64 = 1_000;
        const SECONDS: i64 = 120;
        let mut at: Vec<[i64; 2]> = Vec::new();
        let mut v: Vec<[i64; 2]> = Vec::new();
        for _ in 0..BODIES {
            at.push([r.range(lo[0], hi[0]), r.range(lo[1], hi[1])]);
            let (dx, dz) = (r.range(-1_000, 1_000), r.range(-1_000, 1_000));
            let len = ((dx * dx + dz * dz) as u64).isqrt().max(1) as i64;
            v.push([dx * 1_400_000 / len, dz * 1_400_000 / len]);
        }
        let first = 1_000_000_000u64;
        let body = |b: u64| Id::new(start.root.scope(), first + 2 * b).expect("an id");
        let link = |b: u64| Id::new(start.root.scope(), first + 2 * b + 1).expect("an id");
        let es: Vec<Effect> = (0..BODIES)
            .map(|b| w.body(ground, body(b), link(b), soul(b), at[b as usize]))
            .collect();
        let mut truth: Vec<SoulChanges> = vec![w.tick(es)];
        let ticks = SECONDS * 1_000_000 / TICK_US;
        let a_second = (1_000_000 / TICK_US) as u64;
        let t0 = Instant::now();
        for t in 1..ticks as u64 {
            for b in 0..BODIES as usize {
                for k in 0..2 {
                    let mut x = at[b][k] + v[b][k] * TICK_US / 1_000_000;
                    if !(lo[k]..hi[k]).contains(&x) {
                        v[b][k] = -v[b][k];
                        x = x.clamp(lo[k], hi[k] - 1);
                    }
                    at[b][k] = x;
                }
            }
            let es: Vec<Effect> = (0..BODIES)
                .filter(|b| b % a_second == t % a_second)
                .map(|b| w.walk(ground, body(b), at[b as usize], v[b as usize]))
                .collect();
            truth.push(w.tick(es));
        }
        let fed = t0.elapsed();
        let mut copy = Copy::default();
        let deliveries = drain(&sub);
        let stats = w.tier.stats();
        assert_eq!(stats.fault, None);
        // Replay: the copy after each tick's deliveries, against the world's list after the same tick.
        let mut want: BTreeMap<u64, Spot> = BTreeMap::new(); // by Soul number
        let mut since: BTreeMap<u64, u64> = BTreeMap::new(); // Soul number -> tick it first differed
        let mut worst_ticks = 0u64;
        let mut moves_by_second: BTreeMap<u64, u64> = BTreeMap::new();
        let mut di = deliveries.iter().peekable();
        let mut changes_seen = 0u64;
        for (t, c) in truth.iter().enumerate() {
            let t = t as u64;
            for (n, s) in &c.moved {
                want.insert(*n, *s);
                changes_seen += 1;
            }
            while let Some(d) = di.peek() {
                let Delivery::Index {
                    record,
                    part,
                    bytes,
                } = d
                else {
                    break;
                };
                if *record > t {
                    break;
                }
                if *part == IndexPart::Moves {
                    *moves_by_second.entry(t / a_second).or_default() += bytes.len() as u64;
                }
                copy.take(d);
                di.next();
            }
            for (n, s) in &want {
                // A Soul is numbered in its order of listing: Soul b is number b here.
                let got = copy.souls.spot(soul(*n));
                if got == Some(*s) {
                    since.remove(n);
                } else {
                    let s0 = *since.entry(*n).or_insert(t);
                    worst_ticks = worst_ticks.max(t - s0 + 1);
                }
            }
        }
        let per_second: Vec<u64> = (1..SECONDS as u64)
            .map(|s| moves_by_second.get(&s).copied().unwrap_or(0))
            .collect();
        let mean = per_second.iter().sum::<u64>() / per_second.len() as u64;
        let mut ps = per_second.clone();
        println!(
            "A2 repeat {repeat}: the copy's Soul list was at most {} ms of world time behind the world's ({changes_seen} spot changes); {} ticks ({SECONDS} world seconds) fed through the tier in {:?}",
            worst_ticks * TICK_US as u64 / 1_000,
            ticks,
            fed
        );
        println!(
            "A4 repeat {repeat}: Soul list with 1,000 walking: mean {mean} B/s, p99 {} B/s, max {} B/s (file {} B, start list {} B once)",
            pct(&mut ps, 99),
            per_second.iter().max().copied().unwrap_or(0),
            copy.bytes.get("file").copied().unwrap_or(0),
            copy.bytes.get("souls").copied().unwrap_or(0),
        );
        assert!(worst_ticks * (TICK_US as u64) <= 2_000_000, "A2");
    }
}
