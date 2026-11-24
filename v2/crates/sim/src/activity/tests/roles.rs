//! B10's checks (#4239): an accepted role binds to the activity's thing. A pair offered at a thing whose kind its
//! roles' links are on gives each member its role's link on that thing, in the same part as the membership, acted
//! and caused as the join; the links go when the member leaves, when the offer lapses and when the activity ends. A
//! pair offered on the open ground binds nothing. `cargo test -p sim activity::tests::roles -- --nocapture`.

use std::collections::{BTreeMap, BTreeSet};

use replica::activity::RoleLink;
use replica::effects::{Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Refusal, Rest};
use replica::ids::Id;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::time::Micros;
use replica::world_model::{Audience, plain};

use super::{Activities, BOOK, PAIR, World, n, part, world};
use crate::activity::ENDED;
use crate::timers::DueList;

/// A game board: the fixture's book, on the ground, taking the pair as its child, the pair's roles' links on it.
fn board(w: &mut World) -> Id {
    board_of(w, [Some(1), Some(1)])
}

/// [`board`] whose two roles take `most` each.
fn board_of(w: &mut World, most: [Option<u64>; 2]) -> Id {
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
            most: most[k],
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

/// The effects written since `from` (an index into the stream) that write or take down a role link at `node`.
fn at_node(w: &World, from: usize, node: Id) -> Vec<&Effect> {
    w.acts.stream[from..]
        .iter()
        .filter(|e| e.envelope.node == node)
        .filter(|e| {
            e.changes().iter().any(|c| match &c.change {
                Change::Link { ty, .. } => ty.as_str().starts_with("test:"),
                Change::Unlink { .. } => true,
                _ => false,
            })
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
    assert!(
        linked(&w, board, "test:second").is_empty(),
        "the leaver's link is gone"
    );
    assert_eq!(linked(&w, board, "test:first"), BTreeSet::from([b0]));
    assert_eq!(at_node(&w, from, board).len(), 1);
    // The last leave ends the activity, and its links with it.
    w.leave(0, pair, 3_500);
    assert!(w.acts.members(pair).is_none(), "the activity ended");
    assert!(linked(&w, board, "test:first").is_empty());
    println!(
        "b10: offered and accepted at the board, both sides linked; each leave took its own link down"
    );
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
    assert!(
        linked(&w, board, "test:first").is_empty(),
        "lapsed: no link left"
    );

    // On the open ground nothing is the activity's thing: no role link is written anywhere.
    let from = w.acts.stream.len();
    let offer = w.offer(0, BTreeSet::from([b1]), 130_000_000);
    w.accept(1, offer, 130_001_000)
        .expect("accepted on the ground");
    let links: usize = w.acts.stream[from..]
        .iter()
        .flat_map(|e| e.changes())
        .filter(
            |c| matches!(&c.change, Change::Link { ty, .. } if ty.as_str().starts_with("test:")),
        )
        .count();
    assert_eq!(links, 0, "no role link on the ground");
    assert!(linked(&w, board, "test:second").is_empty());
}

impl World {
    /// Soul `who` offers the pair at `place` in `role` to `asked`.
    fn offer_at(
        &mut self,
        who: usize,
        place: Id,
        role: &str,
        asked: BTreeSet<Id>,
        at: Micros,
    ) -> Result<Id, Refusal> {
        let ask = self.ask(who, at);
        let body = self.bodies[who];
        self.acts.offer(
            &mut self.tree,
            &mut self.mint,
            &mut self.due,
            ask,
            body,
            &n(PAIR),
            &n(role),
            place,
            asked,
            None,
        )
    }

    /// A new process: the activities read back from the tree, a new controller and due list.
    fn restart(&mut self) {
        let kinds = self.acts.kinds.values().cloned().collect();
        let mut c = super::controller(self.root, &self.bodies);
        self.acts = Activities::restore(
            self.acts.header.clone(),
            self.acts.rules.clone(),
            kinds,
            &self.tree,
            &mut c,
        )
        .expect("restored");
        self.c = c;
        self.due = DueList::new();
    }

    /// Whether any activity holds `body`.
    fn held(&self, body: Id) -> bool {
        self.acts.holder(body).is_some()
    }
}

#[test]
fn b10_a_role_held_on_the_thing_is_not_taken_by_a_second_soul_three_ways() {
    let mut w = world(4, 0xb3);
    let (b0, b1, b2, b3) = (w.bodies[0], w.bodies[1], w.bodies[2], w.bodies[3]);
    let board = board(&mut w);
    // 1. One offer, two accepts: the second would make a second pair in the second side, which holds one.
    let offer = w
        .offer_at(0, board, "test:first", BTreeSet::from([b1, b2]), 1_000)
        .expect("offered");
    w.accept(1, offer, 2_000).expect("the first accept");
    let r = w
        .accept(2, offer, 2_500)
        .expect_err("the second side is held");
    assert_eq!(r.name, "role-taken", "{}", r.detail);
    assert_eq!(linked(&w, board, "test:second"), BTreeSet::from([b1]));
    // 2. A second offer at the same board in the first side, which b0 holds.
    let r = w
        .offer_at(2, board, "test:first", BTreeSet::from([b3]), 3_000)
        .expect_err("the first side is held");
    assert_eq!(r.name, "role-taken");
    // 3. Propose and join: the proposal is made, the join in a held role refused, in either side.
    let ask = w.ask(3, 4_000);
    let proposal = w
        .acts
        .propose(&mut w.tree, &mut w.mint, ask, &n(PAIR), board)
        .expect("proposed");
    for role in ["test:first", "test:second"] {
        let ask = w.ask(3, 4_000);
        let r = w
            .acts
            .join(&mut w.tree, &mut w.mint, ask, b3, proposal, &n(role), 1)
            .expect_err("held");
        assert_eq!(r.name, "role-taken", "{role}");
    }
    assert_eq!(linked(&w, board, "test:first"), BTreeSet::from([b0]));
    assert_eq!(linked(&w, board, "test:second"), BTreeSet::from([b1]));
    // An offer asks bodies only.
    let root = w.root;
    let r = w
        .offer_at(3, root, "test:first", BTreeSet::from([board]), 5_000)
        .expect_err("a board is not a body");
    assert_eq!(r.name, "offer-asked-not-a-body");
}

#[test]
fn b10_after_a_restart_a_pending_offer_and_a_waiting_pair_lapse_and_take_their_links_down() {
    let mut w = world(3, 0xb4);
    let (b0, b1, b2) = (w.bodies[0], w.bodies[1], w.bodies[2]);
    // The second side takes two, so a second accept waits as its own pair behind the first.
    let board = board_of(&mut w, [Some(1), Some(2)]);
    let offer = w
        .offer_at(0, board, "test:first", BTreeSet::from([b1, b2]), 1_000)
        .expect("offered");
    let first = w.accept(1, offer, 2_000).expect("accepted");
    assert!(w.acts.started(first));
    let waiting = w.accept(2, offer, 3_000).expect("accepted, waiting");
    assert!(!w.acts.started(waiting), "the asker is in the first pair");
    assert_eq!(linked(&w, board, "test:second"), BTreeSet::from([b1, b2]));
    w.restart();
    // Not yet: nothing ends before its expiry.
    assert!(w.acts.expire(&mut w.tree, 60_000_000).is_empty());
    let ended = w.acts.expire(&mut w.tree, 63_000_000);
    assert_eq!(
        ended,
        vec![waiting],
        "the waiting pair lapses at its expiry"
    );
    assert_eq!(
        linked(&w, board, "test:second"),
        BTreeSet::from([b1]),
        "its link went with it"
    );
    assert_eq!(
        linked(&w, board, "test:first"),
        BTreeSet::from([b0]),
        "the started game keeps its own"
    );

    // A pending offer that a restart did not keep.
    let mut w = world(2, 0xb5);
    let (b0, b1) = (w.bodies[0], w.bodies[1]);
    let board = board_of(&mut w, [Some(1), Some(1)]);
    let offer = w
        .offer_at(0, board, "test:first", BTreeSet::from([b1]), 1_000)
        .expect("offered");
    w.restart();
    assert_eq!(w.acts.expire(&mut w.tree, 61_000_000), vec![offer]);
    assert!(
        linked(&w, board, "test:first").is_empty(),
        "no link outlives the offer"
    );
    assert!(!w.held(b0));
}

#[test]
fn b10_an_expired_proposal_ends_with_its_links_with_or_without_a_restart() {
    for restart in [false, true] {
        let mut w = world(2, 0xb6);
        let b0 = w.bodies[0];
        let board = board(&mut w);
        let ask = w.ask(0, 1_000);
        let p = w
            .acts
            .propose(&mut w.tree, &mut w.mint, ask, &n(PAIR), board)
            .expect("proposed");
        let ask = w.ask(0, 1_000);
        w.acts
            .join(&mut w.tree, &mut w.mint, ask, b0, p, &n("test:first"), 1)
            .expect("joined");
        assert_eq!(linked(&w, board, "test:first"), BTreeSet::from([b0]));
        if restart {
            w.restart();
        }
        assert!(!w.acts.expiring(60_000_000), "not before its expiry");
        assert!(w.acts.expiring(61_001_000));
        assert_eq!(w.acts.expire(&mut w.tree, 61_001_000), vec![p]);
        assert!(
            linked(&w, board, "test:first").is_empty(),
            "restart {restart}"
        );
        assert!(w.tree.handle(p).is_none(), "its node is gone");
    }
}

#[test]
fn b10_a_board_removed_mid_game_lets_both_players_go_at_once() {
    let mut w = world(2, 0xb7);
    let (b0, b1) = (w.bodies[0], w.bodies[1]);
    let board = board(&mut w);
    let offer = w
        .offer_at(0, board, "test:first", BTreeSet::from([b1]), 1_000)
        .expect("offered");
    let game = w.accept(1, offer, 2_000).expect("accepted");
    assert!(w.acts.started(game) && w.held(b0) && w.held(b1));
    // A creator removes the board: the tree takes the game's node and every link with it.
    let e = Effect {
        envelope: Envelope {
            sequence: w.tree.to_state().next,
            at: 3_000,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node: board,
        },
        body: Body::Changes(vec![ChangeRec {
            change: Change::Remove { node: board },
            rest: Rest::new(),
        }]),
        events: None,
        rest: Rest::new(),
    };
    let header = w.acts.header.clone();
    w.tree
        .commit(&header, &part(&header, &[e]), &w.acts.rules)
        .expect("the board removed");
    assert!(w.tree.handle(game).is_none(), "the game went with it");
    assert!(w.acts.stranded(&w.tree));
    w.acts.next = w.tree.to_state().next;
    let from = w.acts.stream.len();
    assert_eq!(
        w.acts.release_gone(&mut w.tree, &mut w.c, 3_000),
        vec![game]
    );
    assert!(!w.held(b0) && !w.held(b1), "both let go");
    assert!(w.acts.members(game).is_none());
    let told: Vec<Id> = w.acts.stream[from..]
        .iter()
        .filter(|e| {
            e.events
                .as_ref()
                .is_some_and(|v| v.iter().any(|x| x.name.as_str() == ENDED))
        })
        .map(|e| e.envelope.node)
        .collect();
    assert_eq!(told, vec![b0, b1], "each told at its body, by name");
    // Both can act again at once: a new game on the ground starts.
    let offer = w.offer(0, BTreeSet::from([b1]), 4_000);
    let again = w.accept(1, offer, 4_500).expect("accepted again");
    assert!(w.acts.started(again));
}

#[test]
fn b10_a_bound_activity_claims_no_hand_and_one_on_the_ground_does() {
    let mut w = world(4, 0xb8);
    let (b0, b1, b2, b3) = (w.bodies[0], w.bodies[1], w.bodies[2], w.bodies[3]);
    let board = board(&mut w);
    let offer = w
        .offer_at(0, board, "test:first", BTreeSet::from([b1]), 1_000)
        .expect("offered");
    let game = w.accept(1, offer, 2_000).expect("accepted");
    assert!(w.acts.started(game));
    assert!(
        holds_nothing(&w, b0) && holds_nothing(&w, b1),
        "the game at the board claims nothing"
    );
    let offer = w.offer(2, BTreeSet::from([b3]), 3_000);
    let pair = w.accept(3, offer, 3_500).expect("accepted");
    assert!(w.acts.started(pair));
    assert!(
        !holds_nothing(&w, b2) && !holds_nothing(&w, b3),
        "the pair on the ground holds its claims"
    );
}

/// Whether nothing running on `body` holds any of its parts.
fn holds_nothing(w: &World, body: Id) -> bool {
    w.c.claims(body)
        .is_some_and(|cl| cl.running().values().all(|i| i.holds.is_empty()))
}
