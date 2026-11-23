//! B9's checks (#2741), on Eden: two scripted Souls lift a 2 m board, carry it 100 m across the open ground straight
//! through one door and set it down inside (A1); the board's track is read back from the log and never overlaps fixed
//! geometry (A2); a route that turns into the same door is refused by name before the lift, with nothing written
//! (A3); the carry is E23's group, its board the activity node's child and its carriers linked to it (A4).
//!
//! They need N1's exported Eden facts (`node v2/tools/import-eden/export/export.ts` from the repository root) and run
//! with `cargo test -p sim --release carry -- --ignored --nocapture`. With `CARRY_TRACE=<file>` the carry is also
//! written as a bird's-eye trace (V14's `v2/tools/birdseye/view.html`): the two carriers, then ten dots along the
//! board, with the fixed geometry near the route as outlines.

use std::collections::BTreeMap;
use std::io::Write;

use replica::activity::{ActivityKind, MEMBER};
use replica::bodies::{Class, Family, Resource};
use replica::effects::{
    Actor, Body as EffectBody, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest,
    schema_hash,
};
use replica::encode::{Name, Value, encode};
use replica::group::Scene as Groups;
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::time::Micros;
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, Kind};

use super::{Carry, Fixed, HALF_LENGTH, HALF_WIDTH, Quad, SPAN, group, sweep};
use crate::activity::{Activities, Ask};
use crate::ground::scene::{Xform, Xz, xform_to};
use crate::host::Runner;
use crate::links::{Doors, Kind as LinkKind};
use crate::mover::Body;
use crate::walk::World as _;
use crate::walk::town::Town;

const TICK: Micros = 50_000;
const SPEED: i64 = 1_400_000;
/// The carry's length on the open ground before the door, µm: with the door and the way in, just over 100 m.
const OUTSIDE: i64 = 97_000_000;
/// How far in past the door's far end the leader sets down, µm.
const INSIDE: i64 = 3_200_000;
const ACTIVITY: &str =
    "souls:carry@12200000000000000000000000000000000000000000000000000000000000000b91";
const BOARD: &str =
    "souls:board@12200000000000000000000000000000000000000000000000000000000000000b92";
const WALKER: &str =
    "souls:walker@12200000000000000000000000000000000000000000000000000000000000000b93";

fn n(s: &str) -> Name {
    Name::new(s).expect("a name")
}

fn humanoid() -> Family {
    let r = |s: &str, class| Resource {
        name: n(s),
        class,
        slot: None,
    };
    Family {
        name: n("souls:humanoid"),
        resources: vec![
            r("souls:leg-left", Class::Locomotion),
            r("souls:leg-right", Class::Locomotion),
        ],
    }
}

/// The carry: two roles, front and back, each holding its body's legs.
fn carry_kind() -> ActivityKind {
    let role = |r: &str| {
        Value::Map(BTreeMap::from([
            (1, Value::Text(n(r))),
            (2, Value::Text(n(&format!("{r}-place")))),
            (
                3,
                Value::Array(vec![Value::Map(BTreeMap::from([
                    (1, Value::Uint(1)),
                    (2, Value::Uint(1)),
                ]))]),
            ),
        ]))
    };
    ActivityKind::from_value(&Value::Map(BTreeMap::from([
        (1, Value::Text(n(ACTIVITY))),
        (2, Value::Uint(1)),
        (
            3,
            Value::Array(vec![role("souls:carry-front"), role("souls:carry-back")]),
        ),
        (4, Value::Uint(60_000_000)),
        (5, Value::Uint(400_000)),
    ])))
    .expect("the carry kind")
}

fn header(root: Id) -> Header {
    let kinds = [ACTIVITY, BOARD, WALKER]
        .iter()
        .map(|k| Value::Text(n(k)))
        .collect();
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/b9-carry/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(root.scope().0.to_vec())),
        (4, root.to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(kinds)),
        (7, Value::Array(Vec::new())),
    ]));
    Header::read(&encode(&v).expect("bytes")).expect("a header")
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

