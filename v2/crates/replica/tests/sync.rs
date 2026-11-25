//! Sync and resume by hash (Engine v2 R5, #2699). `aN_` tests are acceptance boxes; A1's and A2's timings and bytes
//! are the `resync` bench (`v2/tools/bench/resync`). Run with `cargo test -p replica --test sync -- --nocapture`.

use replica::effects::{FIXTURE_HEADER, FIXTURES, Header, Part, Refusal, fixture_bytes};
use replica::ids::{Hash, Id, Scope, Version};
use replica::sync::{BIG_RECORD, Copy, Records, Served, Source, Start, start};
use replica::tree::Tree;

fn header() -> Header {
    Header::read(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap()
}

fn part(name: &str) -> Part {
    Part::read(&fixture_bytes(FIXTURES.iter().find(|(n, _)| *n == name).unwrap().1).unwrap())
        .unwrap()
}

fn base(h: &Header) -> Tree {
    let root = h
        .kinds
        .iter()
        .find(|k| k.as_str().starts_with("souls:place@"))
        .unwrap()
        .clone();
    let mut t = Tree::start(h.zone, root);
    t.apply(h, &part("0-base")).unwrap();
    t
}

fn world_id(n: u64) -> Id {
    Id::new(Scope([0xee; 16]), n).unwrap()
}

fn version(lineage: u8, epoch: u64, sequence: u64) -> Version {
    Version {
        lineage: Scope([lineage; 16]),
        zone: world_id(0),
        epoch,
        sequence,
    }
}

/// The world's end: its tree, sealed, and every record its seals gave.
struct World {
    tree: Tree,
    records: Records,
}

impl World {
    fn seal(&mut self) {
        let s = self.tree.seal().unwrap();
        self.records.keep(&s);
    }

    fn served(&self) -> Served<'_> {
        Served {
            tree: &self.tree,
            records: &self.records,
        }
    }

    fn hash(&self, id: Id) -> Option<Hash> {
        self.tree.node(self.tree.handle(id)?)?.sealed()
    }
}

#[test]
fn a3_another_epoch_or_lineage_never_resumes() {
    let world = version(1, 2, 50);
    assert_eq!(start(Some(&version(1, 2, 40)), &world), Start::Cursor);
    assert_eq!(start(Some(&version(1, 2, 50)), &world), Start::Cursor);
    assert_eq!(
        start(Some(&version(1, 1, 40)), &world),
        Start::FromTop,
        "an older epoch"
    );
    assert_eq!(
        start(Some(&version(1, 3, 40)), &world),
        Start::FromTop,
        "a later epoch"
    );
    assert_eq!(
        start(Some(&version(2, 2, 40)), &world),
        Start::FromTop,
        "another lineage"
    );
    let mut zone = version(1, 2, 40);
    zone.zone = world_id(9);
    assert_eq!(start(Some(&zone), &world), Start::FromTop, "another zone");
    assert_eq!(
        start(Some(&version(1, 2, 51)), &world),
        Start::FromTop,
        "the future"
    );
    assert_eq!(start(None, &world), Start::FromTop, "no cursor");
}

#[test]
fn from_the_top_the_copy_equals_the_world_and_fetches_only_what_differs() {
    let h = header();
    let scope = [world_id(0), world_id(1)];
    for (name, _) in FIXTURES.iter().filter(|(n, _)| *n != "0-base") {
        let mut w = World {
            tree: base(&h),
            records: Records::default(),
        };
        w.seal();
        let mut copy = Copy::default();
        let first = copy.sync(&scope, &mut w.served()).unwrap();
        // The world moves on while the client is away.
        if w.tree.apply(&h, &part(name)).is_err() {
            continue;
        }
        w.seal();
        let s = copy.sync(&scope, &mut w.served()).unwrap();
        for id in scope {
            assert_eq!(
                copy.roots().get(&id),
                w.hash(id).map(Hash::to_bytes).as_ref(),
                "{name}: {id:?}"
            );
        }
        let reached = copy.reach().unwrap();
        assert_eq!(
            reached.len(),
            s.held,
            "{name}: the copy is the scope and nothing else"
        );
        assert!(s.fetched <= s.held, "{name}");
        println!(
            "{name}: first {} records {} B; after {} changed, {} fetched of {} in {} rounds, {} B sent, {} B got",
            first.fetched, first.got, s.changed, s.fetched, s.held, s.rounds, s.sent, s.got
        );
        let again = copy.sync(&scope, &mut w.served()).unwrap();
        assert_eq!(
            (again.fetched, again.changed, again.rounds),
            (0, 0, 1),
            "{name}: current"
        );
    }
}

