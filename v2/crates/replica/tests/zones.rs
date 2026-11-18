//! Zones against their fixtures (Engine v2 T1, #2642; rules in `v2/docs/zones.md`). Each test is one acceptance box,
//! or the case the trunk review asked for; each prints what it saw.

use replica::encode::Value;
use replica::ids::{FIXTURE_SCOPE_A, Held, Id, Minter, Scope};
use replica::world_model::{
    Audience, Draft, FIXTURE_KINDS, Link, Node, check, parse_kinds, parse_world, plain, show,
};
use replica::zones::{
    Arrivals, FIXTURE_SCOPE_ZONE_B, FIXTURE_ZONE_A, FIXTURE_ZONE_B, Fault, Fields, Frame, Own,
    Place, Prev, Record, System, Systems, Transfer, Write, Zone, minter_past, run_in_order, tick,
};
use std::cell::Cell;
use std::collections::BTreeMap;
use std::rc::Rc;

fn node(n: u64) -> Id {
    Id::new(FIXTURE_SCOPE_A, n).unwrap()
}

/// `text` with `from` replaced by `to`, where `from` occurs exactly once.
fn edit(text: &str, from: &str, to: &str) -> String {
    assert_eq!(text.matches(from).count(), 1, "{from:?} occurs once");
    text.replacen(from, to, 1)
}

/// The zone a fixture describes, after T2's check. Its writer mints from `scope`; `lineage` is its world's.
fn zone(text: &str, root: u64, lineage: Scope, scope: Scope) -> Zone {
    let draft = parse_world(&parse_kinds(FIXTURE_KINDS).unwrap(), text).unwrap();
    check(&draft).unwrap();
    let ids = draft
        .nodes
        .iter()
        .map(|n| n.id)
        .chain(draft.links.iter().map(|l| l.id));
    let (minter, held) = minter_past(scope, ids).unwrap();
    Zone::start(node(root), lineage, minter, held, draft).unwrap()
}

/// Zone A, the world's first: it mints from the world's scope.
fn zone_a() -> Zone {
    zone(FIXTURE_ZONE_A, 1, FIXTURE_SCOPE_A, FIXTURE_SCOPE_A)
}

/// Zone B, a second zone of the same world: same lineage, its own scope.
fn zone_b() -> Zone {
    zone(FIXTURE_ZONE_B, 20, FIXTURE_SCOPE_A, FIXTURE_SCOPE_ZONE_B)
}

fn to_garden(b: &Zone) -> Place {
    Place {
        lineage: FIXTURE_SCOPE_A,
        zone: b.id(),
        parent: node(21),
        slot: None,
    }
}

fn to_hall(a: &Zone) -> Place {
    Place {
        lineage: FIXTURE_SCOPE_A,
        zone: a.id(),
        parent: node(2),
        slot: None,
    }
}

/// The lineage, and the one zone's scope, of another world W.
const SCOPE_W: Scope = Scope([0xee; 16]);

/// A world with one zone: a place and a chain of `levels` rooms and boats below it (a room admits a boat, a boat a
/// room), each minted from `scope`. Returns the zone and its node ids, the place first; the node at index k has k
/// ancestors.
fn world(scope: Scope, levels: u64) -> (Zone, Vec<Id>) {
    let kinds = parse_kinds(FIXTURE_KINDS).unwrap();
    let full = |name: &str| kinds.keys().find(|k| plain(k) == name).unwrap().clone();
    let mut m = Minter::new(scope);
    let mut held = Held::default();
    let mut nodes: Vec<Node> = Vec::new();
    for k in 0..=levels {
        let id = m.mint().unwrap();
        held.minted(id);
        nodes.push(Node {
            id,
            kind: full(match k {
                0 => "souls:place",
                _ if k % 2 == 1 => "souls:room",
                _ => "souls:boat",
            }),
            parent: nodes.last().map(|n| n.id),
            slot: None,
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        });
    }
    let ids: Vec<Id> = nodes.iter().map(|n| n.id).collect();
    let draft = Draft {
        kinds,
        nodes,
        ..Draft::default()
    };
    check(&draft).unwrap();
    (Zone::start(ids[0], scope, m, held, draft).unwrap(), ids)
}

