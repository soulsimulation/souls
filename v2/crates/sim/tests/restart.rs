//! Engine v2 K13b (#3119), A4: after a kill and restart mid-walk, every active intent is handed to its skill again
//! and its walker arrives, or it is ended with a named reason; none is left open.
//!
//! On N2's test world, the walker of N7's A3 is ordered from the south room of the ground floor to the north-east
//! room upstairs. Three more orders sit in the log: one already expired by the restart, one naming a skill the world
//! does not know, and one ended before the kill. The orders are written into K4's log (an in-memory disk) as the
//! world would write them; the process is killed mid-walk (the runner and its skills dropped, the disk's power cut),
//! and the restart reads the log back, finds the active orders and hands them back.

mod common;

use common::{arrived, humanoid, id, route, stand, town};
use replica::effects::{
    Actor, Body as Entry, Cause, Effect, Envelope, Event, Header, Part, Rest, schema_hash,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Purpose};
use replica::pose::Vec3;
use replica::time::Micros;
use replica::world_model::{Audience, show};
use sim::host::Runner;
use sim::host::restart::{ORDER_ENDED, Order, active, ended, hand_back};
use sim::log::{Log, Mem};
use sim::walk::{World, node_of};

const SPEED: i64 = 1_400_000;
const TICK: Micros = 50_000;
const WALK: &str = "souls:walk";

fn header(root: Id) -> Header {
    let v = Value::Map(
        [
            (
                1,
                Value::Bytes(Hash::of(Purpose::Fixture, b"souls/restart-test/1").to_bytes()),
            ),
            (2, Value::Bytes(schema_hash().to_bytes())),
            (3, Value::Bytes(root.scope().0.to_vec())),
            (4, root.to_value()),
            (5, Value::Uint(0)),
            (6, Value::Array(Vec::new())),
            (7, Value::Array(Vec::new())),
        ]
        .into(),
    );
    Header::read(&encode(&v).unwrap()).unwrap()
}

/// One part of the log: an entry on `body` for `intent`, carrying `ev`, at `at`.
fn part(h: &Header, seq: u64, at: Micros, body: Id, intent: Id, ev: Event) -> Vec<u8> {
    let e = Effect {
        envelope: Envelope {
            sequence: seq,
            at,
            cause: Cause::Intent(intent),
            actor: Actor::Soul(body),
            audience: Audience::Everyone,
            node: body,
        },
        body: Entry::Changes(Vec::new()),
        events: Some(vec![ev]),
        rest: Rest::new(),
    };
    let v = Value::Map(
        [
            (1, Value::Bytes(h.hash().to_bytes())),
            (2, Value::Array(vec![e.to_value()])),
        ]
        .into(),
    );
    encode(&v).unwrap()
}

/// The disk after a power cut: what a restarted machine reads back.
fn kill(log: Log<Mem>) -> Vec<u8> {
    let n = log.durable();
    log.wait_durable(n).unwrap();
    let disk = log.close();
    let mut d = disk.0.lock().unwrap();
    d.power_cut(0)
}

fn parts(records: &[Vec<u8>]) -> Vec<Part> {
    records.iter().map(|r| Part::read(r).unwrap()).collect()
}