/// A world (or a cache) that sends one wrong byte.
struct Lying<'a>(Served<'a>);

impl Source for Lying<'_> {
    fn hashes(&mut self, ids: &[Id]) -> Result<Vec<Option<Hash>>, Refusal> {
        self.0.hashes(ids)
    }

    fn records(&mut self, hashes: &[Vec<u8>]) -> Result<Vec<Vec<u8>>, Refusal> {
        let mut r = self.0.records(hashes)?;
        if let Some(b) = r.first_mut().and_then(|b| b.last_mut()) {
            *b ^= 1;
        }
        Ok(r)
    }
}

#[test]
fn a_record_that_does_not_hash_to_its_name_is_refused_by_name() {
    let h = header();
    let mut w = World {
        tree: base(&h),
        records: Records::default(),
    };
    w.seal();
    let r = Copy::default().sync(&[world_id(0)], &mut Lying(w.served()));
    assert_eq!(r.map(|_| ()).map_err(|e| e.name), Err("sync-hash"));
}

/// A world whose answers stop after so many records requests, as a socket closed mid-sync.
struct Cut<'a>(Served<'a>, usize);

impl Source for Cut<'_> {
    fn hashes(&mut self, ids: &[Id]) -> Result<Vec<Option<Hash>>, Refusal> {
        self.0.hashes(ids)
    }

    fn records(&mut self, hashes: &[Vec<u8>]) -> Result<Vec<Vec<u8>>, Refusal> {
        if self.1 == 0 {
            return Err(Refusal {
                name: "cut",
                detail: String::new(),
            });
        }
        self.1 -= 1;
        self.0.records(hashes)
    }
}

/// #3424: a sync cut off after its first level held the place's record without the records below it, and the next
/// sync, finding the place's hash held, never descended: `sync-missing` at every sign-in after.
#[test]
fn a_sync_cut_off_mid_descent_leaves_the_copy_as_it_was_and_the_next_one_completes() {
    let h = header();
    let mut w = World {
        tree: base(&h),
        records: Records::default(),
    };
    w.seal();
    let scope = [world_id(0)];
    let mut copy = Copy::default();
    let r = copy.sync(&scope, &mut Cut(w.served(), 1));
    assert_eq!(r.map(|_| ()).map_err(|e| e.name), Err("cut"));
    assert!(
        copy.roots().is_empty(),
        "the scope's hashes are the copy's only once it finishes"
    );
    assert!(copy.reach().unwrap().is_empty());
    let s = copy.sync(&scope, &mut w.served()).unwrap();
    assert_eq!(
        copy.roots().get(&world_id(0)),
        w.hash(world_id(0)).map(Hash::to_bytes).as_ref()
    );
    assert!(s.held > 1, "the place and what is below it: {}", s.held);
    assert_eq!(copy.reach().unwrap().len(), s.held);
}

#[test]
/// #3915: a record the world withholds (empty bytes: under a closed container the asker may not see into) is held as
/// withheld, a leaf: the sync finishes, and the copy never reads it.
fn a_withheld_record_is_a_leaf_the_copy_never_reads() {
    let mut copy = Copy::default();
    let h = Hash::of(replica::ids::Purpose::StatePublic, b"a hidden thing").to_bytes();
    let mut d = copy.compare(&[world_id(1)], vec![Some(h.clone())]);
    let asked = copy.ask(&mut d, usize::MAX);
    assert_eq!(asked, vec![h.clone()]);
    copy.take(&mut d, &asked, vec![Vec::new()]).unwrap();
    assert!(
        copy.ask(&mut d, usize::MAX).is_empty(),
        "nothing below a withheld record"
    );
    let s = copy.finish(d).unwrap();
    assert_eq!(s.held, 1);
    assert_eq!(copy.record(&h), None, "a withheld record is never read");
    assert!(copy.reach().is_ok());
    // Whether it may be seen is not in its hash: the next sync asks for it again.
    let mut d = copy.compare(&[world_id(1)], vec![Some(h.clone())]);
    assert_eq!(
        copy.ask(&mut d, usize::MAX),
        vec![h],
        "a withheld record is asked for again"
    );
}

