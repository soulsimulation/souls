//! F9's job on a small world written here (#2776): things kept field for field, things in use deferred and refreshed
//! once their users leave, a run cut by a restart finished afterwards, and the revisions refused by name.

use std::collections::BTreeMap;

use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, schema_hash,
};
use replica::encode::{Name, Value, encode};
use replica::ids::FIXTURE_SCOPE_A;
use replica::ids::{Hash, Id, Purpose};
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, parse_kinds, parse_world};

use super::{F_LEFT, Job, Plan, Writer, plan};

const OLD: &str = r#"{1: "t:post", 2: "thing", 11: ["body"],
    3: {1: {1: "tall", 2: "int", 3: 0, 4: "public"}, 2: {1: "worn", 2: "bool", 3: 0, 4: "public"}}}"#;
const NEW: &str = r#"{1: "t:post", 2: "thing", 11: ["body"],
    3: {1: {1: "tall", 2: "int", 3: 0, 4: "public"}, 3: {1: "glow", 2: "bool", 3: 1, 4: "public"}}}"#;
const OTHERS: &str = r#"
{1: "t:ground", 2: "place", 11: ["body", "thing"]}
{1: "t:body", 2: "family", 6: {1: ["thing"]}}
"#;

/// Posts 2 to 6 on the ground, a body (7) reserving post 3 and owning post 4, a body (9) on post 8, a body (10)
/// holding post 11.
const WORLD: &str = r#"{1: [], 2: {}, 3: [
    {1: 1, 2: "t:ground"},
    {1: 2, 2: "t:post", 3: 1, 6: {1: 5, 2: 1}},
    {1: 3, 2: "t:post", 3: 1, 6: {1: 6}},
    {1: 4, 2: "t:post", 3: 1, 6: {1: 7, 2: 0}},
    {1: 5, 2: "t:post", 3: 1, 6: {1: 8}},
    {1: 6, 2: "t:post", 3: 1, 6: {1: 9}},
    {1: 7, 2: "t:body", 3: 1},
    {1: 8, 2: "t:post", 3: 1},
    {1: 9, 2: "t:body", 3: 8},
    {1: 10, 2: "t:body", 3: 1},
    {1: 11, 2: "t:post", 3: 10, 4: 1}
  ], 4: [
    {1: 12, 2: "souls:reserves", 3: [7, 3], 4: 0, 5: "everyone"},
    {1: 13, 2: "souls:owns", 3: [7, 4], 4: 0, 5: "everyone"}
  ]}"#;

fn id(n: u64) -> Id {
    Id::new(FIXTURE_SCOPE_A, n).expect("an id")
}

struct World {
    tree: Tree,
    rules: Rules,
    header: Header,
    next: u64,
    parts: Vec<Vec<u8>>,
}

fn world(p: &Plan) -> World {
    let kinds = parse_kinds(&format!("{OTHERS}\n{}", OLD.replace('\n', " "))).expect("kinds");
    let (tree, mut rules) =
        Tree::load(&parse_world(&kinds, WORLD).expect("a world")).expect("loads");
    rules.kinds.extend(p.kinds.admits());
    let root = id(1);
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/refresh-test/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(root.scope().0.to_vec())),
        (4, root.to_value()),
        (5, Value::Uint(0)),
        (
            6,
            Value::Array(
                [&p.from, &p.to, &p.job]
                    .iter()
                    .map(|n| Value::Text((*n).clone()))
                    .collect(),
            ),
        ),
        (7, Value::Array(Vec::new())),
    ]));
    let header = Header::read(&encode(&v).expect("encodes")).expect("a header");
    let next = tree.to_state().next;
    World {
        tree,
        rules,
        header,
        next,
        parts: Vec::new(),
    }
}

impl World {
    fn writer(&mut self) -> Writer<'_> {
        Writer {
            tree: &mut self.tree,
            header: &self.header,
            rules: &self.rules,
            next: &mut self.next,
            at: 0,
            parts: &mut self.parts,
        }
    }

    /// One entry by `node`: what a user leaving writes.
    fn write(&mut self, node: Id, change: Change) {
        let e = Effect {
            envelope: Envelope {
                sequence: self.next,
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
        };
        let bytes = encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (2, Value::Array(vec![e.to_value()])),
        ])))
        .expect("encodes");
        let part = Part::read(&bytes).expect("a part");
        self.tree
            .commit(&self.header, &part, &self.rules)
            .expect("committed");
        self.next += 1;
        self.parts.push(bytes);
    }

    fn kind(&self, n: u64) -> Option<Name> {
        let node = self.tree.node(self.tree.handle(id(n))?)?;
        Some(node.kind().clone())
    }

    fn fields(&self, n: u64) -> BTreeMap<u64, Value> {
        let h = self.tree.handle(id(n)).expect("live");
        self.tree.node(h).expect("live").fields().clone()
    }
}

fn plan_ok() -> Plan {
    plan(OLD, NEW).unwrap_or_else(|e| panic!("{}: {}", e.name, e.detail))
}

