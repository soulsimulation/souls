//! The `replica-equal` bench (Engine v2 R1, #2684), native half. It writes what `node.mjs` beside it needs to run the
//! WASM build of `replica` on the same input, and what the native build gave, into `<out dir>`:
//!
//! - `fixtures.json`: T6's golden fixtures (A1) as batches, and for each fixture the answers (`replica::apply`, with
//!   their chains) to the base's batch and then the fixture's, and the state hash after it.
//! - `stream.bin`: a stream of generated effects (A2), one entry a part, in batches of `BATCH` parts, made here from
//!   a seed each run and never committed; `native.json`: each batch's answer, whose chain covers every step's hash and
//!   then the state hash after the batch, the final state hash, and the native rate (A4).
//!
//! Run from `v2/`: `cargo run -p bench --release --bin replica-equal -- <out dir> [seed] [effects]`, then
//! `node tools/bench/replica-equal/node.mjs <wasm pkg dir> <out dir>`. v2/tools/ci.sh runs both.
// A bench times a run by the wall clock (the wall-clock rule, K7, is the engine's: v2/clippy.toml).
#![allow(clippy::disallowed_methods)]

use replica::apply::Replica;
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, FIXTURE_HEADER, FIXTURES, Rest,
    fixture_bytes,
};
use replica::encode::{Name, Value, encode, to_hex};
use replica::hash::state_hash;
use replica::ids::{Id, Scope};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::world_model::{Audience, End};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::time::Instant;

/// Parts a batch: what JavaScript passes in one call.
const BATCH: usize = 1_000;

/// splitmix64: the same numbers from the same seed on every machine.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    fn int(&mut self, span: i64) -> i64 {
        (self.next() % (2 * span as u64 + 1)) as i64 - span
    }

    fn pick<T: Copy>(&mut self, list: &[T]) -> T {
        list[self.below(list.len())]
    }
}

fn frame(e: &mut Vec<u8>, part: &[u8]) {
    e.extend_from_slice(
        &u32::try_from(part.len())
            .expect("a part fits")
            .to_le_bytes(),
    );
    e.extend_from_slice(part);
}

/// Makes valid entries against its own copy of the world, one generic change or two in each, from a seed.
struct Gen {
    rng: Rng,
    replica: Replica,
    header_hash: Vec<u8>,
    kinds: Vec<Name>,
    scope: Scope,
    counter: u64,
    seq: u64,
    nodes: Vec<Id>,
    links: Vec<Id>,
    changes: u64,
}

impl Gen {
    fn new(header: &[u8], seed: u64) -> Gen {
        let replica = Replica::start(header).expect("a header");
        let h = replica.header();
        let root = h.zone;
        Gen {
            rng: Rng(seed),
            header_hash: h.hash().to_bytes(),
            kinds: h.kinds.clone(),
            scope: root.scope(),
            counter: 1_000,
            seq: 0,
            nodes: vec![root],
            links: Vec::new(),
            changes: 0,
            replica,
        }
    }

    fn id(&mut self) -> Id {
        self.counter += 1;
        Id::new(self.scope, self.counter).expect("an id")
    }

    fn soul(&mut self) -> Id {
        Id::new(Scope([0xdd; 16]), 100 + self.rng.below(5) as u64).expect("an id")
    }

    fn value(&mut self) -> Value {
        match self.rng.below(4) {
            0 => Value::Uint(self.rng.next() >> 20),
            1 => Value::Nint(self.rng.next() >> 20),
            2 => Value::Text(Name::new(&format!("souls:v{}", self.rng.below(50))).expect("a name")),
            _ => Value::Bytes(
                (0..self.rng.below(8))
                    .map(|_| self.rng.next() as u8)
                    .collect(),
            ),
        }
    }

    fn pose(&mut self, parent: Id, slot: Option<u64>) -> Pose {
        Pose {
            frame: Frame { node: parent, slot },
            position: Vec3::new(
                self.rng.int(5_000_000),
                self.rng.int(5_000_000),
                self.rng.int(5_000_000),
            ),
            orientation: Quat::IDENTITY,
            support: match slot {
                Some(_) => Support::Slot,
                None => Support::Surface {
                    surface: parent,
                    height: self.rng.below(1_000) as i64,
                },
            },
        }
    }

    fn slot(&mut self) -> Option<u64> {
        (self.rng.below(10) < 3).then(|| self.rng.below(4) as u64)
    }

    /// The parent and slot of a node here.
    fn at(&self, id: Id) -> (Id, Option<u64>, u32) {
        let t = self.replica.tree();
        let n = t.node(t.handle(id).expect("here")).expect("here");
        (n.parent().expect("not the root"), n.slot(), n.depth())
    }

    fn create(&mut self, parent: Id) -> Change {
        let slot = self.slot();
        let fields = (0..self.rng.below(4))
            .map(|_| (1 + self.rng.below(6) as u64, self.value()))
            .collect::<BTreeMap<_, _>>();
        let node = self.id();
        let kind = self.kinds[self.rng.below(self.kinds.len())].clone();
        let pose = self.pose(parent, slot);
        self.nodes.push(node);
        Change::Create {
            node,
            kind,
            pose,
            audience: Audience::Everyone,
            fields,
        }
    }

