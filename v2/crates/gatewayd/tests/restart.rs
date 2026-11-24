//! I4's durable half (0.133 verification): a walk the world accepted before the gateway restarted (`kill -9` here;
//! `kill -TERM` stops it the same way, `world_link`) ends after the restart, and its receipt reaches the Soul, once.
//! The real `gatewayd` program in front of a stand-in world that does what `worldd` does (`worldd::handover`): each
//! connection's first frame is the gateway's handover ask, an intent is answered with progress at once, and the
//! final answer, whose connection has ended by then, goes to the newest gateway connection, here twice (the world's
//! copy for an ended connection and its own answer to a repeat), so the gateway must pass it on once.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use replica::effects::Actor;
use replica::encode::{Name, Value, decode, encode, to_hex};
use replica::ids::{Id, Scope, Version, sha256};
use replica::intents::{Answer, Hello, Intent, PROTOCOL};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::{TcpStream, UnixListener};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const BUILD: &str = "1220abcd";
const LINEAGE: Scope = Scope([7; 16]);

fn version(sequence: u64) -> Version {
    Version {
        lineage: LINEAGE,
        zone: Id::new(LINEAGE, 0).unwrap(),
        epoch: 1,
        sequence,
    }
}

fn actor() -> Actor {
    Actor::Soul(Id::new(Scope([1; 16]), 5).unwrap())
}

/// The wall clock, µs from the Unix epoch, for an intent's expiry (world time is real time).
#[allow(clippy::disallowed_methods)]
fn unix_us() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as i64
}

