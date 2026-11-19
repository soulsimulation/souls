//! The archive's tool (Engine v2 V3, #2712), run from `v2/`:
//!
//! - `cargo run -p archive --release -- record <dir>`: a scripted world writes its log to `<dir>` (K4's file log) and
//!   its archiver, on its own thread, packs each durable record into the store; prints the recorded state hash.
//! - `cargo run -p archive --release -- restore <hash>`: rebuilds the world from the store alone and prints the
//!   restore log, both hashes, and whether the bundles made again equal the stored ones.
//! - `cargo run -p archive --release -- count`: the write count of a busy hour and a quiet day, scaled to a month
//!   with O3's shipping, at R2's price (in memory; `v2/docs/archive.md`).
//! - `cargo run -p archive --release -- corpus <dir>`: writes entry one of V18's corpus.
//! - `cargo run -p archive --release -- seek [hours]`: V4's seek table and index sizes (`seek_bench.rs`).
//! - `cargo run -p archive --release -- pack <work dir> <out dir> [at µs ...]`: a stream-check run's log archived into
//!   a folder the v2 page serves as history (V9), and each moment's state hash as `seek` gives it.
//!
//! `record` and `restore` use the S3-compatible store named by `ARCHIVE_STORE_ENDPOINT`, `_BUCKET`, `_REGION`
//! (default `auto`), `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` and `_PREFIX`: a local stand-in or a scratch bucket,
//! never production's.

mod seek_bench;

use std::cell::RefCell;
use std::collections::BTreeSet;
use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;

use archive::script::{self, SAID, TICK, World};
use archive::{
    Archiver, R, Segment, Shared, Writes, fetch, rebuild_bundles, refuse, restore, state_hash,
    stored_bundles, words_in_bundle, words_in_object,
};
use directoryd::directory::s3::S3;
use directoryd::directory::store::{Memory, Store};
use replica::encode::{encode, to_hex};
use replica::ids::Id;
use sim::log::{FileStore, Log};

/// R2's price of a write (class A operation), dollars per million (Fact 2, `v2/docs/tranche/V-viewers-and-history.md`).
const PRICE: f64 = 4.50;
/// O3's designed shipping for a busy world: one write each ten seconds, a 30-day month.
const O3_BUSY: u64 = 259_200;

fn store() -> R<S3> {
    let var = |k: &str| std::env::var(format!("ARCHIVE_STORE_{k}")).unwrap_or_default();
    if var("ENDPOINT").is_empty() {
        return refuse("store-settings", "ARCHIVE_STORE_ENDPOINT is not set");
    }
    let region = Some(var("REGION")).filter(|r| !r.is_empty());
    S3::new(
        &var("ENDPOINT"),
        &var("BUCKET"),
        region.as_deref().unwrap_or("auto"),
        &var("ACCESS_KEY_ID"),
        &var("SECRET_ACCESS_KEY"),
        &var("PREFIX"),
    )
}

const PREFIX: &str = "worlds/scripted/";

fn root_of(w: &World) -> (Id, replica::encode::Name) {
    let n = w.tree.node(w.tree.root()).expect("the root");
    (n.id(), n.kind().clone())
}

/// A world whose committed parts queue up for the log.
fn logged(rooms: usize, things: usize) -> (World, Rc<RefCell<Vec<Vec<u8>>>>) {
    let queue: Rc<RefCell<Vec<Vec<u8>>>> = Rc::default();
    let q = queue.clone();
    let w = script::world(
        rooms,
        things,
        Some(Box::new(move |b: &[u8]| q.borrow_mut().push(b.to_vec()))),
    );
    (w, queue)
}

