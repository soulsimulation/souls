//! E8's checks (#2779): a hug offered to one Soul and high fives offered to a room each start when accepted in time
//! (A1); a refused dance and a lapse each reach the asker as a named outcome (A2); with no accept sent (the Soul's
//! client, which holds its standing consent, stopped) the offer lapses (A3; the consent rule itself is the client's,
//! `v2/client/src/reflex/consent.test.mjs`); an offer to a hall of 300 is one effect (A4). `cargo test -p sim offers
//! -- --nocapture` prints each run.

use std::collections::BTreeSet;

use replica::activity::{OFFER, OFFER_DECLINED, OFFER_LAPSED, addressed};
use replica::effects::{Actor, Cause, Effect, Event};
use replica::encode::Value;
use replica::ids::Id;
use replica::time::Micros;
use replica::world_model::show;

use super::{PAIR, World, n, world};
use crate::activity::offer::{OPEN_MOST, present};

/// The pair's proposal lasts a minute.
const LASTS: Micros = 60_000_000;

fn event(e: &Effect) -> &Event {
    e.events.as_ref().and_then(|v| v.first()).expect("an event")
}

fn bodies(v: Option<&Value>) -> Vec<Id> {
    match v {
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| replica::effects::read_id(x).expect("an id"))
            .collect(),
        _ => Vec::new(),
    }
}

impl World {
    /// Soul `who` offers the pair, in its first role, to `asked`.
    pub(super) fn offer(&mut self, who: usize, asked: BTreeSet<Id>, at: Micros) -> Id {
        let ask = self.ask(who, at);
        let body = self.bodies[who];
        self.acts
            .offer(
                &mut self.tree,
                &mut self.mint,
                &mut self.due,
                ask,
                body,
                &n(PAIR),
                &n("test:first"),
                self.root,
                asked,
                None,
            )
            .expect("offered")
    }

    pub(super) fn accept(
        &mut self,
        who: usize,
        offer: Id,
        at: Micros,
    ) -> Result<Id, replica::effects::Refusal> {
        let ask = self.ask(who, at);
        let body = self.bodies[who];
        self.acts.accept(
            &mut self.tree,
            &mut self.mint,
            &mut self.c,
            &mut self.due,
            ask,
            body,
            offer,
        )
    }

    /// Runs every offer timer due before `before`.
    pub(super) fn lapse_until(&mut self, before: Micros) {
        while let Some(t) = self.due.fire(before) {
            self.acts
                .lapse(&mut self.tree, &mut self.c, &mut self.due, &t)
                .expect("an offer's timer")
                .expect("lapsed");
        }
    }

    fn last(&self) -> &Effect {
        self.acts.stream.last().expect("an effect")
    }
}

#[test]
fn a1_a_hug_offered_to_one_soul_starts_when_accepted_in_time() {
    let mut w = world(3, 0xe8);
    let (b0, b1, b2) = (w.bodies[0], w.bodies[1], w.bodies[2]);
    let offer = w.offer(0, BTreeSet::from([b1]), 1_000);
    let e = w.last();
    assert_eq!(event(e).name.as_str(), OFFER);
    assert_eq!(
        addressed(OFFER, &event(e).fields),
        Some(BTreeSet::from([b1]))
    );
    assert!(w.free(b0) && w.free(b1), "an offer reserves nothing");

    let r = w.accept(2, offer, 2_000).expect_err("Soul 2 was not asked");
    assert_eq!(r.name, "not-asked");
    let pair = w.accept(1, offer, 2_000).expect("accepted in time");
    assert_eq!(
        pair, offer,
        "the first to accept joins the offer's own node"
    );
    assert!(w.acts.started(pair), "the hug started");
    assert!(!w.free(b0) && !w.free(b1), "both bodies are in it");
    assert!(w.free(b2));
    let r = w.accept(1, offer, 2_500).expect_err("answered");
    assert_eq!(r.name, "offer-answered");
    println!("a1: hug offered at 1 ms, accepted and started at 2 ms");
}

