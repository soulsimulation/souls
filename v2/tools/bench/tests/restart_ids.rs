//! A restarted writer mints no id twice (Engine v2 K4b, #3136, A2), across a SIGKILL. The test runs itself again as
//! the writer: it builds rooms, takes a checkpoint holding its log place and minter, builds more rooms (ids minted
//! after the checkpoint, only in the log), says `ready` and is killed. This process then restores the checkpoint,
//! opens the log from the checkpoint's place, replays, resumes the minter and mints. Run with
//! `cargo test -p bench --test restart_ids -- --nocapture` to see what it saw.

#[path = "../src/world.rs"]
mod world;

use replica::effects::Header;
use replica::ids::{Id, Scope, Version};
use sim::checkpoint::{Blobs, Checkpoints, replay, restore, resume_minter};
use sim::log::{FileStore, HEADER_LEN, Log};
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::rc::Rc;
use world::World;

const TEST: &str = "a2_a_restarted_writer_mints_no_id_twice_across_a_sigkill";
const WRITER: &str = "SOULS_K4B_WRITER_DIR";

fn version(h: &Header, next: u64) -> Version {
    Version {
        lineage: Scope(h.lineage.0),
        zone: h.zone,
        epoch: 1,
        sequence: next,
    }
}

/// The writer process: never returns, it is killed.
fn writer(dir: &Path) -> ! {
    let (mut log, _) = Log::open(FileStore::open(&dir.join("log")).unwrap(), 1).unwrap();
    let mut c = Checkpoints::open(&dir.join("ckpt"), u64::MAX, Blobs::default()).unwrap();
    let queue: Rc<RefCell<Vec<Vec<u8>>>> = Rc::default();
    let q = queue.clone();
    let mut w = World::new();
    w.log = Some(Box::new(move |b: &[u8]| q.borrow_mut().push(b.to_vec())));
    let mut records = 0u64;
    let mut flush = |log: &mut Log<FileStore>| {
        for b in queue.borrow_mut().drain(..) {
            log.append(b).unwrap();
            records += 1;
        }
        log.wait_durable(records).unwrap();
        records
    };
    for _ in 0..3 {
        w.room(2, 3);
    }
    let records = flush(&mut log);
    let v = version(&w.header, w.tree.next());
    let at = log.durable_at();
    c.take_at(&mut w.tree, v, records, Some((at, &w.mint)), b"")
        .unwrap();
    c.wait().unwrap();
    let at_checkpoint = w.mint.next();
    // Ids minted after the checkpoint: only the log holds them.
    for _ in 0..2 {
        w.room(2, 3);
    }
    flush(&mut log);
    println!("ready checkpoint={at_checkpoint} next={}", w.mint.next());
    std::io::stdout().flush().unwrap();
    loop {
        std::thread::park();
    }
}

fn field(line: &str, key: &str) -> u64 {
    line.split(' ')
        .find_map(|kv| kv.strip_prefix(&format!("{key}=")))
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| panic!("{key} in {line:?}"))
}

#[test]
fn a2_a_restarted_writer_mints_no_id_twice_across_a_sigkill() {
    if let Some(d) = std::env::var_os(WRITER) {
        writer(Path::new(&d));
    }
    let dir: PathBuf = std::env::temp_dir().join(format!("souls-k4b-{}-a2", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", TEST, "--nocapture", "--test-threads=1"])
        .env(WRITER, &dir)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let out = child.stdout.take().unwrap();
    // The test harness prints `test <name> ... ` before it, on the same line.
    let ready = BufReader::new(out)
        .lines()
        .map(|l| l.unwrap())
        .find_map(|l| l.find("ready ").map(|i| l[i..].to_string()))
        .expect("the writer says ready");
    // SIGKILL: nothing of the writer's runs after it.
    child.kill().unwrap();
    child.wait().unwrap();
    let (at_checkpoint, next) = (field(&ready, "checkpoint"), field(&ready, "next"));

    let header = World::new().header;
    let r = restore(&dir.join("ckpt")).unwrap().expect("a checkpoint");
    let place = r.root.log.expect("the checkpoint keeps the log's place");
    let (_log, found) =
        Log::open_at(FileStore::open(&dir.join("log")).unwrap(), 1, Some(place)).unwrap();
    assert!(place.offset > HEADER_LEN as u64);
    assert_eq!(
        found.start as u64, place.offset,
        "read from the checkpoint's place"
    );
    let after = found.after(r.root.record);
    let mut tree = r.tree;
    replay(&mut tree, &header, after, 0).unwrap();
    let saved = r
        .root
        .minter
        .clone()
        .expect("the checkpoint keeps the minter");
    assert_eq!(
        saved.next(),
        at_checkpoint,
        "the counter stored is the writer's"
    );
    let mut m = resume_minter(&r.root, after).unwrap();
    assert_eq!(
        m.next(),
        next,
        "past every id minted after the checkpoint, and no further"
    );
    let state = tree.to_state();
    let held: BTreeSet<Id> = state
        .nodes
        .keys()
        .chain(state.links.keys())
        .copied()
        .collect();
    // The checkpoint's counter alone would mint again an id the log gave out after it.
    assert!(held.contains(&saved.clone().mint().unwrap()));
    let fresh: Vec<Id> = (0..1000).map(|_| m.mint().unwrap()).collect();
    assert!(
        fresh
            .iter()
            .all(|id| !held.contains(id) && id.counter() >= next)
    );
    println!(
        "A2: killed with the minter at {next}; the checkpoint holds {at_checkpoint}; {} log records after it \
         ({} bytes read from byte {}); resumed at {}; 1,000 new ids, none held ({} held)",
        after.len(),
        found.end - found.start,
        found.start,
        next,
        held.len()
    );
    std::fs::remove_dir_all(&dir).unwrap();
}
