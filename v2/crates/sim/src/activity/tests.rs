//! B5's checks (#2724): two scripted Souls propose, join, start and leave, each step theirs in the log (A1); of 1,000
//! random moves aimed at a body outside the actor's activity none changes the target (A2); a leave is always accepted
//! and completes within the kind's bound (A3); after a restart mid-activity both members still belong, every claim
//! has a live holder, and either can leave (A4). `cargo test -p sim activity -- --nocapture` prints the logged run
//! and the leave times. No move is named here: the moves are B2's fixture files.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use replica::activity::{ActivityKind, MEMBER};
use replica::bodies::{Class, Family};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, fixture_bytes,
    schema_hash,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::moves::{Effector, Move};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::time::Micros;
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, Kind};

use super::{Activities, Ask};
use crate::controller::Controller;
use crate::ground::Piece;
use crate::mover::Surface;
use crate::moves::{Moves, Reach, load};
use crate::timers::DueList;

const FAMILIES: &str = include_str!("../../../replica/fixtures/bodies/families.diag");
/// Pinned kind names (`namespace:name@hash`); the hash is a stand-in.
const GROUND: &str =
    "test:ground@12200000000000000000000000000000000000000000000000000000000000000001";
const WALKER: &str =
    "test:walker@12200000000000000000000000000000000000000000000000000000000000000002";
const PAIR: &str = "test:pair@12200000000000000000000000000000000000000000000000000000000000000003";
/// The pair's bound on a leave, µs: shorter than some phases of the fixture moves and longer than others.
const LEAVE_WITHIN: Micros = 400_000;

fn n(s: &str) -> Name {
    Name::new(s).expect("a name")
}

fn splitmix(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

fn family() -> Family {
    let Value::Array(fs) = decode(&fixture_bytes(FAMILIES).expect("bytes"))
        .expect("decodes")
        .value
    else {
        panic!("a list")
    };
    fs.iter()
        .map(|f| Family::from_value(f).expect("a family"))
        .find(|f| f.resources.iter().any(|r| r.class == Class::Manipulator))
        .expect("a family with hands")
}

fn moves() -> Vec<Move> {
    load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../replica/fixtures/moves")).expect("moves")
}

/// The pair: two roles, each holding its body's legs and eyes.
fn pair() -> ActivityKind {
    let want = |all: u64, class: u64| {
        Value::Map(BTreeMap::from([
            (1, Value::Uint(all)),
            (2, Value::Uint(class)),
        ]))
    };
    let role = |r: &str| {
        Value::Map(BTreeMap::from([
            (1, Value::Text(n(r))),
            (2, Value::Text(n(&format!("{r}-place")))),
            (3, Value::Array(vec![want(1, 1), want(2, 3)])),
        ]))
    };
    ActivityKind::from_value(&Value::Map(BTreeMap::from([
        (1, Value::Text(n(PAIR))),
        (2, Value::Uint(1)),
        (
            3,
            Value::Array(vec![role("test:first"), role("test:second")]),
        ),
        (4, Value::Uint(60_000_000)),
        (5, Value::Uint(LEAVE_WITHIN as u64)),
    ])))
    .expect("the pair")
}

fn header(zone: Id) -> Header {
    let kinds = [GROUND, WALKER, PAIR]
        .iter()
        .map(|k| Value::Text(n(k)))
        .collect();
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/b5-activity/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(zone.scope().0.to_vec())),
        (4, zone.to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(kinds)),
        (7, Value::Array(Vec::new())),
    ]));
    Header::read(&encode(&v).expect("bytes")).expect("a header")
}

