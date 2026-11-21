//! B7's checks (#2726): each of the three orders starts from one intent and ends by name (A1, A2); every input it
//! produces is logged with its intent as cause and its Soul as actor (A3); thirty bodies queue for one chair and take
//! it in arrival order, each once (A4); an order with no expiry, and one of any other kind, is refused by name (A5);
//! and the orders are handed back from the log after a restart (the proof's last item).
//!
//! `cargo test -p sim --lib orders -- --nocapture` prints the log excerpts.

use std::collections::BTreeMap;
use std::path::Path;

use replica::bodies::{Class, Family, Resource, SkillShape, Want};
use replica::effects::{
    Actor, Cause, Effect, Event, Header, Part, Refusal, fixture_bytes, read_id, schema_hash,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::intents::{CANCEL, Intent, Target as Aim};
use replica::moves::{Effector, Move, Place};
use replica::pose::{Frame, Mode, Quat, Support, Vec3};
use replica::time::Micros;
use replica::world_model::show;

use super::{
    ARRIVED, CANCELLED, DISPLACED, DONE, EXPIRED, INPUT, NO_EXPIRY, Orders, REPLACED, SlotAt, TAKE,
    TARGET_GONE, Take, Where, end_reason,
};
use crate::controller::{Controller, Driver, Part as Set, Stance};
use crate::ground::Piece;
use crate::host::restart::ORDER;
use crate::mover::Surface;
use crate::moves::{Moves, Reach, load};
use crate::slots::{PlaceAt, Request, Slots};
use crate::spots::Ground;
use crate::timers::DueList;

const CHAIR: &str = include_str!("../../../replica/fixtures/seats/chair.diag");
const TICK: Micros = 50_000;
/// A doorway across the line, z from 2.3 m to 3.2 m: no spot is given in it.
const DOOR: (i64, i64) = (2_300_000, 3_200_000);
const HALF: i64 = 29_000_000;

fn name(t: &str) -> Name {
    Name::new(t).expect("a name")
}

fn mv(n: &str) -> Move {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../replica/fixtures/moves");
    load(&dir)
        .expect("the fixture moves")
        .into_iter()
        .find(|m| m.name.as_str() == n)
        .expect("in the fixtures")
}

fn family() -> Family {
    let r = |n: &str, class, slot| Resource {
        name: name(n),
        class,
        slot,
    };
    Family {
        name: name("souls:humanoid"),
        resources: vec![
            r("souls:leg-left", Class::Locomotion, None),
            r("souls:leg-right", Class::Locomotion, None),
            r("souls:hand-left", Class::Manipulator, Some(1)),
            r("souls:hand-right", Class::Manipulator, Some(2)),
        ],
    }
}

/// A script driver on the legs, which nothing cancels: a body the test walks itself.
fn script() -> SkillShape {
    SkillShape {
        name: name("test:script"),
        claims: vec![Want::All(Class::Locomotion)],
        blocks: Vec::new(),
        cancelled_by: Vec::new(),
    }
}

/// The ground and the slots as the orders read them: a flat floor 58 m square, a doorway across it, and the chair's
/// slot unless it is gone.
struct W<'a> {
    floor: Id,
    slots: &'a Slots,
    gone: bool,
}

impl Ground for W<'_> {
    fn stand(&self, node: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
        let on = Vec3::new(p.x, 0, p.z);
        (node == self.floor && p.x.abs() <= HALF && p.z.abs() <= HALF).then_some((on, on))
    }

    fn passage(&self, _: Id, p: Vec3) -> bool {
        DOOR.0 <= p.z && p.z <= DOOR.1
    }

    fn walk(&mut self, _: Id, a: Vec3, _: Id, b: Vec3) -> Option<i64> {
        Some(super::apart(a, b))
    }
}

impl Where for W<'_> {
    fn toward(&self, _: Id, to: Vec3) -> Option<Vec3> {
        // This fixture's admitted surface is flat and has no obstructing solids.
        self.stand(self.floor, to).map(|(on, _)| on)
    }
    fn slot(&self, thing: Id) -> Option<SlotAt> {
        if self.gone {
            return None;
        }
        let at = self.slots.place(thing)?;
        Some(SlotAt {
            floor: at.floor,
            stand: at.stand().ok()?,
            point: at.point,
        })
    }
}