/// The set fixture's first entry again, as the `round`th part: the crate's field set to `to`, at the next sequence.
/// A node whose record changes at every seal, as a moving body's does.
fn set_again(round: u64, to: replica::encode::Value) -> Part {
    use replica::encode::{Value, encode};
    let Value::Map(mut p) = part("4-set").to_value() else {
        unreachable!("a part is a map")
    };
    let Some(Value::Array(effects)) = p.get_mut(&2) else {
        unreachable!("a part's entries")
    };
    effects.truncate(1);
    let Some(Value::Map(e)) = effects.first_mut() else {
        unreachable!("an entry is a map")
    };
    e.insert(1, Value::Uint(2 + round));
    e.insert(2, Value::Uint(3_000_000 + round * 50_000));
    e.remove(&8);
    let Some(Value::Array(changes)) = e.get_mut(&7) else {
        unreachable!("the entry's changes")
    };
    let Some(Value::Map(c)) = changes.first_mut() else {
        unreachable!("a change is a map")
    };
    c.insert(4, to);
    c.remove(&5);
    Part::read(&encode(&Value::Map(p)).unwrap()).unwrap()
}

/// The crate the set fixture writes to.
const CRATE: u64 = 7;

/// `rounds` seals, the crate changed before each (its field `to(round)`): the records held stop growing once the
/// window has passed, a replaced crate record is served for `window` seals and then refused by name, and a sync from
/// the top still completes.
fn bounded_over(rounds: u64, window: u64, to: impl Fn(u64) -> replica::encode::Value) {
    let h = header();
    let scope = [world_id(0), world_id(1)];
    let mut w = World {
        tree: base(&h),
        records: Records::default(),
    };
    w.seal();
    let at_start = w.records.bytes();
    let (mut settled, mut watched) = (None, None);
    for round in 0..rounds {
        w.tree.apply(&h, &set_again(round, to(round))).unwrap();
        w.seal();
        if round == 2 * window {
            settled = Some(w.records.bytes());
            // The record holding the crate's field as of this seal, which the next seal replaces: the crate's own,
            // or the field's when it is big (#4713).
            watched = Some(holder(&w, world_id(CRATE), 1));
        }
        if let Some(watched) = &watched {
            let served = w.served().records(std::slice::from_ref(watched));
            let age = round - 2 * window; // the next seal replaced it: seals since then, and one
            if age <= window {
                assert!(
                    served.is_ok(),
                    "replaced {} seals ago: still served",
                    age - 1
                );
            } else if age == window + 1 {
                assert_eq!(
                    served.unwrap_err().name,
                    "sync-unknown-hash",
                    "replaced {window} seals ago: let go"
                );
            }
        }
    }
    // Past the window, each seal lets go about what it keeps: the bytes held grow by less than one big record (the
    // small records of the crate's parents, whose window is longer than a big one's, and a value's longer writing).
    let bytes = settled.unwrap();
    assert!(bytes > at_start, "the window holds replaced records");
    let end = w.records.bytes();
    assert!(
        end < bytes + BIG_RECORD,
        "bytes held after {rounds} seals: {end}, after {}: {bytes}",
        2 * window
    );
    let mut fresh = Copy::default();
    fresh.sync(&scope, &mut w.served()).unwrap();
    for id in scope {
        assert_eq!(
            fresh.roots().get(&id),
            w.hash(id).map(Hash::to_bytes).as_ref()
        );
    }
}

/// worldd grew 5 to 9 MB a second while one Soul walked, and never gave it back (#1960): its sync thread kept every
/// record every seal gave, and a moving body re-seals itself and every ancestor at each seal (Eden's ground's record
/// holds its terrain and every child's hash). A small record changed at every seal is kept its window and let go.
#[test]
fn replaced_small_records_are_let_go_after_their_window() {
    use replica::sync::SMALL_SEALS;
    bounded_over(
        3 * SMALL_SEALS + 10,
        SMALL_SEALS,
        replica::encode::Value::Uint,
    );
}

/// A big record (the ground's, in Eden) changed at every seal is kept its shorter window, so the records held stay
/// within a few megabytes of the world's own.
#[test]
fn replaced_big_records_are_let_go_after_their_shorter_window() {
    use replica::sync::BIG_SEALS;
    bounded_over(3 * BIG_SEALS + 10, BIG_SEALS, |r| {
        replica::encode::Value::Bytes(vec![(r % 251) as u8; BIG_RECORD])
    });
}

/// As [`set_again`], on node `node`'s field `field`.
fn set_on(round: u64, node: u64, field: u64, to: replica::encode::Value) -> Part {
    use replica::encode::{Value, encode};
    let Value::Map(mut p) = set_again(round, to).to_value() else {
        unreachable!("a part is a map")
    };
    let Some(Value::Array(effects)) = p.get_mut(&2) else {
        unreachable!("a part's entries")
    };
    let Some(Value::Map(e)) = effects.first_mut() else {
        unreachable!("an entry is a map")
    };
    e.insert(6, world_id(node).to_value());
    let Some(Value::Array(changes)) = e.get_mut(&7) else {
        unreachable!("the entry's changes")
    };
    let Some(Value::Map(c)) = changes.first_mut() else {
        unreachable!("a change is a map")
    };
    c.insert(2, world_id(node).to_value());
    c.insert(3, Value::Uint(field));
    Part::read(&encode(&Value::Map(p)).unwrap()).unwrap()
}

