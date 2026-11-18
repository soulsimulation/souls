//! The due list (Engine v2 K9, #2672): a world that jumps to the next due time writes the same entries, at the same
//! world times, and ends in the same state as the same world stepped tick by tick (A2), also with the tick rate
//! changed inside the gap (A3); removing a node cancels the timers of its subtree (A5); a skill's staged timers reach
//! the list. `cargo test -p sim --test timers`.
//!
//! The scenario here is also the `timers` bench's (`v2/tools/bench/src/timers.rs` includes this file by path), which
//! runs it at full size and times it (A1, A4).

// The bench includes this file: the tests' own helpers are unused there.
#![allow(dead_code, unused_imports)]
// Times its commits, for the bench: the wall-clock rule (K7) binds the engine, not this test.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, TimerRec,
    schema_hash,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::time::{Mapping, Micros, Tempo, TickRate, TimeEffect, Timeline};
use replica::tree::Tree;
use replica::world_model::Audience;
use sim::host::{self, Staged};
use sim::timers::{DueList, Timer};

pub const HOUR: Micros = 3_600_000_000;
/// The field a fire counts in, on the timer's node.
pub const F_FIRES: u64 = 900;

pub fn splitmix(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// What the scenario is: a test world of `things` things, `timers` of its nodes with a timer each, every timer firing
/// `fires` times inside `span` µs (then set once more, due after it), stepped at 20 ticks a second, with the rate
/// changed to 30 at `change_at` when given (a whole tenth of a second, so the span's end is a tick under both rates).
#[derive(Clone, Copy, Debug)]
pub struct Scenario {
    pub seed: u64,
    pub things: usize,
    pub timers: usize,
    pub fires: u64,
    pub span: Micros,
    pub change_at: Option<Micros>,
}

/// One run of the scenario: the world's tree, its due list and the entries written, in order.
pub struct World {
    pub tree: Tree,
    header: Header,
    pub line: Timeline,
    pub due: DueList,
    mint: Minter,
    next: u64,
    audience: BTreeMap<Id, Audience>,
    period: BTreeMap<Id, Micros>,
    fired: BTreeMap<Id, u64>,
    fires: u64,
    span: Micros,
    pub written: Vec<Effect>,
    pending: Vec<Effect>,
    pub ticks: u64,
    /// Time spent committing: encoding the parts, reading them back, and the tree's apply.
    pub spent: [Duration; 3],
}

fn name(s: &str) -> Name {
    Name::new(s).expect("a name")
}

fn header(zone: Id) -> Header {
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/k9-timers/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(zone.scope().0.to_vec())),
        (4, zone.to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(Vec::new())),
        (7, Value::Array(Vec::new())),
    ]));
    Header::read(&encode(&v).expect("bytes")).expect("a header")
}

fn timeline() -> Timeline {
    Timeline::start(
        Mapping::new(0, 0, 1, 1).expect("a mapping"),
        TickRate::new(0, 0, 20).expect("20 a second"),
        Tempo::per_minute(0, 0, 120).expect("a tempo"),
    )
    .expect("a timeline")
}

