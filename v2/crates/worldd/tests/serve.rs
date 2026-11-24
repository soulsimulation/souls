//! Engine v2 C1 (#3365): `worldd seed` makes a world folder from a loader's facts file (N2's test world, through N1's
//! loader), and `worldd serve` runs it. A Soul walks through the world's end of the gateway's socket (I1's framing);
//! the stream's files appear under `views/`; the process is killed with SIGKILL mid-run and started again: it resumes
//! from a checkpoint with the last logged tick's state hash, bodies included (A1, A2, A5).

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use replica::audience::references;
use replica::effects::{Actor, Body, Change, Part};
use replica::encode::{Name, Value, decode, encode, from_hex, to_hex};
use replica::ids::{Id, Minter, Scope, Version};
use replica::intents::{Intent, Target};
use replica::rules::json;
use sim::log::{FileStore, Log};
use sim::text::{Grade, Store};
use worldd::answers::{self, STATE};

thread_local! {
    /// The acts that had their one progress answer (C20) on this test's thread.
    static PROGRESSED: std::cell::RefCell<std::collections::BTreeSet<(Vec<u8>, u64)>> =
        std::cell::RefCell::default();
}

/// Whether `frame` is an act's progress answer (C20, W11 #4087), which the answer helpers read past. An act has at
/// most one: a second fails the test.
fn progress_once(frame: &[u8]) -> bool {
    let Some(key) = answers::progress_of(frame) else {
        return false;
    };
    let first = PROGRESSED.with(|p| p.borrow_mut().insert(key));
    assert!(first, "a second progress answer for one act");
    true
}

fn worldd() -> Command {
    Command::new(env!("CARGO_BIN_EXE_worldd"))
}