fn rules(souls: &[Id]) -> Rules {
    let kind = |owner: &str, children: &[&str]| Kind {
        owner: owner.into(),
        children: children.iter().map(|c| (*c).to_owned()).collect(),
        slots: BTreeMap::new(),
        hands: None,
    };
    Rules {
        kinds: BTreeMap::from([
            (GROUND.to_owned(), kind("place", &["body", "test:pair"])),
            (WALKER.to_owned(), kind("family", &[])),
            (PAIR.to_owned(), kind("activity", &[])),
        ]),
        souls: souls.iter().copied().collect(),
        audiences: BTreeMap::new(),
    }
}

/// A geometry where everything is a micrometre away: always within reach.
struct Near;

impl Reach for Near {
    fn distance(&self, _: Id, _: &Effector, _: Option<&Name>, _: Id, _: &Name) -> Option<i64> {
        Some(1)
    }
}

/// `k` bodies on one ground, each driven by its own Soul; their nodes made by the world's first entry.
struct World {
    root: Id,
    bodies: Vec<Id>,
    souls: Vec<Id>,
    tree: Tree,
    setup: Vec<Effect>,
    c: Controller,
    moves: Moves,
    due: DueList,
    mint: Minter,
    acts: Activities,
}

/// Where body `i` stands: a metre apart in rows of 40, so a hall of 300 (E8) fits the ground.
fn spot(i: usize) -> Vec3 {
    Vec3::new((i % 40) as i64 * 1_000_000, 0, (i / 40) as i64 * 1_000_000)
}

fn controller(root: Id, bodies: &[Id]) -> Controller {
    let corners = vec![
        [-50_000, 0, -50_000],
        [50_000, 0, -50_000],
        [50_000, 0, 50_000],
        [-50_000, 0, 50_000],
    ];
    let ground = Surface::new(
        root,
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
            ground: crate::gaits::Ground::Dry,
        }],
    );
    let mut c = Controller::new();
    for (i, b) in bodies.iter().enumerate() {
        let at = spot(i);
        let frame = Frame {
            node: root,
            slot: None,
        };
        c.add(
            family(),
            ground.place(*b, frame, at, Quat::IDENTITY).expect("placed"),
        )
        .expect("added");
    }
    c
}

fn part(header: &Header, effects: &[Effect]) -> Part {
    let v = Value::Map(BTreeMap::from([
        (1, Value::Bytes(header.hash().to_bytes())),
        (
            2,
            Value::Array(effects.iter().map(Effect::to_value).collect()),
        ),
    ]));
    Part::read(&encode(&v).expect("bytes")).expect("a part")
}

fn world(k: usize, seed: u8) -> World {
    let mut mint = Minter::new(Scope([seed; 16]));
    let mut id = || mint.mint().expect("an id");
    let root = id();
    let bodies: Vec<Id> = (0..k).map(|_| id()).collect();
    let souls: Vec<Id> = (0..k).map(|_| id()).collect();
    let mut tree = Tree::start(root, n(GROUND));
    let header = header(root);
    let rules = rules(&souls);
    let creates = bodies
        .iter()
        .enumerate()
        .map(|(i, b)| ChangeRec {
            change: Change::Create {
                node: *b,
                kind: n(WALKER),
                pose: Pose {
                    frame: Frame {
                        node: root,
                        slot: None,
                    },
                    position: spot(i),
                    orientation: Quat::IDENTITY,
                    support: Support::Surface {
                        surface: root,
                        height: 0,
                    },
                },
                audience: Audience::Everyone,
                fields: BTreeMap::new(),
            },
            rest: Rest::new(),
        })
        .collect();
    let setup = vec![Effect {
        envelope: Envelope {
            sequence: tree.to_state().next,
            at: 0,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node: root,
        },
        body: Body::Changes(creates),
        events: None,
        rest: Rest::new(),
    }];
    tree.commit(&header, &part(&header, &setup), &rules)
        .expect("the bodies");
    let next = tree.to_state().next;
    World {
        root,
        c: controller(root, &bodies),
        bodies,
        souls,
        tree,
        setup,
        moves: Moves::new(),
        due: DueList::new(),
        acts: Activities::new(header, rules, next, vec![pair()]),
        mint,
    }
}