#[test]
fn a1_high_fives_offered_to_a_room_start_with_each_soul_in_order_of_arrival() {
    let mut w = world(6, 0xe9);
    let asked = present(&w.tree, &w.c, w.root);
    assert_eq!(asked.len(), 6, "everyone in the room at this instant");
    let offer = w.offer(0, asked, 1_000);
    assert_eq!(
        bodies(event(w.last()).fields.get(&3)).len(),
        5,
        "the asker is not asked"
    );

    let order = [3, 1, 5, 2, 4];
    let mut pairs = Vec::new();
    for (k, who) in order.iter().enumerate() {
        let at = 2_000 + k as Micros * 100;
        pairs.push(w.accept(*who, offer, at).expect("accepted in time"));
    }
    assert_eq!(pairs[0], offer);
    assert_eq!(
        pairs.iter().collect::<BTreeSet<_>>().len(),
        5,
        "each acceptor is a pair with the asker"
    );
    assert!(w.acts.started(pairs[0]));
    assert!(
        pairs[1..].iter().all(|p| !w.acts.started(*p)),
        "the rest wait their turn"
    );

    let mut at = 10_000;
    for (k, who) in order.iter().enumerate() {
        assert!(
            w.acts.started(pairs[k]),
            "high five {k} started in its turn"
        );
        let members: Vec<Id> = w
            .acts
            .members(pairs[k])
            .expect("live")
            .iter()
            .map(|m| m.body)
            .collect();
        assert_eq!(members, vec![w.bodies[0], w.bodies[*who]]);
        w.leave(*who, pairs[k], at);
        w.leave(0, pairs[k], at + 1);
        assert!(w.tree.handle(pairs[k]).is_none(), "high five {k} over");
        at += 1_000;
    }
    assert!(w.bodies.iter().all(|b| w.free(*b)));
    println!(
        "a1: room offer to 5; high fives in order of arrival {order:?}, each started when the one before ended"
    );
}

#[test]
fn a2_a_refused_dance_reaches_the_asker_and_ends_the_offer() {
    let mut w = world(2, 0xea);
    let (b0, b1) = (w.bodies[0], w.bodies[1]);
    let offer = w.offer(0, BTreeSet::from([b1]), 1_000);
    let ask = w.ask(1, 2_000);
    w.acts
        .decline(&mut w.tree, &mut w.due, ask, b1, offer)
        .expect("declined");
    let e = w.last();
    assert_eq!(event(e).name.as_str(), OFFER_DECLINED);
    assert_eq!(
        e.envelope.cause,
        Cause::Intent(ask.intent),
        "a decline is an intent"
    );
    assert_eq!(
        addressed(OFFER_DECLINED, &event(e).fields),
        Some(BTreeSet::from([b0]))
    );
    assert_eq!(bodies(event(e).fields.get(&3)), vec![b1]);
    assert!(
        w.tree.handle(offer).is_none() && w.memberships(b0).is_empty(),
        "the offer ended"
    );
    assert!(w.due.is_empty(), "its lapse is cleared");
    assert_eq!(
        w.accept(1, offer, 3_000).expect_err("gone").name,
        "offer-missing"
    );
    println!("a2: dance declined at 2 ms; souls:offer-declined to the asker; offer ended");
}

#[test]
fn a2_a3_with_no_answer_the_offer_lapses_and_the_asker_is_told() {
    // Soul 1's standing consent lives in its own client (R9). That client is stopped: no accept is sent.
    let mut w = world(3, 0xeb);
    let (b0, b1, b2) = (w.bodies[0], w.bodies[1], w.bodies[2]);
    let offer = w.offer(0, BTreeSet::from([b1, b2]), 1_000);
    let sequence = w.acts.stream.last().expect("the offer").envelope.sequence;
    let ask = w.ask(2, 2_000);
    w.acts
        .decline(&mut w.tree, &mut w.due, ask, b2, offer)
        .expect("declined");
    assert!(
        w.tree.handle(offer).is_some(),
        "Soul 1 has not answered yet"
    );
    w.lapse_until(1_000 + LASTS + 1);
    let e = w.last();
    assert_eq!(event(e).name.as_str(), OFFER_LAPSED);
    assert_eq!(
        (e.envelope.actor, e.envelope.cause),
        (Actor::World, Cause::Effect(sequence)),
        "a lapse is a timer"
    );
    assert_eq!(e.envelope.at, 1_000 + LASTS);
    assert_eq!(
        addressed(OFFER_LAPSED, &event(e).fields),
        Some(BTreeSet::from([b0, b1])),
        "the asker, and the one asked that never answered"
    );
    assert_eq!(
        bodies(event(e).fields.get(&3)),
        vec![b1],
        "the one that did not answer"
    );
    assert!(w.tree.handle(offer).is_none() && w.memberships(b0).is_empty());
    assert_eq!(
        w.accept(1, offer, 1_000 + LASTS + 2)
            .expect_err("too late")
            .name,
        "offer-missing"
    );
    println!(
        "a2/a3: no answer from Soul 1; souls:offer-lapsed at {} µs to the asker and to Soul 1",
        1_000 + LASTS
    );
}