/// Eden with the carry's kinds: the ground admits carriers, boards and the carry; the carry's slot admits a thing.
fn eden(souls: &[Id]) -> (Tree, Rules, Id, Id) {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    let text = std::fs::read_to_string(path).expect("run the exporter first");
    let im = import_eden::load(&text).expect("Eden loads");
    let (tree, mut rules) = (im.tree, im.rules);
    let ground = im.nodes["ground"];
    let root = im.nodes["world"];
    let gk = tree
        .node(tree.handle(ground).expect("the ground"))
        .expect("the ground")
        .kind()
        .as_str()
        .to_owned();
    let g = rules.kinds.get_mut(&gk).expect("the ground's kind");
    for k in [ACTIVITY, BOARD, WALKER] {
        g.children
            .insert(k.split('@').next().unwrap_or(k).to_owned());
    }
    // A floor takes a board set down on it.
    for (k, v) in rules.kinds.iter_mut() {
        if k.starts_with("eden:floor@") {
            v.children
                .insert(BOARD.split('@').next().unwrap_or(BOARD).to_owned());
        }
    }
    let kind =
        |owner: &str, slots: BTreeMap<u64, std::collections::BTreeSet<String>>, hands| Kind {
            owner: owner.into(),
            children: Default::default(),
            slots,
            hands,
        };
    rules.kinds.insert(
        ACTIVITY.to_owned(),
        kind(
            "activity",
            BTreeMap::from([(super::SLOT, ["thing".to_owned()].into())]),
            None,
        ),
    );
    rules
        .kinds
        .insert(BOARD.to_owned(), kind("thing", BTreeMap::new(), Some(2)));
    rules
        .kinds
        .insert(WALKER.to_owned(), kind("family", BTreeMap::new(), None));
    rules.souls.extend(souls.iter().copied());
    (tree, rules, ground, root)
}

/// A door between the open ground and a building's lowest floor: its link, the floor, the ends' middles on the open
/// ground's plan (outside, inside) and the floor's frame.
struct Door {
    link: Id,
    floor: Id,
    out: Vec3,
    inside: Vec3,
    frame: Xform,
    width: i64,
}

fn xz(v: Vec3) -> Xz {
    [v.x, v.z]
}

fn along(from: Vec3, d: Xz, by: i64) -> Vec3 {
    let l = (i128::from(d[0]).pow(2) + i128::from(d[1]).pow(2)).isqrt() as i64;
    Vec3::new(
        from.x + (i128::from(d[0]) * i128::from(by) / i128::from(l)) as i64,
        from.y,
        from.z + (i128::from(d[1]) * i128::from(by) / i128::from(l)) as i64,
    )
}

fn doors(t: &Town) -> Vec<Door> {
    let gh = t.tree.handle(t.ground).expect("the ground");
    let mut out = Vec::new();
    for b in &t.buildings {
        for l in &b.links {
            if l.kind != LinkKind::Doorway || l.blocked.is_some() {
                continue;
            }
            let [Some(e0), Some(e1)] = l.ends else {
                continue;
            };
            let (g, f) = match (e0.floor == t.ground, e1.floor == t.ground) {
                (true, false) => (e0, e1),
                (false, true) => (e1, e0),
                _ => continue,
            };
            let Some(fh) = t.tree.handle(f.floor) else {
                continue;
            };
            let Ok(frame) = xform_to(&t.tree, fh, gh) else {
                continue;
            };
            let Ok(inside) = frame.point(f.middle()) else {
                continue;
            };
            out.push(Door {
                link: l.id,
                floor: f.floor,
                out: g.middle(),
                inside,
                frame,
                width: l.width,
            });
        }
    }
    out
}

/// The way straight through `d`: from `OUTSIDE` out, through the door, to `INSIDE` in, the follower `SPAN` behind.
fn straight(d: &Door) -> Vec<Xz> {
    let u = [d.inside.x - d.out.x, d.inside.z - d.out.z];
    let start = along(d.out, u, -OUTSIDE);
    vec![
        xz(along(start, u, -SPAN)),
        xz(start),
        xz(d.out),
        xz(d.inside),
        xz(along(d.inside, u, INSIDE)),
    ]
}

