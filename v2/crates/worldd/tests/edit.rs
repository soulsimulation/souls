//! A creator's edits as effects (Engine v2 G1, #2746). Each batch is checked on a frozen copy (`replica::edit`),
//! committed on the clock thread (`sim::edit`) through the one write path, appended to K4's log on a disk in memory
//! and handed to R3's view tier, as the clock thread does with an act. Then all three views are compared: a replica
//! (a client's copy, applying the same bytes), the viewer's stream (R3's frames for the root's public `full` key) and
//! the archive (the log read back from the disk and applied from the start).
//!
//! A1 and A2: one test per operation. A3: a refused batch leaves the log's hash unchanged and names the operation. A4:
//! who, size and kind. A5: an edit planned against an older version.

use replica::apply::Replica;
use replica::edit::{
    Edit, NODES_MOST, OPS_MOST, Op, Ref, Refused, Spot, WRITTEN_MOST, World, check,
};
use replica::effects::{
    Actor, Body, Cause, Effect, FIXTURE_HEADER, Header, Part, State, fixture_bytes,
};
use replica::encode::{Name, Value, decode};
use replica::hash::state_hash;
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::pose::{Frame, Pose};
use replica::pose::{Quat, Support, Vec3};
use replica::views::{Key, Level, Redactions};
use replica::world_model::{Audience, Kind};
use sim::edit::safety::Who;
use sim::edit::{Committed, Planned, commit, plan};
use sim::log::{Log, Mem, recover};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;
use worldd::views::{Delivery, Subscriber, Tier};

const FIELD: u64 = 1;
/// A tick's room in the test of the write rule's room.
const ROOM: usize = 1 << 20;

fn spot(x: i64, slot: Option<u64>) -> Spot {
    Spot {
        slot,
        position: Vec3::new(x, 0, 0),
        orientation: Quat::IDENTITY,
        support: if slot.is_some() {
            Support::Slot
        } else {
            Support::None
        },
    }
}

/// The world: the live replica and its minter, K4's log on a disk in memory, R3's tier following it with one
/// subscriber on the root's public `full` key, and a client's replica.
struct W {
    header: Header,
    world: World,
    root: Id,
    live: Replica,
    minter: Minter,
    intents: Minter,
    disk: Mem,
    log: Log<Mem>,
    tier: Tier,
    sub: Subscriber,
    client: Replica,
    start: State,
    at: i64,
    /// Each committed edit's intent and the effects it wrote.
    committed: Vec<(Id, Vec<Effect>)>,
    /// The Souls' bodies as they stand on each commit tick, for the safety rule (#3280).
    bodies: Vec<Who>,
}

fn kind(header: &Header, plain: &str) -> Name {
    header
        .kinds
        .iter()
        .find(|k| k.as_str().split('@').next() == Some(plain))
        .expect("a pinned kind")
        .clone()
}

fn names(list: &[&str]) -> BTreeSet<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

impl W {
    fn new() -> W {
        let bytes = fixture_bytes(FIXTURE_HEADER).expect("bytes");
        let header = Header::read(&bytes).expect("a header");
        let thing = |children: &[&str], slots: Vec<(u64, &[&str])>| Kind {
            owner: "thing".to_owned(),
            children: names(children),
            slots: slots.into_iter().map(|(s, l)| (s, names(l))).collect(),
            hands: None,
            fields: Default::default(),
        };
        let kinds = BTreeMap::from([
            (
                kind(&header, "souls:place").as_str().to_owned(),
                thing(&["souls:room"], vec![]),
            ),
            (
                kind(&header, "souls:room").as_str().to_owned(),
                thing(&["souls:crate", "souls:key"], vec![]),
            ),
            (
                kind(&header, "souls:crate").as_str().to_owned(),
                thing(&[], vec![(1, &["souls:key"])]),
            ),
            (
                kind(&header, "souls:key").as_str().to_owned(),
                thing(&[], vec![]),
            ),
        ]);
        let world = World {
            creator: Id::new(Scope([0xc0; 16]), 1).expect("an id"),
            kinds,
        };
        // The world's minter gave the zone's root its id first.
        let mut minter = Minter::new(header.lineage);
        let root = minter.mint().expect("an id");
        assert_eq!(root, header.zone);
        let start = State::start(root, kind(&header, "souls:place"));
        let disk = Mem::default();
        let (log, _) = Log::open(Mem(disk.0.clone()), 1).expect("a log");
        let tier = Tier::start(
            header.clone(),
            start.clone(),
            Redactions::default(),
            log.durable_mark(),
        )
        .expect("a tier");
        let key = Key {
            node: root,
            level: Level::Full,
            audience: Audience::Everyone,
        };
        let sub = tier.subscribe(vec![key], 100_000);
        W {
            live: Replica::start(&bytes).expect("a replica"),
            client: Replica::start(&bytes).expect("a replica"),
            header,
            world,
            root,
            minter,
            intents: Minter::new(Scope([0x11; 16])),
            disk,
            log,
            tier,
            sub,
            start,
            at: 0,
            committed: Vec::new(),
            bodies: Vec::new(),
        }
    }

    fn creator(&self) -> Actor {
        Actor::Creator(self.world.creator)
    }

    /// One edit, from `actor`, planned against `planned`: checked on a frozen copy, committed on the clock thread,
    /// appended to the log and handed to the tier, then applied by the client. Its three views are compared.
    fn edit(&mut self, actor: Actor, planned: u64, ops: Vec<Op>) -> Result<Committed, Refused> {
        self.edit_under(actor, planned, ops, None)
    }

    /// [`W::edit`], sent under a build claim (#3701).
    fn edit_under(
        &mut self,
        actor: Actor,
        planned: u64,
        ops: Vec<Op>,
        claim: Option<&str>,
    ) -> Result<Committed, Refused> {
        let intent = self.intents.mint().expect("an id");
        let copy = self.live.frozen();
        let checked = check(
            Edit {
                claim: claim.map(|c| Name::new(c).expect("a name")),
                intent,
                actor,
                planned,
                ops,
            },
            &copy,
            &self.world,
        )?;
        // The fixture's zone has no open ground: the safety rule judges what a body uses.
        let planned = plan(checked, &copy, None)?;
        self.commit(&planned)
    }

    fn commit(&mut self, planned: &Planned) -> Result<Committed, Refused> {
        self.at += 1_000;
        let checked = &planned.checked;
        let c = commit(
            &mut self.live,
            &mut self.minter,
            planned,
            &self.bodies,
            self.at,
        )?;
        let bytes = c.part.stored().to_vec();
        let n = self.log.append(bytes.clone()).expect("appended");
        self.tier.offer(n, bytes.clone());
        self.client
            .apply_bytes(&bytes)
            .expect("the client applies it");
        self.views(checked.edit.intent, checked.edit.actor, n, &c.part);
        Ok(c)
    }

    /// The batch as generic effects under one cause, its editor acting (the creator, or a claim's helper); the
    /// client's replica equal to the live one; the stream's frame for this record holding exactly the batch's effects.
    fn views(&mut self, intent: Id, actor: Actor, record: u64, part: &Part) {
        assert!(!part.effects.is_empty());
        for e in &part.effects {
            assert_eq!(e.envelope.cause, Cause::Intent(intent));
            assert_eq!(e.envelope.actor, actor);
            assert!(matches!(e.body, Body::Changes(_)), "generic changes");
        }
        assert_eq!(
            state_hash(self.client.tree()).expect("a hash"),
            state_hash(self.live.tree()).expect("a hash"),
            "the replica equals the live state"
        );
        let Some(Delivery::Frame {
            record: r, bytes, ..
        }) = self.sub.recv_timeout(Duration::from_secs(30))
        else {
            panic!("the tier sent no frame: {:?}", self.tier.stats().fault)
        };
        assert_eq!(r, record);
        let Value::Map(mut frame) = decode(&bytes).expect("a frame").value else {
            panic!("a frame is a map")
        };
        let records = frame.remove(&8).expect("its records");
        let want: Vec<Value> = part.effects.iter().map(Effect::to_value).collect();
        assert_eq!(
            records,
            Value::Array(want),
            "the stream carries the batch's effects"
        );
        self.committed.push((intent, part.effects.clone()));
    }

    fn log_hash(&self) -> Hash {
        Hash::of(
            Purpose::Fixture,
            &self.disk.0.lock().expect("the disk").bytes,
        )
    }

    /// Ends the tier and the log; the archive (the disk read back and applied from the start) equals the live state,
    /// and holds each edit's effects under its cause. Returns the archive: the world as a restart reads it back.
    fn close(self) -> Replica {
        let stats = self.tier.close();
        assert_eq!(stats.fault, None);
        let mut disk = self.log.close();
        let found = recover(&sim::log::Storage::read(&mut disk).expect("the disk"))
            .expect("the log reads back");
        let parts: Vec<Part> = found
            .records
            .iter()
            .map(|r| Part::read(r).expect("a part"))
            .collect();
        let mut archive = Replica::start(self.header.stored()).expect("a replica");
        let mut state = self.start.clone();
        for p in &parts {
            archive.apply(p).expect("the archive applies");
            state.apply(&self.header, p).expect("the reference apply");
        }
        assert_eq!(
            state_hash(archive.tree()).expect("a hash"),
            state_hash(self.live.tree()).expect("a hash"),
            "the archive equals the live state"
        );
        assert_eq!(state.next, self.live.version());
        for (intent, effects) in &self.committed {
            let got: Vec<&Effect> = parts
                .iter()
                .flat_map(|p| &p.effects)
                .filter(|e| e.envelope.cause == Cause::Intent(*intent))
                .collect();
            assert_eq!(
                got,
                effects.iter().collect::<Vec<_>>(),
                "the archive holds the batch"
            );
        }
        println!(
            "{} edits, {} entries: replica, stream and archive agree",
            self.committed.len(),
            state.next
        );
        archive
    }