/// Each body's point (its feet, or the slot's point while in it) and the chair's named points, for B2's reach.
struct Geo(BTreeMap<Id, Vec3>, BTreeMap<&'static str, Vec3>);

impl Reach for Geo {
    fn distance(&self, body: Id, _: &Effector, _: Option<&Name>, _: Id, p: &Name) -> Option<i64> {
        let (a, b) = (self.0.get(&body)?, self.1.get(p.as_str())?);
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        i64::try_from((d(a.x, b.x) + d(a.y, b.y) + d(a.z, b.z)).isqrt()).ok()
    }
}

struct World {
    c: Controller,
    due: DueList,
    mint: Minter,
    moves: Moves,
    slots: Slots,
    floors: BTreeMap<Id, Surface>,
    floor: Id,
    chair: Id,
    gone: bool,
    orders: Orders,
    now: Micros,
    bodies: Vec<Id>,
    /// Bodies the test walks itself: driver, velocity, ticks left.
    scripted: BTreeMap<Id, (Driver, Vec3, u32)>,
    sequences: BTreeMap<Id, u64>,
}

fn world() -> World {
    let mut mint = Minter::new(Scope([0xb7; 16]));
    let floor = mint.mint().expect("id");
    let corners = vec![
        [-29_000, 0, -29_000],
        [29_000, 0, -29_000],
        [29_000, 0, 29_000],
        [-29_000, 0, 29_000],
    ];
    let surface = Surface::new(
        floor,
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
            ground: crate::gaits::Ground::Dry,
        }],
    );
    let chair = mint.mint().expect("id");
    let place = Place::from_value(
        &decode(&fixture_bytes(CHAIR).expect("bytes"))
            .expect("decodes")
            .value,
    )
    .expect("the chair's place");
    let mut slots = Slots::new();
    slots
        .add(PlaceAt {
            thing: chair,
            point: Vec3::new(0, place.height, 0),
            place,
            facing: Quat::IDENTITY,
            floor,
        })
        .expect("a place");
    World {
        c: Controller::new(),
        due: DueList::new(),
        mint,
        moves: Moves::new(),
        slots,
        floors: BTreeMap::from([(floor, surface)]),
        floor,
        chair,
        gone: false,
        orders: Orders::new(),
        now: 0,
        bodies: Vec::new(),
        scripted: BTreeMap::new(),
        sequences: BTreeMap::new(),
    }
}

impl World {
    /// A humanoid standing at (`x`, `z`) mm.
    fn body(&mut self, x: i64, z: i64) -> Id {
        let id = self.mint.mint().expect("id");
        let frame = Frame {
            node: self.floor,
            slot: None,
        };
        let b = self.floors[&self.floor]
            .place(id, frame, Vec3::new(x * 1000, 0, z * 1000), Quat::IDENTITY)
            .expect("placed");
        self.c.add(family(), b).expect("added");
        self.bodies.push(id);
        id
    }

    fn at(&self, body: Id) -> Vec3 {
        self.c.body(body).expect("a body").pose.position
    }

    fn geo(&self) -> Geo {
        let at = self.slots.place(self.chair).expect("the chair");
        let points = BTreeMap::from([
            ("souls:slot", at.point),
            ("souls:stand", at.stand().expect("a stand point")),
        ]);
        let bodies = self
            .bodies
            .iter()
            .map(|&b| {
                let p = self.c.body(b).expect("a body").pose;
                (
                    b,
                    if p.support == Support::Slot {
                        at.point
                    } else {
                        p.position
                    },
                )
            })
            .collect();
        Geo(bodies, points)
    }

    /// An intent of `actor`'s, its next sequence.
    fn intent(
        &mut self,
        actor: Id,
        verb: &str,
        target: Option<Id>,
        params: Vec<(u64, Value)>,
        expiry: Micros,
    ) -> Intent {
        let s = self.sequences.entry(actor).or_default();
        *s += 1;
        Intent {
            actor: Actor::Soul(actor),
            verb: name(verb),
            target: target.map(Aim::Node),
            parameters: params.into_iter().collect(),
            sequence: *s,
            basis: Value::Array(vec![
                Value::Bytes(vec![0; 16]),
                actor.to_value(),
                Value::Uint(0),
                Value::Uint(0),
            ]),
            expiry,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
        }
    }

