//! 0.134 T1 (#3891), touch by offer and accept: a role may name a move, and when an activity of that kind starts each
//! member aims its role's move at the other through [`super::Activities::aim`]; the moves' records go out as a form's
//! (`souls:form-move`). An accepted handshake writes both moves with their contacts within 50 ms of each other; a
//! declined or lapsed offer moves nobody; a third Soul's aim at a member is refused `target-outside-activity`.
//! `cargo test -p sim together -- --nocapture`.

use std::collections::BTreeSet;

use replica::bodies::{Class, Want};
use replica::effects::{Refusal, read_id};
use replica::encode::Value;
use replica::ids::Id;
use replica::moves::Move;
use replica::time::{Mapping, Micros, Tempo, TickRate, Timeline};

use super::{Activities, Near, PAIR, World, header, moves, n, pair, rules, world};

/// The pair's proposal lasts a minute.
const LASTS: Micros = 60_000_000;

/// A handshake as the engine reads it: a fixture move of one hand, named and reaching as content's does (B2's).
fn handshake() -> Move {
    let mut mv = moves()
        .into_iter()
        .find(|m| m.claims == vec![Want::One(Class::Manipulator)])
        .expect("a move of one hand");
    mv.name = n("souls:handshake");
    mv.contact = n("souls:hand-right");
    mv
}

/// Holding a hand (0.134 T2): the handshake's one hand, its last phase held until released (B's `hold_hand`).
fn hold_hand() -> Move {
    let mut mv = handshake();
    mv.name = n("souls:hold_hand");
    mv.contact = n("souls:hand-left");
    mv.phases.last_mut().expect("a phase").held = true;
    mv
}

/// `k` bodies whose pair's roles each name the handshake.
fn touching(k: usize, seed: u8) -> World {
    with_move(k, seed, "souls:handshake")
}

/// `k` bodies whose pair's roles each name move `mv`.
fn with_move(k: usize, seed: u8, mv: &str) -> World {
    let mut w = world(k, seed);
    let mut kind = pair();
    for r in &mut kind.roles {
        r.mv = Some(n(mv));
    }
    w.acts = Activities::new(
        header(w.root),
        rules(&w.souls),
        w.tree.to_state().next,
        vec![kind],
    );
    w
}