    /// A room under the root with a crate in it and a key in the crate's slot: the batch's minted ids.
    fn furnish(&mut self) -> (Id, Id, Id) {
        let h = self.header.clone();
        let c = self
            .edit(
                self.creator(),
                self.live.version(),
                vec![
                    place(
                        0,
                        &kind(&h, "souls:room"),
                        Ref::Node(self.root),
                        spot(0, None),
                    ),
                    place(1, &kind(&h, "souls:crate"), Ref::New(0), spot(2, None)),
                    place(2, &kind(&h, "souls:key"), Ref::New(1), spot(0, Some(1))),
                ],
            )
            .expect("committed");
        (c.names[&0], c.names[&1], c.names[&2])
    }
}

fn place(name: u64, kind: &Name, parent: Ref, at: Spot) -> Op {
    Op::Place {
        name,
        kind: kind.clone(),
        parent,
        at,
        audience: Audience::Everyone,
        fields: BTreeMap::new(),
    }
}

fn node(live: &Replica, id: Id) -> Option<Value> {
    live.node(id)
}

// --- A1 and A2: one test per operation ------------------------------------------------------------------------------

#[test]
fn a1_a2_place_commits_one_batch_seen_in_all_three_views() {
    let mut w = W::new();
    let (room, cr, key) = w.furnish();
    // Three places, written by their parents: the root, the room, the crate. Ids minted by the engine.
    let (_, effects) = w.committed.last().expect("one").clone();
    assert_eq!(effects.len(), 3);
    assert_eq!(
        effects.iter().map(|e| e.envelope.node).collect::<Vec<_>>(),
        vec![w.root, room, cr]
    );
    assert!(node(&w.live, key).is_some());
    w.close();
}

#[test]
fn a1_a2_move_commits_one_batch_seen_in_all_three_views() {
    let mut w = W::new();
    let (_, cr, key) = w.furnish();
    let v = w.live.version();
    let c = w
        .edit(
            w.creator(),
            v,
            vec![
                Op::Move {
                    node: Ref::Node(cr),
                    at: spot(7, None),
                },
                Op::Move {
                    node: Ref::Node(key),
                    at: spot(1, Some(1)),
                },
            ],
        )
        .expect("committed");
    assert_eq!(c.part.effects.len(), 2, "each node writes its own move");
    w.close();
}

#[test]
fn a1_a2_set_commits_one_batch_seen_in_all_three_views() {
    let mut w = W::new();
    let (room, cr, _) = w.furnish();
    let v = w.live.version();
    w.edit(
        w.creator(),
        v,
        vec![
            Op::Set {
                node: Ref::Node(cr),
                field: FIELD,
                to: Value::Uint(3),
            },
            Op::Set {
                node: Ref::Node(cr),
                field: FIELD + 1,
                to: Value::Text(Name::new("souls:open").expect("a name")),
            },
            Op::Set {
                node: Ref::Node(room),
                field: FIELD,
                to: Value::Uint(9),
            },
        ],
    )
    .expect("committed");
    let Some(Value::Map(n)) = node(&w.live, cr) else {
        panic!("the crate")
    };
    let Some(Value::Map(fields)) = n.get(&6) else {
        panic!("its fields: {n:?}")
    };
    assert_eq!(fields.get(&FIELD), Some(&Value::Uint(3)));
    w.close();
}

#[test]
fn a1_a2_remove_commits_one_batch_seen_in_all_three_views() {
    let mut w = W::new();
    let (room, cr, key) = w.furnish();
    let v = w.live.version();
    w.edit(
        w.creator(),
        v,
        vec![Op::Remove {
            node: Ref::Node(cr),
        }],
    )
    .expect("committed");
    assert!(
        node(&w.live, cr).is_none() && node(&w.live, key).is_none(),
        "the subtree is gone"
    );
    assert!(node(&w.live, room).is_some());
    w.close();
}

// --- A3: a refused batch changes nothing and names its operation ---------------------------------------------------

#[test]
fn a3_a_refused_batch_leaves_the_log_hash_unchanged_and_names_the_operation() {
    let mut w = W::new();
    let (room, cr, _) = w.furnish();
    let (log, state, version) = (
        w.log_hash(),
        state_hash(w.live.tree()).expect("a hash"),
        w.live.version(),
    );
    let h = w.header.clone();
    // The second operation puts a room inside a crate, which a crate does not admit.
    let r = w
        .edit(
            w.creator(),
            version,
            vec![
                Op::Set {
                    node: Ref::Node(room),
                    field: FIELD,
                    to: Value::Uint(1),
                },
                place(0, &kind(&h, "souls:room"), Ref::Node(cr), spot(0, None)),
            ],
        )
        .expect_err("refused");
    assert_eq!(
        (r.op, r.name),
        (Some(1), "edit.child-not-admitted"),
        "{r:?}"
    );
    assert_eq!(w.log_hash(), log);
    assert_eq!(state_hash(w.live.tree()).expect("a hash"), state);
    assert_eq!(w.live.version(), version);
    w.close();
}

// --- A4: who, size and kind ----------------------------------------------------------------------------------------

#[test]
fn a4_another_actor_an_oversized_batch_and_an_unknown_kind_are_refused_by_name() {
    let mut w = W::new();
    let (room, cr, _) = w.furnish();
    let log = w.log_hash();
    let v = w.live.version();
    let set = Op::Set {
        node: Ref::Node(cr),
        field: FIELD,
        to: Value::Uint(1),
    };
    let other = Id::new(Scope([0xc0; 16]), 2).expect("an id");
    for actor in [Actor::Creator(other), Actor::Soul(other), Actor::World] {
        let r = w.edit(actor, v, vec![set.clone()]).expect_err("refused");
        assert_eq!(r.name, "edit.not-the-creator", "{actor:?}");
    }
    let r = w
        .edit(w.creator(), v, vec![set.clone(); OPS_MOST + 1])
        .expect_err("refused");
    assert_eq!(r.name, "edit.too-many-operations");
    // A known plain name with another hash is not a pinned kind.
    let h = w.header.clone();
    let unpinned = Name::new(&format!("souls:key@1220{}", "00".repeat(32))).expect("a name");
    let r = w
        .edit(
            w.creator(),
            v,
            vec![
                set.clone(),
                place(0, &unpinned, Ref::Node(room), spot(0, None)),
            ],
        )
        .expect_err("refused");
    assert_eq!((r.op, r.name), (Some(1), "edit.kind-unknown"));
    assert_eq!(w.log_hash(), log, "nothing refused reached the log");
    // A room of NODES_MOST keys and the room itself: removing it changes one node too many.
    let full = w
        .edit(
            w.creator(),
            w.live.version(),
            vec![place(
                0,
                &kind(&h, "souls:room"),
                Ref::Node(w.root),
                spot(0, None),
            )],
        )
        .expect("committed")
        .names[&0];
    for _ in 0..NODES_MOST / OPS_MOST {
        let ops = (0..OPS_MOST as u64)
            .map(|n| place(n, &kind(&h, "souls:key"), Ref::Node(full), spot(0, None)))
            .collect();
        w.edit(w.creator(), w.live.version(), ops)
            .expect("committed");
    }
    let log = w.log_hash();
    let r = w
        .edit(
            w.creator(),
            w.live.version(),
            vec![Op::Remove {
                node: Ref::Node(full),
            }],
        )
        .expect_err("refused");
    assert_eq!((r.op, r.name), (Some(0), "edit.too-many-nodes"));
    assert_eq!(w.log_hash(), log);
    w.close();
}

// --- #3956: no batch outgrows a log record -------------------------------------------------------------------------

/// A set over the batch limit, and rows that would grow a field past it, are refused `edit.too-large`; a rows
/// operation with no rows is refused `edit.rows`. Nothing refused reaches the log.
#[test]
fn a_batch_writing_more_than_a_record_holds_and_empty_rows_are_refused_by_name() {
    let mut w = W::new();
    let (room, cr, _) = w.furnish();
    let log = w.log_hash();
    let v = w.live.version();
    let big = Value::Bytes(vec![1; WRITTEN_MOST + 1]);
    let r = w
        .edit(
            w.creator(),
            v,
            vec![Op::Set {
                node: Ref::Node(cr),
                field: FIELD,
                to: big,
            }],
        )
        .expect_err("refused");
    assert_eq!((r.op, r.name), (Some(0), "edit.too-large"), "{r:?}");
    // Two halves, each under the limit, over it together; and rows merged into a field already near it.
    let half = || Value::Bytes(vec![2; WRITTEN_MOST / 2 + 1]);
    let r = w
        .edit(
            w.creator(),
            v,
            vec![
                Op::Set {
                    node: Ref::Node(cr),
                    field: FIELD,
                    to: half(),
                },
                Op::Set {
                    node: Ref::Node(room),
                    field: FIELD,
                    to: half(),
                },
            ],
        )
        .expect_err("refused");
    assert_eq!((r.op, r.name), (Some(1), "edit.too-large"), "{r:?}");
    let row = |k: u64, len: usize| {
        Value::Array(vec![
            Value::Uint(k),
            Value::Uint(0),
            Value::Bytes(vec![3; len]),
        ])
    };
    let rows = |rows: Vec<Value>| Op::Rows {
        node: Ref::Node(cr),
        field: FIELD,
        rows,
    };
    let r = w
        .edit(
            w.creator(),
            v,
            vec![
                Op::Set {
                    node: Ref::Node(cr),
                    field: FIELD,
                    to: Value::Array(Vec::new()),
                },
                rows(Vec::new()),
            ],
        )
        .expect_err("refused");
    assert_eq!((r.op, r.name), (Some(1), "edit.rows"), "{r:?}");
    let r = w
        .edit(
            w.creator(),
            v,
            vec![
                Op::Set {
                    node: Ref::Node(cr),
                    field: FIELD,
                    to: Value::Array(vec![row(0, WRITTEN_MOST / 2)]),
                },
                rows(vec![row(1, WRITTEN_MOST / 2)]),
            ],
        )
        .expect_err("refused");
    assert_eq!((r.op, r.name), (Some(1), "edit.too-large"), "{r:?}");
    assert_eq!(w.log_hash(), log, "nothing refused reached the log");
    w.close();
}