    fn accept(&mut self, i: &Intent) -> Result<Id, Refusal> {
        let id = self.mint.mint().expect("id");
        let w = W {
            floor: self.floor,
            slots: &self.slots,
            gone: self.gone,
        };
        self.orders.accept(&mut self.c, &w, i, id, self.now)?;
        Ok(id)
    }

    /// The test walks `body` itself at `v` for `ticks` ticks.
    fn script(&mut self, body: Id, v: Vec3, ticks: u32) {
        let d = self.c.claim(body, &script()).expect("a script claim");
        self.scripted.insert(body, (d, v, ticks));
    }

    /// Fires every timer due by now (B2's moves, B3's slot).
    fn fire(&mut self) {
        while let Some(t) = self.due.fire(self.now) {
            let geo = self.geo();
            let w = &mut *self;
            let _ = w.slots.fire(
                &mut w.c,
                &mut w.due,
                &mut w.mint,
                &mut w.moves,
                &geo,
                &w.floors,
                &t,
            );
        }
    }

    /// One tick: the orders, the test's own scripts, the timers, then the controller.
    fn tick(&mut self) -> Vec<Take> {
        let takes = {
            let w = W {
                floor: self.floor,
                slots: &self.slots,
                gone: self.gone,
            };
            self.orders.step(&mut self.c, &w, self.now)
        };
        let mut done = Vec::new();
        for (b, (d, v, left)) in self.scripted.iter_mut() {
            let v = if *left == 0 { Vec3::ZERO } else { *v };
            self.c
                .set(*b, *d, Set::Velocity(v, Mode::Surface))
                .expect("the script's input");
            if *left == 0 {
                done.push((*b, *d));
            }
            *left = left.saturating_sub(1);
        }
        for (b, d) in done {
            self.scripted.remove(&b);
            let _ = self.c.release(b, d);
        }
        self.fire();
        let stepped = self.c.step(&self.floors, TICK, self.now);
        assert!(stepped.refused.is_empty(), "{:?}", stepped.refused);
        self.now += TICK;
        takes
    }

    fn sit(&mut self, body: Id) -> Result<u64, Refusal> {
        let geo = self.geo();
        let sit = mv("souls:sit");
        let w = &mut *self;
        let r = w.slots.commit(
            &mut w.c,
            &mut w.due,
            &mut w.mint,
            &mut w.moves,
            &geo,
            &w.floors,
            &[Request {
                body,
                thing: w.chair,
                slot: None,
                mv: &sit,
                stance: Stance::Sit,
            }],
            w.now,
        );
        r.into_iter().next().expect("one answer").1
    }

    fn rise(&mut self, body: Id) {
        let geo = self.geo();
        let rise = mv("souls:rise");
        let w = &mut *self;
        w.slots
            .rise(
                &mut w.c,
                &mut w.due,
                &mut w.mint,
                &mut w.moves,
                &geo,
                body,
                &rise,
                w.now,
            )
            .expect("rises");
    }

    fn seated(&self, body: Id) -> bool {
        self.slots.holder(self.chair) == Some(body)
            && self
                .c
                .body(body)
                .is_some_and(|b| b.pose.support == Support::Slot)
    }

    /// Each order's end, by intent.
    fn ends(&self) -> BTreeMap<Id, String> {
        let mut out = BTreeMap::new();
        for e in &self.orders.log {
            for ev in e.events.iter().flatten() {
                if let Some(r) = end_reason(ev) {
                    out.insert(read_id(&ev.fields[&1]).expect("an intent"), r.to_owned());
                }
            }
        }
        out
    }
}

fn event(e: &Effect) -> &Event {
    &e.events.as_ref().expect("events")[0]
}