    /// One entry: its writing node and its changes.
    fn entry(&mut self) -> (Id, Vec<Change>) {
        let n = self.nodes.len();
        let non_root = |g: &mut Gen| g.nodes[1 + g.rng.below(g.nodes.len() - 1)];
        // Weights: create, remove, reparent, set, link, unlink, motion. The world grows to a few hundred nodes and
        // stays there, since a remove takes a whole subtree.
        let create = if n < 20 {
            1_000
        } else if n < 400 {
            30
        } else {
            4
        };
        let weights = [create, 4, 10, 20, 12, 6, 12];
        let mut op = self.rng.below(weights.iter().sum());
        let mut which = 0;
        while op >= weights[which] {
            op -= weights[which];
            which += 1;
        }
        match which {
            0 => {
                let parent = loop {
                    let p = self.rng.pick(&self.nodes);
                    let deep = p != self.nodes[0] && self.at(p).2 >= 30;
                    if !deep {
                        break p;
                    }
                };
                let c = self.create(parent);
                let mut changes = vec![c];
                if self.rng.below(5) == 0 {
                    let Change::Create { node, .. } = changes[0] else {
                        unreachable!()
                    };
                    let to = self.value();
                    changes.push(Change::Set {
                        node,
                        field: 7,
                        to,
                        by: None,
                    });
                }
                (parent, changes)
            }
            1 => {
                let node = non_root(self);
                (node, vec![Change::Remove { node }])
            }
            2 => {
                let node = non_root(self);
                let (parent, slot, _) = self.at(node);
                let to = self.slot();
                let pose = self.pose(parent, to);
                let from = Frame { node: parent, slot };
                (node, vec![Change::Reparent { node, from, pose }])
            }
            3 => {
                let node = self.rng.pick(&self.nodes);
                let field = 1 + self.rng.below(8) as u64;
                let to = self.value();
                (
                    node,
                    vec![Change::Set {
                        node,
                        field,
                        to,
                        by: None,
                    }],
                )
            }
            4 if self.links.len() < 2 * n => {
                let owner = self.rng.pick(&self.nodes);
                let other = if self.rng.below(3) == 0 {
                    self.soul()
                } else {
                    self.rng.pick(&self.nodes)
                };
                let first = self.rng.below(2) == 0;
                let (ends, end) = if first {
                    ([owner, other], End::First)
                } else {
                    ([other, owner], End::Second)
                };
                let link = self.id();
                self.links.push(link);
                let ty = Name::new(["souls:near", "souls:owns", "souls:holds"][self.rng.below(3)])
                    .expect("a name");
                (
                    owner,
                    vec![Change::Link {
                        link,
                        ty,
                        ends,
                        owner: end,
                        audience: Audience::Everyone,
                    }],
                )
            }
            5 if !self.links.is_empty() => {
                let link = self.rng.pick(&self.links);
                let (_, ends, owner, _) = self.replica.tree().link(link).expect("here");
                let node = ends[usize::from(owner == End::Second)];
                (node, vec![Change::Unlink { link }])
            }
            _ => {
                let node = non_root(self);
                let (parent, slot, _) = self.at(node);
                if slot.is_some() {
                    let field = 1 + self.rng.below(8) as u64;
                    let to = self.value();
                    return (
                        node,
                        vec![Change::Set {
                            node,
                            field,
                            to,
                            by: None,
                        }],
                    );
                }
                let at = self.seq as i64 * 50_000;
                let pose = self.pose(parent, None);
                let linear = Vec3::new(self.rng.int(2_000_000), 0, self.rng.int(2_000_000));
                let m = HandOff {
                    node,
                    at,
                    from: Owner::Mover,
                    to: Owner::Mover,
                    pose,
                    linear,
                    angular: Vec3::ZERO,
                };
                (node, vec![Change::Motion(m)])
            }
        }
    }

    /// The next part's bytes, applied to the generator's own copy.
    fn part(&mut self) -> Vec<u8> {
        let (node, changes) = self.entry();
        self.changes += changes.len() as u64;
        let removes = changes.iter().any(|c| matches!(c, Change::Remove { .. }));
        let unlinks = changes.iter().any(|c| matches!(c, Change::Unlink { .. }));
        let e = Effect {
            envelope: Envelope {
                sequence: self.seq,
                at: self.seq as i64 * 50_000,
                cause: Cause::World,
                actor: Actor::World,
                audience: Audience::Everyone,
                node,
            },
            body: Body::Changes(
                changes
                    .into_iter()
                    .map(|change| ChangeRec {
                        change,
                        rest: Rest::new(),
                    })
                    .collect(),
            ),
            events: None,
            rest: Rest::new(),
        };
        let v = Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header_hash.clone())),
            (2, Value::Array(vec![e.to_value()])),
        ]));
        let bytes = encode(&v).expect("bytes");
        self.replica
            .apply_bytes(&bytes)
            .unwrap_or_else(|r| panic!("entry {}: {r}", self.seq));
        self.seq += 1;
        let t = self.replica.tree();
        if removes {
            self.nodes.retain(|id| t.handle(*id).is_some());
        }
        if removes || unlinks {
            self.links.retain(|id| t.link(*id).is_some());
        }
        bytes
    }
}

