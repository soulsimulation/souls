//! A served world's targets (follow-up of X7, #4015): what the driver's Souls walk to, sit on and act on, read the
//! way a client reads them, before the clock starts.
//!
//! - **The ids** come from one test Soul's copy ([`read_copy`]): signed in on its own socket, it asks the world for
//!   its scope's hashes and fetches every record they reach (R5b's compare and descend, `replica::sync`, as the
//!   client's daemon does), checked against their hashes. Each record gives a node's id and its kind's plain name
//!   (the Soul Actions entry its field 27 names, else its kind, without `@revision`).
//! - **The forms** come from the world's kind entries (`GET /v2/entries`, signed in with the same token, gzip), as
//!   the client's `inspect` reads them ([`read_entries`]). A gateway without entries (404) gives none.
//! - **The choice** ([`Targets::of`]): walks go to things with a seat (their stand point), else to any thing with an
//!   entry; sits to things with a seat of posture `sit`; each other shape kind to the first of its [`FORMS`] an entry
//!   offers, on the things of that kind, or on the Soul's own body for a body family's form (`owner: "family"`). A
//!   shape kind no entry offers goes as a walk and is counted (`standIns`).
//!
//! [`Choice`] then turns each act into an intent the way an agent would: a Soul seated by its last sit rises first
//! (a walk or a sit while seated is refused, `resource-held`), and says are withheld unless `--speech` opts in, so a
//! run on a world people visit says nothing out loud.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::{SinkExt, StreamExt};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::Id;
use replica::intents::{Hello, PROTOCOL};
use replica::rules::json::{self, Value as Json};
use replica::sync::{Copy, read_hashes, read_records, wire};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;

/// Each shape kind but walk, sit and say, and the entry forms that carry it, the first one offered taken.
pub const FORMS: &[(&str, &[&str])] = &[
    ("gesture", &["wave", "clap", "cheer"]),
    ("sit-ground", &["sit_down"]),
    ("read", &["read"]),
    ("eat", &["eat", "bite", "drink"]),
    ("play-music", &["play_music", "play"]),
];

/// What a Soul can be sent on this world.
#[derive(Debug, Default, PartialEq)]
pub struct Targets {
    pub walk: Vec<Id>,
    pub sit: Vec<Id>,
    /// Shape kind → the form's verb (`<entry namespace>:<form>`) and the things that offer it; none: the Soul's body.
    pub forms: BTreeMap<String, (String, Vec<Id>)>,
    /// Each Soul's body in the copy (its `souls:body-of` link), for a body family's form.
    pub bodies: BTreeMap<Id, Id>,
}

/// What a test Soul's copy holds: each node's id and plain kind, and each body's Soul.
#[derive(Debug, Default)]
pub struct Seen {
    pub nodes: Vec<(Id, String)>,
    pub bodies: BTreeMap<Id, Id>,
}

fn entry_ns(e: &Json) -> &str {
    e.get("kind")
        .and_then(Json::str)
        .and_then(|k| k.split_once(':'))
        .map_or("eden", |(ns, _)| ns)
}

fn has_slot(e: &Json, posture: Option<&str>) -> bool {
    e.get("slots").and_then(Json::obj).is_some_and(|s| {
        s.iter().any(|(_, s)| {
            let p = s.get("posture").and_then(Json::str);
            match posture {
                Some(want) => p == Some(want),
                None => p.is_some() || s.get("admits").and_then(Json::str) == Some("body"),
            }
        })
    })
}

/// Whether the entry offers `form` to a Soul standing anywhere: a form that needs the thing held first (a book's
/// `read`, an apple's `bite`) is left out, since an agent would take the thing before it.
fn has_form(e: &Json, form: &str) -> bool {
    e.get("forms").and_then(Json::obj).is_some_and(|f| {
        f.iter().any(|(n, f)| {
            n == form
                && !f.get("needs").and_then(Json::arr).is_some_and(|needs| {
                    needs
                        .iter()
                        .any(|x| x.get("need").and_then(Json::str) == Some("held_by_actor"))
                })
        })
    })
}

