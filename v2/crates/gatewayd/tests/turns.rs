//! S2 (0.133): one noisy agent does not slow the others. The real `gatewayd` program in front of a stand-in world that
//! takes intents as a world's tick does: it reads its link as fast as it comes, first come first served, and answers
//! at most [`PER_TICK`] intents each [`TICK`] (200 a second). One agent sends 200 intents a second and 99 send one
//! every 4 s; the 99's receipt time, typical (the median) and worst 1 in 20, stays within 10 % of a run without the
//! flood, because the gateway keeps each agent's place in the world's line (`world_link.rs`, Turns). The run also
//! reports the sockets one gateway holds and its memory per socket (its resident memory with the 100 signed in, less
//! before, over 100).
//!
//! S2_REPORT=1 prints the figures.

use std::collections::{BTreeMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use replica::effects::Actor;
use replica::encode::{Name, Value, decode, encode, to_hex};
use replica::ids::{Id, Scope, Version, sha256};
use replica::intents::{Answer, Hello, Intent, PROTOCOL};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UnixListener};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const BUILD: &str = "1220abcd";
const LINEAGE: Scope = Scope([7; 16]);
/// The stand-in world's tick, and the intents it answers in each.
const TICK: Duration = Duration::from_millis(50);
const PER_TICK: usize = 10;
/// The quiet agents, how often each sends, and the flood's pace (200 a second).
const QUIET: u64 = 99;
const EVERY: Duration = Duration::from_secs(4);
const FLOOD: Duration = Duration::from_millis(5);
/// Each arm's length.
const RUN: Duration = Duration::from_secs(20);

fn version(sequence: u64) -> Version {
    Version {
        lineage: LINEAGE,
        zone: Id::new(LINEAGE, 0).unwrap(),
        epoch: 1,
        sequence,
    }
}

fn actor(n: u64) -> Actor {
    Actor::Soul(Id::new(Scope([1; 16]), n).unwrap())
}