/// `record`: twenty minutes of world time of a world of 100 bodies and 1,000 things, ten steps a tick, its log on
/// the disk and its archive in the store.
fn record(dir: &Path) -> R<()> {
    std::fs::create_dir_all(dir).or_else(|e| refuse("io", e.to_string()))?;
    let (mut w, queue) = logged(10, 90);
    let (root, kind) = root_of(&w);
    let (mut log, _) = Log::open(FileStore::open(&dir.join("log"))?, 1)?;
    let mut a = Archiver::open(Shared(Arc::new(store()?)), PREFIX, &w.header, root, kind)?;
    a.packer.set_target(1 << 20);
    let (tx, archiver) = a.spawn();
    let mut handed = 0u64;
    let mut hand = |log: &mut Log<FileStore>, queue: &Rc<RefCell<Vec<Vec<u8>>>>| -> R<()> {
        let parts: Vec<Vec<u8>> = queue.borrow_mut().drain(..).collect();
        for p in parts {
            let n = log.append(p.clone())?;
            // The archiver takes a record once it is on the disk, never before (T11 rule 1).
            log.wait_durable(n + 1)?;
            tx.send((n, p))
                .or_else(|_| refuse("archive-stopped", "the archiver stopped"))?;
            handed += 1;
        }
        Ok(())
    };
    hand(&mut log, &queue)?;
    for t in 0..24_000u64 {
        script::tick(&mut w, t, 10, 100);
        hand(&mut log, &queue)?;
    }
    drop(tx);
    let writes = archiver
        .join()
        .unwrap_or_else(|p| std::panic::resume_unwind(p))?;
    drop(log);
    println!(
        "recorded: {handed} records, world time {} s, writes {writes:?}",
        24_000 * TICK / 1_000_000
    );
    println!("recorded state hash={}", state_hash(&mut w.tree)?);
    Ok(())
}

/// `restore`: from the store alone.
fn restore_cmd(expect: &str) -> R<()> {
    let s = store()?;
    let f = fetch(&s, PREFIX)?;
    for l in &f.log {
        println!("restore: {l}");
    }
    let mut tree = restore(&f)?;
    let got = state_hash(&mut tree)?;
    println!("recorded state hash={expect}");
    println!("restored state hash={got}");
    println!(
        "state hashes {}",
        if got == expect { "EQUAL" } else { "DIFFER" }
    );
    let stored = stored_bundles(&s, PREFIX, &f)?;
    let again = rebuild_bundles(&f)?;
    for (i, b) in stored.iter().enumerate() {
        let a = again.get(i).map(|a| to_hex(&a.hash()));
        println!(
            "bundle {} ({} records, {} bytes): stored sha256 {} made again {}",
            b.start,
            b.records(),
            b.bytes().len(),
            to_hex(&b.hash()),
            a.as_deref().unwrap_or("none")
        );
    }
    let same =
        stored.len() == again.len() && stored.iter().zip(&again).all(|(a, b)| a.hash() == b.hash());
    println!(
        "bundles: {} stored, {} made again, {}",
        stored.len(),
        again.len(),
        if same { "EQUAL" } else { "DIFFER" }
    );
    let mut found = Vec::new();
    for m in &f.manifests {
        for r in &m.rows {
            if let Some(o) = s.get(&r.key)? {
                found.extend(words_in_object(&o.bytes, &SAID)?);
            }
        }
    }
    for b in &stored {
        found.extend(words_in_bundle(b.bytes(), &SAID)?);
    }
    println!("words found in objects and bundles: {}", found.len());
    if got != expect || !same || !found.is_empty() {
        return refuse("restore-differs", "see above");
    }
    Ok(())
}

/// Archives `ticks` (tick number, movers) of a world of 1,000 bodies and 10,000 things, built first; returns the
/// writes and O3's ships (each ten seconds of world time in which records were made).
fn measure(ticks: &[(u64, usize)]) -> R<(Writes, u64)> {
    let (mut w, queue) = logged(100, 90);
    let (root, kind) = root_of(&w);
    let store = Shared(Arc::new(Memory::default()));
    let a = Archiver::open(store, PREFIX, &w.header, root, kind)?;
    let (tx, archiver) = a.spawn();
    let mut n = 0u64;
    let mut ships = BTreeSet::new();
    let mut send = |queue: &Rc<RefCell<Vec<Vec<u8>>>>, at: i64| -> R<()> {
        let parts: Vec<Vec<u8>> = queue.borrow_mut().drain(..).collect();
        for p in parts {
            ships.insert(at.div_euclid(10_000_000));
            tx.send((n, p))
                .or_else(|_| refuse("archive-stopped", "the archiver stopped"))?;
            n += 1;
        }
        Ok(())
    };
    send(&queue, 0)?;
    for &(t, movers) in ticks {
        script::tick(&mut w, t, movers, 1_200);
        send(&queue, t as i64 * TICK)?;
    }
    drop(tx);
    let writes = archiver
        .join()
        .unwrap_or_else(|p| std::panic::resume_unwind(p))?;
    Ok((writes, ships.len() as u64))
}

