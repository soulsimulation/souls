//! Subscriptions served to the gateway (#3292, the prerequisite of V13 #2745): R4's [`Hub`] runs on the view tier's
//! own thread, fed each committed tick's record once it is on the disk ([`Feed::record`], from the answers thread),
//! and serves the gateway's subscriptions on a local socket of its own, apart from the intents' socket, so a busy view
//! never delays an answer.
//!
//! Frames both ways are a 4-byte big-endian length and that many bytes (the intents' socket's framing):
//!
//! - gateway → world: `{1: n, 2: request, 3: [audience id, ...]}` subscribes under the gateway's number `n`, as one
//!   who is in those audiences (the gateway resolves them for the socket's grant); a request is
//!   [`Request::from_value`]'s form. `{1: n}` alone ends it. A subscribe under a number in use replaces it.
//! - world → gateway: `{1: n, 2: item}`, one of R4's items as its bytes, or `{1: n, 3: name}` when the request is
//!   refused (`subscribe-unread`, `budget-below-minimum`, `no-scope`).
//!
//! The hub knows the bodies its records created, and those of the world as built when it is seeded with them
//! ([`start_with`], `Hub::seed`). Started with K16's store (`Hub::with_words`), it sends each utterance a subscriber
//! hears with its words, read for that subscriber's audiences (C6, #3390).

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::mpsc::{Receiver, Sender, channel};

use replica::effects::{Part, Refusal, read_id};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::Id;

use super::subscription::{Hub, Request};

type R<T> = Result<T, Refusal>;

/// The longest frame read from the gateway: a request names a few scopes and audiences.
const FRAME_MOST: usize = 64 * 1024;

enum Cmd {
    Record(Vec<u8>),
    Subscribe {
        conn: u64,
        n: u64,
        request: Value,
        audiences: Value,
        out: Sender<Vec<u8>>,
    },
    End {
        conn: u64,
        n: u64,
    },
    Gone(u64),
}

/// A subscription held: the hub's number for it, and where its items go.
type Held = (usize, Sender<Vec<u8>>);

/// Hands the view tier's thread what it reads: committed records, and the gateway's subscriptions.
#[derive(Clone)]
pub struct Feed {
    tx: Sender<Cmd>,
}

impl Feed {
    /// One tick's record (a T6 part), once it is on the disk. Never waits.
    pub fn record(&self, bytes: Vec<u8>) {
        let _ = self.tx.send(Cmd::Record(bytes));
    }
}

/// Starts the view tier's thread with an empty hub.
pub fn start() -> R<Feed> {
    start_with(Hub::new())
}

/// Starts the view tier's thread with `hub`: one that reads utterances' words, seeded with the world as built (C6).
pub fn start_with(hub: Hub) -> R<Feed> {
    let (tx, rx) = channel();
    std::thread::Builder::new()
        .name("view-tier".into())
        .spawn(move || run(hub, &rx))
        .map_err(|e| Refusal {
            name: "view-tier",
            detail: format!("the thread did not start: {e}"),
        })?;
    Ok(Feed { tx })
}

fn frame(n: u64, k: u64, v: Value) -> Vec<u8> {
    encode(&Value::Map([(1, Value::Uint(n)), (k, v)].into())).unwrap_or_default()
}

fn audiences(v: &Value) -> R<BTreeSet<Id>> {
    match v {
        Value::Array(ids) => ids.iter().map(read_id).collect(),
        _ => Ok(BTreeSet::new()),
    }
}

