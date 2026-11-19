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
