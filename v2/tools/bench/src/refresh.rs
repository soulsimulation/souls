//! The `refresh` bench (Engine v2 F9, #2776): every floor lamp of Eden's imported content moves to a second revision
//! of its kind (one field added, `lit`, field 40) while 100 walkers cross the open ground. Each tick is the crowd's
//! step and, from tick 5, one slice of the job (`sim::refresh`), at most `--slice` lamps (default 16, stated from step
//! 0's measured refresh). One lamp is reserved by a body for the job's first 20 ticks, then let go (A3).
//!
//! Printed: step 0 (one refresh alone, and an ordinary tick with 100 walkers); per arm and repeat the ticks' mean,
//! 99th percentile and longest, and the job's longest slice (arms `walk`, no job, and `refresh`); the state diff of
//! every lamp before and after (A2); the reserved lamp's ticks (A3); a run cut by a restart halfway, its log replayed on
//! a fresh import and the job recovered and finished (A4); and the revisions refused by name (A5). Two repeats.
//! Declared on #2776. Needs the exported facts file (`v2/tools/import-eden/README.md`). Run from `v2/`:
//! `cargo run -p bench --release --bin refresh`.

// Times its own runs: the wall-clock rule (K7) binds the engine, not this bench.
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use import_eden::Import;
use import_eden::json;
use replica::effects::{
    Actor, Body as EffectBody, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest,
    schema_hash,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::world_model::{Audience, End, parse_kinds, show};
use sim::links::Doors;
use sim::refresh::{Job, Plan, Writer, plan};
use sim::walk::Crowd;
use sim::walk::town::Town;

const SPEED: i64 = 1_400_000; // µm a second
const TICK: i64 = 50_000; // µs: 20 ticks a second
const WALKERS: usize = 100;
const TICKS: usize = 120;
const START: usize = 5;
const HOLD: usize = 20;
const BAR_MS: f64 = 15.0;
/// Today's def ref of the kind moved.
const REF: &str = "core-floor-lamp@2";
/// The body kind the reservation is written from (the import has no bodies).
const BODY: &str = "{1: \"bench:body\", 2: \"family\"}";

fn facts() -> String {
    let path = std::env::args()
        .skip_while(|a| a != "--facts")
        .nth(1)
        .unwrap_or_else(|| {
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../.local/import-eden/eden-2026.facts.json"
            )
            .into()
        });
    std::fs::read_to_string(&path).expect("run v2/tools/import-eden/export/export.ts first")
}

fn slice_size() -> usize {
    std::env::args()
        .skip_while(|a| a != "--slice")
        .nth(1)
        .map_or(16, |s| s.parse().expect("a count"))
}

/// The two revisions: the kind as N1 imports it, and the same with one state field added.
fn revisions(text: &str) -> (String, String) {
    let f = json::parse(text).expect("JSON");
    let k = f
        .get("kinds")
        .expect("kinds")
        .arr()
        .iter()
        .find(|k| k.get("ref").and_then(json::Json::str) == Some(REF))
        .expect("the kind in the facts");
    let (name, hash) = (
        k.get("name").and_then(json::Json::str).expect("a name"),
        k.get("hash").and_then(json::Json::str).expect("a hash"),
    );
    let old = format!("{{1: \"{name}\", 2: \"thing\", 6: {{}}, 11: [\"thing\"], 19: \"{hash}\"}}");
    let new = old.replacen(
        "2: \"thing\",",
        "2: \"thing\", 3: {40: {1: \"lit\", 2: \"bool\", 3: 0, 4: \"public\"}},",
        1,
    );
    (old, new)
}

struct Run {
    town: Town,
    header: Header,
    parts: Vec<Vec<u8>>,
    lamps: Vec<Id>,
    body_kind: String,
}

fn header(root: Id, kinds: Vec<Name>) -> Header {
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/refresh-bench/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(root.scope().0.to_vec())),
        (4, root.to_value()),
        (5, Value::Uint(0)),
        (
            6,
            Value::Array(kinds.into_iter().map(Value::Text).collect()),
        ),
        (7, Value::Array(Vec::new())),
    ]));
    Header::read(&encode(&v).expect("encodes")).expect("a header")
}