/// The view tier's thread: a fault in a record is named and the tier goes on; the clock never waits on it.
fn run(mut hub: Hub, rx: &Receiver<Cmd>) {
    // (connection, gateway's number) -> (hub's number, where its items go).
    let mut subs: BTreeMap<(u64, u64), Held> = BTreeMap::new();
    while let Ok(cmd) = rx.recv() {
        match cmd {
            Cmd::Record(bytes) => {
                let read = Part::read(&bytes).and_then(|p| hub.tick(&p));
                if let Err(e) = read {
                    eprintln!("worldd: view tier: a record was not read: {e}");
                }
                // Each subscription's items to its own connection; one whose connection is gone ends.
                subs.retain(|(_, n), (i, out)| {
                    let sent = hub.drain(*i).into_iter().all(|o| {
                        out.send(frame(*n, 2, Value::Bytes(o.bytes.to_vec())))
                            .is_ok()
                    });
                    if !sent {
                        hub.unsubscribe(*i);
                    }
                    sent
                });
            }
            Cmd::Subscribe {
                conn,
                n,
                request,
                audiences: a,
                out,
            } => {
                if let Some((i, _)) = subs.remove(&(conn, n)) {
                    hub.unsubscribe(i);
                }
                let made = Request::from_value(&request)
                    .and_then(|r| Ok((r, audiences(&a)?)))
                    .and_then(|(r, a)| hub.subscribe_as(r, a));
                match made {
                    Ok(i) => {
                        let sent = hub.drain(i).into_iter().all(|o| {
                            out.send(frame(n, 2, Value::Bytes(o.bytes.to_vec())))
                                .is_ok()
                        });
                        if sent {
                            subs.insert((conn, n), (i, out));
                        } else {
                            hub.unsubscribe(i);
                        }
                    }
                    Err(e) => {
                        let name =
                            Name::new(e.name).unwrap_or_else(|| unreachable!("a refusal's name"));
                        let _ = out.send(frame(n, 3, Value::Text(name)));
                    }
                }
            }
            Cmd::End { conn, n } => {
                if let Some((i, _)) = subs.remove(&(conn, n)) {
                    hub.unsubscribe(i);
                }
            }
            Cmd::Gone(conn) => subs.retain(|(c, _), (i, _)| {
                if *c == conn {
                    hub.unsubscribe(*i);
                }
                *c != conn
            }),
        }
    }
}

/// Listens for the gateway on `path` (replacing a stale socket file), one thread per connection.
pub fn listen(feed: Feed, path: &Path) -> R<()> {
    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path).map_err(|e| Refusal {
        name: "views-socket",
        detail: e.to_string(),
    })?;
    std::thread::Builder::new()
        .name("views-listen".into())
        .spawn(move || {
            for (conn, stream) in (1u64..).zip(listener.incoming().flatten()) {
                let feed = feed.clone();
                std::thread::spawn(move || serve(&feed, conn, stream));
            }
        })
        .map_err(|e| Refusal {
            name: "views-socket",
            detail: e.to_string(),
        })?;
    Ok(())
}

/// Serves one connection of the gateway: its requests to the tier, the tier's items back, in order.
pub fn serve(feed: &Feed, conn: u64, mut stream: UnixStream) {
    let Ok(mut write) = stream.try_clone() else {
        return;
    };
    let (out, items) = channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for f in items {
            let len = u32::try_from(f.len()).unwrap_or(u32::MAX).to_be_bytes();
            if write.write_all(&len).is_err() || write.write_all(&f).is_err() {
                return;
            }
        }
    });
    loop {
        let mut len = [0u8; 4];
        if stream.read_exact(&mut len).is_err() {
            break;
        }
        let len = u32::from_be_bytes(len) as usize;
        if len > FRAME_MOST {
            break;
        }
        let mut bytes = vec![0u8; len];
        if stream.read_exact(&mut bytes).is_err() {
            break;
        }
        let Ok(Value::Map(mut m)) = decode(&bytes).map(|d| d.value) else {
            continue;
        };
        let Some(Value::Uint(n)) = m.remove(&1) else {
            continue;
        };
        let cmd = match m.remove(&2) {
            Some(request) => Cmd::Subscribe {
                conn,
                n,
                request,
                audiences: m.remove(&3).unwrap_or(Value::Array(Vec::new())),
                out: out.clone(),
            },
            None => Cmd::End { conn, n },
        };
        if feed.tx.send(cmd).is_err() {
            break;
        }
    }
    let _ = feed.tx.send(Cmd::Gone(conn));
}

#[cfg(test)]
mod tests {
    //! A1's world side: the answers thread hands each committed record to the tier once it is on the disk, and the
    //! hub there serves it to a subscription on the views socket. The gateway's side, A2 to A4: `gatewayd`'s
    //! `tests/views.rs`.
    use super::*;
    use crate::answers::{self, Config};
    use crate::checkers::toggles;
    use replica::effects::Actor;
    use replica::ids::{Scope, Version};
    use replica::intents::{Intent, Target};
    use sim::log::Mem;
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use std::time::Duration;

    const LINEAGE: Scope = Scope([9; 16]);