#[test]
fn a4_after_a_kill_mid_walk_each_active_order_is_handed_back_or_ended_by_name() {
    let (mut t, nodes) = town(b"souls/restart-test/1");
    let h = header(nodes["world"]);
    let (f0, f1) = (nodes["building/floor-0"], nodes["building/floor-1"]);
    let goal = {
        let n = t.tree.handle(nodes["building/r1d"]).unwrap();
        t.tree.node(n).unwrap().place().unwrap().position
    };
    let (me, late, odd, done) = (id(1), id(2), id(3), id(4));
    let order = |n: u64, body: Id, skill: &str, expires: Micros| Order {
        intent: id(100 + n),
        body,
        skill: Name::new(skill).unwrap(),
        to: f1,
        goal,
        expires,
    };
    let orders = [
        order(1, me, WALK, 600_000_000),
        order(2, late, WALK, 2_000_000),
        order(3, odd, "souls:juggle", 600_000_000),
        order(4, done, WALK, 600_000_000),
    ];

    // Before the kill: the four orders are accepted into the log; the fourth is ended there; the walker walks.
    let (mut log, _) = Log::open(Mem::default(), 1).unwrap();
    let mut seq = 0;
    let mut write = |log: &mut Log<Mem>, at, body, intent, ev| {
        log.append(part(&h, seq, at, body, intent, ev)).unwrap();
        seq += 1;
    };
    for o in &orders {
        write(&mut log, 0, o.body, o.intent, o.event());
    }
    write(
        &mut log,
        0,
        done,
        orders[3].intent,
        ended(orders[3].intent, "souls:cancelled"),
    );
    let mut r = Runner::new(TICK);
    let start = stand(&t, me, f0, Vec3::new(0, 0, -3_000_000));
    let legs = t.plan(&start, f1, goal).unwrap();
    r.add(humanoid(), start, route(&legs, SPEED, TICK)).unwrap();
    // The other three stand on the open ground, out of the walker's way.
    let ground = nodes["ground"];
    for (who, x) in [(late, 0), (odd, 1_500_000), (done, 3_000_000)] {
        r.add_body(humanoid(), stand(&t, who, ground, Vec3::new(x, 0, 0)))
            .unwrap();
    }
    for _ in 0..100 {
        r.tick(&mut t).unwrap();
    }
    let killed_at = r.now;
    let b = *r.controller.body(me).unwrap();
    println!(
        "killed at {} ms, the walker at ({}, {}, {}) mm on {}, its walk running: {}",
        killed_at / 1000,
        b.pose.position.x / 1000,
        b.pose.position.y / 1000,
        b.pose.position.z / 1000,
        show(node_of(&b)),
        r.running(me)
    );
    assert!(r.running(me), "killed mid-walk");
    assert!(arrived(&r, me).is_none());
    // The bodies as the restarted world holds them: their poses come back with the world, the skills do not. (The
    // controller's bodies are not tree nodes yet, so the poses are carried over here, as replay will restore them.)
    let bodies: Vec<_> = r.controller.bodies().copied().collect();
    drop(r);
    let disk = kill(log);

    // The restart: the log read back, the active orders found and handed back, or ended by name as records.
    let (mut log, found) = Log::open(Mem::with(disk), 1).unwrap();
    let open = active(&parts(&found.records)).unwrap();
    println!("active after the restart:");
    for o in &open {
        println!(
            "  {} on {}: {}",
            show(o.intent),
            show(o.body),
            o.skill.as_str()
        );
    }
    assert_eq!(
        open.iter().map(|o| o.intent).collect::<Vec<_>>(),
        [orders[0].intent, orders[1].intent, orders[2].intent],
        "the order ended before the kill is not active"
    );
    let mut r = Runner::new(TICK);
    r.now = killed_at;
    for b in bodies {
        r.add_body(humanoid(), b).unwrap();
    }
    let ends = hand_back(&mut r, &open, killed_at, |o, b| {
        if o.skill.as_str() != WALK {
            return Ok(None);
        }
        // From where the body stands now, not from where the old run had got to.
        let legs = t.plan(b, o.to, o.goal)?;
        Ok(Some(
            route(&legs, SPEED, TICK) as Box<dyn replica::host::Skill>
        ))
    });
    let mut seq = found.records.len() as u64;
    for (o, why) in &ends {
        println!("  ended {}: {} ({})", show(o.intent), why.name, why.detail);
        log.append(part(
            &h,
            seq,
            killed_at,
            o.body,
            o.intent,
            ended(o.intent, why.name),
        ))
        .unwrap();
        seq += 1;
    }
    assert_eq!(
        ends.iter()
            .map(|(o, why)| (o.intent, why.name))
            .collect::<Vec<_>>(),
        [
            (orders[1].intent, "order-expired"),
            (orders[2].intent, "skill-unknown")
        ]
    );
    assert!(r.running(me), "the walk is handed back to its skill");

    // The walker arrives upstairs; its order ends as done.
    for _ in 0..4_000 {
        if !r.running(me) {
            break;
        }
        r.tick(&mut t).unwrap();
    }
    let at = arrived(&r, me).expect("the walker arrives after the restart");
    let b = *r.controller.body(me).unwrap();
    println!(
        "arrived at {} ms, at ({}, {}, {}) mm on {}",
        at / 1000,
        b.pose.position.x / 1000,
        b.pose.position.y / 1000,
        b.pose.position.z / 1000,
        show(node_of(&b))
    );
    assert_eq!(node_of(&b), f1, "upstairs");
    log.append(part(
        &h,
        seq,
        at,
        me,
        orders[0].intent,
        ended(orders[0].intent, "done"),
    ))
    .unwrap();

    // None is left open: read back once more, every order has an end on the log.
    let disk = kill(log);
    let (_, found) = Log::open(Mem::with(disk), 1).unwrap();
    let all = parts(&found.records);
    assert!(active(&all).unwrap().is_empty(), "none is left open");
    let ends = all
        .iter()
        .flat_map(|p| &p.effects)
        .flat_map(|e| e.events.iter().flatten())
        .filter(|ev| ev.name.as_str() == ORDER_ENDED)
        .count();
    assert_eq!(ends, 4);
}
