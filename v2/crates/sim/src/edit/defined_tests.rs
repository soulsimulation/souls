//! A creator's own kinds (#3697): a definition is a `souls:kind` node at the root holding its canonical record; a thing
//! of the kind is placed by its full name; a replica replaying the log learns the kind from it; and each check at
//! commit refuses by name (`kind.invalid`, `kind.too-large`, `kind.collision`, `kind.namespace`, `kind.in-use`).

use super::*;
use replica::edit::{Edit, Op, Ref, Spot, World, check};
use replica::effects::{Actor, FIXTURE_HEADER, Header, fixture_bytes};
use replica::kinds::defined;
use replica::pose::{Quat, Support, Vec3};
use replica::world_model::Kind;

const BIRDBATH: &str = r##"{"format":"souls-entry/1","kind":"gene:birdbath","owner":"thing",
  "geometry":{"bounds_mm":[1000,1200,1000],"parts":[{"kind":"cyl","at":[0,400,0],"r":180,"h":800,"color":"#bbbbbb"}]},
  "text":{"name":"birdbath"}}"##;

fn spot() -> Spot {
    Spot {
        slot: None,
        position: Vec3::new(0, 0, 0),
        orientation: Quat::IDENTITY,
        support: Support::None,
    }
}

fn pinned(header: &Header, plain: &str) -> Name {
    header
        .kinds
        .iter()
        .find(|k| k.as_str().split('@').next() == Some(plain))
        .expect("a pinned kind")
        .clone()
}

struct W {
    bytes: Vec<u8>,
    header: Header,
    world: World,
    root: Id,
    room: Id,
    live: Replica,
    minter: Minter,
    intents: Minter,
    parts: Vec<Arc<Part>>,
    at: Micros,
}

impl W {
    fn new() -> W {
        let bytes = fixture_bytes(FIXTURE_HEADER).expect("bytes");
        let header = Header::read(&bytes).expect("a header");
        let kind = |owner: &str, children: &[&str]| Kind {
            owner: owner.to_owned(),
            children: children.iter().map(|s| (*s).to_owned()).collect(),
            slots: BTreeMap::new(),
            hands: None,
        };
        let kinds = BTreeMap::from([
            (
                pinned(&header, "souls:place").as_str().to_owned(),
                kind("place", &["souls:room"]),
            ),
            (
                pinned(&header, "souls:room").as_str().to_owned(),
                kind("place", &["thing"]),
            ),
        ]);
        let mut minter = Minter::new(header.lineage);
        let root = minter.mint().expect("an id");
        let mut w = W {
            live: Replica::start(&bytes).expect("a replica"),
            bytes,
            world: World {
                creator: Id::new(Scope([0xc0; 16]), 1).expect("an id"),
                kinds,
            },
            header,
            root,
            room: root,
            minter,
            intents: Minter::new(Scope([0x11; 16])),
            parts: Vec::new(),
            at: 0,
        };
        let room = pinned(&w.header, "souls:room");
        w.room = w
            .edit(vec![place(0, &room, Ref::Node(root), BTreeMap::new())])
            .expect("a room")[&0];
        w
    }

    fn edit(&mut self, ops: Vec<Op>) -> Result<BTreeMap<u64, Id>, Refused> {
        let edit = Edit {
            intent: self.intents.mint().expect("an id"),
            actor: Actor::Creator(self.world.creator),
            planned: self.live.version(),
            ops,
        };
        let copy = self.live.frozen();
        let checked = check(edit, &copy, &self.world)?;
        let planned = plan(checked, &copy, None)?;
        self.at += 1_000;
        let c = commit(&mut self.live, &mut self.minter, &planned, &[], self.at)?;
        self.parts.push(c.part);
        Ok(c.names)
    }

    fn define(&mut self, name: u64, record: &str) -> Result<(Id, String), Refused> {
        let names = self.edit(vec![define_op(name, self.root, record)])?;
        let id = names[&name];
        let full = self
            .live
            .tree()
            .handle(id)
            .and_then(|h| self.live.tree().node(h))
            .and_then(|n| defined::named(n.fields()).map(str::to_owned))
            .expect("a full name");
        Ok((id, full))
    }