fn run_of(im: Import, p: &Plan) -> Run {
    let Import {
        tree,
        mut rules,
        nodes,
        kinds,
        ..
    } = im;
    assert_eq!(
        kinds[REF],
        p.from.as_str(),
        "the plan's first revision is the imported kind"
    );
    let (body_kind, body) = parse_kinds(BODY).expect("a kind").pop_first().expect("one");
    rules.kinds.insert(body_kind.clone(), body);
    // The bench's body stands on the open ground, which the import's kind does not admit bodies onto.
    let ground_kind = tree
        .node(tree.handle(nodes["ground"]).expect("the ground"))
        .expect("live")
        .kind()
        .clone();
    let ground = rules
        .kinds
        .get_mut(ground_kind.as_str())
        .expect("the ground's kind");
    ground.children.insert("body".into());
    rules.kinds.extend(p.kinds.admits());
    let root = nodes["world"];
    let names = [&p.from, &p.to, &p.job]
        .iter()
        .map(|n| (*n).clone())
        .chain([Name::new(&body_kind).expect("a name")])
        .collect();
    let header = header(root, names);
    let next = tree.to_state().next;
    let lamps = lamps_of(&tree, p.from.as_str());
    let town = Town::new(
        tree,
        nodes["ground"],
        Doors::new(header.clone(), rules, next),
    )
    .expect("the town");
    Run {
        town,
        header,
        parts: Vec::new(),
        lamps,
        body_kind,
    }
}

fn lamps_of(tree: &replica::tree::Tree, kind: &str) -> Vec<Id> {
    let mut out = Vec::new();
    let mut stack = vec![tree.root()];
    while let Some(h) = stack.pop() {
        let n = tree.node(h).expect("live");
        if n.kind().as_str() == kind {
            out.push(n.id());
        }
        stack.extend(tree.children(h).expect("live").iter().copied());
    }
    out.sort();
    out
}

impl Run {
    fn writer(&mut self, tick: usize) -> Writer<'_> {
        Writer {
            tree: &mut self.town.tree,
            header: &self.header,
            rules: &self.town.doors.rules,
            next: &mut self.town.doors.next,
            at: tick as i64 * TICK,
            parts: &mut self.parts,
        }
    }

    /// One entry of generic changes by `node`, as its own part.
    fn write(&mut self, node: Id, changes: Vec<Change>) {
        let e = Effect {
            envelope: Envelope {
                sequence: self.town.doors.next,
                at: 0,
                cause: Cause::World,
                actor: Actor::World,
                audience: Audience::Everyone,
                node,
            },
            body: EffectBody::Changes(
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
        let bytes = encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (2, Value::Array(vec![e.to_value()])),
        ])))
        .expect("encodes");
        let part = Part::read(&bytes).expect("a part");
        let rules = &self.town.doors.rules;
        self.town
            .tree
            .commit(&self.header, &part, rules)
            .expect("committed");
        self.town.doors.next += 1;
        self.parts.push(bytes);
    }

    /// A body on the open ground reserving `lamp`: the link a form's start writes (F3).
    fn reserve(&mut self, body: Id, link: Id, lamp: Id) {
        let ground = self.town.ground;
        let create = Change::Create {
            node: body,
            kind: Name::new(&self.body_kind).expect("a name"),
            pose: Pose {
                frame: Frame {
                    node: ground,
                    slot: None,
                },
                position: Vec3::ZERO,
                orientation: Quat::IDENTITY,
                support: Support::Surface {
                    surface: ground,
                    height: 0,
                },
            },
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        };
        self.write(ground, vec![create]);
        let ty = Name::new("souls:reserves").expect("a name");
        let audience = Audience::Everyone;
        self.write(
            body,
            vec![Change::Link {
                link,
                ty,
                ends: [body, lamp],
                owner: End::First,
                audience,
            }],
        );
    }

    fn fields(&self, id: Id) -> (Name, Option<Id>, Option<u64>, BTreeMap<u64, Value>) {
        let t = &self.town.tree;
        let n = t.node(t.handle(id).expect("live")).expect("live");
        (n.kind().clone(), n.parent(), n.slot(), n.fields().clone())
    }

    /// 100 walkers on the open ground, each sent 60 m or more to another spot, in a fixed order.
    fn walkers(&mut self) -> Crowd {
        let t = &mut self.town;
        let g = t.ground;
        let mut spots = Vec::new();
        for i in -30..30 {
            for j in -30..30 {
                let p = Vec3::new(i * 7_000_000 + 1_300_000, 0, j * 7_000_000 + 2_100_000);
                if t.map.spot(g, p).is_some()
                    && t.surfaces[&g]
                        .place(
                            Id::new(Scope([9; 16]), 1).expect("an id"),
                            Frame {
                                node: g,
                                slot: None,
                            },
                            p,
                            Quat::IDENTITY,
                        )
                        .is_ok()
                {
                    spots.push(p);
                }
            }
        }
        let mut c = Crowd::new(TICK);
        let mut mint = Minter::new(Scope([0xf9; 16]));
        let n = spots.len();
        for k in 0..n {
            if c.walkers.len() == WALKERS {
                break;
            }
            let (from, to) = (spots[k], spots[(k * 7 + n / 2) % n]);
            let d = ((from.x - to.x) as f64).hypot((from.z - to.z) as f64);
            if d < 60_000_000.0 {
                continue;
            }
            let who = mint.mint().expect("an id");
            let body = t.surfaces[&g]
                .place(
                    who,
                    Frame {
                        node: g,
                        slot: None,
                    },
                    from,
                    Quat::IDENTITY,
                )
                .expect("placed");
            let order = mint.mint().expect("an id");
            let _ = c.add(t, body, SPEED, order, g, to);
        }
        assert_eq!(
            c.walkers.len(),
            WALKERS,
            "{} spots on the open ground",
            spots.len()
        );
        c
    }
}