impl World {
    /// The scenario's world with its timers set at world time 0, those entries applied.
    pub fn new(s: &Scenario) -> World {
        let w = testworld::generate(s.seed, s.things).expect("the test world");
        let im = import_eden::load(&w.text).expect("the test world loads");
        let tree = im.tree;
        let root = tree.node(tree.root()).expect("a root").id();
        let next = tree.to_state().next;
        let mut world = World {
            header: header(root),
            line: timeline(),
            due: DueList::new(),
            mint: Minter::new(Scope([0x4b; 16])),
            next,
            audience: BTreeMap::new(),
            period: BTreeMap::new(),
            fired: BTreeMap::new(),
            fires: s.fires,
            span: s.span,
            written: Vec::new(),
            pending: Vec::new(),
            ticks: 0,
            spent: [Duration::ZERO; 3],
            tree,
        };
        let nodes: Vec<Id> = im
            .nodes
            .values()
            .copied()
            .filter(|&n| n != root)
            .take(s.timers)
            .collect();
        assert_eq!(nodes.len(), s.timers, "the world has a node for each timer");
        let most = s.span / i64::try_from(s.fires).expect("fires");
        for (i, &node) in nodes.iter().enumerate() {
            let r = splitmix(s.seed ^ splitmix(i as u64));
            let p = most - (r % (most as u64 * 7 / 12)) as i64;
            let first = (splitmix(r) % p as u64) as i64;
            let h = world.tree.handle(node).expect("a node");
            let audience = world.tree.node(h).expect("a node").audience();
            world.audience.insert(node, audience);
            world.period.insert(node, p);
            let id = world.mint.mint().expect("an id");
            world.due.set(timer(node, id, first)).expect("set");
            world.entry(node, 0, Body::Timers(vec![set_rec(id, first)]));
        }
        world.commit();
        world
    }

    fn entry(&mut self, node: Id, at: Micros, body: Body) {
        self.pending.push(Effect {
            envelope: Envelope {
                sequence: self.next,
                at,
                cause: Cause::World,
                actor: Actor::World,
                audience: self.audience[&node],
                node,
            },
            body,
            events: None,
            rest: Rest::new(),
        });
        self.next += 1;
    }

    /// Applies the entries written since the last commit to the tree, as one part.
    pub fn commit(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let t0 = Instant::now();
        let v = Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (
                2,
                Value::Array(self.pending.iter().map(Effect::to_value).collect()),
            ),
        ]));
        let bytes = encode(&v).expect("bytes");
        let t1 = Instant::now();
        let part = Part::read(&bytes).expect("a part");
        let t2 = Instant::now();
        self.tree.apply(&self.header, &part).expect("applies");
        for (s, d) in self.spent.iter_mut().zip([t1 - t0, t2 - t1, t2.elapsed()]) {
            *s += d;
        }
        self.written.append(&mut self.pending);
    }

    /// Runs a fired timer at its due time: the node counts the fire, clears the timer and sets the next.
    fn run(&mut self, t: Timer) {
        let count = self.fired.get(&t.node).copied().unwrap_or(0) + 1;
        self.fired.insert(t.node, count);
        let set = Change::Set {
            node: t.node,
            field: F_FIRES,
            to: Value::Uint(count),
            by: None,
        };
        self.entry(
            t.node,
            t.due,
            Body::Changes(vec![ChangeRec {
                change: set,
                rest: Rest::new(),
            }]),
        );
        let p = self.period[&t.node];
        let due = if count < self.fires {
            t.due + p
        } else {
            self.span + p
        };
        let id = self.mint.mint().expect("an id");
        self.due.set(timer(t.node, id, due)).expect("set");
        self.entry(
            t.node,
            t.due,
            Body::Timers(vec![TimerRec::Clear { timer: t.id }, set_rec(id, due)]),
        );
    }

    /// Runs tick `n`: every timer due in its span, each at its due time, then the tick's entries applied.
    fn tick(&mut self, n: i64) {
        let end = self.line.tick_start(n + 1).expect("a tick");
        while let Some(t) = self.due.fire(end) {
            assert!(
                t.due >= self.line.tick_start(n).expect("a tick"),
                "a timer fires in the tick that holds it"
            );
            self.run(t);
        }
        self.commit();
        self.ticks += 1;
    }

    /// The rate change to 30 a second at `at`, written during the tick before it.
    fn change(&mut self, at: Micros) {
        let tick = self.line.tick_of(at).expect("a tick");
        let effect = TimeEffect::TickRate(TickRate::new(at, tick, 30).expect("30 a second"));
        self.line.apply(effect, at - 1).expect("the rate changes");
    }

    /// Every tick from 0 to the span's end, one by one.
    pub fn step(&mut self, change_at: Option<Micros>) {
        let mut n = 0;
        while self.line.tick_start(n).expect("a tick") < self.span {
            if let Some(at) = change_at
                && self.line.tick_start(n + 1).expect("a tick") == at
            {
                self.change(at);
            }
            self.tick(n);
            n += 1;
        }
    }

    /// Only the ticks something is due in, jumping over the rest, to the span's end. The rate change is in the log
    /// before the run (the gap holds it).
    pub fn jump(&mut self, change_at: Option<Micros>) {
        if let Some(at) = change_at {
            self.change(at);
        }
        let mut n = 0;
        while let Some(m) = self.due.next_tick(&self.line, n).expect("a tick") {
            if self.line.tick_start(m).expect("a tick") >= self.span {
                break;
            }
            self.tick(m);
            n = m + 1;
        }
    }

    /// Fires counted, over every node.
    pub fn fired(&self) -> u64 {
        self.fired.values().sum()
    }
}