#[test]
fn a2_a_pair_left_waiting_past_its_own_expiry_lapses_and_the_next_one_starts() {
    let mut w = world(4, 0xec);
    let asked = present(&w.tree, &w.c, w.root);
    let offer = w.offer(0, asked, 1_000);
    let first = w.accept(1, offer, 2_000).expect("accepted");
    let late = w.accept(2, offer, 3_000).expect("accepted");
    let last = w.accept(3, offer, 3_000 + LASTS / 2).expect("accepted");
    // The asker stays in the first high five past the second pair's expiry.
    w.lapse_until(3_000 + LASTS + 1);
    let lapsed: Vec<&Effect> = w
        .acts
        .stream
        .iter()
        .filter(|e| event(e).name.as_str() == OFFER_LAPSED)
        .collect();
    assert_eq!(lapsed.len(), 1);
    assert_eq!(bodies(event(lapsed[0]).fields.get(&3)), vec![w.bodies[2]]);
    assert!(w.tree.handle(late).is_none());
    w.leave(1, first, 3_000 + LASTS + 10);
    w.leave(0, first, 3_000 + LASTS + 11);
    assert!(w.acts.started(last), "the next pair in time starts");
    println!("a2: a pair waiting past its own expiry lapsed; the next started");
}

#[test]
fn a4_an_offer_to_a_hall_of_300_is_one_effect() {
    let mut w = world(301, 0xed);
    let asked = present(&w.tree, &w.c, w.root);
    let before = w.acts.stream.len();
    let offer = w.offer(0, asked, 1_000);
    assert_eq!(w.acts.stream.len(), before + 1, "one effect");
    let e = w.last();
    let to = addressed(OFFER, &event(e).fields).expect("addressed");
    assert_eq!(to.len(), 300);
    assert!(!to.contains(&w.bodies[0]));
    assert!(w.tree.handle(offer).is_some());
    println!("a4: offer to 300 in the hall: 1 effect, 300 bodies addressed");
}

/// 0.135 C5: a kind of three roles is offered only when several take its third, as a crew's carry's sides do. A kind
/// whose three roles one each take (frisbee's) is refused `offer-kind-not-a-pair`, and so is an offer in the third
/// role. A crew's first accept makes the pair, which starts; each accept after it joins that one activity in the third
/// role.
#[test]
fn c5_three_roles_are_offered_only_when_several_take_the_third() {
    let with = |most: usize| {
        let mut k = super::pair();
        let mut side = k.roles[1].clone();
        side.name = n("test:side");
        k.roles.push(side);
        k.most = most;
        let mut w = world(4, 0xc5);
        let next = w.tree.to_state().next;
        w.acts = crate::activity::Activities::new(
            super::header(w.root),
            super::rules(&w.souls),
            next,
            vec![k],
        );
        w
    };
    let offer_in = |w: &mut World, role: &str| {
        let ask = w.ask(0, 1_000);
        let body = w.bodies[0];
        let asked = w.bodies[1..].iter().copied().collect();
        w.acts.offer(
            &mut w.tree,
            &mut w.mint,
            &mut w.due,
            ask,
            body,
            &n(PAIR),
            &n(role),
            w.root,
            asked,
            None,
        )
    };
    let mut frisbee = with(3);
    let r = offer_in(&mut frisbee, "test:first").expect_err("one each take its three roles");
    assert_eq!(r.name, "offer-kind-not-a-pair");
    let mut crew = with(6);
    let r = offer_in(&mut crew, "test:side").expect_err("offered in the role several take");
    assert_eq!(r.name, "offer-kind-not-a-pair");
    let offer = offer_in(&mut crew, "test:first").expect("a crew's carry offered");
    for who in 1..4 {
        let joined = crew.accept(who, offer, 2_000).expect("accepted");
        assert_eq!(joined, offer, "each joins the one activity");
    }
    assert!(
        crew.acts.started(offer),
        "it started with its first two roles"
    );
    let roles: Vec<&str> = crew
        .acts
        .members(offer)
        .expect("members")
        .iter()
        .map(|m| m.role.as_str())
        .collect();
    assert_eq!(
        roles,
        ["test:first", "test:second", "test:side", "test:side"]
    );
}

