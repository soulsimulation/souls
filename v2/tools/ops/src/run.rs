//! The O7 run (Engine v2 O7, #2804): one world behind `gatewayd`, started by O1's launcher from the pin in its
//! directory record, with 100 scripted agents connected and acting throughout. Then, by `supervisor::deploy`:
//!
//! 1. three planted bad builds (`o7-plant`: dies at start, clock stalls, refuses every act) are each deployed: each
//!    passes the rehearsal, reaches the canary, and is rolled back by the machine (A1, A5);
//! 2. a good new build is deployed and kept; then a rollback from it to a build that reads only an older schema is
//!    refused by name, and the world keeps serving (A4).
//!
//! It prints each timeline, the agents' socket counts (A2) and how every act ended, and checks that every act the
//! world answered is in the log after it all (A3). This machine plays systemd's part: `supervisor launch` is run again
//! 100 ms after it exits, and a restart is a SIGKILL, as `Restart=always` does.
//!
//! Build first: `cargo build --release -p ops -p worldd -p gatewayd -p supervisor`. Then
//! `target/release/o7-run --dir <empty folder>`. The other binaries are taken from this one's folder.
// A run times itself by the wall clock (the wall-clock rule, K7, is the engine's: v2/clippy.toml).
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use gatewayd::token::{Grant, Token, Tokens};
use replica::effects::{Actor, read_id};
use replica::encode::{Name, Value, decode, encode, to_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Fallback, Hello, Intent, PROTOCOL, Target};
use sim::log::recover;
use supervisor::deploy::{
    ANSWERED, Canary, Deploy, End, Ended, Probe, Timeline, Unit, log_path, now_us, read_answer,
    records, socket_path, state_path, watch,
};
use supervisor::folder::Folder;
use supervisor::{World, build_hash, build_path, set_pin};
use tokio_tungstenite::tungstenite::Message;
use worldd::checkers::toggles;

const LINEAGE: [u8; 16] = [0x07; 16];
const AGENTS: usize = 100;
/// One body more than the agents: the last is the canary's probe.
const BODIES: usize = AGENTS + 1;

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("o7-run: {msg}");
    std::process::exit(2)
}

fn toggle(body: Id, thing: Id, sequence: u64, expiry_us: i64) -> Intent {
    let n = |s: &str| Name::new(s).expect("a name");
    Intent {
        actor: Actor::Soul(body),
        verb: n("r2:switch_on"),
        target: Some(Target::Node(thing)),
        parameters: BTreeMap::new(),
        sequence,
        basis: Version {
            lineage: Scope(LINEAGE),
            zone: Id::new(Scope(LINEAGE), 0).expect("a zone"),
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        expiry: now_us() + expiry_us,
        resources: Vec::new(),
        fallbacks: vec![Fallback {
            verb: n("r2:switch_off"),
            target: Some(Target::Node(thing)),
            parameters: BTreeMap::new(),
            resources: Vec::new(),
        }],
        replaces: None,
        body: None,
    }
}

/// A build: a script that runs this machine's `worldd` as the world, or a planted fault when served.
fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let worldd = dir.join("bin/worldd");
    let serve = format!(
        "cd \"$2\" && exec '{}' gateway-link --socket gateway.sock --lineage {} --epoch 1 --log log --bodies {BODIES}",
        worldd.display(),
        to_hex(&LINEAGE)
    );
    let text = format!(
        "#!/bin/sh\n# O7 build: {name}\n[ \"$1\" = serve ] && shift\n{}\nexec '{}' \"$@\"\n",
        body.replace("SERVE", &serve),
        worldd.display()
    );
    let p = dir.join(format!("{name}.sh"));
    std::fs::write(&p, text).unwrap_or_else(|e| fail(e));
    p
}

/// Puts a build on the machine (`builds/<hash>/worldd`); returns its hash.
fn install(root: &Path, file: &Path) -> Vec<u8> {
    let bytes = std::fs::read(file).unwrap_or_else(|e| fail(e));
    let h = build_hash(&bytes);
    let p = build_path(root, &h);
    std::fs::create_dir_all(p.parent().expect("a folder")).unwrap_or_else(|e| fail(e));
    std::fs::write(&p, bytes).unwrap_or_else(|e| fail(e));
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755))
        .unwrap_or_else(|e| fail(e));
    h
}

/// systemd's part on this machine: `supervisor launch <world>` again 100 ms after each exit; a restart kills it.
struct Local {
    child: Arc<Mutex<Option<Child>>>,
    stop: Arc<AtomicBool>,
    starts: Arc<AtomicU64>,
}

