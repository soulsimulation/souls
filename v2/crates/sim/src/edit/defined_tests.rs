//! A creator's own kinds (#3697): a definition is a `souls:kind` node at the root holding its canonical record; a thing
//! of the kind is placed by its full name; a replica replaying the log learns the kind from it; and each check at
//! commit refuses by name (`kind.invalid`, `kind.too-large`, `kind.collision`, `kind.namespace`, `kind.in-use`,
//! `kind.field-reserved`).

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
    history: undo::History,
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
            fields: Default::default(),
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
            history: undo::History::default(),
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
            claim: None,
        };
        let copy = self.live.frozen();
        let checked = check(edit, &copy, &self.world)?;
        let planned = plan(checked, &copy, None)?;
        self.at += 1_000;
        let c = self.history.edit(
            &mut self.live,
            &mut self.minter,
            &planned,
            &[],
            self.at,
            None,
        )?;
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
    // It stands as its kind's bounds say: the walk outline, 1000 x 1200 x 1000 mm, in the solids walkers go round.
    let t = w.live.tree();
    let u = Value::Uint;
    assert_eq!(
        t.node(t.handle(bath).expect("live"))
            .expect("a node")
            .fields()
            .get(&12),
        Some(&Value::Array(vec![Value::Array(vec![
            u(0),
            u(0),
            u(500),
            u(500),
            u(0),
            u(0),
            u(1200)
        ])]))
    );
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
        claim: None,
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
    // kind.field-reserved: a state field numbered like one the engine keeps on things (the marks, a tint).
    for n in [143, 144, 145] {
        let r = format!(
            r#"{{"format":"souls-entry/1","kind":"gene:x","owner":"thing","state":{{"hue":{{"n":{n},"type":"int","default":0}}}}}}"#
        );
        assert_eq!(
            w.code(vec![define_op(1, root, &r)]),
            "kind.field-reserved",
            "{n}"
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

/// A record whose `tray` slot admits `admits` (a JSON list's items) and whose `sprout` form creates `makes` into it and
/// starts `leaf` by timer after `after_us`; `leaf` starts `sprout` again after `back_us`, or nothing when `None`.
fn pod(admits: &str, makes: &str, after_us: u64, back_us: Option<u64>) -> String {
    let leaf = back_us.map_or(String::new(), |us| {
        format!(r#"{{"change":"timer","form":"sprout","after_us":{us}}}"#)
    });
    format!(
        r#"{{"format":"souls-entry/1","kind":"gene:pod","owner":"thing",
  "slots":{{"tray":{{"kinds":[{admits}],"at_mm":[0,300,0]}}}},
  "forms":{{"sprout":{{"who":"anyone","effects":[
    {{"change":"create","kind":"{makes}","into":"tray"}},
    {{"change":"timer","form":"leaf","after_us":{after_us}}}]}},
   "leaf":{{"who":"anyone","effects":[{leaf}]}}}}}}"#
    )
}

/// The review's blockers (#3697): a form's effects the world would refuse every time are refused at define
/// (`kind.effects`), huge bounds are `kind.too-large` (never an overflow later), a definition is for everyone
/// (`kind.audience`), and a kind another definition's form creates is `kind.in-use`.
#[test]
fn review_blockers_are_refused_at_define_by_name() {
    let mut w = W::new();
    let root = w.root;
    // kind.too-large: bounds past the world's scale, which the ground's µm arithmetic would overflow.
    let huge = BIRDBATH.replace("[1000,1200,1000]", "[20000000000000000,2000,400]");
    assert_eq!(w.code(vec![define_op(1, root, &huge)]), "kind.too-large");
    // kind.audience: a definition every copy must apply is for everyone.
    let mut private = define_op(1, root, BIRDBATH);
    if let Op::Place { audience, .. } = &mut private {
        *audience = Audience::Of(root);
    }
    assert_eq!(w.code(vec![private]), "kind.audience");
    // kind.effects: a create of a kind the world neither pins nor defines (by its full name) ...
    let (seed_def, seed) = w
        .define(
            1,
            &BIRDBATH
                .replace("birdbath", "seed")
                .replace("[1000,1200,1000]", "[100,100,100]"),
        )
        .expect("a seed, too low to have solids");
    let day = 86_400_000_000;
    for makes in ["eden:apple@1220aa", "gene:typo", "gene:seed"] {
        let r = pod("\"gene:seed\"", makes, day, None);
        let no = w.edit(vec![define_op(1, root, &r)]).expect_err("refused");
        assert_eq!(no.name, "kind.effects", "{makes}: {}", no.detail);
    }
    // ... into a slot that does not admit it ...
    let r = pod("", &seed, day, None);
    assert_eq!(w.code(vec![define_op(1, root, &r)]), "kind.effects");
    // ... and forms that start each other by timer sooner than a tick, in a ring.
    let r = pod("\"gene:seed\"", &seed, 1, Some(1));
    assert_eq!(w.code(vec![define_op(1, root, &r)]), "kind.effects");
    // A quick timer that is no ring, or a ring that takes a day, with a create the slot admits, are fine.
    let r = pod("\"gene:seed\"", &seed, 1, Some(day));
    let (pod_def, _) = w
        .define(1, &r)
        .expect("a pod whose forms the world can run");
    // kind.in-use: the seed's kind is still made by the pod's form; removing both at once is fine.
    assert_eq!(
        w.code(vec![Op::Remove {
            node: Ref::Node(seed_def)
        }]),
        "kind.in-use"
    );
    w.edit(vec![
        Op::Remove {
            node: Ref::Node(pod_def),
        },
        Op::Remove {
            node: Ref::Node(seed_def),
        },
    ])
    .expect("removed together");
}

/// #3697 re-review: a made thing is not judged for what it would bury, so a form that would make a thing with solids
/// into a slot (where a Soul may stand, fixed geometry once the slot has a point) is refused at define,
/// `kind.effects`; the same thing made into a hand defines, and keeps its solids for when it is set down and judged.
#[test]
fn a_form_that_would_make_a_thing_with_solids_into_a_slot_is_refused() {
    let mut w = W::new();
    let root = w.root;
    let (_, birdbath) = w.define(1, BIRDBATH).expect("a birdbath, 1.2 m tall");
    let day = 86_400_000_000;
    let into_slot = pod("\"gene:birdbath\"", &birdbath, day, None);
    let no = w
        .edit(vec![define_op(1, root, &into_slot)])
        .expect_err("refused");
    println!("a pod that makes a birdbath into its tray: {}", no.detail);
    assert_eq!(no.name, "kind.effects", "{}", no.detail);
    assert!(no.detail.contains("made only into a hand"), "{}", no.detail);
    let into_hand = into_slot.replace(r#""into":"tray""#, r#""into":"actor_hand""#);
    w.define(1, &into_hand)
        .expect("made into a hand, it defines");
    let made = crate::forms::amounts::made_fields(w.live.tree(), &full(&birdbath));
    assert!(made.contains_key(&12), "a made birdbath keeps its solids");
}

/// A chain of forms, each starting the next by many 1 µs timers (#3697 re-review): with no ring, the ring search
/// keeps the soonest timer per pair of forms and stays polynomial, so the record defines at once; the same chain
/// closed into a ring under a tick is still `kind.effects`.
fn chain(forms: usize, timers: usize, ring: bool) -> String {
    let form = |i: usize| {
        let next = if i + 1 < forms {
            Some(i + 1)
        } else {
            ring.then_some(0)
        };
        let effects = next.map_or(String::new(), |n| {
            vec![format!(r#"{{"change":"timer","form":"f{n}","after_us":1}}"#); timers].join(",")
        });
        format!(r#""f{i}":{{"who":"anyone","effects":[{effects}]}}"#)
    };
    let forms = (0..forms).map(form).collect::<Vec<_>>().join(",");
    format!(
        r#"{{"format":"souls-entry/1","kind":"gene:chain","owner":"thing","forms":{{{forms}}}}}"#
    )
}

#[test]
fn a_long_chain_of_quick_timers_with_no_ring_is_checked_fast() {
    let mut w = W::new();
    let root = w.root;
    // 30^9 paths for the old search, which never finished; the soonest per pair checks 10 forms at once.
    w.define(1, &chain(10, 30, false))
        .expect("a ring-free chain of quick timers");
    assert_eq!(
        w.code(vec![define_op(2, root, &chain(10, 30, true))]),
        "kind.effects"
    );
}

/// `kind.in-use` holds at commit (#3697 review): a thing of the kind made after the removal was checked (as a Soul's
/// form makes one) refuses it on the live copy, which the read set alone would not.
#[test]
fn a_thing_made_after_the_check_still_refuses_the_removal() {
    let mut w = W::new();
    let (def, name) = w.define(1, BIRDBATH).expect("defined");
    let copy = w.live.frozen();
    let removal = Edit {
        intent: w.intents.mint().expect("an id"),
        actor: Actor::Creator(w.world.creator),
        planned: w.live.version(),
        ops: vec![Op::Remove {
            node: Ref::Node(def),
        }],
        claim: None,
    };
    let checked = check(removal, &copy, &w.world).expect("nothing uses it yet");
    let room = w.room;
    w.edit(vec![place(
        1,
        &full(&name),
        Ref::Node(room),
        BTreeMap::new(),
    )])
    .expect("placed meanwhile");
    assert_eq!(
        replica::edit::confirm(&w.live, &checked)
            .expect_err("in use now")
            .name,
        "kind.in-use"
    );
}

/// #3697 review: a thing a creator's form makes stands as its kind's bounds say, as a placed one does (field 12, the
/// solids walkers go round and the safety rule judges); a boot kind's made thing starts with no fields, as before.
#[test]
fn a_made_thing_of_a_creators_kind_has_its_solids() {
    let mut w = W::new();
    let (_, name) = w.define(1, BIRDBATH).expect("defined");
    let made = crate::forms::amounts::made_fields(w.live.tree(), &full(&name));
    let record = defined::read(BIRDBATH.as_bytes(), &|_| false).expect("a record");
    assert_eq!(
        made.get(&12),
        defined::solids_of(&record.entry).as_ref(),
        "the record's solids"
    );
    assert!(made.contains_key(&12));
    let room = pinned(&w.header, "souls:room");
    assert!(crate::forms::amounts::made_fields(w.live.tree(), &room).is_empty());
}

/// #3697 re-review: an undo or a redo that would remove a creator's definition while a thing of its kind is left (one
/// a Soul's form made since, outside the creator's batches) is refused `kind.in-use`, as an edit's removal is: in the
/// preview the checker plans on and at the tick. Without a thing left, the same undo goes through.
#[test]
fn an_undo_or_redo_that_removes_a_kind_a_thing_still_has_is_refused() {
    let mut w = W::new();
    let (def, name) = w.define(1, BIRDBATH).expect("defined");
    let removal = vec![Op::Remove {
        node: Ref::Node(def),
    }];
    w.edit(removal).expect("removed, nothing uses it");
    let creator = Actor::Creator(w.world.creator);
    let next = |w: &mut W| {
        w.at += 1_000;
        w.at
    };
    let at = next(&mut w);
    w.history
        .undo(&mut w.live, &w.world, creator, at, &mut |_, _| Ok(()))
        .expect("the removal undone, the definition back");
    // A thing of the kind made outside the history, as a Soul's form makes one.
    let history = std::mem::take(&mut w.history);
    let room = w.room;
    let thing = w
        .edit(vec![place(
            1,
            &full(&name),
            Ref::Node(room),
            BTreeMap::new(),
        )])
        .expect("a birdbath made")[&1];
    w.history = history;
    let at = next(&mut w);
    let preview = w
        .history
        .preview(true, &w.live, &w.world, creator, at)
        .expect_err("refused");
    println!("redo of the removal while {thing:?} is a birdbath: {preview:?}");
    assert_eq!(preview.name, "kind.in-use");
    let redo = w
        .history
        .redo(&mut w.live, &w.world, creator, at, &mut |_, _| Ok(()))
        .expect_err("refused at the tick");
    assert_eq!(redo.name, "kind.in-use");
    // Undo, past the redo: the definition's own batch, which would remove it from under the birdbath.
    let undo = w
        .history
        .undo(&mut w.live, &w.world, creator, at, &mut |_, _| Ok(()))
        .expect_err("refused");
    println!("undo of the definition while {thing:?} is a birdbath: {undo:?}");
    assert_eq!(undo.name, "kind.in-use");
    assert!(w.live.tree().handle(def).is_some(), "the definition stays");
    // With the thing gone (outside the history again), the undo goes through.
    let history = std::mem::take(&mut w.history);
    w.edit(vec![Op::Remove {
        node: Ref::Node(thing),
    }])
    .expect("the birdbath removed");
    w.history = history;
    let at = next(&mut w);
    w.history
        .undo(&mut w.live, &w.world, creator, at, &mut |_, _| Ok(()))
        .expect("nothing has the kind now");
    assert!(w.live.tree().handle(def).is_none(), "the definition undone");
}

/// #3697 round 3: a form's put (and a reparent into a slot, which binds to the same put) of a creator's thing with
/// solids into a slot its holder gives a point would make it fixed geometry no one judged, so a Soul could be buried
/// by a thing made into its hand and then put away. It is refused `solid-into-slot` by name; into a slot with no
/// point (carried, never ground) the put goes through.
#[test]
fn a_form_cannot_put_a_creators_solid_thing_into_a_slot_with_a_point() {
    use crate::forms::amounts::{Cx, View};
    use skills::form_runner::{Effect as Bound, Of};
    let mut w = W::new();
    let (_, birdbath) = w.define(1, BIRDBATH).expect("a birdbath, 1.2 m tall");
    let bay = r#"{"format":"souls-entry/1","kind":"gene:bay","owner":"thing",
  "slots":{"bay":{"kinds":["gene:birdbath"],"at_mm":[0,0,600]}},
  "forms":{"make":{"who":"anyone","effects":[{"change":"create","kind":"BIRDBATH","into":"actor_hand"}]}}}"#
        .replace("BIRDBATH", &birdbath);
    let (_, bay) = w
        .define(2, &bay)
        .expect("a bay whose form makes a birdbath into a hand");
    let room = w.room;
    // The bay with a point for its slot (a Soul may stand there), one without, and a birdbath standing in for the
    // one the bay's form made into the Soul's hand (the room stands in for that Soul's body).
    let point = Value::Array(vec![Value::Array(
        [1u64, 0, 0, 600].map(Value::Uint).to_vec(),
    )]);
    let names = w
        .edit(vec![
            place(
                1,
                &full(&bay),
                Ref::Node(room),
                BTreeMap::from([(13, point)]),
            ),
            place(2, &full(&bay), Ref::Node(room), BTreeMap::new()),
            place(3, &full(&birdbath), Ref::Node(room), BTreeMap::new()),
        ])
        .expect("placed");
    let (fixed, carried, thing) = (names[&1], names[&2], names[&3]);
    let limits = crate::forms::amounts::Limits::default();
    let mut minter = Minter::new(Scope([0x3a; 16]));
    let put = |node: Id, minter: &mut Minter| {
        let cx = Cx {
            view: View {
                tree: w.live.tree(),
                out: &[],
            },
            limits: &limits,
            defs: &Default::default(),
            header: Some(&w.header),
            body: room,
            soul: room,
            hands: &[],
            node,
            reserved: &[],
            now: 0,
            stocks: &crate::forms::Stocks::new(),
        };
        cx.entries(
            minter,
            &Bound::Put {
                what: Of::Node(thing),
                slot: 1,
                on: None,
            },
        )
    };
    let no = put(fixed, &mut minter).expect_err("refused");
    println!("put the birdbath into the bay's pointed slot: {no:?}");
    assert_eq!(no.name, "solid-into-slot", "{}", no.detail);
    put(carried, &mut minter).expect("into a slot with no point, it is carried");
}
