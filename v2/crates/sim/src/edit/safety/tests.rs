//! The safety rule's fixtures (G2, #2761) on N2's test world (`v2/tools/testworld`), no things scattered: each test
//! builds what it needs as boxes, and prints each refusal's text (`cargo test -p sim --lib safety -- --nocapture`).
//!
//! The building, in its own frame (mm): floor 1 at 3 m; the landing (r1a) west of x = -2 m; the 0.9 m door "narrow"
//! at (-2000, 0) into the corridor (x -1.9 to 4.1 m, z ±0.45 m); the corridor's door "to-b" at (1000, -550) into the
//! south room above (r1b), whose only door it is. The square: 60 m round the origin, its 16 m squares' lines at x and
//! z = 0 and ±16 m.

use super::{Guard, Known, Who, check, check_on, guard, guard_on};
use crate::ground::exits;
use crate::ground::scene::{F_SLOTS, F_SOLIDS};
use crate::ground::{HUMAN_RADIUS, Scene, Turn, cut_floor};
use crate::links::{Building, Doors, F_STAIRS, Kind};
use crate::routes::{CLIMB, HANDS};
use crate::walk::town::Town;
use replica::edit::{BURIES, CUTS_OFF, IN_USE, Unsafe, Use};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, TransferRec,
    schema_hash,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::tree::{Rules, Tree};
use replica::world_model::Audience;
use std::collections::BTreeMap;

const MM: i64 = 1_000;
const M: i64 = 1_000_000;
const FLOOR_1: i64 = 3_000 * MM;

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

/// A box's one solid, mm in its own frame: centre, half lengths, height span.
fn solid(cx: i64, cz: i64, hx: i64, hz: i64, y1: i64) -> [i64; 9] {
    [cx, cz, hx, hz, 0, 0, y1, 5, 0]
}

struct W {
    tree: Tree,
    header: Header,
    kind: Name,
    ground: Id,
    floor1: Id,
    floor0: Id,
    building: Id,
    next: u64,
    minted: u64,
    rules: Rules,
}

fn world() -> W {
    let w = testworld::generate(1, 0).expect("the test world");
    let imp = import_eden::load(&w.text).expect("the test world loads");
    let root = imp.nodes["world"];
    let kind = Name::new(&imp.kinds["testworld-box@1"]).expect("the box's kind");
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/safety-test/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(root.scope().0.to_vec())),
        (4, root.to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(vec![Value::Text(kind.clone())])),
        (7, Value::Array(Vec::new())),
    ]));
    let header = Header::read(&encode(&v).unwrap()).unwrap();
    let next = imp.tree.to_state().next;
    W {
        header,
        kind,
        ground: imp.nodes["ground"],
        floor1: imp.nodes["building/floor-1"],
        floor0: imp.nodes["building/floor-0"],
        building: imp.nodes["building"],
        tree: imp.tree,
        next,
        minted: 5_000,
        rules: imp.rules,
    }
}

fn on(node: Id, at: Vec3, support: Support) -> Pose {
    Pose {
        frame: Frame { node, slot: None },
        position: at,
        orientation: Quat::IDENTITY,
        support,
    }
}

fn in_slot(node: Id, slot: u64) -> Pose {
    Pose {
        frame: Frame {
            node,
            slot: Some(slot),
        },
        position: Vec3::ZERO,
        orientation: Quat::IDENTITY,
        support: Support::Slot,
    }
}

fn surface(node: Id) -> Support {
    Support::Surface {
        surface: node,
        height: 0,
    }
}

/// A Soul `n` standing on `node` at `at` (µm), with hands and climbing.
fn standing(n: u64, node: Id, at: Vec3) -> Who {
    Who {
        soul: id(100 + n),
        body: id(200 + n),
        pose: on(node, at, surface(node)),
        has: HANDS | CLIMB,
        crossing: None,
    }
}

