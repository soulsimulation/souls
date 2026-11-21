//! G4's acceptance (#2795): content hashes after undo and redo (A1), logged batches whose cause names the reversed
//! batch with no earlier log byte changed (A2), the same ids back (A3), refusals that change nothing (A4), rewinding to
//! a step and the bound (A5). Each batch is checked on a frozen copy, committed through the history and appended to
//! K4's log on a disk in memory.

use super::*;
use crate::edit::plan;
use crate::log::{Log, Mem};
use replica::edit::{Edit, Op, Ref, Spot, check, reverses};
use replica::effects::{FIXTURE_HEADER, Header, fixture_bytes};
use replica::hash::state_hash;
use replica::ids::{Minter, Scope};
use replica::pose::{Quat, Support, Vec3};
use replica::world_model::Kind;

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

fn kind(header: &Header, plain: &str) -> Name {
    header
        .kinds
        .iter()
        .find(|k| k.as_str().split('@').next() == Some(plain))
        .expect("a pinned kind")
        .clone()
}

fn ok() -> impl FnMut(&Replica, &[Effect]) -> Result<(), Refused> {
    |_, _| Ok(())
}

struct W {
    header: Header,
    world: World,
    root: Id,
    live: Replica,
    minter: Minter,
    intents: Minter,
    disk: Mem,
    log: Log<Mem>,
    records: u64,
    history: History,
    at: Micros,
}

impl W {
    fn new(limit: usize) -> W {
        let bytes = fixture_bytes(FIXTURE_HEADER).expect("bytes");
        let header = Header::read(&bytes).expect("a header");
        let names = |l: &[&str]| l.iter().map(|s| (*s).to_owned()).collect();
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
        let mut minter = Minter::new(header.lineage);
        let root = minter.mint().expect("an id");
        let disk = Mem::default();
        let (log, _) = Log::open(Mem(disk.0.clone()), 1).expect("a log");
        W {
            live: Replica::start(&bytes).expect("a replica"),
            header,
            world: World {
                creator: Id::new(Scope([0xc0; 16]), 1).expect("an id"),
                kinds,
            },
            root,
            minter,
            intents: Minter::new(Scope([0x11; 16])),
            disk,
            log,
            records: 0,
            history: History::with_limit(limit),
            at: 0,
        }
    }

    fn creator(&self) -> Actor {
        Actor::Creator(self.world.creator)
    }

    fn append(&mut self, part: &Part) {
        self.records = self.log.append(part.stored().to_vec()).expect("appended") + 1;
    }

    fn edit(&mut self, ops: Vec<Op>, step: Option<&str>) -> Committed {
        let edit = Edit {
            claim: None,
            intent: self.intents.mint().expect("an id"),
            actor: self.creator(),
            planned: self.live.version(),
            ops,
        };
        let copy = self.live.frozen();
        let checked = check(edit, &copy, &self.world).expect("checked");
        let planned = plan(checked, &copy, None).expect("planned");
        self.at += 1_000;
        let step = step.map(|s| Step {
            build: "house".to_owned(),
            name: s.to_owned(),
        });
        let c = self
            .history
            .edit(
                &mut self.live,
                &mut self.minter,
                &planned,
                &[],
                self.at,
                step,
            )
            .expect("committed");
        self.append(&c.part);
        c
    }

    fn undo(&mut self, rule: Rule<'_>) -> Result<Reversed, Refused> {
        self.at += 1_000;
        let actor = self.creator();
        let r = self
            .history
            .undo(&mut self.live, &self.world, actor, self.at, rule)?;
        self.append(&r.part);
        Ok(r)
    }

    fn redo(&mut self) -> Result<Reversed, Refused> {
        self.at += 1_000;
        let actor = self.creator();
        let r = self
            .history
            .redo(&mut self.live, &self.world, actor, self.at, &mut ok())?;
        self.append(&r.part);
        Ok(r)
    }