impl World {
    fn ask(&mut self, who: usize, at: Micros) -> Ask {
        Ask {
            soul: self.souls[who],
            intent: self.mint.mint().expect("an intent id"),
            at,
        }
    }

    /// Bodies `a` and `b` (indexes) in a started pair, proposed by `a`'s Soul.
    fn pair(&mut self, a: usize, b: usize, at: Micros) -> Id {
        let ask = self.ask(a, at);
        let act = self
            .acts
            .propose(&mut self.tree, &mut self.mint, ask, &n(PAIR), self.root)
            .expect("proposed");
        for (who, role) in [(a, "test:first"), (b, "test:second")] {
            let ask = self.ask(who, at);
            let body = self.bodies[who];
            self.acts
                .join(&mut self.tree, &mut self.mint, ask, body, act, &n(role), 1)
                .expect("joined");
        }
        let ask = self.ask(a, at);
        self.acts
            .start(&mut self.tree, &mut self.c, ask, act)
            .expect("started");
        act
    }

    fn leave(&mut self, who: usize, act: Id, at: Micros) -> Micros {
        let ask = self.ask(who, at);
        let body = self.bodies[who];
        self.acts
            .leave(
                &mut self.tree,
                &mut self.c,
                &self.moves,
                &mut self.due,
                &mut self.mint,
                ask,
                body,
                act,
            )
            .expect("a leave is always accepted")
    }

    /// Runs every timer due before `before`: leaves first, then moves; then the activities settle.
    fn run(&mut self, before: Micros) -> Vec<(Id, Micros)> {
        let mut let_go = Vec::new();
        while let Some(t) = self.due.fire(before) {
            if let Some(x) = self
                .acts
                .fire(&mut self.c, &mut self.moves, &mut self.due, &t)
            {
                let_go.push(x);
            } else {
                self.moves
                    .fire(&mut self.c, &mut self.due, &mut self.mint, &Near, &t);
            }
            let refused = self.acts.settle(&mut self.c, &self.moves, &mut self.due);
            assert!(refused.is_empty(), "{refused:?}");
        }
        let_go
    }

    /// Whether `body` has no claim at all: nothing drives it.
    fn free(&self, body: Id) -> bool {
        self.c
            .claims(body)
            .is_some_and(|cl| cl.running().is_empty())
    }

    /// The membership links at `body`, as (link, activity).
    fn memberships(&self, body: Id) -> Vec<(Id, Id)> {
        self.tree
            .links_at(body)
            .iter()
            .filter(|e| self.tree.ty(e).as_str() == MEMBER)
            .map(|e| (e.link, e.other))
            .collect()
    }
}

fn line(e: &Effect, souls: &[Id]) -> String {
    let who = match e.envelope.actor {
        Actor::Soul(s) => format!(
            "soul {}",
            souls.iter().position(|x| *x == s).expect("a Soul")
        ),
        other => format!("{other:?}"),
    };
    let what = e
        .events
        .as_ref()
        .and_then(|ev| ev.first())
        .map_or("-", |ev| ev.name.as_str());
    format!(
        "#{} at {} µs, {who}: {what}",
        e.envelope.sequence, e.envelope.at
    )
}