impl W {
    /// The part of `changes`, one effect each, by `actor`, numbered from the zone's next sequence.
    fn part(&self, actor: Actor, changes: Vec<Change>) -> Part {
        let bodies = changes
            .into_iter()
            .map(|change| {
                // Each effect written by its own node (T6 rule 6): a create by its parent.
                let node = match &change {
                    Change::Create { pose, .. } => pose.frame.node,
                    Change::Remove { node }
                    | Change::Reparent { node, .. }
                    | Change::Set { node, .. } => *node,
                    _ => self.ground,
                };
                let rec = ChangeRec {
                    change,
                    rest: Rest::new(),
                };
                (node, Body::Changes(vec![rec]))
            })
            .collect();
        self.part_of(actor, bodies)
    }

    /// A set-down: `node` crosses from the slot that holds it to `pose`, as T1's leave and arrive in one zone.
    fn set_down(&self, actor: Actor, node: Id, pose: Pose) -> Part {
        let transfer = id(9_100);
        let leave = TransferRec::Leave {
            transfer,
            node,
            lineage: self.header.lineage,
            zone: self.header.zone,
            pose,
        };
        let arrive = TransferRec::Arrive {
            transfer,
            carried: Vec::new(),
        };
        self.part_of(
            actor,
            vec![
                (node, Body::Transfer(leave)),
                (pose.frame.node, Body::Transfer(arrive)),
            ],
        )
    }

    /// The part of `bodies`, each with the node that writes it, by `actor`, numbered from the zone's next sequence.
    fn part_of(&self, actor: Actor, bodies: Vec<(Id, Body)>) -> Part {
        let effects: Vec<Value> = bodies
            .into_iter()
            .enumerate()
            .map(|(k, (node, body))| {
                Effect {
                    envelope: Envelope {
                        sequence: self.next + k as u64,
                        at: 0,
                        cause: Cause::Intent(id(9_000)),
                        actor,
                        audience: Audience::Everyone,
                        node,
                    },
                    body,
                    events: None,
                    rest: Rest::new(),
                }
                .to_value()
            })
            .collect();
        let bytes = encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (2, Value::Array(effects)),
        ])))
        .unwrap();
        Part::read(&bytes).unwrap()
    }

    /// Commits `changes` to the world as it stands before the change under test.
    fn setup(&mut self, changes: Vec<Change>) {
        let p = self.part(Actor::World, changes);
        self.tree
            .apply(&self.header, &p)
            .expect("the setup applies");
        self.next += p.effects.len() as u64;
    }

    /// A new box with `solids` (mm, its frame), posed by `pose`.
    fn new_box(&mut self, pose: Pose, solids: &[[i64; 9]]) -> (Id, Change) {
        self.minted += 1;
        let node = id(self.minted);
        let rows = solids
            .iter()
            .map(|s| Value::Array(s.iter().map(|&v| int(v)).collect()))
            .collect();
        let fields = if solids.is_empty() {
            BTreeMap::new()
        } else {
            BTreeMap::from([(F_SOLIDS, Value::Array(rows))])
        };
        let change = Change::Create {
            node,
            kind: self.kind.clone(),
            pose,
            audience: Audience::Everyone,
            fields,
        };
        (node, change)
    }

    /// A body's node at `pose` with a slot 1 at its origin, for a thing it holds (the scene places a held thing from its
    /// slot's point since #3344).
    fn new_holder(&mut self, pose: Pose) -> (Id, Change) {
        let (node, mut change) = self.new_box(pose, &[]);
        if let Change::Create { fields, .. } = &mut change {
            let slot = Value::Array([1, 0, 0, 0].into_iter().map(int).collect());
            fields.insert(F_SLOTS, Value::Array(vec![slot]));
        }
        (node, change)
    }

    /// A move of `node` from where it is to `pose`.
    fn moved(&self, node: Id, pose: Pose) -> Change {
        let n = self.tree.node(self.tree.handle(node).unwrap()).unwrap();
        Change::Reparent {
            node,
            from: Frame {
                node: n.parent().unwrap(),
                slot: n.slot(),
            },
            pose,
        }
    }

    /// A crate 1.5 m tall at `at` (mm) on floor 1, `hx` by `hz` half lengths.
    fn crate_on_floor1(&mut self, at: [i64; 2], hx: i64, hz: i64) -> (Id, Change) {
        let pose = self.floor1_pose(at);
        self.new_box(pose, &[solid(0, 0, hx, hz, 1_500)])
    }

    fn floor1_pose(&self, at: [i64; 2]) -> Pose {
        on(
            self.floor1,
            Vec3::new(at[0] * MM, FLOOR_1, at[1] * MM),
            surface(self.floor1),
        )
    }

    fn check(&self, actor: Actor, changes: Vec<Change>, bodies: &[Who]) -> (Guard, Vec<Unsafe>) {
        self.check_part(&self.part(actor, changes), bodies)
    }

    /// The town of the world as it stands, for the guard that cuts only what a change can affect (G2b, #3488).
    fn town(&self) -> Town {
        let doors = Doors::new(self.header.clone(), self.rules.clone(), self.next);
        Town::new(self.tree.frozen(), self.ground, doors).expect("the town")
    }

    /// The rule on `p`, after checking that each standing Soul of the fixture stands on ground before it; the guard
    /// on the town (G2b) gives the same verdict as the whole world's.
    fn check_part(&self, p: &Part, bodies: &[Who]) -> (Guard, Vec<Unsafe>) {
        let (g, v) =
            check(&self.tree, &self.header, Some(self.ground), p, bodies).expect("checked");
        let t = self.town();
        let (_, on) =
            check_on(&self.tree, &self.header, p, bodies, &Known::of(&t)).expect("checked");
        assert_eq!(
            on, v,
            "G2b: the guard on the town judges as the whole world's"
        );
        for w in bodies {
            if w.pose.frame.slot.is_none()
                && w.crossing.is_none()
                && w.pose.support == surface(w.pose.frame.node)
            {
                assert!(
                    g.sides
                        .as_ref()
                        .unwrap()
                        .before
                        .map
                        .spot_near(w.pose.frame.node, w.pose.position, 20)
                        .is_some(),
                    "the fixture's Soul {:?} stands on ground",
                    w.soul
                );
            }
        }
        (g, v)
    }
}

