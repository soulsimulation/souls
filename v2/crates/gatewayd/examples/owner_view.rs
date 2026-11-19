//! The owner's view, end to end, for V13's measure (Engine v2 V13, #2745): the world's view tier
//! (`worldd::views::served`) on a local socket, a gateway linked to it on a local TCP port, and a hall of bodies that
//! walk, committed tick by tick at 20 ticks a second. `v2/web/src/source/measure.ts` starts it, reads its first line
//! and drives the page's own socket source and clock against it.
//!
//! The scene: soul 1's body (the owner's, followed) and `--bodies` others in one hall, all within 3 m, so all are in
//! the owner's interest set. Each body hands off its motion once a world second (a walker turning), at its own tick.
//! Every world second soul 2's body has a field set three times: for everyone, for soul 1's audience and for soul 2's
//! audience (private to another owner: it must never reach soul 1's page).
//!
//! Each tick's record is handed to the tier at wall time `anchor + at` (its commit). The first stdout line is JSON:
//! `{"url", "token1", "token2", "follow", "anchorWallMs", "soul1", "soul2", "grant1"}`; the tokens are this run's own,
//! minted here. With `--view-key <file>` it also takes view tokens the directory signs with that key (V13b).
//!
//! `cargo run --release -p gatewayd --example owner_view -- --bodies 30 --seconds 610 --dir <scratch dir>`

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use gatewayd::receipts::Receipts;
use gatewayd::token::{Grant, Token, Tokens, ViewKey};
use gatewayd::{Gateway, Log, socket, views};
use replica::effects::{Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Rest};
use replica::encode::{Name, Value, encode, to_hex};
use replica::ids::{Hash, Id, Purpose, Scope};
use replica::pose::{Frame, HandOff, Owner, Pose, Quat, Support, Vec3};
use replica::world_model::Audience;
use worldd::views::served;

const BUILD: [u8; 4] = [0x12, 0x20, 0xab, 0xcd];
const BODY: &str =
    "souls:body@1220ee1ad75a34f067112ef6d2a095fe5bd3e121a75611a1a95ba85198efcb131cb2";
const TICK_US: i64 = 50_000;

fn soul_id(n: u64) -> Id {
    Id::new(Scope([1; 16]), n).unwrap()
}

fn node(n: u64) -> Id {
    Id::new(Scope([7; 16]), n).unwrap()
}

fn page_key(id: Id) -> String {
    format!("{}.{}", to_hex(&id.scope().0), id.counter())
}

fn pose(room: Id, x: i64, z: i64) -> Pose {
    Pose {
        frame: Frame {
            node: room,
            slot: None,
        },
        position: Vec3::new(x, 0, z),
        orientation: Quat::IDENTITY,
        support: Support::Surface {
            surface: room,
            height: 0,
        },
    }
}

struct W {
    seq: u64,
    at: i64,
}

impl W {
    fn entry(&mut self, n: Id, audience: Audience, change: Change) -> Effect {
        self.seq += 1;
        Effect {
            envelope: Envelope {
                sequence: self.seq,
                at: self.at,
                cause: Cause::World,
                actor: Actor::World,
                audience,
                node: n,
            },
            body: Body::Changes(vec![ChangeRec {
                change,
                rest: Rest::new(),
            }]),
            events: None,
            rest: Rest::new(),
        }
    }

    fn create(&mut self, b: Id, room: Id, x: i64, z: i64) -> Effect {
        let c = Change::Create {
            node: b,
            kind: Name::new(BODY).unwrap(),
            pose: pose(room, x, z),
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        };
        self.entry(room, Audience::Everyone, c)
    }

    fn walk(&mut self, b: Id, room: Id, x: i64, z: i64) -> Effect {
        let h = HandOff {
            node: b,
            at: self.at,
            from: Owner::Mover,
            to: Owner::Mover,
            pose: pose(room, x, z),
            linear: Vec3::new(500_000, 0, 0),
            angular: Vec3::ZERO,
        };
        self.entry(b, Audience::Everyone, Change::Motion(h))
    }

    fn set(&mut self, b: Id, audience: Audience, field: u64) -> Effect {
        let c = Change::Set {
            node: b,
            field,
            to: Value::Uint(self.seq),
            by: None,
        };
        self.entry(b, audience, c)
    }