fn excerpt(e: &Effect) -> String {
    let ev = event(e);
    let cause = match e.envelope.cause {
        Cause::Intent(i) => show(i),
        c => format!("{c:?}"),
    };
    let actor = match e.envelope.actor {
        Actor::Soul(s) => format!("soul {}", show(s)),
        a => format!("{a:?}"),
    };
    let rest: Vec<String> = ev
        .fields
        .iter()
        .filter(|(k, _)| **k != 1 && **k != 6)
        .map(|(k, v)| match (read_id(v), v) {
            (Ok(i), _) => format!("{k}: {}", show(i)),
            (_, Value::Text(n)) => format!("{k}: {}", n.as_str()),
            _ => format!("{k}: {v:?}"),
        })
        .collect();
    format!(
        "#{:<4} {:>8} µs  {:<22} cause intent {cause}  actor {actor}  {}",
        e.envelope.sequence,
        e.envelope.at,
        ev.name.as_str(),
        rest.join(", ")
    )
}

/// A3: every effect an order wrote is caused by its intent, acted by its Soul, on its body; an input names the same
/// intent it is caused by.
fn every_effect_is_its_orders(w: &World, starts: &BTreeMap<Id, Id>) {
    for e in &w.orders.log {
        let Cause::Intent(i) = e.envelope.cause else {
            panic!("an order's effect is caused by its intent: {e:?}")
        };
        let body = starts[&i];
        assert_eq!(e.envelope.actor, Actor::Soul(body), "{}", excerpt(e));
        assert_eq!(e.envelope.node, body, "{}", excerpt(e));
        let ev = event(e);
        if ev.name.as_str() != ORDER {
            assert_eq!(
                read_id(&ev.fields[&1]).expect("an intent"),
                i,
                "{}",
                excerpt(e)
            );
        }
    }
}

#[test]
fn a1_a2_a3_each_order_starts_from_one_intent_ends_by_name_and_logs_its_inputs() {
    let mut w = world();
    let leader = w.body(-5_000, -10_000);
    let (h, f, x, r, d, g) = (
        w.body(-8_000, -8_000),
        w.body(-5_000, -12_000),
        w.body(8_000, -8_000),
        w.body(-6_000, -12_000),
        w.body(5_000, 8_000),
        w.body(-5_000, 8_000),
    );
    w.script(leader, Vec3::new(1_000_000, 0, 0), 1_000);
    let chair = w.chair;
    let sit = || vec![(1, Value::Text(name("souls:sit")))];
    let mut starts = BTreeMap::new();
    let mut want = BTreeMap::new();
    let hands = Value::Array(vec![Value::Text(name("souls:hand-left"))]);
    let mut start = |w: &mut World, who: Id, i: Intent, end: &'static str| {
        let id = w
            .accept(&i)
            .unwrap_or_else(|r| panic!("{}: {r}", i.verb.as_str()));
        starts.insert(id, who);
        want.insert(id, end);
        id
    };
    let i = w.intent(
        h,
        "souls:hold",
        None,
        vec![(1, Value::Uint(2)), (2, hands.clone())],
        1_000_000,
    );
    start(&mut w, h, i, EXPIRED);
    let i = w.intent(f, "souls:follow", Some(leader), Vec::new(), 2_000_000);
    start(&mut w, f, i, EXPIRED);
    let i = w.intent(x, "souls:hold", None, Vec::new(), 10_000_000);
    start(&mut w, x, i, CANCELLED);
    let i = w.intent(r, "souls:follow", Some(leader), Vec::new(), 10_000_000);
    start(&mut w, r, i, REPLACED);
    let i = w.intent(d, "souls:queue", Some(chair), sit(), 10_000_000);
    start(&mut w, d, i, DISPLACED);
    let i = w.intent(g, "souls:queue", Some(chair), sit(), 10_000_000);
    start(&mut w, g, i, TARGET_GONE);
    for t in 0..60 {
        if t == 5 {
            // Cancel x's hold; replace r's follow with a hold; d walks away (a claim on its legs).
            let mut cancel = w.intent(x, CANCEL, None, Vec::new(), 10_000_000);
            cancel.replaces = Some(1);
            w.accept(&cancel).expect("a cancel");
            let mut hold = w.intent(r, "souls:hold", None, Vec::new(), 2_500_000);
            hold.replaces = Some(1);
            start(&mut w, r, hold, EXPIRED);
            w.script(d, Vec3::new(1_000_000, 0, 0), 10);
        }
        if t == 8 {
            w.gone = true;
        }
        assert!(w.tick().is_empty(), "no slot freed");
    }
    println!("B7 orders and their ends (A1, A2, A3):");
    for e in &w.orders.log {
        println!("  {}", excerpt(e));
    }
    // A1: one intent, one record of an order.
    for (id, who) in &starts {
        let records = w
            .orders
            .log
            .iter()
            .filter(|e| event(e).name.as_str() == ORDER && e.envelope.cause == Cause::Intent(*id))
            .count();
        assert_eq!(records, 1, "{}: one record", show(*who));
    }
    // A2: each end is the named effect wanted, and no order is left open.
    let ends = w.ends();
    for (id, end) in &want {
        assert_eq!(
            ends.get(id).map(String::as_str),
            Some(*end),
            "{}",
            show(starts[id])
        );
    }
    for who in [h, f, x, r, d, g] {
        assert!(w.orders.open(who).is_none(), "{} still open", show(who));
    }
    // A3: every input is the order's own, and each order produced some.
    every_effect_is_its_orders(&w, &starts);
    for id in starts.keys() {
        let inputs = w
            .orders
            .log
            .iter()
            .filter(|e| event(e).name.as_str() == INPUT && e.envelope.cause == Cause::Intent(*id))
            .count();
        assert!(inputs > 0, "{}: no input logged", show(starts[id]));
    }
    // The follower walked after its leader while the order lasted.
    let from = Vec3::new(-5_000_000, 0, -12_000_000);
    assert!(
        super::apart(from, w.at(f)) > 1_000_000,
        "the follower moved: {:?}",
        w.at(f)
    );
}