    fn code(&mut self, ops: Vec<Op>) -> &'static str {
        self.edit(ops).expect_err("refused").name
    }
}

fn place(name: u64, kind: &Name, parent: Ref, fields: BTreeMap<u64, Value>) -> Op {
    Op::Place {
        name,
        kind: kind.clone(),
        parent,
        at: spot(),
        audience: Audience::Everyone,
        fields,
    }
}

fn define_op(name: u64, root: Id, record: &str) -> Op {
    place(
        name,
        &Name::new(&defined::kind().0).expect("a name"),
        Ref::Node(root),
        BTreeMap::from([(defined::ENTRY, Value::Bytes(record.as_bytes().to_vec()))]),
    )
}

fn full(name: &str) -> Name {
    Name::new(name).expect("a name")
}

#[test]
fn a_defined_kind_is_placed_and_a_replica_learns_it_from_the_log() {
    let mut w = W::new();
    let (node, name) = w.define(1, BIRDBATH).expect("defined");
    assert!(name.starts_with("gene:birdbath@1220"), "{name}");
    // The record is kept canonical: keys in order, no spaces, so the same definition is the same bytes.
    let tree = w.live.tree();
    let kept = tree.node(tree.handle(node).expect("live")).expect("a node");
    let Some(Value::Bytes(b)) = kept.fields().get(&defined::ENTRY) else {
        panic!("the record is kept as bytes")
    };
    let text = String::from_utf8(b.clone()).expect("utf-8");
    assert!(text.starts_with(
        r#"{"format":"souls-entry/1","geometry":{"bounds_mm":[1000,1200,1000],"parts""#
    ));
    assert_eq!(name, defined::full_name("gene:birdbath", b));
    // A thing of it on the room, then a viewer's replica replays every part to the same state.
    let room = w.room;
    let bath = w
        .edit(vec![place(
            1,
            &full(&name),
            Ref::Node(room),
            BTreeMap::new(),
        )])
        .expect("placed")[&1];
    let mut viewer = Replica::start(&w.bytes).expect("a replica");
    for p in &w.parts {
        viewer
            .apply(p)
            .expect("a viewer applies a creator's kind from the log");
    }
    let state = |r: &Replica| replica::hash::state_hash(r.tree()).expect("a hash");
    assert_eq!(state(&viewer), state(&w.live));
    let t = viewer.tree();
    assert_eq!(
        t.node(t.handle(bath).expect("live"))
            .expect("a node")
            .kind()
            .as_str(),
        name
    );
}

#[test]
fn a_changed_definition_is_a_new_revision_and_old_things_keep_theirs() {
    let mut w = W::new();
    let (_, one) = w.define(1, BIRDBATH).expect("defined");
    let room = w.room;
    let old = w
        .edit(vec![place(
            1,
            &full(&one),
            Ref::Node(room),
            BTreeMap::new(),
        )])
        .expect("placed")[&1];
    let (_, two) = w
        .define(2, &BIRDBATH.replace("[1000,1200,1000]", "[1100,1200,1100]"))
        .expect("a second revision");
    assert_ne!(one, two);
    assert_eq!(one.split('@').next(), two.split('@').next());
    let t = w.live.tree();
    assert_eq!(
        t.node(t.handle(old).expect("live"))
            .expect("a node")
            .kind()
            .as_str(),
        one
    );
}

#[test]
fn define_and_place_in_one_batch_in_that_order() {
    let mut w = W::new();
    let copy = w.live.frozen();
    let edit = Edit {
        intent: w.intents.mint().expect("an id"),
        actor: Actor::Creator(w.world.creator),
        planned: w.live.version(),
        ops: vec![define_op(1, w.root, BIRDBATH)],
    };
    let name = match &check(edit, &copy, &w.world).expect("checked").edit.ops[0] {
        Op::Place { fields, .. } => defined::named(fields).expect("named").to_owned(),
        _ => unreachable!(),
    };
    let (root, room) = (w.root, w.room);
    let thing = place(2, &full(&name), Ref::Node(room), BTreeMap::new());
    assert_eq!(
        w.code(vec![thing.clone(), define_op(1, root, BIRDBATH)]),
        "edit.kind-unknown"
    );
    let names = w
        .edit(vec![define_op(1, root, BIRDBATH), thing])
        .expect("both");
    assert_eq!(names.len(), 2);
}

