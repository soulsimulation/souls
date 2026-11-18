//! Subscriptions (Engine v2 R4, #2698): a client holds more than one scope, and a change of room adds the new before
//! dropping the old (A5); events addressed to it all arrive under a small budget, which no second passes (A2, A3);
//! a budget below the least is refused; the interest set enters and leaves at two distances. A1 to A4 at scale are
//! measured by `v2/tools/bench/subscription`.

use std::collections::BTreeMap;

use replica::effects::{Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Part, Rest};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope as IdScope};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::views::Level;
use replica::world_model::Audience;
use worldd::views::interest::{ENTER, LEAVE};
use worldd::views::subscription::{Hub, Kind, Request, Scope};

/// A pinned body kind, as a log names it.
const BODY: &str =
    "souls:body@1220ee1ad75a34f067112ef6d2a095fe5bd3e121a75611a1a95ba85198efcb131cb2";

fn id(n: u64) -> Id {
    Id::new(IdScope([7; 16]), n).expect("an id")
}

fn pose(room: Id, x: i64) -> Pose {
    Pose {
        frame: Frame {
            node: room,
            slot: None,
        },
        position: Vec3::new(x, 0, 0),
        orientation: Quat::IDENTITY,
        support: Support::Surface {
            surface: room,
            height: 0,
        },
    }
}

struct W {
    seq: u64,
    at: i64,
}

impl W {
    fn entry(&mut self, node: Id, change: Change) -> Effect {
        self.seq += 1;
        Effect {
            envelope: Envelope {
                sequence: self.seq,
                at: self.at,
                cause: Cause::World,
                actor: Actor::World,
                audience: Audience::Everyone,
                node,
            },
            body: Body::Changes(vec![ChangeRec {
                change,
                rest: Rest::new(),
            }]),
            events: None,
            rest: Rest::new(),
        }
    }

    fn body(&mut self, b: Id, room: Id, x: i64) -> Effect {
        let c = Change::Create {
            node: b,
            kind: Name::new(BODY).expect("a name"),
            pose: pose(room, x),
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        };
        self.entry(room, c)
    }

    fn walk(&mut self, b: Id, room: Id, x: i64) -> Effect {
        let h = HandOff {
            node: b,
            at: self.at,
            from: Owner::Mover,
            to: Owner::Mover,
            pose: pose(room, x),
            linear: Vec3::new(1_000_000, 0, 0),
            angular: Vec3::ZERO,
        };
        self.entry(b, Change::Motion(h))
    }

    /// One tick: its entries as a part, and the clock moves on 50 ms.
    fn part(&mut self, effects: Vec<Effect>) -> Part {
        let v = Value::Map(
            [
                (
                    1,
                    Value::Bytes(Hash::of(Purpose::Fixture, b"r4").to_bytes()),
                ),
                (
                    2,
                    Value::Array(effects.iter().map(Effect::to_value).collect()),
                ),
            ]
            .into(),
        );
        self.at += 50_000;
        Part::read(&encode(&v).expect("bytes")).expect("a part")
    }
}

fn w() -> W {
    W { seq: 0, at: 0 }
}

#[test]
fn a5_two_scopes_and_the_new_room_before_the_old_is_dropped() {
    let (a, b, c, me) = (id(1), id(2), id(3), id(10));
    let mut w = w();
    let mut hub = Hub::new();
    let e = vec![w.body(me, a, 0)];
    let p = w.part(e);
    hub.tick(&p).expect("a tick");
    let s = hub
        .subscribe(Request {
            scopes: vec![Scope::Follow(me), Scope::Node(c)],
            level: Level::Full,
            budget: 8_000,
        })
        .expect("subscribed");
    assert_eq!(hub.held(s), Some(&[a, c][..]), "two scopes at once");
    let e = vec![w.walk(me, a, 1_000_000)];
    let p = w.part(e);
    hub.tick(&p).expect("a tick");
    hub.drain(s);
    // The body goes into room b.
    let e = vec![w.walk(me, b, 0)];
    let p = w.part(e);
    hub.tick(&p).expect("a tick");
    assert_eq!(hub.held(s), Some(&[c, b][..]), "c kept, b added, a dropped");
    let kinds: Vec<Kind> = hub.drain(s).iter().map(|o| o.kind).collect();
    let added = kinds.iter().position(|k| *k == Kind::Added).expect("added");
    let dropped = kinds
        .iter()
        .position(|k| *k == Kind::Dropped)
        .expect("dropped");
    assert!(added < dropped, "added before dropped: {kinds:?}");
    assert!(
        kinds[added..dropped].contains(&Kind::Cells),
        "the new room's counts come before the old is dropped: {kinds:?}"
    );
    println!("A5: held {{follow, fixed}} = 2 scopes; on a room change the stream reads {kinds:?}");
}

