//! Births and retirements (Engine v2 K10, #2673): a retirement mid-sit leaves no slot held, no link and no timer; a
//! second birth for an embodied Soul is refused by name; a lost connection retires nobody; a birth's effects hold no
//! account id. The wave of joins on N15's walker scene is the `joins` bench (`v2/tools/bench/joins/main.rs`).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use replica::bodies::{Class, Family};
use replica::effects::{Change, fixture_bytes};
use replica::encode::{Name, Value, decode};
use replica::ids::{Id, Minter, Scope};
use replica::moves::{Effector, Move, Place};
use replica::pose::{Quat, Support, Vec3, fixture};
use sim::controller::Stance;
use sim::ground::Piece;
use sim::host::{Runner, named};
use sim::life::{Birth, Life, Ring};
use sim::mover::Surface;
use sim::moves::{Moves, Reach, load};
use sim::slots::{PlaceAt, Request, Slots};
use sim::timers::{DueList, Timer};

const FAMILIES: &str = include_str!("../../replica/fixtures/bodies/families.diag");
const CHAIR: &str = include_str!("../../replica/fixtures/seats/chair.diag");
const TICK: i64 = 50_000;
const WORLD: Scope = Scope([0x1a; 16]);

fn value(text: &str) -> Value {
    decode(&fixture_bytes(text).expect("bytes"))
        .expect("decodes")
        .value
}

fn family() -> Family {
    let Value::Array(fs) = value(FAMILIES) else {
        panic!("a list")
    };
    fs.iter()
        .map(|f| Family::from_value(f).expect("a family"))
        .find(|f| f.resources.iter().any(|r| r.class == Class::Manipulator))
        .expect("a family with legs and hands")
}

fn mv(name: &str) -> Move {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../replica/fixtures/moves");
    load(&dir)
        .expect("the fixture moves")
        .into_iter()
        .find(|m| m.name.as_str() == name)
        .expect("in the fixtures")
}

/// Everything within reach.
struct Near;
impl Reach for Near {
    fn distance(&self, _: Id, _: &Effector, _: Option<&Name>, _: Id, _: &Name) -> Option<i64> {
        Some(0)
    }
}

fn soul(n: u64) -> Id {
    Id::new(Scope([0x50; 16]), n).expect("an id")
}

struct World {
    runner: Runner,
    life: Life,
    ring: Ring,
    floors: BTreeMap<Id, Surface>,
    slots: Slots,
    moves: Moves,
    due: DueList,
    mint: Minter,
    thing: Id,
    entry: Id,
}

/// A 10 m floor with one chair at its middle and an entry 300 mm in front of it.
fn world() -> World {
    let floor = fixture(1);
    let corners = vec![
        [-5_000, 0, -5_000],
        [5_000, 0, -5_000],
        [5_000, 0, 5_000],
        [-5_000, 0, 5_000],
    ];
    let surface = Surface::new(
        floor,
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
            ground: sim::gaits::Ground::Dry,
        }],
    );
    let mut mint = Minter::new(Scope([0xb3; 16]));
    let thing = mint.mint().expect("id");
    let entry = mint.mint().expect("id");
    let place = Place::from_value(&value(CHAIR)).expect("the chair's place");
    let mut slots = Slots::new();
    slots
        .add(PlaceAt {
            thing,
            point: Vec3::new(0, place.height, 0),
            place,
            facing: Quat::IDENTITY,
            floor,
        })
        .expect("a slot");
    World {
        runner: Runner::new(TICK),
        life: Life::new(WORLD, 8),
        ring: Ring {
            entries: BTreeMap::from([(entry, (floor, Vec3::new(0, 0, 300_000)))]),
            radius: 100_000,
            gap: 200_000,
            rings: 4,
        },
        floors: BTreeMap::from([(floor, surface)]),
        slots,
        moves: Moves::new(),
        due: DueList::new(),
        mint,
        thing,
        entry,
    }
}

impl World {
    fn born(&mut self, s: Id, now: i64) -> Id {
        self.life
            .ask(Birth {
                soul: s,
                entry: self.entry,
                asked: now,
            })
            .expect("asked");
        let b = self
            .life
            .tick(now, &mut self.runner, &self.floors, &self.ring, &family());
        assert_eq!(b.len(), 1, "born at the next tick");
        b[0].body
    }

    /// Fires `n` of the due timers (all with `usize::MAX`).
    fn fire(&mut self, n: usize) {
        for _ in 0..n {
            let Some(t) = self.due.fire(i64::MAX) else {
                return;
            };
            self.slots.fire(
                &mut self.runner.controller,
                &mut self.due,
                &mut self.mint,
                &mut self.moves,
                &Near,
                &self.floors,
                &t,
            );
        }
    }
}