    /// One effect from the world itself, written by `node`: what a Soul or a rule might do between edits.
    fn foreign(&mut self, node: Id, change: Change) {
        self.at += 1_000;
        let e = Effect {
            envelope: Envelope {
                sequence: self.live.version(),
                at: self.at,
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
        let part = write(&mut self.live, &[e]).expect("written");
        self.append(&part);
    }

    fn hashes(&self, ids: &[Id]) -> Vec<Option<Hash>> {
        ids.iter()
            .map(|id| node_hash(self.live.tree(), *id))
            .collect()
    }

    fn state(&self) -> Hash {
        state_hash(self.live.tree()).expect("a hash")
    }

    /// The log's bytes once every record appended is on the disk.
    fn disk(&self) -> Vec<u8> {
        self.log.wait_durable(self.records).expect("durable");
        self.disk.0.lock().expect("the disk").bytes.clone()
    }

    /// A room under the root with a crate in it (field 1 = 1) and a key in the crate's slot (field 1 = 0).
    fn furnish(&mut self, step: Option<&str>) -> (Id, Id, Id, Committed) {
        let h = self.header.clone();
        let mut ops = vec![
            place(
                0,
                &kind(&h, "souls:room"),
                Ref::Node(self.root),
                spot(0, None),
            ),
            place(1, &kind(&h, "souls:crate"), Ref::New(0), spot(2, None)),
            place(2, &kind(&h, "souls:key"), Ref::New(1), spot(0, Some(1))),
        ];
        for (i, v) in [(1, 1), (2, 0)] {
            if let Op::Place { fields, .. } = &mut ops[i] {
                fields.insert(FIELD, Value::Uint(v));
            }
        }
        let c = self.edit(ops, step);
        (c.names[&0], c.names[&1], c.names[&2], c)
    }

    fn set(&mut self, node: Id, to: u64, step: Option<&str>) -> Committed {
        self.edit(
            vec![Op::Set {
                node: Ref::Node(node),
                field: FIELD,
                to: Value::Uint(to),
            }],
            step,
        )
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

fn first(part: &Part) -> u64 {
    part.effects[0].envelope.sequence
}

// --- A1 ---------------------------------------------------------------------------------------------------------------

#[test]
fn a1_undo_and_redo_give_back_the_content_hashes_before_and_after() {
    let mut w = W::new(KEPT_MOST);
    let (room, cr, key, _) = w.furnish(None);
    let h = w.header.clone();
    let ids = [room, cr, key, w.minter_peek()];
    let before = w.hashes(&ids);
    // One batch: set the crate, move it, place another crate.
    let c = w.edit(
        vec![
            Op::Set {
                node: Ref::Node(cr),
                field: FIELD,
                to: Value::Uint(2),
            },
            Op::Move {
                node: Ref::Node(cr),
                at: spot(5, None),
            },
            place(0, &kind(&h, "souls:crate"), Ref::Node(room), spot(-3, None)),
        ],
        None,
    );
    assert_eq!(c.names[&0], ids[3]);
    let after = w.hashes(&ids);
    assert_ne!(before, after);
    w.undo(&mut ok()).expect("undone");
    assert_eq!(
        w.hashes(&ids),
        before,
        "after undo: the hashes before the edit"
    );
    w.redo().expect("redone");
    assert_eq!(w.hashes(&ids), after, "after redo: the hashes after it");
    println!(
        "edit, undo, redo: the 4 touched nodes' hashes equal those before the edit after undo, those after it after redo"
    );
}

impl W {
    /// The id the world's minter gives next.
    fn minter_peek(&self) -> Id {
        let mut m = self.minter.clone();
        m.mint().expect("an id")
    }
}

// --- A2 ---------------------------------------------------------------------------------------------------------------

#[test]
fn a2_undo_and_redo_are_logged_batches_naming_what_they_reverse() {
    let mut w = W::new(KEPT_MOST);
    let (_, cr, _, _) = w.furnish(None);
    let edit = w.set(cr, 2, None);
    let disk = w.disk();
    let undo = w.undo(&mut ok()).expect("undone");
    assert_eq!(undo.reverses, first(&edit.part));
    for e in &undo.part.effects {
        assert_eq!(e.envelope.cause, Cause::Effect(first(&edit.part)));
        assert_eq!(e.envelope.actor, w.creator());
        assert_eq!(reverses(e), Some(first(&edit.part)));
    }
    let redo = w.redo().expect("redone");
    for e in &redo.part.effects {
        assert_eq!(e.envelope.cause, Cause::Effect(first(&undo.part)));
        assert_eq!(reverses(e), Some(first(&undo.part)));
    }
    assert!(edit.part.effects.iter().all(|e| reverses(e).is_none()));
    let now = w.disk();
    assert!(
        now.len() > disk.len() && now.starts_with(&disk),
        "no earlier log byte changes"
    );
    println!(
        "edit at {}, undo at {} (cause effect {}), redo at {} (cause effect {}); log {} -> {} bytes, prefix kept",
        first(&edit.part),
        first(&undo.part),
        undo.reverses,
        first(&redo.part),
        redo.reverses,
        disk.len(),
        now.len()
    );
}

// --- A3 ---------------------------------------------------------------------------------------------------------------

#[test]
fn a3_undoing_a_removal_brings_back_the_same_ids_and_redo_gives_back_the_same_ids() {
    let mut w = W::new(KEPT_MOST);
    let (room, cr, key, _) = w.furnish(None);
    // A link from the crate to the root: removing the room ends it, and undoing the removal brings it back.
    let link = w.minter.mint().expect("an id");
    w.foreign(
        cr,
        Change::Link {
            link,
            ty: Name::new("souls:near").expect("a name"),
            ends: [cr, w.root],
            owner: End::First,
            audience: Audience::Everyone,
        },
    );
    let ids = [w.root, room, cr, key];
    let before = w.hashes(&ids);
    w.edit(
        vec![Op::Remove {
            node: Ref::Node(room),
        }],
        None,
    );
    assert!(w.live.tree().handle(room).is_none() && w.live.tree().link(link).is_none());
    w.undo(&mut ok()).expect("undone");
    assert_eq!(
        w.hashes(&ids),
        before,
        "the same things, with their ids and the link"
    );
    assert!(w.live.tree().link(link).is_some());
    w.redo().expect("redone");
    assert!(w.live.tree().handle(cr).is_none());
    w.undo(&mut ok()).expect("undone again");
    assert_eq!(w.hashes(&ids), before);

    // A place undone and redone: the ids it minted come back.
    let mut w = W::new(KEPT_MOST);
    let (room, cr, key, _) = w.furnish(None);
    let ids = [room, cr, key];
    let placed = w.hashes(&ids);
    w.undo(&mut ok()).expect("undone");
    assert_eq!(w.hashes(&ids), vec![None, None, None]);
    w.redo().expect("redone");
    assert_eq!(w.hashes(&ids), placed, "redo gives back the same ids");
    println!(
        "removal undone: room, crate, key and link back by id; place redone: the same three ids"
    );
}

// --- A4 ---------------------------------------------------------------------------------------------------------------

#[test]
fn a4_a_refused_or_conflicting_undo_changes_nothing() {
    let mut w = W::new(KEPT_MOST);
    let (_, cr, _, _) = w.furnish(None);
    w.set(cr, 2, None);
    let unchanged = |w: &W| (w.state(), w.disk(), w.live.version(), w.history.depth());
    let was = unchanged(&w);
    // G2's rule refuses it (a stand-in for G2's guard and judge, #2761).
    let mut g2 = |_: &Replica, _: &[Effect]| {
        Err(Refused {
            op: None,
            name: "edit.would-bury",
            detail: "a stand-in for G2".to_owned(),
        })
    };
    let r = w.undo(&mut g2).expect_err("refused");
    assert_eq!(r.name, "edit.would-bury");
    assert_eq!(unchanged(&w), was, "a refused undo changes nothing");

    // The crate changed since the edit: undo.conflict.
    w.foreign(
        cr,
        Change::Set {
            node: cr,
            field: FIELD,
            to: Value::Uint(3),
            by: None,
        },
    );
    let was = unchanged(&w);
    let r = w.undo(&mut ok()).expect_err("refused");
    assert_eq!(r.name, "undo.conflict");
    assert_eq!(unchanged(&w), was, "a conflicting undo changes nothing");

    // Something put in the room since it was placed: undoing the place would take it, so undo.conflict.
    let mut w = W::new(KEPT_MOST);
    let (room, _, _, _) = w.furnish(None);
    let h = w.header.clone();
    let other = w.minter.mint().expect("an id");
    w.foreign(
        room,
        Change::Create {
            node: other,
            kind: kind(&h, "souls:key"),
            pose: spot(7, None).pose(room),
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        },
    );
    let was = unchanged(&w);
    let r = w.undo(&mut ok()).expect_err("refused");
    assert_eq!(r.name, "undo.conflict");
    assert_eq!(unchanged(&w), was);
    println!(
        "G2 stand-in refusal, a changed node and a thing put inside: each refused, nothing changed"
    );
}

// --- A5 ---------------------------------------------------------------------------------------------------------------

#[test]
fn a5_rewinding_to_a_step_undoes_later_batches_newest_first_and_stops_at_the_first_refusal() {
    let mut w = W::new(KEPT_MOST);
    let (room, cr, key, _) = w.furnish(Some("frame"));
    let ids = [room, cr, key];
    let at_frame = w.hashes(&ids);
    let walls = w.set(cr, 2, Some("walls"));
    let roof = w.set(cr, 3, Some("roof"));
    let paint = w.set(key, 9, Some("paint"));
    let step = Step {
        build: "house".to_owned(),
        name: "frame".to_owned(),
    };
    let actor = w.creator();
    let r = w
        .history
        .rewind(&mut w.live, &w.world, actor, &step, 50_000, &mut ok())
        .expect("rewound");
    assert_eq!(r.stopped, None);
    assert_eq!(
        r.parts.iter().map(|p| p.reverses).collect::<Vec<_>>(),
        vec![first(&paint.part), first(&roof.part), first(&walls.part)],
        "newest first"
    );
    assert_eq!(w.hashes(&ids), at_frame);
    assert_eq!(w.history.depth(), (1, 3));

    // A conflict on the second batch back stops the rewind there.
    let mut w = W::new(KEPT_MOST);
    let (room, cr, key, _) = w.furnish(Some("frame"));
    w.set(cr, 2, Some("walls"));
    w.foreign(
        cr,
        Change::Set {
            node: cr,
            field: FIELD,
            to: Value::Uint(7),
            by: None,
        },
    );
    let h = w.header.clone();
    let roof = w.edit(
        vec![place(
            0,
            &kind(&h, "souls:crate"),
            Ref::Node(room),
            spot(-4, None),
        )],
        Some("roof"),
    );
    let paint = w.set(key, 9, Some("paint"));
    let actor = w.creator();
    let r = w
        .history
        .rewind(&mut w.live, &w.world, actor, &step, 60_000, &mut ok())
        .expect("rewound");
    assert_eq!(
        r.parts.iter().map(|p| p.reverses).collect::<Vec<_>>(),
        vec![first(&paint.part), first(&roof.part)]
    );
    assert_eq!(r.stopped.as_ref().map(|s| s.name), Some("undo.conflict"));
    assert_eq!(w.history.depth(), (2, 2));
    println!(
        "rewind to frame: 3 undone newest first; with walls changed since: 2 undone, stopped at {:?}",
        r.stopped.map(|s| s.detail)
    );
}

#[test]
fn a5_the_kept_before_values_are_bounded() {
    assert_eq!(KEPT_MOST, 64 * 1024 * 1024);
    // The same batches with no bound and with room for the last two: the oldest leave first.
    let run = |limit: usize| {
        let mut w = W::new(limit);
        let (_, cr, _, _) = w.furnish(None);
        let mut kept = vec![w.history.kept()];
        for to in 2..5 {
            w.set(cr, to, None);
            kept.push(w.history.kept());
        }
        (w, kept)
    };
    let (_, kept) = run(usize::MAX);
    let each: Vec<usize> = kept.windows(2).map(|k| k[1] - k[0]).collect();
    let (mut w, _) = run(each[1] + each[2]);
    assert_eq!(w.history.depth(), (2, 0));
    assert!(w.history.kept() <= each[1] + each[2]);
    w.undo(&mut ok()).expect("undone");
    w.undo(&mut ok()).expect("undone");
    assert_eq!(w.undo(&mut ok()).expect_err("dropped").name, "undo.nothing");
    println!("kept per batch {kept:?} bytes; bound {KEPT_MOST} bytes; oldest dropped first");
}