/// How many arrived, where none may be refused.
fn arrived(r: Result<Arrivals, Fault>) -> u64 {
    let r = r.unwrap();
    assert!(r.refused.is_empty(), "refused: {:?}", r.refused);
    r.arrived
}

fn state(z: &Zone) -> (Vec<Node>, Vec<Link>) {
    (z.nodes().cloned().collect(), z.links().cloned().collect())
}

/// The zone's state with every id that arrived under a new one written as the id it came with.
fn as_before(z: &Zone) -> (Vec<Node>, Vec<Link>) {
    let old = |id: Id| z.origin(id).unwrap_or(id);
    let mut nodes: Vec<Node> = z
        .nodes()
        .map(|n| Node {
            id: old(n.id),
            parent: n.parent.map(old),
            ..n.clone()
        })
        .collect();
    let mut links: Vec<Link> = z
        .links()
        .map(|l| Link {
            id: old(l.id),
            ends: l.ends.map(old),
            ..l.clone()
        })
        .collect();
    nodes.sort_by_key(|n| n.id);
    links.sort_by_key(|l| l.id);
    (nodes, links)
}

/// How many copies of the body (node 3) and its cup (node 4) exist in the zones, in place or in flight.
fn copies(zones: &[&Zone]) -> (u64, u64) {
    let mut placed = 0;
    let mut in_flight = 0;
    for z in zones {
        placed += z
            .nodes()
            .filter(|n| n.id == node(3) || n.id == node(4))
            .count() as u64;
        for t in z.in_flight() {
            in_flight += t
                .nodes
                .iter()
                .filter(|n| n.id == node(3) || n.id == node(4))
                .count() as u64;
        }
    }
    (placed, in_flight)
}

fn uint(f: Option<&Fields>, field: u64) -> u64 {
    match f.and_then(|f| f.get(&field)) {
        Some(Value::Uint(n)) => *n,
        _ => 0,
    }
}

// ---- Systems ------------------------------------------------------------------------------------------------------

/// The cup is poured from: a thousandth less each tick.
struct Pour(Rc<Cell<Option<u64>>>);
impl System for Pour {
    fn name(&self) -> &str {
        "pour"
    }
    fn step(&self, prev: Prev<'_>, own: Own) -> Vec<Write> {
        let left = uint(prev.fields(own.node()), 1).saturating_sub(1000);
        // A cache of what was written this tick: harmless unless another system reads it (the planted fault).
        self.0.set(Some(left));
        vec![own.set(1, Value::Uint(left))]
    }
}

/// The body sees how full the cup was: another node, as of the previous tick.
struct Watch;
impl System for Watch {
    fn name(&self) -> &str {
        "watch"
    }
    fn step(&self, prev: Prev<'_>, own: Own) -> Vec<Write> {
        let seen = uint(prev.fields(node(4)), 1);
        vec![own.set(2, Value::Uint(seen))]
    }
}

/// The hall counts ticks and names what it last saw the body see.
struct Tally;
impl System for Tally {
    fn name(&self) -> &str {
        "tally"
    }
    fn step(&self, prev: Prev<'_>, own: Own) -> Vec<Write> {
        let seen = uint(prev.fields(node(3)), 2);
        vec![
            own.set(2, Value::Uint(prev.tick())),
            own.set(3, Value::Uint(seen)),
            own.clear(1),
        ]
    }
}

/// Planted: the body reads the cup's level from the pour's cache, that is, as this tick wrote it.
struct Peek(Rc<Cell<Option<u64>>>);
impl System for Peek {
    fn name(&self) -> &str {
        "peek"
    }
    fn step(&self, _prev: Prev<'_>, own: Own) -> Vec<Write> {
        vec![own.set(2, Value::Uint(self.0.get().unwrap_or(0)))]
    }
}

/// The hall counts ticks and caches what it wrote: harmless unless another system reads the cache.
struct Count(Rc<Cell<Option<u64>>>);
impl System for Count {
    fn name(&self) -> &str {
        "count"
    }
    fn step(&self, prev: Prev<'_>, own: Own) -> Vec<Write> {
        let n = uint(prev.fields(own.node()), 1) + 1;
        self.0.set(Some(n));
        vec![own.set(1, Value::Uint(n))]
    }
}