#[test]
fn a3_addressed_events_all_arrive_and_no_second_passes_the_budget() {
    let (hall, me) = (id(1), id(10));
    let mut w = w();
    let mut hub = Hub::new();
    let mut make = vec![w.body(me, hall, 0)];
    for i in 0..60 {
        make.push(w.body(id(100 + i), hall, (i as i64 % 6) * 500_000));
    }
    let p = w.part(make);
    hub.tick(&p).expect("a tick");
    let budget = 600;
    let s = hub
        .subscribe(Request {
            scopes: vec![Scope::Follow(me)],
            level: Level::Full,
            budget,
        })
        .expect("subscribed");
    let mut got = 0;
    let mut sent = 0;
    let mut lowered = false;
    for t in 0..200u64 {
        let moves = (0..60)
            .map(|i| {
                w.walk(
                    id(100 + i),
                    hall,
                    (i as i64 % 6) * 500_000 + t as i64 * 1_000,
                )
            })
            .collect();
        let p = w.part(moves);
        if t < 160 && t % 4 == 0 {
            hub.address(s, format!("receipt {t}").as_bytes())
                .expect("addressed");
            sent += 1;
        }
        hub.tick(&p).expect("a tick");
        for o in hub.drain(s) {
            got += u64::from(o.kind == Kind::Addressed);
            if o.kind == Kind::Grant {
                let v = replica::encode::decode(&o.bytes).expect("an item");
                lowered |= format!("{v:?}").contains("souls:over-budget");
            }
        }
    }
    let st = hub.stats(s).expect("stats").clone();
    println!(
        "A3: budget {budget} B/s, most in a second {} B, addressed {sent} sent, {got} received, level {:?}, gaps {}",
        st.most,
        hub.granted(s).expect("a grant").level,
        st.gaps
    );
    assert_eq!(got, sent, "every addressed event arrives");
    assert!(st.most <= budget, "no second passes the budget");
    assert!(lowered, "the level drop is named in the stream");
    assert_ne!(hub.granted(s).expect("a grant").level, Level::Full);
}

#[test]
fn a_budget_below_the_least_is_refused() {
    let mut hub = Hub::new();
    let e = hub
        .subscribe(Request {
            scopes: vec![Scope::Node(id(1)), Scope::Node(id(2))],
            level: Level::Full,
            budget: 61,
        })
        .expect_err("refused");
    assert_eq!(e.name, "budget-below-minimum");
}

#[test]
fn a_body_enters_the_set_at_one_distance_and_leaves_at_a_larger() {
    let (hall, me, you) = (id(1), id(10), id(11));
    let mut w = w();
    let mut hub = Hub::new();
    let between = (ENTER + LEAVE) / 2;
    let e = vec![w.body(me, hall, 0), w.body(you, hall, between)];
    let p = w.part(e);
    hub.tick(&p).expect("a tick");
    let s = hub
        .subscribe(Request {
            scopes: vec![Scope::Follow(me)],
            level: Level::Full,
            budget: 8_000,
        })
        .expect("subscribed");
    let mut step = |x: i64| {
        let e = vec![w.walk(you, hall, x)];
        let p = w.part(e);
        hub.tick(&p).expect("a tick");
        hub.interest(s).expect("a set").contains(&you)
    };
    assert!(!step(between), "between the two distances, not yet in");
    assert!(step(ENTER - 1), "closer than ENTER: in");
    assert!(step(between), "between: stays");
    assert!(!step(LEAVE), "at LEAVE: out");
}