fn print(what: &str, v: &[Unsafe]) {
    for u in v {
        println!("{what}: {}: {}", u.name, u.text());
    }
}

fn creator() -> Actor {
    Actor::Creator(id(9_001))
}

#[test]
fn a1_a_wall_onto_a_standing_soul_is_refused_by_name() {
    let mut w = world();
    let soul = standing(1, w.ground, Vec3::new(-5 * M, 0, -10 * M));
    // A wall 4 m by 0.5 m across where the Soul stands.
    let (_, wall) = w.new_box(
        on(w.ground, Vec3::new(-5 * M, 0, -10 * M), surface(w.ground)),
        &[solid(0, 0, 2_000, 250, 1_500)],
    );
    let (_, v) = w.check(creator(), vec![wall], &[soul]);
    print("A1 wall onto a Soul", &v);
    assert_eq!(v.len(), 1);
    assert_eq!(
        (v[0].name, v[0].soul, v[0].node),
        (BURIES, soul.soul, w.ground)
    );
    let t = v[0].text();
    assert!(t.contains("Soul 07:101") && t.contains("(-5.00, -10.00) m") && t.contains("fix:"));
    assert_eq!(v[0].refused().name, BURIES);
    // The same wall 4 m away buries nobody.
    let (_, wall) = w.new_box(
        on(w.ground, Vec3::new(-5 * M, 0, -14 * M), surface(w.ground)),
        &[solid(0, 0, 2_000, 250, 1_500)],
    );
    assert_eq!(w.check(creator(), vec![wall], &[soul]).1, vec![]);
}