impl Targets {
    /// The targets from the copy's nodes (id, plain kind) and the world's entries (a JSON array).
    pub fn of(seen: &Seen, entries: &Json) -> Targets {
        let nodes = &seen.nodes;
        let all = entries.arr().unwrap_or(&[]);
        let by_kind: BTreeMap<&str, &Json> = all
            .iter()
            .filter_map(|e| Some((e.get("kind")?.str()?, e)))
            .collect();
        let families: Vec<&Json> = all
            .iter()
            .filter(|e| e.get("owner").and_then(Json::str) == Some("family"))
            .collect();
        let things: Vec<(Id, &Json)> = nodes
            .iter()
            .filter_map(|(id, k)| Some((*id, *by_kind.get(k.as_str())?)))
            .filter(|(_, e)| e.get("owner").and_then(Json::str) != Some("family"))
            .collect();
        let ids = |f: &dyn Fn(&Json) -> bool| -> Vec<Id> {
            things
                .iter()
                .filter(|(_, e)| f(e))
                .map(|(id, _)| *id)
                .collect()
        };
        let mut walk = ids(&|e| has_slot(e, None));
        if walk.is_empty() {
            walk = ids(&|_| true);
        }
        // A gateway with no entries: any node of the copy.
        if walk.is_empty() {
            walk = nodes.iter().map(|(id, _)| *id).collect();
        }
        let mut forms = BTreeMap::new();
        for (kind, names) in FORMS {
            let found = names.iter().find_map(|n| {
                let on = ids(&|e| has_form(e, n));
                if let Some((_, e)) = things.iter().find(|(_, e)| has_form(e, n)) {
                    return Some((format!("{}:{n}", entry_ns(e)), on));
                }
                let fam = families.iter().find(|e| has_form(e, n))?;
                Some((format!("{}:{n}", entry_ns(fam)), Vec::new()))
            });
            if let Some(f) = found {
                forms.insert((*kind).to_owned(), f);
            }
        }
        Targets {
            walk,
            sit: ids(&|e| has_slot(e, Some("sit"))),
            forms,
            bodies: seen.bodies.clone(),
        }
    }

    /// The report's line: how many targets each kind has, and each form's verb.
    pub fn json(&self) -> String {
        let forms: Vec<String> = self
            .forms
            .iter()
            .map(|(k, (v, on))| {
                let on = if on.is_empty() {
                    "\"own body\"".to_owned()
                } else {
                    on.len().to_string()
                };
                format!("{k:?}: {{\"verb\": {v:?}, \"on\": {on}}}")
            })
            .collect();
        format!(
            "{{\"walk\": {}, \"sit\": {}, \"bodies\": {}, \"forms\": {{{}}}}}",
            self.walk.len(),
            self.sit.len(),
            self.bodies.len(),
            forms.join(", ")
        )
    }
}

/// One act as sent: its verb, its target, whether it carries words, and how it was chosen.
#[derive(Debug, PartialEq)]
pub struct Chosen {
    pub verb: String,
    pub target: Option<Id>,
    pub words: bool,
    /// `None`, or the shape kind a walk stands in for.
    pub stand_in: Option<String>,
}

/// One agent's state across its acts: seated by its last sit (cleared by the agent's socket when that sit is
/// refused), and how many acts it has sent.
#[derive(Default, Clone)]
pub struct Choice {
    pub seated: Arc<AtomicBool>,
    n: u64,
}

