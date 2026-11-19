//! F10's counts on a world written here (#2773): loose things of a kind with a lifetime end on time, each by one
//! `thing.expired` effect; kept things and things of a kind with none remain; pending ends cost an idle tick no read
//! and no time; a day in one jump equals the day stepped.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use replica::audience::OWNS;
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, TimerRec,
    schema_hash,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{FIXTURE_SCOPE_A, Hash, Id, Minter, Purpose, Scope};
use replica::kinds::Kinds;
use replica::time::Micros;
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, End, parse_kinds, parse_world};

use super::{ENDS, EXPIRED, Fired, Loose, RESERVES, expired, kept, lifetime};
use crate::timers::{DueList, Timer};

const SECOND: Micros = 1_000_000;
const HOUR: Micros = 3_600 * SECOND;
const TICK: Micros = 50_000;

/// A ground, a body with a slot, a kind that lasts an hour loose, one that lasts five, one for ever by section 19
/// and one with no section 19.
const KINDS: [&str; 6] = [
    r#"{1: "t:ground", 2: "place", 11: ["body", "thing"]}"#,
    r#"{1: "t:body", 2: "family", 6: {1: ["thing"]}}"#,
    r#"{1: "t:brief", 2: "thing", 19: {2: 3600000000}}"#,
    r#"{1: "t:longer", 2: "thing", 19: {2: 18000000000}}"#,
    r#"{1: "t:ever", 2: "thing", 19: {1: 1}}"#,
    r#"{1: "t:plain", 2: "thing"}"#,
];

/// Ids by group: loose brief things, brief things owned by body 2, brief things each in body (300 + i)'s slot, loose
/// things that last for ever by their kind, loose things with no section 19, loose longer things.
const LOOSE: u64 = 1_000;
const OWNED: u64 = 2_000;
const SLOTTED: u64 = 3_000;
const EVER: u64 = 4_000;
const PLAIN: u64 = 5_000;
const LONGER: u64 = 6_000;

fn id(n: u64) -> Id {
    Id::new(FIXTURE_SCOPE_A, n).expect("an id")
}

