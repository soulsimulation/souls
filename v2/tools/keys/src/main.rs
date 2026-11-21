//! Engine v2 B10 (#2688): a keyboard client that drives a body through the gateway, with the same intents an agent
//! sends, as the controller's test rig. No model, no script: a person at a terminal.
//!
//! From `v2/`, with `worldd gateway-link --testworld` and `gatewayd` running (`v2/tools/keys/README.md`):
//!
//! - `keys token --tokens <file> --out <file>`: a development token for the test world's Soul. Its hash is appended to
//!   the gateway's tokens file and the token itself written to `--out` (mode 600). It is never printed.
//! - `keys drive --gateway <addr:port> --token <file> --log <world log>`: drive the Soul.
//!   - An arrow key sends "walk to the point 2 m ahead" (`eden:walk` with a point). Held, the next step is sent when
//!     the last one's receipt comes back; a terminal sends no key-up, so a key counts as released when its repeats
//!     stop for 0.6 s, and then nothing more is sent. A new step replaces the last (the world ends it `claim-taken`).
//!     No intent leaves sooner than 200 ms after the last, so a held key never sends more than 5 a second.
//!   - `s` lists the chairs by name and distance; a digit picks one: a walk to its stand point, then `eden:sit`.
//!   - `r` sends `eden:rise`. `q` quits.
//!   - Every receipt or refusal is printed in words, with where the body is now.
//! - `keys log <world log>`: every intent the world took, with its answer, and the most sent in any one second.
//!
//! **Where the body is** comes from the world's log, read only: the position each move's entries record at its start
//! and its end (`worldd::answers`, I4b). The gateway's stream carries answers only so far. Nothing here guesses where
//! the body "should" be: each step is 2 m from the last committed position.

// A tool's clock: intent expiries and key timings read the machine's clocks.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::Command;
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use gatewayd::token::{Grant, Token, Tokens};
use replica::effects::{Actor, read_id};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Hello, Intent, PROTOCOL, Target};
use replica::pose::Vec3;
use replica::world_model::show;
use tungstenite::client::IntoClientRequest;
use tungstenite::{Message, WebSocket};
use worldd::answers::{MOVE_ENDED, MOVE_STARTED};
use worldd::testbodies;

/// One arrow press: this far, µm.
const STEP: i64 = 2_000_000;
/// No intent sooner than this after the last.
const GAP: Duration = Duration::from_millis(200);
/// A key whose repeats stop this long is released.
const RELEASE: Duration = Duration::from_millis(600);
/// An intent's expiry, after it is sent. `keys log` reads the send time back from it.
const EXPIRY: i64 = 60_000_000;
/// Chairs listed within this, µm.
const NEAR: i64 = 60_000_000;

fn now_us() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_micros()).unwrap_or(i64::MAX))
}

fn name(s: &str) -> Name {
    Name::new(s).unwrap_or_else(|| unreachable!("a fixed name"))
}

fn arg<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let k = args.iter().position(|a| a == flag)?;
    args.get(k + 1).map(String::as_str)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let code = match args.get(1).map(String::as_str) {
        Some("token") => token(&args),
        Some("drive") => drive(&args),
        Some("log") => log(&args),
        _ => {
            eprintln!(
                "usage: keys token --tokens <file> --out <file> | keys drive --gateway <addr:port> --token <file> \
                 --log <world log> | keys log <world log>"
            );
            2
        }
    };
    std::process::exit(code);
}

fn actor() -> Actor {
    Actor::Soul(testbodies::body())
}

/// `keys token`: a development token for the Soul; the gateway's file gets its hash, `--out` the token.
fn token(args: &[String]) -> i32 {
    let (Some(tokens), Some(out)) = (arg(args, "--tokens"), arg(args, "--out")) else {
        eprintln!("usage: keys token --tokens <file> --out <file>");
        return 2;
    };
    let grant = Grant::Actor(actor());
    let Ok(t) = Token::issue(grant) else {
        eprintln!("keys: no random bytes for a token");
        return 1;
    };
    let line = format!("{}\n", Tokens::line(grant, &t.hash()));
    let written = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(tokens)
        .and_then(|mut f| f.write_all(line.as_bytes()))
        .and_then(|()| std::fs::write(out, t.reveal()))
        .and_then(|()| {
            Command::new("chmod")
                .args(["600", out])
                .status()
                .map(|_| ())
        });
    match written {
        Ok(()) => {
            println!(
                "a token for {}: its hash added to the tokens file, the token written to its own file",
                grant.to_text()
            );
            0
        }
        Err(e) => {
            eprintln!("keys: {e}");
            1
        }
    }
}