/// Whether every metre of the way outside is open ground a body stands on.
fn walkable(t: &Town, path: &[Xz]) -> bool {
    let (a, b) = (path[0], path[2]);
    let l = (i128::from(b[0] - a[0]).pow(2) + i128::from(b[1] - a[1]).pow(2)).isqrt() as i64;
    (0..=l / 1_000_000).all(|k| {
        let p = [
            a[0] + ((b[0] - a[0]) as i128 * i128::from(k) * 1_000_000 / i128::from(l)) as i64,
            a[1] + ((b[1] - a[1]) as i128 * i128::from(k) * 1_000_000 / i128::from(l)) as i64,
        ];
        t.surfaces[&t.ground]
            .place(
                Id::new(Scope([1; 16]), 1).expect("an id"),
                Frame {
                    node: t.ground,
                    slot: None,
                },
                Vec3::new(p[0], 0, p[1]),
                Quat::IDENTITY,
            )
            .is_ok()
    })
}

struct Setup {
    town: Town,
    fixed: Fixed,
    door: Door,
    header: Header,
    rules: Rules,
    souls: [Id; 2],
    bodies: [Id; 2],
    board: Id,
    mint: Minter,
}

fn setup() -> Setup {
    let mut mint = Minter::new(Scope([0xb9; 16]));
    let mut id = || mint.mint().expect("an id");
    let souls = [id(), id()];
    let bodies = [id(), id()];
    let board = id();
    let (tree, rules, ground, root) = eden(&souls);
    let header = header(root);
    let next = tree.next();
    let town = Town::new(
        tree,
        ground,
        Doors::new(header.clone(), rules.clone(), next),
    )
    .expect("the town");
    let fixed = Fixed::of(&town.tree, ground).expect("the fixed geometry");
    // Step 0: the first door, in the town's order, whose straight way passes the sweep and is open ground throughout.
    let all = doors(&town);
    let mut passed = 0;
    let mut door = None;
    let mut widths = Vec::new();
    let doors_n = all.len();
    for d in all {
        let p = straight(&d);
        if sweep(&p, &fixed).is_ok() && walkable(&town, &p) {
            passed += 1;
            widths.push(d.width / 1000);
            if door.as_ref().is_none_or(|b: &Door| d.width < b.width) {
                door = Some(d);
            }
        }
    }
    let door = door.expect("a door in Eden passed straight");
    println!(
        "step 0: {} fixed boxes; of {doors_n} doors between the open ground and a lowest floor, {passed} are passed straight for {} m (widths {widths:?} mm); the narrowest: link {}, {} mm wide, out ({}, {}) mm",
        fixed.quads.len(),
        (OUTSIDE + INSIDE) / 1_000_000,
        door.link.counter(),
        door.width / 1000,
        door.out.x / 1000,
        door.out.z / 1000
    );
    Setup {
        town,
        fixed,
        door,
        header,
        rules,
        souls,
        bodies,
        board,
        mint,
    }
}

impl Setup {
    /// The carriers' and the board's nodes on the open ground, written by the world: the carriers at `front` and
    /// `back`, the board at rest between them.
    fn place(&mut self, front: Vec3, back: Vec3) {
        let ground = self.town.ground;
        let on = |p: Vec3| Pose {
            frame: Frame {
                node: ground,
                slot: None,
            },
            position: p,
            orientation: Quat::IDENTITY,
            support: Support::Surface {
                surface: ground,
                height: 0,
            },
        };
        let mid = Vec3::new((front.x + back.x) / 2, 0, (front.z + back.z) / 2);
        let create = |node, kind: &str, at| ChangeRec {
            change: Change::Create {
                node,
                kind: n(kind),
                pose: on(at),
                audience: Audience::Everyone,
                fields: BTreeMap::new(),
            },
            rest: Rest::new(),
        };
        let e = Effect {
            envelope: Envelope {
                sequence: self.town.tree.next(),
                at: 0,
                cause: Cause::World,
                actor: Actor::World,
                audience: Audience::Everyone,
                node: ground,
            },
            body: EffectBody::Changes(vec![
                create(self.bodies[0], WALKER, front),
                create(self.bodies[1], WALKER, back),
                create(self.board, BOARD, mid),
            ]),
            events: None,
            rest: Rest::new(),
        };
        self.town
            .tree
            .commit(&self.header, &part(&self.header, &[e]), &self.rules)
            .expect("the carriers and the board");
    }
}