/// Planted: the hall writes the cup's level, a node not its own.
struct Meddle;
impl System for Meddle {
    fn name(&self) -> &str {
        "meddle"
    }
    fn step(&self, _prev: Prev<'_>, own: Own) -> Vec<Write> {
        vec![
            own.set(2, Value::Uint(0)),
            Write {
                node: node(4),
                field: 1,
                value: Some(Value::Uint(0)),
            },
        ]
    }
}

fn frame() -> Frame {
    let a = zone_a();
    Frame {
        tick: 0,
        nodes: a.nodes().map(|n| (n.id, n.fields.clone())).collect(),
    }
}

fn systems(body: Box<dyn System>, hall: Box<dyn System>, cache: Rc<Cell<Option<u64>>>) -> Systems {
    BTreeMap::from([
        (node(2), hall),
        (node(3), body),
        (node(4), Box::new(Pour(cache)) as Box<dyn System>),
    ])
}

#[test]
fn a1_one_ticks_systems_in_two_orders_give_one_result() {
    let s = systems(Box::new(Watch), Box::new(Tally), Rc::new(Cell::new(None)));
    let mut prev = frame();
    for _ in 0..3 {
        let forward: Vec<Id> = s.keys().copied().collect();
        let reverse: Vec<Id> = forward.iter().rev().copied().collect();
        let a = run_in_order(&prev, &s, &forward).unwrap();
        let b = run_in_order(&prev, &s, &reverse).unwrap();
        let next = tick(&prev, &s).unwrap();
        println!(
            "A1 tick {}: order {} gives {}, order {} gives {}",
            next.tick,
            forward
                .iter()
                .map(|i| show(*i))
                .collect::<Vec<_>>()
                .join(","),
            a.hash().unwrap(),
            reverse
                .iter()
                .map(|i| show(*i))
                .collect::<Vec<_>>()
                .join(","),
            b.hash().unwrap(),
        );
        assert_eq!(a, b);
        assert_eq!(a, next);
        prev = next;
    }
    // After three ticks the cup holds 17000; the body saw 18000 (one tick behind); the hall saw what the body saw a
    // tick before that, 19000.
    assert_eq!(uint(prev.nodes.get(&node(4)), 1), 17000);
    assert_eq!(uint(prev.nodes.get(&node(3)), 2), 18000);
    assert_eq!(uint(prev.nodes.get(&node(2)), 3), 19000);
    println!(
        "A1 after 3 ticks: cup 17000, body saw 18000, hall saw 19000 (each read is one tick behind)"
    );
}

#[test]
fn a2_each_planted_bad_system_fails_by_name() {
    let cache = Rc::new(Cell::new(None));
    let peek = systems(Box::new(Peek(cache.clone())), Box::new(Tally), cache);
    let r = tick(&frame(), &peek).unwrap_err();
    println!("A2 a same-tick read of another node: {r}");
    assert_eq!(r.name(), "read-same-tick");
    assert_eq!(
        r.to_string(),
        "read-same-tick: system peek at aa:3 wrote differently in another order [TRUNK T1, v2/docs/zones.md rules 2 and 3] fix: read other nodes only through Prev; drop the shared state, or put both sides in one activity node"
    );

    // The writer first in id order: the hall (aa:2) counts and caches, the body (aa:3) reads the cache. Whichever
    // order runs first leaves this tick's value in the cache for the second, so the check catches it on the ticks
    // where the reverse order runs first.
    let cache = Rc::new(Cell::new(None));
    let writer_first: Systems = BTreeMap::from([
        (node(2), Box::new(Count(cache.clone())) as Box<dyn System>),
        (node(3), Box::new(Peek(cache)) as Box<dyn System>),
    ]);
    let mut prev = frame();
    let mut caught = None;
    for _ in 0..4 {
        match tick(&prev, &writer_first) {
            Ok(next) => prev = next,
            Err(r) => {
                caught = Some((prev.tick, r));
                break;
            }
        }
    }
    let (at, r) = caught.expect("caught within four ticks");
    println!("A2 a same-tick read whose writer comes first, at tick {at}: {r}");
    assert_eq!(r.name(), "read-same-tick");
    assert!(at < 2);

    let meddle = systems(Box::new(Watch), Box::new(Meddle), Rc::new(Cell::new(None)));
    let r = tick(&frame(), &meddle).unwrap_err();
    println!("A2 a write outside its own node: {r}");
    assert_eq!(r.name(), "write-outside-own");
    assert_eq!(
        r.to_string(),
        "write-outside-own: system meddle at aa:2 wrote aa:4 [TRUNK T1, v2/docs/zones.md rules 2 and 3] fix: write only your own node (Own); change another by a transfer, or let its own system read yours next tick"
    );
}