#[test]
fn a2_what_a_body_uses_is_refused_by_name() {
    let mut w = world();
    let g = w.ground;
    // A box to sit in, a counter 0.9 m high to rest on, and a body's node holding a box in its slot 1.
    let (chair, c1) = w.new_box(
        on(g, Vec3::new(10 * M, 0, -10 * M), surface(g)),
        &[solid(0, 0, 250, 250, 450)],
    );
    let (counter, c2) = w.new_box(
        on(g, Vec3::new(14 * M, 0, -10 * M), surface(g)),
        &[solid(0, 0, 1_000, 300, 900)],
    );
    let (body, c3) = w.new_holder(on(g, Vec3::new(18 * M, 0, -10 * M), surface(g)));
    w.setup(vec![c1, c2, c3]);
    let (held, c4) = w.new_box(in_slot(body, 1), &[solid(0, 0, 100, 100, 200)]);
    let (spare, c5) = w.new_box(
        on(g, Vec3::new(20 * M, 0, -14 * M), surface(g)),
        &[solid(0, 0, 250, 250, 450)],
    );
    w.setup(vec![c4, c5]);
    let sitter = Who {
        pose: in_slot(chair, 1),
        ..standing(1, g, Vec3::ZERO)
    };
    let percher = Who {
        pose: on(g, Vec3::new(14 * M, 900 * MM, -10 * M), surface(counter)),
        ..standing(2, g, Vec3::ZERO)
    };
    let holder = Who {
        body,
        ..standing(3, g, Vec3::new(18 * M, 0, -9 * M))
    };
    let all = [sitter, percher, holder];
    let (_, v) = w.check(creator(), vec![Change::Remove { node: chair }], &all);
    print("A2 the box sat in removed", &v);
    assert_eq!(v.len(), 1);
    assert_eq!(
        (v[0].name, v[0].soul, v[0].thing),
        (IN_USE, sitter.soul, Some((chair, Use::In)))
    );
    let away = on(g, Vec3::new(14 * M, 0, -6 * M), surface(g));
    let (_, v) = w.check(creator(), vec![w.moved(counter, away)], &all);
    print("A2 the perch moved", &v);
    assert_eq!(v.len(), 1);
    assert_eq!(
        (v[0].name, v[0].soul, v[0].thing),
        (IN_USE, percher.soul, Some((counter, Use::On)))
    );
    let (_, v) = w.check(creator(), vec![Change::Remove { node: held }], &all);
    print("A2 the held thing removed", &v);
    assert_eq!(v.len(), 1);
    assert_eq!(
        (v[0].name, v[0].soul, v[0].thing),
        (IN_USE, holder.soul, Some((held, Use::Holds)))
    );
    // Its holder setting it down is its own to do; a box nobody uses is free to go.
    let down = on(g, Vec3::new(18 * M, 0, -8 * M), surface(g));
    let p = w.set_down(Actor::Soul(holder.soul), held, down);
    assert_eq!(w.check_part(&p, &all).1, vec![]);
    assert_eq!(
        w.check(creator(), vec![Change::Remove { node: spare }], &all)
            .1,
        vec![]
    );
}

#[test]
fn a3_the_last_way_out_of_an_upper_room_is_refused_by_name() {
    let mut w = world();
    let f = w.floor1;
    // A Soul in the south room above, whose door opens on the corridor; a crate fills the corridor's one way out, the
    // narrow door to the landing, two rooms away.
    let inside = standing(1, f, Vec3::new(5_000 * MM, FLOOR_1, -3_000 * MM));
    let landing = standing(2, f, Vec3::new(-5_000 * MM, FLOOR_1, 3_000 * MM));
    let (_, c) = w.crate_on_floor1([-2_000, 0], 300, 600);
    let (_, v) = w.check(creator(), vec![c.clone()], &[inside, landing]);
    print("A3 upper floor", &v);
    assert_eq!(v.len(), 1);
    assert_eq!(
        (v[0].name, v[0].soul, v[0].node),
        (CUTS_OFF, inside.soul, f)
    );
    // N10's check of the Soul's own piece (`ground::exits::check`) finds nothing: the room's piece still has its door.
    let mut after = w.tree.frozen();
    after.apply(&w.header, &w.part(creator(), vec![c])).unwrap();
    let patch = cut_floor(&Scene::of(&after, f).unwrap(), HUMAN_RADIUS, Turn::NONE).unwrap();
    assert_eq!(
        exits::check(&patch, false, &[], &[(inside.soul, inside.pose.position)]),
        vec![]
    );
    // With nobody past the crate, it is free to go there.
    let (_, c) = w.crate_on_floor1([-2_000, 0], 300, 600);
    assert_eq!(w.check(creator(), vec![c], &[landing]).1, vec![]);
}