/// Defence in depth: a tick's writes that together would outgrow its one log record are refused `part.too-large` on
/// the write path, before they reach the live world, even when each batch passed its check; the next tick's room
/// takes the same batch. A small room stands in for a record's (`sim::commit::TICK_PARTS_MOST`), as the rule is the
/// same.
#[test]
fn writes_past_a_ticks_record_are_refused_before_the_live_world() {
    let mut w = W::new();
    let (_, cr, _) = w.furnish();
    sim::commit::open_room(ROOM);
    let set = |n: u8| Op::Set {
        node: Ref::Node(cr),
        field: FIELD,
        to: Value::Bytes(vec![n; ROOM / 3]),
    };
    let mut n = 0u8;
    let (r, before) = loop {
        n += 1;
        let before = (
            w.log_hash(),
            state_hash(w.live.tree()).expect("a hash"),
            w.live.version(),
        );
        match w.edit(w.creator(), w.live.version(), vec![set(n)]) {
            Ok(_) => assert!(n < 8, "a tick's room is bounded"),
            Err(r) => break (r, before),
        }
    };
    assert_eq!(r.name, "part.too-large", "{r:?}");
    assert!(n > 1, "the first batch fits");
    let after = (
        w.log_hash(),
        state_hash(w.live.tree()).expect("a hash"),
        w.live.version(),
    );
    assert_eq!(after, before, "nothing reached the log or the live world");
    sim::commit::open_room(ROOM);
    w.edit(w.creator(), w.live.version(), vec![set(n)])
        .expect("the next tick takes it");
    w.close();
}

// --- A5: planned against an older version ---------------------------------------------------------------------------

#[test]
fn a5_an_older_plan_commits_unless_a_node_it_touches_changed() {
    let mut w = W::new();
    let (room, cr, key) = w.furnish();
    let planned = w.live.version();
    let set = |n: Id, to: u64| Op::Set {
        node: Ref::Node(n),
        field: FIELD,
        to: Value::Uint(to),
    };
    // Both checked on the copy at `planned`; then the crate changes.
    let copy = w.live.frozen();
    let checked = |ops: Vec<Op>, w: &mut W| {
        check(
            Edit {
                claim: None,
                intent: w.intents.mint().expect("an id"),
                actor: w.creator(),
                planned,
                ops,
            },
            &copy,
            &w.world,
        )
        .and_then(|c| plan(c, &copy, None))
        .expect("checked")
    };
    let untouched = checked(
        vec![
            set(room, 1),
            place(
                0,
                &kind(&w.header.clone(), "souls:key"),
                Ref::Node(room),
                spot(1, None),
            ),
        ],
        &mut w,
    );
    let beside = checked(vec![set(key, 2)], &mut w);
    w.edit(w.creator(), planned, vec![set(cr, 5)])
        .expect("committed");
    assert!(w.live.version() > planned);
    // Planned against the older version, touching nothing that changed since: committed.
    w.commit(&untouched).expect("committed");
    // The key sits in the crate, but only the crate changed: the key is untouched, so this commits too.
    w.commit(&beside).expect("committed");
    // Planned at `planned` again, now touching the crate, which changed after it: refused at commit. A place's parent
    // (the room, changed since) need only still be there.
    let log = w.log_hash();
    let h = w.header.clone();
    let stale = checked(
        vec![
            place(1, &kind(&h, "souls:key"), Ref::Node(room), spot(2, None)),
            set(cr, 3),
        ],
        &mut w,
    );
    let r = w.commit(&stale).expect_err("refused");
    assert_eq!((r.op, r.name), (Some(1), "edit.stale"), "{r:?}");
    assert_eq!(w.log_hash(), log);
    // And refused the same way when checked on a newer copy.
    let r = w
        .edit(w.creator(), planned, vec![set(cr, 4)])
        .expect_err("refused");
    assert_eq!((r.op, r.name), (Some(0), "edit.stale"));
    w.close();
}

// --- #3280: the safety rule through the edit path ------------------------------------------------------------------

#[test]
fn an_edit_unsafe_for_a_soul_on_its_commit_tick_is_refused_by_name_with_nothing_written() {
    let mut w = W::new();
    let (_, cr, _) = w.furnish();
    let (log, state, version) = (
        w.log_hash(),
        state_hash(w.live.tree()).expect("a hash"),
        w.live.version(),
    );
    // A Soul sits in the crate's slot 1 when the removal's tick comes: refused by name, nothing written.
    let soul = Id::new(Scope([0x50; 16]), 1).expect("an id");
    w.bodies = vec![Who {
        soul,
        body: Id::new(Scope([0x50; 16]), 2).expect("an id"),
        pose: Pose {
            frame: Frame {
                node: cr,
                slot: Some(1),
            },
            position: Vec3::ZERO,
            orientation: Quat::IDENTITY,
            support: Support::Slot,
        },
        has: 0,
        crossing: None,
    }];
    let remove = vec![Op::Remove {
        node: Ref::Node(cr),
    }];
    let r = w
        .edit(w.creator(), version, remove.clone())
        .expect_err("refused");
    println!("{}: {}", r.name, r.detail);
    assert_eq!((r.op, r.name), (None, "edit.in-use"), "{r:?}");
    assert!(r.detail.contains("Soul 50:1 is in"), "{}", r.detail);
    assert_eq!(w.log_hash(), log);
    assert_eq!(state_hash(w.live.tree()).expect("a hash"), state);
    assert_eq!(w.live.version(), version);
    // Once the Soul has got up, the same edit commits.
    w.bodies.clear();
    w.edit(w.creator(), version, remove).expect("committed");
    w.close();
}

// --- #3701: district plans and build claims --------------------------------------------------------------------------

fn text(t: &str) -> Value {
    Value::Text(Name::new(t).expect("a name"))
}

fn mm(n: i64) -> Value {
    if n >= 0 {
        Value::Uint(n.unsigned_abs())
    } else {
        Value::Nint(n.unsigned_abs() - 1)
    }
}

fn claim_row(id: &str, part: &str, area: [i64; 4]) -> Value {
    let mut row = vec![text(id), text(part)];
    row.extend(area.map(mm));
    Value::Array(row)
}

fn set_root(root: Id, field: u64, to: Value) -> Op {
    Op::Set {
        node: Ref::Node(root),
        field,
        to,
    }
}

#[test]
fn a2_an_edit_under_a_claim_stays_inside_it_and_others_stay_out() {
    use replica::edit::claims::F_CLAIMS;
    let mut w = W::new();
    let room = w
        .live
        .header()
        .kinds
        .iter()
        .find(|k| k.as_str().starts_with("souls:room@"))
        .cloned()
        .expect("room");
    // The lead claims x 0..10 mm, z -10..10 mm for the house; a room inside it is placed under the claim.
    let v = w.live.version();
    let claims = Value::Array(vec![claim_row("c:house", "part:house", [0, -10, 10, 10])]);
    w.edit(w.creator(), v, vec![set_root(w.root, F_CLAIMS, claims)])
        .expect("claimed");
    let v = w.live.version();
    let inside = w
        .edit_under(
            w.creator(),
            v,
            vec![place(1, &room, Ref::Node(w.root), spot(5_000, None))],
            Some("c:house"),
        )
        .expect("inside the claim");
    let built = inside.names[&1];
    // Under the claim, outside its area: refused by name, the operation and the claim named.
    let v = w.live.version();
    let log = w.log_hash();
    let r = w
        .edit_under(
            w.creator(),
            v,
            vec![place(1, &room, Ref::Node(w.root), spot(20_000, None))],
            Some("c:house"),
        )
        .expect_err("outside");
    assert_eq!((r.op, r.name), (Some(0), "edit.outside-claim"), "{r:?}");
    assert!(r.detail.contains("c:house (part:house)"), "{}", r.detail);
    // Moving the claimed room out, and writing the world's own fields, are outside too.
    let r = w
        .edit_under(
            w.creator(),
            v,
            vec![Op::Move {
                node: Ref::Node(built),
                at: spot(20_000, None),
            }],
            Some("c:house"),
        )
        .expect_err("moved out");
    assert_eq!(r.name, "edit.outside-claim");
    let r = w
        .edit_under(
            w.creator(),
            v,
            vec![set_root(w.root, F_CLAIMS, Value::Array(vec![]))],
            Some("c:house"),
        )
        .expect_err("the root");
    assert_eq!(r.name, "edit.outside-claim");
    // Under no claim, inside one: refused; a claim that is not live: refused.
    let r = w
        .edit(
            w.creator(),
            v,
            vec![Op::Remove {
                node: Ref::Node(built),
            }],
        )
        .expect_err("claimed");
    assert_eq!((r.op, r.name), (Some(0), "edit.claimed"), "{r:?}");
    let r = w
        .edit(
            w.creator(),
            v,
            vec![place(1, &room, Ref::Node(w.root), spot(9_000, None))],
        )
        .expect_err("placed into a claim");
    assert_eq!(r.name, "edit.claimed");
    let r = w
        .edit_under(
            w.creator(),
            v,
            vec![place(1, &room, Ref::Node(w.root), spot(5_000, None))],
            Some("c:gone"),
        )
        .expect_err("unknown");
    assert_eq!((r.op, r.name), (None, "edit.claim-unknown"));
    assert_eq!(w.log_hash(), log, "refusals write nothing");
    // Outside every claim the lead edits freely; once released, inside too.
    w.edit(
        w.creator(),
        v,
        vec![place(1, &room, Ref::Node(w.root), spot(30_000, None))],
    )
    .expect("outside");
    let v = w.live.version();
    w.edit(
        w.creator(),
        v,
        vec![set_root(w.root, F_CLAIMS, Value::Array(vec![]))],
    )
    .expect("released");
    let v = w.live.version();
    w.edit(
        w.creator(),
        v,
        vec![Op::Remove {
            node: Ref::Node(built),
        }],
    )
    .expect("released, so free");
    // Another actor is still nobody, claim or not.
    let other = Actor::Creator(Id::new(Scope([0xd0; 16]), 1).expect("an id"));
    let r = w
        .edit_under(
            other,
            v,
            vec![place(1, &room, Ref::Node(w.root), spot(5_000, None))],
            Some("c:house"),
        )
        .expect_err("not the creator");
    assert_eq!(r.name, "edit.not-the-creator");
    w.close();
}