impl World {
    /// Soul `who` offers the pair, in its first role, to body `to`.
    fn offer_to(&mut self, who: usize, to: usize, at: Micros) -> Id {
        let ask = self.ask(who, at);
        let (body, asked) = (self.bodies[who], BTreeSet::from([self.bodies[to]]));
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

    /// The roles' moves of what started, aimed as the engine aims them after each act.
    fn begin(&mut self, at: Micros) -> Vec<(Id, Refusal)> {
        self.acts.begin_moves(
            &mut self.tree,
            &mut self.c,
            &mut self.moves,
            &mut self.due,
            &mut self.mint,
            &[handshake(), hold_hand()],
            &Near,
            &Timeline::start(
                Mapping::new(0, 0, 1, 1).expect("rate one"),
                TickRate::new(0, 0, 20).expect("20 a second"),
                Tempo::per_minute(0, 0, 120).expect("120 a minute"),
            )
            .expect("a line"),
            at,
        )
    }

    /// Each `souls:form-move` written: the body and how its move ended, if it has (`released`).
    fn endings(&self) -> Vec<(Id, Option<String>)> {
        self.acts
            .stream
            .iter()
            .flat_map(|e| e.events.iter().flatten())
            .filter(|ev| ev.name.as_str() == "souls:form-move")
            .map(|ev| {
                let Value::Map(r) = &ev.fields[&3] else {
                    panic!("a move record")
                };
                let how = match r.get(&9) {
                    Some(Value::Map(e)) => match e.get(&2) {
                        Some(Value::Bytes(b)) => {
                            Some(String::from_utf8(b.clone()).expect("a name"))
                        }
                        other => panic!("how it ended: {other:?}"),
                    },
                    _ => None,
                };
                (read_id(&ev.fields[&2]).expect("a body"), how)
            })
            .collect()
    }

    /// Each `souls:form-move` written: the body and its move's contact time.
    fn touches(&self) -> Vec<(Id, Micros)> {
        let time = |v: &Value| match v {
            Value::Uint(t) => *t as Micros,
            _ => panic!("a time after the world began"),
        };
        self.acts
            .stream
            .iter()
            .flat_map(|e| e.events.iter().flatten())
            .filter(|ev| ev.name.as_str() == "souls:form-move")
            .map(|ev| {
                let body = read_id(&ev.fields[&2]).expect("a body");
                let Value::Map(r) = &ev.fields[&3] else {
                    panic!("a move record")
                };
                let Some(Value::Array(ends)) = r.get(&8) else {
                    panic!("its phase ends")
                };
                (body, time(&ends[0]))
            })
            .collect()
    }
}

#[test]
fn t1_an_accepted_handshake_writes_both_moves_touching_together() {
    let mut w = touching(3, 0x71);
    let (b0, b1, b2) = (w.bodies[0], w.bodies[1], w.bodies[2]);
    let offer = w.offer_to(0, 1, 1_000);
    assert!(w.begin(1_000).is_empty());
    assert!(w.touches().is_empty(), "an offer alone moves nobody");
    let ask = w.ask(1, 2_000);
    let pair = w
        .acts
        .accept(
            &mut w.tree,
            &mut w.mint,
            &mut w.c,
            &mut w.due,
            ask,
            b1,
            offer,
        )
        .expect("accepted");
    assert!(w.acts.started(pair), "the handshake started at the accept");
    let refused = w.begin(2_000);
    assert!(refused.is_empty(), "{refused:?}");
    let touches = w.touches();
    let bodies: BTreeSet<Id> = touches.iter().map(|t| t.0).collect();
    assert_eq!(bodies, BTreeSet::from([b0, b1]), "both members move");
    let (a, b) = (touches[0].1, touches[1].1);
    assert!((a - b).abs() <= 50_000, "contacts {a} and {b} µs");

    // A third Soul's aim at a member is refused, and changes nothing.
    let written = w.acts.stream.len();
    let r = w
        .acts
        .aim(
            &mut w.c,
            &mut w.moves,
            &mut w.due,
            &mut w.mint,
            &Near,
            b2,
            &handshake(),
            b0,
            3_000,
        )
        .expect_err("outside the activity");
    assert_eq!(r.name, "target-outside-activity");
    assert_eq!(w.acts.stream.len(), written);

    // The moves end, and the touch ends with them: both members leave it, and both are held by nothing.
    let _ = w.run(LASTS);
    assert!(w.moves.is_empty(), "both moves ended");
    let refused = w.acts.finish(
        &mut w.tree,
        &mut w.c,
        &mut w.moves,
        &mut w.due,
        &mut w.mint,
        LASTS,
    );
    assert!(refused.is_empty(), "{refused:?}");
    assert!(w.acts.members(pair).is_none(), "the touch ended");
    assert!(w.free(b0) && w.free(b1), "both arms free");
    let ask = w.ask(0, LASTS);
    w.acts
        .leave(
            &mut w.tree,
            &mut w.c,
            &mut w.moves,
            &mut w.due,
            &mut w.mint,
            ask,
            b0,
            pair,
        )
        .expect("a leave is always accepted");
    println!(
        "t1: an accepted handshake: both moves, contacts at {a} and {b} µs; a third Soul's aim refused"
    );
}

#[test]
fn t1_a_declined_or_lapsed_handshake_moves_nobody() {
    let mut w = touching(2, 0x72);
    let b1 = w.bodies[1];
    let offer = w.offer_to(0, 1, 1_000);
    let ask = w.ask(1, 2_000);
    w.acts
        .decline(&mut w.tree, &mut w.due, ask, b1, offer)
        .expect("declined");
    assert!(w.begin(2_000).is_empty());
    let _ = w.offer_to(0, 1, 3_000);
    while let Some(t) = w.due.fire(3_000 + LASTS + 1) {
        w.acts
            .lapse(&mut w.tree, &mut w.c, &mut w.due, &t)
            .expect("an offer's timer")
            .expect("lapsed");
    }
    assert!(w.begin(3_000 + LASTS + 1).is_empty());
    assert!(w.touches().is_empty(), "nobody moved");
    assert!(w.moves.is_empty());
    println!("t1: a declined and a lapsed handshake: no move written");
}

#[test]
fn t2_hands_held_while_both_stay_and_freed_when_either_leaves() {
    let mut w = with_move(2, 0x73, "souls:hold_hand");
    let (b0, b1) = (w.bodies[0], w.bodies[1]);
    let offer = w.offer_to(0, 1, 1_000);
    let ask = w.ask(1, 2_000);
    let pair = w
        .acts
        .accept(
            &mut w.tree,
            &mut w.mint,
            &mut w.c,
            &mut w.due,
            ask,
            b1,
            offer,
        )
        .expect("accepted");
    let refused = w.begin(2_000);
    assert!(refused.is_empty(), "{refused:?}");
    assert_eq!(w.touches().len(), 2, "both members hold a hand");
    // Long after the reach: no timer is left for the held moves, and both still hold.
    let _ = w.run(2_000 + LASTS);
    assert!(w.due.is_empty(), "a held move sets no timer");
    assert!(!w.moves.is_empty(), "both still hold");
    assert_eq!(w.acts.walk_leaves(&w.moves, b0), Some(pair));
    assert_eq!(w.acts.walk_leaves(&w.moves, b1), Some(pair));

    // Soul 1 leaves: both holds are released at once, each written again ended `released`, and both hands are free.
    let at = 3_000 + LASTS;
    let ask = w.ask(1, at);
    let let_go = w
        .acts
        .leave(
            &mut w.tree,
            &mut w.c,
            &mut w.moves,
            &mut w.due,
            &mut w.mint,
            ask,
            b1,
            pair,
        )
        .expect("a leave is always accepted");
    assert_eq!(let_go, at, "let go at once");
    assert!(w.moves.is_empty(), "both holds released");
    let released: BTreeSet<Id> = w
        .endings()
        .into_iter()
        .filter(|(_, how)| how.as_deref() == Some("released"))
        .map(|(b, _)| b)
        .collect();
    assert_eq!(released, BTreeSet::from([b0, b1]));
    assert!(w.free(b1), "the one who left holds nothing");
    assert_eq!(w.acts.walk_leaves(&w.moves, b0), None);
    println!(
        "t2: held past {LASTS} µs with no timer; one leave freed both hands, each written `released`"
    );
}

/// 0.135 R1, walking hand in hand: in a hold, the first member to walk leads (its walk does not let go), and the other
/// follows beside it, half a metre to its side, by its own order (`following`); the other's walk still lets go. A
/// restart ends the hold for both at its first tick (its hands came apart: moves are not stored), each member leaving
/// as its own leave would, so neither is kept in it and both are free.
#[test]
fn r1_the_first_to_walk_leads_the_other_walks_beside_and_a_restart_ends_the_hold() {
    let mut w = with_move(2, 0x74, "souls:hold_hand");
    let (b0, b1) = (w.bodies[0], w.bodies[1]);
    let offer = w.offer_to(0, 1, 1_000);
    let ask = w.ask(1, 2_000);
    let pair = w
        .acts
        .accept(
            &mut w.tree,
            &mut w.mint,
            &mut w.c,
            &mut w.due,
            ask,
            b1,
            offer,
        )
        .expect("accepted");
    assert!(w.begin(2_000).is_empty());
    assert!(w.acts.following().is_empty(), "standing, nobody follows");
    assert!(w.acts.lead(&w.moves, b0), "the first to walk leads");
    assert!(w.acts.lead(&w.moves, b0), "and goes on leading");
    assert!(!w.acts.lead(&w.moves, b1), "the other does not lead");
    assert_eq!(
        w.acts.walk_leaves(&w.moves, b1),
        Some(pair),
        "the other's own walk lets go"
    );
    let soul1 = w.souls[1];
    assert_eq!(
        w.acts.following(),
        vec![(pair, b0, b1, soul1, Some(500_000))],
        "the other walks beside the leader, half a metre off"
    );

    // The restart: the tree from the log alone; a new controller, no moves, no timers.
    let header = w.acts.header.clone();
    let mut log = w.setup.clone();
    log.extend(w.acts.stream.iter().cloned());
    let mut tree = super::Tree::start(w.root, n(super::GROUND));
    tree.apply(&header, &super::part(&header, &log))
        .expect("the log replays");
    let mut c = super::controller(w.root, &w.bodies);
    let rules = w.acts.rules.clone();
    let mut kind = super::pair();
    for r in &mut kind.roles {
        r.mv = Some(n("souls:hold_hand"));
    }
    w.acts = Activities::restore(header, rules, vec![kind], &tree, &mut c).expect("restored");
    w.tree = tree;
    w.c = c;
    w.moves = super::Moves::new();
    w.due = super::DueList::new();
    assert!(w.acts.following().is_empty(), "no leader after a restart");
    assert!(w.acts.finishing(), "the hold ends at the first tick");
    let refused = w.acts.finish(
        &mut w.tree,
        &mut w.c,
        &mut w.moves,
        &mut w.due,
        &mut w.mint,
        10_000,
    );
    assert!(refused.is_empty(), "{refused:?}");
    assert!(w.acts.members(pair).is_none(), "the hold is over");
    for b in [b0, b1] {
        assert!(w.memberships(b).is_empty(), "{b:?} is in no hold");
        assert!(w.free(b), "{b:?} holds nothing");
    }
    println!(
        "r1: the first walker leads, the other follows 0.5 m beside; a restart ends the hold for both"
    );
}