fn ms(d: std::time::Duration) -> f64 {
    d.as_secs_f64() * 1e3
}

fn stats(mut v: Vec<f64>) -> (f64, f64, f64) {
    v.sort_by(f64::total_cmp);
    let mean = v.iter().sum::<f64>() / v.len() as f64;
    let p99 = v[(v.len() * 99).div_ceil(100).saturating_sub(1)];
    (mean, p99, *v.last().unwrap_or(&0.0))
}

struct Arm {
    ticks: Vec<f64>,
    slices: Vec<f64>,
    done_at: Option<usize>,
    held_until: Option<usize>,
    refused: usize,
}

/// One arm: 100 walkers for `TICKS` ticks; with `job`, the job from tick `START`, one lamp reserved for `HOLD` ticks.
fn arm(text: &str, p: &Plan, job: bool, stop_at: Option<usize>) -> (Run, Arm, Option<Job>) {
    let mut r = run_of(import_eden::load(text).expect("Eden loads"), p);
    let mut c = r.walkers();
    let mut ids = Minter::new(Scope([0xfa; 16]));
    let (body, link, job_node) = (
        ids.mint().expect("id"),
        ids.mint().expect("id"),
        ids.mint().expect("id"),
    );
    let held = r.lamps[r.lamps.len() / 2];
    let mut out = Arm {
        ticks: Vec::new(),
        slices: Vec::new(),
        done_at: None,
        held_until: None,
        refused: 0,
    };
    if job {
        r.reserve(body, link, held);
    }
    let mut running: Option<Job> = None;
    let limit = slice_size();
    for tick in 0..TICKS {
        if stop_at == Some(tick) {
            return (r, out, running);
        }
        let t0 = Instant::now();
        c.step(&mut r.town)
            .unwrap_or_else(|e| panic!("refused: {}: {}", e.name, e.detail));
        let t1 = Instant::now();
        if job && tick == START {
            let ground = r.town.ground;
            running = Some(
                Job::start(&mut r.writer(tick), p, job_node, ground, Actor::World)
                    .expect("started"),
            );
        }
        if let Some(j) = running.as_mut().filter(|_| out.done_at.is_none()) {
            let s = j.slice(&mut r.writer(tick), limit).expect("a slice");
            if s.deferred.iter().any(|(id, _)| *id == held) {
                out.held_until = Some(tick);
            }
            if s.done {
                out.done_at = Some(tick);
                out.refused = j.refused.len();
            }
        }
        let t2 = Instant::now();
        if job && tick == START + HOLD {
            r.write(body, vec![Change::Unlink { link }]);
        }
        out.ticks.push(ms(t2 - t0));
        if job && tick >= START {
            out.slices.push(ms(t2 - t1));
        }
    }
    (r, out, running)
}