#[test]
fn a2_a_move_carries_every_node_below_it_and_a_late_claim_still_binds() {
    use replica::edit::claims::F_CLAIMS;
    let mut w = W::new();
    let room = kind(&w.header, "souls:room");
    let crate_ = kind(&w.header, "souls:crate");
    // A room at x -30 mm with a crate 20 mm along it: the crate stands inside the claim's x 0..10 mm once the room
    // moves to x -15 mm, though the room's own origin stays outside.
    let v = w.live.version();
    let built = w
        .edit(
            w.creator(),
            v,
            vec![
                place(1, &room, Ref::Node(w.root), spot(-30_000, None)),
                place(2, &crate_, Ref::New(1), spot(20_000, None)),
            ],
        )
        .expect("built");
    let (room_id, crate_id) = (built.names[&1], built.names[&2]);
    let v = w.live.version();
    let claims = Value::Array(vec![claim_row("c:house", "part:house", [0, -10, 10, 10])]);
    w.edit(w.creator(), v, vec![set_root(w.root, F_CLAIMS, claims)])
        .expect("claimed");
    let v = w.live.version();
    let r = w
        .edit(
            w.creator(),
            v,
            vec![Op::Move {
                node: Ref::Node(room_id),
                at: spot(-15_000, None),
            }],
        )
        .expect_err("the crate moves into the claim");
    assert_eq!((r.op, r.name), (Some(0), "edit.claimed"), "{r:?}");
    // Under the claim, the same move takes the room's own origin, outside it, along.
    let r = w
        .edit_under(
            w.creator(),
            v,
            vec![Op::Move {
                node: Ref::Node(room_id),
                at: spot(-15_000, None),
            }],
            Some("c:house"),
        )
        .expect_err("the room stays outside");
    assert_eq!(r.name, "edit.outside-claim");
    // A move that keeps everything outside passes.
    w.edit(
        w.creator(),
        v,
        vec![Op::Move {
            node: Ref::Node(room_id),
            at: spot(-40_000, None),
        }],
    )
    .expect("all outside");
    // An edit checked before a claim commits, committed after it: the claim binds at commit.
    let v = w.live.version();
    let copy = w.live.frozen();
    let checked = check(
        Edit {
            claim: None,
            intent: w.intents.mint().expect("an id"),
            actor: w.creator(),
            planned: v,
            ops: vec![Op::Remove {
                node: Ref::Node(crate_id),
            }],
        },
        &copy,
        &w.world,
    )
    .expect("checked before the claim");
    let planned = plan(checked, &copy, None).expect("planned");
    let claims = Value::Array(vec![claim_row("c:yard", "part:yard", [-100, -10, -1, 10])]);
    w.edit(w.creator(), v, vec![set_root(w.root, F_CLAIMS, claims)])
        .expect("claimed since");
    let r = w.commit(&planned).expect_err("the late claim binds");
    assert_eq!(r.name, "edit.claimed", "{r:?}");
    w.close();
}

#[test]
fn a3727_a_helper_builds_only_under_its_own_claim_and_an_undo_stays_out_of_claims() {
    use replica::edit::claims::{F_CLAIMS, judge_effects};
    let mut w = W::new();
    let room = kind(&w.header, "souls:room");
    let helper = Id::new(Scope([0xc0; 16]), (1 << 44) + 7).expect("an id");
    let stranger = Id::new(Scope([0xc0; 16]), (1 << 44) + 8).expect("an id");
    let name = |h: Id| {
        text(&format!(
            "helper:h{}-{}",
            replica::encode::to_hex(&h.scope().0),
            h.counter()
        ))
    };
    // A room the lead places at x 5 mm, before any claim: its creation is what a redo would write again.
    let v = w.live.version();
    let lead = w
        .edit(
            w.creator(),
            v,
            vec![place(1, &room, Ref::Node(w.root), spot(5_000, None))],
        )
        .expect("the lead's room");
    let mut row = match claim_row("c:house", "part:house", [0, -10, 10, 10]) {
        Value::Array(r) => r,
        _ => unreachable!(),
    };
    row.push(name(helper));
    let v = w.live.version();
    w.edit(
        w.creator(),
        v,
        vec![set_root(
            w.root,
            F_CLAIMS,
            Value::Array(vec![Value::Array(row)]),
        )],
    )
    .expect("claimed with a helper");
    let v = w.live.version();
    let as_ = |h: Id| Actor::Creator(h);
    // The helper, under its claim, inside: built.
    w.edit_under(
        as_(helper),
        v,
        vec![place(1, &room, Ref::Node(w.root), spot(6_000, None))],
        Some("c:house"),
    )
    .expect("the helper builds inside its claim");
    let v = w.live.version();
    // Outside its area: refused by the claim check; with no claim, or as a stranger: not an editor at all.
    let r = w
        .edit_under(
            as_(helper),
            v,
            vec![place(1, &room, Ref::Node(w.root), spot(20_000, None))],
            Some("c:house"),
        )
        .expect_err("outside");
    assert_eq!(r.name, "edit.outside-claim", "{r:?}");
    let r = w
        .edit(
            as_(helper),
            v,
            vec![place(1, &room, Ref::Node(w.root), spot(30_000, None))],
        )
        .expect_err("no claim");
    assert_eq!(r.name, "edit.not-the-creator", "{r:?}");
    let r = w
        .edit_under(
            as_(stranger),
            v,
            vec![place(1, &room, Ref::Node(w.root), spot(6_000, None))],
            Some("c:house"),
        )
        .expect_err("another helper");
    assert_eq!(r.name, "edit.not-the-creator", "{r:?}");
    // The lead's undo or redo may not write inside a live claim: the room's creation again, at x 5 mm, is refused.
    let r = judge_effects(&w.live, &lead.part.effects).expect_err("inside a claim");
    assert_eq!(r.name, "edit.claimed", "{r:?}");
    // Malformed helpers are refused with the claim list.
    let mut bad = match claim_row("c:yard", "part:yard", [20, -10, 30, 10]) {
        Value::Array(r) => r,
        _ => unreachable!(),
    };
    bad.push(text("helper:hnot-hex"));
    let r = w
        .edit(
            w.creator(),
            v,
            vec![set_root(
                w.root,
                F_CLAIMS,
                Value::Array(vec![Value::Array(bad)]),
            )],
        )
        .expect_err("a bad helper");
    assert_eq!(r.name, "edit.claim-malformed");
    w.close();
}

fn points(list: &[[i64; 2]]) -> Value {
    Value::Array(
        list.iter()
            .map(|p| Value::Array(vec![mm(p[0]), mm(p[1])]))
            .collect(),
    )
}

/// A road at its parent's origin, as the creator's `place --path` lays one (#3962): its line (field 16) and the
/// ribbon outline (field 11) of a line along x, `width` mm wide, all in mm.
fn road(name: u64, kind: &Name, parent: Ref, line: &[[i64; 2]], width: i64) -> Op {
    let h = width / 2;
    let left = line.iter().map(|p| [p[0], p[1] + h]);
    let right = line.iter().rev().map(|p| [p[0], p[1] - h]);
    Op::Place {
        name,
        kind: kind.clone(),
        parent,
        at: spot(0, None),
        audience: Audience::Everyone,
        fields: BTreeMap::from([
            (11, points(&left.chain(right).collect::<Vec<_>>())),
            (16, points(line)),
        ]),
    }
}

