//! The replica library (Engine v2 R1, #2684), native build. Each `aN_` test is one acceptance box; the WASM build runs
//! the same fixtures and the same query cases (`queries.txt`) in Node through `v2/tools/bench/replica-equal/node.mjs`,
//! and A2's generated stream and A4's numbers are that bench's.

use replica::apply::Replica;
use replica::effects::{FIXTURE_HEADER, FIXTURES, fixture_bytes};
use replica::encode::{decode, encode_diagnostic};
use replica::hash::{Chain, state_hash, step_hash};
use replica::ids::{Id, Scope};

fn header() -> Vec<u8> {
    fixture_bytes(FIXTURE_HEADER).unwrap()
}

fn part(name: &str) -> Vec<u8> {
    let text = FIXTURES.iter().find(|(n, _)| *n == name).unwrap().1;
    fixture_bytes(text).unwrap()
}

/// A batch: each part's length as four little-endian bytes, then the part.
fn batch(parts: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    for p in parts {
        out.extend_from_slice(&u32::try_from(p.len()).unwrap().to_le_bytes());
        out.extend_from_slice(p);
    }
    out
}

/// `<name> state <hash>` from T6's goldens.
fn golden_state(name: &str) -> String {
    let goldens = include_str!("../fixtures/effects/goldens.txt");
    let prefix = format!("{name} state ");
    let line = goldens.lines().find(|l| l.starts_with(&prefix)).unwrap();
    line[prefix.len()..].split(' ').next().unwrap().to_owned()
}

#[test]
fn a1_golden_fixtures_give_t6s_state_hash_at_every_step() {
    for (name, _) in FIXTURES.iter().skip(1) {
        let mut r = Replica::start(&header()).unwrap();
        r.apply_bytes(&part("0-base")).unwrap();
        assert_eq!(
            state_hash(r.tree()).unwrap().to_string(),
            golden_state("0-base")
        );
        r.apply_bytes(&part(name))
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let got = state_hash(r.tree()).unwrap().to_string();
        assert_eq!(got, golden_state(name), "{name}");
        println!("a1 {name}: base then fixture, state {got} as goldens.txt");
    }
}

fn ee(n: u64) -> Id {
    Id::new(Scope([0xee; 16]), n).unwrap()
}

#[test]
fn a1_a_batch_chains_each_steps_changed_nodes_and_then_the_state() {
    // By hand: the base changes the root, room, body, cup, key and crate, and Soul 100's links; 4-set the crate and
    // the cup. The chain is each step's hash and then the state hash after the batch.
    let soul = Id::new(Scope([0xdd; 16]), 100).unwrap();
    let mut r = Replica::start(&header()).unwrap();
    let mut chain = Chain::new();
    r.apply_bytes(&part("0-base")).unwrap();
    let base = [soul, ee(0), ee(1), ee(2), ee(4), ee(6), ee(7)];
    chain.push(&step_hash(r.tree(), 2, &base));
    r.apply_bytes(&part("4-set")).unwrap();
    chain.push(&step_hash(r.tree(), 4, &[ee(4), ee(7)]));
    chain.push(&state_hash(r.tree()).unwrap().to_bytes());

    let mut all = Replica::start(&header()).unwrap();
    let a = all
        .apply_batch(&batch(&[part("0-base"), part("4-set")]), true)
        .unwrap();
    assert_eq!(
        (a.parts, a.version, a.chain, a.refused),
        (2, 4, Some(chain.digest()), None)
    );
    // A refused part stops the batch; the parts before it stay applied.
    let mut r = Replica::start(&header()).unwrap();
    let a = r
        .apply_batch(&batch(&[part("0-base"), part("0-base")]), false)
        .unwrap();
    assert_eq!(
        (a.parts, a.version, a.refused),
        (1, 2, Some("sequence-gap"))
    );
    println!("a1 batch: chained as by hand; a refused second part leaves the first applied");
}

/// One case of `queries.txt`: `<name>: <query> => <answer>`, both in diagnostic notation, or `=> refused <name>`.
pub struct Case<'a> {
    pub name: &'a str,
    pub query: &'a str,
    pub answer: &'a str,
}

fn cases() -> Vec<Case<'static>> {
    include_str!("queries.txt")
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .map(|l| {
            let (name, rest) = l.split_once(": ").unwrap();
            let (query, answer) = rest.split_once(" => ").unwrap();
            Case {
                name,
                query: query.trim(),
                answer: answer.trim(),
            }
        })
        .collect()
}

#[test]
fn a3_each_query_answers_as_queries_txt_says() {
    let mut r = Replica::start(&header()).unwrap();
    r.apply_bytes(&part("0-base")).unwrap();
    r.apply_bytes(&part("5-link")).unwrap();
    let mut which = std::collections::BTreeSet::new();
    for c in cases() {
        let q = encode_diagnostic(c.query).unwrap();
        let got = match r.query(&q) {
            Ok(bytes) => {
                decode(&bytes).unwrap();
                Ok(bytes)
            }
            Err(e) => Err(e.name),
        };
        let want = match c.answer.strip_prefix("refused ") {
            Some(name) => Err(name),
            None => Ok(encode_diagnostic(c.answer).unwrap()),
        };
        assert_eq!(got, want, "{}", c.name);
        which.insert(c.name.split(' ').next().unwrap().to_owned());
        println!("a3 {}: as written", c.name);
    }
    let all = ["node", "children", "links", "path", "changed", "hash"];
    assert!(
        all.iter().all(|w| which.contains(*w)),
        "a case for each query: {which:?}"
    );
}