fn walk(sequence: u64) -> Vec<u8> {
    let i = Intent {
        actor: actor(),
        verb: Name::new("eden:walk").unwrap(),
        target: None,
        parameters: BTreeMap::new(),
        sequence,
        basis: version(0).to_value(),
        expiry: unix_us() + 120_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    encode(&i.to_value()).unwrap()
}

/// The gateway's handover ask as `worldd::handover::ask` reads it: `{31: []}` (`world_link::HANDOVER`).
fn handover_ask() -> Vec<u8> {
    encode(&Value::Map([(31, Value::Array(Vec::new()))].into())).unwrap()
}

fn framed(v: Value) -> Vec<u8> {
    let frame = encode(&v).unwrap();
    let mut out = u32::try_from(frame.len()).unwrap().to_be_bytes().to_vec();
    out.extend(frame);
    out
}

/// The stand-in world's connections, newest last: whether each began with the handover ask, and its writer.
type Conns = Arc<Mutex<Vec<(Arc<AtomicBool>, Arc<tokio::sync::Mutex<OwnedWriteHalf>>)>>>;

/// Answers each intent with C20's progress (accepted, 60 s left) on its own connection, and keeps every connection.
async fn world(listener: UnixListener, conns: Conns) {
    while let Ok((s, _)) = listener.accept().await {
        let (mut read, write) = s.into_split();
        let write = Arc::new(tokio::sync::Mutex::new(write));
        let asked = Arc::new(AtomicBool::new(false));
        conns.lock().unwrap().push((asked.clone(), write.clone()));
        tokio::spawn(async move {
            let mut first = true;
            loop {
                let mut len = [0u8; 4];
                if read.read_exact(&mut len).await.is_err() {
                    return;
                }
                let mut bytes = vec![0u8; u32::from_be_bytes(len) as usize];
                if read.read_exact(&mut bytes).await.is_err() {
                    return;
                }
                if std::mem::take(&mut first) && bytes == handover_ask() {
                    asked.store(true, Ordering::SeqCst);
                    continue;
                }
                let Ok(i) = Intent::read(&bytes) else {
                    continue;
                };
                let Value::Map(mut a) = (Answer::Accepted {
                    actor: i.actor,
                    sequence: i.sequence,
                    intent: Id::new(LINEAGE, 1).unwrap(),
                })
                .to_value() else {
                    unreachable!()
                };
                a.insert(5, Value::Uint(60_000_000));
                let f = framed(Value::Map(
                    [(1, version(1).to_value()), (2, Value::Map(a))].into(),
                ));
                let _ = write.lock().await.write_all(&f).await;
            }
        });
    }
}

struct Gatewayd(Child, String);

impl Drop for Gatewayd {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn gatewayd(world: &Path, tokens: &Path) -> Gatewayd {
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

async fn next(ws: &mut Ws) -> Option<Value> {
    loop {
        match ws.next().await? {
            Ok(Message::Binary(b)) => return Some(decode(&b).unwrap().value),
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
}

/// Signs in, with the cursor when given; the socket and the sign-in's outcome.
async fn connect(addr: &str, token: &str, cursor: Option<Value>) -> (Ws, Value) {
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
    let mut m = BTreeMap::from([(1, Value::Text(Name::new(token).unwrap()))]);
    if let Some(c) = cursor {
        m.insert(2, c);
    }
    ws.send(Message::Binary(encode(&Value::Map(m)).unwrap().into()))
        .await
        .unwrap();
    let outcome = next(&mut ws).await.unwrap();
    (ws, outcome)
}

/// The answer's kind and sequence in a frame (`{2: {2: sequence, 3: kind}}`).
fn kind_and_sequence(v: &Value) -> (Option<u64>, Option<u64>) {
    let Value::Map(m) = v else {
        return (None, None);
    };
    let Some(Value::Map(a)) = m.get(&2) else {
        return (None, None);
    };
    let uint = |k| match a.get(&k) {
        Some(Value::Uint(n)) => Some(*n),
        _ => None,
    };
    (uint(3), uint(2))
}

async fn connections(conns: &Conns, n: usize) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while conns.lock().unwrap().len() < n {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the gateway connects to the world");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn i4_a_walk_accepted_before_a_gateway_restart_gets_its_receipt_after_it_once() {
    restart("i4-restart", false).await;
}

/// The client sends the walk again through the new gateway (`gateway-upgrade.md` step 3): the new gateway keeps it,
/// and the world's answer to the repeat and its handed-on copy from the ended connection reach the Soul once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn i4_a_walk_sent_again_through_the_new_gateway_gets_its_receipt_once() {
    restart("i4-resend", true).await;
}

/// A walk through one gateway, `kill -9`, a second gateway (and with `resend`, the walk sent again through it), then
/// its receipt from the world twice on the newest connection: the Soul gets it once.
async fn restart(name: &str, resend: bool) {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let world_path = dir.join("w.sock");
    let conns: Conns = Arc::default();
    tokio::spawn(world(
        UnixListener::bind(&world_path).unwrap(),
        conns.clone(),
    ));
    let grant = format!("soul-{}-5", to_hex(&[1; 16]));
    let token = format!("{grant}.{}", to_hex(&sha256(b"i4 restart")));
    std::fs::write(
        dir.join("tokens.txt"),
        format!("{grant} {}\n", to_hex(&sha256(token.as_bytes()))),
    )
    .unwrap();

    // The walk is sent through the first gateway, and the world says it is under way.
    let mut first = gatewayd(&world_path, &dir.join("tokens.txt"));
    connections(&conns, 1).await;
    let (mut ws, _) = connect(&first.1, &token, None).await;
    ws.send(Message::Binary(walk(1).into())).await.unwrap();
    let progress = next(&mut ws).await.unwrap();
    assert_eq!(kind_and_sequence(&progress), (Some(3), Some(1)));
    let Value::Map(p) = &progress else { panic!() };
    let cursor = p.get(&1).cloned();

    // The gateway is killed outright, and its successor connects to the world, saying it is the gateway.
    let _ = first.0.kill();
    let _ = first.0.wait();
    let second = gatewayd(&world_path, &dir.join("tokens.txt"));
    connections(&conns, 2).await;
    let (mut ws, _) = connect(&second.1, &token, cursor).await;
    if resend {
        ws.send(Message::Binary(walk(1).into())).await.unwrap();
        let progress = next(&mut ws).await.unwrap();
        assert_eq!(kind_and_sequence(&progress), (Some(3), Some(1)));
    }

    // The walk ends: the world hands its receipt to the newest connection, and it comes twice.
    let receipt = Answer::Receipt {
        actor: actor(),
        sequence: 1,
        intent: Id::new(LINEAGE, 1).unwrap(),
        entries: vec![2],
        names: BTreeMap::new(),
    };
    let f = framed(Value::Map(
        [(1, version(2).to_value()), (2, receipt.to_value())].into(),
    ));
    let newest = conns.lock().unwrap().last().unwrap().1.clone();
    for _ in 0..2 {
        newest.lock().await.write_all(&f).await.unwrap();
    }
    let got = tokio::time::timeout(Duration::from_secs(5), next(&mut ws))
        .await
        .expect("the walk's receipt reaches the Soul after the restart")
        .unwrap();
    assert_eq!(kind_and_sequence(&got), (Some(1), Some(1)), "{got:?}");
    let again = tokio::time::timeout(Duration::from_millis(500), next(&mut ws)).await;
    assert!(again.is_err(), "the receipt came twice: {again:?}");
    let asked: Vec<bool> = conns
        .lock()
        .unwrap()
        .iter()
        .map(|c| c.0.load(Ordering::SeqCst))
        .collect();
    assert_eq!(
        asked,
        [true, true],
        "each connection begins with the handover ask"
    );
}