fn scratch(tag: &str) -> PathBuf {
    // Short: a Unix socket's path is at most 104 bytes on macOS.
    let d = std::env::temp_dir().join(format!("{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("a scratch folder");
    d
}

/// A running `worldd serve`, its stdout and stderr lines on one channel.
struct Served {
    child: Child,
    lines: Receiver<String>,
    /// Lines taken off the channel while waiting for another: the two pipes race (a clock thread's stderr line can
    /// come in before the main thread's stdout line printed first), so a line is never dropped for coming early.
    early: RefCell<Vec<String>>,
    /// Every line it printed, on either stream (O3c's A3 reads them all).
    all: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl Drop for Served {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn serve(dir: &Path, socket: &Path) -> Served {
    serve_with(dir, socket, &[])
}

/// `worldd serve` with `more` arguments and no backup settings.
fn serve_with(dir: &Path, socket: &Path, more: &[&std::ffi::OsStr]) -> Served {
    serve_env(dir, socket, more, &[])
}

/// `worldd serve` with `more` arguments and no backup settings but `env`'s.
fn serve_env(dir: &Path, socket: &Path, more: &[&std::ffi::OsStr], env: &[(&str, &str)]) -> Served {
    let mut c = worldd();
    c.args(["serve", "--dir"])
        .arg(dir)
        .arg("--socket")
        .arg(socket)
        .args(["--checkpoint-every", "2048"])
        .args(more)
        .env_remove("SOULS_BACKUP_URL")
        .env_remove("SOULS_BACKUP_KEY_FILE")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        c.env(k, v);
    }
    let mut child = c.spawn().expect("worldd serve starts");
    let (tx, lines) = channel();
    let all = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let out = child.stdout.take().expect("stdout");
    let err = child.stderr.take().expect("stderr");
    for pipe in [Box::new(out) as Box<dyn Read + Send>, Box::new(err)] {
        let (tx, all) = (tx.clone(), all.clone());
        std::thread::spawn(move || {
            for l in BufReader::new(pipe).lines().map_while(Result::ok) {
                if let Ok(mut a) = all.lock() {
                    a.push(l.clone());
                }
                let _ = tx.send(l);
            }
        });
    }
    Served {
        child,
        lines,
        early: RefCell::default(),
        all,
    }
}

impl Served {
    /// The first line starting with `prefix`, within 60 s.
    fn line(&self, prefix: &str) -> String {
        first_line(&self.lines, &self.early, prefix, Duration::from_secs(60)).unwrap_or_else(|| {
            // Say why: a process that ended closes its pipes and the wait ends early; what it printed says how.
            let said = self.all.lock().map(|a| a.join("\n")).unwrap_or_default();
            panic!("no line {prefix:?}; it printed:\n{said}")
        })
    }

    fn kill(mut self) {
        // SIGKILL: no flush, no goodbye.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The first line starting with `prefix`: one that came early first, else the next on the channel within `wait`,
/// keeping those passed over for a later wait.
// A real process on the real clock: the wait for its line is real time.
#[allow(clippy::disallowed_methods)]
fn first_line(
    lines: &Receiver<String>,
    early: &RefCell<Vec<String>>,
    prefix: &str,
    wait: Duration,
) -> Option<String> {
    let mut early = early.borrow_mut();
    if let Some(i) = early.iter().position(|l| l.starts_with(prefix)) {
        return Some(early.remove(i));
    }
    let end = Instant::now() + wait;
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        match lines.recv_timeout(left) {
            Ok(l) if l.starts_with(prefix) => return Some(l),
            Ok(l) => early.push(l),
            Err(_) => break,
        }
    }
    None
}

/// The clock thread's "started at tick" (stderr) can come in before the "restart:" the main thread printed first
/// (stdout): on two-core runners it did, and the wait for "restart:" dropped it, so the start looked hung (#3421).
#[test]
fn a_line_that_comes_before_the_one_awaited_is_kept_for_its_own_wait() {
    let (tx, rx) = channel();
    let early = RefCell::default();
    for l in [
        "worldd: started at tick 7 state 00",
        "restart: checkpoint None",
    ] {
        tx.send(l.to_owned()).unwrap();
    }
    let wait = Duration::from_millis(100);
    assert_eq!(
        first_line(&rx, &early, "restart: ", wait).as_deref(),
        Some("restart: checkpoint None")
    );
    assert_eq!(
        first_line(&rx, &early, "worldd: started at tick", wait).as_deref(),
        Some("worldd: started at tick 7 state 00")
    );
    assert_eq!(first_line(&rx, &early, "restart: ", wait), None);
}

// A real process on the real clock: the wait for its socket is real time.
#[allow(clippy::disallowed_methods)]
fn connect(socket: &Path) -> UnixStream {
    let end = Instant::now() + Duration::from_secs(30);
    loop {
        match UnixStream::connect(socket) {
            Ok(s) => return s,
            Err(_) if Instant::now() < end => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => panic!("the socket: {e}"),
        }
    }
}

fn walk(
    s: &mut UnixStream,
    body: Id,
    lineage: Scope,
    ground: Id,
    sequence: u64,
    x_m: i64,
    z_m: i64,
) {
    let i =
        |n: i64| u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint);
    let to = Value::Array(vec![i(x_m * 1_000_000), i(0), i(z_m * 1_000_000)]);
    send(
        s,
        body,
        lineage,
        ground,
        BTreeMap::from([(1, to)]),
        sequence,
    );
}

/// A walk in place carrying `words` (V1b: a value under T8's field 23 is kept in the world's text store and the
/// intent logged with its reference). A served world's Souls are not yet nodes a say can come from (C3's joins), so
/// the words ride on a walk, as V1b's toggle carries its sender's.
fn walk_with_words(
    s: &mut UnixStream,
    body: Id,
    lineage: Scope,
    ground: Id,
    sequence: u64,
    words: &str,
) {
    let i =
        |n: i64| u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint);
    let to = Value::Array(vec![i(-40_000_000), i(0), i(30_000_000)]);
    let w = Value::Map(BTreeMap::from([(
        worldd::words::WORDS,
        Value::Bytes(words.as_bytes().to_vec()),
    )]));
    send(
        s,
        body,
        lineage,
        ground,
        BTreeMap::from([(1, to), (2, w)]),
        sequence,
    );
}

fn send(
    s: &mut UnixStream,
    body: Id,
    lineage: Scope,
    ground: Id,
    parameters: BTreeMap<u64, Value>,
    sequence: u64,
) {
    let intent = Intent {
        actor: Actor::Soul(body),
        verb: Name::new("eden:walk").expect("a name"),
        target: Some(Target::Node(ground)),
        parameters,
        sequence,
        basis: Version {
            lineage,
            zone: Id::new(lineage, 0).expect("the zone"),
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        expiry: answers::now() + 60_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    let bytes = encode(&intent.to_value()).expect("bytes");
    s.write_all(&(bytes.len() as u32).to_be_bytes())
        .expect("sent");
    s.write_all(&bytes).expect("sent");
}

/// The next answer's kind: 1 a receipt, 2 a refusal (with its reason).
fn answer(s: &mut UnixStream) -> (u64, String) {
    // A progress answer (C20, sent as a walk's route is planned) is read past.
    let frame = loop {
        let mut len = [0u8; 4];
        s.read_exact(&mut len).expect("an answer");
        let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
        s.read_exact(&mut frame).expect("an answer");
        if !progress_once(&frame) {
            break frame;
        }
    };
    let Value::Map(m) = decode(&frame).expect("a frame").value else {
        panic!("a frame")
    };
    let Some(Value::Map(a)) = m.get(&2) else {
        panic!("an answer")
    };
    match (a.get(&3), a.get(&4)) {
        (Some(Value::Uint(k)), Some(Value::Text(t))) => (*k, t.as_str().to_owned()),
        (Some(Value::Uint(k)), _) => (*k, String::new()),
        other => panic!("an answer: {other:?}"),
    }
}

/// The state hash of the log's last tick, as the disk holds it.
fn last_state(log: &Path) -> String {
    let (l, found) = Log::open(FileStore::open(log).expect("the log"), 1).expect("opens");
    drop(l.close());
    found
        .records
        .iter()
        .rev()
        .find_map(|r| match Part::read(r).ok()?.rest.get(&STATE) {
            Some(Value::Bytes(h)) => Some(to_hex(h)),
            _ => None,
        })
        .expect("a tick with a state hash")
}

#[test]
fn a1_a2_a5_seeded_world_serves_walks_and_restarts_after_sigkill() {
    let d = scratch("c1");
    let (dir, body, root, ground) = seeded(&d);

    // A1: the first start replays the seeded log (the import's part), with the folder's entries.
    let socket = d.join("s");
    let w = serve(&dir, &socket);
    let world = w.line("world ");
    println!("{world}");
    assert!(world.ends_with("1 entries, 1 souls"), "{world}");
    println!("{}", w.line("restart: "));
    let first = w.line("worldd: started at tick");
    println!("A1: {first}");
    // No store named (O3b A1): this test is C1's, unchanged.
    serves_walks_and_restarts(w, &d, &dir, body, root, ground);
}

/// K16 (0.133): a world seeded by an older build is served by today's, under the header its log names. The older
/// build is stood for by rewriting the seeded world's header and import part as one whose code differed: its ground's
/// kind at another revision (an import loader change; every body is born under the ground) and no give (an activity
/// it did not have). Today's build rebuilds another header, so before K16 every start was refused `header-mismatch`.
/// It starts, takes the ground's kind at the world's revision, a Soul is born and walks, and it restarts from its
/// checkpoint with the last logged state (C1's run).
#[test]
fn k16_a_world_seeded_by_an_older_build_is_served_under_its_own_header() {
    use replica::effects::Header;
    fn renamed(v: Value, from: &str, to: &str) -> Value {
        match v {
            Value::Text(t) if t.as_str() == from => Value::Text(Name::new(to).unwrap()),
            Value::Array(a) => Value::Array(a.into_iter().map(|v| renamed(v, from, to)).collect()),
            Value::Map(m) => Value::Map(
                m.into_iter()
                    .map(|(k, v)| (k, renamed(v, from, to)))
                    .collect(),
            ),
            v => v,
        }
    }
    let d = scratch("k16");
    let (dir, body, root, ground) = seeded(&d);
    let today =
        Header::read(&std::fs::read(dir.join("header")).expect("the seed keeps its header"))
            .unwrap();
    let records = logged(&dir.join("log"));
    assert_eq!(records.len(), 1, "a seed's log is its import part");
    let part = Part::read(&records[0]).unwrap();
    assert_eq!(
        part.header,
        today.hash().to_bytes(),
        "the part names the kept header"
    );

    // The older build's header: the ground's kind at another revision, and no give.
    let ground_kind = today
        .kinds
        .iter()
        .find(|k| k.as_str().split('@').next() == Some(import_eden::GROUND))
        .expect("the ground's kind")
        .as_str()
        .to_owned();
    let (plain, pin) = ground_kind.split_once('@').unwrap();
    // Another SHA-256 multihash: its code and length, then the digest reversed.
    let (code, digest) = pin.split_at(4);
    let older_ground = format!("{plain}@{code}{}", digest.chars().rev().collect::<String>());
    assert_ne!(older_ground, ground_kind);
    let Value::Map(mut h) = renamed(
        decode(today.stored()).unwrap().value,
        &ground_kind,
        &older_ground,
    ) else {
        panic!("a header is a map")
    };
    let Some(Value::Array(kinds)) = h.get_mut(&6) else {
        panic!("the header's kinds")
    };
    kinds.retain(|k| !matches!(k, Value::Text(t) if t.as_str().starts_with("souls:give@")));
    let older = Header::read(&encode(&Value::Map(h)).unwrap()).unwrap();
    assert_ne!(older.kinds, today.kinds);
    let Value::Map(mut p) = renamed(
        decode(&records[0]).unwrap().value,
        &ground_kind,
        &older_ground,
    ) else {
        panic!("a part is a map")
    };
    p.insert(1, Value::Bytes(older.hash().to_bytes()));
    std::fs::remove_file(dir.join("log")).unwrap();
    let (mut log, _) = Log::open(FileStore::open(&dir.join("log")).unwrap(), 1).unwrap();
    let n = log.append(encode(&Value::Map(p)).unwrap()).unwrap();
    log.wait_durable(n + 1).unwrap();
    drop(log.close());
    std::fs::write(dir.join("header"), older.stored()).unwrap();
    // The older build's owners: its ground's revision, owned as today's, and no give.
    let owners: String = std::fs::read_to_string(dir.join("header.kinds"))
        .expect("the seed keeps its kinds' owners")
        .lines()
        .filter(|l| !l.starts_with("souls:give@"))
        .map(|l| l.replace(&ground_kind, &older_ground) + "\n")
        .collect();
    std::fs::write(dir.join("header.kinds"), owners).unwrap();

    let socket = d.join("s");
    let w = serve(&dir, &socket);
    let said = w.line("header: ");
    println!("{said}");
    assert!(
        said.contains("not this build's")
            && said.contains(&format!(
                "1 kinds taken at the world's revision [{older_ground} as {ground_kind}]"
            ))
            && said.contains(
                "1 this build pins that the world cannot make until it is reseeded [souls:give@"
            ),
        "{said}"
    );
    w.line("worldd: started at tick");
    // `world.kinds` still loads as the creator's client loads it (`replica::wasm`'s `creator_kinds`): each boot
    // line's target is a place kind its own kind lines define.
    let kinds = std::fs::read_to_string(dir.join("world.kinds")).unwrap();
    let mut defined = BTreeMap::new();
    for line in kinds.lines() {
        defined.extend(replica::world_model::parse_kinds(line).expect("a kind line or a comment"));
    }
    let targets: Vec<&str> = kinds
        .lines()
        .filter_map(|l| {
            l.strip_prefix("# souls-boot-body ")
                .or_else(|| l.strip_prefix("# souls-boot-activity ")?.split(' ').next())
        })
        .collect();
    assert!(!targets.is_empty());
    for t in targets {
        assert_eq!(
            defined.get(t).map(|k| k.owner.as_str()),
            Some("place"),
            "{t}"
        );
    }
    serves_walks_and_restarts(w, &d, &dir, body, root, ground);
}

/// K16: a world seeded before K16 keeps no header file. Served by a build whose header is the one its log names, it
/// keeps that header and serves; a later start reads it.
#[test]
fn k16_a_world_with_no_header_file_keeps_the_one_its_log_names() {
    let d = scratch("k16b");
    let (dir, ..) = seeded(&d);
    let kept = std::fs::read(dir.join("header")).unwrap();
    let owners = std::fs::read(dir.join("header.kinds")).unwrap();
    std::fs::remove_file(dir.join("header")).unwrap();
    std::fs::remove_file(dir.join("header.kinds")).unwrap();
    let w = serve(&dir, &d.join("s"));
    assert_eq!(
        w.line("header: "),
        "header: kept this build's, the one the log names"
    );
    w.line("worldd: started at tick");
    w.kill();
    assert_eq!(std::fs::read(dir.join("header")).unwrap(), kept);
    assert_eq!(std::fs::read(dir.join("header.kinds")).unwrap(), owners);
    let _ = std::fs::remove_dir_all(&d);
}

/// #4013 A1: while it loads, `serve` tells the service manager it made progress (`EXTEND_TIMEOUT_USEC`, as much as
/// the unit's 30 s `TimeoutStartSec`), then `READY=1`, and no more progress notices after it.
#[test]
fn x5_a1_serve_says_progress_while_it_loads_and_none_once_ready() {
    let d = scratch("x5");
    let (dir, ..) = seeded(&d);
    let notify = d.join("n");
    let manager = std::os::unix::net::UnixDatagram::bind(&notify).expect("a notify socket");
    manager
        .set_read_timeout(Some(Duration::from_secs(60)))
        .expect("a read timeout");
    let w = serve_env(
        &dir,
        &d.join("s"),
        &[],
        &[("NOTIFY_SOCKET", notify.to_str().expect("a path"))],
    );
    let mut said = Vec::new();
    let mut buf = [0u8; 512];
    while !said.iter().any(|s: &String| s.starts_with("READY=1")) {
        let n = manager.recv(&mut buf).expect("a notice before READY=1");
        said.push(String::from_utf8_lossy(&buf[..n]).into_owned());
    }
    let before = said
        .iter()
        .filter(|s| *s == "EXTEND_TIMEOUT_USEC=30000000")
        .count();
    println!("A1: {before} progress notices, then {:?}", said.last());
    assert!(before >= 1, "no progress before ready: {said:?}");
    // The watchdog's thread starts before READY=1, so its word may come first too.
    let other = said[..said.len() - 1]
        .iter()
        .filter(|s| *s != "EXTEND_TIMEOUT_USEC=30000000" && *s != "WATCHDOG=1")
        .count();
    assert_eq!(other, 0, "only progress and alive, then ready: {said:?}");
    // After READY=1, only the watchdog's word, twice a second: no progress notice in the next second.
    after_ready(&manager);
    drop(w);
}

// A real process on the real clock: the second read after READY=1 is real time.
#[allow(clippy::disallowed_methods)]
fn after_ready(manager: &std::os::unix::net::UnixDatagram) {
    let mut buf = [0u8; 512];
    manager
        .set_read_timeout(Some(Duration::from_millis(200)))
        .expect("a read timeout");
    let end = Instant::now() + Duration::from_secs(1);
    while Instant::now() < end {
        if let Ok(n) = manager.recv(&mut buf) {
            let s = String::from_utf8_lossy(&buf[..n]).into_owned();
            assert_eq!(s, "WATCHDOG=1", "after READY=1");
        }
    }
}

/// The seeded world: its folder, its Soul's body, its root and its ground.
fn seeded(d: &Path) -> (PathBuf, Id, Id, Id) {
    let facts = d.join("facts.json");
    std::fs::write(
        &facts,
        testworld::generate(1, 0).expect("the test world").text,
    )
    .expect("facts");
    let im = import_eden::load(&std::fs::read_to_string(&facts).unwrap()).expect("loads");
    let (root, ground) = (im.nodes["world"], im.nodes["ground"]);
    let dir = d.join("w");
    let entries = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds/doors");
    let out = worldd()
        .args(["seed", "--facts"])
        .arg(&facts)
        .arg("--dir")
        .arg(&dir)
        .arg("--entries")
        .arg(&entries)
        .args(["--souls", "1", "--at", "-40,30"])
        .output()
        .expect("seed runs");
    assert!(
        out.status.success(),
        "seed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let meta = json::parse(&std::fs::read_to_string(dir.join("world.json")).unwrap()).unwrap();
    let scope: [u8; 16] = from_hex(meta.get("souls_scope").and_then(json::Value::str).unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let body = Id::new(Scope(scope), 1).unwrap();
    assert!(
        std::fs::read_to_string(dir.join("tokens"))
            .unwrap()
            .starts_with("soul-")
    );
    (dir, body, root, ground)
}

/// Follow the actual public pointer and validate its immutable files with the supported native reader.
fn served_stream(dir: &Path) -> (u64, BTreeMap<PathBuf, Vec<u8>>) {
    use replica::effects::Header;
    use replica::stream::{Player, Pointer, public::PublicPlayer};

    let world =
        json::parse(&std::fs::read_to_string(dir.join("views/world.json")).unwrap()).unwrap();
    let stream = dir.join(world.get("stream").and_then(json::Value::str).unwrap());
    let pointer_bytes = std::fs::read(stream.join("pointer")).expect("the stream's pointer");
    let pointer = Pointer::read(&pointer_bytes).expect("a valid stream pointer");
    let Value::Map(fields) = decode(&pointer_bytes).expect("pointer CBOR").value else {
        panic!("the pointer is a map");
    };
    // stream::dir is lineage/zone/epoch/node/level/audience; headers share its epoch directory.
    let header_path = stream
        .ancestors()
        .nth(3)
        .unwrap()
        .join("headers")
        .join(to_hex(&pointer.header));
    let header_bytes = std::fs::read(&header_path).expect("the exact published header");
    let header = Header::read(&header_bytes).expect("a valid stream header");
    assert_eq!(
        pointer.header,
        header.hash().to_bytes(),
        "the pointer's header hash"
    );
    assert_eq!(
        header_path,
        dir.join("views")
            .join(replica::stream::header_path(&header))
    );
    enum Reader {
        Based(Box<PublicPlayer>),
        Legacy(Box<Player>),
    }
    let mut immutable = BTreeMap::from([(header_path, header_bytes.clone())]);
    let (parts, mut reader) = match fields.get(&8) {
        Some(Value::Bytes(generation)) => {
            assert_eq!(generation.len(), 32, "the baseline digest");
            let parts = stream.join("g").join(to_hex(generation));
            let path = parts.join("baseline");
            let baseline = std::fs::read(&path).expect("the published generation baseline");
            assert_eq!(
                replica::ids::sha256(&baseline).as_slice(),
                generation,
                "the exact baseline hash"
            );
            let player =
                PublicPlayer::start(&header_bytes, &baseline).expect("the normal based reader");
            immutable.insert(path, baseline);
            (parts, Reader::Based(Box::new(player)))
        }
        None => (
            stream,
            Reader::Legacy(Box::new(
                Player::start(&header_bytes).expect("the normal legacy reader"),
            )),
        ),
        _ => panic!("the generation is a digest"),
    };
    let newest = pointer.newest.expect("at least one genuine published part");
    let mut entries = 0;
    for number in 0..=newest {
        let path = parts.join(number.to_string());
        let bytes = std::fs::read(&path).expect("a genuine immutable numbered part");
        let played = match &mut reader {
            Reader::Based(player) => player.play(&bytes),
            Reader::Legacy(player) => player.play(&bytes),
        }
        .expect("the normal reader validates the published part");
        assert_eq!(played.number, number);
        if played.hash.is_some() {
            assert_eq!(played.hash, Some(true), "the part's hash");
        }
        entries += played.entries;
        immutable.insert(path, bytes);
    }
    assert!(entries > 0, "the first stream contains genuine effects");
    (newest + 1, immutable)
}

fn serves_walks_and_restarts(w: Served, d: &Path, dir: &Path, body: Id, root: Id, ground: Id) {
    let socket = d.join("s");
    let dir = dir.to_path_buf();
    // A Soul walks 6 m east, then a walk in flight when the process is killed.
    let mut s = connect(&socket);
    walk(&mut s, body, root.scope(), ground, 1, -34, 30);
    let (kind, why) = answer(&mut s);
    assert_eq!((kind, why.as_str()), (1, ""), "the walk ends in a receipt");
    walk(&mut s, body, root.scope(), ground, 2, -40, 36);
    std::thread::sleep(Duration::from_millis(1500));

    // A2: the stream of the zone's root is written under views/, and named by views/world.json.
    let (parts, immutable) = served_stream(&dir);
    println!("A2: {parts} genuine parts validated");

    // A5: SIGKILL mid-walk; the restart resumes from a checkpoint with the last logged tick's state.
    w.kill();
    let before = last_state(&dir.join("log"));
    let w = serve(&dir, &socket);
    let restart = w.line("restart: ");
    let started = w.line("worldd: started at tick");
    println!("A5: last logged state {before}; {restart}; {started}");
    assert!(
        restart.starts_with("restart: checkpoint Some("),
        "{restart}"
    );
    assert!(
        started.ends_with(&format!("state {before}")),
        "the state hash matches"
    );

    // The world goes on: the Soul walks again, and the repeat of an answered intent gets its kept answer.
    let mut s = connect(&socket);
    walk(&mut s, body, root.scope(), ground, 1, -34, 30);
    assert_eq!(answer(&mut s).0, 1, "the kept answer of sequence 1");
    walk(&mut s, body, root.scope(), ground, 3, -38, 30);
    assert_eq!(
        answer(&mut s),
        (1, String::new()),
        "a walk after the restart"
    );
    let (restarted_parts, restarted_files) = served_stream(&dir);
    assert!(
        restarted_parts >= parts,
        "the stream continues after restart"
    );
    for (path, bytes) in immutable {
        assert_eq!(
            restarted_files.get(&path),
            Some(&bytes),
            "published bytes survive restart"
        );
    }
    w.kill();
    let _ = std::fs::remove_dir_all(d);
}

/// #3837 A1, A2, A4: a served world whose log is compacted while it runs restarts from its newest checkpoint and the
/// log after the cut, with the last logged tick's state hash; and the same log uncompacted, replayed from record 0
/// with no checkpoint, gives the same state. The bytes before the cut are a hole on the disk.
#[test]
fn i3837_a_compacted_world_restarts_with_the_state_of_a_full_replay() {
    let d = scratch("i3837");
    let (dir, body, root, ground) = seeded(&d);
    let socket = d.join("s");
    // A second name for each file the log has been: a compaction renames a new file over `log`, and the one before
    // keeps the bytes before its cut (the same bytes at the same offsets in both).
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let keeper = {
        let (stop, log, d) = (stop.clone(), dir.join("log"), d.clone());
        std::thread::spawn(move || {
            use std::os::unix::fs::MetadataExt;
            let mut kept: Vec<(u64, PathBuf)> = Vec::new();
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                if let Ok(m) = std::fs::metadata(&log)
                    && kept.last().is_none_or(|(ino, _)| *ino != m.ino())
                {
                    let name = d.join(format!("log.keep{}", kept.len()));
                    if std::fs::hard_link(&log, &name).is_ok() {
                        kept.push((m.ino(), name));
                    }
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            kept
        })
    };
    let w = serve_with(&dir, &socket, &["--compact-after".as_ref(), "1".as_ref()]);
    w.line("worldd: started at tick");
    let mut s = connect(&socket);
    let mut compacted = None;
    for seq in 1..=60u64 {
        let x = if seq % 2 == 0 { -40 } else { -34 };
        walk(&mut s, body, root.scope(), ground, seq, x, 30);
        assert_eq!(answer(&mut s).0, 1, "walk {seq} ends in a receipt");
        compacted = first_line(
            &w.lines,
            &w.early,
            "log: compacted",
            Duration::from_millis(200),
        );
        if compacted.is_some() {
            break;
        }
    }
    let compacted = compacted.expect("the log was compacted while the world ran");
    println!("{compacted}");
    // The world goes on after the compaction, writing to the compacted file.
    walk(&mut s, body, root.scope(), ground, 100, -37, 33);
    assert_eq!(answer(&mut s).0, 1);
    std::thread::sleep(Duration::from_millis(500));
    let all = w.all.clone();
    w.kill();
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let kept = keeper.join().unwrap();
    let mut cuts: Vec<u64> = all
        .lock()
        .unwrap()
        .iter()
        .filter_map(|l| l.strip_prefix("log: compacted, kept from record "))
        .filter_map(|l| l.split("(byte ").nth(1)?.trim_end_matches(')').parse().ok())
        .collect();
    let log = dir.join("log");
    let cut = sim::log::compact::read_cut(&log)
        .unwrap()
        .expect("a cut file");
    // The last compaction may have finished after the last look that printed one.
    if kept.len() == cuts.len() + 2 {
        cuts.push(cut.at.offset);
    }
    assert_eq!(
        kept.len(),
        cuts.len() + 1,
        "a file for each compaction: {cuts:?}"
    );

    assert!(cut.at.record > 0);
    let before = last_state(&log);
    let (l, found) = Log::open(FileStore::open(&log).unwrap(), 1).unwrap();
    drop(l.close());
    assert_eq!(
        found.first, cut.at.record,
        "a compacted log is read from its cut"
    );
    {
        use std::os::unix::fs::MetadataExt;
        let m = std::fs::metadata(&log).unwrap();
        println!(
            "A2: log {} bytes long, {} on the disk, cut at record {} byte {}",
            m.len(),
            m.blocks() * 512,
            cut.at.record,
            cut.at.offset
        );
    }

    // The same log uncompacted: each file the log has been, from its cut to the next.
    let full = d.join("full");
    copy_tree(&dir, &full);
    let mut bytes = Vec::new();
    for (i, (_, path)) in kept.iter().enumerate() {
        let b = std::fs::read(path).unwrap();
        let end = cuts.get(i).map_or(b.len(), |&c| c as usize);
        bytes.extend_from_slice(&b[bytes.len()..end]);
    }
    std::fs::write(full.join("log"), bytes).unwrap();
    std::fs::remove_file(full.join("log.cut")).unwrap();
    std::fs::remove_dir_all(full.join("checkpoints")).unwrap();
    let _ = std::fs::remove_file(full.join("gateway.sock"));
    let w = serve(&full, &d.join("f"));
    let replayed = started_or_dump(&w);
    println!("A2 full replay: {replayed}");
    w.kill();

    let w = serve(&dir, &socket);
    let started = started_or_dump(&w);
    let restart = w.line("restart: ");
    println!("A1: last logged state {before}; {restart}; {started}");
    assert!(
        restart.starts_with("restart: checkpoint Some("),
        "{restart}"
    );
    assert!(
        started.ends_with(&format!("state {before}")),
        "the last logged state"
    );
    assert!(
        replayed.ends_with(&format!("state {before}")),
        "a full replay's state"
    );
    w.kill();
    let _ = std::fs::remove_dir_all(&d);
}

/// The start line, or every line the process printed when it never came.
fn started_or_dump(w: &Served) -> String {
    first_line(
        &w.lines,
        &w.early,
        "worldd: started at tick",
        Duration::from_secs(60),
    )
    .unwrap_or_else(|| panic!("no start: {:#?}", w.all.lock().unwrap()))
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (p, t) = (e.path(), to.join(e.file_name()));
        let kind = e.file_type().unwrap();
        if kind.is_dir() {
            copy_tree(&p, &t);
        } else if kind.is_file() {
            std::fs::copy(&p, &t).unwrap();
        }
    }
}

/// The log's records on the disk, from record 0.
fn logged(log: &Path) -> Vec<Vec<u8>> {
    let (l, found) = Log::open(FileStore::open(log).expect("the log"), 1).expect("opens");
    drop(l.close());
    assert_eq!(found.first, 0);
    found.records
}

/// The history in the store, read from record 0 as a full-history reader reads it: (record, bytes).
fn history(store: &impl directoryd::directory::store::Store, root: Id) -> Vec<(u64, Vec<u8>)> {
    use replica::directory::WorldRecord;
    let key = WorldRecord::key(&root.scope().0, root);
    let Some(o) = store.get(&key).expect("reads") else {
        return Vec::new();
    };
    let rec = WorldRecord::read(&o.bytes).expect("the world's record");
    let (mut at, mut out) = (0, Vec::new());
    while let Some((_, p, _)) = worldd::shipping::piece_at(store, &rec, at).expect("a piece") {
        for r in p.records {
            out.push((at, r));
            at += 1;
        }
    }
    out
}

/// Engine v2 O3b (#3458): with a store named, `worldd serve` claims its world and ships its log's records and
/// checkpoints (A1). Killed with SIGKILL mid-shipping three times, each start claims again and ships from the
/// directory's mark plus one: the history read from the store from record 0 then holds every record logged, once,
/// in order (A2). The history's header and bundles are archived under `h/<world>/<lineage>/` (A3).
// A real process on the real clock: the waits for shipping are real time.
#[allow(clippy::disallowed_methods)]
#[test]
fn o3b_a1_a2_a3_ships_history_exactly_once_across_three_kills() {
    let d = scratch("o3b");
    let spec = d.join("bucket").display().to_string();
    ships_history_across_three_kills(&d, &spec, &[]);
    // `O3B_KEEP=1` keeps the store for the page's end-to-end run.
    if std::env::var_os("O3B_KEEP").is_none() {
        let _ = std::fs::remove_dir_all(&d);
    }
}

/// O3c (#3529) A2 and A3: the same three kills with the store an S3 bucket (a local stand-in, never production's),
/// named in the offsite form with its keys in the environment. No line the world printed, and no file it wrote,
/// holds the secret or the key id.
#[test]
fn o3c_a2_a3_ships_history_to_an_s3_bucket_across_three_kills() {
    use directoryd::directory::stand_in::{KEY_ID, StandIn};
    const SECRET: &str = "stand-in-secret-0f3c";
    let d = scratch("o3c");
    let s = StandIn::start(1000).expect("a stand-in");
    let spec = format!("{}/o3c", s.url("souls"));
    let env = [
        ("AWS_ACCESS_KEY_ID", KEY_ID),
        ("AWS_SECRET_ACCESS_KEY", SECRET),
    ];
    let lines = ships_history_across_three_kills(&d, &spec, &env);
    assert!(lines.iter().any(|l| l == "store: the offsite bucket"));
    for l in &lines {
        assert!(
            !l.contains(SECRET) && !l.contains(KEY_ID),
            "a credential in {l:?}"
        );
    }
    let mut files = 0;
    let mut stack = vec![d.clone()];
    while let Some(p) = stack.pop() {
        if p.is_dir() {
            stack.extend(
                std::fs::read_dir(&p)
                    .expect("a folder")
                    .flatten()
                    .map(|e| e.path()),
            );
        } else if let Ok(bytes) = std::fs::read(&p) {
            files += 1;
            for c in [SECRET, KEY_ID] {
                assert!(
                    !bytes.windows(c.len()).any(|w| w == c.as_bytes()),
                    "a credential in {}",
                    p.display()
                );
            }
        }
    }
    println!(
        "A3: {} lines and {files} files hold no credential",
        lines.len()
    );
    assert!(
        s.paths().iter().all(|p| p.starts_with("souls/o3c/")),
        "every object under the URL's prefix"
    );
    let _ = std::fs::remove_dir_all(&d);
}

/// 0.132.1: a fresh seed whose entries have a stand point C13 moves (Eden's chess table's, inside its own solids)
/// serves. The seed built its header before the move and `serve` after it, so since G3 put an activity's stands in
/// its kind every start of a fresh Eden was refused `header-mismatch`. C13 moves a stand point only for a kind the world
/// places, and the test world places none of them, so this needs Eden's exported facts (`v2/tools/import-eden/export`).
#[test]
#[ignore = "needs .local/import-eden/eden-2026.facts.json"]
fn a_seed_whose_stand_point_is_moved_serves() {
    let facts = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../.local/import-eden/eden-2026.facts.json");
    assert!(
        facts.is_file(),
        "run v2/tools/import-eden/export/export.ts first"
    );
    let d = scratch("rn-stand");
    let dir = d.join("w");
    let entries = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let out = worldd()
        .args(["seed", "--facts"])
        .arg(&facts)
        .arg("--dir")
        .arg(&dir)
        .arg("--entries")
        .arg(&entries)
        .args(["--souls", "0"])
        .output()
        .expect("seed runs");
    let said = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "seed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        said.contains("stand point: eden:chess_table"),
        "the chess table's stand point is moved"
    );
    let w = serve_env(&dir, &d.join("s"), &[], &[]);
    w.line("listening");
    w.kill();
}

/// 0.132.1 (production, 23 Nov): a fresh Eden's first start on an S3 store writes a stream-recovery object of 11.8 MB.
/// Production's rehearsal did that on a scratch copy, and the world then started from its own folder and had to read
/// the object back. Past ureq's 10 MiB cap its public stream stopped before its first flush and the world refused to
/// serve (`public-stream: stopped before its first flush`), again and again. With the world's read cap
/// (`S3::for_world`) it serves. Two seeds of the same facts stand for the scratch copy and the world's own folder.
/// Needs Eden's exported facts (`v2/tools/import-eden/export`): the test world tops out at 4.3 MB, under the cap.
#[test]
#[ignore = "needs .local/import-eden/eden-2026.facts.json"]
fn eden_restarts_on_an_s3_store_whose_stream_recovery_object_passes_10_mib() {
    use directoryd::directory::stand_in::{KEY_ID, StandIn};
    use std::ffi::OsStr;
    let facts = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../.local/import-eden/eden-2026.facts.json");
    assert!(
        facts.is_file(),
        "run v2/tools/import-eden/export/export.ts first"
    );
    let d = scratch("rn-eden-s3");
    let entries = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let seed = |dir: &Path| {
        let out = worldd()
            .args(["seed", "--facts"])
            .arg(&facts)
            .arg("--dir")
            .arg(dir)
            .arg("--entries")
            .arg(&entries)
            .args(["--souls", "0"])
            .output()
            .expect("seed runs");
        assert!(
            out.status.success(),
            "seed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    let (scratch_copy, own) = (d.join("rehearsal"), d.join("w"));
    seed(&scratch_copy);
    seed(&own);
    let s = StandIn::start(1000).expect("a stand-in");
    let spec = format!("{}/rn", s.url("souls"));
    let env = [
        ("AWS_ACCESS_KEY_ID", KEY_ID),
        ("AWS_SECRET_ACCESS_KEY", "stand-in-secret"),
    ];
    let args = [
        OsStr::new("--store"),
        OsStr::new(&spec),
        OsStr::new("--machine"),
        OsStr::new("test-machine"),
    ];
    // The first start, on the scratch copy: a stream with nothing to recover writes its recovery objects.
    let w = serve_env(&scratch_copy, &d.join("s1"), &args, &env);
    w.line("listening");
    w.kill();
    assert!(
        s.paths().iter().any(|p| p.contains("/stream-recovery/")),
        "the first start wrote its stream's recovery objects"
    );
    // The world's own folder starts and reads them back from the store, one of them past 10 MiB.
    let w = serve_env(&own, &d.join("s2"), &args, &env);
    w.line("listening");
    let said = w.all.lock().map(|a| a.join("\n")).unwrap_or_default();
    assert!(!said.contains("the public stream stopped"), "{said}");
    w.kill();
}

/// #1960: a restart whose first reads of an S3 bucket go unanswered past the client's timeout tries them again and
/// starts; with the bucket out of reach for good it still ends, with the store's refusal, in bounded time.
// A real process on the real clock: the stalls and the bound are real time.
#[allow(clippy::disallowed_methods)]
#[test]
fn i1960_a_world_starts_through_slow_store_reads_and_ends_on_an_unreachable_store() {
    use directoryd::directory::stand_in::{KEY_ID, StandIn};
    use std::ffi::OsStr;
    let d = scratch("i1960");
    let (dir, ..) = seeded(&d);
    let socket = d.join("s");
    let env = [
        ("AWS_ACCESS_KEY_ID", KEY_ID),
        ("AWS_SECRET_ACCESS_KEY", "stand-in-secret"),
    ];
    let s = StandIn::start(1000).expect("a stand-in");
    let spec = format!("{}/i1960", s.url("souls"));
    let more = |spec: &str| {
        [
            OsStr::new("--store").to_owned(),
            OsStr::new(spec).to_owned(),
            OsStr::new("--machine").to_owned(),
            OsStr::new("test-machine").to_owned(),
        ]
    };
    let args = more(&spec);
    let args: Vec<&OsStr> = args.iter().map(|a| a.as_os_str()).collect();
    // The first start claims the world and writes its history's first objects.
    let w = serve_env(&dir, &socket, &args, &env);
    w.line("listening");
    w.kill();

    // The restart: its first two reads of the history's header (the archiver's, as production's counts read was) each
    // go unanswered for 6 s, past the client's 5 s.
    s.stall_reads(2, Duration::from_secs(6), "/header");
    let begun = Instant::now();
    let w = serve_env(&dir, &socket, &args, &env);
    w.line("listening");
    let took = begun.elapsed();
    let retried: Vec<String> = w
        .all
        .lock()
        .map(|l| l.clone())
        .unwrap_or_default()
        .into_iter()
        .filter(|l| l.starts_with("store: ") && l.contains("out of reach"))
        .collect();
    println!("restart through 2 stalled reads in {took:?}: {retried:?}");
    assert_eq!(retried.len(), 2, "the stalled read tried again twice");
    assert!(
        retried.iter().all(|l| l.contains("/header: timeout")),
        "{retried:?}"
    );
    w.kill();

    // The bucket gone: nothing listens at its address. Four tries of the first read, then the refusal.
    let gone = std::net::TcpListener::bind("127.0.0.1:0").expect("a port");
    let port = gone.local_addr().expect("its address").port();
    drop(gone);
    let args = more(&format!("s3:http://127.0.0.1:{port}/souls/i1960"));
    let args: Vec<&OsStr> = args.iter().map(|a| a.as_os_str()).collect();
    let begun = Instant::now();
    let mut w = serve_env(&dir, &socket, &args, &env);
    let ended = w.line("worldd serve: ");
    let status = w.child.wait().expect("it ends");
    let took = begun.elapsed();
    println!("unreachable: {ended} after {took:?}");
    assert!(!status.success());
    assert!(
        ended.starts_with("worldd serve: store-unreachable: "),
        "{ended}"
    );
    assert!(
        took >= Duration::from_secs(14) && took < Duration::from_secs(60),
        "four tries over the waits, bounded: {took:?}"
    );
    let _ = std::fs::remove_dir_all(&d);
}

/// R12 (0.133): a world whose public stream cannot recover from its store (as production's did on 23 Nov, a read past
/// the client's cap) never ends for it, which systemd would only repeat: it listens degraded, with no public pointer
/// (no viewers) and `health.json` naming the fault, and tries again with back-off. Once the store answers, the stream
/// serves, the pointer is back and it names a valid stream.
// A real process on the real clock: the back-off and the health file's writes are real time.
#[allow(clippy::disallowed_methods)]
#[test]
fn r12_a_world_whose_stream_store_refuses_stays_up_degraded_and_recovers_when_it_answers() {
    use directoryd::directory::stand_in::{KEY_ID, StandIn};
    use std::ffi::OsStr;
    let d = scratch("r12");
    let (dir, body, root, ground) = seeded(&d);
    let socket = d.join("s");
    let env = [
        ("AWS_ACCESS_KEY_ID", KEY_ID),
        ("AWS_SECRET_ACCESS_KEY", "stand-in-secret"),
    ];
    let s = StandIn::start(1000).expect("a stand-in");
    let spec = format!("{}/r12", s.url("souls"));
    let args = [
        OsStr::new("--store"),
        OsStr::new(&spec),
        OsStr::new("--machine"),
        OsStr::new("test-machine"),
    ];
    let health = dir.join("health.json");
    let pointer = dir.join("views/world.json");
    // Reads `health.json` until its stream says `state`; the deadline only stops a hung test.
    let stream_until = |state: &str| -> String {
        let want = format!("\"stream\":{{\"state\":\"{state}\"");
        let end = Instant::now() + Duration::from_secs(30);
        loop {
            let h = std::fs::read_to_string(&health).unwrap_or_default();
            if h.contains(&want) {
                return h;
            }
            assert!(
                Instant::now() < end,
                "no stream {state} in health.json: {h}"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    // The first start writes the stream's recovery objects to the store.
    let w = serve_env(&dir, &socket, &args, &env);
    w.line("listening");
    stream_until("serving");
    // Its backup puts the recovery chain's head last (R15).
    let end = Instant::now() + Duration::from_secs(30);
    while !s
        .paths()
        .iter()
        .any(|p| p.contains("/stream-recovery/") && p.ends_with("/head"))
    {
        assert!(Instant::now() < end, "the stream's backup wrote its head");
        std::thread::sleep(Duration::from_millis(100));
    }
    w.kill();
    // As on a new machine: no views and no spool, so the stream recovers from the store, and the store refuses those
    // reads.
    std::fs::remove_dir_all(dir.join("views")).expect("views");
    std::fs::remove_dir_all(dir.join("stream-backup")).expect("the stream's spool");
    let _ = std::fs::remove_file(&health);
    s.refuse_reads(usize::MAX, 403, "stream-recovery");
    let mut w = serve_env(&dir, &socket, &args, &env);
    let said = w.line("worldd: the public stream is degraded, no viewers: ");
    assert!(said.contains("store-error"), "{said}");
    w.line("listening");
    let _ = connect(&socket);
    let h = stream_until("degraded");
    assert!(h.contains("\"fault\":\"store-error: "), "{h}");
    assert!(!pointer.exists(), "no viewers while degraded");
    // Tried again with back-off: a second refused try, a second apart or more.
    let again = w.line("worldd: the public stream is degraded, no viewers: ");
    assert!(again.contains("try 2 refused"), "{again}");
    assert!(w.child.try_wait().expect("its state").is_none(), "still up");
    // The store answers: the next try serves.
    s.refuse_reads(0, 403, "");
    w.line("worldd: the public stream recovered after ");
    stream_until("serving");
    assert!(pointer.is_file(), "the pointer is back");
    // Recovered from the store alone, it starts a new generation (R15): a walk gives it a part to validate.
    let mut c = connect(&socket);
    walk(&mut c, body, root.scope(), ground, 1, -34, 30);
    assert_eq!(answer(&mut c).0, 1, "the walk ends in a receipt");
    std::thread::sleep(Duration::from_millis(1_500));
    let (_, files) = served_stream(&dir);
    assert!(!files.is_empty(), "it names a valid stream");
    w.kill();
    let _ = std::fs::remove_dir_all(&d);
}

/// R15 (0.133): viewers read the public stream from the machine's disk, and the store is its backup only. A 60 s store
/// stall mid-run (every write's answer lost, every read held past the client's timeout) never delays a viewer or the
/// world: the newest part or quiet mark on disk stays within 2 s of the world's time throughout, a Soul's walks are
/// answered, and `health.json` says the backup is degraded while the stream serves. Once the store answers, the backup
/// catches up by itself, with no restart. A SIGKILL while the backup is behind restarts on the spool's exact bytes;
/// a new machine (no views, no spool) recovers the same stream from the store alone, with the log's state hash.
// A real process on the real clock: the stall, the back-off and the pointer's times are real time.
#[allow(clippy::disallowed_methods)]
#[test]
fn r15_a_store_stall_delays_only_the_backup_never_a_viewer_and_it_catches_up() {
    use directoryd::directory::stand_in::{Fail, KEY_ID, StandIn};
    use replica::stream::Pointer;
    use std::ffi::OsStr;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
    const STALL: Duration = Duration::from_secs(60);
    let d = scratch("r15");
    let (dir, body, root, ground) = seeded(&d);
    let socket = d.join("s");
    let env = [
        ("AWS_ACCESS_KEY_ID", KEY_ID),
        ("AWS_SECRET_ACCESS_KEY", "stand-in-secret"),
    ];
    let s = StandIn::start(1000).expect("a stand-in");
    let spec = format!("{}/r15", s.url("souls"));
    let args = [
        OsStr::new("--store"),
        OsStr::new(&spec),
        OsStr::new("--machine"),
        OsStr::new("test-machine"),
    ];
    let health = dir.join("health.json");
    let health_says = |want: &str| -> String {
        let end = Instant::now() + Duration::from_secs(150);
        loop {
            let h = std::fs::read_to_string(&health).unwrap_or_default();
            if h.contains(want) {
                return h;
            }
            assert!(Instant::now() < end, "no {want} in health.json: {h}");
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    let stall = |on: bool| {
        if on {
            s.fail_writes(usize::MAX, Fail::Lost);
            s.stall_reads(usize::MAX, Duration::from_secs(6), "");
        } else {
            s.fail_writes(0, Fail::Lost);
            s.stall_reads(0, Duration::ZERO, "");
        }
    };
    // The store's head is the spool's: the backup is current.
    let backed_up = || {
        // The spool's one head, `stream-recovery/<stream>/head`; its objects come and go as they are backed up.
        let spool = dir.join("stream-backup");
        let mut head = None;
        let mut todo = vec![spool.clone()];
        while let Some(d) = todo.pop() {
            for e in std::fs::read_dir(&d).expect("the spool").flatten() {
                let p = e.path();
                if p.file_name().is_some_and(|n| n == "head") {
                    head = Some(p);
                } else if p.is_dir() && !p.ends_with("objects") {
                    todo.push(p);
                }
            }
        }
        let head = head.expect("the spool's head");
        let key = head
            .strip_prefix(&spool)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let bucket = supervisor::bucket::Bucket::parse(&spec, |k| {
            env.iter()
                .find(|(n, _)| *n == k)
                .map_or(String::new(), |(_, v)| (*v).to_owned())
        })
        .expect("the store");
        use directoryd::directory::store::Store;
        let end = Instant::now() + Duration::from_secs(150);
        loop {
            let there = bucket.get(&key).ok().flatten().map(|o| o.bytes);
            if there.is_some() && there == std::fs::read(&head).ok() {
                return;
            }
            assert!(Instant::now() < end, "the store's head is the spool's");
            std::thread::sleep(Duration::from_millis(200));
        }
    };
    // A Soul walks back and forth until told to stop: each walk answered is the world going on.
    let seq = Arc::new(AtomicU64::new(0));
    let walker = |stop: Arc<AtomicBool>| {
        let (socket, seq) = (socket.clone(), Arc::clone(&seq));
        std::thread::spawn(move || {
            let mut c = connect(&socket);
            let mut answered = 0u64;
            while !stop.load(Ordering::Relaxed) {
                let n = seq.fetch_add(1, Ordering::Relaxed) + 1;
                let x = if n % 2 == 0 { -40 } else { -34 };
                walk(&mut c, body, root.scope(), ground, n, x, 30);
                assert_eq!(answer(&mut c).0, 1, "walk {n} ends in a receipt");
                answered += 1;
            }
            answered
        })
    };
    // What a viewer sees: how far the newest part or quiet mark on disk is behind the world's time, sampled every
    // 100 ms; the most, µs.
    let worst = Arc::new(AtomicI64::new(0));
    let looking = Arc::new(AtomicBool::new(true));
    let viewer = {
        let (dir, worst, looking) = (dir.clone(), Arc::clone(&worst), Arc::clone(&looking));
        std::thread::spawn(move || {
            let mut samples = 0u64;
            while looking.load(Ordering::Relaxed) {
                let world = json::parse(
                    &std::fs::read_to_string(dir.join("views/world.json")).unwrap_or_default(),
                );
                let stream = world.ok().and_then(|w| {
                    w.get("stream")
                        .and_then(json::Value::str)
                        .map(str::to_owned)
                });
                if let Some(p) = stream
                    .and_then(|s| std::fs::read(dir.join(s).join("pointer")).ok())
                    .and_then(|b| Pointer::read(&b).ok())
                {
                    let wall_ms = i64::try_from(
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_millis(),
                    )
                    .unwrap();
                    let world_now = p.anchor_world + (wall_ms - p.anchor_wall_ms as i64) * 1000;
                    let shown = p.newest_to.max(p.quiet_until).unwrap_or(p.anchor_world);
                    worst.fetch_max(world_now - shown, Ordering::Relaxed);
                    samples += 1;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            samples
        })
    };

    let mut w = serve_env(&dir, &socket, &args, &env);
    w.line("listening");
    health_says("\"stream\":{\"state\":\"serving\"}");
    health_says("\"stream_backup\":{\"state\":\"current\"}");
    let stop = Arc::new(AtomicBool::new(false));
    let walking = walker(Arc::clone(&stop));
    std::thread::sleep(Duration::from_secs(3));
    backed_up();
    let before = worst.swap(0, Ordering::Relaxed);
    println!(
        "viewer delay before the stall: at most {} ms",
        before / 1000
    );
    // Under 2 s on a quiet machine. On one loaded by other tests (the whole file runs at once, a debug build), the
    // stream's own cadence slows with no stall at all, so the bar follows what was measured before the stall: what is
    // measured is that the stall adds nothing a viewer waits on.
    let bar = 2_000_000.max(before * 3 / 2 + 500_000);

    // The stall: the stream serves on, the backup falls behind and says so.
    stall(true);
    let began = Instant::now();
    let said = w.line("worldd: the public stream's backup is behind, viewers unaffected: ");
    assert!(said.contains("store-unreachable"), "{said}");
    let h = health_says("\"stream_backup\":{\"state\":\"degraded\"");
    assert!(h.contains("\"stream\":{\"state\":\"serving\"}"), "{h}");
    std::thread::sleep(STALL.saturating_sub(began.elapsed()));
    let h = health_says("\"stream_backup\":{\"state\":\"degraded\"");
    let behind: u64 = h
        .split("\"behind\":")
        .nth(1)
        .and_then(|r| r.split([',', '}']).next()?.parse().ok())
        .unwrap_or(0);
    let during = worst.swap(0, Ordering::Relaxed);
    println!(
        "viewer delay during the {} s stall: at most {} ms; {behind} objects wait",
        STALL.as_secs(),
        during / 1000
    );
    assert!(
        during < bar,
        "a viewer is never 2 s behind (or the unstalled delay and 0.5 s on a loaded machine): {during} µs"
    );
    assert!(behind > 0, "the backup waits on the store: {h}");
    assert!(w.child.try_wait().expect("its state").is_none(), "still up");

    // The store answers: the backup catches up by itself.
    stall(false);
    let answered = Instant::now();
    w.line("worldd: the public stream's backup caught up after ");
    health_says("\"stream_backup\":{\"state\":\"current\"}");
    backed_up();
    println!(
        "the backup caught up {} ms after the store answered",
        answered.elapsed().as_millis()
    );
    stop.store(true, Ordering::Relaxed);
    let walks = walking.join().expect("the walker");
    println!("{walks} walks answered across the stall");
    assert!(walks > 3, "the world went on: {walks}");
    let after = worst.swap(0, Ordering::Relaxed);
    println!(
        "viewer delay while it catches up: at most {} ms",
        after / 1000
    );
    assert!(after < bar, "nor while it catches up: {after} µs");

    // A SIGKILL while the backup is behind: the restart publishes on from the spool's exact bytes.
    stall(true);
    let stop = Arc::new(AtomicBool::new(false));
    let walking = walker(Arc::clone(&stop));
    w.line("worldd: the public stream's backup is behind, viewers unaffected: ");
    std::thread::sleep(Duration::from_secs(2));
    stop.store(true, Ordering::Relaxed);
    walking.join().expect("the walker");
    let (_, published) = served_stream(&dir);
    w.kill();
    stall(false);
    let w = serve_env(&dir, &socket, &args, &env);
    w.line("listening");
    let stop = Arc::new(AtomicBool::new(false));
    let walking = walker(Arc::clone(&stop));
    std::thread::sleep(Duration::from_secs(2));
    stop.store(true, Ordering::Relaxed);
    walking.join().expect("the walker");
    // R16: the restart (a new claim) rolls its generation over at once, so the stream it serves is a new generation;
    // the files viewers were shown stay where they were, with their bytes.
    served_stream(&dir);
    for (path, bytes) in &published {
        assert_eq!(
            std::fs::read(path).ok().as_ref(),
            Some(bytes),
            "published bytes survive the kill"
        );
    }
    backed_up();
    looking.store(false, Ordering::Relaxed);
    println!("{} viewer samples", viewer.join().expect("the viewer"));
    w.kill();

    // A new machine: no views, no spool. The stream recovers from the store alone, in a new generation, and the world's
    // state is its log's. Twice: once with the backup current, and once with the store's head behind what viewers
    // were shown (its head's writes refused, then SIGKILL): no address of that lost tail is cut again.
    for lagging in [false, true] {
        let w = serve_env(&dir, &socket, &args, &env);
        w.line("listening");
        if lagging {
            s.refuse_writes(usize::MAX, 503, "/head");
        }
        let stop = Arc::new(AtomicBool::new(false));
        let walking = walker(Arc::clone(&stop));
        std::thread::sleep(Duration::from_secs(3));
        stop.store(true, Ordering::Relaxed);
        walking.join().expect("the walker");
        std::thread::sleep(Duration::from_millis(1_500));
        if lagging {
            w.line("worldd: the public stream's backup is behind, viewers unaffected: ");
        } else {
            backed_up();
        }
        let shown = views_files(&dir);
        let generation = generation_of(&dir);
        w.kill();
        s.refuse_writes(0, 503, "");
        let state = last_state(&dir.join("log"));
        std::fs::remove_dir_all(dir.join("views")).expect("views");
        std::fs::remove_dir_all(dir.join("stream-backup")).expect("the spool");
        let w = serve_env(&dir, &socket, &args, &env);
        let started = w.line("worldd: started at tick");
        assert!(started.ends_with(&format!("state {state}")), "{started}");
        w.line("listening");
        health_says("\"stream\":{\"state\":\"serving\"}");
        let stop = Arc::new(AtomicBool::new(false));
        let walking = walker(Arc::clone(&stop));
        std::thread::sleep(Duration::from_secs(2));
        stop.store(true, Ordering::Relaxed);
        walking.join().expect("the walker");
        served_stream(&dir);
        assert_ne!(generation_of(&dir), generation, "a new generation");
        let again = views_files(&dir);
        let mut same = 0;
        for (path, bytes) in &again {
            if let Some(b) = shown.get(path) {
                assert_eq!(
                    b, bytes,
                    "no address viewers were shown is cut again: {path:?}"
                );
                same += 1;
            }
        }
        println!(
            "new machine (store {}): {same} files the same, none cut again",
            if lagging { "behind" } else { "current" }
        );
        w.kill();
    }
    let _ = std::fs::remove_dir_all(&d);
}

/// R15 (0.133): one writer per chain. An old instance of a world (stopped, not dead) and a new one copied from it
/// share the store's chain; the new one backs up its head; the old one, woken, finds the store's head neither its own
/// nor the one it wrote against, and is fenced for good: it never overwrites the new one's head, says so in
/// `health.json` and the journal, and its stream goes on serving from its disk.
// A real process on the real clock: the backup's passes are real time.
#[allow(clippy::disallowed_methods)]
#[test]
fn r15_an_old_writer_is_fenced_and_never_overwrites_a_new_one_s_head() {
    use directoryd::directory::stand_in::{KEY_ID, StandIn};
    use directoryd::directory::store::Store;
    use std::ffi::OsStr;
    let d = scratch("r15f");
    let (dir, body, root, ground) = seeded(&d);
    let env = [
        ("AWS_ACCESS_KEY_ID", KEY_ID),
        ("AWS_SECRET_ACCESS_KEY", "stand-in-secret"),
    ];
    let s = StandIn::start(1000).expect("a stand-in");
    let spec = format!("{}/r15f", s.url("souls"));
    let args = [
        OsStr::new("--store"),
        OsStr::new(&spec),
        OsStr::new("--machine"),
        OsStr::new("test-machine"),
    ];
    let bucket = supervisor::bucket::Bucket::parse(&spec, |k| {
        env.iter()
            .find(|(n, _)| *n == k)
            .map_or(String::new(), |(_, v)| (*v).to_owned())
    })
    .expect("the store");
    let head_key = || {
        s.paths()
            .into_iter()
            .find(|p| p.contains("/stream-recovery/") && p.ends_with("/head"))
            .map(|p| p.trim_start_matches("souls/r15f/").to_owned())
    };
    let store_head = |key: &str| bucket.get(key).ok().flatten().map(|o| o.bytes);
    let until = |what: &str, ok: &dyn Fn() -> bool| {
        let end = Instant::now() + Duration::from_secs(60);
        while !ok() {
            assert!(Instant::now() < end, "{what}");
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    let walks = |socket: &Path, from: u64| {
        let mut c = connect(socket);
        for n in from..from + 2 {
            let x = if n % 2 == 0 { -40 } else { -34 };
            walk(&mut c, body, root.scope(), ground, n, x, 30);
            assert_eq!(answer(&mut c).0, 1, "walk {n} ends in a receipt");
        }
    };
    // The old instance serves and backs up its head.
    let old_socket = d.join("s-old");
    let old = serve_env(&dir, &old_socket, &args, &env);
    old.line("listening");
    walks(&old_socket, 1);
    until("the old writer's head is in the store", &|| {
        head_key().is_some()
    });
    let key = head_key().unwrap();
    let spooled = dir.join("stream-backup").join(&key);
    until("the store holds the old writer's head", &|| {
        store_head(&key) == std::fs::read(&spooled).ok()
    });
    // It stops (as a hung or partitioned process does), and a new instance starts from a copy of its folder.
    let pid = old.child.id().to_string();
    let stopped = Command::new("kill").args(["-STOP", &pid]).status();
    assert!(stopped.expect("kill").success(), "the old writer stopped");
    let new_dir = d.join("new");
    copy_tree(&dir, &new_dir);
    let _ = std::fs::remove_file(new_dir.join("gateway.sock"));
    let new_socket = d.join("s-new");
    let new = serve_env(&new_dir, &new_socket, &args, &env);
    new.line("listening");
    walks(&new_socket, 100);
    let new_spooled = new_dir.join("stream-backup").join(&key);
    until("the store holds the new writer's head", &|| {
        let h = store_head(&key);
        h.is_some() && h == std::fs::read(&new_spooled).ok() && h != std::fs::read(&spooled).ok()
    });
    let theirs = store_head(&key);
    // The old one wakes and writes on: its backup is fenced, the new one's head stays.
    let woke = Command::new("kill").args(["-CONT", &pid]).status();
    assert!(woke.expect("kill").success(), "the old writer woke");
    walks(&old_socket, 200);
    let said = old.line("worldd: the public stream's backup is fenced, viewers unaffected: ");
    assert!(said.contains("stream-backup-fenced"), "{said}");
    let health = dir.join("health.json");
    until("the old writer's health says fenced", &|| {
        std::fs::read_to_string(&health)
            .unwrap_or_default()
            .contains("\"stream_backup\":{\"state\":\"fenced\"")
    });
    walks(&old_socket, 300);
    std::thread::sleep(Duration::from_secs(3));
    let after = store_head(&key);
    assert!(
        after == theirs || after == std::fs::read(&new_spooled).ok(),
        "the old writer never put over the new one's head"
    );
    assert_ne!(
        after,
        std::fs::read(&spooled).ok(),
        "the store's head is not the old writer's"
    );
    assert!(
        std::fs::read_to_string(&health)
            .unwrap_or_default()
            .contains("\"stream\":{\"state\":\"serving\"}"),
        "the old writer's stream still serves from its disk"
    );
    old.kill();
    new.kill();
    let _ = std::fs::remove_dir_all(&d);
}

/// R15 (0.133): a world whose stream's backup is behind (every write to the store refused) and that goes to sleep
/// sleeps properly: the stream's bounded wait for its backup stays inside the sleep watch's wait for its answer, so the
/// watch hears it and the world exits asleep with a sleeping pointer. Never a world that stays up while its stream has
/// stopped and its pointer says still.
// A real process on the real clock: the quiet minute before a sleep is real time.
#[allow(clippy::disallowed_methods)]
#[test]
fn r15_a_world_whose_backup_is_behind_sleeps_properly() {
    use directoryd::directory::stand_in::{KEY_ID, StandIn};
    use std::ffi::OsStr;
    use std::os::unix::net::UnixListener;
    let d = scratch("r15s");
    let (dir, ..) = seeded(&d);
    let socket = d.join("s");
    let env = [
        ("AWS_ACCESS_KEY_ID", KEY_ID),
        ("AWS_SECRET_ACCESS_KEY", "stand-in-secret"),
    ];
    let s = StandIn::start(1000).expect("a stand-in");
    let spec = format!("{}/r15s", s.url("souls"));
    // The machine's alarm daemon, standing in: every alarm acknowledged.
    let alarms = d.join("alarms");
    let daemon = UnixListener::bind(&alarms).expect("the alarm socket");
    std::thread::spawn(move || {
        for mut c in daemon.incoming().flatten() {
            let mut line = String::new();
            let _ = BufReader::new(c.try_clone().unwrap()).read_line(&mut line);
            let _ = c.write_all(b"ok\n");
        }
    });
    let args = [
        OsStr::new("--store"),
        OsStr::new(&spec),
        OsStr::new("--machine"),
        OsStr::new("test-machine"),
        OsStr::new("--sleep"),
        alarms.as_os_str(),
        OsStr::new("--world-name"),
        OsStr::new("r15s"),
    ];
    let mut w = serve_env(&dir, &socket, &args, &env);
    w.line("listening");
    let health = dir.join("health.json");
    s.refuse_writes(usize::MAX, 503, "");
    w.line("worldd: the public stream's backup is behind, viewers unaffected: ");
    let end = Instant::now() + Duration::from_secs(150);
    let status = loop {
        if let Some(status) = w.child.try_wait().expect("its state") {
            break Some(status);
        }
        if Instant::now() > end {
            break None;
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    let said = w.all.lock().unwrap().join("\n");
    assert!(
        !said.contains("the public stream did not answer"),
        "the watch heard the stream:\n{said}"
    );
    assert!(
        !said.contains("the public stream stopped"),
        "the stream never stopped:\n{said}"
    );
    let h = std::fs::read_to_string(&health).unwrap_or_default();
    let status = status.unwrap_or_else(|| panic!("it never slept:\n{h}\n{said}"));
    assert_eq!(status.code(), Some(75), "it exits asleep:\n{said}");
    assert!(said.contains("asleep: next due"), "{said}");
    let world =
        json::parse(&std::fs::read_to_string(dir.join("views/world.json")).unwrap()).unwrap();
    let stream = dir.join(world.get("stream").and_then(json::Value::str).unwrap());
    let Value::Map(p) = decode(&std::fs::read(stream.join("pointer")).unwrap())
        .unwrap()
        .value
    else {
        panic!("the pointer is a map")
    };
    assert!(p.contains_key(&11), "the pointer says asleep");
    println!("it slept, its backup behind");
    // R16: the wake (a new claim) keeps the generation it slept on: the sleep marked the spool clean, so no new seed
    // and baseline are written.
    let slept_on = p.get(&8).cloned().expect("a generation");
    let generations = || std::fs::read_dir(stream.join("g")).unwrap().count();
    let before = generations();
    s.refuse_writes(0, 503, "");
    let w = serve_env(&dir, &socket, &args, &env);
    w.line("listening");
    let Value::Map(p) = decode(&std::fs::read(stream.join("pointer")).unwrap())
        .unwrap()
        .value
    else {
        panic!("the pointer is a map")
    };
    assert_eq!(p.get(&8), Some(&slept_on), "the wake keeps the generation");
    assert_eq!(generations(), before, "and makes no new one");
    println!("it woke on the generation it slept on");
    w.kill();
    let _ = std::fs::remove_dir_all(&d);
}

/// R15 (0.133): a store-only recovery (a new machine) whose store head is a generation with no parts serves at once:
/// its fresh generation waits for the world to move past the recovered cursor, so it never rebuilds the baseline the
/// store names, and it is never refused or degraded for it.
// A real process on the real clock: the backup's passes are real time.
#[allow(clippy::disallowed_methods)]
#[test]
fn r15_a_new_machine_on_a_generation_with_no_parts_serves() {
    use directoryd::directory::stand_in::{KEY_ID, StandIn};
    use directoryd::directory::store::Store;
    use std::ffi::OsStr;
    let d = scratch("r15g");
    let (dir, body, root, ground) = seeded(&d);
    let socket = d.join("s");
    let keys = [
        ("AWS_ACCESS_KEY_ID", KEY_ID),
        ("AWS_SECRET_ACCESS_KEY", "stand-in-secret"),
    ];
    // Every part closes its generation: the store's head is a generation with no parts once the backup is current.
    let every_part = [keys[0], keys[1], ("SOULS_STREAM_GENERATION_PARTS", "1")];
    let s = StandIn::start(1000).expect("a stand-in");
    let spec = format!("{}/r15g", s.url("souls"));
    let args = [
        OsStr::new("--store"),
        OsStr::new(&spec),
        OsStr::new("--machine"),
        OsStr::new("test-machine"),
    ];
    let bucket = supervisor::bucket::Bucket::parse(&spec, |k| {
        keys.iter()
            .find(|(n, _)| *n == k)
            .map_or(String::new(), |(_, v)| (*v).to_owned())
    })
    .expect("the store");
    let w = serve_env(&dir, &socket, &args, &every_part);
    w.line("listening");
    let mut c = connect(&socket);
    for n in 1..=2u64 {
        walk(
            &mut c,
            body,
            root.scope(),
            ground,
            n,
            if n % 2 == 0 { -40 } else { -34 },
            30,
        );
        assert_eq!(answer(&mut c).0, 1, "walk {n} ends in a receipt");
    }
    std::thread::sleep(Duration::from_millis(1_500));
    // The store's head, once it is the spool's: a rollover's manifest (no previous manifest, no chunk).
    let key = s
        .paths()
        .into_iter()
        .find(|p| p.contains("/stream-recovery/") && p.ends_with("/head"))
        .map(|p| p.trim_start_matches("souls/r15g/").to_owned())
        .expect("a head in the store");
    let spooled = dir.join("stream-backup").join(&key);
    let prefix = key.trim_end_matches("head").to_owned();
    // Whether `head` names a generation's first manifest (no previous one) with no part (no chunk).
    let no_parts = |head: &[u8]| -> bool {
        let Ok(Value::Map(h)) = decode(head).map(|d| d.value) else {
            return false;
        };
        let Some(Value::Bytes(manifest)) = h.get(&1) else {
            return false;
        };
        let Ok(Some(m)) = bucket.get(&format!("{prefix}objects/{}", to_hex(manifest))) else {
            return false;
        };
        let Ok(Value::Map(m)) = decode(&m.bytes).map(|d| d.value) else {
            return false;
        };
        m.get(&2) == Some(&Value::Bytes(Vec::new())) && m.get(&3) == Some(&Value::Bytes(Vec::new()))
    };
    // The world is still now; its last cut rolled over, and its backup puts that head last.
    let end = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(there) = bucket.get(&key).ok().flatten().map(|o| o.bytes)
            && Some(&there) == std::fs::read(&spooled).ok().as_ref()
            && no_parts(&there)
        {
            break;
        }
        assert!(
            Instant::now() < end,
            "the store holds the spool's head, a generation with no parts"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    let generation = generation_of(&dir);
    w.kill();
    // A new machine: no views, no spool.
    std::fs::remove_dir_all(dir.join("views")).expect("views");
    std::fs::remove_dir_all(dir.join("stream-backup")).expect("the spool");
    let w = serve_env(&dir, &socket, &args, &keys);
    w.line("listening");
    let health = dir.join("health.json");
    let end = Instant::now() + Duration::from_secs(5);
    while !std::fs::read_to_string(&health)
        .unwrap_or_default()
        .contains("\"stream\":{\"state\":\"serving\"}")
    {
        assert!(Instant::now() < end, "it serves within one back-off");
        std::thread::sleep(Duration::from_millis(100));
    }
    let mut c = connect(&socket);
    for n in 3..=6u64 {
        walk(
            &mut c,
            body,
            root.scope(),
            ground,
            n,
            if n % 2 == 0 { -40 } else { -34 },
            30,
        );
        assert_eq!(answer(&mut c).0, 1, "walk {n} ends in a receipt");
    }
    std::thread::sleep(Duration::from_millis(1_500));
    let said = w.all.lock().unwrap().join("\n");
    assert!(
        !said.contains("the public stream is degraded"),
        "never degraded:\n{said}"
    );
    served_stream(&dir);
    assert_ne!(generation_of(&dir), generation, "a new generation");
    w.kill();
    let _ = std::fs::remove_dir_all(&d);
}

/// Every file under `dir/views`, but those mid-write (`.tmp`) or gone as they are read.
fn views_files(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut all = BTreeMap::new();
    let mut todo = vec![dir.join("views")];
    while let Some(d) = todo.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                todo.push(p);
            } else if p.extension().is_none_or(|x| x != "tmp")
                && !p.ends_with("pointer")
                && !p.ends_with("world.json")
                && let Ok(b) = std::fs::read(&p)
            {
                all.insert(p, b);
            }
        }
    }
    all
}

/// The generation (field 8, its baseline's digest) the served stream's pointer names.
fn generation_of(dir: &Path) -> Vec<u8> {
    let world =
        json::parse(&std::fs::read_to_string(dir.join("views/world.json")).unwrap()).unwrap();
    let stream = dir.join(world.get("stream").and_then(json::Value::str).unwrap());
    let Value::Map(fields) = decode(&std::fs::read(stream.join("pointer")).unwrap())
        .unwrap()
        .value
    else {
        panic!("the pointer is a map")
    };
    match fields.get(&8) {
        Some(Value::Bytes(g)) => g.clone(),
        other => panic!("the pointer names its generation: {other:?}"),
    }
}

/// O3b's kill test over the store `spec` names, with `env` set for the world: every line the world printed.
// A real process on the real clock: the waits for shipping are real time.
#[allow(clippy::disallowed_methods)]
fn ships_history_across_three_kills(d: &Path, spec: &str, env: &[(&str, &str)]) -> Vec<String> {
    use directoryd::directory::store::Store;
    use std::ffi::OsStr;
    let (dir, body, root, ground) = seeded(d);
    let socket = d.join("s");
    let bucket = supervisor::bucket::Bucket::parse(spec, |k| {
        env.iter()
            .find(|(n, _)| *n == k)
            .map_or(String::new(), |(_, v)| (*v).to_owned())
    })
    .expect("the store");
    let more = [
        OsStr::new("--store"),
        OsStr::new(spec),
        OsStr::new("--machine"),
        OsStr::new("test-machine"),
    ];
    let mut printed = Vec::new();
    // Each run walks, then is killed with SIGKILL while records wait to be shipped (the seal age is about 9 s). The
    // second walks again 11 s in, after a piece and the checkpoint pointer landed and moved the mark, so the third
    // start resumes in the middle of the log.
    let mut seq = 0;
    let mut froms = Vec::new();
    for (run, again) in [false, true, false].into_iter().enumerate() {
        let w = serve_env(&dir, &socket, &more, env);
        let shipping = w.line("shipping: ");
        println!("run {run}: {shipping}");
        let from: u64 = shipping
            .strip_prefix(&format!("shipping: epoch {} from record ", run + 1))
            .and_then(|r| r.split(' ').next()?.parse().ok())
            .unwrap_or_else(|| panic!("{shipping}"));
        froms.push(from);
        // The records the start hands the shipper wait from here; the kill comes before they seal.
        let handed = Instant::now();
        w.line("listening");
        let mut s = connect(&socket);
        for k in 0..1 + usize::from(again) {
            if k > 0 {
                std::thread::sleep(Duration::from_millis(11_000));
            }
            seq += 1;
            let x = if seq % 2 == 0 { -38 } else { -34 };
            walk(&mut s, body, root.scope(), ground, seq, x, 30);
            assert_eq!(answer(&mut s).0, 1, "the walk ends in a receipt");
        }
        // 1.5 s for the walk's records to reach the disk, but never past 8 s after the start handed its records over
        // (a piece seals at about 9 s): a start that replays a longer public stream (#3799) is still killed mid-shipping.
        let last = if again { Instant::now() } else { handed };
        let seal = last + Duration::from_millis(8_000);
        std::thread::sleep(
            Duration::from_millis(1_500).min(seal.saturating_duration_since(Instant::now())),
        );
        let landed = history(&bucket, root).len();
        printed.push(w.all.clone());
        w.kill();
        let on_disk = logged(&dir.join("log")).len();
        println!("run {run}: SIGKILL, {landed} of {on_disk} records off the machine");
        assert!(landed < on_disk, "killed mid-shipping");
    }
    assert!(
        froms[2] > 0,
        "the third start resumes past the mark: {froms:?}"
    );
    // A last start ships what the kills left: every record logged before it, once, in order.
    let before = logged(&dir.join("log")).len();
    let w = serve_env(&dir, &socket, &more, env);
    println!("last run: {}", w.line("shipping: "));
    w.line("listening");
    // A3: walks either side of a minute of world time (the machine's clock) close a bundle, and the archiver writes
    // its day's index.
    let name = format!("{0}-{0}-{1}", to_hex(&root.scope().0), root.counter());
    let hist = format!("h/{name}/{}/", to_hex(&root.scope().0));
    let mut s = connect(&socket);
    let mut moment = 0;
    for k in 0..2 {
        if k > 0 {
            let now = answers::now();
            let next = (now / 60_000_000 + 1) * 60_000_000;
            std::thread::sleep(Duration::from_micros((next - now) as u64 + 1_500_000));
        }
        seq += 1;
        let x = if seq % 2 == 0 { -38 } else { -34 };
        walk(&mut s, body, root.scope(), ground, seq, x, 30);
        assert_eq!(answer(&mut s).0, 1, "the walk ends in a receipt");
        if k == 0 {
            moment = answers::now();
        }
    }
    let indexed = || {
        bucket
            .list(&format!("{hist}bundles/"))
            .expect("lists")
            .iter()
            .any(|k| k.ends_with("/index"))
    };
    let end = Instant::now() + Duration::from_secs(30);
    while (history(&bucket, root).len() < before || !indexed()) && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(500));
    }
    printed.push(w.all.clone());
    w.kill();
    let h = history(&bucket, root);
    let log = logged(&dir.join("log"));
    println!(
        "A2: {} records read from record 0, {} logged before the last start, {} on the disk",
        h.len(),
        before,
        log.len()
    );
    assert!(
        h.len() >= before,
        "every record logged before the last start"
    );
    for (n, (at, bytes)) in h.iter().enumerate() {
        assert_eq!(*at, n as u64, "in order, each once");
        assert_eq!(bytes, &log[n], "record {n} as logged");
    }
    // A3: the history's header and a day's bundle index, as the page reads them (`v2/tools/ops/o3b-history.mjs`).
    assert!(
        bucket
            .get(&format!("{hist}header"))
            .expect("reads")
            .is_some(),
        "the history's header"
    );
    assert!(indexed(), "a bundle and its day's index");
    println!(
        "A3: history {spec}/{hist} world {name} lineage {} at {moment}",
        to_hex(&root.scope().0)
    );
    printed
        .iter()
        .flat_map(|a| a.lock().map(|l| l.clone()).unwrap_or_default())
        .collect()
}

/// Every text-store reference the log at `log` holds (its parts' intents carry them in place of words).
fn references_in(log: &Path) -> Vec<Id> {
    let (l, found) = Log::open(FileStore::open(log).expect("the log"), 1).expect("opens");
    drop(l.close());
    let mut out = std::collections::BTreeSet::new();
    for r in found.records.iter().filter(|r| !sim::recorder::is_input(r)) {
        out.extend(references(&Value::Map(
            Part::read(r).expect("a part").rest.clone(),
        )));
    }
    out.into_iter().collect()
}

/// The body born for `soul` (C3, #3367): a Soul's first intent births its body, and its words are kept for that body,
/// so they read by it. From the log: the `souls:body-of` link from the body to `soul`.
fn born_body(log: &Path, soul: Id) -> Id {
    let (l, found) = Log::open(FileStore::open(log).expect("the log"), 1).expect("opens");
    drop(l.close());
    found
        .records
        .iter()
        .filter(|r| !sim::recorder::is_input(r))
        .flat_map(|r| Part::read(r).expect("a part").effects)
        .filter_map(|e| match e.body {
            Body::Changes(c) => Some(c),
            _ => None,
        })
        .flatten()
        .find_map(|c| match c.change {
            Change::Link {
                ty, ends: [b, s], ..
            } if ty.as_str() == "souls:body-of" && s == soul => Some(b),
            _ => None,
        })
        .expect("a body born for the Soul")
}

/// O20b (#3523) A1: `worldd serve` keeps a world's words in `<dir>/log.text`. Sentences said before a SIGKILL read
/// after the world is started again, and one erased while it is down stays refused `removed` across the next start.
#[test]
fn o20b_a1_served_words_outlive_sigkill_and_erased_stay_refused() {
    let d = scratch("o20b");
    let (dir, body, root, ground) = seeded(&d);
    let socket = d.join("s");
    let lines = ["the bread is still warm", "a sentence someone erased"];
    let w = serve(&dir, &socket);
    w.line("worldd: started at tick");
    let mut s = connect(&socket);
    for (n, l) in lines.iter().enumerate() {
        walk_with_words(&mut s, body, root.scope(), ground, n as u64 + 1, l);
        assert_eq!(answer(&mut s), (1, String::new()), "{l:?}: a receipt");
    }
    // SIGKILL, then a start that opens the store again, then SIGKILL again.
    w.kill();
    let w = serve(&dir, &socket);
    println!("A1: {}", w.line("worldd: started at tick"));
    w.kill();
    let refs = references_in(&dir.join("log"));
    assert_eq!(refs.len(), 2, "two sentences, each logged by its reference");
    let body = born_body(&dir.join("log"), body);
    let store = || {
        Store::open_dir(
            &dir.join("log.text"),
            Minter::new(worldd::words::scope(root.scope())),
        )
        .expect("the world's text store on the disk")
    };
    let t = store();
    let read = |t: &Store, r: Id| String::from_utf8(t.read(r, &[body]).expect("reads")).unwrap();
    let mut refs: Vec<(String, Id)> = refs.into_iter().map(|r| (read(&t, r), r)).collect();
    refs.sort_by_key(|(l, _)| lines.iter().position(|x| x == l));
    let got: Vec<&str> = refs.iter().map(|(l, _)| l.as_str()).collect();
    assert_eq!(got, lines, "both sentences read after the restart");
    let refs: Vec<Id> = refs.into_iter().map(|(_, r)| r).collect();
    t.remove(refs[1], body, 0, Grade::Erased).expect("erased");
    t.close();
    let w = serve(&dir, &socket);
    w.line("worldd: started at tick");
    w.kill();
    let t = store();
    assert_eq!(
        t.read(refs[0], &[body]).expect("reads"),
        lines[0].as_bytes()
    );
    assert_eq!(
        t.read(refs[1], &[body]).unwrap_err().name,
        "removed",
        "erased words stay erased"
    );
    t.close();
    println!(
        "A1: {:?} reads after two restarts; the erased sentence is refused `removed`",
        lines[0]
    );
    let _ = std::fs::remove_dir_all(&d);
}

/// O20b (#3523) A2, A3: `worldd serve` runs O20's shipper for the world's own stores. With no bucket set it serves as
/// before and says so once (A3). With a folder standing in for the offsite bucket it ships its words under the world's
/// lineage, and O12's restore step (`backup::restore`, the world's lines) brings a sentence said while it ran back into
/// a fresh folder, where it reads (A2).
// A real process on the real clock: the wait for its copy is real time.
#[allow(clippy::disallowed_methods)]
#[test]
fn o20b_a2_a3_served_world_ships_its_words_and_they_restore() {
    let d = scratch("o20s");
    let (dir, body, root, ground) = seeded(&d);
    let socket = d.join("s");
    let w = serve(&dir, &socket);
    let said = w.line("worldd: backup: ");
    println!("A3: {said}");
    assert!(said.contains("no bucket"), "{said}");
    w.line("worldd: started at tick");
    w.kill();

    let bucket = d.join("bucket");
    let pass = d.join("recovery.key");
    std::fs::write(&pass, "a recovery passphrase for the test\n").unwrap();
    let url = format!("folder:{}", bucket.display());
    let w = serve_env(
        &dir,
        &socket,
        &[],
        &[
            ("SOULS_BACKUP_URL", &url),
            ("SOULS_BACKUP_KEY_FILE", pass.to_str().unwrap()),
            ("SOULS_BACKUP_SHIP_S", "1"),
        ],
    );
    println!("A2: {}", w.line("worldd: backup: shipping"));
    w.line("worldd: started at tick");
    let lineage = to_hex(&root.scope().0);
    let folder = directoryd::directory::folder::Folder::new(bucket.clone());
    let text_key = format!("store/worlds/{lineage}/text");
    let etag = |k: &str| {
        use directoryd::directory::store::Store as _;
        folder.get(k).unwrap().map(|o| o.etag)
    };
    let wait = |what: &str, ok: &dyn Fn() -> bool| {
        let end = Instant::now() + Duration::from_secs(30);
        while !ok() {
            assert!(Instant::now() < end, "{what} within 30 s");
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    wait("the first copy", &|| etag(&text_key).is_some());
    let first = etag(&text_key);
    let line = "the well is deeper than it looks";
    let mut s = connect(&socket);
    walk_with_words(&mut s, body, root.scope(), ground, 1, line);
    assert_eq!(answer(&mut s), (1, String::new()), "a receipt");
    wait("the copy with the sentence", &|| etag(&text_key) != first);
    w.kill();

    // Machine-b: a fresh folder, the bucket and the passphrase alone.
    let refs = references_in(&dir.join("log"));
    let body = born_body(&dir.join("log"), body);
    let b = d.join("b");
    let prefix = format!("worlds/{lineage}/");
    let stores: Vec<_> = backup::owned_by("worldd", &[&lineage])
        .unwrap()
        .into_iter()
        .filter(|e| e.path.starts_with(&prefix))
        .collect();
    let key = backup::Key::from_passphrase(b"a recovery passphrase for the test").unwrap();
    let restored = backup::restore(&folder, Some(&key), &stores, &b, &prefix).expect("restores");
    println!(
        "A2: restored {:?}; keys {:?}",
        restored
            .iter()
            .map(|r| (&r.name, r.files, r.bytes))
            .collect::<Vec<_>>(),
        directoryd::directory::folder::Folder::keys(&folder, "store/")
    );
    let t = Store::open_dir(
        &b.join("log.text"),
        Minter::new(worldd::words::scope(root.scope())),
    )
    .expect("the restored text store");
    let back: Vec<Vec<u8>> = refs
        .iter()
        .filter_map(|r| t.read(*r, &[body]).ok())
        .collect();
    t.close();
    assert_eq!(
        back,
        vec![line.as_bytes().to_vec()],
        "the sentence reads on machine-b"
    );
    let _ = std::fs::remove_dir_all(&d);
}

/// Actual serve startup must connect the gateway subscription socket, including after checkpoint replay.
#[test]
fn c30_served_subscription_socket_replays_ownership_and_private_words() {
    let d = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.local/c30-subscriptions");
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    let d = d.canonicalize().unwrap(); // Keep the Unix socket path below the platform's byte limit.
    let (dir, a, root, _) = seeded(&d);
    let b = Id::new(a.scope(), 2).unwrap();
    let socket = d.join("s");
    let act = |s: &mut UnixStream, who, seq, verb: &str, target: Option<Id>, parameters| {
        let intent = Intent {
            actor: Actor::Soul(who),
            verb: Name::new(verb).unwrap(),
            target: target.map(Target::Node),
            parameters,
            sequence: seq,
            basis: Version {
                lineage: root.scope(),
                zone: root,
                epoch: 1,
                sequence: 0,
            }
            .to_value(),
            expiry: i64::MAX,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
            reflex: false,
        };
        let bytes = encode(&intent.to_value()).unwrap();
        s.write_all(&(bytes.len() as u32).to_be_bytes()).unwrap();
        s.write_all(&bytes).unwrap();
        assert_eq!(answer(s), (1, String::new()));
    };
    let read_item = |s: &mut UnixStream| {
        let mut len = [0; 4];
        s.read_exact(&mut len).unwrap();
        let mut bytes = vec![0; u32::from_be_bytes(len) as usize];
        s.read_exact(&mut bytes).unwrap();
        let Value::Map(m) = decode(&bytes).unwrap().value else {
            panic!("frame")
        };
        let Some(Value::Bytes(bytes)) = m.get(&2) else {
            panic!("item")
        };
        bytes.clone()
    };
    let mut w = serve(&dir, &socket);
    w.line("listening ");
    let mut intents = connect(&socket);
    act(&mut intents, a, 1, "life:join", None, BTreeMap::new());
    act(&mut intents, b, 1, "life:join", None, BTreeMap::new());
    w.kill(); // Read the durable birth only after releasing the log's writer lock.
    let body = born_body(&dir.join("log"), b);
    w = serve(&dir, &socket);
    w.line("listening ");
    intents = connect(&socket);
    for round in 0..2 {
        if round == 1 {
            w.kill();
            w = serve(&dir, &socket);
            assert!(w.line("restart: ").contains("checkpoint Some("));
            w.line("listening ");
            intents = connect(&socket);
        }
        // A hostile follower of the same body never gets its private audience.
        let views = |principal: Id| {
            let mut s = connect(&socket.with_extension("views"));
            s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let req = Value::Map(BTreeMap::from([
                (1, Value::Uint(1)),
                (
                    2,
                    Value::Map(BTreeMap::from([
                        (
                            1,
                            Value::Array(vec![Value::Map(BTreeMap::from([(2, body.to_value())]))]),
                        ),
                        (2, Value::Uint(2)),
                        (3, Value::Uint(8000)),
                    ])),
                ),
                (3, Value::Array(vec![principal.to_value()])),
            ]));
            let bytes = encode(&req).unwrap();
            s.write_all(&(bytes.len() as u32).to_be_bytes()).unwrap();
            s.write_all(&bytes).unwrap();
            let Value::Map(grant) = decode(&read_item(&mut s)).unwrap().value else {
                panic!("grant")
            };
            assert_eq!(grant.get(&1), Some(&Value::Uint(5)));
            s
        };
        let mut own = views(b);
        let mut outsider = views(Id::new(a.scope(), 99).unwrap());
        let words = format!("private round {round}");
        act(
            &mut intents,
            a,
            round + 2,
            "eden:whisper",
            Some(body),
            BTreeMap::from([(
                1,
                Value::Map(BTreeMap::from([(
                    23,
                    Value::Bytes(words.as_bytes().to_vec()),
                )])),
            )]),
        );
        let mut heard = None;
        for _ in 0..20 {
            if let Some(h) = replica::speech::heard(&read_item(&mut own)).unwrap() {
                heard = Some(h);
                break;
            }
        }
        assert_eq!(heard.unwrap().words.as_deref(), Some(words.as_bytes()));
        outsider
            .set_read_timeout(Some(Duration::from_millis(300)))
            .unwrap();
        // Drain all public/count/grant traffic, refusing any addressed private words.
        for _ in 0..20 {
            let mut len = [0; 4];
            if outsider.read_exact(&mut len).is_err() {
                break;
            }
            let mut bytes = vec![0; u32::from_be_bytes(len) as usize];
            outsider.read_exact(&mut bytes).unwrap();
            assert!(!bytes.windows(words.len()).any(|w| w == words.as_bytes()));
        }
    }
    w.kill();
    let _ = std::fs::remove_dir_all(&d);
}

/// Every file under `dir`, by its path there, with its bytes.
fn files(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut all = BTreeMap::new();
    let mut todo = vec![dir.to_path_buf()];
    while let Some(d) = todo.pop() {
        for e in std::fs::read_dir(&d).expect("reads the folder").flatten() {
            let p = e.path();
            if p.is_dir() {
                todo.push(p);
            } else {
                let rel = p.strip_prefix(dir).expect("under the folder").to_path_buf();
                all.insert(rel, std::fs::read(&p).expect("reads the file"));
            }
        }
    }
    all
}

/// 0.132.1 RH: a deploy's rehearsal serves its scratch copy of the world and never the shared store, even when the
/// deploy runs with the live store's settings in its environment: the store stays byte for byte as the live world left
/// it (its claim, its epoch, its history), and the restart of the real deploy after it takes the world over at the
/// next epoch, as it would with no rehearsal.
#[test]
fn rh_a_rehearsal_leaves_the_live_store_and_the_deploy_after_it_takes_over() {
    use std::ffi::OsStr;
    const CHILD: &str = "SOULS_RH_REHEARSAL_CHILD";
    // The rehearsal as the deploy runs it, in a process whose environment names the live store and machine.
    if let Some(d) = std::env::var_os(CHILD).map(PathBuf::from) {
        let canary = supervisor::deploy::Canary {
            window: Duration::from_millis(100),
            start_within: Duration::from_secs(60),
            answer_within: Duration::from_secs(5),
            every: Duration::from_millis(50),
        };
        let r = supervisor::deploy::rehearse(
            Path::new(env!("CARGO_BIN_EXE_worldd")),
            &d.join("w"),
            &d.join("r"),
            0,
            &canary,
            &mut supervisor::deploy::Probe::Ask(0),
        )
        .expect("the rehearsal passes");
        assert!(r.served_kept && r.copied > 0, "{r:?}");
        return;
    }
    let d = scratch("rh");
    let (dir, ..) = seeded(&d);
    let spec = format!("folder:{}", d.join("store").display());
    let more = [
        OsStr::new("--store"),
        OsStr::new(&spec),
        OsStr::new("--machine"),
        OsStr::new("live"),
    ];
    let socket = d.join("s");
    // The live world claims its history at epoch 1 and ships; then it is stopped, its claim left in the store.
    let live = serve_with(&dir, &socket, &more);
    let shipping = live.line("shipping: ");
    assert!(shipping.starts_with("shipping: epoch 1 "), "{shipping}");
    live.line("listening");
    live.kill();
    let before = files(&d.join("store"));
    assert!(!before.is_empty(), "the live claim is in the store");
    // The live backup bucket, set as production sets it, shipping every second.
    let (backup, pass) = (d.join("backup"), d.join("backup.key"));
    std::fs::create_dir_all(&backup).expect("the backup folder");
    std::fs::write(&pass, "a recovery passphrase for the test\n").expect("the key");
    let backup_url = format!("folder:{}", backup.display());
    // The store named either way worldd reads it: `$WORLDD_STORE`, and the directory's `$DIRECTORY_STORE_URL`
    // (production's).
    for store_env in ["WORLDD_STORE", "DIRECTORY_STORE_URL"] {
        let out = Command::new(std::env::current_exe().expect("this test"))
            .args([
                "--exact",
                "rh_a_rehearsal_leaves_the_live_store_and_the_deploy_after_it_takes_over",
                "--nocapture",
            ])
            .env(CHILD, &d)
            .env_remove("WORLDD_STORE")
            .env_remove("DIRECTORY_STORE_URL")
            .env(store_env, &spec)
            .env("WORLDD_MACHINE", "rehearsal")
            .env("SOULS_BACKUP_URL", &backup_url)
            .env("SOULS_BACKUP_KEY_FILE", &pass)
            .env("SOULS_BACKUP_SHIP_S", "1")
            .output()
            .expect("the rehearsal runs");
        let said = || std::fs::read_to_string(d.join("r/worldd.err")).unwrap_or_default();
        assert!(
            out.status.success(),
            "the rehearsal with {store_env}: {}{}\nthe build said: {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
            said()
        );
        assert!(
            files(&d.join("store")) == before,
            "the rehearsal with {store_env} changed the live store; the build said: {}",
            said()
        );
        assert!(
            files(&backup).is_empty(),
            "the rehearsal with {store_env} wrote the live backup; the build said: {}",
            said()
        );
    }
    // The real deploy's restart after it takes the world over, at the next epoch.
    let deployed = serve_with(&dir, &socket, &more);
    let shipping = deployed.line("shipping: ");
    assert!(shipping.starts_with("shipping: epoch 2 "), "{shipping}");
    deployed.line("listening");
    drop(deployed);
    let _ = std::fs::remove_dir_all(&d);
}