// ---- Transfers ----------------------------------------------------------------------------------------------------

#[test]
fn a3_there_and_back_unchanged() {
    let (mut a, mut b) = (zone_a(), zone_b());
    let before = state(&a);
    let there = a.leave(node(3), to_garden(&b)).unwrap();
    println!(
        "A3 there: transfer {} leaves {} with {} nodes and {} links",
        show(there.id),
        show(a.id()),
        there.nodes.len(),
        there.links.len()
    );
    assert_eq!(arrived(b.arrive_all(std::slice::from_ref(&there))), 1);
    a.settle(there.id).unwrap();
    assert_eq!(copies(&[&a]), (0, 0));
    assert_eq!(copies(&[&b]), (2, 0));
    assert_eq!(
        b.node(node(4)).unwrap().parent,
        Some(node(3)),
        "the cup is still in the hand"
    );
    let back = b.leave(node(3), to_hall(&a)).unwrap();
    println!(
        "A3 back: transfer {} (zone B's own scope) returns it",
        show(back.id)
    );
    assert_eq!(back.id.scope(), FIXTURE_SCOPE_ZONE_B);
    arrived(a.arrive_all(std::slice::from_ref(&back)));
    b.settle(back.id).unwrap();
    let after = state(&a);
    println!(
        "A3 zone A before and after: {} nodes, {} links each, equal: {}",
        after.0.len(),
        after.1.len(),
        before == after
    );
    assert_eq!(before, after);
    assert_eq!((a.in_flight().count(), b.in_flight().count()), (0, 0));

    // To another world W and home again: A has held these ids, so they come home under new ones that keep the old
    // as their origin (T3 rule 6), and the carried links are rewritten to them. Otherwise nothing changed.
    let (mut w, w_ids) = world(SCOPE_W, 1);
    let out = a
        .leave(
            node(3),
            Place {
                lineage: SCOPE_W,
                zone: w.id(),
                parent: w_ids[1],
                slot: None,
            },
        )
        .unwrap();
    arrived(w.arrive_all(std::slice::from_ref(&out)));
    a.settle(out.id).unwrap();
    assert!(
        w.node(node(3)).is_some(),
        "W never held aa:3, so it keeps it"
    );
    let home = w.leave(node(3), to_hall(&a)).unwrap();
    arrived(a.arrive_all(std::slice::from_ref(&home)));
    w.settle(home.id).unwrap();
    let renamed: Vec<String> = a
        .nodes()
        .map(|n| n.id)
        .chain(a.links().map(|l| l.id))
        .filter_map(|id| {
            a.origin(id)
                .map(|o| format!("{} (origin {})", show(id), show(o)))
        })
        .collect();
    let body = a
        .nodes()
        .find(|n| a.origin(n.id) == Some(node(3)))
        .unwrap()
        .id;
    let cup = a.nodes().find(|n| a.origin(n.id) == Some(node(4))).unwrap();
    println!(
        "A3 to world W and home: renamed {}; the cup's parent is {}; equal to before but for the ids: {}",
        renamed.join(", "),
        show(cup.parent.unwrap()),
        as_before(&a) == before
    );
    assert_eq!(renamed.len(), 4, "the body, the cup and their two links");
    assert_eq!(cup.parent, Some(body));
    assert!(
        a.links()
            .all(|l| !l.ends.contains(&node(3)) && !l.ends.contains(&node(4)))
    );
    assert_eq!(as_before(&a), before);
}

