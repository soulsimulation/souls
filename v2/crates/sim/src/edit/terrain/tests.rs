//! G5's acceptance (#2762) on a field written as data: 48 m of open ground, nine 16 m terrain tiles of 1 m cells, flat
//! at 0, a box resting at (24, 31) m. Walkers cross it west to east at z = 20, 24 and 28 m through the host (N7's walk,
//! G3's ladder); one second in, a creator's edit raises a hill (A1) or digs a pond (A2) across their way, planned off
//! the clock on a copy and committed through G1, its ground rebuilt off the clock while the clock goes on (G3). A3 and
//! A5 are the edit's refusals and its lift. `cargo test -p sim --release --lib terrain -- --nocapture` prints the
//! numbers.

// Times its own runs: the wall-clock rule (K7) binds the engine, not this test.
#![allow(clippy::disallowed_methods)]

use super::{MALFORMED, REFUSED, UNDER_BUILDING, UNDER_SOUL, UNSETTLED};
use crate::edit::safety::Who;
use crate::edit::{commit, plan};
use crate::gaits::Ground;
use crate::ground::exits::piece_of;
use crate::ground::scene::{F_OUTLINE, F_PLACE_OF, F_TILE_SIZE, F_TILES, F_WATER_LEVEL};
use crate::ground::{STEEP, Terrain};
use crate::host::Runner;
use crate::links::Doors;
use crate::mover::Body;
use crate::routes::HANDS;
use crate::unstick::Ladder;
use crate::walk::town::Town;
use crate::walk::{Leg, World as _, node_of};
use import_eden::Import;
use replica::apply::Replica;
use replica::bodies::{Class, Family, Resource};
use replica::edit::{Edit, Op, Ref, Refused, Spot, World, check};
use replica::effects::{Actor, Header};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, Minter, Scope};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::time::Micros;
use replica::world_model::{Audience, show};
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};

const M: i64 = 1_000_000;
/// Samples a side of a tile, less one: 16 m tiles of 1 m cells.
const N: i64 = 16;
const TILES: i64 = 3;
const TICK: Micros = 50_000;
const SPEED: i64 = 1_400_000;
/// The edit is checked a second in.
const EDIT_AT: u64 = 20;
/// The walkers' lines, m.
const LINES: [i64; 3] = [20, 24, 28];
/// The resting box, m.
const BOX: [i64; 2] = [24, 31];
/// The hill: its middle and radius (m) and height (mm); its flanks are steeper than N11a's bar.
const HILL: ([f64; 2], f64, f64) = ([24.0, 24.0], 8.0, 6_000.0);
/// The pond's outline (m, x then z) and level (mm): across the three lines, its bed 0.25 m under the level at the edge
/// and 0.15 m deeper for every metre in.
const POND: [i64; 4] = [18, 12, 30, 30];
const LEVEL: i64 = -200;

fn id(n: u64) -> Id {
    Id::new(Scope([7; 16]), n).unwrap()
}

fn int(v: i64) -> Value {
    if v >= 0 {
        Value::Uint(v as u64)
    } else {
        Value::Nint((-1 - v) as u64)
    }
}