#[test]
fn a_retirement_mid_sit_leaves_no_slot_link_or_timer() {
    let sit = mv("souls:sit");
    // Before the first phase ends, part way down, and seated with the sit done.
    for fired in [0, 1, usize::MAX] {
        let mut w = world();
        let s = soul(1);
        let body = w.born(s, 0);
        let link = w.life.link_of(s).expect("linked");
        let started = w.slots.commit(
            &mut w.runner.controller,
            &mut w.due,
            &mut w.mint,
            &mut w.moves,
            &Near,
            &[Request {
                body,
                thing: w.thing,
                mv: &sit,
                stance: Stance::Sit,
            }],
            0,
        );
        assert!(started[0].1.is_ok(), "{:?}", started[0].1);
        w.fire(fired);
        // A timer of the body's own skill, pending too.
        let own = w.mint.mint().expect("id");
        w.due
            .set(Timer {
                node: body,
                id: own,
                due: 60_000_000,
                name: named("souls:wake"),
            })
            .expect("set");
        assert_eq!(w.slots.holder(w.thing), Some(body), "fired {fired}");

        let r = w
            .life
            .retire(
                s,
                1_000_000,
                &mut w.runner,
                &mut w.slots,
                &mut w.moves,
                &mut w.due,
            )
            .expect("retired");
        assert_eq!(r.slot, Some(w.thing));
        assert!(r.timers.iter().any(|t| t.id == own));
        assert_eq!(
            r.changes,
            [Change::Unlink { link }, Change::Remove { node: body }]
        );
        assert_eq!(
            w.slots.holder(w.thing),
            None,
            "no slot held (fired {fired})"
        );
        assert_eq!(w.slots.held_by(body), None);
        assert!(w.slots.is_empty());
        assert!(w.due.is_empty(), "no timer (fired {fired})");
        assert!(w.moves.is_empty(), "no move under way");
        assert_eq!(w.life.body_of(s), None);
        assert_eq!(w.life.link_of(s), None, "no link");
        assert!(w.runner.controller.body(body).is_none(), "the body is gone");
        assert!(w.runner.controller.bodies().all(|b| b.id != body));

        // The slot takes another body, and the Soul can be born again.
        let other = w.born(soul(2), 2_000_000);
        let again = w.slots.commit(
            &mut w.runner.controller,
            &mut w.due,
            &mut w.mint,
            &mut w.moves,
            &Near,
            &[Request {
                body: other,
                thing: w.thing,
                mv: &sit,
                stance: Stance::Sit,
            }],
            2_000_000,
        );
        assert!(again[0].1.is_ok(), "the slot is free: {:?}", again[0].1);
        assert_ne!(w.born(s, 3_000_000), body, "a new body, a new id");
    }
}

#[test]
fn a_second_birth_is_refused_by_name_and_a_lost_connection_retires_nobody() {
    let mut w = world();
    let s = soul(1);
    let asked = Birth {
        soul: s,
        entry: w.entry,
        asked: 0,
    };
    w.life.ask(asked).expect("asked");
    let r = w.life.ask(asked).expect_err("one on the way");
    assert_eq!(r.name, "soul-embodied");
    let born = w.life.tick(0, &mut w.runner, &w.floors, &w.ring, &family());
    let body = born[0].body;
    let r = w.life.ask(asked).expect_err("embodied");
    assert_eq!(r.name, "soul-embodied");
    assert_eq!(w.life.waiting(), 0);
    assert_eq!(w.runner.controller.bodies().count(), 1, "one body");

    // The connection is lost: whatever the Soul's body ran ends, and the world goes on. The body stays.
    w.runner.end(body, named("connection-lost"));
    for _ in 0..100 {
        w.life.tick(0, &mut w.runner, &w.floors, &w.ring, &family());
        w.runner.controller.step(&w.floors, TICK, 0);
    }
    assert_eq!(w.life.body_of(s), Some(body), "still embodied");
    let p = w.runner.controller.body(body).expect("still standing").pose;
    assert!(matches!(p.support, Support::Surface { .. }));
    assert_eq!(w.life.link_of(s), Some(born[0].link), "still linked");
}

#[test]
fn no_birth_effect_holds_an_account_id() {
    let mut w = world();
    // An account and its Soul: only the Soul is ever given to a birth.
    let account = Id::new(Scope([0xac; 16]), 1).expect("an id");
    let s = soul(1);
    w.life
        .ask(Birth {
            soul: s,
            entry: w.entry,
            asked: 0,
        })
        .expect("asked");
    let born = w.life.tick(0, &mut w.runner, &w.floors, &w.ring, &family());
    let b = &born[0];
    let mut ids = BTreeSet::new();
    for c in &b.changes {
        match c {
            Change::Create { node, pose, .. } => {
                ids.insert(*node);
                ids.insert(pose.frame.node);
            }
            Change::Link { link, ends, .. } => {
                ids.insert(*link);
                ids.extend(ends);
            }
            other => panic!("a birth is a create and a link: {other:?}"),
        }
    }
    let floor = fixture(1);
    assert_eq!(ids, BTreeSet::from([b.body, b.link, s, floor]));
    assert!(!ids.contains(&account));
    assert_eq!(b.body.scope(), WORLD, "the world mints the body");
    assert_eq!(b.link.scope(), WORLD);
}