#[test]
fn a_leave_keeps_or_ends_links_to_nodes_that_stay() {
    // The body leans on the crate (a link the body owns), and the crate is marked as resting against the body (a
    // link the crate owns). Both join the leaving body to a node that stays.
    let text = edit(
        FIXTURE_ZONE_A,
        "{1: 7, 2: \"owns\", 3: [100, 4], 4: 1, 5: \"everyone\"}",
        "{1: 7, 2: \"owns\", 3: [100, 4], 4: 1, 5: \"everyone\"}, {1: 8, 2: \"leans-on\", 3: [3, 5], 4: 0, 5: \"everyone\"}, \
         {1: 9, 2: \"rests-against\", 3: [5, 3], 4: 0, 5: \"everyone\"}",
    );
    let ids = |ls: &[Link]| ls.iter().map(|l| show(l.id)).collect::<Vec<_>>().join(",");
    // Within one world: each stays with its owning end; nothing is ended.
    let (mut a, mut b) = (zone(&text, 1, FIXTURE_SCOPE_A, FIXTURE_SCOPE_A), zone_b());
    let before = state(&a);
    let t = a.leave(node(3), to_garden(&b)).unwrap();
    let kept: Vec<String> = a.links().map(|l| show(l.id)).collect();
    println!(
        "links within one world: carried {}, ended [{}], kept in zone A {}",
        ids(&t.links),
        ids(&t.ended),
        kept.join(",")
    );
    assert_eq!(ids(&t.links), "aa:6,aa:7,aa:8");
    assert!(t.ended.is_empty());
    assert_eq!(kept, vec!["aa:9"]);
    arrived(b.arrive_all(std::slice::from_ref(&t)));
    let back = b.leave(node(3), to_hall(&a)).unwrap();
    arrived(a.arrive_all(std::slice::from_ref(&back)));
    assert_eq!(state(&a), before, "both links are whole again at home");
    // To another world: both are ended, and the leave lists them.
    let mut a = zone(&text, 1, FIXTURE_SCOPE_A, FIXTURE_SCOPE_A);
    let (w, w_ids) = world(SCOPE_W, 1);
    let to_w = Place {
        lineage: SCOPE_W,
        zone: w.id(),
        parent: w_ids[1],
        slot: None,
    };
    let t = a.leave(node(3), to_w).unwrap();
    println!(
        "links to another world: carried {}, ended {}, left in zone A {}",
        ids(&t.links),
        ids(&t.ended),
        a.links().count()
    );
    assert_eq!(ids(&t.links), "aa:6,aa:7");
    assert_eq!(ids(&t.ended), "aa:8,aa:9");
    assert_eq!(a.links().count(), 0);
}

/// A refused arrive is named, never logged at the destination, holds up no other arrival, and goes back to where
/// it stood under the same transfer id, so nothing stays in flight for ever.
#[test]
fn a_refused_arrive_is_named_goes_back_and_holds_up_nothing() {
    // World W's chain reaches 31 ancestors. The body with its cup is two levels.
    let (mut deep, ids) = world(SCOPE_W, 31);
    let w = deep.id();
    let to = |parent: Id| Place {
        lineage: SCOPE_W,
        zone: w,
        parent,
        slot: None,
    };
    let mut a = zone_a();
    let body = a.leave(node(3), to(ids[31])).unwrap();
    let crate_ = a.leave(node(5), to(ids[1])).unwrap();
    let r = deep.arrive_all(&[body.clone(), crate_.clone()]).unwrap();
    let (refused, why) = r.refused[0].clone();
    println!(
        "refused arrive: {} arrived, transfer {} refused: {why}",
        r.arrived,
        show(refused)
    );
    assert_eq!((r.arrived, refused), (1, body.id));
    assert_eq!(why.name(), "arrive-too-deep");
    assert_eq!(
        why.to_string(),
        "arrive-too-deep: transfer aa:8's deepest node would have 33 ancestors, over 32"
    );
    assert!(deep.node(node(3)).is_none() && deep.node(node(5)).is_some());
    a.settle(crate_.id).unwrap();
    a.take_back(body.id, &why).unwrap();
    let back = a.node(node(3)).unwrap();
    println!(
        "refused arrive: zone A takes the body back under {}, logs return {} ({}), in flight {}",
        show(back.parent.unwrap()),
        show(body.id),
        match a.log().last() {
            Some(Record::Return { reason, .. }) => reason.as_str(),
            _ => "no return",
        },
        a.in_flight().count()
    );
    assert_eq!(back.parent, Some(node(2)));
    assert_eq!(a.node(node(4)).unwrap().parent, Some(node(3)));
    assert_eq!(a.in_flight().count(), 0);
    assert!(
        matches!(a.log().last(), Some(Record::Return { reason, .. }) if reason == "arrive-too-deep")
    );
    // Under a node with 30 ancestors it fits: the cup has 32.
    let mut a = zone_a();
    let t = a.leave(node(3), to(ids[30])).unwrap();
    assert_eq!(arrived(deep.arrive_all(std::slice::from_ref(&t))), 1);
    // An arrival from another world reaches only the world's first zone.
    let mut b = zone_b();
    let stray = deep.leave(ids[31], to_garden(&b)).unwrap();
    let r = b.arrive_all(std::slice::from_ref(&stray)).unwrap();
    println!("an arrival from W in zone B: {}", r.refused[0].1);
    assert_eq!(r.refused[0].1.name(), "arrive-not-first-zone");
}