/// A crew accepted while its members are held elsewhere (its back and a side each still in another activity) starts
/// once the last of them is free, the side included, and until then says why it has not: the refusal its start last
/// met, naming the body held and what holds it (the rack trial's crew of four that joined and never started).
#[test]
fn c5_a_crew_whose_members_were_held_starts_when_the_last_is_free() {
    let mut k = super::pair();
    let mut side = k.roles[1].clone();
    side.name = n("test:side");
    k.roles.push(side);
    k.most = 6;
    let mut w = world(6, 0xc6);
    let next = w.tree.to_state().next;
    w.acts = crate::activity::Activities::new(
        super::header(w.root),
        super::rules(&w.souls),
        next,
        vec![k],
    );
    let back_held = w.pair(1, 4, 500);
    let side_held = w.pair(2, 5, 500);
    let asked = w.bodies[1..4].iter().copied().collect();
    let offer = w.offer(0, asked, 1_000);
    for who in 1..4 {
        assert_eq!(w.accept(who, offer, 2_000).expect("accepted"), offer);
    }
    assert!(!w.acts.started(offer), "its back is held elsewhere");
    let why = w.acts.unstarted_why(offer).expect("a reason");
    assert!(why.contains("body-in-activity"), "{why}");
    w.leave(1, back_held, 3_000);
    assert!(!w.acts.started(offer), "its side is still held elsewhere");
    let why = w.acts.unstarted_why(offer).expect("a reason");
    assert!(
        why.contains(&show(w.bodies[2])),
        "names the side held: {why}"
    );
    w.leave(2, side_held, 4_000);
    assert!(w.acts.started(offer), "it starts once its side is free");
    assert_eq!(w.acts.unstarted_why(offer), None);
    assert_eq!(w.acts.members(offer).map(<[_]>::len), Some(4));
}

/// Trial of 25 Nov: two Souls talking (a started conversation holds both) offered and accepted a follow, and it never
/// started (`body-in-activity`), lapsing with no reason. A conversation claims one voice: a pair offered and accepted
/// by two who talk starts at the accept, a third Soul's pair with one of them too; the conversation goes on through
/// both and after the pair is left, and a second conversation is still refused while the first holds the body.
#[test]
fn e26_two_souls_talking_start_another_activity_and_go_on_talking() {
    let mut w = world(3, 0x9c);
    let (b0, b1, b2) = (w.bodies[0], w.bodies[1], w.bodies[2]);
    w.acts = super::Activities::new(
        w.acts.header.clone(),
        w.acts.rules.clone(),
        w.tree.to_state().next,
        vec![super::pair(), super::talk()],
    );
    // The two talk: a conversation, started.
    let ask = w.ask(0, 1_000);
    let talk = w
        .acts
        .propose(&mut w.tree, &mut w.mint, ask, &n(super::TALK), w.root)
        .expect("proposed");
    for (who, role) in [(0, "souls:opener"), (1, "souls:member")] {
        let ask = w.ask(who, 1_000);
        let body = w.bodies[who];
        w.acts
            .join(&mut w.tree, &mut w.mint, ask, body, talk, &n(role), 1)
            .expect("joined");
    }
    let ask = w.ask(0, 1_000);
    w.acts
        .start(&mut w.tree, &mut w.c, ask, talk)
        .expect("talking");
    assert_eq!(w.acts.holder(b0), Some(talk));

    // While talking, one offers the other a pair (a follow, a hug, a dance), and it starts at the accept.
    let offer = w.offer(0, BTreeSet::from([b1]), 2_000);
    let pair = w.accept(1, offer, 3_000).expect("accepted");
    assert!(w.acts.started(pair), "started while both talk");
    assert_eq!(w.acts.holder(b1), Some(pair), "the pair holds it");

    // A conversation is still one at a time: a second one with the third Soul is refused while the first holds b1.
    let ask = w.ask(2, 4_000);
    let other = w
        .acts
        .propose(&mut w.tree, &mut w.mint, ask, &n(super::TALK), w.root)
        .expect("proposed");
    for (who, role) in [(2, "souls:opener"), (1, "souls:member")] {
        let ask = w.ask(who, 4_000);
        let body = w.bodies[who];
        w.acts
            .join(&mut w.tree, &mut w.mint, ask, body, other, &n(role), 1)
            .expect("joined");
    }
    let ask = w.ask(2, 4_000);
    let r = w
        .acts
        .start(&mut w.tree, &mut w.c, ask, other)
        .expect_err("b1 talks already");
    assert_eq!(r.name, "body-in-activity");
    assert!(w.free(b2), "nothing claimed for the refused one");

    // The pair left, both still talk.
    w.leave(1, pair, 5_000);
    w.leave(0, pair, 5_000);
    w.run(10_000_000);
    assert_eq!(w.acts.holder(b0), Some(talk), "still talking");
    assert_eq!(w.acts.holder(b1), Some(talk), "still talking");
    assert!(w.acts.started(talk));
    println!("e26: a pair started at the accept between two who talk; the talk went on after it");
}