#[test]
fn a4_thirty_bodies_queue_for_one_chair_and_take_it_in_arrival_order_each_once() {
    let mut w = world();
    let chair = w.chair;
    // One body holds the chair at the start.
    let first = w.body(0, 300);
    w.sit(first).expect("sits");
    for _ in 0..40 {
        w.tick();
    }
    assert!(w.seated(first));
    // Thirty bodies scattered beside the room, minted in id order; they queue in another order.
    let ids: Vec<Id> = (0..30)
        .map(|i| w.body(-9_000 + (i % 6) * 3_000, -6_000 - (i / 6) * 2_000))
        .collect();
    let arrival: Vec<Id> = (0..30).map(|k| ids[(k * 7) % 30]).collect();
    assert_ne!(arrival, ids, "arrival is not id order");
    let mut starts = BTreeMap::new();
    for &b in &arrival {
        let i = w.intent(
            b,
            "souls:queue",
            Some(chair),
            vec![(1, Value::Text(name("souls:sit")))],
            3_000_000_000,
        );
        starts.insert(w.accept(&i).expect("queues"), b);
    }
    assert_eq!(w.orders.line(chair), arrival);
    // They walk to their spots.
    for _ in 0..1_200 {
        w.tick();
    }
    let spots: Vec<Vec3> = arrival
        .iter()
        .map(|b| w.orders.spot(*b).expect("a spot"))
        .collect();
    for (k, (b, p)) in arrival.iter().zip(&spots).enumerate() {
        assert!(
            super::apart(w.at(*b), *p) <= ARRIVED,
            "{k}: {} not on its spot",
            show(*b)
        );
        assert!(
            !(DOOR.0 <= p.z && p.z <= DOOR.1),
            "{k}: a spot in the doorway at {p:?}"
        );
        if k > 0 {
            assert!(p.z > spots[k - 1].z, "the line goes back from the chair");
        }
    }
    println!(
        "B7 the line of thirty (A4): spots at z = {:?} mm; none in the doorway {}..{} mm",
        spots.iter().map(|p| p.z / 1000).collect::<Vec<_>>(),
        DOOR.0 / 1000,
        DOOR.1 / 1000
    );
    // Each time the chair frees, the head takes it; then it rises for the next.
    let mut holder = first;
    let mut sat = Vec::new();
    let mut takes = 0;
    for (round, &next) in arrival.iter().enumerate() {
        w.rise(holder);
        let mut n = 0;
        while w.slots.holder(chair).is_some() {
            assert!(w.tick().is_empty(), "nothing taken while held");
            n += 1;
            assert!(n < 200, "the rise ends");
        }
        // The one who rose walks off; the change wakes the line.
        w.script(holder, Vec3::new(2_000_000, 0, 0), 20);
        w.orders.freed(
            &W {
                floor: w.floor,
                slots: &w.slots,
                gone: false,
            },
            chair,
        );
        let mut took = Vec::new();
        for _ in 0..400 {
            took = w.tick();
            if !took.is_empty() {
                break;
            }
        }
        assert_eq!(took.len(), 1, "round {round}: one take");
        let t = took.remove(0);
        assert_eq!(t.body, next, "round {round}: the head, in arrival order");
        assert_eq!(t.act.as_str(), "souls:sit");
        w.sit(t.body).expect("the head sits");
        for _ in 0..60 {
            assert!(w.tick().is_empty(), "once: no take while the chair is held");
        }
        assert!(w.seated(t.body), "round {round}: seated");
        takes += 1;
        sat.push(t.body);
        holder = t.body;
    }
    assert_eq!(sat, arrival, "the chair taken in arrival order");
    assert_eq!(takes, 30);
    let logged: Vec<Id> = w
        .orders
        .log
        .iter()
        .filter(|e| event(e).name.as_str() == TAKE)
        .map(|e| e.envelope.node)
        .collect();
    assert_eq!(logged, arrival, "one take each, logged in arrival order");
    let ends = w.ends();
    assert!(
        starts
            .keys()
            .all(|i| ends.get(i).map(String::as_str) == Some(DONE))
    );
    every_effect_is_its_orders(&w, &starts);
    println!("B7 the first three takes and their ends:");
    for e in w
        .orders
        .log
        .iter()
        .filter(|e| matches!(event(e).name.as_str(), TAKE) || end_reason(event(e)) == Some(DONE))
        .take(6)
    {
        println!("  {}", excerpt(e));
    }
    println!("B7 seated in arrival order: 30 of 30, each took once");
}

