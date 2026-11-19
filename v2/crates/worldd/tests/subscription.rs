//! Subscriptions (Engine v2 R4, #2698): a client holds more than one scope, and a change of room adds the new before
//! dropping the old (A5); events addressed to it all arrive under a small budget, which no second passes (A2, A3);
//! a budget below the least is refused; the interest set enters and leaves at two distances. A1 to A4 at scale are
//! measured by `v2/tools/bench/subscription`. A turn into an activity reaches its members alone, live and in a replay
//! (E26a, #3504).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use replica::effects::{Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Part, Rest};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope as IdScope};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::speech::{Said, heard};
use replica::views::Level;
use replica::world_model::{Audience, End, show};
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

/// R4b (#3151) A1: the counts by cell come whole once, on join, and as changes after; a client applying them holds
/// the hub's table every world second, and a cell that empties is sent as 0.
#[test]
fn r4b_counts_by_cell_come_whole_on_join_then_as_changes_that_rebuild_the_table() {
    use replica::encode::decode;
    use worldd::views::subscription::GRID;
    let (hall, me) = (id(1), id(10));
    let mut w = w();
    let mut hub = Hub::new();
    let mut make = vec![w.body(me, hall, 0)];
    for i in 0..20 {
        make.push(w.body(id(100 + i), hall, i as i64 * 3_000_000));
    }
    let p = w.part(make);
    hub.tick(&p).expect("a tick");
    let s = hub
        .subscribe(Request {
            scopes: vec![Scope::Follow(me)],
            level: Level::Full,
            budget: 8_000,
        })
        .expect("subscribed");
    let num = |v: &Value| match v {
        Value::Uint(n) => *n as i64,
        Value::Nint(n) => -1 - *n as i64,
        _ => panic!("an integer"),
    };
    let mut table: BTreeMap<(i64, i64), u32> = BTreeMap::new();
    let (mut whole, mut changes, mut emptied) = (0, 0, 0);
    for t in 1..=100i64 {
        // Everyone but me walks 0.5 m a tick, so cells fill and empty.
        let moves = (0..20)
            .map(|i| w.walk(id(100 + i), hall, i as i64 * 3_000_000 + t * 500_000))
            .collect();
        let p = w.part(moves);
        hub.tick(&p).expect("a tick");
        let mut got = false;
        for o in hub.drain(s) {
            if !matches!(o.kind, Kind::Cells | Kind::Changes) {
                continue;
            }
            got = true;
            let Value::Map(m) = decode(&o.bytes).expect("an item").value else {
                panic!("a map")
            };
            if o.kind == Kind::Cells {
                whole += 1;
                table.clear();
            } else {
                changes += 1;
            }
            let Value::Array(rows) = &m[&4] else {
                panic!("rows")
            };
            for r in rows {
                let Value::Array(r) = r else { panic!("a row") };
                let c = (num(&r[0]), num(&r[1]));
                match num(&r[2]) as u32 {
                    0 => {
                        emptied += 1;
                        table.remove(&c)
                    }
                    n => table.insert(c, n),
                };
            }
        }
        if got {
            let want = hub.places().cells(GRID).remove(&hall).expect("the hall").1;
            assert_eq!(table, want, "the client's table at tick {t}");
        }
    }
    println!(
        "R4b A1: {whole} whole table, {changes} changes, {emptied} cells emptied; the table rebuilt equals the hub's every second"
    );
    assert!(emptied > 0, "a cell that empties is sent as 0");
    assert_eq!(whole, 1, "whole only on join");
    assert!(changes >= 4, "changes every second after: {changes}");
}