fn ask(mint: &mut Minter, soul: Id, at: Micros) -> Ask {
    Ask {
        soul,
        intent: mint.mint().expect("an intent"),
        at,
    }
}

/// The board's outline from one sample of the frame: its centre and turn (the board rides at the frame's origin).
fn outline(c: Vec3, q: Quat) -> Quad {
    let r = |x, z| {
        let v = q.rotate(Vec3::new(x, 0, z)).expect("a turn");
        [c.x + v.x, c.z + v.z]
    };
    [
        r(HALF_LENGTH, HALF_WIDTH),
        r(HALF_LENGTH, -HALF_WIDTH),
        r(-HALF_LENGTH, -HALF_WIDTH),
        r(-HALF_LENGTH, HALF_WIDTH),
    ]
}

#[test]
#[ignore = "needs the exported Eden facts file"]
fn a1_a2_a4_two_souls_carry_a_board_100_m_through_a_door() {
    let mut s = setup();
    let ground = s.town.ground;
    let path = straight(&s.door);
    let (back, front) = (path[0], path[1]);
    let terrain = |p: Xz| {
        s.town.surfaces[&ground]
            .place(
                s.bodies[0],
                Frame {
                    node: ground,
                    slot: None,
                },
                Vec3::new(p[0], 0, p[1]),
                Quat::IDENTITY,
            )
            .expect("on the ground")
    };
    let (lb, fb): (Body, Body) = (
        terrain(front),
        Body {
            id: s.bodies[1],
            ..terrain(back)
        },
    );
    s.place(lb.pose.position, fb.pose.position);

    // B5: the leader's Soul proposes the carry, both join it.
    let next = s.town.tree.next();
    let mut acts = Activities::new(s.header.clone(), s.rules.clone(), next, vec![carry_kind()]);
    let a = ask(&mut s.mint, s.souls[0], 0);
    let activity = acts
        .propose(&mut s.town.tree, &mut s.mint, a, &n(ACTIVITY), ground)
        .expect("proposed");
    for (k, role) in [(0, "souls:carry-front"), (1, "souls:carry-back")] {
        acts.next = s.town.tree.next();
        let a = ask(&mut s.mint, s.souls[k], 0);
        acts.join(
            &mut s.town.tree,
            &mut s.mint,
            a,
            s.bodies[k],
            activity,
            &n(role),
            1,
        )
        .expect("joined");
    }

    // Before the lift: the sweep along the whole route.
    let poses = sweep(&path, &s.fixed).expect("the straight way passes");
    println!("sweep: {poses} poses of the board along the route, none clips");

    let mut carry = Carry::new(
        activity,
        s.board,
        ground,
        Audience::Everyone,
        s.header.clone(),
        s.rules.clone(),
    );
    let lift = s.mint.mint().expect("an id");
    carry
        .lift(
            &mut s.town.tree,
            0,
            lb.pose.position,
            fb.pose.position,
            lift,
        )
        .expect("lifted");

    // A4: E23's group read from the tree, and its check.
    let parent = |t: &Tree, id: Id| {
        t.node(t.handle(id).expect("live"))
            .and_then(|n| n.parent())
            .expect("a parent")
    };
    let g = group(activity, s.board, s.bodies[0], s.bodies[1]);
    let scene = Groups {
        parents: [activity, s.board, s.bodies[0], s.bodies[1]]
            .into_iter()
            .map(|i| (i, parent(&s.town.tree, i)))
            .collect(),
        groups: vec![g],
    };
    scene.check().expect("E23's check");
    assert_eq!(parent(&s.town.tree, s.board), activity);
    let links: Vec<Id> = acts
        .members(activity)
        .expect("live")
        .iter()
        .map(|m| m.body)
        .collect();
    assert_eq!(links, s.bodies.to_vec());
    println!(
        "A4: the board {} is the child of the carry's node {}; carriers {} and {} are linked to it ({MEMBER}); E23's check passes, steered by {}",
        s.board.counter(),
        activity.counter(),
        s.bodies[0].counter(),
        s.bodies[1].counter(),
        scene.groups[0].steerer().expect("one steerer")
    );

    // The walk: each carrier its own ordinary route, the follower to SPAN short of the leader's goal.
    let goal = s.door.frame;
    let to = |p: Xz| {
        crate::links::back(&goal, Vec3::new(p[0], s.door.inside.y, p[1]))
            .expect("in the floor's frame")
    };
    let u = [path[4][0] - path[3][0], path[4][1] - path[3][1]];
    let lead_goal = to(path[4]);
    let follow_goal = to(xz(along(Vec3::new(path[4][0], 0, path[4][1]), u, -SPAN)));
    let mut r = Runner::new(TICK);
    for (b, g) in [(lb, lead_goal), (fb, follow_goal)] {
        let legs = s.town.plan(&b, s.door.floor, g).expect("planned");
        assert!(
            legs.iter().any(|l| l.link == Some(s.door.link)),
            "the route goes through the door"
        );
        let legs = legs
            .iter()
            .map(|l| skills::route::Leg {
                to: l.to,
                link: l.link,
            })
            .collect();
        r.add(
            humanoid(),
            b,
            Box::new(skills::route::Route::new(legs, SPEED, TICK)),
        )
        .expect("walking");
    }
    let gh = s.town.tree.handle(ground).expect("the ground");
    let on_plan = |t: &Tree, b: &Body| -> Vec3 {
        if b.pose.frame.node == ground {
            return b.pose.position;
        }
        let h = t.handle(b.pose.frame.node).expect("live");
        xform_to(t, h, gh)
            .expect("a frame")
            .point(b.pose.position)
            .expect("a point")
    };
    let mut walked = 0i64;
    let mut last = lb.pose.position;
    let mut grips: Vec<(Xz, Xz)> = Vec::new();
    let mut tick = 0;
    while !r.runs.is_empty() {
        tick += 1;
        assert!(tick < 4_000, "the carry ends within 200 s");
        s.town.doors.next = s.town.tree.next();
        r.tick(&mut s.town)
            .unwrap_or_else(|e| panic!("tick {tick}: {}: {}", e.name, e.detail));
        let f = on_plan(
            &s.town.tree,
            r.controller.body(s.bodies[0]).expect("leader"),
        );
        let b = on_plan(
            &s.town.tree,
            r.controller.body(s.bodies[1]).expect("follower"),
        );
        walked +=
            (i128::from(f.x - last.x).pow(2) + i128::from(f.z - last.z).pow(2)).isqrt() as i64;
        last = f;
        grips.push((xz(f), xz(b)));
        carry
            .step(&mut s.town.tree, tick * TICK, f, b)
            .unwrap_or_else(|e| panic!("tick {tick}: {}: {}", e.name, e.detail));
    }
    let (lf, ff) = (
        *r.controller.body(s.bodies[0]).expect("leader"),
        *r.controller.body(s.bodies[1]).expect("follower"),
    );
    assert_eq!(lf.pose.frame.node, s.door.floor, "the leader is inside");
    assert_eq!(ff.pose.frame.node, s.door.floor, "the follower is inside");
    let down = s.mint.mint().expect("an id");
    carry
        .set_down(
            &mut s.town.tree,
            (tick + 1) * TICK,
            s.door.floor,
            lf.pose.position,
            ff.pose.position,
            down,
        )
        .expect("set down");
    assert_eq!(parent(&s.town.tree, s.board), s.door.floor);
    let spans: Vec<i64> = grips
        .iter()
        .map(|(f, b)| {
            (i128::from(f[0] - b[0]).pow(2) + i128::from(f[1] - b[1]).pow(2)).isqrt() as i64
        })
        .collect();
    println!(
        "A1: lifted at 0 s, carried {} ticks ({:.1} s): the leader walked {} mm, through door link {} ({} mm wide), and set the board down on floor {} at {:.1} s; carriers {} to {} mm apart (the places say {} mm)",
        tick,
        tick as f64 * TICK as f64 / 1e6,
        walked / 1000,
        s.door.link.counter(),
        s.door.width / 1000,
        s.door.floor.counter(),
        (tick + 1) as f64 * TICK as f64 / 1e6,
        spans.iter().min().expect("ticks") / 1000,
        spans.iter().max().expect("ticks") / 1000,
        SPAN / 1000,
    );
    assert!(walked >= 99_000_000, "100 m carried");

    // A2: the board's track, read back from the log, against the fixed geometry.
    let mut samples = 0;
    let mut clips = Vec::new();
    for e in carry.log.parts.iter().flatten() {
        let EffectBody::Changes(cs) = &e.body else {
            continue;
        };
        for c in cs {
            if let Change::Motion(h) = &c.change
                && h.node == activity
            {
                samples += 1;
                let q = outline(h.pose.position, h.pose.orientation);
                if s.fixed.hit(&q).is_some() {
                    clips.push(h.at);
                }
            }
        }
    }
    println!(
        "A2: the board's track in the log: {samples} samples of the carry's node, {} overlap fixed geometry",
        clips.len()
    );
    assert_eq!(samples, tick as usize + 1);
    assert!(clips.is_empty(), "the board overlaps at {clips:?}");

    if let Ok(out) = std::env::var("CARRY_TRACE") {
        let mut walkers = vec![(xz(lb.pose.position), xz(fb.pose.position))];
        walkers.extend(grips.iter().copied());
        trace(&out, &s.fixed, &path, &carry, &walkers);
        println!("trace written: {} ticks", carry.track.len());
    }
}

