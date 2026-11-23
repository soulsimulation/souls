//! 0.133 R4, the give (the smallest part of E24, #2793): a held book offered to another Soul and accepted ends in a
//! free hand of the one who accepted, and the offer ends; at the accept the world checks again that the
//! giver still holds it (`give.not-held`), that the two stand within reach on one floor (`give.too-far`), and that the
//! taker has a free hand (`give.no-free-hand`), and a refused accept leaves the offer open. `cargo test -p sim give`.

use std::collections::{BTreeMap, BTreeSet};

use replica::effects::{Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Rest};
use replica::ids::Id;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::time::Micros;
use replica::world_model::Audience;

use super::{BOOK, PAIR, World, family, header, n, part, rules, world};
use crate::activity::offer::GIVEN;
use crate::slots::hands::hands;

impl World {
    /// A new book, in hand `hand` (0 or 1) of body `who`, written by the world.
    fn hold(&mut self, who: usize, hand: usize) -> Id {
        let book = self.mint.mint().expect("an id");
        let slot = hands(&family())[hand].slot;
        let at = self.tree.to_state().next;
        let effect = Effect {
            envelope: Envelope {
                sequence: at,
                at: 0,
                cause: Cause::World,
                actor: Actor::World,
                audience: Audience::Everyone,
                node: self.bodies[who],
            },
            body: Body::Changes(vec![ChangeRec {
                change: Change::Create {
                    node: book,
                    kind: n(BOOK),
                    pose: Pose {
                        frame: Frame {
                            node: self.bodies[who],
                            slot: Some(slot),
                        },
                        position: Vec3::ZERO,
                        orientation: Quat::IDENTITY,
                        support: Support::Slot,
                    },
                    audience: Audience::Everyone,
                    fields: BTreeMap::new(),
                },
                rest: Rest::new(),
            }]),
            events: None,
            rest: Rest::new(),
        };
        let header = header(self.root);
        self.tree
            .commit(&header, &part(&header, &[effect]), &rules(&self.souls))
            .expect("the book held");
        self.acts.next = self.tree.to_state().next;
        book
    }

    /// Soul `who` offers `book` to body `to`, as a give of the pair kind.
    fn give(
        &mut self,
        who: usize,
        to: usize,
        book: Id,
        at: Micros,
    ) -> Result<Id, replica::effects::Refusal> {
        let ask = self.ask(who, at);
        let (body, asked) = (self.bodies[who], BTreeSet::from([self.bodies[to]]));
        self.acts.offer(
            &mut self.tree,
            &mut self.mint,
            &mut self.due,
            ask,
            body,
            &n(PAIR),
            &n("test:first"),
            self.root,
            asked,
            Some(book),
        )
    }

    fn take(&mut self, who: usize, offer: Id, at: Micros) -> Result<Id, replica::effects::Refusal> {
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

    /// The body and slot that hold `thing`.
    fn held_by(&self, thing: Id) -> (Option<Id>, Option<u64>) {
        let n = self
            .tree
            .handle(thing)
            .and_then(|h| self.tree.node(h))
            .expect("the thing");
        (n.parent(), n.slot())
    }
}

#[test]
fn a_book_given_and_accepted_ends_in_the_takers_free_hand() {
    let mut w = world(2, 41);
    let book = w.hold(0, 0);
    let offer = w.give(0, 1, book, 1_000).expect("offered");
    let before = w.acts.stream.len();
    assert_eq!(w.take(1, offer, 2_000).expect("accepted"), offer);
    let (parent, slot) = w.held_by(book);
    assert_eq!(parent, Some(w.bodies[1]), "in the taker's hand");
    assert_eq!(slot, Some(hands(&family())[0].slot), "its first free hand");
    // The transfer's leave and arrive (one part, as a hand's take), then the offer's end with the given event.
    let part = &w.acts.stream[before..];
    println!("give: {} effects", part.len());
    assert_eq!(part.len(), 3);
    assert!(
        part[..2]
            .iter()
            .all(|e| matches!(e.body, Body::Transfer(_))),
        "the transfer first"
    );
    let event = part[2]
        .events
        .as_ref()
        .and_then(|e| e.first())
        .expect("an event");
    assert_eq!(event.name.as_str(), GIVEN);
    assert!(
        w.tree.handle(offer).is_none(),
        "a give makes no activity node"
    );
    assert_eq!(
        w.take(1, offer, 3_000).expect_err("answered").name,
        "offer-missing",
        "a give is accepted once"
    );
}

#[test]
fn refused_by_name_and_the_offer_stays_open() {
    // Too far: bodies 0 and 2 stand 2 m apart.
    let mut w = world(3, 42);
    let book = w.hold(0, 0);
    let offer = w.give(0, 2, book, 1_000).expect("offered");
    assert_eq!(
        w.take(2, offer, 2_000).expect_err("too far").name,
        "give.too-far"
    );
    assert_eq!(w.held_by(book).0, Some(w.bodies[0]), "still the giver's");
    // No free hand: the taker holds a book in each hand; the offer stays open, and after a hand is free it goes.
    let mut w = world(2, 43);
    let book = w.hold(0, 0);
    let full = [w.hold(1, 0), w.hold(1, 1)];
    let offer = w.give(0, 1, book, 1_000).expect("offered");
    assert_eq!(
        w.take(1, offer, 2_000).expect_err("hands full").name,
        "give.no-free-hand"
    );
    assert_eq!(w.held_by(book).0, Some(w.bodies[0]));
    assert_eq!(w.held_by(full[0]).0, Some(w.bodies[1]));
    // Not held: offering what another holds, and accepting once the giver no longer holds it.
    let mut w = world(2, 44);
    let book = w.hold(0, 0);
    assert_eq!(
        w.give(1, 0, book, 1_000).expect_err("not held").name,
        "give.not-held"
    );
    let offer = w.give(0, 1, book, 1_000).expect("offered");
    let other = w.give(0, 1, book, 1_100).expect("offered twice");
    w.take(1, offer, 2_000).expect("the first accepted");
    assert_eq!(
        w.take(1, other, 2_100).expect_err("gone").name,
        "give.not-held"
    );
}