#[test]
fn a3962_a_shape_is_judged_by_its_outline_and_line_not_its_origin() {
    use replica::edit::claims::{F_CLAIMS, judge_effects};
    let mut w = W::new();
    let room = kind(&w.header, "souls:room");
    let helper = Id::new(Scope([0xc0; 16]), (1 << 44) + 7).expect("an id");
    let as_helper = Actor::Creator(helper);
    // Before any claim, the lead lays a road at the ground's origin, x 120..180 mm along z 30 mm.
    let v = w.live.version();
    let lead = w
        .edit(
            w.creator(),
            v,
            vec![road(
                1,
                &room,
                Ref::Node(w.root),
                &[[120, 30], [180, 30]],
                4,
            )],
        )
        .expect("the lead's road");
    let built = lead.names[&1];
    // The lead's yard (x 100..200, z -10..10 mm) and the helper's house (x 100..200, z 20..40 mm): neither holds the
    // origin, where every shape stands.
    let yard = claim_row("c:yard", "part:yard", [100, -10, 200, 10]);
    let mut house = match claim_row("c:house", "part:house", [100, 20, 200, 40]) {
        Value::Array(r) => r,
        _ => unreachable!(),
    };
    house.push(text(&format!(
        "helper:h{}-{}",
        replica::encode::to_hex(&helper.scope().0),
        helper.counter()
    )));
    let v = w.live.version();
    w.edit(
        w.creator(),
        v,
        vec![set_root(
            w.root,
            F_CLAIMS,
            Value::Array(vec![yard, Value::Array(house)]),
        )],
    )
    .expect("claimed");
    let v = w.live.version();
    // A road across the yard, under no claim: its middle point is inside, so it is refused.
    let r = w
        .edit(
            w.creator(),
            v,
            vec![road(
                1,
                &room,
                Ref::Node(w.root),
                &[[50, 0], [150, 0], [250, 0]],
                4,
            )],
        )
        .expect_err("across the yard");
    assert_eq!((r.op, r.name), (Some(0), "edit.claimed"), "{r:?}");
    // The helper's road inside its own claim is built; one that leaves it is not.
    w.edit_under(
        as_helper,
        v,
        vec![road(
            1,
            &room,
            Ref::Node(w.root),
            &[[110, 25], [190, 25]],
            4,
        )],
        Some("c:house"),
    )
    .expect("the helper's road inside its claim");
    let v = w.live.version();
    let r = w
        .edit_under(
            as_helper,
            v,
            vec![road(
                1,
                &room,
                Ref::Node(w.root),
                &[[150, 30], [250, 30]],
                4,
            )],
            Some("c:house"),
        )
        .expect_err("out of its claim");
    assert_eq!((r.op, r.name), (Some(0), "edit.outside-claim"), "{r:?}");
    // The lead's road now lies in the house claim: the lead may not move, remove or reshape it under no claim.
    for op in [
        Op::Move {
            node: Ref::Node(built),
            at: spot(5_000, None),
        },
        Op::Remove {
            node: Ref::Node(built),
        },
        Op::Set {
            node: Ref::Node(built),
            field: 16,
            to: points(&[[120, 30], [170, 30]]),
        },
    ] {
        let r = w.edit(w.creator(), v, vec![op]).expect_err("in the house");
        assert_eq!((r.op, r.name), (Some(0), "edit.claimed"), "{r:?}");
    }
    // An undo or redo that lays it again is refused too.
    let r = judge_effects(&w.live, &lead.part.effects).expect_err("in the house");
    assert_eq!(r.name, "edit.claimed", "{r:?}");
    // The helper moves it 10 mm along, inside; 60 mm takes its far end out (x 180..240 mm); then removes it.
    w.edit_under(
        as_helper,
        v,
        vec![Op::Move {
            node: Ref::Node(built),
            at: spot(10_000, None),
        }],
        Some("c:house"),
    )
    .expect("moved inside");
    let v = w.live.version();
    let r = w
        .edit_under(
            as_helper,
            v,
            vec![Op::Move {
                node: Ref::Node(built),
                at: spot(60_000, None),
            }],
            Some("c:house"),
        )
        .expect_err("moved out");
    assert_eq!((r.op, r.name), (Some(0), "edit.outside-claim"), "{r:?}");
    w.edit_under(
        as_helper,
        v,
        vec![Op::Remove {
            node: Ref::Node(built),
        }],
        Some("c:house"),
    )
    .expect("the helper removes it");
    w.close();
}

#[test]
fn a3728_a_link_is_judged_at_both_ends_and_its_door() {
    use replica::edit::claims::{F_CLAIMS, judge_effects};
    use replica::world_model::End;
    let mut w = W::new();
    let room = kind(&w.header, "souls:room");
    let helper = Id::new(Scope([0xc0; 16]), (1 << 44) + 9).expect("an id");
    let link = |name: u64, ends: [Id; 2], owner: End, door: Option<Id>| Op::Link {
        name,
        ty: Name::new("eden:stairs").expect("a name"),
        ends: ends.map(Ref::Node),
        owner,
        field: 21,
        row: vec![Value::Uint(1)],
        door: door.map(Ref::Node),
    };
    // Two rooms at x 3 and 7 mm (inside the claim to come), two at x 30 and 40 mm (outside it), and a link the lead
    // makes from the first, before any claim: what an undo of it, or a redo, would write.
    let v = w.live.version();
    let built = w
        .edit(
            w.creator(),
            v,
            vec![
                place(1, &room, Ref::Node(w.root), spot(3_000, None)),
                place(2, &room, Ref::Node(w.root), spot(7_000, None)),
                place(3, &room, Ref::Node(w.root), spot(30_000, None)),
                place(4, &room, Ref::Node(w.root), spot(40_000, None)),
                place(5, &room, Ref::Node(w.root), spot(50_000, None)),
            ],
        )
        .expect("built");
    let [a, b, c, d, e] = [1, 2, 3, 4, 5].map(|n| built.names[&n]);
    let v = w.live.version();
    let lead = w
        .edit(w.creator(), v, vec![link(1, [a, c], End::First, None)])
        .expect("the lead's link, before the claim");
    let v = w.live.version();
    let far = w
        .edit(w.creator(), v, vec![link(1, [d, b], End::First, None)])
        .expect("the lead's link owned outside the claim to come, before it");
    let mut row = match claim_row("c:house", "part:house", [0, -10, 10, 10]) {
        Value::Array(r) => r,
        _ => unreachable!(),
    };
    row.push(text(&format!(
        "helper:h{}-{}",
        replica::encode::to_hex(&helper.scope().0),
        helper.counter()
    )));
    let v = w.live.version();
    w.edit(
        w.creator(),
        v,
        vec![set_root(
            w.root,
            F_CLAIMS,
            Value::Array(vec![Value::Array(row)]),
        )],
    )
    .expect("claimed with a helper");
    let v = w.live.version();
    let log = w.log_hash();
    // Under no claim: a link owned inside the claim, whose far end is inside it, or whose door is inside it, is
    // refused; one outside it is not.
    let r = w
        .edit(w.creator(), v, vec![link(1, [a, c], End::First, None)])
        .expect_err("owned inside the claim");
    assert_eq!((r.op, r.name), (Some(0), "edit.claimed"), "{r:?}");
    let r = w
        .edit(w.creator(), v, vec![link(1, [c, a], End::Second, None)])
        .expect_err("owned by its second end, inside the claim");
    assert_eq!(r.name, "edit.claimed", "{r:?}");
    let r = w
        .edit(w.creator(), v, vec![link(1, [c, a], End::First, None)])
        .expect_err("owned outside the claim, its far end inside it");
    assert_eq!((r.op, r.name), (Some(0), "edit.claimed"), "{r:?}");
    let r = w
        .edit(w.creator(), v, vec![link(1, [c, d], End::First, Some(b))])
        .expect_err("its door inside the claim");
    assert_eq!(r.name, "edit.claimed", "{r:?}");
    // Under the claim, by its helper: a link owned outside it, or with its door outside it, is refused.
    let as_helper = Actor::Creator(helper);
    let r = w
        .edit_under(
            as_helper,
            v,
            vec![link(1, [c, a], End::First, None)],
            Some("c:house"),
        )
        .expect_err("owned outside the claim");
    assert_eq!((r.op, r.name), (Some(0), "edit.outside-claim"), "{r:?}");
    let r = w
        .edit_under(
            as_helper,
            v,
            vec![link(1, [a, c], End::First, None)],
            Some("c:house"),
        )
        .expect_err("owned inside the claim, its far end outside it");
    assert_eq!((r.op, r.name), (Some(0), "edit.outside-claim"), "{r:?}");
    let r = w
        .edit_under(
            as_helper,
            v,
            vec![link(1, [a, b], End::First, Some(e))],
            Some("c:house"),
        )
        .expect_err("its door outside the claim");
    assert_eq!(r.name, "edit.outside-claim", "{r:?}");
    // A doorway link, or a link with a door, owned by its second end is refused: its row is read at its first end.
    let doorway = Op::Link {
        name: 1,
        ty: Name::new("eden:doorway").expect("a name"),
        ends: [c, d].map(Ref::Node),
        owner: End::Second,
        field: 22,
        row: vec![Value::Uint(1)],
        door: None,
    };
    let r = w
        .edit(w.creator(), v, vec![doorway])
        .expect_err("a doorway owned by its second end");
    assert_eq!((r.op, r.name), (Some(0), "edit.link"), "{r:?}");
    let r = w
        .edit(w.creator(), v, vec![link(1, [c, d], End::Second, Some(e))])
        .expect_err("a link with a door, owned by its second end");
    assert_eq!((r.op, r.name), (Some(0), "edit.link"), "{r:?}");
    // A doorway link owned by its first end still writes a row of at least 5 values to field 22, where it is read.
    let first = |field: u64, row: Vec<Value>| Op::Link {
        name: 1,
        ty: Name::new("eden:doorway").expect("a name"),
        ends: [c, d].map(Ref::Node),
        owner: End::First,
        field,
        row,
        door: None,
    };
    let r = w
        .edit(w.creator(), v, vec![first(21, vec![Value::Uint(1); 6])])
        .expect_err("a doorway's row in another field");
    assert_eq!((r.op, r.name), (Some(0), "edit.link"), "{r:?}");
    let r = w
        .edit(w.creator(), v, vec![first(22, vec![Value::Uint(1)])])
        .expect_err("a doorway's row too short to read");
    assert_eq!((r.op, r.name), (Some(0), "edit.link"), "{r:?}");
    assert_eq!(w.log_hash(), log, "refusals write nothing");
    // The lead links outside every claim, and the helper inside its own.
    w.edit(w.creator(), v, vec![link(1, [c, d], End::First, Some(e))])
        .expect("outside every claim");
    let v = w.live.version();
    w.edit_under(
        as_helper,
        v,
        vec![link(1, [a, b], End::First, None)],
        Some("c:house"),
    )
    .expect("the helper links inside its claim");
    // The lead's link written again (a redo) now lands inside the claim: refused, as an undo's would be.
    let r = judge_effects(&w.live, &lead.part.effects).expect_err("inside a claim");
    assert_eq!(r.name, "edit.claimed", "{r:?}");
    // So is one owned outside it whose far end is inside it.
    let r = judge_effects(&w.live, &far.part.effects).expect_err("its far end inside a claim");
    assert_eq!(r.name, "edit.claimed", "{r:?}");
    w.close();
}

