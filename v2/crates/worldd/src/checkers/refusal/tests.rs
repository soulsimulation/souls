//! I6 (#2691): each `aN_` test is one acceptance box. Staleness is random but seeded, so a failure repeats.

use super::{STATE_LIMIT, repair, states_of};
use crate::checkers::toggles::World;
use crate::checkers::{Act, Candidate, check};
use replica::apply::Replica;
use replica::effects::{Actor, Cause, Part};
use replica::encode::{Name, Value, decode, encode};
use replica::hash::node_hash;
use replica::ids::Id;
use replica::intents::Answer;
use replica::world_model::Audience;
use sim::commit::{Checks, Outcome, commit};
use std::collections::BTreeSet;

/// xorshift64*, seeded: the tests' only randomness.
struct Rng(u64);

impl Rng {
    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 33) as usize % n
    }
}

/// A Soul that acts through `body` on `thing`, decided on its copy at `basis` (its one check: a stale read is refused).
fn act(principal: Id, body: Id, thing: Id) -> Act {
    Act {
        id: 1,
        cause: Cause::World,
        actor: Actor::Soul(principal),
        body,
        candidates: vec![Candidate {
            this: thing,
            form: "switch_on".into(),
        }],
        recheck: Some(0),
    }
}

/// Commits `checks` on the server, which must refuse them as stale.
fn refuse(server: &mut World, checks: &Checks) {
    match commit(&mut server.replica, checks, 0) {
        Outcome::Refused { reason } => assert_eq!(reason, "stale"),
        other => panic!("not refused: {other:?}"),
    }
}

/// The refusal of `checks` as the client gets it: built, encoded and decoded.
fn frame(server: &World, principal: Id, checks: &Checks, basis: u64, limit: usize) -> Value {
    let answer = Answer::Refused {
        actor: Actor::Soul(principal),
        sequence: 1,
        reason: Name::new("stale").unwrap_or_else(|| unreachable!()),
        now: Value::Uint(server.replica.version()),
        changed: Vec::new(),
    };
    let frame = repair(&answer, &server.replica, checks, basis, limit);
    let bytes = encode(&frame).unwrap_or_else(|e| panic!("a refusal encodes: {e}"));
    decode(&bytes)
        .unwrap_or_else(|e| panic!("a refusal decodes: {e}"))
        .value
}

fn refused(server: &mut World, principal: Id, checks: &Checks, basis: u64, limit: usize) -> Value {
    refuse(server, checks);
    frame(server, principal, checks, basis, limit)
}

/// Random staleness on the server: one to four changes, at least one to a node of the read set (`thing` or `body`).
fn stale(server: &mut World, rng: &mut Rng, body: Id, thing: Id) -> Vec<Part> {
    let mut parts = Vec::new();
    let n = 1 + rng.below(4);
    for k in 0..n {
        let level = rng.below(1000) as u64;
        let part = match (k, rng.below(3)) {
            (0, 0) | (_, 2) => server.set(body, 9, level, Audience::Everyone),
            (0, _) => server.dim(thing, level),
            _ => {
                let other = server.pairs[rng.below(server.pairs.len())].1;
                server.dim(other, level)
            }
        };
        parts.push(part);
    }
    parts
}

fn hashes(r: &Replica, ids: &[Id]) -> Vec<Option<Vec<u8>>> {
    ids.iter()
        .map(|id| node_hash(r.tree(), *id).map(|h| h.to_bytes()))
        .collect()
}

fn read_set(checks: &Checks) -> Vec<Id> {
    checks.candidates[0].reads.iter().map(|(i, _)| *i).collect()
}

fn size(v: &Value) -> usize {
    encode(v).map_or(0, |b| b.len())
}