/// A second of world time.
const S: Micros = 1_000_000;

/// A world of `k` Souls whose pair kind is a crew's: a third role several take, up to `most` members (0.135 C5).
fn crew_world(k: usize, most: usize, seed: u8) -> World {
    let mut kind = super::pair();
    let mut side = kind.roles[1].clone();
    side.name = n("test:side");
    kind.roles.push(side);
    kind.most = most;
    let mut w = world(k, seed);
    let next = w.tree.to_state().next;
    w.acts = crate::activity::Activities::new(
        super::header(w.root),
        super::rules(&w.souls),
        next,
        vec![kind],
    );
    w
}

fn lapses(w: &World) -> Vec<(Micros, Vec<Id>)> {
    w.acts
        .stream
        .iter()
        .filter(|e| event(e).name.as_str() == OFFER_LAPSED)
        .map(|e| (e.envelope.at, bodies(event(e).fields.get(&3))))
        .collect()
}

/// The Mars Lab rehearsal (26 Nov): a crew of six whose agents each took a while; the sixth accept came 68 s after the
/// offer and found it gone. Each accept now keeps the offer open a minute more: five accepts 15 s apart (the last
/// 75 s after the offer, past the kind's minute) make the crew of six, and the offer and each join say how long.
#[test]
fn crew_of_six_accepting_15_s_apart_forms_past_the_kinds_minute() {
    let mut w = crew_world(6, 6, 0xd1);
    let asked: BTreeSet<Id> = w.bodies[1..].iter().copied().collect();
    let made: Micros = 1_000;
    let offer = w.offer(0, asked, made);
    let f = &event(w.last()).fields;
    let uint = |m: Micros| Some(Value::Uint(m as u64));
    assert_eq!(f.get(&4).cloned(), uint(made + LASTS), "open a minute");
    assert_eq!(
        f.get(&7).cloned(),
        uint(LASTS),
        "each accept keeps it open a minute more"
    );
    assert_eq!(
        f.get(&8).cloned(),
        uint(made + OPEN_MOST * LASTS),
        "and never past five"
    );
    for who in 1..6 {
        let at = made + who as Micros * 15 * S;
        // The world's ticks run every timer due before the accept arrives.
        w.lapse_until(at);
        let joined = w
            .accept(who, offer, at)
            .unwrap_or_else(|r| panic!("accept {who} at {} s: {}", at / S, r.name));
        assert_eq!(joined, offer, "each joins the one crew");
        // The join's own event (the first accept also starts the crew, written after it).
        let e = w
            .acts
            .stream
            .iter()
            .rev()
            .filter_map(|e| e.events.as_ref().and_then(|v| v.first()))
            .find(|e| e.name.as_str() == "souls:activity-joined")
            .expect("a join");
        let renewed = if who < 5 { uint(at + LASTS) } else { None };
        assert_eq!(
            e.fields.get(&2).cloned(),
            renewed,
            "accept {who} renews it a minute from now; the last answer leaves nothing to wait for"
        );
    }
    assert!(w.acts.started(offer));
    assert_eq!(
        w.acts.members(offer).map(<[_]>::len),
        Some(6),
        "a crew of six"
    );
    w.lapse_until(made + 10 * LASTS);
    assert!(
        lapses(&w).is_empty(),
        "every Soul asked answered: nothing lapsed"
    );
    assert!(w.acts.started(offer), "the crew carries on");
    assert!(w.acts.offers.open.is_empty() && w.due.is_empty());
    println!("crew: six formed from accepts 15 s apart, the last 75 s after the offer");
}