#[test]
fn a5_no_expiry_and_any_other_kind_are_refused_by_name() {
    let mut w = world();
    let b = w.body(0, -5_000);
    let leader = w.body(0, -8_000);
    let chair = w.chair;
    let cases: Vec<(&str, Intent, &str)> = vec![
        (
            "a hold with no expiry",
            w.intent(b, "souls:hold", None, Vec::new(), 0),
            NO_EXPIRY,
        ),
        (
            "a follow to the end of time",
            w.intent(b, "souls:follow", Some(leader), Vec::new(), Micros::MAX),
            NO_EXPIRY,
        ),
        (
            "a queue for a day",
            w.intent(b, "souls:queue", Some(chair), Vec::new(), 86_400_000_000),
            "order-expiry-too-long",
        ),
        (
            "wait until a time",
            w.intent(b, "souls:wait-until", None, Vec::new(), 1_000_000),
            "order-unknown",
        ),
        (
            "when he jabs, block",
            w.intent(b, "souls:when", Some(leader), Vec::new(), 1_000_000),
            "order-unknown",
        ),
        (
            "an act is not an order",
            w.intent(b, "eden:sit", Some(chair), Vec::new(), 1_000_000),
            "order-unknown",
        ),
        (
            "a hold with a condition",
            w.intent(
                b,
                "souls:hold",
                None,
                vec![(9, Value::Text(name("souls:if-jabbed")))],
                1_000_000,
            ),
            "order-parameter-unknown",
        ),
    ];
    for (what, i, want) in cases {
        let r = w.accept(&i).expect_err(what);
        println!("B7 refused (A5): {what:<28} {} ({})", r.name, r.detail);
        assert_eq!(r.name, want, "{what}");
    }
    assert!(w.orders.log.is_empty(), "a refusal writes nothing");
    assert!(w.orders.open(b).is_none());
}