    fn record(&self, effects: &[Effect]) -> Vec<u8> {
        let v = Value::Map(
            [
                (
                    1,
                    Value::Bytes(Hash::of(Purpose::Fixture, b"owner-view").to_bytes()),
                ),
                (
                    2,
                    Value::Array(effects.iter().map(Effect::to_value).collect()),
                ),
            ]
            .into(),
        );
        encode(&v).unwrap()
    }
}

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter()
        .position(|x| x == name)
        .and_then(|i| a.get(i + 1).cloned())
}

/// Where body `i` (0 the owner's) walks at world second `s`: on a circle of up to 3 m, half a metre on each turn.
fn spot(i: u64, s: i64) -> (i64, i64) {
    let r = 1_000_000 + (i as i64 % 5) * 400_000;
    let a = (i as f64) * 0.7 + (s as f64) * 0.2;
    ((r as f64 * a.cos()) as i64, (r as f64 * a.sin()) as i64)
}

#[allow(clippy::disallowed_methods)] // A measuring tool: it commits each tick at its wall time, as a world's clock does.
#[tokio::main]
async fn main() {
    let bodies: u64 = arg("--bodies").and_then(|v| v.parse().ok()).unwrap_or(30);
    let seconds: i64 = arg("--seconds").and_then(|v| v.parse().ok()).unwrap_or(610);
    let dir = PathBuf::from(arg("--dir").expect("--dir <scratch dir>"));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("world.views");
    let feed = served::start().unwrap();
    served::listen(feed.clone(), &path).unwrap();
    let mut tokens = Tokens::default();
    let mut issued = Vec::new();
    for n in 1..=2 {
        let g = Grant::Actor(Actor::Soul(soul_id(n)));
        let t = Token::issue(g).unwrap();
        tokens.add(g, t.hash());
        issued.push(t);
    }
    let log: Log = Arc::new(|line: &str| eprintln!("gatewayd: {line}"));
    let gw = Gateway::with_receipts(tokens, BUILD.to_vec(), log, Receipts::off());
    // V13b's end-to-end run: view tokens the directory signs with this key are taken too.
    if let Some(key) = arg("--view-key").and_then(|p| std::fs::read_to_string(p).ok()) {
        let _ = gw
            .view_key
            .set(ViewKey::read(&key).expect("--view-key: 64 hex digits"));
    }
    tokio::spawn(views::run(gw.clone(), path));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}{}", listener.local_addr().unwrap(), socket::PATH);
    tokio::spawn(axum::serve(listener, socket::router(gw.clone())).into_future());

    let hall = node(1);
    let body = |i: u64| node(10 + i);
    let mut w = W { seq: 0, at: 0 };
    let created: Vec<Effect> = (0..=bodies)
        .map(|i| {
            let (x, z) = spot(i, 0);
            w.create(body(i), hall, x, z)
        })
        .collect();
    let anchor = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
        * 1000.0;
    let start = Instant::now();
    feed.record(w.record(&created));
    println!(
        r#"{{"url":"{url}","token1":"{}","token2":"{}","follow":"{}","anchorWallMs":{anchor},"soul1":"{}","soul2":"{}","grant1":"{}"}}"#,
        issued[0].reveal(),
        issued[1].reveal(),
        page_key(body(0)),
        page_key(soul_id(1)),
        page_key(soul_id(2)),
        issued[0].grant().to_text(),
    );
    let ticks = seconds * 1_000_000 / TICK_US;
    for tick in 1..=ticks {
        w.at = tick * TICK_US;
        tokio::time::sleep_until((start + Duration::from_micros(w.at as u64)).into()).await;
        let s = w.at / 1_000_000;
        let mut e: Vec<Effect> = (0..=bodies)
            .filter(|i| (tick as u64 + i).is_multiple_of(20))
            .map(|i| {
                let (x, z) = spot(i, s);
                w.walk(body(i), hall, x, z)
            })
            .collect();
        if tick % 20 == 10 {
            let other = body(1);
            e.push(w.set(other, Audience::Everyone, 1));
            e.push(w.set(other, Audience::Of(soul_id(1)), 2));
            e.push(w.set(other, Audience::Of(soul_id(2)), 3));
        }
        if e.is_empty() {
            continue;
        }
        feed.record(w.record(&e));
    }
    eprintln!("owner_view: {ticks} ticks committed");
}
