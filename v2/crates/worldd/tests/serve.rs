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

fn scratch() -> PathBuf {
    // Short: a Unix socket's path is at most 104 bytes on macOS.
    let d = std::env::temp_dir().join(format!("c1-{}", std::process::id()));
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
    let mut child = worldd()
        .args(["serve", "--dir"])
        .arg(dir)
        .arg("--socket")
        .arg(socket)
        .args(["--checkpoint-every", "2048"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("worldd serve starts");
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
    let d = scratch();
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