fn header(root: Id) -> Header {
    let v = Value::Map(
        [
            (
                1,
                Value::Bytes(Hash::of(Purpose::Fixture, b"souls/orders-test/1").to_bytes()),
            ),
            (2, Value::Bytes(schema_hash().to_bytes())),
            (3, Value::Bytes(root.scope().0.to_vec())),
            (4, root.to_value()),
            (5, Value::Uint(0)),
            (6, Value::Array(Vec::new())),
            (7, Value::Array(Vec::new())),
        ]
        .into(),
    );
    Header::read(&encode(&v).expect("bytes")).expect("a header")
}

#[test]
fn orders_are_handed_back_from_the_log_after_a_restart() {
    let mut w = world();
    let chair = w.chair;
    let (h, f, q, leader) = (
        w.body(-3_000, -3_000),
        w.body(3_000, -3_000),
        w.body(0, 6_000),
        w.body(3_000, -6_000),
    );
    let mut starts = BTreeMap::new();
    let i = w.intent(
        h,
        "souls:hold",
        None,
        vec![(1, Value::Uint(3))],
        600_000_000,
    );
    starts.insert(w.accept(&i).expect("a hold"), h);
    let i = w.intent(f, "souls:follow", Some(leader), Vec::new(), 1_000_000);
    starts.insert(w.accept(&i).expect("a follow"), f);
    let i = w.intent(q, "souls:queue", Some(chair), Vec::new(), 600_000_000);
    starts.insert(w.accept(&i).expect("a queue"), q);
    for _ in 0..10 {
        w.tick();
    }
    // The log as parts on disk; the process dies.
    let hd = header(w.floor);
    let parts: Vec<Part> = w
        .orders
        .log
        .iter()
        .map(|e| {
            let v = Value::Map(
                [
                    (1, Value::Bytes(hd.hash().to_bytes())),
                    (2, Value::Array(vec![e.to_value()])),
                ]
                .into(),
            );
            Part::read(&encode(&v).expect("bytes")).expect("a part")
        })
        .collect();
    let before = w.orders.spot(q);
    w.orders = Orders::new();
    for b in [h, f, q] {
        let held: Vec<u64> =
            w.c.claims(b)
                .expect("a body")
                .running()
                .keys()
                .copied()
                .collect();
        for d in held {
            w.c.release(b, d).expect("released");
        }
    }
    // The restart, two seconds of world time later: the follow has expired by then.
    w.now += 2_000_000;
    let back = {
        let wh = W {
            floor: w.floor,
            slots: &w.slots,
            gone: false,
        };
        w.orders
            .resume(&mut w.c, &wh, &parts, w.now)
            .expect("resumes")
    };
    for e in &w.orders.log {
        println!("B7 after the restart: {}", excerpt(e));
    }
    let back: Vec<Id> = back.iter().map(|i| starts[i]).collect();
    assert_eq!(back, vec![h, q], "the hold and the queue are handed back");
    assert_eq!(
        w.ends().values().map(String::as_str).collect::<Vec<_>>(),
        vec![EXPIRED]
    );
    assert!(w.orders.open(f).is_none());
    assert_eq!(w.orders.line(chair), vec![q]);
    assert_eq!(w.orders.spot(q), before, "the queue keeps its spot");
    w.tick();
}