#[test]
#[ignore = "needs the exported Eden facts file"]
fn a3_a_route_that_turns_into_the_door_is_refused_before_the_lift() {
    let s = setup();
    let d = &s.door;
    let u = [d.inside.x - d.out.x, d.inside.z - d.out.z];
    // Along the wall, 4 m to the side and 0.6 m out, then a right angle into the door.
    let side = [-u[1], u[0]];
    let start = along(along(d.out, side, 4_000_000), u, -600_000);
    let path = vec![
        xz(along(start, side, SPAN)),
        xz(start),
        xz(d.out),
        xz(d.inside),
        xz(along(d.inside, u, INSIDE)),
    ];
    let before = s.town.tree.next();
    let r = sweep(&path, &s.fixed).expect_err("refused");
    println!("A3: {}: {}", r.name, r.detail);
    assert_eq!(r.name, "carry-board-clips");
    assert_eq!(s.town.tree.next(), before, "nothing written");
}

/// The carry as V14's bird's-eye trace: the two carriers, then ten dots along the board, a tick a row, relative to
/// the route's middle; the fixed boxes near the route as outlines.
fn trace(out: &str, fixed: &Fixed, path: &[Xz], carry: &Carry, walkers: &[(Xz, Xz)]) {
    let b = path
        .iter()
        .fold([i64::MAX, i64::MAX, i64::MIN, i64::MIN], |b, p| {
            [
                b[0].min(p[0]),
                b[1].min(p[1]),
                b[2].max(p[0]),
                b[3].max(p[1]),
            ]
        });
    let o = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    let cm = |p: Xz| [(p[0] - o[0]) / 10_000, (p[1] - o[1]) / 10_000];
    let near = fixed.within([
        b[0] - 8_000_000,
        b[1] - 8_000_000,
        b[2] + 8_000_000,
        b[3] + 8_000_000,
    ]);
    let outlines: Vec<String> = near
        .iter()
        .map(|q| {
            let pts: Vec<String> = q
                .iter()
                .map(|p| {
                    let c = cm(*p);
                    format!("[{},{}]", c[0], c[1])
                })
                .collect();
            format!(
                "{{\"floor\":0,\"kind\":\"room\",\"pts\":[{}]}}",
                pts.join(",")
            )
        })
        .collect();
    // Twelve bodies: a row's offsets must be even for the view's 16-bit arrays.
    let n = 12;
    let head = format!(
        "{{\"format\":\"birdseye/0\",\"note\":\"B9's carry: two carriers, then ten dots along the board\",\"tick_us\":{TICK},\"ticks\":{},\"bodies\":{n},\"unit\":\"cm\",\"step_cm\":{},\"floors\":[0],\"nodes\":[{{\"name\":\"Eden\",\"floor\":0}}],\"outlines\":[{}]}}",
        carry.track.len(),
        SPEED * TICK / 1_000_000 / 10_000,
        outlines.join(",")
    );
    let mut file = std::io::BufWriter::new(std::fs::File::create(out).expect("the trace file"));
    file.write_all(&(head.len() as u32).to_le_bytes()).unwrap();
    file.write_all(head.as_bytes()).unwrap();
    file.write_all(&vec![0u8; (4 - (4 + head.len()) % 4) % 4])
        .unwrap();
    let on_board = |q: Quat, c: Vec3, x: i64| {
        let v = q.rotate(Vec3::new(x, 0, 0)).expect("a turn");
        [c.x + v.x, c.z + v.z]
    };
    for ((_, c, q), (f, b)) in carry.track.iter().zip(walkers) {
        let mut pts = vec![*f, *b];
        for k in 0..10 {
            pts.push(on_board(*q, *c, -HALF_LENGTH + k * 2 * HALF_LENGTH / 9));
        }
        let mut row = vec![0u8; 5 * n];
        for (k, p) in pts.iter().enumerate() {
            let p = cm(*p);
            row[2 * k..2 * k + 2].copy_from_slice(&(p[0] as i16).to_le_bytes());
            row[2 * n + 2 * k..2 * n + 2 * k + 2].copy_from_slice(&(p[1] as i16).to_le_bytes());
        }
        file.write_all(&row).unwrap();
    }
    file.flush().unwrap();
}

