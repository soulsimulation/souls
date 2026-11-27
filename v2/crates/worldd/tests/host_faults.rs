//! Engine v2 O10 (#2806): a served world on a host fault, with a Soul walking through the world's end of the gateway's
//! socket. A full disk (a 64 MB tmpfs filled under the world, Linux only) and a host clock stepped back and forward by
//! two minutes, while the world runs and while it is down. A store out of reach is `serve.rs`'s (R17, #1960).
//! Each prints its timeline; the act ledger is every walk's answer, and each acknowledged one answered again, kept,
//! after the fault.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use replica::effects::{Actor, Part};
use replica::encode::{Name, Value, decode, encode, from_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Intent, Target};
use replica::rules::json;
use worldd::answers;

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
    let out = worldd()
        .args(["seed", "--facts"])
        .arg(&facts)
        .arg("--dir")
        .arg(&dir)
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
    (dir, Id::new(Scope(scope), 1).unwrap(), root, ground)
}

/// A running process, its stdout and stderr lines on one channel, each with when it came.
struct Run {
    child: Child,
    lines: Receiver<String>,
    early: RefCell<Vec<String>>,
    all: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    began: Instant,
}

impl Drop for Run {
    fn drop(&mut self) {
        // The whole group: a shell's loop and the world it runs.
        let _ = Command::new("kill")
            .args(["-9", &format!("-{}", self.child.id())])
            .status();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// A real process on the real clock: its lines' times are real time.
#[allow(clippy::disallowed_methods)]
fn run(mut c: Command) -> Run {
    use std::os::unix::process::CommandExt;
    c.env_remove("SOULS_BACKUP_URL")
        .env_remove("SOULS_BACKUP_KEY_FILE")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = c.spawn().expect("it starts");
    let (tx, lines) = channel();
    let all = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let began = Instant::now();
    for pipe in [
        Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>,
        Box::new(child.stderr.take().unwrap()),
    ] {
        let (tx, all) = (tx.clone(), all.clone());
        std::thread::spawn(move || {
            for l in BufReader::new(pipe).lines().map_while(Result::ok) {
                if let Ok(mut a) = all.lock() {
                    a.push(format!("{:>7} ms  {l}", began.elapsed().as_millis()));
                }
                let _ = tx.send(l);
            }
        });
    }
    Run {
        child,
        lines,
        early: RefCell::default(),
        all,
        began,
    }
}

impl Run {
    /// The first line holding `part`, within `wait`.
    // A real process on the real clock.
    #[allow(clippy::disallowed_methods)]
    fn line_within(&self, part: &str, wait: Duration) -> Option<String> {
        let mut early = self.early.borrow_mut();
        if let Some(i) = early.iter().position(|l| l.contains(part)) {
            return Some(early.remove(i));
        }
        let end = Instant::now() + wait;
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match self.lines.recv_timeout(left) {
                Ok(l) if l.contains(part) => return Some(l),
                Ok(l) => early.push(l),
                Err(_) => break,
            }
        }
        None
    }

    fn line(&self, part: &str) -> String {
        self.line_within(part, Duration::from_secs(60))
            .unwrap_or_else(|| panic!("no line {part:?}; it printed:\n{}", self.said()))
    }

    fn said(&self) -> String {
        self.all.lock().map(|a| a.join("\n")).unwrap_or_default()
    }

    // A real process on the real clock.
    #[allow(clippy::disallowed_methods)]
    fn at(&self) -> u128 {
        self.began.elapsed().as_millis()
    }
}

fn serve(dir: &Path, socket: &Path, env: &[(&str, &Path)]) -> Run {
    let mut c = worldd();
    c.args(["serve", "--dir"])
        .arg(dir)
        .arg("--socket")
        .arg(socket)
        .args(["--checkpoint-every", "2048"]);
    for (k, v) in env {
        c.env(k, v);
    }
    run(c)
}

/// A client of the world's socket, its reads bounded so a world that does not answer is a timeline, not a hung test.
// A real process on the real clock: the wait for its socket is real time.
#[allow(clippy::disallowed_methods)]
fn connect(socket: &Path, within: Duration) -> Option<UnixStream> {
    let end = Instant::now() + within;
    loop {
        match UnixStream::connect(socket) {
            Ok(s) => {
                s.set_read_timeout(Some(Duration::from_secs(1))).ok()?;
                return Some(s);
            }
            Err(_) if Instant::now() < end => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
}

/// A walk to `(x_m, 0, z_m)` under `sequence`, with no expiry (the Soul client's default), so a world whose time is
/// not the test's is never what refuses it.
fn walk(s: &mut UnixStream, w: &Walker, sequence: u64, x_m: i64, z_m: i64) -> bool {
    let i =
        |n: i64| u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint);
    let to = Value::Array(vec![i(x_m * 1_000_000), i(0), i(z_m * 1_000_000)]);
    let intent = Intent {
        actor: Actor::Soul(w.body),
        verb: Name::new("eden:walk").expect("a name"),
        target: Some(Target::Node(w.ground)),
        parameters: BTreeMap::from([(1, to)]),
        sequence,
        basis: Version {
            lineage: w.root.scope(),
            zone: Id::new(w.root.scope(), 0).expect("the zone"),
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        expiry: (1 << 53) - 1,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    let bytes = encode(&intent.to_value()).expect("bytes");
    s.write_all(&(bytes.len() as u32).to_be_bytes()).is_ok() && s.write_all(&bytes).is_ok()
}

/// The next final answer within `within`: (its sequence, 1 a receipt or 2 a refusal, its reason). `None`: none came
/// (a world that does not answer), or the socket closed (a world that ended).
// A real process on the real clock.
#[allow(clippy::disallowed_methods)]
fn answer(s: &mut UnixStream, within: Duration) -> Option<(u64, u64, String)> {
    let end = Instant::now() + within;
    loop {
        let mut len = [0u8; 4];
        match s.read_exact(&mut len) {
            Ok(()) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) && Instant::now() < end =>
            {
                continue;
            }
            Err(_) => return None,
        }
        let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
        s.read_exact(&mut frame).ok()?;
        if answers::progress_of(&frame).is_some() {
            continue;
        }
        let Value::Map(m) = decode(&frame).ok()?.value else {
            return None;
        };
        let Some(Value::Map(a)) = m.get(&2) else {
            continue;
        };
        let sequence = match a.get(&2) {
            Some(Value::Uint(n)) => *n,
            _ => 0,
        };
        return match (a.get(&3), a.get(&4)) {
            (Some(Value::Uint(k)), Some(Value::Text(t))) => {
                Some((sequence, *k, t.as_str().to_owned()))
            }
            (Some(Value::Uint(k)), _) => Some((sequence, *k, String::new())),
            _ => None,
        };
    }
}

struct Walker {
    body: Id,
    root: Id,
    ground: Id,
}

/// The newest world time of an effect in the log on the disk, µs.
fn log_reached(log: &Path) -> i64 {
    reached_from(log, 0).expect("a tick with an effect")
}

/// The newest world time of an effect in the log's records from record `from` on, µs, and how many records it holds.
fn reached_from(log: &Path, from: usize) -> Option<i64> {
    let bytes = std::fs::read(log).expect("the log");
    sim::log::recover(&bytes)
        .expect("the log")
        .records
        .iter()
        .skip(from)
        .filter(|r| !sim::recorder::is_input(r))
        .filter_map(|r| Part::read(r).ok())
        .flat_map(|p| p.effects.into_iter().map(|e| e.envelope.at))
        .max()
}

fn records(log: &Path) -> usize {
    sim::log::recover(&std::fs::read(log).expect("the log"))
        .expect("the log")
        .records
        .len()
}

/// How far the public stream shows the world, world µs: its pointer's newest part's end or its quiet mark.
fn shown(dir: &Path) -> Option<i64> {
    let world = json::parse(&std::fs::read_to_string(dir.join("views/world.json")).ok()?).ok()?;
    let stream = world.get("stream")?.str()?.to_owned();
    let p = replica::stream::Pointer::read(&std::fs::read(dir.join(stream).join("pointer")).ok()?)
        .ok()?;
    p.newest_to.max(p.quiet_until)
}

/// Waits up to `within` for the public stream to show world time `t`: how long it took, or `None`.
// A real process on the real clock.
#[allow(clippy::disallowed_methods)]
fn shown_by(dir: &Path, t: i64, within: Duration) -> Option<u128> {
    let began = Instant::now();
    while began.elapsed() < within {
        if shown(dir).is_some_and(|s| s >= t) {
            return Some(began.elapsed().as_millis());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    None
}

/// Walks `sequence` and waits up to `within` for its answer, reconnecting once when the socket is gone: (ms it took,
/// the answer).
// A real process on the real clock.
#[allow(clippy::disallowed_methods)]
fn ask(
    socket: &Path,
    c: &mut Option<UnixStream>,
    w: &Walker,
    sequence: u64,
    within: Duration,
) -> (u128, Option<(u64, u64, String)>) {
    let began = Instant::now();
    let x = -40 + (sequence % 5) as i64;
    for _ in 0..2 {
        if c.is_none() {
            *c = connect(socket, within.saturating_sub(began.elapsed()));
        }
        let Some(s) = c.as_mut() else { break };
        if walk(s, w, sequence, x, 30) {
            let a = answer(s, within.saturating_sub(began.elapsed()));
            if a.is_some() {
                return (began.elapsed().as_millis(), a);
            }
        }
        *c = None;
    }
    (began.elapsed().as_millis(), None)
}

/// When the line holding `part` came, ms, from [`Run::said`]'s lines.
fn at_of(said: &str, part: &str) -> Option<u128> {
    said.lines()
        .find(|l| l.contains(part))?
        .split(" ms")
        .next()?
        .trim()
        .parse()
        .ok()
}

/// A3: the host clock stepped back and forward two minutes, while the world runs and before a restart. World time
/// never goes back, the world never waits for the host clock, and every walk is answered.
// A real process on the real clock: the steps are a file the world's clock reads; the waits are real time.
#[allow(clippy::disallowed_methods)]
#[test]
fn o10_a_stepped_host_clock_never_freezes_a_world() {
    let d = scratch("o10c");
    let (dir, body, root, ground) = seeded(&d);
    let w = Walker { body, root, ground };
    let socket = d.join("s");
    let step = d.join("step");
    let log = dir.join("log");
    std::fs::write(&step, "0").unwrap();
    let env = [("WORLDD_TEST_CLOCK_STEP", step.as_path())];
    let mut ledger: Vec<(u64, u64)> = Vec::new();
    let mut c = None;
    let mut seq = 0u64;
    let mut next = |c: &mut Option<UnixStream>, label: &str, within: Duration| {
        seq += 1;
        let (ms, a) = ask(&socket, c, &w, seq, within);
        println!("A3 {label}: walk {seq} answered {a:?} in {ms} ms");
        if let Some((_, kind, _)) = a {
            ledger.push((seq, kind));
            return ms;
        }
        u128::MAX
    };

    let world = serve(&dir, &socket, &env);
    world.line("listening");
    next(&mut c, "before", Duration::from_secs(30));
    for (label, by) in [
        ("running, stepped back 120 s", -120),
        ("running, stepped forward 120 s", 120),
    ] {
        std::fs::write(&step, (by * 1_000_000i64).to_string()).unwrap();
        let named = world.line_within(
            "clock.stepped: the machine's clock moved",
            Duration::from_secs(2),
        );
        println!("A3 {label}: named {named:?}");
        assert!(
            named.is_some(),
            "{label}: clock.stepped is named within 2 s"
        );
        let ms = next(&mut c, label, Duration::from_secs(10));
        // Viewers: the public stream shows the walk's last effect within 5 s, whatever the machine's clock says.
        let viewed = shown_by(&dir, log_reached(&log), Duration::from_secs(5));
        println!("A3 {label}: shown in {viewed:?} ms");
        assert!(ms < 5_000, "{label}: {ms} ms");
        assert!(viewed.is_some(), "{label}: viewers see the walk within 5 s");
    }
    std::fs::write(&step, "0").unwrap();
    drop(c.take());
    drop(world);

    for (label, by) in [
        ("restart, stepped back 120 s", -120i64),
        ("restart, stepped forward 120 s", 120),
    ] {
        let reached = log_reached(&log);
        let kept = records(&log);
        std::fs::write(&step, (by * 1_000_000).to_string()).unwrap();
        let world = serve(&dir, &socket, &env);
        world.line("listening");
        let named = world.line_within("clock.stepped", Duration::from_secs(2));
        println!("A3 {label}: named {named:?} at {} ms", world.at());
        let ms = next(&mut c, label, Duration::from_secs(30));
        let started = world.line_within("started at tick", Duration::from_secs(1));
        // World time from the effects written since the restart only, never those before it.
        let after = reached_from(&log, kept);
        // Viewers: the public stream shows the walk's last effect within 5 s.
        let viewed = after.and_then(|t| shown_by(&dir, t, Duration::from_secs(5)));
        println!(
            "A3 {label}: {started:?}; world time {reached} before, {after:?} after; shown in {viewed:?} ms; it \
             printed:\n{}",
            world.said()
        );
        drop(c.take());
        drop(world);
        assert!(
            after.is_some_and(|a| a >= reached),
            "{label}: world time went back"
        );
        assert!(viewed.is_some(), "{label}: viewers see the walk within 5 s");
        // Back: the world goes on at once. Forward: it first catches up the step's ticks exactly, back to back (K7),
        // here 120 s of them in a debug build on a shared machine: no freeze, a catch-up as long as the step's work.
        let bar = if by < 0 { 5_000 } else { 20_000 };
        assert!(ms < bar, "{label}: the walk waited {ms} ms");
        if by < 0 {
            assert!(named.is_some(), "{label}: clock.stepped is named");
        }
        std::fs::write(&step, "0").unwrap();
    }
    // The ledger: every acknowledged walk, sent again, gets its kept answer.
    let world = serve(&dir, &socket, &[]);
    world.line("listening");
    let mut s = connect(&socket, Duration::from_secs(30)).expect("the socket");
    for (n, kind) in &ledger {
        assert!(walk(&mut s, &w, *n, -40 + (*n % 5) as i64, 30));
        let a = answer(&mut s, Duration::from_secs(10));
        assert_eq!(a.as_ref().map(|a| a.1), Some(*kind), "walk {n}: {a:?}");
    }
    drop(world);
    let _ = std::fs::remove_dir_all(&d);
}

/// A1: the disk under a world fills (a 64 MB tmpfs, in a user and mount namespace of its own), while a Soul walks;
/// then it clears. A shell restarts the world as its unit does. Linux only: elsewhere it says so and ends.
// A real process on the real clock: the fill, the waits and the restarts are real time.
#[allow(clippy::disallowed_methods)]
#[test]
fn o10_a_full_disk_never_freezes_a_world() {
    if !cfg!(target_os = "linux") {
        println!("A1: a tmpfs of its own needs Linux");
        return;
    }
    let d = scratch("o10d");
    let (seed, body, root, ground) = seeded(&d);
    let w = Walker { body, root, ground };
    let socket = d.join("s");
    let mnt = d.join("m");
    std::fs::create_dir_all(&mnt).unwrap();
    // A unit's restart, at its first delay (100 ms; `worldd@.service`), for ever.
    let script = r#"mount -t tmpfs -o size=64m tmpfs "$1" || exit 97
cp -a "$2" "$1/w" || exit 98
while :; do "$3" serve --dir "$1/w" --socket "$4" --checkpoint-every 2048; echo "o10: exited $?"; sleep 0.1; done"#;
    let mut c = Command::new("unshare");
    c.args([
        "--user",
        "--map-root-user",
        "--mount",
        "sh",
        "-c",
        script,
        "sh",
    ])
    .arg(&mnt)
    .arg(&seed)
    .arg(env!("CARGO_BIN_EXE_worldd"))
    .arg(&socket);
    let world = run(c);
    if world
        .line_within("listening", Duration::from_secs(60))
        .is_none()
    {
        println!(
            "A1: no tmpfs of its own here (unprivileged namespaces off?); it printed:\n{}",
            world.said()
        );
        return;
    }
    // The world's folder as the namespace sees it.
    let inside = PathBuf::from(format!("/proc/{}/root", world.child.id()))
        .join(mnt.strip_prefix("/").unwrap());
    let health = || std::fs::read_to_string(inside.join("w/health.json")).unwrap_or_default();
    let mut ledger: Vec<(u64, u64)> = Vec::new();
    let mut c = None;
    let mut seq = 0u64;
    let mut ask_one = |c: &mut Option<UnixStream>, label: &str, within: Duration| {
        seq += 1;
        let (ms, a) = ask(&socket, c, &w, seq, within);
        println!(
            "A1 {label} at {} ms: walk {seq} answered {a:?} in {ms} ms",
            world.at()
        );
        if let Some((_, kind, _)) = &a {
            ledger.push((seq, *kind));
        }
        a
    };
    assert!(ask_one(&mut c, "before", Duration::from_secs(30)).is_some());

    // The fill: a file grown until the disk refuses it.
    let fill = inside.join("fill");
    let filled_at = world.at();
    {
        let mut f = std::fs::File::create(&fill).expect("the fill");
        let mb = vec![7u8; 1 << 20];
        let mut n = 0;
        while f.write_all(&mb).is_ok() {
            n += 1;
        }
        let _ = f.sync_all();
        println!("A1: filled at {filled_at} ms with {n} MB");
    }
    let mut answered_full = Vec::new();
    for k in 0..5 {
        let a = ask_one(&mut c, "full", Duration::from_secs(3));
        answered_full.push(a);
        if k % 4 == 0 {
            println!(
                "A1 full: health {}",
                health().chars().take(300).collect::<String>()
            );
        }
    }
    // The disk clears.
    std::fs::remove_file(&fill).expect("the fill goes");
    let cleared_at = world.at();
    let mut back = None;
    for _ in 0..30 {
        if let Some((_, 1, _)) = ask_one(&mut c, "cleared", Duration::from_secs(2)) {
            back = Some(world.at() - cleared_at);
            break;
        }
    }
    println!(
        "A1: cleared at {cleared_at} ms; a walk accepted {back:?} ms after; it printed:\n{}",
        world.said()
    );
    drop(c.take());
    // The ledger: every acknowledged walk, sent again, gets its kept answer.
    let mut s = connect(&socket, Duration::from_secs(30)).expect("the socket");
    for (n, kind) in ledger.iter().filter(|(_, k)| *k == 1) {
        assert!(walk(&mut s, &w, *n, -40 + (*n % 5) as i64, 30));
        let a = answer(&mut s, Duration::from_secs(10));
        assert_eq!(a.as_ref().map(|a| a.1), Some(*kind), "walk {n}: {a:?}");
    }
    let said = world.said();
    let restarts = said.matches("o10: exited").count();
    let (failed, named) = (at_of(&said, "disk-failed:"), at_of(&said, "disk.full:"));
    println!(
        "A1: {restarts} restarts; disk-failed at {failed:?} ms, disk.full named at {named:?} ms; full answers \
         {answered_full:?}"
    );
    assert!(restarts <= 1, "restarts at most once: {restarts}");
    assert!(
        failed.zip(named).is_some_and(|(f, n)| n - f < 2_000),
        "disk.full named within 2 s of the failure"
    );
    assert!(
        back.is_some_and(|ms| ms < 5_000),
        "accepted within 5 s of the clear: {back:?}"
    );
    drop(world);
    let _ = std::fs::remove_dir_all(&d);
}