fn timer(node: Id, id: Id, due: Micros) -> Timer {
    Timer {
        node,
        id,
        due,
        name: name("k9:beat"),
    }
}

fn set_rec(id: Id, due: Micros) -> TimerRec {
    TimerRec::Set {
        timer: id,
        due,
        name: name("k9:beat"),
    }
}

/// Runs the scenario both ways and checks they agree: the entries with their world times, the tree's state and the
/// due list. Returns the two worlds.
pub fn both(s: &Scenario) -> (World, World) {
    let mut jumped = World::new(s);
    jumped.jump(s.change_at);
    let mut stepped = World::new(s);
    stepped.step(s.change_at);
    assert_eq!(
        jumped.fired(),
        s.timers as u64 * s.fires,
        "every timer fired its count"
    );
    assert_eq!(
        jumped.written.len(),
        stepped.written.len(),
        "as many entries"
    );
    for (a, b) in jumped.written.iter().zip(&stepped.written) {
        assert_eq!(a, b, "the same entry at the same world time");
    }
    assert_eq!(
        jumped.tree.to_state(),
        stepped.tree.to_state(),
        "the same state"
    );
    assert_eq!(jumped.due, stepped.due, "the same timers pending");
    assert_eq!(
        jumped.due.len(),
        s.timers,
        "each node's last timer is pending"
    );
    assert_eq!(
        DueList::from_state(&jumped.tree.to_state().timers),
        jumped.due,
        "the list is the tree's timers"
    );
    (jumped, stepped)
}

const SMALL: Scenario = Scenario {
    seed: 7,
    things: 300,
    timers: 100,
    fires: 10,
    span: 4 * HOUR,
    change_at: None,
};

#[test]
fn a_jump_equals_every_tick() {
    let (jumped, stepped) = both(&SMALL);
    assert!(jumped.ticks <= 1_000 && stepped.ticks == 4 * 3_600 * 20);
}

#[test]
fn a_jump_equals_every_tick_with_the_rate_changed_in_the_gap() {
    let s = Scenario {
        change_at: Some(HOUR + 300_000),
        ..SMALL
    };
    let (_, stepped) = both(&s);
    assert_eq!(stepped.ticks, 72_006 + 323_991);
    assert_eq!(
        stepped.line.tick_of(4 * HOUR).expect("a tick"),
        stepped.ticks as i64,
        "the span ends on a tick"
    );
}