#[test]
fn served_soul_body_is_resolved_internally_and_restored_without_a_wire_body_field() {
    let mut w = world();
    let body = w.body(0, -5_000);
    let soul = Id::new(Scope([0x11; 16]), 99).unwrap();
    let mut i = w.intent(soul, "souls:hold", None, Vec::new(), 600_000_000);
    i.body = Some(body); // Only the authenticated world's resolver supplies this internal field.
    assert!(
        Intent::read(&encode(&i.to_value()).unwrap()).is_err(),
        "client-selected Soul body refused on wire"
    );
    let id = w.accept(&i).expect("resolved body accepted");
    assert_eq!(w.orders.open(body).unwrap().actor, Actor::Soul(soul));
    let ev = event(&w.orders.log[0]);
    let source = Intent::read(&encode(&ev.fields[&6]).unwrap()).expect("canonical source intent");
    assert_eq!(source.body, None, "no Soul-selected body on the wire");
    assert_eq!(source.actor, Actor::Soul(soul));
    let hd = header(w.floor);
    let bytes = encode(&Value::Map(
        [
            (1, Value::Bytes(hd.hash().to_bytes())),
            (
                2,
                Value::Array(w.orders.log.iter().map(Effect::to_value).collect()),
            ),
        ]
        .into(),
    ))
    .unwrap();
    let parts = vec![Part::read(&bytes).unwrap()];
    for d in
        w.c.claims(body)
            .unwrap()
            .running()
            .keys()
            .copied()
            .collect::<Vec<_>>()
    {
        w.c.release(body, d).unwrap();
    }
    w.orders = Orders::new();
    let wh = W {
        floor: w.floor,
        slots: &w.slots,
        gone: false,
    };
    let back = w
        .orders
        .resume(&mut w.c, &wh, &parts, 1)
        .expect("restore trusted body");
    assert_eq!(back, vec![id]);
    assert_eq!(w.orders.open(body).unwrap().actor, Actor::Soul(soul));
}

/// A refused supported-way answer; the ground and ownership remain the ordinary fixture's.
struct NoWay<'a>(W<'a>);
impl Ground for NoWay<'_> {
    fn stand(&self, n: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
        self.0.stand(n, p)
    }
    fn passage(&self, n: Id, p: Vec3) -> bool {
        self.0.passage(n, p)
    }
    fn walk(&mut self, an: Id, a: Vec3, bn: Id, b: Vec3) -> Option<i64> {
        self.0.walk(an, a, bn, b)
    }
}
impl Where for NoWay<'_> {
    fn toward(&self, _: Id, _: Vec3) -> Option<Vec3> {
        None
    }
    fn slot(&self, thing: Id) -> Option<SlotAt> {
        self.0.slot(thing)
    }
}

#[test]
fn b7c_unreachable_releases_driver_without_stopping_unrelated_body() {
    let mut w = world();
    let blocked = w.body(5_000, 8_000);
    let other = w.body(-8_000, -8_000);
    let source = w.intent(
        blocked,
        "souls:queue",
        Some(w.chair),
        vec![(1, Value::Text(name("eden:sit")))],
        10_000_000,
    );
    let order = w.accept(&source).unwrap();
    w.script(other, Vec3::new(1_000_000, 0, 0), 20);
    let before = w.at(other);
    let where_ = NoWay(W {
        floor: w.floor,
        slots: &w.slots,
        gone: false,
    });
    assert!(w.orders.step(&mut w.c, &where_, w.now).is_empty());
    assert_eq!(
        w.ends().get(&order).map(String::as_str),
        Some("souls:no-way")
    );
    assert!(w.orders.open(blocked).is_none());
    assert!(w.c.claims(blocked).unwrap().running().is_empty());
    for _ in 0..10 {
        assert!(w.tick().is_empty());
    }
    assert!(w.at(other).x > before.x);
    assert!(w.orders.log.iter().all(|e| event(e).name.as_str() != TAKE));
}

#[test]
fn b7c_same_coordinates_on_another_floor_cannot_take() {
    let mut w = world();
    let body = w.body(0, 300);
    let mut place = w.slots.place(w.chair).unwrap().clone();
    place.floor = w.mint.mint().unwrap();
    w.slots = Slots::new();
    w.slots.add(place).unwrap();
    let source = w.intent(
        body,
        "souls:queue",
        Some(w.chair),
        vec![(1, Value::Text(name("eden:sit")))],
        10_000_000,
    );
    let order = w.accept(&source).unwrap();
    w.orders.freed(
        &W {
            floor: w.floor,
            slots: &w.slots,
            gone: false,
        },
        w.chair,
    );
    assert!(w.tick().is_empty());
    assert_eq!(
        w.ends().get(&order).map(String::as_str),
        Some("souls:no-way")
    );
    assert!(w.c.claims(body).unwrap().running().is_empty());
    assert!(w.orders.log.iter().all(|e| event(e).name.as_str() != TAKE));
}