#[test]
fn a3_a_long_thin_pen_closed_round_its_souls_is_refused_for_each() {
    let mut w = world();
    let g = w.ground;
    // A pen on the square 32 m long and 1.6 m wide inside, across the squares' lines at x = 0 and 16 m, shut at its
    // west end and open at its east; forty Souls along it.
    let (_, pen) = w.new_box(
        on(g, Vec3::new(0, 0, 10 * M), surface(g)),
        &[
            solid(6_000, -900, 16_000, 100, 1_500),
            solid(6_000, 900, 16_000, 100, 1_500),
            solid(-10_000, 0, 100, 1_000, 1_500),
        ],
    );
    w.setup(vec![pen]);
    let souls: Vec<Who> = (0..40)
        .map(|k| standing(k, g, Vec3::new(-8 * M + k as i64 * 700 * MM, 0, 10 * M)))
        .collect();
    let (_, gate) = w.new_box(
        on(g, Vec3::new(22 * M, 0, 10 * M), surface(g)),
        &[solid(0, 0, 100, 1_000, 1_500)],
    );
    let (_, v) = w.check(creator(), vec![gate], &souls);
    print("A3 pen", &v[..2]);
    assert_eq!(v.len(), 40);
    assert!(
        v.iter()
            .zip(&souls)
            .all(|(u, s)| u.name == CUTS_OFF && u.soul == s.soul)
    );
}

#[test]
fn a4_a_crate_set_down_in_the_only_doorway_and_an_undo_are_refused() {
    let mut w = world();
    let f = w.floor1;
    // The carrier's body node on the landing, holding a crate in its slot 1.
    let (body, c1) = w.new_holder(w.floor1_pose([-7_000, 5_000]));
    w.setup(vec![c1]);
    let (crate_, c2) = w.new_box(in_slot(body, 1), &[solid(0, 0, 700, 300, 1_500)]);
    w.setup(vec![c2]);
    let carrier = Who {
        body,
        ..standing(1, f, Vec3::new(2_500 * MM, FLOOR_1, 0))
    };
    let inside = standing(2, f, Vec3::new(5_000 * MM, FLOOR_1, -3_000 * MM));
    // E4's set-down, handed over as the change it would commit: the crate into the doorway to the south room above.
    let down = w.set_down(
        Actor::Soul(carrier.soul),
        crate_,
        w.floor1_pose([1_000, -550]),
    );
    let (_, v) = w.check_part(&down, &[carrier, inside]);
    print("A4 crate set down", &v);
    assert_eq!(v.len(), 1);
    assert_eq!((v[0].name, v[0].soul), (CUTS_OFF, inside.soul));
    // An undo: a box once moved out of the narrow doorway, to the landing's corner, moved back.
    let (b, c3) = w.crate_on_floor1([-7_000, -5_000], 300, 600);
    w.setup(vec![c3]);
    let undo = w.moved(b, w.floor1_pose([-2_000, 0]));
    let (_, v) = w.check(creator(), vec![undo], &[carrier, inside]);
    print("A4 undo", &v);
    assert_eq!(
        v.iter().map(|u| (u.name, u.soul)).collect::<Vec<_>>(),
        vec![(CUTS_OFF, carrier.soul), (CUTS_OFF, inside.soul)]
    );
}