    #[test]
    fn subscription_grant_arrives_without_any_record() {
        let feed = start().unwrap();
        let (out, items) = channel();
        feed.tx
            .send(Cmd::Subscribe {
                conn: 1,
                n: 7,
                request: Value::Map(
                    [
                        (
                            1,
                            Value::Array(vec![Value::Map(
                                [(2, Id::new(LINEAGE, 1).unwrap().to_value())].into(),
                            )]),
                        ),
                        (2, Value::Uint(2)),
                        (3, Value::Uint(8000)),
                    ]
                    .into(),
                ),
                audiences: Value::Array(Vec::new()),
                out,
            })
            .unwrap();
        let bytes = items
            .recv_timeout(Duration::from_millis(500))
            .expect("grant without a tick");
        let Value::Map(frame) = decode(&bytes).unwrap().value else {
            panic!("frame")
        };
        assert_eq!(kind(frame.get(&2).unwrap()), Some(5));
    }

    fn toggle(body: Id, thing: Id, sequence: u64) -> Vec<u8> {
        let i = Intent {
            actor: Actor::Soul(body),
            verb: Name::new("r2:switch_on").unwrap(),
            target: Some(Target::Node(thing)),
            parameters: BTreeMap::new(),
            sequence,
            basis: Version {
                lineage: LINEAGE,
                zone: Id::new(LINEAGE, 0).unwrap(),
                epoch: 1,
                sequence: 0,
            }
            .to_value(),
            expiry: i64::MAX,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
        };
        encode(&i.to_value()).unwrap()
    }

    fn read(s: &mut UnixStream) -> Option<BTreeMap<u64, Value>> {
        let mut len = [0u8; 4];
        s.read_exact(&mut len).ok()?;
        let mut b = vec![0u8; u32::from_be_bytes(len) as usize];
        s.read_exact(&mut b).ok()?;
        match decode(&b).ok()?.value {
            Value::Map(m) => Some(m),
            _ => None,
        }
    }

    fn kind(item: &Value) -> Option<u64> {
        let Value::Bytes(b) = item else { return None };
        match decode(b).ok()?.value {
            Value::Map(m) => match m.get(&1) {
                Some(Value::Uint(k)) => Some(*k),
                _ => None,
            },
            _ => None,
        }
    }

    #[test]
    fn a1_committed_parts_feed_the_hub_on_the_view_tier() {
        let feed = start().unwrap();
        let w = toggles::World::build(1, 2, 0);
        let (body, thing) = w.pairs[0];
        let mut cfg = Config::new(LINEAGE, 1);
        cfg.tick = Duration::from_millis(10);
        cfg.measures = false;
        cfg.served = Some(feed.clone());
        let world =
            answers::start(w.replica, toggles::rules(), Mem::with(Vec::new()), cfg).unwrap();

        let (ours, mut gateway) = UnixStream::pair().unwrap();
        std::thread::spawn(move || serve(&feed, 1, ours));
        // Subscribes to the toggled thing's node at counts, as soul `body` (the gateway resolved its audience).
        let request = Value::Map(
            [
                (
                    1,
                    Value::Array(vec![Value::Map([(1, thing.to_value())].into())]),
                ),
                (2, Value::Uint(4)),
                (3, Value::Uint(1_000)),
            ]
            .into(),
        );
        let f = encode(&Value::Map(
            [
                (1, Value::Uint(7)),
                (2, request),
                (3, Value::Array(vec![body.to_value()])),
            ]
            .into(),
        ))
        .unwrap();
        let len = u32::try_from(f.len()).unwrap().to_be_bytes();
        gateway.write_all(&len).unwrap();
        gateway.write_all(&f).unwrap();
        gateway
            .set_read_timeout(Some(Duration::from_millis(50)))
            .unwrap();

        // Each commit's record reaches the tier after its sync; the first read after the subscription opens it.
        let mut kinds = Vec::new();
        for seq in 1..=40 {
            let (reply, answer) = channel();
            assert!(world.door().arrive(toggle(body, thing, seq), reply));
            answer
                .recv_timeout(Duration::from_secs(5))
                .expect("an answer");
            while let Some(m) = read(&mut gateway) {
                assert_eq!(
                    m.get(&1),
                    Some(&Value::Uint(7)),
                    "under the gateway's number"
                );
                kinds.extend(m.get(&2).and_then(kind));
            }
            if kinds.contains(&4) {
                break;
            }
        }
        assert_eq!(kinds.first(), Some(&5), "the grant first: {kinds:?}");
        assert!(
            kinds.contains(&4),
            "the node's count, from a committed part: {kinds:?}"
        );
        world.stop();
    }