/// 0.135 C2: a load read from its kind's entry, and its checks before the lift.
mod from_entry {
    use replica::rules::json::parse;

    use super::super::{Fixed, GRIP_REACH, Load, REACH};

    const M: i64 = 1_000_000;

    fn entry(path: &str) -> replica::rules::json::Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../content/kinds/construction");
        parse(&std::fs::read_to_string(root.join(path)).expect("the entry")).expect("json")
    }

    #[test]
    fn c2_the_beam_and_the_upright_as_their_entries_state() {
        let beam = Load::of(&entry("rack_beam.json")).expect("the beam");
        assert_eq!(
            beam,
            Load {
                half_length: 1_371_500,
                half_width: 51_000,
                grips: [-1_097_000, 1_097_000],
                crew: 2,
                ..beam
            }
        );
        let upright = Load::of(&entry("rack_upright.json")).expect("the upright");
        assert_eq!(
            upright,
            Load {
                half_length: 1_219_000,
                half_width: 609_500,
                grips: [-780_000, 780_000],
                crew: 1,
                ..upright
            }
        );
        assert_eq!(upright.places(), [-780_000 - REACH, 780_000 + REACH]);
    }

    /// 0.135 C4: held in the carry's slot, each load's long axis runs along the carry's +x, from the back carrier to
    /// the front (the beam's z, the upright's y), the beam on its edge and the upright flat, its middle at the slot's origin;
    /// set down between carriers facing +z, it lies the same way, its middle between them and its lowest side on the
    /// floor. B9's board is held as before.
    #[test]
    fn c4_a_load_is_held_and_set_down_lengthwise_between_its_carriers() {
        use replica::pose::{Quat, Vec3};
        let near = |a: Vec3, b: Vec3| {
            (a.x - b.x).abs() <= 2 && (a.y - b.y).abs() <= 2 && (a.z - b.z).abs() <= 2
        };
        // Each load's long axis, the side that lies across, and the side that stands up, from its middle, µm: the
        // beam stays on its edge, the upright is laid flat.
        for (name, file, long, wide, thin) in [
            (
                "beam",
                "rack_beam.json",
                Vec3::new(0, 0, 1_371_500),
                Vec3::new(25_500, 0, 0),
                Vec3::new(0, 51_000, 0),
            ),
            (
                "upright",
                "rack_upright.json",
                Vec3::new(0, 1_219_000, 0),
                Vec3::new(609_500, 0, 0),
                Vec3::new(0, 0, 38_000),
            ),
        ] {
            let load = Load::of(&entry(file)).unwrap();
            let (at, q) = load.held().unwrap();
            // Its long axis's end, from its middle, turned: along the carry's +x, by half its length.
            let end = q.rotate(long).unwrap();
            assert!(
                near(end, Vec3::new(load.half_length, 0, 0)),
                "{name}: its length runs between the carriers: {end:?}"
            );
            let across = q.rotate(wide).unwrap();
            assert!(
                across.y.abs() <= 2 && across.x.abs() <= 2,
                "{name}: its wider side lies across: {across:?}"
            );
            let up = q.rotate(thin).unwrap();
            assert!(
                up.x.abs() <= 2 && up.z.abs() <= 2,
                "{name}: its thinnest side stands up: {up:?}"
            );
            let middle = q.rotate(load.middle).unwrap();
            assert!(
                near(
                    Vec3::new(at.x + middle.x, at.y + middle.y, at.z + middle.z),
                    Vec3::ZERO
                ),
                "{name}: its middle at the slot's origin"
            );
            // Set down between carriers that face +z (the carry's +x turned a quarter turn).
            let facing = Quat::from_yaw_mdeg(-90_000).unwrap();
            assert!(near(
                facing.rotate(Vec3::new(1_000_000, 0, 0)).unwrap(),
                Vec3::new(0, 0, 1_000_000)
            ));
            let c = Vec3::new(5 * M, 0, -3 * M);
            let (p, o) = load.resting(c, facing).unwrap();
            let m = o.rotate(load.middle).unwrap();
            assert!(
                near(
                    Vec3::new(p.x + m.x, p.y + m.y, p.z + m.z),
                    Vec3::new(c.x, up.y.abs(), c.z)
                ),
                "{name}: its middle between the carriers, its lowest side on the floor"
            );
            let end = o.rotate(long).unwrap();
            assert!(
                near(end, Vec3::new(0, 0, load.half_length)),
                "{name}: set down lengthwise along the way they faced: {end:?}"
            );
        }
        let board = Load::board();
        assert_eq!(board.held().unwrap(), (Vec3::ZERO, Quat::IDENTITY));
        let q = Quat::from_yaw_mdeg(30_000).unwrap();
        assert_eq!(
            board.resting(Vec3::new(1, 2, 3), q).unwrap(),
            (Vec3::new(1, 2, 3), q)
        );
    }

    /// Two walls with a 0.9 m passage between them, across a straight way east: the upright (1.22 m wide) is refused
    /// `carry-board-clips` before the lift and the beam (0.1 m) is not; a crew of one and a carrier off its grip are
    /// refused by name.
    #[test]
    fn c2_a_passage_a_crew_and_a_grip_refused_before_the_lift() {
        let wall = |z0: i64, z1: i64| {
            [
                [10 * M, z0],
                [10 * M + 200_000, z0],
                [10 * M + 200_000, z1],
                [10 * M, z1],
            ]
        };
        let fixed = Fixed::new(vec![wall(450_000, 3 * M), wall(-3 * M, -450_000)]);
        for (name, load, ok) in [
            (
                "upright",
                Load::of(&entry("rack_upright.json")).unwrap(),
                false,
            ),
            ("beam", Load::of(&entry("rack_beam.json")).unwrap(), true),
        ] {
            let [b, f] = load.places();
            let r = load.check(2, [f, 0], [b, 0], [0, 0], Some(([20 * M, 0], &fixed)));
            match ok {
                true => assert!(r.is_ok(), "{name}: {r:?}"),
                false => assert_eq!(r.map_err(|e| e.name), Err("carry-board-clips"), "{name}"),
            }
        }
        let beam = Load::of(&entry("rack_beam.json")).unwrap();
        let [b, f] = beam.places();
        let crew = beam.check(1, [f, 0], [b, 0], [0, 0], None);
        assert_eq!(crew.map_err(|e| e.name), Err("carry-crew-too-small"));
        let off = beam.check(2, [f + GRIP_REACH + 400_000, 0], [b, 0], [0, 0], None);
        assert_eq!(off.map_err(|e| e.name), Err("carry-grip-out-of-reach"));
    }
}