fn b64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        for k in 0..4 {
            s.push(if k <= c.len() {
                A[(n >> (18 - 6 * k) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    s
}

/// A tile's heights (mm, i32 little-endian, a row of x for each z) and classes, from `h` at each sample (m).
fn tile(tx: i64, tz: i64, h: &dyn Fn(i64, i64) -> i64) -> (Vec<u8>, Vec<u8>) {
    let mut heights = Vec::new();
    for j in 0..=N {
        for i in 0..=N {
            let v = i32::try_from(h(tx * N + i, tz * N + j)).unwrap();
            heights.extend_from_slice(&v.to_le_bytes());
        }
    }
    (heights, vec![0; (N * N) as usize])
}

fn keys() -> impl Iterator<Item = (i64, i64)> {
    (0..TILES).flat_map(|tz| (0..TILES).map(move |tx| (tx, tz)))
}

/// The open ground's `F_TILES` for heights `h`.
fn tiles_value(h: &dyn Fn(i64, i64) -> i64) -> Value {
    Value::Array(
        keys()
            .map(|(tx, tz)| {
                let (hb, cb) = tile(tx, tz, h);
                Value::Array(vec![int(tx), int(tz), Value::Bytes(hb), Value::Bytes(cb)])
            })
            .collect(),
    )
}

fn flat(_: i64, _: i64) -> i64 {
    0
}

thread_local! {
    /// The hill raised: [`HILL`], or one of #3473's.
    static SHAPE: Cell<([f64; 2], f64, f64)> = const { Cell::new(HILL) };
}

/// The hill's height at a sample: a raised cosine.
fn hill(i: i64, j: i64) -> i64 {
    let ([cx, cz], r, h) = SHAPE.get();
    let d = ((i as f64 - cx).powi(2) + (j as f64 - cz).powi(2)).sqrt() / r;
    if d >= 1.0 {
        0
    } else {
        (h * (1.0 + (std::f64::consts::PI * d).cos()) / 2.0).round() as i64
    }
}

/// The pond's bed at a sample: under the level inside its outline.
fn pond(i: i64, j: i64) -> i64 {
    let [x0, z0, x1, z1] = POND;
    let d = (i - x0).min(x1 - i).min(j - z0).min(z1 - j);
    if d < 0 { 0 } else { LEVEL - 250 - 150 * d }
}

/// The field as N1's facts file, with the resting box.
fn field() -> Import {
    let tiles: Vec<String> = keys()
        .map(|(tx, tz)| {
            let (h, c) = tile(tx, tz, &flat);
            format!(
                r#"{{"tx": {tx}, "tz": {tz}, "heights": "{}", "classes": "{}"}}"#,
                b64(&h),
                b64(&c)
            )
        })
        .collect();
    let side = TILES * N * 1000;
    let text = format!(
        r#"{{"format": "souls/import-eden/1",
          "kinds": [{{"ref": "testworld-box@1", "hash": "53179b1e42508ae311f9d73f380c9b8d06b595204965a653ef9cca5cdde228f2", "name": "testworld:box", "form": "point"}}],
          "things": [{{"id": "box", "def": "testworld-box@1", "ref": "testworld-box@1", "parent": null,
            "pose": [{}, 0, {}, 0], "scale_ppm": 1000000, "solids": [[0, 0, 150, 150, 0, 0, 300, 5, 0]]}}],
          "doors": [],
          "places": [{{"id": "field.area", "of": "area", "kind": "field", "name": "the field",
            "polygon": [[0, 0], [{side}, 0], [{side}, {side}], [0, {side}]]}}],
          "bake": {{}}, "byRef": {{}}, "ground": {{"tileM": {N}, "tiles": [{}]}}}}"#,
        BOX[0] * 1000,
        BOX[1] * 1000,
        tiles.join(", ")
    );
    import_eden::load(&text).expect("the field loads")
}

/// The import's log as a replica starts from it: `Replica::start` roots a zone at a `souls:place` kind and the import
/// roots it at its world kind, so the header lists that kind once more under the place's name (as worldd's tests do).
fn log(im: &Import) -> (Vec<u8>, Vec<u8>) {
    let Value::Map(mut h) = decode(&im.log.0).unwrap().value else {
        panic!("a header")
    };
    let Some(Value::Array(kinds)) = h.get_mut(&6) else {
        panic!("its kinds")
    };
    let world = kinds
        .iter()
        .find_map(|k| match k {
            Value::Text(t) => t.as_str().strip_prefix("eden:world@").map(str::to_owned),
            _ => None,
        })
        .expect("the world's kind");
    kinds.push(Value::Text(
        Name::new(&format!("souls:place@{world}")).unwrap(),
    ));
    let header = encode(&Value::Map(h)).unwrap();
    let Value::Map(mut part) = decode(&im.log.1).unwrap().value else {
        panic!("a part")
    };
    part.insert(
        1,
        Value::Bytes(Header::read(&header).unwrap().hash().to_bytes()),
    );
    (header, encode(&Value::Map(part)).unwrap())
}

/// The field's copy for edits: the replica loaded from the import's log, the world's creator and kinds.
struct Edits {
    live: Replica,
    world: World,
    ground: Id,
    minter: Minter,
    intents: Minter,
    place: Name,
}

impl Edits {
    fn of(im: &Import) -> Edits {
        let (header, part) = log(im);
        let mut live = Replica::start(&header).expect("a replica");
        live.apply_bytes(&part).expect("the import's part");
        let place = im
            .rules
            .kinds
            .keys()
            .find(|k| k.starts_with("eden:place@"))
            .expect("the place kind");
        Edits {
            place: Name::new(place).unwrap(),
            world: World {
                creator: Id::new(Scope([0xc0; 16]), 1).unwrap(),
                kinds: im.rules.kinds.clone(),
            },
            ground: im.nodes["ground"],
            minter: Minter::new(Scope([0x95; 16])),
            intents: Minter::new(Scope([0x11; 16])),
            live,
        }
    }

    /// Checks, plans and commits `ops` against `bodies` at `at`.
    fn run(
        &mut self,
        ops: Vec<Op>,
        bodies: &[Who],
        at: Micros,
    ) -> Result<crate::edit::Committed, Refused> {
        let edit = Edit {
            intent: self.intents.mint().unwrap(),
            actor: Actor::Creator(self.world.creator),
            planned: self.live.version(),
            ops,
        };
        let copy = self.live.frozen();
        let checked = check(edit, &copy, &self.world)?;
        let planned = plan(checked, &copy, Some(self.ground))?;
        commit(&mut self.live, &mut self.minter, &planned, bodies, at)
    }

    /// The landform's place node: its outline, and the fields given (a water's own, for a pond).
    fn landform(&self, of: &str, ring: &[[i64; 2]], more: Vec<(u64, Value)>) -> Op {
        let ring = Value::Array(
            ring.iter()
                .map(|p| Value::Array(vec![int(p[0] * 1000), int(p[1] * 1000)]))
                .collect(),
        );
        let mut fields = BTreeMap::from([
            (F_PLACE_OF, Value::Text(Name::new(of).unwrap())),
            (F_OUTLINE, ring),
        ]);
        fields.extend(more);
        Op::Place {
            name: 1,
            kind: self.place.clone(),
            parent: Ref::Node(self.ground),
            at: Spot {
                slot: None,
                position: Vec3::ZERO,
                orientation: Quat::IDENTITY,
                support: Support::None,
            },
            audience: Audience::Everyone,
            fields,
        }
    }

    fn tiles(&self, h: &dyn Fn(i64, i64) -> i64) -> Op {
        Op::Set {
            node: Ref::Node(self.ground),
            field: F_TILES,
            to: tiles_value(h),
        }
    }

    /// The move that lifts `thing` by the ground's change `rise` (µm) under its origin.
    fn lift(&self, thing: Id, rise: i64) -> Op {
        let t = self.live.tree();
        let p = t.node(t.handle(thing).unwrap()).unwrap().place().unwrap();
        Op::Move {
            node: Ref::Node(thing),
            at: Spot {
                slot: None,
                position: Vec3::new(p.position.x, p.position.y + rise, p.position.z),
                orientation: p.orientation,
                support: p.support,
            },
        }
    }

    fn y_of(&self, thing: Id) -> i64 {
        let t = self.live.tree();
        t.node(t.handle(thing).unwrap())
            .unwrap()
            .place()
            .unwrap()
            .position
            .y
    }
}

fn square() -> Vec<[i64; 2]> {
    let ([cx, cz], r, _) = SHAPE.get();
    let (cx, cz, r) = (cx as i64, cz as i64, r as i64);
    vec![
        [cx - r, cz - r],
        [cx + r, cz - r],
        [cx + r, cz + r],
        [cx - r, cz + r],
    ]
}

#[test]
fn landform_parameters_and_owned_doorway_metadata_have_distinct_fields() {
    use replica::edit::DOOR_GEOMETRY;

    assert_eq!(DOOR_GEOMETRY, 100);
    let im = field();
    let mut edits = Edits::of(&im);
    let parameters = Value::Bytes(br#"{"kind":"bump","h":0}"#.to_vec());
    let place = edits.landform("eden:landform", &square(), vec![(28, parameters.clone())]);
    let made = edits
        .run(vec![place], &[], 0)
        .expect("landform field 28 Place");
    let node = made.names[&1];
    let updated = Value::Bytes(br#"{"kind":"bump","h":1}"#.to_vec());
    edits
        .run(
            vec![Op::Set {
                node: Ref::Node(node),
                field: 28,
                to: updated.clone(),
            }],
            &[],
            0,
        )
        .expect("landform field 28 Set");
    let tree = edits.live.tree();
    let placed = tree.node(tree.handle(node).unwrap()).unwrap();
    let fields = placed.fields();
    assert_eq!(fields.get(&28), Some(&updated));
    assert!(!fields.contains_key(&DOOR_GEOMETRY));

    // Reserved metadata stays protected regardless of the forged value's shape.
    for forged in [parameters, Value::Array(vec![])] {
        let before = edits.live.version();
        let place = edits.landform(
            "eden:landform",
            &square(),
            vec![(DOOR_GEOMETRY, forged.clone())],
        );
        let refused = edits
            .run(vec![place], &[], 0)
            .expect_err("forged metadata Place");
        assert_eq!(refused.name, "edit.doorway-geometry");
        assert_eq!(edits.live.version(), before);
        let refused = edits
            .run(
                vec![Op::Set {
                    node: Ref::Node(node),
                    field: DOOR_GEOMETRY,
                    to: forged,
                }],
                &[],
                0,
            )
            .expect_err("forged metadata Set");
        assert_eq!(refused.name, "edit.doorway-geometry");
        assert_eq!(edits.live.version(), before);
    }
}

/// The hill's batch: its node, the tiles, and the box lifted by the ground's change under it (a sample, so exact).
fn hill_ops(e: &Edits, box_id: Id, lift: bool) -> Vec<Op> {
    let ([cx, cz], r, h) = SHAPE.get();
    let params = format!(
        r#"{{"kind":"bump","c":[{cx},{cz}],"r":{r},"h":{},"peak":1}}"#,
        h / 1000.0
    )
    .into_bytes();
    let mut ops = vec![
        e.landform("eden:landform", &square(), vec![(28, Value::Bytes(params))]),
        e.tiles(&hill),
    ];
    if lift {
        ops.push(e.lift(box_id, hill(BOX[0], BOX[1]) * 1000));
    }
    ops
}

fn pond_ops(e: &Edits) -> Vec<Op> {
    let [x0, z0, x1, z1] = POND;
    vec![
        e.landform(
            "eden:water",
            &[[x0, z0], [x1, z0], [x1, z1], [x0, z1]],
            vec![(F_WATER_LEVEL, int(LEVEL))],
        ),
        e.tiles(&pond),
    ]
}

fn humanoid() -> Family {
    let r = |n: &str| Resource {
        name: Name::new(n).unwrap(),
        class: Class::Locomotion,
        slot: None,
    };
    Family {
        name: Name::new("souls:humanoid").unwrap(),
        resources: vec![r("souls:leg-left"), r("souls:leg-right")],
    }
}

fn walk(r: &mut Runner, t: &mut Town, body: Body, goal: Vec3) -> Vec<Leg> {
    let legs = t
        .plan(&body, t.ground, goal)
        .unwrap_or_else(|e| panic!("{}: {}", e.name, e.detail));
    let route = legs
        .iter()
        .map(|l| skills::route::Leg {
            to: l.to,
            link: l.link,
        })
        .collect();
    let skill = Box::new(skills::route::Route::new(route, SPEED, r.tick));
    r.add(humanoid(), body, skill).expect("a walker");
    legs
}

fn who(b: &crate::mover::Body) -> Who {
    Who {
        soul: b.id,
        body: b.id,
        pose: b.pose,
        has: HANDS,
        crossing: None,
    }
}

/// What one arm measured.
struct Arm {
    stale: usize,
    max_delay: Micros,
    rebuild_us: u128,
    ticks_during: u64,
    install_us: u128,
    arrived: usize,
    samples: u64,
    bad: Vec<String>,
    ended: Vec<String>,
}

/// The walkers, the edit `ops` one second in, and twenty seconds after; `bad` names a sample on ground the edit made
/// forbidden (a steep cell, or water a walker may not wade).
fn arm(ops: fn(&Edits, Id) -> Vec<Op>, forbidden: fn(&Town, Vec3) -> Option<String>) -> Arm {
    let im = field();
    let box_id = im.nodes["box"];
    let mut e = Edits::of(&im);
    let im = field();
    let header = Header::read(&log(&im).0).unwrap();
    let next = im.tree.to_state().next;
    let ground = im.nodes["ground"];
    let mut t =
        Town::new(im.tree, ground, Doors::new(header.clone(), im.rules, next)).expect("the town");
    let mut c = Runner::new(TICK);
    let mut ladder = Ladder::new();
    for (k, z) in LINES.iter().enumerate() {
        let w = id(k as u64 + 1);
        let body = t.surfaces[&ground]
            .place(
                w,
                Frame {
                    node: ground,
                    slot: None,
                },
                Vec3::new(4 * M, 0, z * M),
                Quat::IDENTITY,
            )
            .unwrap_or_else(|e| panic!("{}: {}", e.name, e.detail));
        let goal = Vec3::new(44 * M, 0, z * M);
        let legs = walk(&mut c, &mut t, body, goal);
        ladder.add(w, id(100 + k as u64), SPEED, ground, goal, legs);
    }
    let step = |t: &mut Town, c: &mut Runner, l: &mut Ladder| {
        l.step(c, t)
            .unwrap_or_else(|e| panic!("refused: {}: {}", e.name, e.detail));
    };
    for _ in 0..EDIT_AT {
        step(&mut t, &mut c, &mut ladder);
    }
    // The edit, checked and committed on the copy against the walkers as they stand.
    let bodies: Vec<Who> = c.controller.bodies().map(who).collect();
    let part = e
        .run(ops(&e, box_id), &bodies, c.now)
        .unwrap_or_else(|r| panic!("refused: {}: {}", r.name, r.detail))
        .part;
    // Its ground, cut off the clock from a copy while the clock goes on (G3).
    let (base, versions, basis) = (t.tree.frozen(), t.versions.clone(), t.basis());
    let t0 = std::time::Instant::now();
    let (rebuilt, rebuild_us, ticks_during) = std::thread::scope(|s| {
        let job = s.spawn(|| {
            let r = Town::rebuild(base, &header, ground, &versions, &basis, &part);
            (r, t0.elapsed().as_micros())
        });
        // The clock goes on at real time, a tick every 50 ms, until the ground is ready.
        let mut ticks = 0;
        while !job.is_finished() {
            std::thread::sleep(std::time::Duration::from_micros(TICK as u64));
            if !job.is_finished() {
                step(&mut t, &mut c, &mut ladder);
                ticks += 1;
            }
        }
        let (r, us) = job.join().unwrap();
        (r.expect("the rebuild"), us, ticks)
    });
    let t1 = std::time::Instant::now();
    t.install(rebuilt, &part)
        .unwrap_or_else(|e| panic!("install refused: {}: {}", e.name, e.detail));
    let install_us = t1.elapsed().as_micros();
    let commit_at = c.now;
    let stale: BTreeSet<Id> = c
        .running_bodies()
        .into_iter()
        .filter(|w| t.planned_on(*w).iter().any(|(n, _)| *n == ground))
        .collect();
    let (mut samples, mut bad) = (0, Vec::new());
    for _ in 0..800 {
        if ladder.done(&c) {
            break;
        }
        step(&mut t, &mut c, &mut ladder);
        for b in c.controller.bodies() {
            samples += 1;
            if let Some(why) = forbidden(&t, b.pose.position) {
                bad.push(format!("{} at {:?}: {why}", show(b.id), b.pose.position));
            }
            assert_eq!(node_of(b), ground);
        }
    }
    let max_delay = stale
        .iter()
        .map(|w| {
            let (_, at, _) = ladder
                .replans
                .iter()
                .find(|(x, at, _)| x == w && *at >= commit_at)
                .unwrap_or_else(|| panic!("{} was never planned again: {:?}", show(*w), c.ended));
            at - commit_at
        })
        .max()
        .unwrap_or(0);
    let arrived = c
        .ended
        .values()
        .filter(|(_, p)| *p == replica::host::Progress::Done)
        .count();
    Arm {
        stale: stale.len(),
        max_delay,
        rebuild_us,
        ticks_during,
        install_us,
        arrived,
        samples,
        bad,
        ended: c
            .controller
            .bodies()
            .map(|b| {
                format!(
                    "{} at {:?}: {:?}",
                    show(b.id),
                    b.pose.position,
                    c.ended.get(&b.id)
                )
            })
            .collect(),
    }
}

/// `f` at `p` when it holds there and 2 mm off each way too (a centre on a cell's or a piece's edge reads either side).
fn all_round(p: Vec3, f: impl Fn(Vec3) -> Option<String>) -> Option<String> {
    let off = [(0, 0), (2_000, 0), (-2_000, 0), (0, 2_000), (0, -2_000)];
    let mut first = None;
    for (dx, dz) in off {
        let why = f(Vec3::new(p.x + dx, p.y, p.z + dz))?;
        first.get_or_insert(why);
    }
    first
}

fn steep(t: &Town, p: Vec3) -> Option<String> {
    let terrain = Terrain::of(&t.tree, t.ground).unwrap().unwrap();
    all_round(p, |q| {
        let s = terrain.slope_at(q.x, q.z).unwrap_or(0);
        (s > STEEP).then(|| format!("on a cell of slope {s} ppm"))
    })
}

fn wet(t: &Town, p: Vec3) -> Option<String> {
    let s = &t.surfaces[&t.ground];
    all_round(p, |q| {
        match piece_of(s.pieces(), q).map(|k| s.pieces()[k as usize].ground) {
            Some(Ground::Dry) => None,
            g => Some(format!("on {g:?}")),
        }
    })
}

fn report(what: &str, a: &Arm) {
    println!(
        "G5 {what}: rebuilt off the clock in {} us while the clock stepped {} ticks; installed in {} us",
        a.rebuild_us, a.ticks_during, a.install_us
    );
    println!(
        "  {} walks planned on the changed ground, each planned again within {} ms of the commit; {} of {} arrived; {} samples, {} on forbidden ground",
        a.stale,
        a.max_delay / 1000,
        a.arrived,
        LINES.len(),
        a.samples,
        a.bad.len()
    );
}

/// A1 (and A5 on the way): the hill re-routes the walkers within 2 s; its rebuild time is posted.
#[test]
fn a1_a_hill_across_a_route_re_routes_its_walkers_within_2_s() {
    let im = field();
    let e = Edits::of(&im);
    let cells = {
        let copy = e.live.frozen();
        let checked = check(
            Edit {
                intent: id(9),
                actor: Actor::Creator(e.world.creator),
                planned: copy.version(),
                ops: hill_ops(&e, im.nodes["box"], true),
            },
            &copy,
            &e.world,
        )
        .unwrap();
        plan(checked, &copy, Some(e.ground))
            .unwrap()
            .terrain
            .unwrap()
            .cells()
    };
    for repeat in 1..=2 {
        let a = arm(|e, b| hill_ops(e, b, true), steep);
        report(
            &format!("hill ({cells} cells changed), repeat {repeat}"),
            &a,
        );
        assert_eq!(
            a.stale,
            LINES.len(),
            "every walk crossed the field's ground"
        );
        assert!(a.max_delay <= 2_000_000, "A1: planned again within 2 s");
        assert!(
            a.bad.is_empty(),
            "A1: round the hill, never on its flanks: {:?}",
            a.bad
        );
        assert_eq!(
            a.arrived,
            LINES.len(),
            "A1: every walker arrives round the hill (#3473): {:?}",
            a.ended
        );
    }
}

/// #3473: hills of other sizes across the same lines, each with a way round its steep cells: every walker arrives
/// round it, none stopped on a steep cell's corner (`goal-unreachable`).
#[test]
fn a_walker_round_steep_cells_arrives_whatever_the_hill() {
    // (radius m, height mm): A1's hill and those that stopped a walker on a cell's corner.
    for (r, h) in [
        (8.0, 6_000.0),
        (9.0, 6_000.0),
        (8.0, 5_000.0),
        (10.0, 7_000.0),
    ] {
        SHAPE.set(([24.0, 24.0], r, h));
        let a = arm(|e, b| hill_ops(e, b, true), steep);
        report(&format!("hill {r} m by {} m", h / 1000.0), &a);
        assert!(a.bad.is_empty(), "never on the hill's flanks: {:?}", a.bad);
        assert_eq!(
            a.arrived,
            LINES.len(),
            "every walker arrives round a {r} m by {h} mm hill: {:?}",
            a.ended
        );
    }
}

/// A2: a pond dug across the route sends the walkers, who may not wade, round it.
#[test]
fn a2_a_pond_across_a_route_sends_bodies_that_cannot_wade_round_it() {
    for repeat in 1..=2 {
        let a = arm(|e, _| pond_ops(e), wet);
        report(&format!("pond, repeat {repeat}"), &a);
        assert_eq!(a.stale, LINES.len());
        assert!(a.max_delay <= 2_000_000);
        assert!(a.bad.is_empty(), "A2: never in the water: {:?}", a.bad);
        assert_eq!(
            a.arrived,
            LINES.len(),
            "A2: every walker arrives, round the pond"
        );
    }
}

/// A3: refused by name, changing nothing: a Soul standing where the hill goes, a building under it, a thing left
/// where it was, a tile size changed.
#[test]
fn a3_a_terrain_edit_under_a_soul_is_refused_by_name() {
    let im = field();
    let box_id = im.nodes["box"];
    let mut e = Edits::of(&im);
    let v0 = e.live.version();
    let soul = Who {
        soul: id(500),
        body: id(501),
        pose: Pose {
            frame: Frame {
                node: e.ground,
                slot: None,
            },
            position: Vec3::new(20 * M, 0, 22 * M),
            orientation: Quat::IDENTITY,
            support: Support::Surface {
                surface: e.ground,
                height: 0,
            },
        },
        has: HANDS,
        crossing: None,
    };
    let r = e
        .run(hill_ops(&e, box_id, true), &[soul], 1_000)
        .expect_err("under a Soul");
    println!("A3: {}: {}", r.name, r.detail);
    assert_eq!(r.name, UNDER_SOUL);
    assert!(r.detail.contains(&show(soul.soul)), "names the Soul");
    assert_eq!(e.live.version(), v0, "a refusal changes nothing");

    let r = e
        .run(hill_ops(&e, box_id, false), &[], 1_000)
        .expect_err("the box left");
    println!("A3: {}: {}", r.name, r.detail);
    assert_eq!(r.name, UNSETTLED);
    assert!(r.detail.contains(&show(box_id)), "names the thing");

    let size = Op::Set {
        node: Ref::Node(e.ground),
        field: F_TILE_SIZE,
        to: int(32_000),
    };
    let mut ops = hill_ops(&e, box_id, true);
    ops.push(size);
    let r = e.run(ops, &[], 1_000).expect_err("a new tile size");
    println!("A3: {}: {}", r.name, r.detail);
    assert_eq!(r.name, MALFORMED);

    // A building: N2's test world, its open ground given terrain with a hill round the building.
    let w = testworld::generate(1, 0).expect("the test world");
    let tw = import_eden::load(&w.text).expect("the test world loads");
    let mut e = Edits::of(&tw);
    let b = tw.nodes["building"];
    let p = e
        .live
        .tree()
        .node(e.live.tree().handle(b).unwrap())
        .unwrap()
        .place()
        .unwrap();
    let (bx, bz) = (p.position.x / M, p.position.z / M);
    let ops = vec![
        Op::Set {
            node: Ref::Node(e.ground),
            field: F_TILE_SIZE,
            to: int(N * 1000),
        },
        Op::Set {
            node: Ref::Node(e.ground),
            field: F_TILES,
            to: Value::Array(
                [(bx.div_euclid(N), bz.div_euclid(N))]
                    .iter()
                    .map(|&(tx, tz)| {
                        let (h, c) = tile(tx, tz, &|i, j| {
                            if (i - bx).abs() + (j - bz).abs() < 4 {
                                500
                            } else {
                                0
                            }
                        });
                        Value::Array(vec![int(tx), int(tz), Value::Bytes(h), Value::Bytes(c)])
                    })
                    .collect(),
            ),
        },
    ];
    let r = e.run(ops, &[], 1_000).expect_err("under a building");
    println!("A3: {}: {}", r.name, r.detail);
    assert_eq!(r.name, UNDER_BUILDING);
    assert!(r.detail.contains(&show(b)), "names the building");
    println!("A3: the edits a terrain edit refuses: {REFUSED:?}");
}

/// A5: the raised ground lifts the resting box by a pose change written in the batch.
#[test]
fn a5_raised_ground_lifts_resting_things_by_a_pose_change_in_the_batch() {
    let im = field();
    let box_id = im.nodes["box"];
    let mut e = Edits::of(&im);
    let y0 = e.y_of(box_id);
    let rise = hill(BOX[0], BOX[1]) * 1000;
    assert!(rise > 0, "the box rests on the hill's flank");
    let done = e
        .run(hill_ops(&e, box_id, true), &[], 1_000)
        .expect("committed");
    let moves: Vec<_> = done
        .part
        .effects
        .iter()
        .flat_map(|ef| match &ef.body {
            replica::effects::Body::Changes(c) => c.iter().map(|r| &r.change).collect(),
            _ => Vec::new(),
        })
        .filter_map(|c| match c {
            replica::effects::Change::Reparent { node, pose, .. } if *node == box_id => {
                Some(pose.position.y)
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        moves,
        [y0 + rise],
        "A5: the batch writes the box's new pose"
    );
    assert_eq!(
        e.y_of(box_id),
        y0 + rise,
        "A5: the box stands on the raised ground"
    );
    let t = Terrain::of(e.live.tree(), e.ground).unwrap().unwrap();
    assert_eq!(t.height_at(BOX[0] * M, BOX[1] * M), Some(rise));
    println!(
        "A5: the box lifted from {y0} to {} µm by its move in the batch",
        y0 + rise
    );
}