/// E26a (#3504, A1 and A2): a turn into an activity is sent to its members' subscriptions, each with the entry of the
/// activity's audience and its words, while each is a member, and stops when one leaves; a Soul beside the speaker
/// that is not a member and a public viewer following a member never get it, live or when the log is read again.
#[test]
fn e26a_a_turn_into_an_activity_reaches_its_members_alone_live_and_in_a_replay() {
    let (hall, m1, m2, outsider, act) = (id(1), id(10), id(11), id(12), id(50));
    let store = Arc::new(worldd::words::in_memory(IdScope([9; 16])).expect("a store"));
    let line = |w: &str| {
        store
            .write(w.as_bytes(), Audience::Of(act), m1)
            .expect("kept")
    };
    let (first, second) = (line("shall we go"), line("after the rain"));
    let member = |w: &mut W, link: Id, body: Id| {
        let c = Change::Link {
            link,
            ty: Name::new("souls:member").expect("a name"),
            ends: [body, act],
            owner: End::Second,
            audience: Audience::Everyone,
        };
        w.entry(act, c)
    };
    // A turn by m1 as the world writes it: its hearers the members' bodies at write, in the activity's audience.
    let turn = |w: &mut W, words: Id, hearers: BTreeSet<Id>| {
        let said = Said {
            words,
            reach_mm: 5_000,
            audience: Audience::Of(act),
            hearers,
            length: 1_000_000,
        };
        let mut e = w.entry(m1, Change::Unlink { link: id(999) });
        e.envelope.audience = Audience::Of(act);
        e.body = Body::Changes(Vec::new());
        e.events = Some(vec![said.event()]);
        e
    };
    let mut w = w();
    let bodies = vec![
        w.body(m1, hall, 0),
        w.body(m2, hall, 30_000_000),
        w.body(outsider, hall, 500_000),
    ];
    let mut parts = vec![w.part(bodies)];
    let links = vec![member(&mut w, id(60), m1), member(&mut w, id(61), m2)];
    parts.push(w.part(links));
    let both = BTreeSet::from([m1, m2]);
    let t = turn(&mut w, first, both.clone());
    parts.push(w.part(vec![t]));
    let gone = w.entry(act, Change::Unlink { link: id(61) });
    parts.push(w.part(vec![gone]));
    // Written as if m2 were still a hearer: the hub's own check keeps it from a Soul that left.
    let t = turn(&mut w, second, both);
    parts.push(w.part(vec![t]));

    // Each subscriber: its name, its audiences and the body it follows. The viewer follows m1, as the public.
    let subscribers = [
        ("m1", vec![m1], m1),
        ("m2", vec![m2], m2),
        ("outsider", vec![outsider], outsider),
        ("public viewer", vec![], m1),
    ];
    // The log read live (subscribed once the bodies are made), then read again by a new hub from its first part.
    let mut seen = BTreeMap::new();
    for replay in [false, true] {
        let mut hub = Hub::with_words(store.clone());
        if !replay {
            hub.tick(&parts[0]).expect("a tick");
        }
        let subs: Vec<usize> = subscribers
            .iter()
            .map(|(_, a, b)| {
                let r = Request {
                    scopes: vec![Scope::Follow(*b)],
                    level: Level::Full,
                    budget: 64_000,
                };
                hub.subscribe_as(r, a.iter().copied().collect())
                    .expect("subscribed")
            })
            .collect();
        for p in &parts[usize::from(!replay)..] {
            hub.tick(p).expect("a tick");
        }
        for ((who, _, _), s) in subscribers.iter().zip(subs) {
            let got: Vec<(Audience, Option<String>)> = hub
                .drain(s)
                .iter()
                .filter_map(|o| heard(&o.bytes).expect("an item"))
                .map(|h| {
                    let w = h.words.map(|w| String::from_utf8(w).expect("utf-8"));
                    (h.said.audience, w)
                })
                .collect();
            seen.insert((replay, *who), got);
        }
    }
    for ((replay, who), got) in &seen {
        println!(
            "E26a A2 ({}): {who} heard {:?} of the turns into {}",
            if *replay { "replay" } else { "live" },
            got.iter().map(|(_, w)| w.clone()).collect::<Vec<_>>(),
            show(act)
        );
    }
    let private = |w: &str| (Audience::Of(act), Some(w.to_string()));
    for replay in [false, true] {
        assert_eq!(
            seen[&(replay, "m1")],
            vec![private("shall we go"), private("after the rain")],
            "a member hears every turn, in the activity's audience, with its words"
        );
        assert_eq!(
            seen[&(replay, "m2")],
            vec![private("shall we go")],
            "m2 hears while a member and not after it leaves"
        );
        assert!(seen[&(replay, "outsider")].is_empty(), "not a member");
        assert!(seen[&(replay, "public viewer")].is_empty(), "the public");
    }
}
