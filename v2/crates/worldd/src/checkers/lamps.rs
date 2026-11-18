//! A world of rooms, each with bodies, a lamp beside each body (R2's `r2:lamp`, `replica/cases/kinds/lamp.json`)
//! and cups, held in a replica: for the checkers' tests and the `commit-cost` bench (I3, #2686).

use super::{Act, Candidate, Rules};
use replica::apply::Replica;
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, schema_hash,
};
use replica::encode::{Name, Value as Cbor, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::rules::json::{Value, parse};
use replica::world_model::{Audience, parse_kinds};
use std::collections::BTreeMap;

const KINDS: &str = r#"
{1: "souls:place", 2: "place", 11: ["souls:room"]}
{1: "souls:room", 2: "place", 11: ["body", "thing"]}
{1: "souls:body", 2: "family", 6: {1: ["thing"], 2: ["thing"]}}
{1: "souls:cup", 2: "thing"}
{1: "r2:lamp", 2: "thing"}
"#;

/// Bodies stand 200 mm apart, in micrometres.
const SPACING: i64 = 200_000;

const LAMP: &str = include_str!("../../../replica/cases/kinds/lamp.json");

/// The world, its header and each body with its lamp.
pub struct World {
    pub replica: Replica,
    header: Header,
    kinds: BTreeMap<&'static str, Name>,
    mint: Minter,
    /// Each body and the lamp beside it.
    pub pairs: Vec<(Id, Id)>,
}

/// The rules for the world's lamps: the lamp's entry and a press that reaches 400 mm, so a body reaches its own
/// lamp's switch (300 mm up) and the next one's (200 mm along), and no further.
pub fn rules() -> Rules {
    let lamp = parse(LAMP).unwrap_or_else(|e| panic!("lamp.json: {e}"));
    Rules {
        kinds: Value::Obj(vec![("r2:lamp".into(), lamp)]),
        moves: parse(r#"{"press": {"reach_mm": 400}}"#).unwrap_or_else(|e| panic!("moves: {e}")),
    }
}

/// The act of switching a lamp, either way: its candidates are switch_on, then switch_off (one of them holds).
pub fn toggle(id: u64, body: Id, lamp: Id) -> Act {
    Act {
        id,
        cause: Cause::World,
        actor: Actor::World,
        body,
        candidates: ["switch_on", "switch_off"]
            .map(|form| Candidate {
                this: lamp,
                form: form.into(),
            })
            .to_vec(),
        recheck: None,
    }
}

fn name(s: &str) -> Name {
    Name::new(s).unwrap_or_else(|| panic!("a name: {s}"))
}

fn pose(frame: Id, x: i64) -> Pose {
    Pose {
        frame: Frame {
            node: frame,
            slot: None,
        },
        position: Vec3::new(x, 0, 0),
        orientation: Quat::IDENTITY,
        support: Support::Surface {
            surface: frame,
            height: 0,
        },
    }
}

impl World {
    /// `rooms` rooms, each with `bodies` bodies, a lamp at each body's place and `cups` cups.
    pub fn build(rooms: usize, bodies: usize, cups: usize) -> World {
        let parsed = parse_kinds(KINDS).unwrap_or_else(|e| panic!("kinds: {e}"));
        let mut kinds = BTreeMap::new();
        for full in parsed.keys() {
            let plain = [
                "souls:place",
                "souls:room",
                "souls:body",
                "souls:cup",
                "r2:lamp",
            ]
            .into_iter()
            .find(|p| full.starts_with(&format!("{p}@")))
            .unwrap_or_else(|| panic!("a fixture kind: {full}"));
            kinds.insert(plain, name(full));
        }
        let mut mint = Minter::new(Scope([0x2b; 16]));
        let root = mint.mint().unwrap_or_else(|e| panic!("an id: {e:?}"));
        let v = Cbor::Map(BTreeMap::from([
            (1, Cbor::Bytes(Hash::of(Purpose::Fixture, b"i3").to_bytes())),
            (2, Cbor::Bytes(schema_hash().to_bytes())),
            (3, Cbor::Bytes(root.scope().0.to_vec())),
            (4, root.to_value()),
            (5, Cbor::Uint(0)),
            (
                6,
                Cbor::Array(kinds.values().cloned().map(Cbor::Text).collect()),
            ),
            (7, Cbor::Array(Vec::new())),
        ]));
        let bytes = encode(&v).unwrap_or_else(|e| panic!("a header: {e}"));
        let mut w = World {
            replica: Replica::start(&bytes).unwrap_or_else(|e| panic!("a replica: {e}")),
            header: Header::read(&bytes).unwrap_or_else(|e| panic!("a header: {e}")),
            kinds,
            mint,
            pairs: Vec::new(),
        };
        for _ in 0..rooms {
            w.room(root, bodies, cups);
        }
        w
    }

    fn id(&mut self) -> Id {
        self.mint.mint().unwrap_or_else(|e| panic!("an id: {e:?}"))
    }

    fn create(&self, node: Id, kind: &str, parent: Id, x: i64, fields: &[(u64, u64)]) -> Change {
        Change::Create {
            node,
            kind: self.kinds[kind].clone(),
            pose: pose(parent, x),
            audience: Audience::Everyone,
            fields: fields.iter().map(|(k, v)| (*k, Cbor::Uint(*v))).collect(),
        }
    }

    /// One part of world effects with these changes, each its own effect, at the live version.
    pub fn part(&self, changes: Vec<(Id, Change)>) -> Part {
        self.part_of(Audience::Everyone, changes)
    }

    /// [`World::part`], its effects of `audience`.
    pub fn part_of(&self, audience: Audience, changes: Vec<(Id, Change)>) -> Part {
        let start = self.replica.version();
        let effects: Vec<Cbor> = changes
            .into_iter()
            .zip(start..)
            .map(|((node, change), sequence)| {
                Effect {
                    envelope: Envelope {
                        sequence,
                        at: 0,
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
                }
                .to_value()
            })
            .collect();
        let v = Cbor::Map(BTreeMap::from([
            (1, Cbor::Bytes(self.header.hash().to_bytes())),
            (2, Cbor::Array(effects)),
        ]));
        Part::read(&encode(&v).unwrap_or_else(|e| panic!("a part: {e}")))
            .unwrap_or_else(|e| panic!("a part: {e}"))
    }

    fn room(&mut self, root: Id, bodies: usize, cups: usize) {
        let room = self.id();
        let mut changes = vec![(root, self.create(room, "souls:room", root, 0, &[]))];
        for i in 0..bodies as i64 {
            let (b, l) = (self.id(), self.id());
            changes.push((room, self.create(b, "souls:body", room, i * SPACING, &[])));
            // A lamp: unlit, wired, dimmed to 0 (lamp.json's fields 1, 2 and 3), where its body stands.
            let lamp = self.create(l, "r2:lamp", room, i * SPACING, &[(1, 0), (2, 1), (3, 0)]);
            changes.push((room, lamp));
            self.pairs.push((b, l));
        }
        for i in 0..cups as i64 {
            let c = self.id();
            changes.push((room, self.create(c, "souls:cup", room, i * 1_000_000, &[])));
        }
        let part = self.part(changes);
        self.replica
            .apply(&part)
            .unwrap_or_else(|e| panic!("a room applies: {e}"));
    }

    /// A change to a lamp's level, as another act would make it: the lamp's stamp moves on.
    pub fn dim(&mut self, lamp: Id, level: u64) -> Part {
        self.set(lamp, 3, level, Audience::Everyone)
    }

    /// A field set on a node of `audience`, by an entry of that audience.
    pub fn set(&mut self, node: Id, field: u64, to: u64, audience: Audience) -> Part {
        let part = self.part_of(
            audience,
            vec![(
                node,
                Change::Set {
                    node,
                    field,
                    to: Cbor::Uint(to),
                    by: None,
                },
            )],
        );
        self.replica
            .apply(&part)
            .unwrap_or_else(|e| panic!("a set applies: {e}"));
        part
    }

    /// An unlit lamp of `audience` under `parent`, created by an entry of that audience (I6's audience test).
    pub fn lamp_of(&mut self, parent: Id, audience: Audience) -> Id {
        let id = self.id();
        let Change::Create {
            node,
            kind,
            pose,
            fields,
            ..
        } = self.create(id, "r2:lamp", parent, 0, &[(1, 0), (2, 1), (3, 0)])
        else {
            unreachable!("create makes a create")
        };
        let create = Change::Create {
            node,
            kind,
            pose,
            audience,
            fields,
        };
        let part = self.part_of(audience, vec![(parent, create)]);
        self.replica
            .apply(&part)
            .unwrap_or_else(|e| panic!("a lamp of an audience applies: {e}"));
        id
    }
}