#[test]
fn a3728_a_rows_edit_is_judged_as_a_set_of_its_field() {
    use replica::edit::claims::F_CLAIMS;
    let mut w = W::new();
    let room = kind(&w.header, "souls:room");
    let pair = |k: u64| Value::Array(vec![Value::Uint(k), Value::Uint(0)]);
    // A room at x 5 mm with a field of rows, then a claim over it.
    let v = w.live.version();
    let built = w
        .edit(
            w.creator(),
            v,
            vec![place(1, &room, Ref::Node(w.root), spot(5_000, None))],
        )
        .expect("built");
    let inside = built.names[&1];
    let v = w.live.version();
    w.edit(
        w.creator(),
        v,
        vec![Op::Set {
            node: Ref::Node(inside),
            field: 90,
            to: Value::Array(vec![pair(1)]),
        }],
    )
    .expect("a field of rows");
    let v = w.live.version();
    let claims = Value::Array(vec![claim_row("c:house", "part:house", [0, -10, 10, 10])]);
    w.edit(w.creator(), v, vec![set_root(w.root, F_CLAIMS, claims)])
        .expect("claimed");
    let v = w.live.version();
    let log = w.log_hash();
    // Rows into a node inside the claim, under no claim: refused as its set would be.
    let r = w
        .edit(
            w.creator(),
            v,
            vec![Op::Rows {
                node: Ref::Node(inside),
                field: 90,
                rows: vec![pair(2)],
            }],
        )
        .expect_err("inside a claim");
    assert_eq!((r.op, r.name), (Some(0), "edit.claimed"), "{r:?}");
    // Rows into the claim list: what they would make is read as claims, so an overlap is refused by name.
    let r = w
        .edit(
            w.creator(),
            v,
            vec![Op::Rows {
                node: Ref::Node(w.root),
                field: F_CLAIMS,
                rows: vec![claim_row("c:yard", "part:yard", [5, -10, 20, 10])],
            }],
        )
        .expect_err("an overlapping claim");
    assert_eq!((r.op, r.name), (Some(0), "edit.claim-malformed"), "{r:?}");
    // Under the claim, rows into the world's own fields are the lead's.
    let r = w
        .edit_under(
            w.creator(),
            v,
            vec![Op::Rows {
                node: Ref::Node(w.root),
                field: F_CLAIMS,
                rows: vec![claim_row("c:yard", "part:yard", [20, -10, 30, 10])],
            }],
            Some("c:house"),
        )
        .expect_err("the root under a claim");
    assert_eq!(r.name, "edit.outside-claim", "{r:?}");
    assert_eq!(w.log_hash(), log, "refusals write nothing");
    // A well-formed claim added as a row commits.
    w.edit(
        w.creator(),
        v,
        vec![Op::Rows {
            node: Ref::Node(w.root),
            field: F_CLAIMS,
            rows: vec![claim_row("c:yard", "part:yard", [20, -10, 30, 10])],
        }],
    )
    .expect("a second claim, as a row");
    w.close();
}

#[test]
fn a1_a2_plans_and_claims_are_checked_before_they_are_recorded() {
    use replica::edit::claims::{F_CLAIMS, F_DISTRICTS};
    let mut w = W::new();
    let v = w.live.version();
    let plot = |id: &str, x: i64| {
        Value::Array(vec![
            text(id),
            mm(x),
            mm(0),
            mm(20_000),
            mm(15_000),
            mm(0),
            text("use:bakery"),
        ])
    };
    let road = Value::Array(vec![
        text("road:main"),
        mm(6_000),
        Value::Array(vec![mm(-50_000), mm(-20_000), mm(50_000), mm(-20_000)]),
    ]);
    let plan = |plots: Vec<Value>, chapters: Vec<Value>| {
        Value::Array(vec![Value::Array(vec![
            text("d:market"),
            text("title:market-quarter"),
            Value::Array(plots),
            Value::Array(vec![road.clone()]),
            Value::Array(chapters),
        ])])
    };
    let good = plan(
        vec![plot("p:a", 0), plot("p:b", 30_000)],
        vec![
            Value::Array(vec![text("p:a")]),
            Value::Array(vec![text("p:b")]),
        ],
    );
    w.edit(w.creator(), v, vec![set_root(w.root, F_DISTRICTS, good)])
        .expect("recorded");
    let v = w.live.version();
    for (bad, why) in [
        (
            plan(vec![plot("p:a", 0), plot("p:a", 30_000)], vec![]),
            "twice",
        ),
        (plan(vec![], vec![]), "no plots"),
        (
            plan(vec![plot("p:a", 0)], vec![Value::Array(vec![text("p:z")])]),
            "unknown",
        ),
    ] {
        let r = w
            .edit(w.creator(), v, vec![set_root(w.root, F_DISTRICTS, bad)])
            .expect_err("malformed");
        assert_eq!(r.name, "edit.district-malformed", "{r:?}");
        assert!(r.detail.contains(why), "{}", r.detail);
    }
    let overlap = Value::Array(vec![
        claim_row("c:1", "part:north", [0, 0, 10, 10]),
        claim_row("c:2", "part:south", [5, 5, 20, 20]),
    ]);
    let r = w
        .edit(w.creator(), v, vec![set_root(w.root, F_CLAIMS, overlap)])
        .expect_err("overlap");
    assert_eq!((r.op, r.name), (Some(0), "edit.claim-malformed"), "{r:?}");
    let nine = Value::Array(
        (0..9)
            .map(|i| claim_row(&format!("c:n{i}"), "part:p", [i * 10, 0, i * 10 + 5, 5]))
            .collect(),
    );
    let r = w
        .edit(w.creator(), v, vec![set_root(w.root, F_CLAIMS, nine)])
        .expect_err("nine");
    assert_eq!(r.name, "edit.claim-malformed");
    w.close();
}

// --- #3700: owner and access marks, and land-use zones ---------------------------------------------------------------