/// The world's text: `n` of each group (`n` ≤ 100 for the bodies' ids to stay apart).
fn world_text(n: u64) -> String {
    let mut nodes = String::from(r#"{1: 1, 2: "t:ground"}, {1: 2, 2: "t:body", 3: 1}"#);
    let mut links = String::new();
    for i in 0..n {
        let _ = write!(nodes, r#", {{1: {}, 2: "t:brief", 3: 1}}"#, LOOSE + i);
        let _ = write!(nodes, r#", {{1: {}, 2: "t:brief", 3: 1}}"#, OWNED + i);
        let _ = write!(nodes, r#", {{1: {}, 2: "t:body", 3: 1}}"#, 300 + i);
        let _ = write!(
            nodes,
            r#", {{1: {}, 2: "t:brief", 3: {}, 4: 1}}"#,
            SLOTTED + i,
            300 + i
        );
        let _ = write!(nodes, r#", {{1: {}, 2: "t:ever", 3: 1}}"#, EVER + i);
        let _ = write!(nodes, r#", {{1: {}, 2: "t:plain", 3: 1}}"#, PLAIN + i);
        let _ = write!(nodes, r#", {{1: {}, 2: "t:longer", 3: 1}}"#, LONGER + i);
        if !links.is_empty() {
            links.push_str(", ");
        }
        let _ = write!(
            links,
            r#"{{1: {}, 2: "souls:owns", 3: [2, {}], 4: 0, 5: "everyone"}}"#,
            9_000 + i,
            OWNED + i
        );
    }
    format!("{{1: [], 2: {{}}, 3: [{nodes}], 4: [{links}]}}")
}

struct World {
    tree: Tree,
    rules: Rules,
    header: Header,
    kinds: Kinds,
    loose: Loose,
    due: DueList,
    mint: Minter,
    next: u64,
    /// Every effect written, in order.
    log: Vec<Effect>,
}

fn world(n: u64) -> World {
    let mut kinds = Kinds::default();
    for (i, k) in KINDS.iter().enumerate() {
        let got = kinds.load(&[(&format!("k{i}"), k)]);
        assert_eq!(got.len(), 1, "{:?}", kinds.refused());
    }
    let parsed = parse_kinds(&KINDS.join("\n")).expect("kinds");
    let (tree, rules) =
        Tree::load(&parse_world(&parsed, &world_text(n)).expect("a world")).expect("loads");
    let root = id(1);
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/expiry-test/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(root.scope().0.to_vec())),
        (4, root.to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(Vec::new())),
        (7, Value::Array(Vec::new())),
    ]));
    let header = Header::read(&encode(&v).expect("encodes")).expect("a header");
    let next = tree.to_state().next;
    World {
        tree,
        rules,
        header,
        kinds,
        loose: Loose::new(),
        due: DueList::new(),
        mint: Minter::new(Scope([0xf1; 16])),
        next,
        log: Vec::new(),
    }
}

impl World {
    fn live(&self, n: u64) -> bool {
        self.tree.handle(id(n)).is_some()
    }

    /// Every thing set down (made loose or kept) at `now`, as a set-down's commit would call it.
    fn changed(&mut self, n: u64, now: Micros) -> Option<TimerRec> {
        self.loose
            .changed(
                &mut self.due,
                &mut self.mint,
                &self.tree,
                &self.kinds,
                id(n),
                now,
            )
            .expect("changed")
    }

    fn write(&mut self, e: Effect) {
        let bytes = encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (2, Value::Array(vec![e.to_value()])),
        ])))
        .expect("encodes");
        let part = Part::read(&bytes).expect("a part");
        self.tree
            .commit(&self.header, &part, &self.rules)
            .expect("committed");
        self.next += 1;
        self.log.push(e);
    }

    fn run(&mut self, t: &Timer) {
        match self.loose.fire(&self.tree, t, |_| false) {
            Some(Fired::Ends(node)) => {
                let h = self.tree.handle(node).expect("live");
                let audience = self.tree.node(h).expect("live").audience();
                self.due.cancel_under(&self.tree, node);
                let e = expired(node, audience, self.next, t.due);
                self.write(e);
                self.loose.removed(node);
            }
            other => panic!("{other:?}"),
        }
    }

    fn jump(&mut self, end: Micros) {
        while let Some(t) = self.due.fire(end) {
            self.run(&t);
        }
    }

    fn step(&mut self, from: Micros, end: Micros) {
        let mut at = from;
        while at < end {
            at += TICK;
            while let Some(t) = self.due.fire(at) {
                self.run(&t);
            }
        }
    }
}

/// The world with every thing set down at `i` seconds, its index in its group.
fn set_down(n: u64) -> World {
    let mut w = world(n);
    for i in 0..n {
        for g in [LOOSE, OWNED, SLOTTED, EVER, PLAIN, LONGER] {
            w.changed(g + i, i as Micros * SECOND);
        }
    }
    w
}

