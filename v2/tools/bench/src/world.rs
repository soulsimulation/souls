//! The world the benches build (K2's `tree`, K5's `restart`): a place of rooms, each with bodies holding a cup and
//! linked to their Souls, and cups on its floor owned by those Souls. Built through `commit`, part by part.

// Each bench uses part of it.
#![allow(dead_code)]

use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, schema_hash,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, End, parse_kinds};
use std::collections::BTreeMap;

const KINDS: &str = r#"
{1: "souls:place", 2: "place", 11: ["souls:room"]}
{1: "souls:room", 2: "place", 11: ["body", "thing"]}
{1: "souls:body", 2: "family", 6: {1: ["thing"], 2: ["thing"]}}
{1: "souls:cup", 2: "thing"}
"#;

/// What a world hands each committed part's bytes to.
pub type Logger = Box<dyn FnMut(&[u8])>;

pub struct World {
    pub tree: Tree,
    pub header: Header,
    pub rules: Rules,
    pub kinds: BTreeMap<&'static str, Name>,
    pub mint: Minter,
    pub next: u64,
    pub rooms: Vec<Id>,
    pub bodies: Vec<Id>,
    pub souls: Vec<Id>,
    /// Called with each part's bytes as it commits (`restart` appends them to its log).
    pub log: Option<Logger>,
}

fn name(s: &str) -> Name {
    Name::new(s).expect("a name")
}

pub fn pose(frame: Id, slot: Option<u64>, x: i64) -> Pose {
    Pose {
        frame: Frame { node: frame, slot },
        position: Vec3::new(x, 0, 0),
        orientation: Quat::IDENTITY,
        support: match slot {
            Some(_) => Support::Slot,
            None => Support::Surface {
                surface: frame,
                height: 0,
            },
        },
    }
}

impl World {
    pub fn new() -> World {
        let rules = Rules {
            kinds: parse_kinds(KINDS).expect("kinds"),
            ..Rules::default()
        };
        let mut kinds = BTreeMap::new();
        for full in rules.kinds.keys() {
            let plain = ["souls:place", "souls:room", "souls:body", "souls:cup"]
                .into_iter()
                .find(|p| full.starts_with(&format!("{p}@")))
                .expect("a fixture kind");
            kinds.insert(plain, name(full));
        }
        let mut mint = Minter::new(Scope([0x2a; 16]));
        let root = mint.mint().expect("an id");
        let v = Value::Map(BTreeMap::from([
            (
                1,
                Value::Bytes(Hash::of(Purpose::Fixture, b"bench").to_bytes()),
            ),
            (2, Value::Bytes(schema_hash().to_bytes())),
            (3, Value::Bytes(root.scope().0.to_vec())),
            (4, root.to_value()),
            (5, Value::Uint(0)),
            (
                6,
                Value::Array(kinds.values().cloned().map(Value::Text).collect()),
            ),
            (7, Value::Array(Vec::new())),
        ]));
        let header = Header::read(&encode(&v).expect("bytes")).expect("a header");
        let tree = Tree::start(root, kinds["souls:place"].clone());
        World {
            tree,
            header,
            rules,
            kinds,
            mint,
            next: 0,
            rooms: Vec::new(),
            bodies: Vec::new(),
            souls: Vec::new(),
            log: None,
        }
    }

    pub fn id(&mut self) -> Id {
        self.mint.mint().expect("an id")
    }

    pub fn entry(&mut self, node: Id, changes: Vec<Change>) -> Effect {
        self.next += 1;
        Effect {
            envelope: Envelope {
                sequence: self.next - 1,
                at: 0,
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
        }
    }

    /// Commits one part and gives its bytes, as the log holds them (`restart` appends them).
    pub fn commit(&mut self, entries: Vec<Effect>) -> Vec<u8> {
        let v = Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (
                2,
                Value::Array(entries.iter().map(Effect::to_value).collect()),
            ),
        ]));
        let bytes = encode(&v).expect("bytes");
        let part = Part::read(&bytes).expect("a part");
        self.tree
            .commit(&self.header, &part, &self.rules)
            .expect("commits");
        if let Some(log) = &mut self.log {
            log(&bytes);
        }
        bytes
    }

    fn create(&self, node: Id, kind: &str, parent: Id, slot: Option<u64>, x: i64) -> Change {
        Change::Create {
            node,
            kind: self.kinds[kind].clone(),
            pose: pose(parent, slot, x),
            audience: Audience::Everyone,
            fields: BTreeMap::from([(1, Value::Uint(x as u64))]),
        }
    }

    fn link(&mut self, ty: &str, ends: [Id; 2], owner: End) -> Change {
        Change::Link {
            link: self.id(),
            ty: name(ty),
            ends,
            owner,
            audience: Audience::Everyone,
        }
    }

    /// A room under the root holding `bodies` bodies (each linked to its own Soul, a cup in its right hand and a
    /// motion sample) and `things` cups on its floor, each owned by a Soul. One part.
    pub fn room(&mut self, bodies: usize, things: usize) -> Id {
        let root = self.tree.node(self.tree.root()).expect("the root").id();
        let room = self.id();
        let mut entries = vec![];
        let c = self.create(room, "souls:room", root, None, 0);
        entries.push(self.entry(root, vec![c]));
        let mut inside = Vec::new();
        let mut bodies_here = Vec::new();
        for i in 0..bodies {
            let b = self.id();
            inside.push(self.create(b, "souls:body", room, None, i as i64 * 1000));
            bodies_here.push(b);
        }
        let mut cups = Vec::new();
        for i in 0..things {
            let t = self.id();
            inside.push(self.create(t, "souls:cup", room, None, i as i64 * 1000));
            cups.push(t);
        }
        entries.push(self.entry(room, inside));
        for b in bodies_here {
            let soul = Id::new(Scope([0x50; 16]), self.souls.len() as u64).expect("a Soul");
            self.rules.souls.insert(soul);
            self.souls.push(soul);
            let cup = self.id();
            let held = self.create(cup, "souls:cup", b, Some(2), 0);
            let body_of = self.link("souls:body-of", [b, soul], End::First);
            let sample = Change::Motion(HandOff {
                node: b,
                at: 0,
                from: Owner::Mover,
                to: Owner::Mover,
                pose: pose(room, None, 5),
                linear: Vec3::new(1_000_000, 0, 0),
                angular: Vec3::ZERO,
            });
            let e = self.entry(b, vec![held, body_of, sample]);
            entries.push(e);
            self.bodies.push(b);
        }
        // Each cup is owned by the Soul of a body in its room, in turn: every Soul has one body and nine cups.
        let owners = self.souls.len() - bodies.min(self.souls.len());
        for (i, t) in cups.into_iter().enumerate() {
            let soul = match bodies {
                0 => self.souls[i % self.souls.len()],
                n => self.souls[owners + i % n],
            };
            let owns = self.link("souls:owns", [soul, t], End::Second);
            let e = self.entry(t, vec![owns]);
            entries.push(e);
        }
        self.commit(entries);
        self.rooms.push(room);
        room
    }
}

/// A world of `scale` × (1,000 bodies, 9,000 cups on floors and 1,000 in hands) in 100 × `scale` rooms.
pub fn build(scale: usize) -> World {
    let mut w = World::new();
    for _ in 0..100 * scale {
        w.room(10, 90);
    }
    w
}
