//! A creator's edits as effects (Engine v2 G1, #2746). Each batch is checked on a frozen copy (`replica::edit`),
//! committed on the clock thread (`sim::edit`) through the one write path, appended to K4's log on a disk in memory
//! and handed to R3's view tier, as the clock thread does with an act. Then all three views are compared: a replica
//! (a client's copy, applying the same bytes), the viewer's stream (R3's frames for the root's public `full` key) and
//! the archive (the log read back from the disk and applied from the start).
//!
//! A1 and A2: one test per operation. A3: a refused batch leaves the log's hash unchanged and names the operation. A4:
//! who, size and kind. A5: an edit planned against an older version.

use replica::apply::Replica;
use replica::edit::{Edit, NODES_MOST, OPS_MOST, Op, Ref, Refused, Spot, World, check};
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
    /// and holds each edit's effects under its cause.
    fn close(self) {
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
