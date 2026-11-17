//! Engine v2 V14 (#2659): a scripted run of bodies in the tree, written as a trace for the bird's-eye view
//! (`view.html` beside this crate).
//!
//! `cargo run -p birdseye --release -- <out.trace> [bodies] [seconds]` (from `v2/`; defaults 1,000 bodies, 600 s).
//!
//! - **The world** is N2's test world (seed 1), loaded into K2's tree through N1's loader.
//! - **The bodies** are nodes in the tree: most on the open ground's square, the rest in the rooms of every floor, each
//!   a child of the node it stands in. Nothing walks yet in this bench (N7's walkers are N15's): each body paces
//!   between two seeded points of its square or room at today's walking pace, and every tick its pose is committed as
//!   a motion sample (T6), one part a tick, through `Tree::commit`.
//! - **Two seeded faults** for the view to find: body 17 stands still from 120 s to 170 s, and body 42 jumps 6 m at
//!   200 s.
//! - **The trace** is read back from the tree each tick: every body's node and its position in the open ground's frame.
//!   It is a throwaway: not T6's encoding, not a contract, never served. Little-endian: a `u32` header length, the
//!   header (JSON: tick, counts, units, the nodes with their floors, the outlines of every room and named place), zero
//!   bytes to a multiple of four, then per tick `x[n]` and `z[n]` as `i16` centimetres and `node[n]` as `u8`.
//!
//! Integers only: µm and µs in the tree, centimetres in the trace.

use import_eden::{F_LEVEL, F_NAME, F_OUTLINE, Import, PLACE, ROOM};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, schema_hash,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::tree::Handle;
use replica::world_model::{Audience, parse_kinds, plain};
use sim::ground::scene::{Xform, xform_to};
use std::collections::BTreeMap;
use std::io::Write;

/// µs a tick: 20 a second.
const TICK_US: i64 = 50_000;
/// µm a second: today's walking pace.
const SPEED: i64 = 1_400_000;
/// The body that stands still, from and to (s).
const STUCK: (usize, i64, i64) = (17, 120, 170);
/// The body that jumps, when (s) and how far along x (µm).
const JUMP: (usize, i64, i64) = (42, 200, 6_000_000);
const BODY_KIND: &str = r#"{1: "birdseye:body", 2: "thing"}"#;

/// SplitMix64.
struct Seed(u64);
impl Seed {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn within(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() % (hi - lo).max(1) as u64) as i64
    }
}

/// Where a body paces: its node, and the box (µm, the node's frame) its two points are drawn from.
struct Region {
    node: Id,
    lo: [i64; 2],
    hi: [i64; 2],
}

/// A body: its node id, its region, its two points (µm, x and z) and where on its way it starts (µm).
struct Walker {
    id: Id,
    region: usize,
    a: [i64; 2],
    b: [i64; 2],
    phase: i64,
}