/// The body's last committed place in the world's log: the node of its frame and its position, µm.
fn committed(log: &Path, body: Id) -> Option<(Id, Vec3)> {
    let bytes = std::fs::read(log).ok()?;
    let mut last = None;
    for r in sim::log::recover(&bytes).ok()?.records {
        let Ok(part) = replica::effects::Part::read(&r) else {
            continue;
        };
        for e in &part.effects {
            for ev in e.events.iter().flatten() {
                let n = ev.name.as_str();
                if n != MOVE_STARTED && n != MOVE_ENDED {
                    continue;
                }
                let f = &ev.fields;
                if f.get(&1).and_then(|v| read_id(v).ok()) != Some(body) {
                    continue;
                }
                if let (Some(Value::Array(p)), Some(node)) =
                    (f.get(&3), f.get(&4).and_then(|v| read_id(v).ok()))
                    && let [x, y, z] = p.as_slice()
                {
                    last = Some((node, Vec3::new(int(x)?, int(y)?, int(z)?)));
                }
            }
        }
    }
    last
}

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

fn metres(p: Vec3) -> String {
    format!("({:.1}, {:.1}) m", p.x as f64 / 1e6, p.z as f64 / 1e6)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Dir {
    North,
    South,
    East,
    West,
}

impl Dir {
    /// North is +z, where the hall stands from the square (N2).
    fn step(self) -> (i64, i64) {
        match self {
            Dir::North => (0, STEP),
            Dir::South => (0, -STEP),
            Dir::East => (STEP, 0),
            Dir::West => (-STEP, 0),
        }
    }
}

enum Key {
    Arrow(Dir),
    Char(u8),
}

/// What an intent sent was for.
#[derive(Clone, Copy)]
enum Sent {
    Step(Dir),
    ToChair(usize),
    Sit(usize),
    Rise,
}

/// Reads the terminal's keys: arrows by their escape sequences, anything else as a byte.
fn keys() -> Receiver<Key> {
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut b = [0u8; 1];
        let mut esc = 0;
        while stdin.read_exact(&mut b).is_ok() {
            let k = match (esc, b[0]) {
                (0, 0x1b) => {
                    esc = 1;
                    continue;
                }
                (1, b'[') => {
                    esc = 2;
                    continue;
                }
                (2, c) => {
                    esc = 0;
                    match c {
                        b'A' => Key::Arrow(Dir::North),
                        b'B' => Key::Arrow(Dir::South),
                        b'C' => Key::Arrow(Dir::East),
                        b'D' => Key::Arrow(Dir::West),
                        _ => continue,
                    }
                }
                (_, c) => {
                    esc = 0;
                    Key::Char(c)
                }
            };
            if tx.send(k).is_err() {
                return;
            }
        }
    });
    rx
}

struct Driver {
    ws: WebSocket<TcpStream>,
    log: std::path::PathBuf,
    ground: Id,
    sequence: u64,
    last_sent: Option<Instant>,
    sent: BTreeMap<u64, Sent>,
    /// The arrow held, and when its last repeat came.
    held: Option<(Dir, Instant)>,
    /// A step waiting for the gap, or for the last step's receipt while the key is held.
    want_step: bool,
    /// The step in flight.
    stepping: Option<u64>,
    picking: bool,
}

impl Driver {
    fn say(&self, line: &str) {
        print!("{line}\r\n");
        let _ = std::io::stdout().flush();
    }

    fn here(&self) -> (Id, Vec3) {
        committed(&self.log, testbodies::body()).unwrap_or((self.ground, testbodies::start()))
    }

    /// Where the body is, in words: on the ground at a point, or seated on a chair.
    fn place(&self) -> String {
        let (node, at) = self.here();
        match testbodies::chairs().iter().find(|c| c.1 == node) {
            Some(c) => format!("seated on {}", c.0),
            None if node == self.ground => format!("at {}", metres(at)),
            None => format!("on {}", show(node)),
        }
    }