#[test]
fn a1_two_souls_propose_join_start_and_leave_each_step_theirs() {
    let mut w = world(3, 0xb5);
    let (s0, s1) = (w.souls[0], w.souls[1]);
    let (b0, b1) = (w.bodies[0], w.bodies[1]);

    let propose = w.ask(0, 1_000);
    let act = w
        .acts
        .propose(&mut w.tree, &mut w.mint, propose, &n(PAIR), w.root)
        .expect("proposed");
    assert!(w.free(b0) && w.free(b1), "a proposal reserves nothing");

    let j0 = w.ask(0, 2_000);
    let l0 = w
        .acts
        .join(&mut w.tree, &mut w.mint, j0, b0, act, &n("test:first"), 1)
        .expect("joined");
    let stale = w.ask(1, 2_500);
    assert_eq!(
        w.acts
            .join(
                &mut w.tree,
                &mut w.mint,
                stale,
                b1,
                act,
                &n("test:second"),
                2
            )
            .expect_err("stale")
            .name,
        "activity-revision-stale"
    );
    let early = w.ask(0, 2_600);
    assert_eq!(
        w.acts
            .start(&mut w.tree, &mut w.c, early, act)
            .expect_err("a role is open")
            .name,
        "roles-unfilled"
    );
    let j1 = w.ask(1, 3_000);
    let l1 = w
        .acts
        .join(&mut w.tree, &mut w.mint, j1, b1, act, &n("test:second"), 1)
        .expect("joined");
    // A resent join (the same intent) makes no second membership and writes nothing.
    let written = w.acts.stream.len();
    let again = w
        .acts
        .join(&mut w.tree, &mut w.mint, j1, b1, act, &n("test:second"), 1)
        .expect("answered");
    assert_eq!((again, w.acts.stream.len()), (l1, written));
    assert_eq!(w.memberships(b0), vec![(l0, act)]);
    assert_eq!(w.memberships(b1), vec![(l1, act)]);

    let start = w.ask(0, 4_000);
    w.acts
        .start(&mut w.tree, &mut w.c, start, act)
        .expect("started");
    assert!(
        !w.free(b0) && !w.free(b1),
        "the start took both bodies' claims"
    );

    // A second activity wanting a held body: the first to start has it, and the other is refused naming it.
    let other = w.ask(2, 4_500);
    let second = w
        .acts
        .propose(&mut w.tree, &mut w.mint, other, &n(PAIR), w.root)
        .expect("proposed");
    for (who, role) in [(2, "test:first"), (1, "test:second")] {
        let ask = w.ask(who, 4_600);
        let body = w.bodies[who];
        w.acts
            .join(&mut w.tree, &mut w.mint, ask, body, second, &n(role), 1)
            .expect("joined");
    }
    let ask = w.ask(2, 4_700);
    let r = w
        .acts
        .start(&mut w.tree, &mut w.c, ask, second)
        .expect_err("held");
    assert_eq!(r.name, "body-in-activity");
    assert!(r.detail.contains(&replica::world_model::show(act)), "{r}");

    let leave1 = w.leave(1, act, 5_000);
    assert_eq!(leave1, 5_000);
    assert!(w.memberships(b1).iter().all(|(_, a)| *a != act));
    let leave0 = w.leave(0, act, 6_000);
    assert_eq!(leave0, 6_000);
    assert!(w.free(b0) && w.memberships(b0).is_empty());
    assert!(w.tree.handle(act).is_none(), "the activity ends when empty");

    // The log: the first activity's steps are each its Soul's, caused by its intent.
    let steps: Vec<(Id, Id, &str)> = vec![
        (s0, propose.intent, "souls:activity-proposed"),
        (s0, j0.intent, "souls:activity-joined"),
        (s1, j1.intent, "souls:activity-joined"),
        (s0, start.intent, "souls:activity-started"),
    ];
    let log = &w.acts.stream;
    for e in log {
        println!("{}", line(e, &w.souls));
    }
    for (e, (soul, intent, event)) in log.iter().zip(&steps) {
        assert_eq!(e.envelope.actor, Actor::Soul(*soul));
        assert_eq!(e.envelope.cause, Cause::Intent(*intent));
        assert_eq!(
            e.events.as_ref().expect("an event")[0].name.as_str(),
            *event
        );
    }
    let left: Vec<_> = log
        .iter()
        .filter(|e| e.events.as_ref().expect("an event")[0].name.as_str() == "souls:activity-left")
        .filter(|e| e.envelope.node == act)
        .map(|e| e.envelope.actor)
        .collect();
    assert_eq!(left, vec![Actor::Soul(s1), Actor::Soul(s0)]);
}

