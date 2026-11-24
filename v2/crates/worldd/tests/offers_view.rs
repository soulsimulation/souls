//! Engine v2 C2 (#3366), with E8's offers: the view tier addresses an offer to each body asked and its decline to the
//! asker, as it addresses speech to its hearers (`replica::activity::addressed`), and no one else.

use std::collections::BTreeMap;

use replica::activity::{OFFER, OFFER_DECLINED};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Event, Part, Rest,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope as IdScope};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::views::Level;
use replica::world_model::Audience;
use worldd::views::subscription::{Hub, Request, Scope};

const BODY: &str =
    "souls:body@1220ee1ad75a34f067112ef6d2a095fe5bd3e121a75611a1a95ba85198efcb131cb2";

fn id(n: u64) -> Id {
    Id::new(IdScope([0x8e; 16]), n).expect("an id")
}

fn name(s: &str) -> Name {
    Name::new(s).expect("a name")
}

fn part(effects: &[Effect]) -> Part {
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"c2-offers").to_bytes()),
        ),
        (
            2,
            Value::Array(effects.iter().map(Effect::to_value).collect()),
        ),
    ]));
    Part::read(&encode(&v).expect("bytes")).expect("a part")
}

fn effect(sequence: u64, node: Id, changes: Vec<Change>, events: Option<Vec<Event>>) -> Effect {
    Effect {
        envelope: Envelope {
            sequence,
            at: 1_000_000,
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
        events,
        rest: Rest::new(),
    }
}

fn event(n: &str, offer: Id, asker: Id, asked: Id) -> Option<Vec<Event>> {
    Some(vec![Event {
        name: name(n),
        fields: BTreeMap::from([
            (1, offer.to_value()),
            (2, asker.to_value()),
            (3, Value::Array(vec![asked.to_value()])),
        ]),
        changes: Vec::new(),
        rest: Rest::new(),
    }])
}

#[test]
fn an_offer_reaches_the_bodies_asked_and_a_decline_the_asker() {
    let (floor, asker, asked, third, offer) = (id(1), id(2), id(3), id(4), id(5));
    let create = |n: Id, x: i64| Change::Create {
        node: n,
        kind: name(BODY),
        pose: Pose {
            frame: Frame {
                node: floor,
                slot: None,
            },
            position: Vec3::new(x, 0, 0),
            orientation: Quat::IDENTITY,
            support: Support::Surface {
                surface: floor,
                height: 0,
            },
        },
        audience: Audience::Everyone,
        fields: BTreeMap::new(),
    };
    let mut hub = Hub::new();
    let start: Vec<Effect> = [asker, asked, third]
        .iter()
        .enumerate()
        .map(|(k, b)| {
            effect(
                k as u64,
                floor,
                vec![create(*b, k as i64 * 1_000_000)],
                None,
            )
        })
        .collect();
    hub.tick(&part(&start)).expect("the start");
    let sub = |hub: &mut Hub, b: Id| {
        hub.subscribe(Request {
            scopes: vec![Scope::Follow(b)],
            level: Level::Counts,
            budget: 1_000_000,
        })
        .expect("subscribed")
    };
    let subs = [
        sub(&mut hub, asker),
        sub(&mut hub, asked),
        sub(&mut hub, third),
    ];
    let count = |hub: &Hub| subs.map(|s| hub.stats(s).expect("stats").addressed_in);
    hub.tick(&part(&[effect(
        3,
        floor,
        Vec::new(),
        event(OFFER, offer, asker, asked),
    )]))
    .expect("the offer");
    assert_eq!(count(&hub), [0, 1, 0], "the offer: to the body asked only");
    hub.tick(&part(&[effect(
        4,
        floor,
        Vec::new(),
        event(OFFER_DECLINED, offer, asker, asked),
    )]))
    .expect("the decline");
    assert_eq!(count(&hub), [1, 1, 0], "the decline: to the asker only");
}

/// 0.135 (the audit of #4700): an activity's join, start, leave and end reach its members wherever they stand, the
/// offerer among them, and no one else (`replica::activity::TO_MEMBERS`): one joining hears its join, one leaving its
/// leave, its end goes to those who left before too, and a member told of an end at its body hears it there.
#[test]
fn an_activity_tells_its_members_who_joins_starts_leaves_and_when_it_ends() {
    use replica::activity::MEMBER;
    use replica::world_model::End;
    let (floor, asker, asked, third, act, l1, l2) =
        (id(1), id(2), id(3), id(4), id(5), id(6), id(7));
    let create = |n: Id, x: i64| Change::Create {
        node: n,
        kind: name(BODY),
        pose: Pose {
            frame: Frame {
                node: floor,
                slot: None,
            },
            position: Vec3::new(x, 0, 0),
            orientation: Quat::IDENTITY,
            support: Support::Surface {
                surface: floor,
                height: 0,
            },
        },
        audience: Audience::Everyone,
        fields: BTreeMap::new(),
    };
    let link = |l: Id, b: Id| Change::Link {
        link: l,
        ty: name(MEMBER),
        ends: [b, act],
        owner: End::Second,
        audience: Audience::Everyone,
    };
    let said = |n: &str, fields: BTreeMap<u64, Value>| {
        Some(vec![Event {
            name: name(n),
            fields,
            changes: Vec::new(),
            rest: Rest::new(),
        }])
    };
    let mut hub = Hub::new();
    // Far apart, 40 m between each: nothing reaches one by its nearness.
    let mut start: Vec<Effect> = [asker, asked, third]
        .iter()
        .enumerate()
        .map(|(k, b)| {
            effect(
                k as u64,
                floor,
                vec![create(*b, k as i64 * 40_000_000)],
                None,
            )
        })
        .collect();
    // The offer made the activity with its asker in it (no word to it: its own act's receipt says so).
    start.push(effect(3, act, vec![link(l1, asker)], None));
    hub.tick(&part(&start)).expect("the start");
    let sub = |hub: &mut Hub, b: Id| {
        hub.subscribe(Request {
            scopes: vec![Scope::Follow(b)],
            level: Level::Counts,
            budget: 1_000_000,
        })
        .expect("subscribed")
    };
    let subs = [
        sub(&mut hub, asker),
        sub(&mut hub, asked),
        sub(&mut hub, third),
    ];
    let step = |hub: &mut Hub, e: Effect, want: [u64; 3], what: &str| {
        hub.tick(&part(&[e])).expect(what);
        let got = subs.map(|s| hub.stats(s).expect("stats").addressed_in);
        assert_eq!(got, want, "{what}");
    };
    let joined = effect(
        4,
        act,
        vec![link(l2, asked)],
        said("souls:activity-joined", BTreeMap::new()),
    );
    step(
        &mut hub,
        joined,
        [1, 1, 0],
        "a join: to the member before it and the one it joins",
    );
    let started = effect(
        5,
        act,
        Vec::new(),
        said("souls:activity-started", BTreeMap::new()),
    );
    step(&mut hub, started, [2, 2, 0], "the start: to both members");
    let left = effect(
        6,
        act,
        vec![Change::Unlink { link: l2 }],
        said("souls:activity-left", BTreeMap::new()),
    );
    step(&mut hub, left, [3, 3, 0], "a leave: to the one leaving too");
    let down = BTreeMap::from([
        (1, act.to_value()),
        (2, id(8).to_value()),
        (3, Value::Text(name("souls:partner-left"))),
    ]);
    let down = effect(8, act, Vec::new(), said("souls:carry-set-down", down));
    step(&mut hub, down, [4, 3, 0], "a set-down: to its members");
    let last = effect(
        9,
        act,
        vec![Change::Unlink { link: l1 }, Change::Remove { node: act }],
        said("souls:activity-left", BTreeMap::new()),
    );
    step(
        &mut hub,
        last,
        [5, 4, 0],
        "its end (the last leave): to the last member, and to the one who left before",
    );
    let ended = BTreeMap::from([
        (1, act.to_value()),
        (2, Value::Text(name("souls:thing-gone"))),
    ]);
    let ended = effect(7, asked, Vec::new(), said("souls:activity-ended", ended));
    step(
        &mut hub,
        ended,
        [5, 5, 0],
        "an end told at a body (its activity gone): to that body",
    );
    let after = effect(
        10,
        act,
        Vec::new(),
        said("souls:activity-started", BTreeMap::new()),
    );
    step(&mut hub, after, [5, 5, 0], "no members left: to no one");

    // A two-member offer already taken: a third who takes it joins a new pair, the event naming the offer in field 1.
    let (offer, pair, thing) = (id(20), id(21), id(22));
    let to = |l: u64, b: Id, a: Id| Change::Link {
        link: id(l),
        ty: name(MEMBER),
        ends: [b, a],
        owner: End::Second,
        audience: Audience::Everyone,
    };
    let taken = effect(
        11,
        offer,
        vec![to(30, asker, offer), to(31, asked, offer)],
        None,
    );
    step(&mut hub, taken, [5, 5, 0], "an offer taken: nothing told");
    let joined = BTreeMap::from([(1, offer.to_value())]);
    let second = effect(
        12,
        floor,
        vec![to(32, asker, pair), to(33, third, pair)],
        said("souls:activity-joined", joined),
    );
    step(
        &mut hub,
        second,
        [6, 5, 1],
        "a second taker's pair: to its members, not to the first taker",
    );
    // A creator removes the thing the pair is under (the removal names the thing alone); each member is told at its
    // body, once.
    let gone = effect(13, thing, vec![Change::Remove { node: thing }], None);
    step(
        &mut hub,
        gone,
        [6, 5, 1],
        "the thing's removal: nothing told",
    );
    let end = |seq: u64, body: Id| {
        let f = BTreeMap::from([
            (1, pair.to_value()),
            (2, Value::Text(name("souls:thing-gone"))),
        ]);
        effect(seq, body, Vec::new(), said("souls:activity-ended", f))
    };
    step(
        &mut hub,
        end(14, asker),
        [7, 5, 1],
        "an end at a body: to it alone",
    );
    step(
        &mut hub,
        end(15, third),
        [7, 5, 2],
        "an end at a body: to it alone",
    );
    let late = effect(
        16,
        pair,
        Vec::new(),
        said("souls:activity-started", BTreeMap::new()),
    );
    step(
        &mut hub,
        late,
        [7, 5, 2],
        "its memberships let go: to no one",
    );
}