fn dollars(writes: u64) -> f64 {
    writes as f64 * PRICE / 1e6
}

/// `count`: a busy hour and a quiet day, counted and scaled to a 30-day month.
fn count() -> R<()> {
    // Busy: K5's restart load, 100 of 1,000 bodies take a step each 50 ms tick, for an hour (72,000 ticks).
    let busy: Vec<(u64, usize)> = (0..72_000).map(|t| (t, 100)).collect();
    let (b, _) = measure(&busy)?;
    let b_month = b.total() * 720;
    println!("busy hour: {b:?}, {} writes", b.total());
    println!(
        "busy month: {} x 720 = {b_month} + O3 {O3_BUSY} = {} writes, ${:.3}",
        b.total(),
        b_month + O3_BUSY,
        dollars(b_month + O3_BUSY)
    );
    // Quiet: one act an hour (one body takes one step), for a day.
    let quiet: Vec<(u64, usize)> = (1..=24).map(|h| (h * 72_000, 1)).collect();
    let (q, ships) = measure(&quiet)?;
    let q_month = (q.total() + ships) * 30;
    println!("quiet day: {q:?}, {} writes; O3 ships {ships}", q.total());
    println!(
        "quiet month: ({} + {ships}) x 30 = {q_month} writes, ${:.4}",
        q.total(),
        dollars(q_month)
    );
    let (bt, qt) = (dollars(b_month + O3_BUSY), dollars(q_month));
    println!(
        "bars: busy ${bt:.3} < $2 {}; quiet ${qt:.4} < $0.01 {}",
        if bt < 2.0 { "MET" } else { "UNMET" },
        if qt < 0.01 { "MET" } else { "UNMET" }
    );
    // A still world: no records, so nothing archived and nothing written.
    let w = World::new();
    let (root, kind) = root_of(&w);
    let empty = Memory::default();
    let mut a = Archiver::open(&empty, PREFIX, &w.header, root, kind)?;
    a.flush()?;
    println!(
        "still: a world with no new records, {} writes",
        a.writes().total()
    );
    Ok(())
}

/// `corpus`: one small recording, its one archive object and one bundle as hex text, and the sheet naming them.
fn corpus(dir: &Path) -> R<()> {
    let store = Memory::default();
    let (mut w, queue) = logged(1, 2);
    for t in 0..20u64 {
        script::tick(&mut w, t * 20, 2, 10 * 20);
    }
    let (root, kind) = root_of(&w);
    let mut a = Archiver::open(&store, PREFIX, &w.header, root, kind.clone())?;
    for (n, p) in queue.borrow_mut().drain(..).enumerate() {
        a.push(n as u64, p)?;
    }
    a.flush()?;
    let f = fetch(&store, PREFIX)?;
    let [seg] = f.segments.as_slice() else {
        return refuse("corpus", "one object");
    };
    let stored = stored_bundles(&store, PREFIX, &f)?;
    let [bundle] = stored.as_slice() else {
        return refuse("corpus", "one bundle");
    };
    let hex = |b: &[u8]| {
        to_hex(b)
            .as_bytes()
            .chunks(120)
            .map(|c| String::from_utf8_lossy(c).into_owned() + "\n")
            .collect::<String>()
    };
    let key = &f.manifests[0].rows[0].key;
    let seg_bytes = store.get(key)?.map(|o| o.bytes).unwrap_or_default();
    if Segment::read(&seg_bytes)? != *seg {
        return refuse("corpus", "the object reads back");
    }
    let header = replica::effects::Header::read(&seg.header)?;
    let kinds: Vec<&str> = header.kinds.iter().map(|k| k.as_str()).collect();
    std::fs::create_dir_all(dir).or_else(|e| refuse("io", e.to_string()))?;
    let write = |name: &str, text: String| {
        std::fs::write(dir.join(name), text).or_else(|e| refuse("io", e.to_string()))
    };
    write("segment.hex", hex(&seg_bytes))?;
    write("bundle.hex", hex(bundle.bytes()))?;
    let sheet = format!(
        "# V18's recording corpus, entry 1 (V3, #2712): one archive object (segment.hex) and one history bundle\n\
         # (bundle.hex), as hex text. Recorded from a scripted world (`cargo run -p archive -- corpus`), never\n\
         # production. Kinds are pinned by hash in their names. Decoded by v2/tools/archive/tests/archive.rs.\n\
         build: {}\nschema: {}\nkinds: {}\nroot: {}\nroot kind: {}\nrecords: {}\nstate hash: {}\nbundle sha256: {}\n",
        to_hex(&header.build),
        to_hex(&header.schema),
        kinds.join(" "),
        to_hex(&encode(&root.to_value()).or_else(|e| refuse("encoding", e.to_string()))?),
        kind.as_str(),
        seg.records.len(),
        state_hash(&mut w.tree)?,
        to_hex(&bundle.hash()),
    );
    write("entry.txt", sheet)?;
    println!(
        "corpus entry 1: object {} bytes, bundle {} bytes, {} records",
        seg_bytes.len(),
        bundle.bytes().len(),
        seg.records.len()
    );
    Ok(())
}