#[test]
fn f10_lifetime_is_section_19_and_kept_is_a_link_or_a_slot() {
    let w = world(1);
    let kind = |n: u64| {
        let h = w.tree.handle(id(n)).expect("live");
        w.tree.node(h).expect("live").kind().as_str().to_owned()
    };
    assert_eq!(lifetime(&w.kinds, &kind(LOOSE)), Some(HOUR));
    assert_eq!(lifetime(&w.kinds, &kind(LONGER)), Some(5 * HOUR));
    assert_eq!(lifetime(&w.kinds, &kind(EVER)), None);
    assert_eq!(lifetime(&w.kinds, &kind(PLAIN)), None);
    assert!(!kept(&w.tree, id(LOOSE)));
    assert!(kept(&w.tree, id(OWNED)));
    assert!(kept(&w.tree, id(SLOTTED)));
    // Section 19 in any other shape is refused by name.
    for bad in ["{2: 0}", "{1: 1, 2: 5}", "{1: 0}", "7"] {
        let mut k = Kinds::default();
        let src = format!(r#"{{1: "t:bad", 2: "thing", 19: {bad}}}"#);
        assert!(k.load(&[("bad", &src)]).is_empty(), "{bad}");
        assert_eq!(k.refused()[0].name, "kind-loose", "{bad}");
    }
}

#[test]
fn f10_a1_a2_loose_things_end_on_time_and_kept_ones_remain() {
    let mut w = set_down(100);
    // One end pending per loose thing of a kind with a lifetime; none for kept ones or ones that last for ever.
    assert_eq!(w.loose.len(), 200);
    assert_eq!(w.due.len(), 200);

    // A1: a lifetime and one second on, every loose brief thing is gone, each by one `thing.expired` effect at its
    // due time, the world its actor.
    w.step(0, HOUR + 100 * SECOND);
    let mut ended = BTreeMap::new();
    for e in &w.log {
        let Body::Changes(c) = &e.body else {
            panic!("a change")
        };
        let [r] = c.as_slice() else { panic!("one") };
        let Change::Remove { node } = r.change else {
            panic!("a remove")
        };
        let events = e.events.as_ref().expect("an event");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].name.as_str(), EXPIRED);
        assert_eq!(e.envelope.actor, Actor::World);
        assert!(
            ended.insert(node, e.envelope.at).is_none(),
            "one effect each"
        );
    }
    assert_eq!(ended.len(), 100);
    for i in 0..100 {
        let set = i as Micros * SECOND;
        let at = ended[&id(LOOSE + i)];
        assert!(at >= set + HOUR && at < set + HOUR + SECOND, "{i}: {at}");
        assert!(!w.live(LOOSE + i));
    }

    // A2: ten lifetimes on, kept things and things whose kind lasts for ever remain; the longer ones ended too.
    w.step(HOUR + 100 * SECOND, 10 * HOUR + 100 * SECOND);
    for i in 0..100 {
        for g in [OWNED, SLOTTED, EVER, PLAIN] {
            assert!(w.live(g + i), "{g} + {i}");
        }
        assert!(!w.live(LONGER + i));
    }
    assert_eq!(w.log.len(), 200);
    assert!(w.loose.is_empty() && w.due.is_empty());
}

#[test]
fn f10_becoming_kept_cancels_and_becoming_loose_starts_one_timer() {
    let mut w = set_down(2);
    // An owner lets go at 10 s: one timer, due an hour later; a second call sets no other.
    w.write(entry(&w, Change::Unlink { link: id(9_000) }, 10 * SECOND));
    let set = w.changed(OWNED, 10 * SECOND);
    assert!(matches!(set, Some(TimerRec::Set { due, .. }) if due == 10 * SECOND + HOUR));
    assert_eq!(w.changed(OWNED, 20 * SECOND), None);
    // A loose thing gains an owner: its timer is cancelled, by a clear record.
    let before = w.due.len();
    w.write(entry(&w, link(9_100, OWNS, LOOSE), 30 * SECOND));
    assert!(matches!(
        w.changed(LOOSE, 30 * SECOND),
        Some(TimerRec::Clear { .. })
    ));
    assert_eq!(w.due.len(), before - 1);
    assert_eq!(w.loose.due(id(LOOSE)), None);
    // A thing a run reserves waits at its end, and ends when the run lets go.
    w.write(entry(&w, link(9_200, RESERVES, LOOSE + 1), 40 * SECOND));
    let t = w.due.fire(Micros::MAX).expect("a timer");
    assert_eq!((t.node, t.due), (id(LOOSE + 1), SECOND + HOUR));
    assert_eq!(
        w.loose.fire(&w.tree, &t, |_| false),
        Some(Fired::Waits(id(LOOSE + 1)))
    );
    assert!(w.live(LOOSE + 1));
    assert!(!w.loose.released(&w.tree, id(LOOSE + 1)), "still reserved");
    // The same wait for the target of an accepted intent, which the caller names.
    let t = w.due.fire(Micros::MAX).expect("a timer");
    assert_eq!(t.node, id(OWNED));
    assert_eq!(
        w.loose.fire(&w.tree, &t, |n| n == id(OWNED)),
        Some(Fired::Waits(id(OWNED)))
    );
    assert!(w.loose.released(&w.tree, id(OWNED)));
}