fn mm_pairs(v: Option<&Value>) -> Vec<[i64; 2]> {
    let num = |v: &Value| match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    };
    match v {
        Some(Value::Array(ps)) => ps
            .iter()
            .filter_map(|p| match p {
                Value::Array(xz) if xz.len() >= 2 => Some([num(&xz[0])?, num(&xz[1])?]),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn entry(sequence: u64, at: i64, node: Id, changes: Vec<Change>) -> Effect {
    Effect {
        envelope: Envelope {
            sequence,
            at,
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

fn part(header: &Header, effects: &[Effect]) -> Part {
    let v = Value::Map(BTreeMap::from([
        (1, Value::Bytes(header.hash().to_bytes())),
        (
            2,
            Value::Array(effects.iter().map(Effect::to_value).collect()),
        ),
    ]));
    Part::read(&encode(&v).expect("bytes")).expect("a part")
}

fn pose(node: Id, p: [i64; 2]) -> Pose {
    Pose {
        frame: Frame { node, slot: None },
        position: Vec3::new(p[0], 0, p[1]),
        orientation: Quat::IDENTITY,
        support: Support::Surface {
            surface: node,
            height: 0,
        },
    }
}

/// Where a walker is at world time `t` (µs): pacing from `a` to `b` and back, held while seeded to stand still.
fn at(w: &Walker, k: usize, t: i64) -> [i64; 2] {
    let mut t = t;
    if k == STUCK.0 {
        let (from, to) = (STUCK.1 * 1_000_000, STUCK.2 * 1_000_000);
        t -= (t - from).clamp(0, to - from);
    }
    let (dx, dz) = (w.b[0] - w.a[0], w.b[1] - w.a[1]);
    let len = ((dx * dx + dz * dz) as u64).isqrt() as i64;
    let mut p = if len == 0 {
        w.a
    } else {
        let run = (i128::from(t) * i128::from(SPEED) / 1_000_000) as i64 + w.phase;
        let mut d = run.rem_euclid(2 * len);
        if d > len {
            d = 2 * len - d;
        }
        [w.a[0] + dx * d / len, w.a[1] + dz * d / len]
    };
    if k == JUMP.0 && t >= JUMP.1 * 1_000_000 {
        p[0] += JUMP.2;
    }
    p
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out = args
        .get(1)
        .expect("usage: birdseye <out.trace> [bodies] [seconds]");
    let n: usize = args.get(2).map_or(1000, |s| s.parse().expect("bodies"));
    let seconds: i64 = args.get(3).map_or(600, |s| s.parse().expect("seconds"));
    let ticks = seconds * 1_000_000 / TICK_US;

    let w = testworld::generate(1, 0).expect("the test world");
    let Import {
        mut tree,
        mut rules,
        nodes,
        texts,
        ..
    } = import_eden::load(&w.text).expect("the test world loads");
    let (bname, bkind) = parse_kinds(BODY_KIND)
        .expect("the body kind")
        .pop_first()
        .expect("one");
    rules.kinds.insert(bname.clone(), bkind);
    let root = nodes["world"];
    let ground = nodes["ground"];
    let hv = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/birdseye/0").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(root.scope().0.to_vec())),
        (4, root.to_value()),
        (5, Value::Uint(0)),
        (
            6,
            Value::Array(
                rules
                    .kinds
                    .keys()
                    .map(|k| Value::Text(Name::new(k).expect("a kind name")))
                    .collect(),
            ),
        ),
        (7, Value::Array(Vec::new())),
    ]));
    let header = Header::read(&encode(&hv).expect("bytes")).expect("a header");
    let gh = tree.handle(ground).expect("the ground");

    // The rooms and named places, with their floors: outlines for the view and regions for the bodies.
    let name_of = |v: Option<&Value>| match v {
        Some(Value::Bytes(h)) => <[u8; 32]>::try_from(h.as_slice())
            .ok()
            .and_then(|h| texts.get(&h).cloned()),
        _ => None,
    };
    let mut outlines: Vec<(i64, &'static str, Vec<[i64; 2]>)> = Vec::new();
    let mut regions = vec![Region {
        node: ground,
        lo: [-27_000_000, -27_000_000],
        hi: [27_000_000, 27_000_000],
    }];
    let mut node_table: Vec<(Id, String, i64)> = vec![(ground, "open ground".to_owned(), 0)];
    let mut stack = vec![tree.root()];
    while let Some(h) = stack.pop() {
        let nd = tree.node(h).expect("live");
        let kind = plain(nd.kind().as_str()).to_owned();
        if kind == ROOM {
            let floor = nd
                .parent()
                .and_then(|f| tree.node(tree.handle(f)?))
                .and_then(|f| match f.fields().get(&F_LEVEL) {
                    Some(Value::Uint(l)) => Some(*l as i64),
                    _ => None,
                })
                .unwrap_or(0);
            let ring = mm_pairs(nd.fields().get(&F_OUTLINE));
            let x = xform_to(&tree, h, gh).expect("a room on the ground");
            let world: Vec<[i64; 2]> = ring
                .iter()
                .map(|p| {
                    let w = x
                        .point(Vec3::new(p[0] * 1000, 0, p[1] * 1000))
                        .expect("a point");
                    [w.x / 1000, w.z / 1000]
                })
                .collect();
            outlines.push((floor, "room", world));
            let (mut lo, mut hi) = ([i64::MAX; 2], [i64::MIN; 2]);
            for p in &ring {
                lo = [lo[0].min(p[0] * 1000), lo[1].min(p[1] * 1000)];
                hi = [hi[0].max(p[0] * 1000), hi[1].max(p[1] * 1000)];
            }
            let (lo, hi) = (
                [lo[0] + 600_000, lo[1] + 600_000],
                [hi[0] - 600_000, hi[1] - 600_000],
            );
            if hi[0] > lo[0] + 1_500_000 && hi[1] > lo[1] + 1_500_000 {
                regions.push(Region {
                    node: nd.id(),
                    lo,
                    hi,
                });
                let name = name_of(nd.fields().get(&F_NAME)).unwrap_or_else(|| "a room".to_owned());
                node_table.push((nd.id(), name, floor));
            }
        } else if kind == PLACE {
            let ring = mm_pairs(nd.fields().get(&F_OUTLINE));
            if ring.len() >= 3 {
                outlines.push((0, "place", ring));
            }
        }
        stack.extend(tree.children(h).expect("live").iter().copied());
    }

    // The bodies: the first ones on the square (both faults among them), then rooms by their area.
    let mut seed = Seed(2659);
    let room_area: Vec<i64> = regions
        .iter()
        .map(|r| (r.hi[0] - r.lo[0]) / 1000 * ((r.hi[1] - r.lo[1]) / 1000) / 1_000_000)
        .collect();
    let mut walkers: Vec<Walker> = Vec::with_capacity(n);
    let mut mint = Minter::new(Scope([0xb1; 16]));
    let in_rooms: usize = room_area
        .iter()
        .skip(1)
        .map(|a| (a / 8).clamp(2, 120) as usize)
        .sum();
    let on_square = n.saturating_sub(in_rooms).max(n / 2);
    for k in 0..n {
        let region = if k < on_square {
            0
        } else {
            // Rooms in turn, each up to its share.
            let mut left = k - on_square;
            let mut r = 1;
            loop {
                let share = (room_area[r] / 8).clamp(2, 120) as usize;
                if left < share || r + 1 == regions.len() {
                    break r;
                }
                left -= share;
                r += 1;
            }
        };
        let rg = &regions[region];
        let mut pick = || {
            [
                seed.within(rg.lo[0], rg.hi[0]),
                seed.within(rg.lo[1], rg.hi[1]),
            ]
        };
        // Two points at least 2 m apart, so a body that paces always makes progress; else the box's diagonal.
        let (mut a, mut b) = (pick(), pick());
        for _ in 0..64 {
            if (a[0] - b[0]).pow(2) + (a[1] - b[1]).pow(2) >= 2_000_000i64.pow(2) {
                break;
            }
            (a, b) = (pick(), pick());
        }
        if (a[0] - b[0]).pow(2) + (a[1] - b[1]).pow(2) < 2_000_000i64.pow(2) {
            (a, b) = (rg.lo, rg.hi);
        }
        if k == STUCK.0 {
            (a, b) = ([-10_000_000, -10_000_000], [10_000_000, -10_000_000]);
        }
        if k == JUMP.0 {
            (a, b) = ([-20_000_000, 10_000_000], [-4_000_000, 10_000_000]);
        }
        let phase = seed.within(0, 40_000_000);
        walkers.push(Walker {
            id: mint.mint().expect("an id"),
            region,
            a,
            b,
            phase,
        });
    }

    // Create them, one part.
    let mut seq = tree.to_state().next;
    let mut by_region: BTreeMap<usize, Vec<Change>> = BTreeMap::new();
    for (k, w) in walkers.iter().enumerate() {
        let rg = &regions[w.region];
        by_region.entry(w.region).or_default().push(Change::Create {
            node: w.id,
            kind: Name::new(&bname).expect("the kind"),
            pose: pose(rg.node, at(w, k, 0)),
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        });
    }
    let mut effects = Vec::new();
    for (r, cs) in by_region {
        effects.push(entry(seq, 0, regions[r].node, cs));
        seq += 1;
    }
    tree.commit(&header, &part(&header, &effects), &rules)
        .unwrap_or_else(|e| panic!("create refused: {}: {}", e.name, e.detail));

    // Each region's frame on the open ground, and each body's node index in the trace.
    let frames: Vec<Xform> = regions
        .iter()
        .map(|r| xform_to(&tree, tree.handle(r.node).expect("live"), gh).expect("a frame"))
        .collect();
    let node_ix: BTreeMap<Id, u8> = node_table
        .iter()
        .enumerate()
        .map(|(i, (id, ..))| (*id, i as u8))
        .collect();
    let handles: Vec<Handle> = walkers
        .iter()
        .map(|w| tree.handle(w.id).expect("live"))
        .collect();

    let floors: Vec<i64> = {
        let mut f: Vec<i64> = node_table.iter().map(|t| t.2).collect();
        f.sort_unstable();
        f.dedup();
        f
    };
    let json_pts = |v: &[[i64; 2]]| {
        v.iter()
            .map(|p| format!("[{},{}]", p[0] / 10, p[1] / 10))
            .collect::<Vec<_>>()
            .join(",")
    };
    let head = format!(
        "{{\"format\":\"birdseye/0\",\"note\":\"a throwaway trace: not T6's encoding, not a contract, never served\",\"tick_us\":{TICK_US},\"ticks\":{ticks},\"bodies\":{n},\"unit\":\"cm\",\"step_cm\":{},\"floors\":[{}],\"nodes\":[{}],\"outlines\":[{}]}}",
        SPEED * TICK_US / 1_000_000 / 10_000,
        floors
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(","),
        node_table
            .iter()
            .map(|(_, name, f)| format!("{{\"name\":{:?},\"floor\":{f}}}", name))
            .collect::<Vec<_>>()
            .join(","),
        outlines
            .iter()
            .map(|(f, k, v)| format!(
                "{{\"floor\":{f},\"kind\":\"{k}\",\"pts\":[{}]}}",
                json_pts(v)
            ))
            .collect::<Vec<_>>()
            .join(","),
    );
    let mut file = std::io::BufWriter::new(std::fs::File::create(out).expect("the trace file"));
    file.write_all(&(head.len() as u32).to_le_bytes()).unwrap();
    file.write_all(head.as_bytes()).unwrap();
    file.write_all(&vec![0u8; (4 - (4 + head.len()) % 4) % 4])
        .unwrap();

    let t0 = std::time::Instant::now();
    let mut commit_us: u128 = 0;
    let mut row = vec![0u8; 5 * n];
    for tick in 0..ticks {
        let t = tick * TICK_US;
        let effects: Vec<Effect> = walkers
            .iter()
            .enumerate()
            .map(|(k, w)| {
                let node = regions[w.region].node;
                entry(
                    seq + k as u64,
                    t,
                    w.id,
                    vec![Change::Motion(HandOff {
                        node: w.id,
                        at: t,
                        from: Owner::Mover,
                        to: Owner::Mover,
                        pose: pose(node, at(w, k, t)),
                        linear: Vec3::ZERO,
                        angular: Vec3::ZERO,
                    })],
                )
            })
            .collect();
        seq += n as u64;
        let c0 = std::time::Instant::now();
        tree.commit(&header, &part(&header, &effects), &rules)
            .unwrap_or_else(|e| panic!("tick {tick} refused: {}: {}", e.name, e.detail));
        commit_us += c0.elapsed().as_micros();
        // Read back from the tree: each body's node and its position on the open ground.
        for (k, h) in handles.iter().enumerate() {
            let nd = tree.node(*h).expect("live");
            let parent = nd.parent().expect("a parent");
            let p = nd.place().expect("placed").position;
            let wp = frames[walkers[k].region].point(p).expect("a point");
            let (x, z) = ((wp.x / 10_000) as i16, (wp.z / 10_000) as i16);
            row[2 * k..2 * k + 2].copy_from_slice(&x.to_le_bytes());
            row[2 * n + 2 * k..2 * n + 2 * k + 2].copy_from_slice(&z.to_le_bytes());
            row[4 * n + k] = node_ix[&parent];
        }
        file.write_all(&row).unwrap();
    }
    file.flush().unwrap();
    println!(
        "birdseye: {n} bodies ({on_square} on the square, {} in {} rooms), {ticks} ticks of {} ms, {} outlines; run {} ms, commits {} ms; body {} still {}..{} s, body {} jumps {} mm at {} s",
        n - on_square,
        regions.len() - 1,
        TICK_US / 1000,
        outlines.len(),
        t0.elapsed().as_millis(),
        commit_us / 1000,
        STUCK.0,
        STUCK.1,
        STUCK.2,
        JUMP.0,
        JUMP.2 / 1000,
        JUMP.1
    );
}