/// The hash of the record that holds field `field` of node `id`, as the world serves it: its big field's own record
/// when its record names one (key 0, #4713), else its own record.
fn holder(w: &World, id: Id, field: u64) -> Vec<u8> {
    use replica::encode::{Value, decode};
    let own = w.hash(id).unwrap().to_bytes();
    let bytes = w
        .served()
        .records(std::slice::from_ref(&own))
        .unwrap()
        .remove(0);
    let Value::Map(m) = decode(&bytes).unwrap().value else {
        unreachable!("a record is a map")
    };
    if let Some(Value::Array(bigs)) = m.get(&0) {
        for p in bigs {
            if let Value::Array(p) = p
                && let [Value::Uint(f), Value::Bytes(h)] = p.as_slice()
                && *f == field
            {
                return h.clone();
            }
        }
    }
    assert!(
        matches!(m.get(&6), Some(Value::Map(f)) if f.contains_key(&field)),
        "the node holds the field"
    );
    own
}

/// #4713: every Soul's sync fetched mars-two's ground record again (8.4 MB) whenever a body on the ground moved: its
/// terrain is in it, and a child's change re-hashes its parent. A big field is a record of its own, which a child's
/// change leaves as it was: a sync after one fetches the parent's small record, not the field. The copy reads the
/// field through its node's record, and a checkpoint's records read the tree back whole.
#[test]
fn a_childs_change_leaves_the_record_holding_its_parents_big_field_as_it_was() {
    use replica::encode::{Value, decode};
    use replica::tree::BIG_FIELD;
    const ROOM: u64 = 1;
    const TERRAIN: u64 = 25;
    let terrain = Value::Bytes((0..1 << 20).map(|i| (i % 251) as u8).collect());
    let h = header();
    let scope = [world_id(0), world_id(1)];
    let mut w = World {
        tree: base(&h),
        records: Records::default(),
    };
    w.seal();
    // The crate's room stands for the ground: 1 MB of terrain (mars-two's is 8.4 MB), and the crate in it.
    w.tree
        .apply(&h, &set_on(0, ROOM, TERRAIN, terrain.clone()))
        .unwrap();
    w.seal();
    let mut copy = Copy::default();
    let first = copy.sync(&scope, &mut w.served()).unwrap();
    assert!(first.got > 1 << 20, "a snapshot fetches the terrain");
    let held = holder(&w, world_id(ROOM), TERRAIN);
    for round in 1..=3 {
        let room = w.hash(world_id(ROOM)).unwrap();
        // The crate changes, as a body walking on the ground does.
        w.tree
            .apply(&h, &set_again(round, Value::Uint(round)))
            .unwrap();
        w.seal();
        assert_ne!(
            w.hash(world_id(ROOM)).unwrap(),
            room,
            "the room's hash covers the crate's"
        );
        assert_eq!(
            holder(&w, world_id(ROOM), TERRAIN),
            held,
            "round {round}: the record holding the terrain is the same"
        );
        let s = copy.sync(&scope, &mut w.served()).unwrap();
        assert!(
            s.got < BIG_FIELD as u64,
            "round {round}: a sync after the crate's change fetched {} B",
            s.got
        );
    }
    let own = w.hash(world_id(ROOM)).unwrap().to_bytes();
    let Value::Map(room) = decode(copy.record(&own).unwrap()).unwrap().value else {
        unreachable!("a record is a map")
    };
    assert_eq!(copy.field(&room, TERRAIN), Some(terrain.clone()));
    let whole = w.tree.seal_whole().unwrap();
    let mut records = std::collections::BTreeMap::new();
    for (h, b) in &whole.nodes {
        records.insert(h.to_bytes(), b.clone());
    }
    for (_, h, b) in &whole.audiences {
        records.insert(h.to_bytes(), b.clone());
    }
    let audiences: Vec<_> = whole
        .audiences
        .iter()
        .map(|(a, h, _)| (*a, h.to_bytes()))
        .collect();
    let back = Tree::unseal(&audiences, &mut |h| {
        records.get(h).cloned().ok_or(Refusal {
            name: "checkpoint-missing",
            detail: String::new(),
        })
    })
    .unwrap();
    assert_eq!(
        back.state_hashes_whole().unwrap(),
        w.tree.state_hashes_whole().unwrap()
    );
    let n = back.node(back.handle(world_id(ROOM)).unwrap()).unwrap();
    assert_eq!(n.fields().get(&TERRAIN), Some(&terrain));
}