/// A1 and A5: 1,000 refusals forced by random staleness. After the client applies each, its hashes for the nodes the
/// check read equal the server's; the payload sizes are printed (`--nocapture`).
#[test]
fn a1_a5_a_thousand_stale_refusals_repair_the_copy() {
    let mut server = World::build(2, 10, 0);
    let principal = Id::new(server.pairs[0].0.scope(), 1 << 40).unwrap_or_else(|| unreachable!());
    let mut rng = Rng(0x0016_2691);
    let mut sizes = Vec::new();
    for _ in 0..1000 {
        let (body, thing) = server.pairs[rng.below(server.pairs.len())];
        let basis = server.replica.version();
        let mut client = server.replica.frozen();
        let checks = check(
            &client,
            &super::super::toggles::rules(),
            &act(principal, body, thing),
        );
        stale(&mut server, &mut rng, body, thing);
        let frame = refused(&mut server, principal, &checks, basis, STATE_LIMIT);
        sizes.push(size(&frame));
        let repaired = client.apply_states(&states_of(&frame));
        assert!(repaired.fetch.is_empty(), "{repaired:?}");
        let ids = read_set(&checks);
        assert_eq!(hashes(&client, &ids), hashes(&server.replica, &ids));
    }
    sizes.sort_unstable();
    println!(
        "a5 payload: {} refusals, median {} bytes, largest {} bytes",
        sizes.len(),
        sizes[sizes.len() / 2],
        sizes[sizes.len() - 1]
    );
}

/// Every id and value in a record, flattened.
fn leaves(v: &Value, out: &mut Vec<Value>) {
    match v {
        Value::Array(a) => a.iter().for_each(|x| leaves(x, out)),
        Value::Map(m) => m.values().for_each(|x| leaves(x, out)),
        other => out.push(other.clone()),
    }
}

/// A2: a refusal names its code and withholds what is outside the actor's audience. The check read a thing private
/// to someone else, one private to the actor and the body; all three changed. Only the actor's own and the public
/// node are carried; the other's id and its distinctive level appear nowhere in the refusal.
#[test]
fn a2_no_field_outside_the_actors_audience() {
    let mut server = World::build(1, 2, 0);
    let scope = server.pairs[0].0.scope();
    let (me, other) = (
        Id::new(scope, 1 << 40).unwrap_or_else(|| unreachable!()),
        Id::new(scope, (1 << 40) + 1).unwrap_or_else(|| unreachable!()),
    );
    let (body, _) = server.pairs[0];
    let room = server.replica.path(body).unwrap_or_default()[1];
    let theirs = server.toggle_of(room, Audience::Of(other));
    let mine = server.toggle_of(room, Audience::Of(me));
    let basis = server.replica.version();
    let copy = server.replica.frozen();
    let mut a = act(me, body, theirs);
    a.candidates.push(Candidate {
        this: mine,
        form: "switch_on".into(),
    });
    let checks = check(&copy, &super::super::toggles::rules(), &a);
    server.set(theirs, 3, 777_777, Audience::Of(other));
    server.set(mine, 3, 555_555, Audience::Of(me));
    server.set(body, 9, 333_333, Audience::Everyone);
    let frame = refused(&mut server, me, &checks, basis, STATE_LIMIT);
    let mut all = Vec::new();
    leaves(&frame, &mut all);
    assert!(
        !all.contains(&Value::Uint(777_777)),
        "the other's level leaked"
    );
    assert!(
        !all.contains(&theirs.to_value()),
        "the other's node is named"
    );
    let carried: BTreeSet<Id> = states_of(&frame).iter().map(|s| s.id).collect();
    assert_eq!(carried, BTreeSet::from([body, mine]));
    assert!(all.contains(&Value::Uint(555_555)) && all.contains(&Value::Uint(333_333)));
}

