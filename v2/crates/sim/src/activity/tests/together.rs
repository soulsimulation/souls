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
use replica::time::Micros;

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

/// `k` bodies whose pair's roles each name the handshake.
fn touching(k: usize, seed: u8) -> World {
    let mut w = world(k, seed);
    let mut kind = pair();
    for r in &mut kind.roles {
        r.mv = Some(n("souls:handshake"));
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
            &[handshake()],
            &Near,
            at,
        )
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

    // The moves end, the members take their roles back, and either may leave.
    let _ = w.run(LASTS);
    assert!(w.moves.is_empty(), "both moves ended");
    let ask = w.ask(0, LASTS);
    w.acts
        .leave(
            &mut w.tree,
            &mut w.c,
            &w.moves,
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