    /// A say or a whisper by `body`, its words T8's `{23: words}` in parameter 1.
    fn words(body: Id, verb: &str, to: Option<Id>, words: &str, sequence: u64) -> Vec<u8> {
        let p = Value::Map([(23, Value::Bytes(words.as_bytes().to_vec()))].into());
        let i = Intent {
            actor: Actor::Soul(body),
            verb: Name::new(verb).unwrap(),
            target: to.map(Target::Node),
            parameters: [(1, p)].into(),
            sequence,
            basis: Version {
                lineage: LINEAGE,
                zone: Id::new(LINEAGE, 0).unwrap(),
                epoch: 1,
                sequence: 0,
            }
            .to_value(),
            expiry: i64::MAX,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
        };
        encode(&i.to_value()).unwrap()
    }

    #[test]
    fn c6_a1_a_soul_hears_what_is_said_near_it_with_its_words_and_a_whisper_only_its_listener() {
        let w = toggles::World::build(1, 3, 0);
        let [a, b, c] = [w.pairs[0].0, w.pairs[1].0, w.pairs[2].0];
        let text = Arc::new(crate::words::in_memory(LINEAGE).unwrap());
        let mut hub = Hub::with_words(Arc::clone(&text));
        hub.seed(w.replica.tree());
        let feed = start_with(hub).unwrap();
        let mut cfg = Config::new(LINEAGE, 1);
        cfg.tick = Duration::from_millis(10);
        cfg.measures = false;
        cfg.served = Some(feed.clone());
        cfg.text = Some(text);
        let world =
            answers::start(w.replica, toggles::rules(), Mem::with(Vec::new()), cfg).unwrap();

        let (ours, mut gateway) = UnixStream::pair().unwrap();
        std::thread::spawn(move || serve(&feed, 1, ours));
        // Each Soul follows its own body, in its own audience, as the gateway subscribes it (numbers 1 to 3).
        for (n, body) in [(1u64, a), (2, b), (3, c)] {
            let scope = Value::Map([(2, body.to_value())].into());
            let request = Value::Map(
                [
                    (1, Value::Array(vec![scope])),
                    (2, Value::Uint(3)),
                    (3, Value::Uint(8_000)),
                ]
                .into(),
            );
            let f = encode(&Value::Map(
                [
                    (1, Value::Uint(n)),
                    (2, request),
                    (3, Value::Array(vec![body.to_value()])),
                ]
                .into(),
            ))
            .unwrap();
            gateway
                .write_all(&u32::try_from(f.len()).unwrap().to_be_bytes())
                .unwrap();
            gateway.write_all(&f).unwrap();
        }
        gateway
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let said = "the bread is still warm";
        let whispered = "meet me by the door";
        for (seq, intent) in [
            (1, words(a, "local:say", None, said, 1)),
            (2, words(a, "local:whisper", Some(c), whispered, 2)),
        ] {
            let (reply, answer) = channel();
            assert!(world.door().arrive(intent, reply), "intent {seq} taken");
            answer
                .recv_timeout(Duration::from_secs(5))
                .expect("an answer");
        }
        // Every utterance each subscription was sent: (its number, the speaker, the words).
        let mut heard: Vec<(u64, Id, Option<String>)> = Vec::new();
        // Four are due (the say to each of the three, the whisper to C); one more round would show a fifth.
        let mut rounds_after = 0;
        for _ in 0..30 {
            while let Some(m) = read(&mut gateway) {
                let (Some(Value::Uint(n)), Some(Value::Bytes(item))) = (m.get(&1), m.get(&2))
                else {
                    continue;
                };
                if let Some(h) = replica::speech::heard(item).unwrap() {
                    let w = h.words.map(|w| String::from_utf8(w).unwrap());
                    heard.push((*n, h.speaker, w));
                }
            }
            if heard.len() >= 4 {
                rounds_after += 1;
                if rounds_after > 1 {
                    break;
                }
            }
        }
        let to = |n: u64| -> Vec<Option<&str>> {
            heard
                .iter()
                .filter(|h| h.0 == n)
                .map(|h| h.2.as_deref())
                .collect()
        };
        assert!(heard.iter().all(|h| h.1 == a), "all said by A: {heard:?}");
        assert_eq!(to(1), vec![Some(said)], "A hears its say, not its whisper");
        assert_eq!(
            to(2),
            vec![Some(said)],
            "B hears the say, never the whisper"
        );
        assert_eq!(to(3), vec![Some(said), Some(whispered)], "C hears both");
        world.stop();
    }
}