#[test]
fn a2_a3_state_kept_by_number_and_things_in_use_wait_for_their_users() {
    let p = plan_ok();
    assert_eq!(p.added, BTreeMap::from([(3, Value::Uint(1))]));
    assert_eq!(p.dropped, vec![2]);
    let mut w = world(&p);
    let before: BTreeMap<u64, _> = [2, 3, 4, 5, 6].iter().map(|n| (*n, w.fields(*n))).collect();
    let mut job = Job::start(&mut w.writer(), &p, id(100), id(1), Actor::World).expect("started");
    assert_eq!(job.left(), 7);
    let s = job.slice(&mut w.writer(), 100).expect("a slice");
    assert_eq!(s.refreshed, 4);
    let deferred: BTreeMap<Id, &str> = s.deferred.iter().copied().collect();
    assert_eq!(
        deferred,
        BTreeMap::from([(id(3), "reserved"), (id(8), "occupied"), (id(11), "held")])
    );
    assert!(!s.done);
    for n in [2, 4, 5, 6] {
        assert_eq!(w.kind(n), Some(p.to.clone()), "post {n}");
        let mut want = before[&n].clone();
        want.remove(&2);
        want.insert(3, Value::Uint(1));
        assert_eq!(
            w.fields(n),
            want,
            "post {n}: only the added field differs, the dropped one is gone"
        );
    }
    // The owner link was written again with its id; the reservation and the users are untouched.
    assert!(
        w.tree
            .link(id(13))
            .is_some_and(|(_, ends, _, _)| ends == [id(7), id(4)])
    );
    assert!(w.tree.link(id(12)).is_some());
    for n in [3, 8, 11] {
        assert_eq!(w.kind(n), Some(p.from.clone()), "post {n} in use");
    }
    let h = w.tree.handle(id(100)).expect("the job node");
    assert_eq!(
        w.tree.node(h).expect("live").fields()[&F_LEFT],
        Value::Uint(3)
    );

    // Still in use: nothing moves.
    let s = job.slice(&mut w.writer(), 100).expect("a slice");
    assert_eq!((s.refreshed, s.deferred.len()), (0, 3));

    // The reserving body lets go and the seated body leaves: both refreshed next slice; the held one waits.
    w.write(id(7), Change::Unlink { link: id(12) });
    w.write(id(9), Change::Remove { node: id(9) });
    let s = job.slice(&mut w.writer(), 100).expect("a slice");
    assert_eq!(s.refreshed, 2);
    assert_eq!(s.deferred, vec![(id(11), "held")]);
    assert_eq!(w.kind(3), Some(p.to.clone()));
    assert_eq!(w.kind(8), Some(p.to.clone()));
    assert_eq!(w.kind(11), Some(p.from.clone()));

    // The holder goes, taking what it holds: the job ends and its node is removed.
    w.write(id(10), Change::Remove { node: id(10) });
    let s = job.slice(&mut w.writer(), 100).expect("a slice");
    assert!(s.done);
    assert!(job.refused.is_empty());
    assert!(w.tree.handle(id(100)).is_none());
}

#[test]
fn a4_a_run_cut_by_a_restart_finishes_afterwards() {
    let p = plan_ok();
    let mut w = world(&p);
    w.write(id(7), Change::Unlink { link: id(12) });
    let mut job = Job::start(&mut w.writer(), &p, id(100), id(1), Actor::World).expect("started");
    let s = job.slice(&mut w.writer(), 2).expect("a slice");
    assert_eq!(s.refreshed, 2);
    drop(job);

    // The restart: a new tree from the same world and the log so far.
    let parts = std::mem::take(&mut w.parts);
    let mut r = world(&p);
    for bytes in &parts {
        let part = Part::read(bytes).expect("a part");
        r.tree.commit(&r.header, &part, &r.rules).expect("replays");
        r.next += part.effects.len() as u64;
    }
    let mut jobs = Job::recover(&r.tree);
    assert_eq!(jobs.len(), 1);
    let job = &mut jobs[0];
    assert_eq!(job.left(), 5, "the two refreshed are not done again");
    let mut done = false;
    for _ in 0..10 {
        let s = job.slice(&mut r.writer(), 2).expect("a slice");
        if s.done {
            done = true;
            break;
        }
        // The held and seated posts' users leave after the first slice.
        if r.tree.handle(id(9)).is_some() {
            r.write(id(9), Change::Remove { node: id(9) });
            r.write(id(10), Change::Remove { node: id(10) });
        }
    }
    assert!(done);
    for n in [2, 3, 4, 5, 6, 8] {
        assert_eq!(r.kind(n), Some(p.to.clone()), "post {n}");
        assert_eq!(r.fields(n).get(&3), Some(&Value::Uint(1)));
    }
}

#[test]
fn a5_a_changed_shape_or_stand_point_is_refused_by_name() {
    let with =
        |extra: &str| OLD.replacen("11: [\"body\"],", &format!("11: [\"body\"], {extra},"), 1);
    let name = |a: &str, b: &str| plan(a, b).err().map(|e| e.name);
    assert_eq!(
        name(&with("7: h'01'"), &with("7: h'02'")),
        Some("refresh-shape-changed")
    );
    let stand = |z: i64| {
        with(&format!(
            "5: {{1: {{1: \"foot\", 2: [0, 0, {z}], 3: \"stand\"}}}}"
        ))
    };
    assert_eq!(name(&stand(300), &stand(400)), Some("refresh-stand-moved"));
    let reused = OLD.replace(
        "2: {1: \"worn\", 2: \"bool\"",
        "2: {1: \"worn\", 2: \"int\"",
    );
    assert_eq!(name(OLD, &reused), Some("refresh-field-reused"));
    assert_eq!(name(OLD, OLD), Some("refresh-same-revision"));
    // The same shape and stand point, with a field added, is a revision.
    assert!(
        plan(
            &stand(300),
            &stand(300).replace("\"worn\", 2: \"bool\", 3: 0", "\"worn\", 2: \"bool\", 3: 1")
        )
        .is_ok()
    );
}
