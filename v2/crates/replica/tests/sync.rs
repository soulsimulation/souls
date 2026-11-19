//! Sync and resume by hash (Engine v2 R5, #2699). `aN_` tests are acceptance boxes; A1's and A2's timings and bytes
//! are the `resync` bench (`v2/tools/bench/resync`). Run with `cargo test -p replica --test sync -- --nocapture`.

use replica::effects::{FIXTURE_HEADER, FIXTURES, Header, Part, Refusal, fixture_bytes};
use replica::ids::{Hash, Id, Scope, Version};
use replica::sync::{Copy, Records, Served, Source, Start, start};
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