#[test]
fn a5_the_verdict_is_taken_on_the_commit_tick() {
    let mut w = world();
    let f = w.floor1;
    let soul = standing(1, f, Vec3::new(-5_000 * MM, FLOOR_1, 3_000 * MM));
    let (_, c) = w.crate_on_floor1([-2_000, 0], 300, 600);
    let p = w.part(creator(), vec![c]);
    // Checked off the clock while the Soul is on the landing: safe.
    let g = guard(&w.tree, &w.header, Some(w.ground), &p).expect("checked");
    assert_eq!(g.judge(&[soul]), vec![]);
    // It walks into the south room above before the tick the edit would commit; judged then, the edit is refused.
    let walked = Who {
        pose: on(f, Vec3::new(5_000 * MM, FLOOR_1, -3_000 * MM), surface(f)),
        ..soul
    };
    let v = g.judge(&[walked]);
    print("A5 judged at commit", &v);
    let t = w.town();
    let on = guard_on(&w.tree, &w.header, &p, &Known::of(&t)).expect("checked");
    assert_eq!(
        (on.judge(&[soul]), on.judge(&[walked])),
        (vec![], v.clone())
    );
    assert_eq!(v.len(), 1);
    assert_eq!((v[0].name, v[0].soul), (CUTS_OFF, soul.soul));
}

// --- #3280: seated and lying bodies, and bodies partway across a link ----------------------------------------------

impl W {
    /// The link of `kind` whose line passes nearest `at` (mm, the building's frame).
    fn link_near(&self, kind: Kind, at: [i64; 2]) -> Id {
        let b = Building::read(&self.tree, self.building).expect("the building's links");
        let d2 = |p: &Vec3| {
            let (dx, dz) = (i128::from(p.x - at[0] * MM), i128::from(p.z - at[1] * MM));
            dx * dx + dz * dz
        };
        b.links
            .iter()
            .filter(|l| l.kind == kind)
            .min_by_key(|l| l.line.iter().map(d2).min().unwrap_or(i128::MAX))
            .map(|l| l.id)
            .expect("a link")
    }
}

#[test]
fn a2_a_seated_or_lying_soul_shut_in_a_room_is_refused() {
    let mut w = world();
    let f = w.floor1;
    // A box to sit in and a long one to lie in, in the south room above, a Soul in each.
    let (sat_in, c1) = w.crate_on_floor1([5_000, -3_000], 250, 250);
    let (lain_in, c2) = w.crate_on_floor1([3_000, -4_500], 1_000, 450);
    w.setup(vec![c1, c2]);
    let sitter = Who {
        pose: in_slot(sat_in, 1),
        ..standing(1, f, Vec3::ZERO)
    };
    let lier = Who {
        pose: in_slot(lain_in, 1),
        ..standing(2, f, Vec3::ZERO)
    };
    // A crate in the corridor's narrow door, the room's last way out two rooms off: both are named.
    let (_, c) = w.crate_on_floor1([-2_000, 0], 300, 600);
    let (_, v) = w.check(creator(), vec![c], &[sitter, lier]);
    print("A2 seated and lying, shut in", &v);
    assert_eq!(
        v.iter().map(|u| (u.name, u.soul)).collect::<Vec<_>>(),
        vec![(CUTS_OFF, sitter.soul), (CUTS_OFF, lier.soul)]
    );
    assert!(v[0].text().contains("(5.00, -3.00) m"), "{}", v[0].text());
    // The same crate on the landing, clear of the door, shuts nobody in.
    let (_, c) = w.crate_on_floor1([-6_000, 4_000], 300, 600);
    assert_eq!(w.check(creator(), vec![c], &[sitter, lier]).1, vec![]);
}