    fn send(&mut self, verb: &str, target: Option<Id>, point: Option<Vec3>, what: Sent) {
        self.sequence += 1;
        let mut parameters = BTreeMap::new();
        if let Some(p) = point {
            let i = |n: i64| {
                u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint)
            };
            parameters.insert(1, Value::Array(vec![i(p.x), i(p.y), i(p.z)]));
        }
        let lineage = Scope([0; 16]);
        let intent = Intent {
            actor: actor(),
            verb: name(verb),
            target: target.map(Target::Node),
            parameters,
            sequence: self.sequence,
            basis: Version {
                lineage,
                zone: Id::new(lineage, 0).unwrap_or_else(|| unreachable!("id 0")),
                epoch: 1,
                sequence: 0,
            }
            .to_value(),
            expiry: now_us() + EXPIRY,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
            reflex: false,
        };
        let Ok(bytes) = encode(&intent.to_value()) else {
            return self.say("an intent did not encode");
        };
        if let Err(e) = self.ws.send(Message::Binary(bytes.into())) {
            return self.say(&format!("the gateway: {e}"));
        }
        self.last_sent = Some(Instant::now());
        self.sent.insert(self.sequence, what);
    }

    fn may_send(&self) -> bool {
        self.last_sent.is_none_or(|t| t.elapsed() >= GAP)
    }

    fn step(&mut self, d: Dir) {
        let (node, at) = self.here();
        if node != self.ground {
            self.say("seated: press r to rise first");
            self.want_step = false;
            return;
        }
        let (dx, dz) = d.step();
        let to = Vec3::new(at.x + dx, 0, at.z + dz);
        self.say(&format!("walk 2 m {d:?} from {} to {}", metres(at), metres(to)).to_lowercase());
        self.send("eden:walk", Some(self.ground), Some(to), Sent::Step(d));
        self.stepping = Some(self.sequence);
        self.want_step = false;
    }

    fn key(&mut self, k: Key) -> bool {
        match k {
            Key::Arrow(d) => {
                let repeat = self.held.is_some_and(|(h, _)| h == d);
                self.held = Some((d, Instant::now()));
                // A new press goes at once and replaces the step in flight; a repeat waits for its receipt.
                if !repeat {
                    self.want_step = true;
                    self.stepping = None;
                }
            }
            Key::Char(b'q' | 3) => return false,
            Key::Char(b's') => {
                let (_, at) = self.here();
                let mut near: Vec<(usize, i64)> = testbodies::chairs()
                    .iter()
                    .enumerate()
                    .map(|(i, c)| (i, (c.2.x - at.x).abs().max((c.2.z - at.z).abs())))
                    .filter(|c| c.1 <= NEAR)
                    .collect();
                near.sort_by_key(|c| c.1);
                self.say("chairs near: press a number to sit");
                for (i, d) in &near {
                    self.say(&format!(
                        "  {}  {}, {:.0} m away",
                        i + 1,
                        testbodies::chairs()[*i].0,
                        *d as f64 / 1e6
                    ));
                }
                self.picking = true;
            }
            Key::Char(c @ b'1'..=b'9') if self.picking => {
                self.picking = false;
                let i = usize::from(c - b'1');
                if let Some(&(n, thing, _)) = testbodies::chairs().get(i) {
                    self.say(&format!("walk to {n}"));
                    self.send("eden:walk", Some(thing), None, Sent::ToChair(i));
                }
            }
            Key::Char(b'r') => {
                self.say("rise");
                self.send("eden:rise", None, None, Sent::Rise);
            }
            _ => {}
        }
        true
    }

    /// An answer in words.
    fn answer(&mut self, frame: &[u8]) {
        let Ok(Value::Map(m)) = decode(frame).map(|d| d.value) else {
            return self.say("an unreadable frame from the gateway");
        };
        if let Some(Value::Text(t)) = m.get(&4) {
            return self.say(&format!("gateway: {}", t.as_str()));
        }
        let Some(Value::Map(a)) = m.get(&2) else {
            return;
        };
        let seq = match a.get(&2) {
            Some(Value::Uint(s)) => *s,
            _ => 0,
        };
        let what = self.sent.remove(&seq);
        if self.stepping == Some(seq) {
            self.stepping = None;
        }
        let at = self.place();
        let did = match what {
            Some(Sent::Step(d)) => format!("the walk {d:?}").to_lowercase(),
            Some(Sent::ToChair(i)) => format!("the walk to {}", testbodies::chairs()[i].0),
            Some(Sent::Sit(i)) => format!("the sit on {}", testbodies::chairs()[i].0),
            Some(Sent::Rise) => "the rise".to_owned(),
            None => format!("intent {seq}"),
        };
        match (a.get(&3), a.get(&4), a.get(&5)) {
            (Some(Value::Uint(1)), _, Some(Value::Array(e))) => {
                let entries: Vec<String> =
                    e.iter().filter_map(int).map(|n| format!("#{n}")).collect();
                self.say(&format!(
                    "  done: {did}, log entries {}; now {at}",
                    entries.join(" ")
                ));
                if let Some(Sent::ToChair(i)) = what {
                    self.say(&format!("sit on {}", testbodies::chairs()[i].0));
                    self.send(
                        "eden:sit",
                        Some(testbodies::chairs()[i].1),
                        None,
                        Sent::Sit(i),
                    );
                }
                if matches!(what, Some(Sent::Step(_))) && self.held.is_some() {
                    self.want_step = true;
                }
            }
            (Some(Value::Uint(2)), Some(Value::Text(r)), _) => {
                let r = r.as_str();
                let why = match r {
                    "claim-taken" => "it gave way to the next",
                    "resource-held" => "the body is busy (seated?)",
                    _ => "",
                };
                self.say(&format!(
                    "  refused: {did}: {r}{}{why}; now {at}",
                    if why.is_empty() { "" } else { ", " }
                ));
            }
            (Some(Value::Uint(5)), Some(Value::Text(r)), _) => {
                self.say(&format!("  unread: {}", r.as_str()))
            }
            other => self.say(&format!("  answer: {other:?}")),
        }
    }
}