/// Trunk review of #2969: a change that crosses nodes inside one zone is the same leave and arrive, a tick apart in
/// the zone's one log. A pick-up: the crate leaves the hall floor for the body's left hand.
#[test]
fn a_change_inside_one_zone_is_a_leave_then_an_arrive() {
    let mut a = zone_a();
    let here = |parent: Id, slot: Option<u64>| Place {
        lineage: FIXTURE_SCOPE_A,
        zone: node(1),
        parent,
        slot,
    };
    // Tick n: the leave. The crate is in flight, in nobody's hands.
    let t = a.leave(node(5), here(node(3), Some(1))).unwrap();
    assert!(a.node(node(5)).is_none());
    assert_eq!(a.in_flight().count(), 1);
    // Tick n+1: the arrive, in the same log, under the same id; it also ends the flight.
    assert_eq!(arrived(a.arrive_all(std::slice::from_ref(&t))), 1);
    let crate_ = a.node(node(5)).unwrap();
    let records: Vec<String> = a
        .log()
        .iter()
        .map(|r| match r {
            Record::Start { .. } => "start".to_owned(),
            Record::Leave(t) => format!("leave {}", show(t.id)),
            Record::Arrive(t) => format!("arrive {}", show(t.id)),
            Record::Settle(id) => format!("settle {}", show(*id)),
            Record::Return { transfer, .. } => format!("return {}", show(*transfer)),
        })
        .collect();
    println!(
        "inside one zone: the crate is in {} slot {:?}; zone A's log: {}",
        show(crate_.parent.unwrap()),
        crate_.slot,
        records.join(", ")
    );
    assert_eq!((crate_.parent, crate_.slot), (Some(node(3)), Some(1)));
    assert_eq!(records, vec!["start", "leave aa:8", "arrive aa:8"]);
    assert_eq!(a.in_flight().count(), 0);
    // A crossing the kinds do not admit (the crate into the cup) is refused by T2's name and goes back.
    let bad = a.leave(node(5), here(node(4), None)).unwrap();
    let r = a.arrive_all(std::slice::from_ref(&bad)).unwrap();
    let why = r.refused[0].1.clone();
    println!("inside one zone, the crate into the cup: {why}");
    assert_eq!(why.name(), "child-not-admitted");
    a.take_back(bad.id, &why).unwrap();
    let crate_ = a.node(node(5)).unwrap();
    assert_eq!((crate_.parent, crate_.slot), (Some(node(3)), Some(1)));
    assert_eq!(a.in_flight().count(), 0);
}