#[test]
fn a1_a_private_mark_is_its_owners_alone_and_passes_down_to_what_is_inside() {
    use replica::who_may::{F_ACCESS, F_OWNER};
    let mut w = W::new();
    let (room, cr, _) = w.furnish();
    let owner = Id::new(Scope([0x50; 16]), 7).expect("an id");
    let other = Id::new(Scope([0x50; 16]), 8).expect("an id");
    let entry =
        replica::rules::json::parse(r#"{"forms": {"open": {"who": "anyone"}}}"#).expect("JSON");
    let may = |w: &W, body: Id, node: Id| {
        sim::forms::may(
            w.live.tree(),
            &BTreeMap::new(),
            &|_| None,
            body,
            node,
            &entry,
            "open",
        )
    };
    // Unmarked: anyone may, as before.
    assert!(may(&w, other, cr).is_ok());
    // The room is the owner's and private: the crate in it is too.
    let v = w.live.version();
    w.edit(
        w.creator(),
        v,
        vec![
            Op::Set {
                node: Ref::Node(room),
                field: F_OWNER,
                to: owner.to_value(),
            },
            Op::Set {
                node: Ref::Node(room),
                field: F_ACCESS,
                to: Value::Uint(2),
            },
        ],
    )
    .expect("marked");
    assert!(may(&w, owner, cr).is_ok(), "the owner may");
    let r = may(&w, other, cr).expect_err("private");
    assert_eq!(r.name, "object.private");
    assert!(r.detail.contains("private"), "{}", r.detail);
    // Its own public mark wins over the room's.
    let v = w.live.version();
    w.edit(
        w.creator(),
        v,
        vec![Op::Set {
            node: Ref::Node(cr),
            field: F_ACCESS,
            to: Value::Uint(1),
        }],
    )
    .expect("public");
    assert!(may(&w, other, cr).is_ok());
    // The god's private thing refuses every Soul; a group has no members.
    let v = w.live.version();
    w.edit(
        w.creator(),
        v,
        vec![
            Op::Set {
                node: Ref::Node(cr),
                field: F_ACCESS,
                to: Value::Uint(2),
            },
            Op::Set {
                node: Ref::Node(cr),
                field: F_OWNER,
                to: text("owner:god"),
            },
        ],
    )
    .expect("the god's");
    assert_eq!(
        may(&w, owner, cr).expect_err("private").name,
        "object.private"
    );
    // Marks that do not read are refused, and nothing is written.
    let v = w.live.version();
    let log = w.log_hash();
    for (field, to) in [
        (F_ACCESS, Value::Uint(3)),
        (F_OWNER, text("souls:bob")),
        (F_OWNER, Value::Uint(4)),
    ] {
        let r = w
            .edit(
                w.creator(),
                v,
                vec![Op::Set {
                    node: Ref::Node(cr),
                    field,
                    to,
                }],
            )
            .expect_err("malformed");
        assert_eq!((r.op, r.name), (Some(0), "edit.owner-malformed"), "{r:?}");
    }
    assert_eq!(w.log_hash(), log);
    // None again: anyone may.
    w.edit(
        w.creator(),
        v,
        vec![
            Op::Set {
                node: Ref::Node(cr),
                field: F_ACCESS,
                to: Value::Uint(0),
            },
            Op::Set {
                node: Ref::Node(cr),
                field: F_OWNER,
                to: Value::Uint(0),
            },
            Op::Set {
                node: Ref::Node(room),
                field: F_ACCESS,
                to: Value::Uint(0),
            },
        ],
    )
    .expect("cleared");
    assert!(may(&w, other, cr).is_ok());
    w.close();
}

// --- 0.134 R4: a creator's tint ---------------------------------------------------------------------------------

/// A tint of rows `[part, rgb]`.
fn tint(rows: &[(&str, u64)]) -> Value {
    Value::Array(
        rows.iter()
            .map(|(p, c)| Value::Array(vec![text(p), Value::Uint(*c)]))
            .collect(),
    )
}

/// The tint a node holds, if any.
fn tint_of(live: &Replica, id: Id) -> Option<Value> {
    let Some(Value::Map(n)) = live.node(id) else {
        panic!("the node")
    };
    let Some(Value::Map(fields)) = n.get(&6) else {
        return None;
    };
    fields.get(&replica::tint::F_TINT).cloned()
}

/// R4: the creator's recolour of a thing and of one part commits as one set each, seen by the client's replica, the
/// public stream and the log (`W::edit` compares all three); anyone else's is refused by name, and so is a tint that
/// does not read, with nothing written; the log read back from the disk, as a restart reads it, holds the tint.
#[test]
fn r4_a_recolour_is_the_creators_alone_logged_streamed_and_kept_across_a_restart() {
    use replica::tint::F_TINT;
    let mut w = W::new();
    let (room, cr, _) = w.furnish();
    assert_eq!(tint_of(&w.live, cr), None, "an old thing has no tint");
    let set = |to: Value| Op::Set {
        node: Ref::Node(cr),
        field: F_TINT,
        to,
    };
    let v = w.live.version();
    w.edit(w.creator(), v, vec![set(tint(&[("tint:whole", 0xff0000)]))])
        .expect("the creator recolours the crate");
    let seat = tint(&[("tint:whole", 0xff0000), ("part:seat", 0x0000ff)]);
    let v = w.live.version();
    w.edit(w.creator(), v, vec![set(seat.clone())])
        .expect("and its seat");
    assert_eq!(tint_of(&w.live, cr), Some(seat.clone()));
    assert_eq!(
        tint_of(&w.client, cr),
        Some(seat.clone()),
        "the client's copy"
    );

    let log = w.log_hash();
    let v = w.live.version();
    let other = Id::new(Scope([0xc0; 16]), 2).expect("an id");
    for actor in [Actor::Creator(other), Actor::Soul(other), Actor::World] {
        let r = w
            .edit(actor, v, vec![set(tint(&[("tint:whole", 0x00ff00)]))])
            .expect_err("not the creator");
        assert_eq!(r.name, "edit.not-the-creator", "{actor:?}");
    }
    for bad in [
        Value::Uint(0xff0000),
        tint(&[("tint:whole", 0x100_0000)]),
        tint(&[("part:seat", 1), ("part:seat", 2)]),
    ] {
        let r = w
            .edit(w.creator(), v, vec![set(bad.clone())])
            .expect_err("malformed");
        assert_eq!((r.op, r.name), (Some(0), "edit.tint-malformed"), "{bad:?}");
    }
    let r = w
        .edit(
            w.creator(),
            v,
            vec![Op::Rows {
                node: Ref::Node(cr),
                field: F_TINT,
                rows: vec![Value::Array(vec![text("part:seat"), Value::Uint(7)])],
            }],
        )
        .expect_err("a second seat row");
    assert_eq!(r.name, "edit.tint-malformed");
    // Nor a link's row (R4 review): its row would land in the owner's field 145 as `[link, ...]`.
    let r = w
        .edit(
            w.creator(),
            v,
            vec![Op::Link {
                name: 1,
                ty: Name::new("test:link").expect("a name"),
                ends: [Ref::Node(cr), Ref::Node(room)],
                owner: replica::world_model::End::First,
                field: F_TINT,
                row: vec![Value::Uint(7)],
                door: None,
            }],
        )
        .expect_err("a link into the tint");
    assert_eq!((r.op, r.name), (Some(0), "edit.tint-malformed"));
    assert_eq!(w.log_hash(), log, "nothing refused reached the log");
    assert_eq!(tint_of(&w.live, cr), Some(seat.clone()));

    let reread = w.close();
    assert_eq!(tint_of(&reread, cr), Some(seat), "kept across a restart");
}

#[test]
fn a2_zones_are_named_land_uses_with_an_outline() {
    use replica::edit::claims::F_ZONES;
    let mut w = W::new();
    let zone = |n: &str, u: &str, pts: &[i64]| {
        Value::Array(vec![
            text(n),
            text(u),
            Value::Array(pts.iter().map(|p| mm(*p)).collect()),
        ])
    };
    let square = [0, 0, 10_000, 0, 10_000, 10_000];
    let v = w.live.version();
    w.edit(
        w.creator(),
        v,
        vec![set_root(
            w.root,
            F_ZONES,
            Value::Array(vec![zone("zone:market", "use:commercial", &square)]),
        )],
    )
    .expect("zoned");
    let v = w.live.version();
    for bad in [
        zone("zone:market", "use:casino", &square),
        zone("market", "use:park", &square),
        zone("zone:park", "use:park", &[0, 0, 5, 5]),
    ] {
        let r = w
            .edit(
                w.creator(),
                v,
                vec![set_root(w.root, F_ZONES, Value::Array(vec![bad]))],
            )
            .expect_err("malformed");
        assert_eq!(r.name, "edit.zone-malformed", "{r:?}");
    }
    w.close();
}

// --- #3934 review: a removal's unlink rewrites a far owner, which the claim check judges too ------------------------

/// N2's test world as imported, on a copy that edits commit to: its doorways are real links.
struct Doorways {
    live: Replica,
    root: Id,
    /// The leaf of the test world's door to b.
    leaf: Id,
    world: World,
    minter: Minter,
    intents: Minter,
    at: i64,
}

impl Doorways {
    fn new() -> Doorways {
        let im = import_eden::load(&testworld::generate(1, 0).expect("the test world").text)
            .expect("the test world loads");
        let root = im.nodes["world"];
        let h = import_eden::header(root, &im.rules).expect("a header");
        let next = im.tree.to_state().next;
        let leaf = im.nodes["door-building-to-b"];
        Doorways {
            live: Replica::restored(h, im.tree, next),
            root,
            leaf,
            world: World {
                creator: Id::new(Scope([0xc0; 16]), 1).expect("an id"),
                kinds: BTreeMap::new(),
            },
            minter: Minter::new(Scope([0x77; 16])),
            intents: Minter::new(Scope([0x11; 16])),
            at: 0,
        }
    }

    fn planned(&mut self, ops: Vec<Op>, claim: Option<&str>) -> Result<Planned, Refused> {
        let copy = self.live.frozen();
        let checked = check(
            Edit {
                claim: claim.map(|c| Name::new(c).expect("a name")),
                intent: self.intents.mint().expect("an id"),
                actor: Actor::Creator(self.world.creator),
                planned: self.live.version(),
                ops,
            },
            &copy,
            &self.world,
        )?;
        plan(checked, &copy, None)
    }

    fn edit(&mut self, ops: Vec<Op>, claim: Option<&str>) -> Result<Committed, Refused> {
        let planned = self.planned(ops, claim)?;
        self.at += 1_000;
        commit(&mut self.live, &mut self.minter, &planned, &[], self.at)
    }

    /// Where `node`'s origin is on the root's ground (x, z mm), as the claim check reads it: an edit of it under the
    /// far-away probe claim is refused naming its point.
    fn probe(&mut self, node: Id) -> (i64, i64) {
        let r = self
            .planned(
                vec![Op::Set {
                    node: Ref::Node(node),
                    field: 200,
                    to: Value::Uint(1),
                }],
                Some("c:probe"),
            )
            .err()
            .expect("outside the probe");
        assert_eq!(r.name, "edit.outside-claim", "{r:?}");
        let n = |k: &str| -> i64 {
            let at = r.detail.find(k).expect("a coordinate") + k.len();
            r.detail[at..]
                .split(' ')
                .next()
                .and_then(|s| s.parse().ok())
                .expect("a number")
        };
        (n("x "), n("z "))
    }
}

#[test]
fn a3934_removing_a_node_that_names_a_claimed_doorway_is_judged_where_the_doorway_is() {
    use replica::edit::claims::{F_CLAIMS, judge_effects};
    const F_DOOR_LINK: u64 = 7;
    let mut w = Doorways::new();
    let root = w.root;
    // The doorway the test world's door to b opens, and its owning end, whose field 22 lists it.
    let tree = w.live.tree();
    let leaf = tree
        .node(tree.handle(w.leaf).expect("the leaf"))
        .expect("the leaf");
    let link_value = leaf.fields()[&F_DOOR_LINK].clone();
    let link = replica::effects::read_id(&link_value).expect("a link");
    let (_, [owner, _], ..) = tree.link(link).expect("the doorway");
    let probe = Value::Array(vec![claim_row(
        "c:probe",
        "part:probe",
        [900_000_000, 900_000_000, 900_000_001, 900_000_001],
    )]);
    w.edit(vec![set_root(root, F_CLAIMS, probe)], None)
        .expect("the probe claim");
    let (ox, oz) = w.probe(owner);
    // A childless node far from the owner, with no door of its own.
    let tree = w.live.tree();
    let mut candidates: Vec<Id> = Vec::new();
    let mut stack = vec![tree.root()];
    while let Some(h) = stack.pop() {
        let kids = tree.children(h).unwrap_or_default();
        if let Some(n) = tree.node(h)
            && kids.is_empty()
            && n.parent().is_some()
            && !n.fields().contains_key(&F_DOOR_LINK)
            && !n.fields().contains_key(&replica::edit::DOOR_GEOMETRY)
        {
            candidates.push(n.id());
        }
        stack.extend(kids.iter().copied());
    }
    candidates.sort();
    let (outside, (px, pz)) = candidates
        .into_iter()
        .find_map(|c| {
            let p = w.probe(c);
            ((p.0 - ox).abs() + (p.1 - oz).abs() > 5_000).then_some((c, p))
        })
        .expect("a node far from the doorway");
    let aim = |node: Id| Op::Set {
        node: Ref::Node(node),
        field: F_DOOR_LINK,
        to: link_value.clone(),
    };
    let remove = |node: Id| Op::Remove {
        node: Ref::Node(node),
    };
    // The same removal before the claim, on a copy: what a redo would write again.
    let mut scratch = Doorways {
        live: w.live.frozen(),
        root,
        leaf: w.leaf,
        world: w.world.clone(),
        minter: Minter::new(Scope([0x78; 16])),
        intents: Minter::new(Scope([0x12; 16])),
        at: w.at,
    };
    let unlinked = scratch
        .edit(vec![aim(outside), remove(outside)], None)
        .expect("unclaimed, the removal unlinks the doorway");
    assert!(scratch.live.tree().link(link).is_none(), "unlinked");
    // The lead claims the doorway's owner.
    let house = claim_row("c:house", "part:house", [ox - 1, oz - 1, ox + 1, oz + 1]);
    w.edit(
        vec![set_root(root, F_CLAIMS, Value::Array(vec![house.clone()]))],
        None,
    )
    .expect("claimed");
    // Under no claim: aiming and removing in one batch, or the removal after the aim, is refused where the doorway is.
    let r = w
        .edit(vec![aim(outside), remove(outside)], None)
        .expect_err("the removal unlinks a claimed doorway");
    assert_eq!((r.op, r.name), (Some(1), "edit.claimed"), "{r:?}");
    assert!(r.detail.contains("c:house"), "{}", r.detail);
    w.edit(vec![aim(outside)], None)
        .expect("aiming alone writes only the outside node");
    let r = w
        .edit(vec![remove(outside)], None)
        .expect_err("the removal unlinks a claimed doorway");
    assert_eq!((r.op, r.name), (Some(0), "edit.claimed"), "{r:?}");
    assert!(w.live.tree().link(link).is_some(), "the doorway stands");
    // An undo or a redo writing the same removal is refused too.
    let r = judge_effects(&w.live, &unlinked.part.effects).expect_err("inside a claim");
    assert_eq!(r.name, "edit.claimed", "{r:?}");
    // Under another claim holding the removed node: the doorway's owner is outside it.
    let yard = claim_row("c:yard", "part:yard", [px - 1, pz - 1, px + 1, pz + 1]);
    w.edit(
        vec![set_root(root, F_CLAIMS, Value::Array(vec![house, yard]))],
        None,
    )
    .expect("a second claim");
    let r = w
        .edit(vec![remove(outside)], Some("c:yard"))
        .expect_err("the owner is outside c:yard");
    assert_eq!((r.op, r.name), (Some(0), "edit.outside-claim"), "{r:?}");
    assert!(w.live.tree().link(link).is_some(), "the doorway stands");
}

/// #5006 (god mode audit, row 20): a building kind placed by a creator's edit brings its floor, rooms, windows and
/// doorways from its entry's `building` section, in the same edit, as a template's building has them; the floor's
/// scene reads every doorway; a place that brings its own solids (a clone's or an import's copy) is left as it is.
#[test]
fn a5006_a_building_placed_live_brings_its_rooms_and_doorways_in_one_edit() {
    let mut w = Doorways::new();
    let im = import_eden::load(&testworld::generate(1, 0).expect("the test world").text)
        .expect("the test world loads");
    w.world.kinds = im.rules.kinds.clone();
    let ground = im.nodes["ground"];
    let building = w
        .world
        .kinds
        .keys()
        .find(|k| k.starts_with("testworld:building@"))
        .expect("the test world's building kind")
        .clone();
    // The cottage's entry section, given to the test world's building kind.
    let cottage = replica::rules::json::parse(include_str!(
        "../../../../content/kinds/places/cottage.json"
    ))
    .expect("the cottage's entry");
    let entries = replica::rules::json::parse(&format!(
        r#"{{"testworld:building": {}}}"#,
        cottage.to_json()
    ))
    .expect("entries");
    let place = |name: u64, fields: BTreeMap<u64, Value>| Op::Place {
        name,
        kind: Name::new(&building).expect("a name"),
        parent: Ref::Node(ground),
        at: Spot {
            slot: None,
            position: Vec3::new(60_000_000, 0, 60_000_000),
            orientation: Quat::IDENTITY,
            support: Support::None,
        },
        audience: Audience::Everyone,
        fields,
    };
    let mut edit = Edit {
        claim: None,
        intent: w.intents.mint().expect("an id"),
        actor: Actor::Creator(w.world.creator),
        planned: w.live.version(),
        ops: vec![place(1, BTreeMap::new())],
    };
    let parts =
        worldd::buildsafe::with_buildings(&mut edit, &entries, &w.world.kinds).expect("expanded");
    assert_eq!(
        parts.len(),
        12,
        "the floor, rooms and windows are named as the building's parts"
    );
    let count = |p: &str| {
        edit.ops
            .iter()
            .filter(|o| matches!(o, Op::Place { kind, .. } if kind.as_str().starts_with(p)))
            .count()
    };
    let links = edit
        .ops
        .iter()
        .filter(|o| matches!(o, Op::Link { .. }))
        .count();
    assert_eq!(
        (
            count("eden:floor@"),
            count("eden:room@"),
            count("eden:window@"),
            links
        ),
        (1, 3, 8, 3),
        "one floor, the three rooms, eight windows and three doorways"
    );
    let Op::Place { fields, .. } = &edit.ops[0] else {
        panic!("the building's own place first")
    };
    assert!(
        fields.contains_key(&import_eden::F_SOLIDS) && fields.contains_key(&import_eden::F_SLOTS)
    );
    // One edit: checked, planned and committed whole.
    let copy = w.live.frozen();
    let checked = check(edit, &copy, &w.world).expect("checked");
    let planned = plan(checked, &copy, None).expect("planned");
    w.at += 1_000;
    let done = commit(&mut w.live, &mut w.minter, &planned, &[], w.at).expect("committed");
    let tree = w.live.tree();
    let id = done.names[&1];
    let h = tree.handle(id).expect("the building");
    let floors: Vec<Id> = tree
        .children(h)
        .unwrap_or_default()
        .iter()
        .filter_map(|c| tree.node(*c))
        .filter(|n| n.kind().as_str().starts_with("eden:floor@"))
        .map(|n| n.id())
        .collect();
    assert_eq!(floors.len(), 1, "a floor in the building");
    let fh = tree.handle(floors[0]).expect("the floor");
    assert_eq!(
        tree.children(fh).unwrap_or_default().len(),
        3,
        "three rooms on it"
    );
    // The doorways' rows on their rooms, each a link the floor's scene reads; the front door's leads outside.
    let mut ways = Vec::new();
    for r in tree.children(fh).unwrap_or_default() {
        if let Some(Value::Array(rows)) = tree.node(*r).and_then(|n| n.fields().get(&22).cloned()) {
            for row in rows {
                let Value::Array(row) = row else { continue };
                ways.push(replica::effects::read_id(&row[0]).expect("a doorway's link"));
            }
        }
    }
    assert_eq!(ways.len(), 3, "three doorways, each in its room's row");
    let scene = sim::ground::scene::Scene::of(tree, floors[0]).expect("the floor's scene");
    for l in &ways {
        assert!(
            scene.doorways.iter().any(|d| d.link == *l),
            "the floor reads doorway {l:?}"
        );
    }
    let outside = ways
        .iter()
        .filter(|l| {
            tree.link(**l)
                .is_some_and(|(_, ends, ..)| ends.contains(&ground))
        })
        .count();
    assert_eq!(outside, 1, "the front door leads to the open ground");

    // A copy that brings its own walls is left as it is.
    let own = BTreeMap::from([(import_eden::F_SOLIDS, Value::Array(Vec::new()))]);
    let mut copy_edit = Edit {
        claim: None,
        intent: w.intents.mint().expect("an id"),
        actor: Actor::Creator(w.world.creator),
        planned: w.live.version(),
        ops: vec![place(1, own)],
    };
    let none =
        worldd::buildsafe::with_buildings(&mut copy_edit, &entries, &w.world.kinds).expect("left");
    assert!(none.is_empty());
    assert_eq!(copy_edit.ops.len(), 1, "a copy's place gains nothing");
}