fn intent(n: u64, sequence: u64) -> Vec<u8> {
    let i = Intent {
        actor: actor(n),
        verb: Name::new("eden:wave").unwrap(),
        target: None,
        parameters: BTreeMap::new(),
        sequence,
        basis: version(0).to_value(),
        expiry: 60_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    encode(&i.to_value()).unwrap()
}

/// The stand-in world: reads every frame as it comes into one line, and each tick answers the first [`PER_TICK`].
async fn world(listener: UnixListener) {
    while let Ok((s, _)) = listener.accept().await {
        let (mut read, mut write) = s.into_split();
        let line: Arc<Mutex<VecDeque<Intent>>> = Arc::default();
        let ticks = {
            let line = line.clone();
            tokio::spawn(async move {
                let mut version_now = 0;
                let mut tick = tokio::time::interval(TICK);
                loop {
                    tick.tick().await;
                    let taken: Vec<Intent> = {
                        let mut l = line.lock().unwrap();
                        let n = l.len().min(PER_TICK);
                        l.drain(..n).collect()
                    };
                    for i in taken {
                        version_now += 1;
                        let answer = Answer::Receipt {
                            actor: i.actor,
                            sequence: i.sequence,
                            intent: Id::new(LINEAGE, version_now).unwrap(),
                            entries: vec![version_now],
                            names: BTreeMap::new(),
                        };
                        let frame = encode(&Value::Map(
                            [(1, version(version_now).to_value()), (2, answer.to_value())].into(),
                        ))
                        .unwrap();
                        let len = u32::try_from(frame.len()).unwrap().to_be_bytes();
                        if write.write_all(&len).await.is_err()
                            || write.write_all(&frame).await.is_err()
                        {
                            return;
                        }
                    }
                }
            })
        };
        loop {
            let mut len = [0u8; 4];
            if read.read_exact(&mut len).await.is_err() {
                break;
            }
            let mut bytes = vec![0u8; u32::from_be_bytes(len) as usize];
            if read.read_exact(&mut bytes).await.is_err() {
                break;
            }
            if let Ok(i) = Intent::read(&bytes) {
                line.lock().unwrap().push_back(i);
            }
        }
        ticks.abort();
    }
}

/// The gateway program and the address it listens on.
struct Gatewayd(Child, String);

impl Drop for Gatewayd {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn gatewayd(world: &std::path::Path, tokens: &std::path::Path) -> Gatewayd {
    let mut child = Command::new(env!("CARGO_BIN_EXE_gatewayd"))
        .args(["--listen", "127.0.0.1:0", "--world"])
        .arg(world)
        .arg("--tokens")
        .arg(tokens)
        .args(["--build", BUILD])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("gatewayd starts");
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let addr = loop {
        let l = lines
            .next()
            .expect("gatewayd says where it listens")
            .unwrap();
        if let Some(a) = l.strip_prefix("listening ") {
            break a.to_owned();
        }
    };
    Gatewayd(child, addr)
}

/// Resident memory of process `pid`, kB.
fn rss_kb(pid: u32) -> u64 {
    let out = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .unwrap_or(0)
}

async fn next(ws: &mut Ws) -> Option<Value> {
    loop {
        match ws.next().await? {
            Ok(Message::Binary(b)) => return Some(decode(&b).unwrap().value),
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
}

/// Connects, exchanges first frames and signs in.
async fn connect(addr: &str, token: &str) -> Ws {
    let url = format!("ws://{addr}{}", gatewayd::socket::PATH);
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let hello = Hello {
        protocol: PROTOCOL,
        build: replica::encode::from_hex(BUILD).unwrap(),
        refused: None,
        other: None,
    };
    ws.send(Message::Binary(hello.to_bytes().unwrap().into()))
        .await
        .unwrap();
    next(&mut ws).await.unwrap();
    let sign_in = encode(&Value::Map(
        [(1, Value::Text(Name::new(token).unwrap()))].into(),
    ))
    .unwrap();
    ws.send(Message::Binary(sign_in.into())).await.unwrap();
    next(&mut ws).await.unwrap();
    ws
}

fn sequence_of(v: &Value) -> Option<u64> {
    let Value::Map(m) = v else { return None };
    let Some(Value::Map(a)) = m.get(&2) else {
        return None;
    };
    match a.get(&2) {
        Some(Value::Uint(s)) => Some(*s),
        _ => None,
    }
}

/// One arm: 99 quiet agents (and, with `flood`, the noisy one) on a fresh gateway and world. The quiet agents'
/// receipt times, ms, sorted; the sockets signed in; the gateway's memory per socket, kB.
// Real processes on the real clock: a receipt's time is real time.
#[allow(clippy::disallowed_methods)]
async fn arm(name: &str, flood: bool) -> (Vec<f64>, usize, f64) {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("s2-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let world_path = dir.join("w.sock");
    tokio::spawn(world(UnixListener::bind(&world_path).unwrap()));
    // Tokens: agent 0 floods, 1..=99 are quiet.
    let mut lines = String::new();
    let mut tokens = Vec::new();
    for n in 0..=QUIET {
        let grant = format!("soul-{}-{n}", to_hex(&[1; 16]));
        let mut secret = [0u8; 32];
        secret[..8].copy_from_slice(&(n + 1).to_be_bytes());
        let token = format!("{grant}.{}", to_hex(&sha256(&secret)));
        lines.push_str(&format!("{grant} {}\n", to_hex(&sha256(token.as_bytes()))));
        tokens.push(token);
    }
    let tokens_path = dir.join("tokens.txt");
    std::fs::write(&tokens_path, lines).unwrap();
    let gw = gatewayd(&world_path, &tokens_path);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let before = rss_kb(gw.0.id());
    let mut quiet = Vec::new();
    for n in 1..=QUIET {
        quiet.push(connect(&gw.1, &tokens[n as usize]).await);
    }
    let noisy = connect(&gw.1, &tokens[0]).await;
    let sockets = quiet.len() + 1;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let per_socket = rss_kb(gw.0.id()).saturating_sub(before) as f64 / sockets as f64;

    let end = Instant::now() + RUN;
    let flooding = flood.then(|| {
        let (mut tx, mut rx) = noisy.split();
        tokio::spawn(async move { while rx.next().await.is_some() {} });
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(FLOOD);
            let mut s = 0;
            while Instant::now() < end {
                tick.tick().await;
                s += 1;
                if tx.send(Message::Binary(intent(0, s).into())).await.is_err() {
                    break;
                }
            }
        })
    });
    let times: Arc<Mutex<Vec<f64>>> = Arc::default();
    let mut agents = Vec::new();
    for (k, mut ws) in quiet.into_iter().enumerate() {
        let times = times.clone();
        let n = k as u64 + 1;
        agents.push(tokio::spawn(async move {
            // Spread over the period, so the quiet agents do not all send in one tick.
            tokio::time::sleep(EVERY.mul_f64(k as f64 / QUIET as f64)).await;
            let mut s = 0;
            while Instant::now() < end {
                s += 1;
                let sent = Instant::now();
                ws.send(Message::Binary(intent(n, s).into())).await.unwrap();
                loop {
                    let v = next(&mut ws).await.expect("an answer");
                    if sequence_of(&v) == Some(s) {
                        break;
                    }
                }
                times
                    .lock()
                    .unwrap()
                    .push(sent.elapsed().as_secs_f64() * 1000.0);
                tokio::time::sleep(EVERY.saturating_sub(sent.elapsed())).await;
            }
        }));
    }
    for a in agents {
        a.await.unwrap();
    }
    if let Some(f) = flooding {
        f.abort();
    }
    let mut t = times.lock().unwrap().clone();
    t.sort_by(f64::total_cmp);
    (t, sockets, per_socket)
}

fn at(sorted: &[f64], q: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * q).round() as usize]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn s2_a_flooding_agent_leaves_the_others_receipt_times_within_ten_percent() {
    let (calm, sockets, per_socket) = arm("calm", false).await;
    let (noisy, _, _) = arm("noisy", true).await;
    let figures = [("typical", 0.5), ("worst 1 in 20", 0.95)]
        .map(|(what, q)| (what, at(&calm, q), at(&noisy, q)));
    if std::env::var_os("S2_REPORT").is_some() {
        println!(
            "s2: {} and {} receipts; sockets {sockets}, memory per socket {per_socket:.1} kB",
            calm.len(),
            noisy.len()
        );
        for (what, c, n) in &figures {
            println!(
                "s2: {what}: {c:.1} ms without the flood, {n:.1} ms with it ({:+.1} %)",
                (n / c - 1.0) * 100.0
            );
        }
    }
    assert!(
        calm.len() > 400 && noisy.len() > 400,
        "enough receipts: {} and {}",
        calm.len(),
        noisy.len()
    );
    for (what, c, n) in figures {
        assert!(
            n <= c * 1.10,
            "{what}: {n:.1} ms with the flood, {c:.1} ms without"
        );
    }
}