#[test]
fn a2_a_thousand_moves_at_a_body_outside_the_actors_activity_change_nothing() {
    // Bodies 0 and 1 in one started pair, 2 and 3 in another, 4 joined to a proposal, 5 in none.
    let mut w = world(6, 0xa2);
    let _ = w.pair(0, 1, 0);
    let _ = w.pair(2, 3, 0);
    let ask = w.ask(4, 0);
    let proposed = w
        .acts
        .propose(&mut w.tree, &mut w.mint, ask, &n(PAIR), w.root)
        .expect("proposed");
    let ask = w.ask(4, 0);
    let b4 = w.bodies[4];
    w.acts
        .join(
            &mut w.tree,
            &mut w.mint,
            ask,
            b4,
            proposed,
            &n("test:first"),
            1,
        )
        .expect("joined");
    let all = moves();
    let snap = |w: &World, t: Id| {
        let n = w
            .tree
            .node(w.tree.handle(t).expect("a node"))
            .expect("a node");
        format!(
            "{:?} {:?} {:?} {:?} {:?}",
            w.c.input(t),
            w.c.claims(t).map(|c| c.running().clone()),
            w.c.body(t),
            n.fields(),
            w.tree.links_at(t)
        )
    };
    let (written, mut tried, mut seed) = (w.acts.stream.len(), 0, 0xb5_u64);
    while tried < 1_000 {
        seed = splitmix(seed);
        let (a, t) = ((seed % 6) as usize, ((seed >> 8) % 6) as usize);
        let (actor, target) = (w.bodies[a], w.bodies[t]);
        let holder = w.acts.holder(actor);
        if a == t || (holder.is_some() && holder == w.acts.holder(target)) {
            continue;
        }
        let mv = &all[((seed >> 16) % all.len() as u64) as usize];
        let before = snap(&w, target);
        let r = w
            .acts
            .aim(
                &mut w.c,
                &mut w.moves,
                &mut w.due,
                &mut w.mint,
                &Near,
                actor,
                mv,
                target,
                (tried as i64) * 1_000,
            )
            .expect_err("outside the actor's activity");
        assert_eq!(r.name, "target-outside-activity");
        assert_eq!(snap(&w, target), before, "move {tried} changed its target");
        tried += 1;
    }
    assert!(w.moves.is_empty() && w.due.is_empty());
    assert_eq!(w.acts.stream.len(), written);
    // Inside the activity the same moves are accepted.
    let (b0, b1) = (w.bodies[0], w.bodies[1]);
    w.acts
        .aim(
            &mut w.c,
            &mut w.moves,
            &mut w.due,
            &mut w.mint,
            &Near,
            b0,
            &all[0],
            b1,
            0,
        )
        .expect("a move inside the activity");
    println!(
        "a2: {tried} moves aimed outside the actor's activity, all refused, no target changed"
    );
}

