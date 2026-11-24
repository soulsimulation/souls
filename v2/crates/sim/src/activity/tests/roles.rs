//! B10's checks (#4239): an accepted role binds to the activity's thing. A pair offered at a thing whose kind its
//! roles' links are on gives each member its role's link on that thing, in the same part as the membership, acted
//! and caused as the join; the links go when the member leaves, when the offer lapses and when the activity ends. A
//! pair offered on the open ground binds nothing. `cargo test -p sim activity::tests::roles -- --nocapture`.

use std::collections::{BTreeMap, BTreeSet};

use replica::activity::RoleLink;
use replica::effects::{Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Rest};
use replica::ids::Id;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::world_model::{Audience, plain};

use super::{BOOK, PAIR, World, n, part, world};

/// A game board: the fixture's book, on the ground, taking the pair as its child, the pair's roles' links on it.
fn board(w: &mut World) -> Id {
    let plain_book = plain(BOOK).to_owned();
    for (role, k) in w
        .acts
        .kinds
        .get_mut(&n(PAIR))
        .expect("the pair")
        .roles
        .iter_mut()
        .zip(0..)
    {
        role.link = Some(RoleLink {
            ty: n(["test:first", "test:second"][k]),
            soul: false,
            on: plain_book.clone(),
        });
    }
    let rules = &mut w.acts.rules;
    for (k, kind) in rules.kinds.iter_mut() {
        if plain(k) == "test:ground" {
            kind.children.insert("thing".into());
        }
        if k == BOOK {
            kind.children.insert(plain(PAIR).into());
        }
    }
    let board = w.mint.mint().expect("an id");
    let e = Effect {
        envelope: Envelope {
            sequence: w.tree.to_state().next,
            at: 0,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node: w.root,
        },
        body: Body::Changes(vec![ChangeRec {
            change: Change::Create {
                node: board,
                kind: n(BOOK),
                pose: Pose {
                    frame: Frame {
                        node: w.root,
                        slot: None,
                    },
                    position: Vec3::new(500_000, 0, 500_000),
                    orientation: Quat::IDENTITY,
                    support: Support::Surface {
                        surface: w.root,
                        height: 0,
                    },
                },
                audience: Audience::Everyone,
                fields: BTreeMap::new(),
            },
            rest: Rest::new(),
        }]),
        events: None,
        rest: Rest::new(),
    };
    let header = w.acts.header.clone();
    w.tree
        .commit(&header, &part(&header, &[e]), &w.acts.rules)
        .expect("the board");
    w.acts.next = w.tree.to_state().next;
    board
}

/// The bodies `thing` is linked to by type `ty`.
fn linked(w: &World, thing: Id, ty: &str) -> BTreeSet<Id> {
    w.tree
        .links_at(thing)
        .iter()
        .filter(|e| w.tree.ty(e).as_str() == ty)
        .map(|e| e.other)
        .collect()
}

/// The effects written since `from` (an index into the stream) that link or unlink at `node`.
fn at_node(w: &World, from: usize, node: Id) -> Vec<&Effect> {
    w.acts.stream[from..]
        .iter()
        .filter(|e| e.envelope.node == node)
        .filter(|e| {
            e.changes()
                .iter()
                .any(|c| matches!(c.change, Change::Link { .. } | Change::Unlink { .. }))
        })
        .collect()
}

#[test]
fn b10_an_accepted_role_gives_its_member_the_role_link_on_the_activitys_thing() {
    let mut w = world(3, 0xb1);
    let (b0, b1, b2) = (w.bodies[0], w.bodies[1], w.bodies[2]);
    let board = board(&mut w);

    // Offered at the board: the asker holds its role's link at once, in the offer's own part, caused by its intent.
    let ask = w.ask(0, 1_000);
    let from = w.acts.stream.len();
    let offer = w
        .acts
        .offer(
            &mut w.tree,
            &mut w.mint,
            &mut w.due,
            ask,
            b0,
            &n(PAIR),
            &n("test:first"),
            board,
            BTreeSet::from([b1]),
            None,
        )
        .expect("offered at the board");
    assert_eq!(linked(&w, board, "test:first"), BTreeSet::from([b0]));
    assert!(linked(&w, board, "test:second").is_empty());
    let written = at_node(&w, from, board);
    assert_eq!(written.len(), 1, "one entry at the board");
    assert_eq!(written[0].envelope.cause, Cause::Intent(ask.intent));
    assert_eq!(written[0].envelope.actor, Actor::Soul(ask.soul));

    // Accepted: the other side's link, caused by the accept.
    let from = w.acts.stream.len();
    let pair = w.accept(1, offer, 2_000).expect("accepted");
    assert_eq!(pair, offer);
    assert_eq!(linked(&w, board, "test:second"), BTreeSet::from([b1]));
    let written = at_node(&w, from, board);
    assert_eq!(written.len(), 1);
    assert_eq!(written[0].envelope.actor, Actor::Soul(w.souls[1]));
    assert!(matches!(written[0].envelope.cause, Cause::Intent(_)));
    assert!(!linked(&w, board, "test:first").contains(&b2));

    // A leave takes the leaver's link down, in its own part; the other keeps its own.
    let from = w.acts.stream.len();
    w.leave(1, pair, 3_000);
    assert!(linked(&w, board, "test:second").is_empty(), "the leaver's link is gone");
    assert_eq!(linked(&w, board, "test:first"), BTreeSet::from([b0]));
    assert_eq!(at_node(&w, from, board).len(), 1);
    // The last leave ends the activity, and its links with it.
    w.leave(0, pair, 3_500);
    assert!(w.acts.members(pair).is_none(), "the activity ended");
    assert!(linked(&w, board, "test:first").is_empty());
    println!("b10: offered and accepted at the board, both sides linked; each leave took its own link down");
}

#[test]
fn b10_a_lapsed_offer_takes_its_askers_link_down_and_the_ground_binds_nothing() {
    let mut w = world(3, 0xb2);
    let (b0, b1) = (w.bodies[0], w.bodies[1]);
    let board = board(&mut w);
    let ask = w.ask(0, 1_000);
    w.acts
        .offer(
            &mut w.tree,
            &mut w.mint,
            &mut w.due,
            ask,
            b0,
            &n(PAIR),
            &n("test:first"),
            board,
            BTreeSet::from([b1]),
            None,
        )
        .expect("offered");
    assert_eq!(linked(&w, board, "test:first"), BTreeSet::from([b0]));
    w.lapse_until(120_000_000);
    assert!(linked(&w, board, "test:first").is_empty(), "lapsed: no link left");

    // On the open ground nothing is the activity's thing: no role link is written anywhere.
    let from = w.acts.stream.len();
    let offer = w.offer(0, BTreeSet::from([b1]), 130_000_000);
    w.accept(1, offer, 130_001_000).expect("accepted on the ground");
    let links: usize = w.acts.stream[from..]
        .iter()
        .flat_map(|e| e.changes())
        .filter(|c| matches!(&c.change, Change::Link { ty, .. } if ty.as_str().starts_with("test:")))
        .count();
    assert_eq!(links, 0, "no role link on the ground");
    assert!(linked(&w, board, "test:second").is_empty());
}