#[test]
fn each_check_at_commit_refuses_by_name() {
    let mut w = W::new();
    let root = w.root;
    // kind.invalid: not a record, not the format, a section a creator's kind cannot hold, a fraction, a bad state.
    for bad in [
        "not json",
        r#"{"format":"souls-entry/2","kind":"gene:x","owner":"thing"}"#,
        r#"{"format":"souls-entry/1","kind":"gene:x","owner":"thing","roles":{}}"#,
        r#"{"format":"souls-entry/1","kind":"gene:x","owner":"thing","geometry":{"bounds_mm":[0.5,1,1]}}"#,
        r#"{"format":"souls-entry/1","kind":"gene:x","owner":"thing","state":{"on":{"n":1,"type":"nonsense"}}}"#,
        r#"{"format":"souls-entry/1","kind":"x","owner":"thing"}"#,
    ] {
        assert_eq!(
            w.code(vec![define_op(1, root, bad)]),
            "kind.invalid",
            "{bad}"
        );
    }
    // Not at the root.
    let room = w.room;
    let mut misplaced = define_op(1, root, BIRDBATH);
    if let Op::Place { parent, .. } = &mut misplaced {
        *parent = Ref::Node(room);
    }
    assert_eq!(w.code(vec![misplaced]), "kind.invalid");
    // kind.too-large.
    let big = BIRDBATH.replace("birdbath\"}", &format!("{}\"}}", "b".repeat(70_000)));
    assert_eq!(w.code(vec![define_op(1, root, &big)]), "kind.too-large");
    // kind.namespace: the engine's, the boot content's and every boot kind's namespace.
    for ns in ["souls", "eden"] {
        let r = BIRDBATH.replace("gene:", &format!("{ns}:"));
        assert_eq!(
            w.code(vec![define_op(1, root, &r)]),
            "kind.namespace",
            "{ns}"
        );
    }
    // kind.collision: the same full name again.
    let (def, name) = w.define(1, BIRDBATH).expect("defined");
    assert_eq!(w.code(vec![define_op(1, root, BIRDBATH)]), "kind.collision");
    // The same definition in another key order is the same bytes, so the same name.
    let reordered = r##"{"owner":"thing","kind":"gene:birdbath","format":"souls-entry/1",
      "text":{"name":"birdbath"},"geometry":{"parts":[{"h":800,"r":180,"at":[0,400,0],"kind":"cyl","color":"#bbbbbb"}],"bounds_mm":[1000,1200,1000]}}"##;
    assert_eq!(
        w.code(vec![define_op(1, root, reordered)]),
        "kind.collision"
    );
    // A definition never changes in place.
    assert_eq!(
        w.code(vec![Op::Set {
            node: Ref::Node(def),
            field: defined::ENTRY,
            to: Value::Bytes(b"{}".to_vec()),
        }]),
        "kind.invalid"
    );
    // kind.in-use: removing it while a thing is of it; removing both at once is fine.
    let bath = w
        .edit(vec![place(
            1,
            &full(&name),
            Ref::Node(room),
            BTreeMap::new(),
        )])
        .expect("placed")[&1];
    assert_eq!(
        w.code(vec![Op::Remove {
            node: Ref::Node(def)
        }]),
        "kind.in-use"
    );
    w.edit(vec![
        Op::Remove {
            node: Ref::Node(bath),
        },
        Op::Remove {
            node: Ref::Node(def),
        },
    ])
    .expect("removed together");
    // Gone, it is no longer pinned.
    assert_eq!(
        w.code(vec![place(
            1,
            &full(&name),
            Ref::Node(room),
            BTreeMap::new()
        )]),
        "edit.kind-unknown"
    );
}