#[test]
fn a_solid_placed_through_an_occupied_seat_is_refused_in_use() {
    // Today's game refuses it (`body.in-use`, the seated Soul named) even with clear ground to stand up onto, which the
    // #3280 rule alone lets through.
    let mut w = world();
    let g = w.ground;
    let at = Vec3::new(-5 * M, 0, -10 * M);
    let (chair, c) = w.new_holder(on(g, at, surface(g)));
    let Change::Create {
        node,
        kind,
        pose,
        audience,
        mut fields,
    } = c
    else {
        unreachable!()
    };
    // A chair: a low box, its seat (slot 1) 450 mm up at its middle.
    let slot = Value::Array([1, 0, 450, 0].into_iter().map(int).collect());
    fields.insert(F_SLOTS, Value::Array(vec![slot]));
    let low = solid(0, 0, 250, 250, 450);
    fields.insert(
        F_SOLIDS,
        Value::Array(vec![Value::Array(low.iter().map(|&v| int(v)).collect())]),
    );
    w.setup(vec![Change::Create {
        node,
        kind,
        pose,
        audience,
        fields,
    }]);
    let sitter = Who {
        pose: in_slot(chair, 1),
        ..standing(1, g, Vec3::ZERO)
    };
    let crate_at = |w: &mut W, dx: i64| {
        let p = Vec3::new(at.x + dx * MM, 0, at.z);
        w.new_box(on(g, p, surface(g)), &[solid(0, 0, 300, 300, 1_500)])
            .1
    };
    // A crate through the chair: the open ground round it is still clear, but where she sits is filled.
    let c = crate_at(&mut w, 0);
    let (_, v) = w.check(creator(), vec![c], &[sitter]);
    print("a crate through the occupied chair", &v);
    assert_eq!(v.len(), 1, "{v:?}");
    assert_eq!(
        (v[0].name, v[0].soul, v[0].thing),
        (IN_USE, sitter.soul, Some((chair, Use::In)))
    );
    // The same crate a metre and a half off the chair leaves her seat as it was.
    let c = crate_at(&mut w, 1_500);
    assert_eq!(w.check(creator(), vec![c.clone()], &[sitter]).1, vec![]);
    // And through the chair with nobody in it, it is no Soul's business here.
    let c = crate_at(&mut w, 0);
    assert_eq!(w.check(creator(), vec![c], &[]).1, vec![]);
}

#[test]
fn a2_a_body_partway_through_a_doorway_or_on_a_stair_is_refused() {
    let mut w = world();
    let f = w.floor1;
    let to_b = w.link_near(Kind::Doorway, [1_000, -550]);
    let stair = w.link_near(Kind::Stairs, [-5_000, 0]);
    // Partway through the door to the south room above.
    let in_door = Who {
        crossing: Some(to_b),
        ..standing(1, f, Vec3::new(1_000 * MM, FLOOR_1, -550 * MM))
    };
    // A crate set in that doorway buries it there.
    let (_, c) = w.crate_on_floor1([1_000, -550], 700, 300);
    let (_, v) = w.check(creator(), vec![c], &[in_door]);
    print("A2 a crate in the doorway it is crossing", &v);
    assert_eq!(v.len(), 1);
    assert_eq!((v[0].name, v[0].soul), (BURIES, in_door.soul));
    // A crate in the narrow door cuts off both the corridor and the room it is crossing between.
    let (_, c) = w.crate_on_floor1([-2_000, 0], 300, 600);
    let (_, v) = w.check(creator(), vec![c], &[in_door]);
    print("A2 the doorway's both sides cut off", &v);
    assert_eq!(v.len(), 1);
    assert_eq!((v[0].name, v[0].soul), (CUTS_OFF, in_door.soul));
    // Halfway up the stair: taking the stair away buries it there.
    let on_stair = Who {
        crossing: Some(stair),
        ..standing(2, w.floor0, Vec3::new(-5_400 * MM, 1_500 * MM, 0))
    };
    let gone = Change::Set {
        node: w.floor0,
        field: F_STAIRS,
        to: Value::Array(Vec::new()),
        by: None,
    };
    let (_, v) = w.check(creator(), vec![gone.clone()], &[on_stair]);
    print("A2 the stair it is on taken away", &v);
    assert_eq!(v.len(), 1);
    assert_eq!((v[0].name, v[0].soul), (BURIES, on_stair.soul));
    // Taken away, the stair was the upper floor's one way down: the Soul in the doorway above is cut off by it.
    let (_, v) = w.check(creator(), vec![gone.clone()], &[in_door]);
    assert_eq!(v.len(), 1);
    assert_eq!((v[0].name, v[0].soul), (CUTS_OFF, in_door.soul));
    // A crate on the landing clear of both doors is safe for both; the stair taken away with nobody upstairs, too.
    let (_, c) = w.crate_on_floor1([-6_000, 4_000], 300, 600);
    assert_eq!(w.check(creator(), vec![c], &[in_door, on_stair]).1, vec![]);
    let outside = standing(3, w.ground, Vec3::new(-5 * M, 0, -10 * M));
    assert_eq!(w.check(creator(), vec![gone], &[outside]).1, vec![]);
}