/// `pack <work dir> <out dir> [at µs ...]` (V9, #2719): a stream-check run's K4 log (`<work dir>/log`, a copy if it
/// still runs) archived into `<out dir>` as files, each store key a path, with the T6 header as `header`; then each
/// moment's state hash as the archive's own `seek` gives it.
fn pack(work: &Path, out: &Path, ats: &[i64]) -> R<()> {
    let io = |e: std::io::Error| replica::effects::Refusal {
        name: "io",
        detail: e.to_string(),
    };
    let none = |name: &'static str| replica::effects::Refusal {
        name,
        detail: String::new(),
    };
    let mut dirs = vec![work.join("www")];
    let mut header = None;
    while let Some(d) = dirs.pop() {
        for e in std::fs::read_dir(&d).map_err(io)?.flatten() {
            if e.path().is_dir() {
                dirs.push(e.path());
            } else if d.ends_with("headers") {
                header = Some(std::fs::read(e.path()).map_err(io)?);
            }
        }
    }
    let header = replica::effects::Header::read(&header.ok_or_else(|| none("no-header"))?)?;
    let kind = header
        .kinds
        .iter()
        .find(|k| k.as_str().starts_with("souls:place@"))
        .cloned();
    let (_, rec) = Log::open(FileStore::open(&work.join("log"))?, 1)?;
    let store = Shared(Arc::new(Memory::default()));
    let mut a = Archiver::open(
        store.clone(),
        "",
        &header,
        header.zone,
        kind.ok_or_else(|| none("no-root"))?,
    )?;
    for (i, r) in rec.records.into_iter().enumerate() {
        a.push(rec.first + i as u64, r)?;
    }
    a.flush()?;
    for k in store.0.keys().into_iter().chain(["header".to_owned()]) {
        let bytes = if k == "header" {
            header.stored().to_vec()
        } else {
            store.get(&k)?.map(|o| o.bytes).unwrap_or_default()
        };
        let path = out.join(&k);
        std::fs::create_dir_all(path.parent().unwrap_or(out)).map_err(io)?;
        std::fs::write(&path, bytes).map_err(io)?;
    }
    for &at in ats {
        let s = archive::seek(&store, "", &header, at)?;
        println!(
            "at {at} state hash {} ({} bytes, {} requests)",
            to_hex(&s.state.hash()?.to_bytes()),
            s.bytes,
            s.requests
        );
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |i: usize| args.get(i).cloned().unwrap_or_default();
    let out = match arg(1).as_str() {
        "record" => record(Path::new(&arg(2))),
        "restore" => restore_cmd(&arg(2)),
        "count" => count(),
        "corpus" => corpus(Path::new(&arg(2))),
        "seek" => seek_bench::run(arg(2).parse().unwrap_or(24)),
        "pack" => pack(
            Path::new(&arg(2)),
            Path::new(&arg(3)),
            &args[4.min(args.len())..]
                .iter()
                .filter_map(|a| a.parse().ok())
                .collect::<Vec<_>>(),
        ),
        _ => refuse(
            "usage",
            "record <dir> | restore <hash> | count | corpus <dir> | seek [hours]",
        ),
    };
    if let Err(e) = out {
        eprintln!("archive: {e}");
        std::process::exit(1);
    }
}