impl Local {
    fn start(sup: PathBuf, root: PathBuf, world: String, log: PathBuf) -> Local {
        let child: Arc<Mutex<Option<Child>>> = Arc::default();
        let stop = Arc::new(AtomicBool::new(false));
        let starts = Arc::new(AtomicU64::new(0));
        let (c, s, n) = (child.clone(), stop.clone(), starts.clone());
        std::thread::spawn(move || {
            while !s.load(Ordering::SeqCst) {
                let out = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&log);
                let err = out.as_ref().ok().and_then(|f| f.try_clone().ok());
                let spawned = Command::new(&sup)
                    .args(["launch", &world])
                    .env("WORLDS_ROOT", &root)
                    .stdout(out.map_or_else(|_| Stdio::null(), Stdio::from))
                    .stderr(err.map_or_else(Stdio::null, Stdio::from))
                    .spawn();
                if let Ok(ch) = spawned {
                    n.fetch_add(1, Ordering::SeqCst);
                    *c.lock().expect("the unit") = Some(ch);
                }
                loop {
                    std::thread::sleep(Duration::from_millis(20));
                    let mut g = c.lock().expect("the unit");
                    match g.as_mut().map(Child::try_wait) {
                        Some(Ok(None)) => {}
                        _ => {
                            *g = None;
                            break;
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        Local {
            child,
            stop,
            starts,
        }
    }

    fn halt(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.kill_now();
    }
}

impl Unit for Local {
    fn restart(&mut self) -> Result<(), String> {
        self.kill_now()
    }
}

impl Local {
    fn kill_now(&self) -> Result<(), String> {
        if let Some(c) = self.child.lock().expect("the unit").as_mut() {
            let _ = c.kill();
        }
        Ok(())
    }
}

/// How each of one agent's acts ended: sequence → the answers it had.
type Ends = BTreeMap<u64, Vec<End>>;

/// One agent: hello, sign-in, then its own toggle about once a second until `stop`, then 10 s for its answers.
async fn agent(
    url: String,
    token: String,
    pair: (Id, Id),
    every: Duration,
    stop: Arc<AtomicBool>,
) -> (bool, Ends) {
    let mut ends = Ends::new();
    let Ok((ws, _)) = tokio_tungstenite::connect_async(&url).await else {
        return (false, ends);
    };
    let (mut tx, mut rx) = ws.split();
    let hello = Hello {
        protocol: PROTOCOL,
        build: vec![0x12, 0x20],
        refused: None,
        other: None,
    };
    let sign_in = encode(&Value::Map(
        [(1, Value::Text(Name::new(&token).expect("a token")))].into(),
    ))
    .expect("a sign-in");
    let mut ok = tx
        .send(Message::Binary(hello.to_bytes().expect("hello").into()))
        .await
        .is_ok();
    ok = ok && tx.send(Message::Binary(sign_in.into())).await.is_ok();
    for _ in 0..2 {
        ok = ok && matches!(rx.next().await, Some(Ok(Message::Binary(_))));
    }
    if !ok {
        return (false, ends);
    }
    let mut seq = 0u64;
    let mut tick = tokio::time::interval(every);
    let mut drain_until: Option<Instant> = None;
    let open = loop {
        let wait = match drain_until {
            Some(u) if Instant::now() >= u => break true,
            Some(u) => u - Instant::now(),
            None => Duration::from_secs(3600),
        };
        tokio::select! {
            _ = tick.tick(), if drain_until.is_none() => {
                if stop.load(Ordering::Relaxed) {
                    drain_until = Some(Instant::now() + Duration::from_secs(10));
                    continue;
                }
                seq += 1;
                ends.insert(seq, Vec::new());
                let bytes = encode(&toggle(pair.0, pair.1, seq, 600_000_000).to_value()).expect("an intent");
                if tx.send(Message::Binary(bytes.into())).await.is_err() {
                    break false;
                }
            }
            m = rx.next() => match m {
                Some(Ok(Message::Binary(b))) => {
                    if let Some((s, end)) = read_answer(&b)
                        && let Some(e) = ends.get_mut(&s)
                    {
                        e.push(end);
                    }
                }
                Some(Ok(_)) => {}
                _ => break false,
            },
            _ = tokio::time::sleep(wait) => {}
        }
    };
    let _ = tx.send(Message::Close(None)).await;
    (open, ends)
}

fn print(title: &str, tl: &Timeline) {
    println!("\n### {title}\n\n| ms from the deploy's start | event |\n|---:|---|");
    for (ms, what) in &tl.0 {
        println!("| {ms} | {what} |");
    }
}

/// Milliseconds from the restart onto the new build to the old build serving again.
fn rolled_back_in(tl: &Timeline) -> Option<u128> {
    let at = |p: &str| tl.0.iter().find(|(_, w)| w.starts_with(p)).map(|(t, _)| *t);
    Some(at("serving again")? - at("restarted: the canary")?)
}

#[tokio::main]
async fn main() {
    let a: Vec<String> = std::env::args().collect();
    let dir = PathBuf::from(
        a.iter()
            .position(|x| x == "--dir")
            .and_then(|k| a.get(k + 1))
            .unwrap_or_else(|| fail("usage: o7-run --dir <empty folder>")),
    );
    let here = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| fail("no folder for the binaries"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("bin")).unwrap_or_else(|e| fail(e));
    let dir = dir.canonicalize().unwrap_or_else(|e| fail(e));
    for b in ["worldd", "gatewayd", "supervisor", "o7-plant"] {
        std::fs::copy(here.join(b), dir.join("bin").join(b))
            .unwrap_or_else(|e| fail(format!("{b}: {e}")));
    }
    let root = dir.join("root");
    let world = World {
        lineage: LINEAGE,
        zone: Id::new(Scope(LINEAGE), 0).expect("a zone"),
    };
    let name = world.name();
    std::fs::create_dir_all(state_path(&root, &world)).unwrap_or_else(|e| fail(e));
    // A local socket's path is at most 104 bytes on macOS (108 on Linux): this process works from the machine's
    // folder and names the world's sockets from it, and the builds bind theirs from the world's own folder.
    std::env::set_current_dir(&root).unwrap_or_else(|e| fail(e));
    let here_root = PathBuf::from(".");
    let state = state_path(&here_root, &world);

    // The builds: two good ones, three planted faults, and one that reads only an older schema.
    let plant = |mode: &str| {
        format!(
            "if [ \"$1\" = --dir ]; then\n  [ -n \"$WORLDD_REHEARSAL\" ] && SERVE\n  cd \"$2\" && exec '{}' {mode} . {} {BODIES}\nfi",
            dir.join("bin/o7-plant").display(),
            to_hex(&LINEAGE)
        )
    };
    let good = "if [ \"$1\" = --dir ]; then SERVE; fi";
    let older = format!(
        "if [ \"$1\" = schemas ]; then echo reads 1220{z}; echo writes 1220{z}; exit 0; fi\n{good}",
        z = "0".repeat(64)
    );
    let build = |n: &str, body: &str| install(&root, &script(&dir, n, body));
    let good_a = build("good-a", good);
    let good_b = build("good-b", good);
    let plants = [
        ("dies at start", build("plant-die", &plant("die"))),
        ("clock stalls", build("plant-stall", &plant("stall"))),
        ("refuses every act", build("plant-refuse", &plant("refuse"))),
    ];
    let older = build("older-schema", &older);
    let store = Folder::new(root.join("directory"));
    set_pin(&store, &world, &good_a).unwrap_or_else(|e| fail(e));

    let unit = Local::start(
        dir.join("bin/supervisor"),
        root.clone(),
        name.clone(),
        dir.join("world.out"),
    );
    let pairs = toggles::World::build(1, BODIES, 0).pairs;
    let probe_pair = pairs[AGENTS];
    // The run's own probe body, so its canary also wants a commit: the `refuse` plant answers sync asks.
    let mut probe = Probe::Act(Box::new(toggle(probe_pair.0, probe_pair.1, 0, 5_000_000)));
    let canary = Canary {
        window: Duration::from_secs(5),
        start_within: Duration::from_secs(3),
        answer_within: Duration::from_secs(1),
        every: Duration::from_millis(250),
    };
    let first = Canary {
        window: Duration::from_secs(10),
        ..canary
    };
    watch(&socket_path(&state), &first, &mut probe, true)
        .unwrap_or_else(|e| fail(format!("the world: {e}")));

    // The gateway and the agents.
    let mut file = String::new();
    let mut tokens = Vec::new();
    for p in &pairs[..AGENTS] {
        let t = Token::issue(Grant::Actor(Actor::Soul(p.0))).expect("random bytes");
        file.push_str(&Tokens::line(t.grant(), &t.hash()));
        tokens.push(t.reveal().to_owned());
    }
    std::fs::write(dir.join("tokens"), file).unwrap_or_else(|e| fail(e));
    let glog = std::fs::File::create(dir.join("gatewayd.out")).unwrap_or_else(|e| fail(e));
    let mut g = Command::new(dir.join("bin/gatewayd"))
        .args(["--listen", "127.0.0.1:0", "--world"])
        .arg(socket_path(&state))
        .arg("--tokens")
        .arg(dir.join("tokens"))
        .args(["--build", "1220"])
        .stdout(Stdio::piped())
        .stderr(glog)
        .spawn()
        .unwrap_or_else(|e| fail(e));
    let mut line = String::new();
    BufReader::new(g.stdout.take().expect("stdout"))
        .read_line(&mut line)
        .unwrap_or_else(|e| fail(e));
    let addr = line
        .trim()
        .strip_prefix("listening ")
        .unwrap_or_else(|| fail("gatewayd did not listen"))
        .to_owned();
    let url = format!("ws://{addr}{}", gatewayd::socket::PATH);
    let stop = Arc::new(AtomicBool::new(false));
    let agents: Vec<_> = tokens
        .into_iter()
        .enumerate()
        .map(|(i, t)| {
            let every = Duration::from_millis(1000 + (i as u64 * 7919) % 500);
            tokio::spawn(agent(url.clone(), t, pairs[i], every, stop.clone()))
        })
        .collect();
    tokio::time::sleep(Duration::from_secs(5)).await;

    // The deploys, on a thread of their own: each blocks while it watches.
    let (root2, root_abs, unit_ref) = (here_root.clone(), root.clone(), Arc::new(Mutex::new(unit)));
    let u = unit_ref.clone();
    let deploys = tokio::task::spawn_blocking(move || {
        let store = Folder::new(root_abs.join("directory"));
        let d = Deploy {
            store: &store,
            root: &root2,
            world,
            canary,
            window: 100,
        };
        let mut unit = u.lock().expect("the unit");
        let mut out = Vec::new();
        for (what, b) in &plants {
            let r = d.run(b, &mut *unit, &mut probe);
            out.push((what.to_string(), r));
            std::thread::sleep(Duration::from_secs(3));
        }
        let kept = d.run(&good_b, &mut *unit, &mut probe);
        out.push(("a good new build".into(), kept));
        let before = records(&state_path(&root2, &world));
        let mut tl = Timeline::default();
        let t0 = Instant::now();
        let refused = d.roll_back(&older, &good_b, true, &mut *unit, &mut probe, &mut |s| {
            tl.0.push((t0.elapsed().as_millis(), s))
        });
        let serving = watch(
            &socket_path(&state_path(&root2, &world)),
            &canary,
            &mut probe,
            false,
        );
        let after = records(&state_path(&root2, &world));
        tl.0.push((
            t0.elapsed().as_millis(),
            format!(
                "after the refusal: the world served the probe for {} ms: {serving:?}; its log grew from {before} to {after} records",
                canary.window.as_millis()
            ),
        ));
        (out, refused, tl, serving)
    });
    let (out, refused, refused_tl, serving) = deploys.await.unwrap_or_else(|e| fail(e));
    tokio::time::sleep(Duration::from_secs(3)).await;
    stop.store(true, Ordering::Relaxed);
    let mut results = Vec::new();
    for h in agents {
        results.push(h.await.unwrap_or_else(|e| fail(e)));
    }
    let _ = g.kill();
    let _ = g.wait();
    let unit = unit_ref.lock().expect("the unit");
    let starts = unit.starts.load(Ordering::SeqCst);
    unit.halt();
    drop(unit);
    std::thread::sleep(Duration::from_millis(300));

    // The report.
    let mut fails = Vec::new();
    println!("# O7 run: deploy and roll back one world\n");
    for (what, (ended, tl, r)) in &out {
        print(&format!("{what}: {ended:?}"), tl);
        let within = rolled_back_in(tl);
        if what != "a good new build" {
            println!(
                "\nRolled back by the machine in {within:?} ms (canary restart to serving again)."
            );
            if !matches!(ended, Ended::RolledBack { .. }) || within.is_none_or(|ms| ms > 60_000) {
                fails.push(format!("A1 {what}"));
            }
        } else if *ended != Ended::Kept {
            fails.push("A4 setup: the good build was not kept".into());
        }
        if let Some(r) = r {
            let scratch = r
                .scratch
                .strip_prefix(&dir)
                .unwrap_or(&r.scratch)
                .display()
                .to_string();
            println!(
                "\nRehearsal (A5): scratch copy `{scratch}/log`; {} records copied; {} recorded intents fed, {} named ends ({} receipts, refused {:?}); served log `root/worlds/<world>/log`: its first {} bytes (SHA-256 {}…) the same after: {}.",
                r.copied,
                r.fed,
                r.ended,
                r.receipts,
                r.refused,
                r.served_len,
                &r.served_sha[..16],
                r.served_kept
            );
            if !r.served_kept
                || r.fed == 0
                || r.ended != r.fed
                || !r.scratch.starts_with(Path::new(".").join("rehearsals"))
            {
                fails.push(format!("A5 {what}"));
            }
        }
    }
    print(
        "A rollback to a build that reads only an older schema",
        &refused_tl,
    );
    println!("\nRefused: {refused:?}");
    if !matches!(&refused, Err(e) if e.starts_with("rollback.schema-unread")) || serving.is_err() {
        fails.push("A4".into());
    }

    let signed_in = results
        .iter()
        .filter(|(open, ends)| *open || !ends.is_empty())
        .count();
    let open = results.iter().filter(|(open, _)| *open).count();
    println!(
        "\n### Sockets (A2)\n\n{AGENTS} agents; signed in {signed_in}; still open at the end, before each agent closed its own: {open}; dropped: {}.",
        AGENTS - open
    );
    if open != AGENTS {
        fails.push("A2".into());
    }

    let log = std::fs::read(log_path(&state)).unwrap_or_else(|e| fail(e));
    let found = recover(&log).unwrap_or_else(|e| fail(e));
    let mut logged: BTreeSet<(Id, u64)> = BTreeSet::new();
    let mut logged_refused: BTreeMap<String, u64> = BTreeMap::new();
    for r in &found.records {
        let Ok(Value::Map(part)) = decode(r).map(|d| d.value) else {
            continue;
        };
        let Some(Value::Array(rows)) = part.get(&ANSWERED) else {
            continue;
        };
        for row in rows {
            let Value::Map(m) = row else { continue };
            let (Some(Value::Bytes(k)), Some(Value::Uint(q))) = (m.get(&1), m.get(&2)) else {
                continue;
            };
            let body = decode(k).ok().and_then(|d| match d.value {
                Value::Map(a) => a.get(&2).and_then(|v| read_id(v).ok()),
                _ => None,
            });
            if let Some(b) = body {
                logged.insert((b, *q));
            }
            if let Some(Value::Bytes(f)) = m.get(&4)
                && let Some((_, End::Refused(why))) = read_answer(f)
            {
                *logged_refused.entry(why).or_default() += 1;
            }
        }
    }
    let (mut sent, mut receipts, mut restarting, mut unanswered, mut acked, mut lost) =
        (0, 0, 0, 0, 0, 0);
    let mut refused_by: BTreeMap<String, u64> = BTreeMap::new();
    for (i, (_, ends)) in results.iter().enumerate() {
        for (seq, e) in ends {
            sent += 1;
            if e.is_empty() {
                unanswered += 1;
            }
            for end in e {
                match end {
                    End::Receipt => receipts += 1,
                    End::Refused(w) if w == "world.restarting" => restarting += 1,
                    End::Refused(w) => *refused_by.entry(w.clone()).or_default() += 1,
                    End::Unnamed => unanswered += 1,
                }
            }
            // Acknowledged by a world (not the gateway's own `world.restarting`): it must be in the log.
            if e.iter().any(|x| {
                matches!(x, End::Receipt) || matches!(x, End::Refused(w) if w != "world.restarting")
            }) {
                acked += 1;
                if !logged.contains(&(pairs[i].0, *seq)) {
                    lost += 1;
                }
            }
        }
    }
    println!(
        "\n### Acts (A3)\n\nSent {sent}: receipts {receipts}; refused by the world {refused_by:?}; `world.restarting` (the gateway, while the world was away) {restarting}; no named end {unanswered}.\nAcknowledged by a world {acked}; of them not in the log after it all: {lost}. Refusals in the log by name: {logged_refused:?}.\nThe launcher started the world {starts} times."
    );
    if unanswered != 0 || lost != 0 || acked == 0 {
        fails.push("A3".into());
    }
    println!(
        "\nResult: {}",
        if fails.is_empty() {
            "pass".to_owned()
        } else {
            format!("FAIL {fails:?}")
        }
    );
    std::process::exit(i32::from(!fails.is_empty()));
}