fn hex(b: &[u8]) -> String {
    to_hex(b)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out = std::path::PathBuf::from(
        args.get(1)
            .expect("usage: replica-equal <out dir> [seed] [effects]"),
    );
    let seed: u64 = args.get(2).map_or(2684, |s| s.parse().expect("a seed"));
    let count: usize = args.get(3).map_or(100_000, |s| s.parse().expect("a count"));
    std::fs::create_dir_all(&out).expect("the out dir");
    let header = fixture_bytes(FIXTURE_HEADER).expect("the header");
    std::fs::write(out.join("header.bin"), &header).expect("written");

    // A1: the base as one batch, then each golden fixture as another, each call's chain ending in the state hash.
    let mut base = Vec::new();
    frame(&mut base, &fixture_bytes(FIXTURES[0].1).expect("the base"));
    let mut fx = format!("{{\n  \"0-base\": {{\"batch\": \"{}\"}}", hex(&base));
    for (name, text) in FIXTURES.iter().skip(1) {
        let mut b = Vec::new();
        frame(&mut b, &fixture_bytes(text).expect("a fixture"));
        let mut r = Replica::start(&header).expect("a header");
        let a0 = r.apply_batch(&base, true).expect("a batch");
        let a1 = r.apply_batch(&b, true).expect("a batch");
        assert_eq!(
            (a0.parts, a0.refused, a1.parts, a1.refused),
            (1, None, 1, None),
            "{name}"
        );
        let answers = [a0, a1].map(|a| format!("\"{}\"", hex(&a.to_bytes())));
        let state = state_hash(r.tree()).expect("a hash");
        write!(
            fx,
            ",\n  \"{name}\": {{\"batch\": \"{}\", \"answers\": [{}], \"state\": \"{state}\"}}",
            hex(&b),
            answers.join(", ")
        )
        .unwrap();
    }
    fx.push_str("\n}\n");
    std::fs::write(out.join("fixtures.json"), fx).expect("written");

    // A2: the generated stream, made from the seed now.
    let t = Instant::now();
    let mut g = Gen::new(&header, seed);
    let parts: Vec<Vec<u8>> = (0..count).map(|_| g.part()).collect();
    let made = t.elapsed();
    let mut batches = Vec::new();
    for chunk in parts.chunks(BATCH) {
        let mut b = Vec::new();
        for p in chunk {
            frame(&mut b, p);
        }
        batches.push(b);
    }
    let mut stream = Vec::new();
    for b in &batches {
        stream.extend_from_slice(&u32::try_from(b.len()).expect("fits").to_le_bytes());
        stream.extend_from_slice(b);
    }
    std::fs::write(out.join("stream.bin"), &stream).expect("written");

    // A hash at every step and the state hash after every batch, chained per batch.
    let mut r = Replica::start(&header).expect("a header");
    let t = Instant::now();
    let answers: Vec<String> = batches
        .iter()
        .map(|b| {
            let a = r.apply_batch(b, true).expect("a batch");
            assert_eq!(a.refused, None);
            hex(&a.to_bytes())
        })
        .collect();
    let hashed = t.elapsed();
    let state = state_hash(r.tree()).expect("a hash");
    let (nodes, links) = r.tree().counts();

    // A4: the rate, applying without hashing: the best of three runs.
    let mut best = f64::MAX;
    for _ in 0..3 {
        let mut r = Replica::start(&header).expect("a header");
        let t = Instant::now();
        for b in &batches {
            r.apply_batch(b, false).expect("a batch");
        }
        best = best.min(t.elapsed().as_secs_f64());
    }
    let rate = count as f64 / best;
    let json = format!(
        "{{\n  \"seed\": {seed},\n  \"effects\": {count},\n  \"changes\": {},\n  \"batch\": {BATCH},\n  \"version\": {},\n  \"nodes\": {nodes},\n  \"links\": {links},\n  \"state\": \"{state}\",\n  \"rate\": {rate:.0},\n  \"answers\": [{}]\n}}\n",
        g.changes,
        r.version(),
        answers
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(", ")
    );
    std::fs::write(out.join("native.json"), json).expect("written");
    println!(
        "native: {count} effects ({} changes) from seed {seed} made in {:.2} s; hashed at every step in {:.2} s; \
         ends with {nodes} nodes and {links} links, state {state}",
        g.changes,
        made.as_secs_f64(),
        hashed.as_secs_f64()
    );
    println!(
        "native: {rate:.0} effects applied a second (best of 3, no hashing, batches of {BATCH})"
    );
}