#[test]
fn a3_a_leave_is_always_accepted_and_completes_within_the_bound() {
    let all = moves();
    let (mut most, mut cases, mut mid_move) = (0, 0, 0);
    let mut seed = 0xa3_u64;
    for trial in 0..300_u64 {
        seed = splitmix(seed ^ trial);
        let mut w = world(2, 0xa3);
        let act = w.pair(0, 1, 0);
        let mv = &all[(seed % all.len() as u64) as usize];
        let (b0, b1) = (w.bodies[0], w.bodies[1]);
        w.acts
            .aim(
                &mut w.c,
                &mut w.moves,
                &mut w.due,
                &mut w.mint,
                &Near,
                b0,
                mv,
                b1,
                0,
            )
            .expect("aimed");
        let asked = ((seed >> 8) % (mv.length() as u64 + 200_000)) as Micros;
        let who = ((seed >> 40) % 2) as usize;
        let body = w.bodies[who];
        w.run(asked);
        let in_move = who == 0 && !w.moves.is_empty();
        let said = w.leave(who, act, asked);
        let mut done = if w.free(body) { Some(asked) } else { None };
        while done.is_none() {
            let Some(next) = w.due.next_due() else { break };
            w.run(next + 1);
            if w.free(body) {
                done = Some(next);
            }
        }
        let done = done.expect("the body is let go");
        assert!(
            done <= asked + LEAVE_WITHIN,
            "trial {trial}: {done} after {asked}"
        );
        assert_eq!(done, said, "trial {trial}: let go when the leave said");
        assert!(w.memberships(body).is_empty());
        most = most.max(done - asked);
        cases += 1;
        mid_move += usize::from(in_move);
    }
    // A leave of what one is not in, or of an activity that is gone, is accepted too.
    let mut w = world(3, 0xa4);
    let act = w.pair(0, 1, 0);
    assert_eq!(w.leave(2, act, 10), 10);
    let gone = w.mint.mint().expect("an id");
    assert_eq!(w.leave(0, gone, 20), 20);
    println!(
        "a3: {cases} leaves, {mid_move} mid-move; longest from ask to let go {most} µs, bound {LEAVE_WITHIN} µs"
    );
    assert!(mid_move > 0 && most <= LEAVE_WITHIN);
}

#[test]
fn a4_after_a_restart_mid_activity_both_still_belong_and_either_can_leave() {
    let mut w = world(2, 0xa4);
    let act = w.pair(0, 1, 0);
    let (b0, b1) = (w.bodies[0], w.bodies[1]);
    let mv = moves().remove(0);
    w.acts
        .aim(
            &mut w.c,
            &mut w.moves,
            &mut w.due,
            &mut w.mint,
            &Near,
            b0,
            &mv,
            b1,
            0,
        )
        .expect("aimed");
    w.run(mv.phases[0].length + 1);
    assert_eq!(w.moves.len(), 1, "stopped mid-move");

    // The restart: the tree from the log alone; a new controller, no moves, no timers.
    let header = w.acts.header.clone();
    let mut log = w.setup.clone();
    log.extend(w.acts.stream.iter().cloned());
    let mut tree = Tree::start(w.root, n(GROUND));
    tree.apply(&header, &part(&header, &log))
        .expect("the log replays");
    let mut c = controller(w.root, &w.bodies);
    let moves = Moves::new();
    let rules = w.acts.rules.clone();
    let acts = Activities::restore(header, rules, vec![pair()], &tree, &mut c).expect("restored");
    w.tree = tree;
    w.c = c;
    w.moves = moves;
    w.due = DueList::new();
    w.acts = acts;

    let members: BTreeSet<Id> = w
        .acts
        .members(act)
        .expect("the activity")
        .iter()
        .map(|m| m.body)
        .collect();
    assert_eq!(members, BTreeSet::from([b0, b1]));
    assert!(w.acts.started(act));
    for b in [b0, b1] {
        assert_eq!(w.memberships(b).len(), 1);
        assert_eq!(w.memberships(b)[0].1, act);
        let running = w.c.claims(b).expect("a body").running().clone();
        assert!(!running.is_empty(), "the activity took its claims again");
        for driver in running.keys() {
            assert!(
                w.acts.holds(&w.moves, b, *driver),
                "a claim on {b:?} without a live holder"
            );
        }
    }
    // Either can leave, at once: no move came back to wait for.
    let at = 5_000_000;
    assert_eq!(w.leave(1, act, at), at);
    assert!(w.free(b1) && w.memberships(b1).is_empty());
    assert_eq!(w.leave(0, act, at + 1), at + 1);
    assert!(w.free(b0) && w.tree.handle(act).is_none());
    println!("a4: restored mid-move; 2 members, every claim the activity's; both left at once");
}

/// E8 (#2779): offers, accepted, declined and lapsed, on this file's world.
mod offers;