fn entry(w: &World, change: Change, at: Micros) -> Effect {
    Effect {
        envelope: Envelope {
            sequence: w.next,
            at,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node: id(2),
        },
        body: Body::Changes(vec![ChangeRec {
            change,
            rest: Rest::new(),
        }]),
        events: None,
        rest: Rest::new(),
    }
}

/// A link of type `ty` from body 2 to `thing`, owned by the body.
fn link(n: u64, ty: &str, thing: u64) -> Change {
    Change::Link {
        link: id(n),
        ty: Name::new(ty).expect("a name"),
        ends: [id(2), id(thing)],
        owner: End::First,
        audience: Audience::Everyone,
    }
}

#[test]
fn f10_a3_pending_ends_cost_an_idle_tick_no_read() {
    let mut w = set_down(100);
    // The rest of the world's timers, far off; then 5,000 ends pending beside them.
    for i in 0..5_000 {
        let id = w.mint.mint().expect("an id");
        w.due
            .set(Timer {
                node: id,
                id,
                due: 48 * HOUR + i,
                name: Name::new(ENDS).expect("a name"),
            })
            .expect("set");
    }
    w.tree.reset_reads();
    // An hour of idle ticks before the first end is due reads nothing of the tree.
    let mut fired = 0;
    let mut at = 0;
    while at < HOUR - TICK {
        at += TICK;
        while w.due.fire(at).is_some() {
            fired += 1;
        }
    }
    assert_eq!(fired, 0);
    assert_eq!(w.tree.reads(), (0, 0));
}

/// The cost of an idle tick (its look at the due list) in a world with `others` timers, with and without 5,000 ends
/// pending, ns a tick, best of five runs.
#[allow(clippy::disallowed_methods)] // A3 measures real time; the engine never reads it.
fn idle_tick_ns(others: u64, ends: u64) -> f64 {
    let mut due = DueList::new();
    let mut mint = Minter::new(Scope([0xf2; 16]));
    for i in 0..others + ends {
        let id = mint.mint().expect("an id");
        due.set(Timer {
            node: id,
            id,
            due: HOUR + i as Micros,
            name: Name::new(ENDS).expect("a name"),
        })
        .expect("set");
    }
    let ticks = 200_000;
    let mut best = f64::MAX;
    for _ in 0..5 {
        let start = std::time::Instant::now();
        let mut at = 0;
        for _ in 0..ticks {
            at += 1;
            std::hint::black_box(due.fire(std::hint::black_box(at)));
        }
        best = best.min(start.elapsed().as_nanos() as f64 / f64::from(ticks));
    }
    best
}

#[test]
fn f10_a3_five_thousand_pending_ends_add_no_tick_time() {
    let without = idle_tick_ns(1_000, 0);
    let with = idle_tick_ns(1_000, 5_000);
    eprintln!("f10 a3: idle tick {without:.1} ns without, {with:.1} ns with 5,000 ends pending");
    // Within noise: well under a microsecond a tick either way, in a 50 ms tick.
    assert!(with - without < 1_000.0, "{without} -> {with}");
}

#[test]
fn f10_a4_a_day_in_one_jump_equals_the_day_stepped() {
    let mut jumped = set_down(100);
    let mut stepped = set_down(100);
    jumped.jump(24 * HOUR);
    stepped.step(0, 24 * HOUR);
    assert_eq!(jumped.log.len(), 200);
    assert_eq!(jumped.log, stepped.log);
    assert_eq!(jumped.tree.to_state(), stepped.tree.to_state());
}
