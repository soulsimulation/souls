//! Links (Engine v2 N4, #2652) on N2's test world: a scripted body, with no route search and no walk skill, crosses
//! three shut doors, the stair and the ladder from link data alone.
//!
//! `cargo test -p sim --release --test links -- --nocapture` prints the crossing's effect list, the refusal and the
//! largest step.

use import_eden::{F_DOORWAY, Import};
use replica::effects::Refusal;
use replica::effects::{Actor, Body, Cause, Change, Header, schema_hash};
use replica::encode::{Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::pose::Vec3;
use replica::tree::Tree;
use replica::world_model::show;
use sim::ground::Scene;
use sim::links::{Abilities, Building, DOOR_OPENED, Doors, F_OPEN, Kind, on_patch};
use std::collections::BTreeMap;

use testworld::WALL;

const SPEED: i64 = 1_400_000; // µm a second: today's walking pace
const TICK: i64 = 50_000; // µs: 20 ticks a second

struct World {
    tree: Tree,
    building: Building,
    doors: Doors,
    nodes: BTreeMap<String, Id>,
}

fn world() -> World {
    let w = testworld::generate(1, 0).expect("the test world");
    let Import {
        tree, rules, nodes, ..
    } = import_eden::load(&w.text).expect("the test world loads");
    let root = nodes["world"];
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/links-test/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(root.scope().0.to_vec())),
        (4, root.to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(Vec::new())),
        (7, Value::Array(Vec::new())),
    ]));
    let header = Header::read(&encode(&v).unwrap()).unwrap();
    let next = tree.to_state().next;
    let building = Building::read(&tree, nodes["building"]).expect("the building's links");
    World {
        tree,
        building,
        doors: Doors::new(header, rules, next),
        nodes,
    }
}

impl World {
    /// The doorway link the door thing `door` stands in.
    fn doorway(&self, door: &str) -> Id {
        let n = self
            .tree
            .node(self.tree.handle(self.nodes[door]).unwrap())
            .unwrap();
        replica::effects::read_id(n.fields().get(&F_DOORWAY).unwrap()).unwrap()
    }
    fn of_kind(&self, k: Kind) -> Id {
        self.building.links.iter().find(|l| l.kind == k).unwrap().id
    }
    fn open(&self, door: &str) -> bool {
        let n = self
            .tree
            .node(self.tree.handle(self.nodes[door]).unwrap())
            .unwrap();
        n.fields().get(&F_OPEN) == Some(&Value::Uint(1))
    }
    fn walker(&self, hands: bool) -> Walker {
        // In the south room on the ground floor, 2 m east of the door to the stair hall.
        Walker::new(
            Vec3::new(0, 0, -3_000_000),
            self.nodes["building/floor-0"],
            Abilities { legs: true, hands },
            SPEED,
            TICK,
            Id::new(Scope([7; 16]), 1).unwrap(),
            Id::new(Scope([7; 16]), 2).unwrap(),
        )
    }
}

const DOORS: [&str; 3] = [
    "door-building-a-b",
    "door-building-narrow",
    "door-building-to-d",
];