#[test]
fn a3_an_arrive_applied_twice_leaves_one_copy() {
    let (mut a, mut b) = (zone_a(), zone_b());
    let t = a.leave(node(3), to_garden(&b)).unwrap();
    let first = arrived(b.arrive_all(std::slice::from_ref(&t)));
    // Delivered again, twice in one batch: nothing more arrives and nothing more is logged.
    let again = arrived(b.arrive_all(&[t.clone(), t.clone()]));
    // A stop before zone A settles: after a restart A sends it once more.
    let (log_a, log_b) = (a.log().to_vec(), b.log().to_vec());
    drop((a, b));
    let (mut a, mut b) = (Zone::replay(&log_a).unwrap(), Zone::replay(&log_b).unwrap());
    let resent: Vec<Transfer> = a.in_flight().cloned().collect();
    let third = arrived(b.arrive_all(&resent));
    a.settle(t.id).unwrap();
    // And a log holding the arrive twice replays to one copy too.
    let mut doubled = b.log().to_vec();
    doubled.push(Record::Arrive(t.clone()));
    let replayed = Zone::replay(&doubled).unwrap();
    let arrives = b
        .log()
        .iter()
        .filter(|r| matches!(r, Record::Arrive(_)))
        .count();
    println!(
        "A3 arrive twice: arrived {first}, then {again}, then {third} after a restart; zone B logs {arrives} arrive; \
         copies (placed, in flight) {:?}; a log with the arrive twice replays to {:?}",
        copies(&[&a, &b]),
        copies(&[&replayed])
    );
    assert_eq!((first, again, third, arrives), (1, 0, 0, 1));
    assert_eq!(copies(&[&a, &b]), (2, 0));
    assert_eq!(copies(&[&replayed]), (2, 0));
    assert_eq!(state(&replayed), state(&b));
}

#[test]
fn a3_a_stop_between_leave_and_arrive_neither_loses_nor_doubles() {
    let (mut a, b) = (zone_a(), zone_b());
    let t = a.leave(node(3), to_garden(&b)).unwrap();
    // The stop: the leave is in A's log, no arrive is in B's. Both writers restart from their logs.
    let (log_a, log_b) = (a.log().to_vec(), b.log().to_vec());
    drop((a, b));
    let (mut a, mut b) = (Zone::replay(&log_a).unwrap(), Zone::replay(&log_b).unwrap());
    let at_restart = copies(&[&a, &b]);
    println!("A3 stop: after the restart, copies (placed, in flight) {at_restart:?}");
    assert_eq!(
        at_restart,
        (0, 2),
        "the body and its cup are in flight, in zone A's log"
    );
    let resent: Vec<Transfer> = a.in_flight().cloned().collect();
    assert_eq!(resent, vec![t.clone()]);
    // A checkpoint keeps the flight: replayed from it alone, zone A still has the transfer to send.
    let from_checkpoint = Zone::replay(&[a.checkpoint()]).unwrap();
    assert_eq!(
        from_checkpoint.in_flight().cloned().collect::<Vec<_>>(),
        resent
    );
    println!(
        "A3 stop: zone A replayed from a checkpoint alone has {} in flight",
        resent.len()
    );
    arrived(b.arrive_all(&resent));
    a.settle(t.id).unwrap();
    let done = copies(&[&a, &b]);
    println!("A3 stop: sent again and settled, copies (placed, in flight) {done:?}");
    assert_eq!(done, (2, 0));
}