#[test]
fn class_guard_and_atomic_install_preserve_each_actual_footprint() {
    use replica::kinds::sizes::Size;
    let mut w = world();
    let soul = standing(1, w.ground, Vec3::new(-5 * M, 0, -10 * M));
    // 500mm from the wall: Standard's340mm clearance fits; Large is over20mm inside its560mm margin.
    let (_, wall) = w.new_box(
        on(
            w.ground,
            Vec3::new(-5 * M, 0, -10 * M - 750 * MM),
            surface(w.ground),
        ),
        &[solid(0, 0, 2000, 250, 1500)],
    );
    let part = w.part(creator(), vec![wall]);
    let standard =
        super::guard_for(&w.tree, &w.header, Some(w.ground), &part, Size::Standard).unwrap();
    let large_guard =
        super::guard_for(&w.tree, &w.header, Some(w.ground), &part, Size::Large).unwrap();
    let present = |side: &super::Side| {
        side.map
            .spot_near(soul.pose.frame.node, soul.pose.position, super::AT_EDGE)
            .is_some()
    };
    let standard_sides = standard.sides.as_ref().unwrap();
    assert!(present(&standard_sides.before));
    assert!(present(&standard_sides.after));
    let large_sides = large_guard.sides.as_ref().unwrap();
    assert!(present(&large_sides.before));
    assert!(!present(&large_sides.after));
    assert!(standard.judge(&[soul]).is_empty());
    let large = large_guard.judge(&[soul]);
    assert_eq!(large.first().map(|u| u.name), Some(BURIES));
    let mut town = w.town();
    town.prepare_classes([Size::Large]).unwrap();
    let before = town.tree.to_state();
    let versions = town.versions.clone();
    let rebuilt = Town::rebuild(
        town.tree.frozen(),
        &w.header,
        w.ground,
        &town.versions,
        &town.basis(),
        &part,
    )
    .unwrap();
    let (rejected, accepted) = rebuilt.into_pair();
    assert_eq!(
        town.install_then(rejected, &part, || Err::<(), _>(
            replica::effects::Refusal {
                name: "paired-refusal",
                detail: String::new()
            }
        ))
        .unwrap_err()
        .name,
        "paired-refusal"
    );
    assert_eq!(town.tree.to_state(), before);
    assert_eq!(town.versions, versions);
    let place = |town: &Town, size| {
        town.surfaces_for(size).unwrap()[&w.ground].place(
            soul.body,
            soul.pose.frame,
            soul.pose.position,
            soul.pose.orientation,
        )
    };
    assert!(place(&town, Size::Large).is_ok());
    town.install(accepted, &part).unwrap();
    assert!(place(&town, Size::Standard).is_ok());
    assert!(
        place(&town, Size::Large).is_err(),
        "the class bank changes with the committed tree"
    );
}