#[test]
fn a1_a2_a3_a5_three_shut_doors_the_stair_and_the_ladder_from_link_data_alone() {
    let mut w = world();
    for l in &w.building.links {
        println!(
            "link {} {:?} {} width {} mm, ends on patches {}/{}, line {} points{}",
            show(l.id),
            l.kind,
            l.kind.move_name(),
            l.width / 1000,
            l.ends[0].is_some(),
            l.ends[1].is_some(),
            l.line.len(),
            l.blocked
                .map(|b| format!(", not crossable: {b}"))
                .unwrap_or_default()
        );
    }
    let ids: Vec<Id> = DOORS.iter().map(|d| w.doorway(d)).collect();
    let (stair, ladder) = (w.of_kind(Kind::Stairs), w.of_kind(Kind::Ladder));
    assert!(
        DOORS.iter().all(|d| !w.open(d)),
        "the three doors start shut"
    );
    let order = [
        Leg::Cross(ids[0]),
        Leg::Cross(stair),
        Leg::Cross(ids[1]),
        Leg::Cross(ids[2]),
        Leg::Cross(ladder),
    ];
    let mut body = w.walker(true);
    let r = body.run(&w.building, &mut w.tree, &mut w.doors, &order);
    r.unwrap_or_else(|e| panic!("refused: {}: {}", e.name, e.detail));

    // A1: on the roof, at the ladder's top.
    assert_eq!(body.floor, w.nodes["building/floor-2"]);
    assert_eq!(body.at.y, 6_000_000);
    assert!(DOORS.iter().all(|d| w.open(d)), "the three doors are open");

    // A2: each opening is in the effect stream, in the order crossed.
    println!("the crossing's effect list:");
    let mut opened = Vec::new();
    for e in &w.doors.stream {
        let ev = &e.events.as_ref().unwrap()[0];
        let Body::Changes(c) = &e.body else {
            panic!("an effect")
        };
        let Change::Set {
            node, field, to, ..
        } = &c[0].change
        else {
            panic!("a set")
        };
        let link = replica::effects::read_id(&ev.fields[&1]).unwrap();
        let (Actor::Soul(soul), Cause::Intent(order)) = (e.envelope.actor, e.envelope.cause) else {
            panic!("a Soul's order")
        };
        println!(
            "  #{} at {} µs, node {} (Soul {}, order {}): set field {field} to {to:?}; event {} of link {}",
            e.envelope.sequence,
            e.envelope.at,
            show(*node),
            show(soul),
            show(order),
            ev.name.as_str(),
            show(link)
        );
        assert_eq!(ev.name.as_str(), DOOR_OPENED);
        assert_eq!(
            ev.name.as_str(),
            "eden:door_opened",
            "the door kind's event"
        );
        assert_eq!((*field, to), (F_OPEN, &Value::Uint(1)));
        opened.push(link);
    }
    assert_eq!(opened, ids, "one opening per door, in the order crossed");

    // A3: no step longer than speed times the tick.
    let (largest, bar) = body.largest_step();
    println!(
        "{} steps over {} µs of world time; the largest step {largest} µm, the bar (speed x tick) {bar} µm",
        body.steps.len(),
        body.now
    );
    assert!(
        body.steps
            .iter()
            .all(|s| *s <= i128::from(bar) * i128::from(bar))
    );

    // A5: every walking step stood on its floor's patch (`Walker::walk` refuses any other), and N3's patch holds no
    // doorway. Checked here directly too: every step inside a doorway's opening (its width, through its wall) was
    // crossing that doorway's link. Then a straight walk through an open doorway, not by its link, is refused.
    let mut inside = 0;
    for floor in w.building.floors.keys() {
        let scene = Scene::of(&w.tree, *floor).unwrap();
        for d in &scene.doorways {
            for (p, crossing) in &body.trail {
                let (dx, dz) = (i128::from(p.x - d.at[0]), i128::from(p.z - d.at[1]));
                let along = (dx * i128::from(d.along[0]) + dz * i128::from(d.along[1])) / 1_000_000;
                let across =
                    (dx * i128::from(d.across[0]) + dz * i128::from(d.across[1])) / 1_000_000;
                let level = (p.y - d.y).abs() < 1_000_000;
                if level
                    && along.abs() <= i128::from(d.width / 2)
                    && across.abs() <= i128::from(WALL * 500)
                {
                    assert_eq!(
                        *crossing,
                        Some(d.link),
                        "a step in doorway {} not by its link",
                        show(d.link)
                    );
                    inside += 1;
                }
            }
        }
    }
    println!("{inside} steps stood in a doorway's opening, each crossing that doorway's link");
    assert!(inside >= 3);
    let mut stray = w.walker(true);
    let r = stray.run(
        &w.building,
        &mut w.tree,
        &mut w.doors,
        &[Leg::Walk([-4_000_000, -3_000_000])],
    );
    let e = r.expect_err("a walk through the doorway beside its link");
    println!(
        "a straight walk through the open door a-b, not by its link: {}: {}",
        e.name, e.detail
    );
    assert_eq!(e.name, "off-ground");
}

#[test]
fn a4_a_body_without_hands_is_refused_at_a_shut_door_by_name() {
    let mut w = world();
    let link = w.doorway(DOORS[0]);
    let mut body = w.walker(false);
    let r = body.run(&w.building, &mut w.tree, &mut w.doors, &[Leg::Cross(link)]);
    let e = r.expect_err("no hands");
    println!(
        "a body without hands at {}: {}: {}",
        DOORS[0], e.name, e.detail
    );
    assert_eq!(e.name, "door-needs-hands");
    assert!(!w.open(DOORS[0]), "the door stays shut");
    assert!(w.doors.stream.is_empty(), "nothing written");
    assert_eq!(
        body.floor, w.nodes["building/floor-0"],
        "still on this side"
    );
}

// --- The proof walker (N4), moved here from `sim::links` by B1 (#2680) -------------------------------------------

fn sq(v: i64) -> i128 {
    i128::from(v) * i128::from(v)
}

/// The squared length of `b − a`, µm².
fn dist2(a: Vec3, b: Vec3) -> i128 {
    sq(b.x - a.x) + sq(b.y - a.y) + sq(b.z - a.z)
}

fn gone(id: Id) -> Refusal {
    Refusal {
        name: "node-missing",
        detail: show(id),
    }
}