/// The terminal in raw-ish mode: keys one at a time, unechoed; restored when dropped.
struct Raw(Option<String>);

impl Raw {
    fn on() -> Raw {
        let saved = Command::new("stty")
            .arg("-g")
            .stdin(std::process::Stdio::inherit())
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_owned());
        let _ = Command::new("stty")
            .args(["-icanon", "-echo", "-isig", "min", "1"])
            .stdin(std::process::Stdio::inherit())
            .status();
        Raw(saved)
    }
}

impl Drop for Raw {
    fn drop(&mut self) {
        if let Some(s) = &self.0 {
            let _ = Command::new("stty")
                .arg(s)
                .stdin(std::process::Stdio::inherit())
                .status();
        }
    }
}

/// `keys drive`.
fn drive(args: &[String]) -> i32 {
    let (Some(gateway), Some(token), Some(log)) = (
        arg(args, "--gateway"),
        arg(args, "--token"),
        arg(args, "--log"),
    ) else {
        eprintln!("usage: keys drive --gateway <addr:port> --token <file> --log <world log>");
        return 2;
    };
    let Some(token) = std::fs::read_to_string(token)
        .ok()
        .and_then(|t| Token::parse(t.trim()))
    else {
        eprintln!("keys: the token file holds no token");
        return 2;
    };
    let ground = match testbodies::town() {
        Ok((_, g)) => g,
        Err(e) => {
            eprintln!("keys: the test world: {e}");
            return 1;
        }
    };
    let connected = TcpStream::connect(gateway)
        .map_err(|e| e.to_string())
        .and_then(|stream| {
            let mut req = format!("ws://{gateway}/v2/ws")
                .into_client_request()
                .map_err(|e| e.to_string())?;
            let bearer = format!("Bearer {}", token.reveal())
                .parse()
                .map_err(|_| "a token header".to_owned())?;
            req.headers_mut().insert("authorization", bearer);
            tungstenite::client(req, stream)
                .map(|(ws, _)| ws)
                .map_err(|e| e.to_string())
        });
    let mut ws = match connected {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("keys: the gateway: {e}");
            return 1;
        }
    };
    let hello = Hello {
        protocol: PROTOCOL,
        build: vec![0],
        refused: None,
        other: None,
    };
    if let Err(e) = hello.to_bytes().map_err(|r| r.to_string()).and_then(|h| {
        ws.send(Message::Binary(h.into()))
            .map_err(|e| e.to_string())
    }) {
        eprintln!("keys: the first frame: {e}");
        return 1;
    }
    let _ = ws
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(20)));
    let raw = Raw::on();
    let mut d = Driver {
        ws,
        log: log.into(),
        ground,
        // Sequences only rise for an actor, across sessions too.
        sequence: u64::try_from(now_us()).unwrap_or(0),
        last_sent: None,
        sent: BTreeMap::new(),
        held: None,
        want_step: false,
        stepping: None,
        picking: false,
    };
    d.say(&format!(
        "driving {} {}",
        show(testbodies::body()),
        d.place()
    ));
    d.say("arrows walk 2 m, s lists chairs, r rises, q quits");
    let keys = keys();
    let mut hello_seen = false;
    'run: loop {
        while let Ok(k) = keys.try_recv() {
            if !d.key(k) {
                break 'run;
            }
        }
        if let Some((dir, t)) = d.held
            && t.elapsed() >= RELEASE
        {
            d.held = None;
            d.want_step = false;
            d.say(&format!("released {dir:?}").to_lowercase());
        }
        if d.want_step
            && d.stepping.is_none()
            && d.may_send()
            && let Some((dir, _)) = d.held
        {
            d.step(dir);
        }
        match d.ws.read() {
            Ok(Message::Binary(b)) if !hello_seen => {
                hello_seen = true;
                if Hello::read(&b).is_err() {
                    d.say("the gateway's first frame was not read");
                }
            }
            Ok(Message::Binary(b)) => d.answer(&b),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => {
                d.say(&format!("the gateway closed: {e}"));
                break;
            }
        }
    }
    drop(raw);
    0
}