#[test]
fn a4_a_body_leaves_only_with_what_its_soul_owns() {
    // The body also holds, in its left hand, a key its Soul does not own.
    let text = edit(
        FIXTURE_ZONE_A,
        "    {1: 5, 2: \"souls:crate\", 3: 2}\n",
        "    {1: 5, 2: \"souls:crate\", 3: 2},\n    {1: 8, 2: \"souls:key\", 3: 3, 4: 1}\n",
    );
    let (w, w_ids) = world(SCOPE_W, 1);
    let to_w = Place {
        lineage: SCOPE_W,
        zone: w.id(),
        parent: w_ids[1],
        slot: None,
    };
    let mut a = zone(&text, 1, FIXTURE_SCOPE_A, FIXTURE_SCOPE_A);
    let before = a.log().len();
    let r = a.leave(node(3), to_w).unwrap_err();
    println!("A4 to another world: {r}");
    assert_eq!(r.name(), "leave-holds-unowned");
    assert_eq!(
        r.to_string(),
        "leave-holds-unowned: body aa:3 holds aa:8, which its Soul does not own"
    );
    assert_eq!(a.log().len(), before, "a refused leave writes nothing");
    assert!(a.node(node(3)).is_some());
    // Inside the world a zone boundary is invisible: the same body walks into zone B with the key.
    let t = a.leave(node(3), to_garden(&zone_b())).unwrap();
    println!(
        "A4 into the next zone of the same world: the leave carries {} nodes, the key among them",
        t.nodes.len()
    );
    assert!(t.nodes.iter().any(|n| n.id == node(8)));
    // Owned, the key goes to the other world too.
    let owned = edit(
        &text,
        "{1: 7, 2: \"owns\", 3: [100, 4], 4: 1, 5: \"everyone\"}",
        "{1: 7, 2: \"owns\", 3: [100, 4], 4: 1, 5: \"everyone\"}, {1: 9, 2: \"owns\", 3: [100, 8], 4: 1, 5: \"everyone\"}",
    );
    let mut a = zone(&owned, 1, FIXTURE_SCOPE_A, FIXTURE_SCOPE_A);
    let t = a.leave(node(3), to_w).unwrap();
    println!(
        "A4 the key owned too: the leave to another world carries {} nodes",
        t.nodes.len()
    );
    assert_eq!(t.nodes.len(), 3);
}

/// Trunk review of #2967: two arrivals of one id in one tick are applied one at a time, and "held" includes the
/// arrival before, so they never keep one id. Here world A and its fork C each send their crate `aa:5` to world W.
#[test]
fn two_arrivals_of_one_id_in_one_tick_get_two_ids() {
    const SCOPE_C: Scope = Scope([0xcc; 16]);
    let world_w = || {
        let (w, ids) = world(SCOPE_W, 1);
        (w, ids[1])
    };
    let (_, room) = world_w();
    let mut a = zone_a();
    // The fork keeps the ids it carries and carries no bodies; its writer mints from its own scope.
    let fork: Vec<Node> = zone_a()
        .nodes()
        .filter(|n| n.id != node(3) && n.id != node(4))
        .cloned()
        .collect();
    let (_, held_c) = minter_past(FIXTURE_SCOPE_A, fork.iter().map(|n| n.id)).unwrap();
    let kinds = parse_kinds(FIXTURE_KINDS).unwrap();
    let fork = Draft {
        kinds,
        nodes: fork,
        ..Draft::default()
    };
    let mut c = Zone::start(node(1), SCOPE_C, Minter::new(SCOPE_C), held_c, fork).unwrap();
    let to = |w: &Zone| Place {
        lineage: SCOPE_W,
        zone: w.id(),
        parent: room,
        slot: None,
    };
    let (w0, _) = world_w();
    let from_a = a.leave(node(5), to(&w0)).unwrap();
    let from_c = c.leave(node(5), to(&w0)).unwrap();
    let mut results = Vec::new();
    for delivered in [
        [from_a.clone(), from_c.clone()],
        [from_c.clone(), from_a.clone()],
    ] {
        let (mut w, _) = world_w();
        assert_eq!(arrived(w.arrive_all(&delivered)), 2);
        let crates: Vec<(Id, Option<Id>)> = w
            .nodes()
            .filter(|n| n.kind.starts_with("souls:crate@"))
            .map(|n| (n.id, w.origin(n.id)))
            .collect();
        println!(
            "two arrivals of aa:5 in one tick, delivered {} first: crates {}",
            show(delivered[0].id),
            crates
                .iter()
                .map(|(id, o)| match o {
                    Some(o) => format!("{} (origin {})", show(*id), show(*o)),
                    None => show(*id),
                })
                .collect::<Vec<_>>()
                .join(", ")
        );
        results.push(state(&w));
        assert_eq!(crates.len(), 2);
        assert_ne!(crates[0].0, crates[1].0);
        assert!(crates.contains(&(node(5), None)));
        assert!(
            crates
                .iter()
                .any(|(id, o)| id.scope() == SCOPE_W && *o == Some(node(5)))
        );
    }
    assert_eq!(
        results[0], results[1],
        "the delivery order does not change the result"
    );
}