fn refusal(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

/// One leg of a walk order the agent wrote.
#[derive(Clone, Copy, Debug)]
pub enum Leg {
    /// Walk straight to this point (x, z µm) on the floor the body is on.
    Walk([i64; 2]),
    /// Go to the near end of this link and cross it by its move, opening its door first if it is shut.
    Cross(Id),
}

/// A body run by a script: no route search and no walk skill, only the legs it is given, a fixed speed and a tick.
/// Proof only: it moves a body without the mover, so it lives here, not in `sim` (B1 #2680: nothing under
/// `v2/crates/*/src` moves a body but the controller).
pub struct Walker {
    /// Its centre, µm, in the building's frame.
    pub at: Vec3,
    /// The floor node whose patch it stands on.
    pub floor: Id,
    pub abilities: Abilities,
    /// µm a second.
    pub speed: i64,
    /// µs a tick.
    pub tick: i64,
    /// The world time, µs.
    pub now: i64,
    /// Every step's squared length, µm², in order.
    pub steps: Vec<i128>,
    /// Where each step ended, and the link it was crossing, if any.
    pub trail: Vec<(Vec3, Option<Id>)>,
    crossing: Option<Id>,
    pub soul: Id,
    pub order: Id,
}

impl Walker {
    /// A body at `at` on `floor`'s patch, at world time 0, acting for `soul` under the order `order`.
    pub fn new(
        at: Vec3,
        floor: Id,
        abilities: Abilities,
        speed: i64,
        tick: i64,
        soul: Id,
        order: Id,
    ) -> Walker {
        Walker {
            at,
            floor,
            abilities,
            speed,
            tick,
            now: 0,
            steps: Vec::new(),
            trail: Vec::new(),
            crossing: None,
            soul,
            order,
        }
    }

    fn reach(&self) -> i64 {
        self.speed * self.tick / 1_000_000
    }

    /// One tick toward `to`, never longer than speed times the tick. Returns whether it got there.
    fn step(&mut self, to: Vec3) -> bool {
        let d2 = dist2(self.at, to);
        let r = self.reach();
        let next = if d2 <= sq(r) {
            to
        } else {
            let d = d2.isqrt();
            let part = |a: i64, b: i64| a + ((i128::from(b - a) * i128::from(r)) / d) as i64;
            Vec3::new(
                part(self.at.x, to.x),
                part(self.at.y, to.y),
                part(self.at.z, to.z),
            )
        };
        self.steps.push(dist2(self.at, next));
        self.trail.push((next, self.crossing));
        self.at = next;
        self.now += self.tick;
        next == to
    }

    /// Walks straight to `to` on its floor's patch; every step stands on it, or the walk is refused as `off-ground`.
    fn walk(&mut self, b: &Building, to: Vec3) -> Result<(), Refusal> {
        let patch = &b.floors.get(&self.floor).ok_or_else(|| gone(self.floor))?.1;
        loop {
            let done = self.step(to);
            if !on_patch(patch, self.at, 2) {
                return Err(refusal(
                    "off-ground",
                    format!("({}, {}, {}) µm", self.at.x, self.at.y, self.at.z),
                ));
            }
            if done {
                return Ok(());
            }
        }
    }

    /// Carries out a walk order, leg by leg.
    pub fn run(
        &mut self,
        b: &Building,
        tree: &mut Tree,
        doors: &mut Doors,
        legs: &[Leg],
    ) -> Result<(), Refusal> {
        for leg in legs {
            match *leg {
                Leg::Walk([x, z]) => self.walk(b, Vec3::new(x, self.at.y, z))?,
                Leg::Cross(id) => self.cross(b, tree, doors, id)?,
            }
        }
        Ok(())
    }

    fn cross(
        &mut self,
        b: &Building,
        tree: &mut Tree,
        doors: &mut Doors,
        id: Id,
    ) -> Result<(), Refusal> {
        let show = || replica::world_model::show(id);
        let link = b.link(id).ok_or_else(|| refusal("link-missing", show()))?;
        if let Some(why) = link.blocked {
            return Err(refusal(why, show()));
        }
        let needs = link.kind.needs();
        if needs.legs && !self.abilities.legs {
            return Err(refusal("link-needs-legs", show()));
        }
        if needs.hands && !self.abilities.hands {
            return Err(refusal("link-needs-hands", show()));
        }
        // The near end is the one on this floor nearest the body.
        let near = (0..2)
            .filter(|&k| link.ends[k].is_some_and(|e| e.floor == self.floor))
            .min_by_key(|&k| link.ends[k].map_or(i128::MAX, |e| dist2(self.at, e.middle())))
            .ok_or_else(|| refusal("link-not-here", show()))?;
        let mut line = link.line.clone();
        if near == 1 {
            line.reverse();
        }
        self.walk(b, line[0])?;
        if let Some(door) = link.door {
            let shut = tree
                .node(tree.handle(door).ok_or_else(|| gone(door))?)
                .and_then(|n| n.fields().get(&F_OPEN).cloned())
                != Some(Value::Uint(1));
            if shut {
                if !self.abilities.hands {
                    return Err(refusal("door-needs-hands", show()));
                }
                // Stand, open: the opening is written at the end of this tick and read the next.
                self.steps.push(0);
                self.trail.push((self.at, None));
                self.now += self.tick;
                doors.ask(door, id, Cause::Intent(self.order), Actor::Soul(self.soul));
                doors.flush(tree, self.now)?;
            }
        }
        self.crossing = Some(id);
        for &p in &line[1..] {
            while !self.step(p) {}
        }
        self.crossing = None;
        self.floor = link.ends[1 - near].map_or(self.floor, |e| e.floor);
        Ok(())
    }

    /// The largest step taken, µm (rounded down), and the bar it is held to: speed times the tick.
    pub fn largest_step(&self) -> (i64, i64) {
        (
            self.steps.iter().max().copied().unwrap_or(0).isqrt() as i64,
            self.reach(),
        )
    }
}