/// `keys log`: every intent the world took (its log's answered rows), its answer, and the most in any one second.
fn log(args: &[String]) -> i32 {
    let Some(path) = args.get(2) else {
        eprintln!("usage: keys log <world log>");
        return 2;
    };
    let Ok(bytes) = std::fs::read(path) else {
        eprintln!("keys: cannot read the log");
        return 1;
    };
    let Ok(found) = sim::log::recover(&bytes) else {
        eprintln!("keys: not a world log");
        return 1;
    };
    let mut sent: Vec<(i64, String)> = Vec::new();
    for r in found.records {
        let Ok(Value::Map(m)) = decode(&r).map(|d| d.value) else {
            continue;
        };
        let Some(Value::Array(rows)) = m.get(&worldd::answers::ANSWERED) else {
            continue;
        };
        for row in rows {
            let Value::Map(row) = row else { continue };
            let Some(Value::Map(i)) = row.get(&5) else {
                continue;
            };
            let verb = match i.get(&2) {
                Some(Value::Text(v)) => v.as_str().to_owned(),
                _ => "?".into(),
            };
            let at = i.get(&7).and_then(int).map_or(0, |e| e - EXPIRY);
            let target = match i.get(&3) {
                Some(v) => read_id(v).map(show).unwrap_or_default(),
                None => String::new(),
            };
            let answer = match row.get(&4) {
                Some(Value::Bytes(f)) => match decode(f).map(|d| d.value) {
                    Ok(Value::Map(f)) => match f.get(&2) {
                        Some(Value::Map(a)) => match (a.get(&3), a.get(&4)) {
                            (Some(Value::Uint(1)), _) => "receipt".to_owned(),
                            (Some(Value::Uint(2)), Some(Value::Text(r))) => {
                                format!("refused {}", r.as_str())
                            }
                            _ => "other".to_owned(),
                        },
                        _ => "?".to_owned(),
                    },
                    _ => "?".to_owned(),
                },
                _ => "?".to_owned(),
            };
            sent.push((at, format!("{verb} {target} -> {answer}")));
        }
    }
    sent.sort_by_key(|s| s.0);
    let t0 = sent.first().map_or(0, |s| s.0);
    let mut verbs: BTreeMap<String, usize> = BTreeMap::new();
    for (at, line) in &sent {
        println!("{:>8.3} s  {line}", (at - t0) as f64 / 1e6);
        let v = line.split(' ').next().unwrap_or("?").to_owned();
        *verbs.entry(v).or_default() += 1;
    }
    let most = sent
        .iter()
        .map(|(a, _)| {
            sent.iter()
                .filter(|(b, _)| *b >= *a && *b < a + 1_000_000)
                .count()
        })
        .max()
        .unwrap_or(0);
    println!("{} intents; by verb: {verbs:?}", sent.len());
    println!("the most sent in any one second: {most}");
    0
}