#[test]
fn removing_a_node_cancels_its_subtrees_timers() {
    let mut w = World::new(&Scenario { timers: 0, ..SMALL });
    let root = w.tree.node(w.tree.root()).expect("a root").id();
    // A node with children, its first child, and a sibling of the node, outside its subtree.
    let (mut walk, mut found) = (vec![w.tree.root()], None);
    while let Some(h) = walk.pop() {
        let kids = w.tree.children(h).expect("children").to_vec();
        if let Some(&p) = kids
            .iter()
            .find(|&&k| !w.tree.children(k).expect("children").is_empty())
            && let Some(&o) = kids.iter().find(|&&k| k != p)
        {
            found = Some((p, w.tree.children(p).expect("children")[0], o));
            break;
        }
        walk.extend(kids);
    }
    let (parent, child, other) = found.expect("a node with children and a sibling");
    let id = |h| w.tree.node(h).expect("a node").id();
    let (parent, child, other) = (id(parent), id(child), id(other));
    for n in [root, parent, child, other] {
        w.audience.insert(n, Audience::Everyone);
    }
    let mut ids = Vec::new();
    for (node, due) in [(parent, 5), (child, 3), (other, 4), (parent, 9)] {
        let t = w.mint.mint().expect("an id");
        w.due.set(timer(node, t, due)).expect("set");
        w.entry(node, 0, Body::Timers(vec![set_rec(t, due)]));
        ids.push(t);
    }
    w.commit();

    let gone = w.due.cancel_under(&w.tree, parent);
    assert_eq!(
        gone.iter().map(|t| (t.node, t.due)).collect::<Vec<_>>(),
        [(child, 3), (parent, 5), (parent, 9)],
        "the subtree's timers, in key order"
    );
    for t in &gone {
        w.entry(
            t.node,
            10,
            Body::Timers(vec![TimerRec::Clear { timer: t.id }]),
        );
    }
    let remove = Change::Remove { node: parent };
    w.entry(
        parent,
        10,
        Body::Changes(vec![ChangeRec {
            change: remove,
            rest: Rest::new(),
        }]),
    );
    w.commit();
    assert!(w.tree.handle(parent).is_none(), "the node is removed");
    assert_eq!(w.due.len(), 1);
    assert_eq!(w.due.fire(i64::MAX).map(|t| t.node), Some(other));
    assert_eq!(
        w.tree.to_state().timers.keys().copied().collect::<Vec<_>>(),
        [ids[2]],
        "the tree holds only the other node's timer"
    );
    assert_eq!(
        w.due.cancel_under(&w.tree, parent),
        [],
        "nothing left under it"
    );
}

#[test]
fn equal_due_times_fire_in_id_order_and_cancel_by_key() {
    let mut due = DueList::new();
    let mut mint = Minter::new(Scope([1; 16]));
    let node = mint.mint().expect("an id");
    let ids: Vec<Id> = (0..3).map(|_| mint.mint().expect("an id")).collect();
    for &t in ids.iter().rev() {
        due.set(timer(node, t, 100)).expect("set");
    }
    assert_eq!(
        due.set(timer(node, ids[0], 50)).map_err(|r| r.name),
        Err("id-duplicate")
    );
    assert_eq!(due.next_due(), Some(100));
    assert_eq!(due.fire(100), None, "nothing is due before 100");
    assert!(due.cancel((100, ids[1])).is_some());
    assert_eq!(due.fire(101).map(|t| t.id), Some(ids[0]));
    assert_eq!(due.fire(101).map(|t| t.id), Some(ids[2]));
    assert_eq!(due.fire(101), None);
    assert_eq!(due.next_due(), None);
}

#[test]
fn a_skills_staged_timers_reach_the_list() {
    let mut due = DueList::new();
    let mut mint = Minter::new(Scope([2; 16]));
    let (body, other) = (mint.mint().expect("an id"), mint.mint().expect("an id"));
    let (a, b) = (mint.mint().expect("an id"), mint.mint().expect("an id"));
    let mut staged = Staged::default();
    for (id, due) in [(a, 40), (b, 20)] {
        staged.timers.push(host::Timer {
            body,
            id,
            due,
            name: name("k9:beat"),
        });
    }
    staged.cleared.push((body, b));
    staged.cleared.push((other, a));
    let refused = due.apply(&staged);
    assert_eq!(
        refused
            .iter()
            .map(|(n, r)| (*n, r.name))
            .collect::<Vec<_>>(),
        [(other, "not-own-node")],
        "a body clears only its own timers"
    );
    assert_eq!(due.len(), 1);
    assert_eq!(due.next_due(), Some(40));
    assert_eq!(due.clear(body, b).map_err(|r| r.name), Err("timer-missing"));
    assert_eq!(due.clear(body, a).map(|t| t.due), Ok(40));
}