impl Choice {
    /// The intent for agent `agent`'s next act of shape kind `kind` (its schedule verb `verb`, whose namespace walks,
    /// sits and rises take), or `None` for a say withheld. `soul` is the agent's Soul.
    pub fn next(
        &mut self,
        t: &Targets,
        kind: &str,
        verb: &str,
        agent: u32,
        soul: Id,
        speech: bool,
    ) -> Option<Chosen> {
        let seated = self.seated.load(Ordering::Relaxed);
        let sit = |to: bool| self.seated.store(to, Ordering::Relaxed);
        let ns = verb.split_once(':').map_or("eden", |(ns, _)| ns);
        let pick = |v: &[Id], k: u64| (!v.is_empty()).then(|| v[(k % v.len() as u64) as usize]);
        let a = u64::from(agent);
        let n = self.n;
        let plain = |verb: String, target| Chosen {
            verb,
            target,
            words: false,
            stand_in: None,
        };
        let out = match kind {
            "say" if !speech => return None,
            "say" => Chosen {
                verb: verb.to_owned(),
                target: None,
                words: true,
                stand_in: None,
            },
            "walk" | "sit" if seated => {
                sit(false);
                plain(format!("{ns}:rise"), None)
            }
            "walk" => plain(format!("{ns}:walk"), pick(&t.walk, a * 7 + n)),
            "sit" if !t.sit.is_empty() => {
                sit(true);
                plain(format!("{ns}:sit"), pick(&t.sit, a))
            }
            k => match t.forms.get(k) {
                Some((v, on)) if on.is_empty() && t.bodies.contains_key(&soul) => {
                    plain(v.clone(), t.bodies.get(&soul).copied())
                }
                Some((v, on)) if !on.is_empty() => plain(v.clone(), pick(on, a + n)),
                _ if seated => {
                    sit(false);
                    plain(format!("{ns}:rise"), None)
                }
                _ => Chosen {
                    stand_in: Some(k.to_owned()),
                    ..plain(format!("{ns}:walk"), pick(&t.walk, a * 7 + n))
                },
            },
        };
        self.n += 1;
        Some(out)
    }
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next_map(ws: &mut Ws, n: u64) -> Result<BTreeMap<u64, Value>, String> {
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(30), ws.next())
            .await
            .map_err(|_| "targets: no answer to a sync request in 30 s".to_owned())?;
        let Some(Ok(Message::Binary(b))) = frame else {
            match frame {
                Some(Ok(_)) => continue,
                _ => return Err("targets: the socket closed during the sync".into()),
            }
        };
        if let Ok(Value::Map(m)) = decode(&b).map(|d| d.value)
            && m.get(&wire::ASK) == Some(&Value::Uint(n))
        {
            if let Some(Value::Text(r)) = m.get(&wire::REFUSED) {
                return Err(format!("targets: the sync was refused: {}", r.as_str()));
            }
            return Ok(m);
        }
    }
}

/// The plain name of a node record's kind: its field 27's entry, else its kind, without `@revision`.
fn plain_kind(record: &BTreeMap<u64, Value>) -> Option<String> {
    let named = match record.get(&6) {
        Some(Value::Map(f)) => f.get(&27),
        _ => None,
    };
    let Some(Value::Text(k)) = named.or_else(|| record.get(&2)) else {
        return None;
    };
    let k = k.as_str();
    Some(k.split_once('@').map_or(k, |(p, _)| p).to_owned())
}

/// The Soul a body record's `souls:body-of` link names (field 9's links `[[id, {1: type, 2: [body, soul]}], ...]`).
fn soul_of(record: &BTreeMap<u64, Value>) -> Option<Id> {
    let Some(Value::Array(links)) = record.get(&9) else {
        return None;
    };
    links.iter().find_map(|l| {
        let Value::Array(pair) = l else { return None };
        let Some(Value::Map(link)) = pair.get(1) else {
            return None;
        };
        let Some(Value::Text(ty)) = link.get(&1) else {
            return None;
        };
        if ty.as_str().split('@').next() != Some("souls:body-of") {
            return None;
        }
        let Some(Value::Array(ends)) = link.get(&2) else {
            return None;
        };
        replica::effects::read_id(ends.get(1)?).ok()
    })
}

