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

use replica::effects::{Actor, Part};
use replica::encode::{Name, Value, decode, encode, from_hex, to_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Intent, Target};
use replica::rules::json;
use sim::log::{FileStore, Log};
use worldd::answers::{self, STATE};

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

fn serve(dir: &Path, socket: &Path) -> Served {
    serve_with(dir, socket, &[])
}

fn serve_with(dir: &Path, socket: &Path, more: &[&std::ffi::OsStr]) -> Served {
    serve_env(dir, socket, more, &[])
}

fn serve_env(dir: &Path, socket: &Path, more: &[&std::ffi::OsStr], env: &[(&str, &str)]) -> Served {
    let mut child = worldd()
        .args(["serve", "--dir"])
        .arg(dir)
        .arg("--socket")
        .arg(socket)
        .args(["--checkpoint-every", "2048"])
        .args(more)
        .envs(env.iter().copied())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("worldd serve starts");
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
        first_line(&self.lines, &self.early, prefix, Duration::from_secs(60))
            .unwrap_or_else(|| panic!("no line {prefix:?}"))
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
    let intent = Intent {
        actor: Actor::Soul(body),
        verb: Name::new("eden:walk").expect("a name"),
        target: Some(Target::Node(ground)),
        parameters: BTreeMap::from([(
            1,
            Value::Array(vec![i(x_m * 1_000_000), i(0), i(z_m * 1_000_000)]),
        )]),
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
    };
    let bytes = encode(&intent.to_value()).expect("bytes");
    s.write_all(&(bytes.len() as u32).to_be_bytes())
        .expect("sent");
    s.write_all(&bytes).expect("sent");
}

/// The next answer's kind: 1 a receipt, 2 a refusal (with its reason).
fn answer(s: &mut UnixStream) -> (u64, String) {
    let mut len = [0u8; 4];
    s.read_exact(&mut len).expect("an answer");
    let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
    s.read_exact(&mut frame).expect("an answer");
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
    let pointer =
        json::parse(&std::fs::read_to_string(dir.join("views/world.json")).unwrap()).unwrap();
    let stream = dir.join(pointer.get("stream").and_then(json::Value::str).unwrap());
    assert!(stream.join("pointer").exists(), "the stream's pointer");
    assert!(
        stream.join("0").exists(),
        "the stream's first part (the import)"
    );
    println!(
        "A2: {} parts",
        std::fs::read_dir(&stream).unwrap().count() - 1
    );

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
    w.kill();
    let _ = std::fs::remove_dir_all(d);
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
        std::thread::sleep(Duration::from_millis(1_500));
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