/// A crew offered that nobody accepts lapses a minute after it was made, named `souls:offer-lapsed` to the asker and
/// to each Soul asked; its node goes and no one is held.
#[test]
fn a_crew_offer_nobody_accepts_lapses_by_name() {
    let mut w = crew_world(4, 6, 0xd2);
    let asked: Vec<Id> = w.bodies[1..].to_vec();
    let offer = w.offer(0, asked.iter().copied().collect(), 1_000);
    w.lapse_until(1_000 + LASTS);
    assert!(
        w.tree.handle(offer).is_some(),
        "still open until its minute is up"
    );
    w.lapse_until(1_000 + LASTS + 1);
    assert_eq!(lapses(&w), vec![(1_000 + LASTS, asked.clone())]);
    let e = w.last();
    let mut to: BTreeSet<Id> = asked.iter().copied().collect();
    to.insert(w.bodies[0]);
    assert_eq!(addressed(OFFER_LAPSED, &event(e).fields), Some(to));
    assert!(w.tree.handle(offer).is_none(), "its node went");
    assert!(
        w.bodies
            .iter()
            .all(|b| w.free(*b) && w.memberships(*b).is_empty())
    );
    assert!(w.acts.offers.open.is_empty() && w.due.is_empty());
    assert_eq!(
        w.accept(1, offer, 1_000 + LASTS + 2)
            .expect_err("lapsed")
            .name,
        "offer-missing"
    );
}

/// Nobody is held by a lapsed offer: a crew whose back is held elsewhere never starts, and when no more accept its
/// renewed lapse ends the offer and its waiting node together (the two who joined are let go, those never answering
/// named). Renewals stop at five of the kind's minutes: an accept after that finds the offer gone.
#[test]
fn nobody_is_held_by_a_lapsed_crew_offer() {
    let mut w = crew_world(6, 6, 0xd3);
    let held = w.pair(1, 5, 500);
    let asked: BTreeSet<Id> = w.bodies[1..5].iter().copied().collect();
    let offer = w.offer(0, asked, 1_000);
    w.accept(1, offer, 10 * S).expect("accepted");
    assert!(!w.acts.started(offer), "its back is held elsewhere");
    w.accept(2, offer, 50 * S).expect("joined");
    // The first pair's own wait (10 s + a minute) is renewed with the offer: nothing lapses before 110 s.
    w.lapse_until(50 * S + LASTS);
    assert!(lapses(&w).is_empty() && w.tree.handle(offer).is_some());
    w.lapse_until(50 * S + LASTS + 1);
    let gone = lapses(&w);
    assert_eq!(gone.len(), 2, "the offer and its waiting pair: {gone:?}");
    assert!(gone.iter().all(|(at, _)| *at == 50 * S + LASTS));
    assert!(
        gone.contains(&(50 * S + LASTS, vec![w.bodies[3], w.bodies[4]])),
        "those that never answered"
    );
    assert!(
        gone.contains(&(50 * S + LASTS, vec![w.bodies[1], w.bodies[2]])),
        "and both who joined, told by name"
    );
    assert!(w.tree.handle(offer).is_none(), "its node went");
    for b in [0, 2, 3, 4] {
        assert!(
            w.free(w.bodies[b]) && w.memberships(w.bodies[b]).is_empty(),
            "Soul {b} is held by nothing"
        );
    }
    assert!(w.memberships(w.bodies[0]).is_empty());
    assert!(w.acts.started(held), "the back's other activity goes on");
    assert!(w.acts.offers.open.is_empty() && w.acts.offers.pairs.is_empty() && w.due.is_empty());

    // The bound: accepts 55 s apart renew it to five minutes after the offer at most.
    let mut w = crew_world(8, 8, 0xd4);
    let made: Micros = 1_000;
    let asked: BTreeSet<Id> = w.bodies[1..].iter().copied().collect();
    let offer = w.offer(0, asked, made);
    for who in 1..6 {
        let at = made + who as Micros * 55 * S;
        w.lapse_until(at);
        w.accept(who, offer, at).expect("accepted in time");
    }
    let latest = made + OPEN_MOST * LASTS;
    w.lapse_until(made + 330 * S);
    assert_eq!(lapses(&w), vec![(latest, vec![w.bodies[6], w.bodies[7]])]);
    assert_eq!(
        w.accept(6, offer, made + 330 * S)
            .expect_err("past the bound")
            .name,
        "offer-missing"
    );
    assert_eq!(
        w.acts.members(offer).map(<[_]>::len),
        Some(6),
        "the crew that formed carries on"
    );
    assert!(w.acts.offers.open.is_empty() && w.due.is_empty());
}