/// The nodes of a test Soul's scope, as its copy holds them after a sync from nothing.
pub async fn read_copy(url: &str, token: &str) -> Result<Seen, String> {
    let (mut ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|e| format!("targets: connect: {e}"))?;
    let hello = Hello {
        protocol: PROTOCOL,
        build: vec![0x12, 0x20],
        refused: None,
        other: None,
    };
    let sign_in = encode(&Value::Map(
        [(1, Value::Text(Name::new(token).ok_or("targets: a token")?))].into(),
    ))
    .map_err(|e| e.to_string())?;
    let send = |b: Vec<u8>| Message::Binary(b.into());
    ws.send(send(hello.to_bytes().map_err(|e| e.to_string())?))
        .await
        .map_err(|e| e.to_string())?;
    ws.send(send(sign_in)).await.map_err(|e| e.to_string())?;
    let ask = |n: u64, key: u64, list: Vec<Value>| {
        encode(&Value::Map(BTreeMap::from([
            (wire::ASK, Value::Uint(n)),
            (key, Value::Array(list)),
        ])))
        .expect("a sync request")
    };
    ws.send(send(ask(1, wire::IDS, Vec::new())))
        .await
        .map_err(|e| e.to_string())?;
    let (scope, hashes) = read_hashes(&next_map(&mut ws, 1).await?).map_err(|r| r.name)?;
    let mut copy = Copy::default();
    let mut d = copy.compare(&scope, hashes);
    let mut n = 1;
    loop {
        let asked = copy.ask(&mut d, wire::RECORDS_MOST);
        if asked.is_empty() {
            break;
        }
        n += 1;
        let list = asked.iter().map(|h| Value::Bytes(h.clone())).collect();
        ws.send(send(ask(n, wire::RECORDS, list)))
            .await
            .map_err(|e| e.to_string())?;
        let got = read_records(&next_map(&mut ws, n).await?).map_err(|r| r.name)?;
        copy.take(&mut d, &asked, got).map_err(|r| r.name)?;
    }
    copy.finish(d).map_err(|r| r.name)?;
    let _ = ws.send(Message::Close(None)).await;
    let mut out = Seen::default();
    for h in copy.reach().map_err(|r| r.name)? {
        let Some(Ok(Value::Map(m))) = copy.record(&h).map(|b| decode(b).map(|d| d.value)) else {
            continue;
        };
        if let (Some(id), Some(kind)) = (
            m.get(&1).and_then(|v| replica::effects::read_id(v).ok()),
            plain_kind(&m),
        ) {
            if let Some(soul) = soul_of(&m) {
                out.bodies.insert(soul, id);
            }
            if std::env::var("DRIVER_DEBUG").is_ok() { eprintln!("node {kind} {:?}", m.get(&9)); }
            out.nodes.push((id, kind));
        }
    }
    out.nodes.sort();
    Ok(out)
}

