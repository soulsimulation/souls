//! The incremental state hash (Engine v2 K20, #3395): `Tree::state_hashes` hashes again only the nodes a part changed
//! and their ancestors, and gives what hashing the whole tree gives (`Tree::state_hashes_whole`) and what K5's seal
//! gives, at every tick of a generated run.

use replica::apply::Replica;
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, FIXTURE_HEADER, Rest, fixture_bytes,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Id, Scope};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::world_model::{Audience, End};
use std::collections::BTreeMap;

/// splitmix64: the same run from the same seed on every machine.
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

/// Valid parts against its own world, one generic change or two each (as `tools/bench/replica-equal`'s generator,
/// with private nodes besides).
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
    /// Some fields large enough that their nodes' heads are kept.
    big: bool,
}

impl Gen {
    fn new(seed: u64) -> Gen {
        let replica = Replica::start(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap();
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
            big: false,
            replica,
        }
    }

    fn id(&mut self) -> Id {
        self.counter += 1;
        Id::new(self.scope, self.counter).unwrap()
    }

    fn soul(&mut self) -> Id {
        Id::new(Scope([0xdd; 16]), 100 + self.rng.below(5) as u64).unwrap()
    }

    fn value(&mut self) -> Value {
        // A large field now and then, when asked: its node's record up to its children is kept (`Tree::head`).
        if self.big && self.rng.below(8) == 0 {
            let n = 4_096 + self.rng.below(2_048);
            return Value::Bytes((0..n).map(|_| self.rng.next() as u8).collect());
        }
        match self.rng.below(3) {
            0 => Value::Uint(self.rng.next() >> 20),
            1 => Value::Text(Name::new(&format!("souls:v{}", self.rng.below(50))).unwrap()),
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
            position: Vec3::new(self.rng.int(5_000_000), 0, self.rng.int(5_000_000)),
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

    fn at(&self, id: Id) -> (Id, Option<u64>, u32) {
        let t = self.replica.tree();
        let n = t.node(t.handle(id).unwrap()).unwrap();
        (n.parent().unwrap(), n.slot(), n.depth())
    }

    fn entry(&mut self) -> (Id, Vec<Change>) {
        let n = self.nodes.len();
        let non_root = |g: &mut Gen| g.nodes[1 + g.rng.below(g.nodes.len() - 1)];
        // create, remove, reparent, set, link, unlink, motion
        let create = if n < 20 {
            1_000
        } else if n < 100 {
            30
        } else {
            4
        };
        let weights = [create, 4, 10, 20, 12, 6, 12];
        let mut op = self.rng.below(weights.iter().sum());
        let mut which = 0;
        while n > 1 && op >= weights[which] {
            op -= weights[which];
            which += 1;
        }
        match which {
            0 => {
                let parent = loop {
                    // With large fields, half the nodes go under the root, as Eden's things under its ground.
                    if self.big && self.rng.below(2) == 0 {
                        break self.nodes[0];
                    }
                    let p = self.rng.pick(&self.nodes);
                    if p == self.nodes[0] || self.at(p).2 < 20 {
                        break p;
                    }
                };
                let slot = self.slot();
                let fields = (0..self.rng.below(4))
                    .map(|_| (1 + self.rng.below(6) as u64, self.value()))
                    .collect::<BTreeMap<_, _>>();
                let node = self.id();
                let kind = self.kinds[self.rng.below(self.kinds.len())].clone();
                let pose = self.pose(parent, slot);
                // One node in eight is private: a top of its own audience, hashed apart (T3 rule 11).
                let audience = if self.rng.below(8) == 0 {
                    Audience::Of(self.soul())
                } else {
                    Audience::Everyone
                };
                self.nodes.push(node);
                let create = Change::Create {
                    node,
                    kind,
                    pose,
                    audience,
                    fields,
                };
                (parent, vec![create])
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
            4 if self.links.len() < 2 * n => {
                let owner = self.rng.pick(&self.nodes);
                let other = if self.rng.below(3) == 0 {
                    self.soul()
                } else {
                    self.rng.pick(&self.nodes)
                };
                let (ends, end) = if self.rng.below(2) == 0 {
                    ([owner, other], End::First)
                } else {
                    ([other, owner], End::Second)
                };
                let link = self.id();
                self.links.push(link);
                let ty = Name::new(["souls:near", "souls:owns"][self.rng.below(2)]).unwrap();
                let change = Change::Link {
                    link,
                    ty,
                    ends,
                    owner: end,
                    audience: self.audience_of(owner),
                };
                (owner, vec![change])
            }
            5 if !self.links.is_empty() => {
                let link = self.rng.pick(&self.links);
                let (_, ends, owner, _) = self.replica.tree().link(link).unwrap();
                (
                    ends[usize::from(owner == End::Second)],
                    vec![Change::Unlink { link }],
                )
            }
            6 => {
                let node = non_root(self);
                let (parent, slot, _) = self.at(node);
                if slot.is_some() {
                    return (node, vec![self.set(node)]);
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
            _ => {
                let node = self.rng.pick(&self.nodes);
                (node, vec![self.set(node)])
            }
        }
    }

    fn set(&mut self, node: Id) -> Change {
        let field = 1 + self.rng.below(8) as u64;
        let to = self.value();
        Change::Set {
            node,
            field,
            to,
            by: None,
        }
    }

    /// The audience a node here has.
    fn audience_of(&self, id: Id) -> Audience {
        let t = self.replica.tree();
        t.node(t.handle(id).unwrap()).unwrap().audience()
    }

    /// The audience of the entry that makes a change: that of the node or link it writes (T6).
    fn audience(&self, c: &Change) -> Audience {
        match c {
            Change::Create { audience, .. } | Change::Link { audience, .. } => *audience,
            Change::Remove { node } | Change::Reparent { node, .. } | Change::Set { node, .. } => {
                self.audience_of(*node)
            }
            Change::Motion(m) => self.audience_of(m.node),
            Change::Unlink { link } => self.replica.tree().link(*link).unwrap().3,
        }
    }

    /// The next part, applied to the generator's world.
    fn part(&mut self) {
        let (node, changes) = self.entry();
        let audience = self.audience(&changes[0]);
        let e = Effect {
            envelope: Envelope {
                sequence: self.seq,
                at: self.seq as i64 * 50_000,
                cause: Cause::World,
                actor: Actor::World,
                audience,
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
        self.replica
            .apply_bytes(&encode(&v).unwrap())
            .unwrap_or_else(|r| panic!("entry {}: {r}", self.seq));
        self.seq += 1;
        let t = self.replica.tree();
        self.nodes.retain(|id| t.handle(*id).is_some());
        self.links.retain(|id| t.link(*id).is_some());
    }
}

/// A1: over 10,000 ticks of one to three generated parts each, the state hash worked out from what changed equals the
/// whole tree's at every tick, and K5's seal's at every 100th (the seal and the state hash share the marks a change
/// clears). In all it hashes a small share of what hashing the whole tree each tick would.
#[test]
fn a1_the_state_hash_from_what_changed_equals_the_whole_trees_on_every_tick() {
    let mut g = Gen::new(3395);
    let (mut whole, mut parts, mut private) = (0u64, 0u64, 0usize);
    for tick in 0..10_000u64 {
        for _ in 0..1 + g.rng.below(3) {
            g.part();
            parts += 1;
        }
        let tree = g.replica.tree_for_seal();
        let got = tree.state_hashes().unwrap();
        assert_eq!(got, tree.state_hashes_whole().unwrap(), "tick {tick}");
        // A tree untouched since gives the same hashes, hashing nothing.
        let before = tree.rehashed();
        assert_eq!(tree.state_hashes().unwrap(), got, "tick {tick}, again");
        assert_eq!(
            tree.rehashed(),
            before,
            "tick {tick}: hashed again unchanged"
        );
        if tick % 100 == 99 {
            assert_eq!(
                tree.seal()
                    .unwrap()
                    .hashes()
                    .into_iter()
                    .collect::<Vec<_>>(),
                got,
                "tick {tick}, seal"
            );
        }
        whole += tree.counts().0 as u64;
        private = private.max(got.len() - 1);
    }
    let rehashed = g.replica.tree().rehashed();
    println!(
        "{parts} parts in 10,000 ticks: {rehashed} nodes hashed again, against {whole} for the whole tree each tick; \
         up to {private} private audiences"
    );
    assert!(private > 0, "the run held private nodes");
    assert!(rehashed * 5 < whole, "{rehashed} of {whole}");
}

/// A1: a change to one node hashes again that node and its ancestors, no other; nothing changed hashes nothing.
#[test]
fn a1_one_change_hashes_its_node_and_its_ancestors_only() {
    let mut g = Gen::new(7);
    while g.nodes.len() < 80 {
        g.part();
    }
    g.replica.tree_for_seal().state_hashes().unwrap();
    // The deepest node: a set on it marks it and every ancestor up to the root.
    let deep = *g.nodes.iter().max_by_key(|id| g.at_depth(**id)).unwrap();
    let depth = g.at_depth(deep);
    assert!(depth >= 3, "a deep enough tree: {depth}");
    let audience = {
        let t = g.replica.tree();
        t.node(t.handle(deep).unwrap()).unwrap().audience()
    };
    let before = g.replica.tree().rehashed();
    let set = g.set(deep);
    g.apply(deep, set);
    let tree = g.replica.tree_for_seal();
    assert_eq!(
        tree.state_hashes().unwrap(),
        tree.state_hashes_whole().unwrap()
    );
    // Its ancestors are hashed again each under its own audience; a node is hashed once.
    assert_eq!(
        tree.rehashed() - before,
        u64::from(depth) + 1,
        "a node at depth {depth} ({audience:?})"
    );
}

impl Gen {
    fn at_depth(&self, id: Id) -> u32 {
        let t = self.replica.tree();
        t.node(t.handle(id).unwrap()).unwrap().depth()
    }

    /// One change by `node`'s entry, applied.
    fn apply(&mut self, node: Id, change: Change) {
        let audience = self.audience(&change);
        let e = Effect {
            envelope: Envelope {
                sequence: self.seq,
                at: self.seq as i64 * 50_000,
                cause: Cause::World,
                actor: Actor::World,
                audience,
                node,
            },
            body: Body::Changes(vec![ChangeRec {
                change,
                rest: Rest::new(),
            }]),
            events: None,
            rest: Rest::new(),
        };
        let v = Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header_hash.clone())),
            (2, Value::Array(vec![e.to_value()])),
        ]));
        self.replica.apply_bytes(&encode(&v).unwrap()).unwrap();
        self.seq += 1;
    }

    /// A part that sets a large field on a node, then removes a node that is not there: refused whole, its set
    /// undone. Whether it was refused.
    fn refused_part(&mut self) -> bool {
        let node = self.nodes[1 + self.rng.below(self.nodes.len() - 1)];
        let mut set = self.set(node);
        while !matches!(&set, Change::Set { to: Value::Bytes(b), .. } if b.len() >= 4_096) {
            set = self.set(node);
        }
        let missing = Id::new(self.scope, 999_999_999).unwrap();
        let e = Effect {
            envelope: Envelope {
                sequence: self.seq,
                at: self.seq as i64 * 50_000,
                cause: Cause::World,
                actor: Actor::World,
                audience: self.audience_of(node),
                node,
            },
            body: Body::Changes(
                [set, Change::Remove { node: missing }]
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
        self.replica.apply_bytes(&encode(&v).unwrap()).is_err()
    }
}

/// #1960: with large fields, a node's record up to its children is kept between ticks (`Tree::head`) and only its
/// children's hashes are taken again while nodes below it change, from the mark before the first that changed (the
/// root, with a large field, has dozens of children). Over 3,000 ticks of generated parts, refused parts
/// that set and undo a large field among them, the state hash so worked out equals the whole tree's, hashed with no
/// mark and nothing kept, at every tick, and K5's seal's at every 100th.
#[test]
fn a_kept_head_gives_the_whole_trees_state_hash_on_every_tick() {
    let mut g = Gen::new(1960);
    g.big = true;
    // The root's own large field: its head is kept, and its many children are taken from their marks.
    let root = g.nodes[0];
    let mut set = g.set(root);
    while !matches!(&set, Change::Set { to: Value::Bytes(b), .. } if b.len() >= 4_096) {
        set = g.set(root);
    }
    g.apply(root, set);
    let (mut kept, mut refused, mut children) = (0usize, 0u64, 0usize);
    for tick in 0..3_000u64 {
        for _ in 0..1 + g.rng.below(3) {
            g.part();
        }
        if tick % 7 == 3 && g.nodes.len() > 1 && g.refused_part() {
            refused += 1;
        }
        let tree = g.replica.tree_for_seal();
        let got = tree.state_hashes().unwrap();
        assert_eq!(got, tree.state_hashes_whole().unwrap(), "tick {tick}");
        kept = kept.max(tree.heads_kept());
        children = children.max(tree.children(tree.root()).map_or(0, <[_]>::len));
        if tick % 100 == 99 {
            assert_eq!(
                tree.seal()
                    .unwrap()
                    .hashes()
                    .into_iter()
                    .collect::<Vec<_>>(),
                got,
                "tick {tick}, seal"
            );
        }
    }
    println!(
        "up to {kept} heads kept, the root's children up to {children}; {refused} refused parts"
    );
    assert!(kept >= 5, "heads kept: {kept}");
    assert!(children >= 48, "the root's children: {children}");
    assert!(refused > 300, "refused parts: {refused}");
}