fn main() {
    let text = facts();
    let (old, new) = revisions(&text);
    let p = plan(&old, &new).unwrap_or_else(|e| panic!("{}: {}", e.name, e.detail));
    println!(
        "refresh (F9, #2776): {} -> {}",
        p.from.as_str(),
        p.to.as_str()
    );
    println!(
        "  added {:?}, dropped {:?}",
        p.added.keys().collect::<Vec<_>>(),
        p.dropped
    );

    // Step 0: one refresh alone (the median of 20, each a slice of one), and an ordinary tick with 100 walkers.
    {
        let mut r = run_of(import_eden::load(&text).expect("Eden loads"), &p);
        println!(
            "  step 0: {} things of the kind in the import",
            r.lamps.len()
        );
        let ground = r.town.ground;
        let node = Minter::new(Scope([0xfb; 16])).mint().expect("id");
        let t = Instant::now();
        let mut j = Job::start(&mut r.writer(0), &p, node, ground, Actor::World).expect("started");
        let start = ms(t.elapsed());
        let mut one = Vec::new();
        for _ in 0..20 {
            let t = Instant::now();
            assert_eq!(j.slice(&mut r.writer(0), 1).expect("a slice").refreshed, 1);
            one.push(ms(t.elapsed()));
        }
        let (mean, _, max) = stats(one);
        let mut c = r.walkers();
        let mut walk = Vec::new();
        for _ in 0..40 {
            let t = Instant::now();
            c.step(&mut r.town).expect("a step");
            walk.push(ms(t.elapsed()));
        }
        let (wm, wp, wx) = stats(walk);
        println!(
            "  step 0: job start (one walk of the tree) {start:.3} ms; one refresh mean {mean:.3} ms, longest {max:.3} ms"
        );
        println!(
            "  step 0: 100 walkers alone, 40 ticks: mean {wm:.2} ms, p99 {wp:.2} ms, longest {wx:.2} ms"
        );
        println!("  step 0: slice stated: {} things a tick", slice_size());
    }

    println!(
        "\n| arm | repeat | ticks | mean ms | p99 ms | longest ms | longest slice ms | lamps moved | done at tick | under {BAR_MS} ms |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|");
    for repeat in 1..=2 {
        let (_, a, _) = arm(&text, &p, false, None);
        let (m, p99, x) = stats(a.ticks);
        println!(
            "| walk | {repeat} | {TICKS} | {m:.2} | {p99:.2} | {x:.2} | - | 0 | - | {} |",
            x < BAR_MS
        );

        let (r, a, _) = arm(&text, &p, true, None);
        let (m, p99, x) = stats(a.ticks);
        let (_, _, sx) = stats(a.slices);
        let moved = lamps_of(&r.town.tree, p.to.as_str()).len();
        println!(
            "| refresh | {repeat} | {TICKS} | {m:.2} | {p99:.2} | {x:.2} | {sx:.2} | {moved} of {} | {} | {} |",
            r.lamps.len(),
            a.done_at.map_or("-".into(), |t| t.to_string()),
            x < BAR_MS
        );
        assert_eq!(a.refused, 0);
        assert!(a.done_at.is_some());
    }

    // A2: the state diff, lamp by lamp, against the import.
    let base = run_of(import_eden::load(&text).expect("Eden loads"), &p);
    let (r, a, _) = arm(&text, &p, true, None);
    let mut diffs: BTreeMap<Vec<u64>, usize> = BTreeMap::new();
    let mut kept = 0;
    for id in &base.lamps {
        let (_, parent0, slot0, before) = base.fields(*id);
        let (kind, parent, slot, after) = r.fields(*id);
        assert_eq!(kind, p.to);
        assert_eq!((parent0, slot0), (parent, slot), "parent and slot kept");
        let changed: Vec<u64> = after
            .keys()
            .chain(before.keys())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter(|k| before.get(k) != after.get(k))
            .copied()
            .collect();
        kept += usize::from(before.iter().all(|(k, v)| after.get(k) == Some(v)));
        *diffs.entry(changed).or_default() += 1;
    }
    println!(
        "\nA2 state diff, {} lamps: every field kept in {kept}; fields that differ -> lamps: {diffs:?}",
        base.lamps.len()
    );
    let sample = base.lamps[0];
    let keys = |r: &Run| r.fields(sample).3.keys().copied().collect::<Vec<_>>();
    println!(
        "  e.g. lamp {}: fields before {:?}",
        show(sample),
        keys(&base)
    );
    println!(
        "  e.g. lamp {}: fields after  {:?} (40 = {:?})",
        show(sample),
        keys(&r),
        r.fields(sample).3.get(&40)
    );

    // A3: the reserved lamp.
    println!(
        "\nA3 lamp {} reserved until tick {}: deferred through tick {:?}, on {} at the end; job done at tick {:?}",
        show(r.lamps[r.lamps.len() / 2]),
        START + HOLD,
        a.held_until,
        r.fields(r.lamps[r.lamps.len() / 2]).0.as_str(),
        a.done_at
    );

    // A4: cut halfway, the log replayed on a fresh import, the job recovered and finished.
    let half = START + (r.lamps.len() / slice_size()) / 2;
    let (cut, _, job) = arm(&text, &p, true, Some(half));
    let before_cut = lamps_of(&cut.town.tree, p.to.as_str()).len();
    drop(job);
    let mut again = run_of(import_eden::load(&text).expect("Eden loads"), &p);
    for bytes in &cut.parts {
        let part = Part::read(bytes).expect("a part");
        let rules = &again.town.doors.rules;
        again
            .town
            .tree
            .commit(&again.header, &part, rules)
            .expect("replays");
        again.town.doors.next += part.effects.len() as u64;
    }
    let mut jobs = Job::recover(&again.town.tree);
    assert_eq!(jobs.len(), 1);
    let left = jobs[0].left();
    let mut ticks = 0;
    loop {
        ticks += 1;
        if ticks == HOLD {
            // The reserving body lets go, as in the run that was not cut.
            let (body, link) = {
                let t = &again.town.tree;
                let lamp = again.lamps[again.lamps.len() / 2];
                let e = t.links_at(lamp).first().expect("the reservation").clone();
                (e.other, e.link)
            };
            again.write(body, vec![Change::Unlink { link }]);
        }
        if jobs[0]
            .slice(&mut again.writer(half + ticks), slice_size())
            .expect("a slice")
            .done
        {
            break;
        }
        assert!(ticks < 1_000, "the recovered job ends");
    }
    let after = lamps_of(&again.town.tree, p.to.as_str()).len();
    println!(
        "\nA4 cut at tick {half}: {before_cut} lamps moved before the cut, {left} left after recovery, finished in {ticks} slices: {after} of {} on the new revision, {} on the old",
        again.lamps.len(),
        lamps_of(&again.town.tree, p.from.as_str()).len()
    );

    // A5: revisions that move where a body stands or the thing's shape are refused.
    let shape = new.replacen("2: \"thing\",", "2: \"thing\", 7: h'1220aa',", 1);
    let stand = new.replacen(
        "2: \"thing\",",
        "2: \"thing\", 5: {1: {1: \"front\", 2: [0, 0, 400], 3: \"stand\"}},",
        1,
    );
    for (what, text) in [
        ("a geometry (section 7)", &shape),
        ("a stand point", &stand),
    ] {
        let e = plan(&old, text).err().expect("refused");
        println!(
            "A5 a revision adding {what}: refused {} ({})",
            e.name, e.detail
        );
    }
}