/// The world's kind entries, `GET /v2/entries` at the gateway (plain HTTP, as `--remote` is), signed in with `token`.
pub async fn read_entries(url: &str, token: &str) -> Result<Json, String> {
    let host = url
        .strip_prefix("ws://")
        .and_then(|r| r.split('/').next())
        .ok_or("targets: the gateway's address")?;
    let mut s = tokio::net::TcpStream::connect(host)
        .await
        .map_err(|e| format!("targets: entries: {e}"))?;
    let req = format!(
        "GET /v2/entries HTTP/1.1\r\nHost: {host}\r\nAuthorization: Bearer {token}\r\nAccept-Encoding: gzip\r\nConnection: close\r\n\r\n"
    );
    s.write_all(req.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
    let at = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("targets: entries: no HTTP answer")?;
    let head = String::from_utf8_lossy(&buf[..at]);
    let status = head.lines().next().unwrap_or("");
    if status.contains(" 404 ") {
        eprintln!(
            "driver: the gateway serves no entries (no --entries): walks go to any node, forms stand in as walks"
        );
        return Ok(Json::Arr(Vec::new()));
    }
    if !status.contains(" 200 ") {
        return Err(format!(
            "targets: entries: {status} (the gateway serves them with --entries)"
        ));
    }
    let gz = &buf[at + 4..];
    if gz.len() < 18 {
        return Err("targets: entries: a short body".into());
    }
    let raw = miniz_oxide::inflate::decompress_to_vec(&gz[10..gz.len() - 8])
        .map_err(|e| format!("targets: entries: gzip: {e:?}"))?;
    json::parse(&String::from_utf8_lossy(&raw))
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::ids::Scope;

    fn id(n: u64) -> Id {
        Id::new(Scope([5; 16]), n).unwrap()
    }

    const ENTRIES: &str = r#"[
      {"kind": "eden:chair", "slots": {"seat": {"admits": "body", "posture": "sit"}}, "forms": {"sit": {}}},
      {"kind": "eden:speaker", "forms": {"play_music": {}}},
      {"kind": "eden:book", "forms": {"read": {"needs": [{"need": "held_by_actor"}]}}},
      {"kind": "eden:humanoid", "owner": "family", "forms": {"wave": {}, "sit_down": {}}}
    ]"#;

    #[test]
    fn targets_come_from_the_copy_and_the_entries() {
        let seen = Seen {
            nodes: vec![
                (id(1), "eden:chair".to_owned()),
                (id(2), "eden:chair".to_owned()),
                (id(3), "eden:speaker".to_owned()),
                (id(4), "souls:ground".to_owned()),
                (id(5), "eden:book".to_owned()),
            ],
            bodies: BTreeMap::new(),
        };
        let t = Targets::of(&seen, &json::parse(ENTRIES).unwrap());
        assert_eq!(t.walk, [id(1), id(2)]);
        assert_eq!(t.sit, [id(1), id(2)]);
        assert_eq!(
            t.forms["play-music"],
            ("eden:play_music".into(), vec![id(3)])
        );
        assert_eq!(t.forms["gesture"], ("eden:wave".into(), Vec::new()));
        assert_eq!(t.forms["sit-ground"], ("eden:sit_down".into(), Vec::new()));
        assert!(
            !t.forms.contains_key("read"),
            "a form that needs the thing held"
        );
    }

    #[test]
    fn a_seated_soul_rises_first_says_are_withheld_and_an_unoffered_kind_walks() {
        let me = id(9);
        let seen = Seen {
            nodes: vec![(id(1), "eden:chair".to_owned())],
            bodies: BTreeMap::from([(me, id(8))]),
        };
        let t = Targets::of(&seen, &json::parse(ENTRIES).unwrap());
        let mut c = Choice::default();
        let verb = |c: &mut Choice, kind| {
            c.next(&t, kind, "eden:x", 0, me, false)
                .map(|x| (x.verb, x.target))
        };
        assert_eq!(verb(&mut c, "say"), None);
        assert_eq!(verb(&mut c, "sit"), Some(("eden:sit".into(), Some(id(1)))));
        assert_eq!(verb(&mut c, "walk"), Some(("eden:rise".into(), None)));
        assert_eq!(
            verb(&mut c, "walk"),
            Some(("eden:walk".into(), Some(id(1))))
        );
        assert_eq!(
            verb(&mut c, "gesture"),
            Some(("eden:wave".into(), Some(id(8))))
        );
        let read = c.next(&t, "read", "eden:read", 0, me, false).unwrap();
        assert_eq!(
            (read.verb.as_str(), read.stand_in.as_deref()),
            ("eden:walk", Some("read"))
        );
        let other = c.next(&t, "gesture", "eden:wave", 0, id(7), false).unwrap();
        assert_eq!(
            other.stand_in.as_deref(),
            Some("gesture"),
            "a body not in the copy"
        );
        c.next(&t, "sit", "eden:sit", 0, me, false);
        c.seated.store(false, Ordering::Relaxed);
        let walk = c.next(&t, "walk", "eden:walk", 0, me, false).unwrap();
        assert_eq!(
            walk.verb, "eden:walk",
            "a refused sit leaves the Soul standing"
        );
        let say = c.next(&t, "say", "eden:say", 0, me, true).unwrap();
        assert!(say.words && say.verb == "eden:say");
    }
}