/// A3: over the byte limit a refusal carries node ids and hashes only, and the hashes are the server's.
#[test]
fn a3_over_the_limit_ids_and_hashes_only() {
    let mut server = World::build(1, 2, 0);
    let principal = Id::new(server.pairs[0].0.scope(), 1 << 40).unwrap_or_else(|| unreachable!());
    let (body, thing) = server.pairs[0];
    let basis = server.replica.version();
    let checks = check(
        &server.replica.frozen(),
        &super::super::toggles::rules(),
        &act(principal, body, thing),
    );
    server.dim(thing, 42);
    server.set(body, 9, 7, Audience::Everyone);
    refuse(&mut server, &checks);
    let full = frame(&server, principal, &checks, basis, STATE_LIMIT);
    let limit = size(&full) / 2;
    let frame = frame(&server, principal, &checks, basis, limit);
    let Value::Map(m) = &frame else {
        panic!("a map")
    };
    assert!(m.get(&8).is_none() && states_of(&frame).is_empty());
    let Some(Value::Array(rows)) = m.get(&9) else {
        panic!("no ids and hashes: {frame:?}")
    };
    let mut want = vec![body, thing];
    want.sort();
    for (row, id) in rows.iter().zip(&want) {
        let Value::Array(r) = row else {
            panic!("a row")
        };
        assert_eq!(r.len(), 3, "id, stamp, hash and nothing else");
        assert_eq!(r[0], id.to_value());
        let h = node_hash(server.replica.tree(), *id).unwrap_or_else(|| unreachable!());
        assert_eq!(r[2], h.to_value());
    }
    assert_eq!(rows.len(), 2);
}

/// A4: a refusal applied together with the stream never rewinds a node, in either order. The client holds the copy
/// it decided on; the server moves on before the refusal (the staleness) and after it. Each case applies the stream
/// up to a random point, the refusal, then the rest, and after every step each node the check read is as new as the
/// server's at the later of the client's version and the refusal's.
#[test]
fn a4_never_rewinds_a_node_in_either_order() {
    let mut server = World::build(1, 6, 0);
    let principal = Id::new(server.pairs[0].0.scope(), 1 << 40).unwrap_or_else(|| unreachable!());
    let mut rng = Rng(0x0026_91a4);
    let (mut before, mut after) = (0, 0);
    for _ in 0..300 {
        let (body, thing) = server.pairs[rng.below(server.pairs.len())];
        let basis = server.replica.version();
        let mut client = server.replica.frozen();
        let checks = check(
            &client,
            &super::super::toggles::rules(),
            &act(principal, body, thing),
        );
        let ids = read_set(&checks);
        let mut stream = stale(&mut server, &mut rng, body, thing);
        let frame = refused(&mut server, principal, &checks, basis, STATE_LIMIT);
        let now = server.replica.version();
        stream.extend(stale(&mut server, &mut rng, body, thing));
        // The server's hashes of the read set at each version from the basis on, replayed on a copy.
        let mut replay = client.frozen();
        let mut history = vec![hashes(&replay, &ids)];
        for p in &stream {
            replay
                .apply(p)
                .unwrap_or_else(|e| panic!("the stream applies: {e}"));
            history.push(hashes(&replay, &ids));
        }
        assert_eq!(history.last(), Some(&hashes(&server.replica, &ids)));
        let at = |v: u64| &history[usize::try_from(v - basis).unwrap_or(0)];
        let cut = rng.below(stream.len() + 1);
        if (basis + cut as u64) < now {
            before += 1;
        } else {
            after += 1;
        }
        for p in &stream[..cut] {
            client
                .apply(p)
                .unwrap_or_else(|e| panic!("the stream applies: {e}"));
            assert_eq!(&hashes(&client, &ids), at(client.version()));
        }
        client.apply_states(&states_of(&frame));
        assert_eq!(&hashes(&client, &ids), at(client.version().max(now)));
        for p in &stream[cut..] {
            client
                .apply(p)
                .unwrap_or_else(|e| panic!("the stream applies: {e}"));
            assert_eq!(&hashes(&client, &ids), at(client.version().max(now)));
        }
        assert_eq!(client.version(), server.replica.version());
    }
    assert!(
        before > 50 && after > 50,
        "both orders ran: {before} {after}"
    );
}
