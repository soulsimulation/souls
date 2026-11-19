//! Engine v2 C1 (#3365): `worldd seed` makes a world folder from a loader's facts file (N2's test world, through N1's
//! loader), and `worldd serve` runs it. A Soul walks through the world's end of the gateway's socket (I1's framing);
//! the stream's files appear under `views/`; the process is killed with SIGKILL mid-run and started again: it resumes
//! from a checkpoint with the last logged tick's state hash, bodies included (A1, A2, A5).

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use replica::audience::references;
use replica::effects::{Actor, Part};
use replica::encode::{Name, Value, decode, encode, from_hex, to_hex};
use replica::ids::{Id, Minter, Scope, Version};
use replica::intents::{Intent, Target};
use replica::rules::json;
use sim::log::{FileStore, Log};
use sim::text::{Grade, Store};
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

/// A running `worldd serve`, its stderr lines on a channel.
struct Served {
    child: Child,
    lines: Receiver<String>,
}

fn serve(dir: &Path, socket: &Path) -> Served {
    serve_with(dir, socket, &[])
}

/// `worldd serve` with no backup settings but `env`'s.
fn serve_with(dir: &Path, socket: &Path, env: &[(&str, &str)]) -> Served {
    let mut c = worldd();
    c.args(["serve", "--dir"])
        .arg(dir)
        .arg("--socket")
        .arg(socket)
        .args(["--checkpoint-every", "2048"])
        .env_remove("SOULS_BACKUP_URL")
        .env_remove("SOULS_BACKUP_KEY_FILE")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in env {
        c.env(k, v);
    }
    let mut child = c.spawn().expect("worldd serve starts");
    let (tx, lines) = channel();
    let out = child.stdout.take().expect("stdout");
    let err = child.stderr.take().expect("stderr");
    for pipe in [Box::new(out) as Box<dyn Read + Send>, Box::new(err)] {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for l in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = tx.send(l);
            }
        });
    }
    Served { child, lines }
}

impl Served {
    /// The first line starting with `prefix`, within 60 s.
    // A real process on the real clock: the wait for its line is real time.
    #[allow(clippy::disallowed_methods)]
    fn line(&self, prefix: &str) -> String {
        let end = Instant::now() + Duration::from_secs(60);
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match self.lines.recv_timeout(left) {
                Ok(l) if l.starts_with(prefix) => return l,
                Ok(_) => {}
                Err(_) => break,
            }
        }
        panic!("no line {prefix:?}");
    }

    fn kill(mut self) {
        // SIGKILL: no flush, no goodbye.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
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

/// A seeded world folder `<d>/w` from N2's test world, one Soul at (-40, 30): the folder, the Soul, the zone's root
/// and the ground.
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
    let _ = std::fs::remove_dir_all(&d);
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
    let w = serve_with(
        &dir,
        &socket,
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
