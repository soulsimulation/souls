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

/// The world's kinds; the toggle's is the one its entry names.
fn kinds_text(toggle: &str) -> String {
    format!(
        r#"
{{1: "souls:place", 2: "place", 11: ["souls:room"]}}
{{1: "souls:room", 2: "place", 11: ["body", "thing"]}}
{{1: "souls:body", 2: "family", 6: {{1: ["thing"], 2: ["thing"]}}}}
{{1: "souls:item", 2: "thing"}}
{{1: "{toggle}", 2: "thing"}}
"#
    )
}

/// Bodies stand 200 mm apart, in micrometres.
const SPACING: i64 = 200_000;

const ENTRY: &str = include_str!("../../../replica/cases/kinds/lamp.json");

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
    let entry = entry();
    Rules {
        kinds: Value::Obj(vec![(toggle_kind(&entry), entry)]),
        moves: parse(r#"{"press": {"reach_mm": 400}}"#).unwrap_or_else(|e| panic!("moves: {e}")),
    }
}

/// The toggle's entry (R2's fixture), parsed.
fn entry() -> Value {
    parse(ENTRY).unwrap_or_else(|e| panic!("the toggle's entry: {e}"))
}

/// The toggle's kind, as its entry names it.
fn toggle_kind(entry: &Value) -> String {
    match entry.get("kind") {
        Some(Value::Str(kind)) => kind.clone(),
        other => panic!("the entry's kind is {other:?}"),
    }
}

/// The act of switching a toggle, either way: its candidates are switch_on, then switch_off (one of them holds).
pub fn toggle(id: u64, body: Id, thing: Id) -> Act {
    Act {
        id,
        cause: Cause::World,
        actor: Actor::World,
        body,
        candidates: ["switch_on", "switch_off"]
            .map(|form| Candidate {
                this: thing,
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
    pub fn build(rooms: usize, bodies: usize, items: usize) -> World {
        let toggle = toggle_kind(&entry());
        let parsed = parse_kinds(&kinds_text(&toggle)).unwrap_or_else(|e| panic!("kinds: {e}"));
        let mut kinds = BTreeMap::new();
        for full in parsed.keys() {
            // Each kind by its plain name, the toggle's as `toggle`.
            let plain = [
                ("souls:place", "souls:place"),
                ("souls:room", "souls:room"),
                ("souls:body", "souls:body"),
                ("souls:item", "souls:item"),
                (toggle.as_str(), "toggle"),
            ]
            .into_iter()
            .find(|(p, _)| full.starts_with(&format!("{p}@")))
            .map(|(_, plain)| plain)
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
            w.room(root, bodies, items);
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
                        audience: Audience::Everyone,
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

    fn room(&mut self, root: Id, bodies: usize, items: usize) {
        let room = self.id();
        let mut changes = vec![(root, self.create(room, "souls:room", root, 0, &[]))];
        for i in 0..bodies as i64 {
            let (b, l) = (self.id(), self.id());
            changes.push((room, self.create(b, "souls:body", room, i * SPACING, &[])));
            // A lamp: unlit, wired, dimmed to 0 (lamp.json's fields 1, 2 and 3), where its body stands.
            let toggle = self.create(l, "toggle", room, i * SPACING, &[(1, 0), (2, 1), (3, 0)]);
            changes.push((room, toggle));
            self.pairs.push((b, l));
        }
        for i in 0..items as i64 {
            let c = self.id();
            changes.push((room, self.create(c, "souls:item", room, i * 1_000_000, &[])));
        }
        let part = self.part(changes);
        self.replica
            .apply(&part)
            .unwrap_or_else(|e| panic!("a room applies: {e}"));
    }

    /// A change to a lamp's level, as another act would make it: the lamp's stamp moves on.
    pub fn dim(&mut self, toggle: Id, level: u64) -> Part {
        let part = self.part(vec![(
            toggle,
            Change::Set {
                node: toggle,
                field: 3,
                to: Cbor::Uint(level),
                by: None,
            },
        )]);
        self.replica
            .apply(&part)
            .unwrap_or_else(|e| panic!("a dim applies: {e}"));
        part
    }
}
