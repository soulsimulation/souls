//! The public stream as a viewer reads it (stage 2a, #4154): act wait measured to what a viewer can see, not to the
//! gateway's answer.
//!
//! With `--stream <http://host:port/path/>` (the stream's folder as the viewers' origin serves it, V2) one task reads
//! the stream the way the page's worker does (`v2/web/src/source/worker.ts`): the pointer every [`POLL`] (the page's
//! 250 ms), then every part the pointer names that it has not had, in number order, over plain HTTP. Each part is read
//! as a page reads it (`StreamPart::read`, then T6's `Part::read`), and the first time an effect caused by an intent
//! (`Cause::Intent(id)`, T6 rule 6) is seen, its arrival is kept by the intent's id. A receipt or acceptance names the
//! same id (field 4, `v2/docs/intents.md` rule 8), so the driver joins the two: an act's wait is from its send to the
//! arrival of the first part that shows something it caused. The parts already written when the run starts are not
//! read (the page joining late reads a baseline instead; nothing in them is the run's).
//!
//! It also keeps the stream's own lag: each part's arrival against the wall time its world-time end fell at (the
//! pointer's anchor), the part of every act wait that is the stream's cut and settle, not the load.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use replica::effects::{Body, Cause, Part};
use replica::encode::{Value, decode, to_hex};
use replica::ids::Id;
use replica::stream::{Pointer, StreamPart};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The page's pointer poll (`worker.ts`, `setInterval(poll, 250)`).
pub const POLL: Duration = Duration::from_millis(250);

/// What the reader saw: each intent's first visible effect (Unix ms of the part's arrival), the stream's lag per part
/// (ms), the parts read and the reads that failed.
#[derive(Default)]
pub struct Seen {
    pub first: HashMap<Id, u64>,
    pub lag_ms: Vec<i64>,
    pub parts: u64,
    pub failed: u64,
}

/// An HTTP/1.1 GET (one connection a request, as `--remote` is plain): the status and the body.
async fn get(base: &str, path: &str) -> Result<(u16, Vec<u8>), String> {
    let rest = base
        .strip_prefix("http://")
        .ok_or("--stream: give http://")?;
    let (host, dir) = rest.split_once('/').unwrap_or((rest, ""));
    let mut s = tokio::net::TcpStream::connect(host)
        .await
        .map_err(|e| e.to_string())?;
    let req = format!(
        "GET /{dir}{path} HTTP/1.1\r\nHost: {host}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
    );
    s.write_all(req.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
    let at = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("no HTTP answer")?;
    let head = String::from_utf8_lossy(&buf[..at]).to_ascii_lowercase();
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let mut body = buf[at + 4..].to_vec();
    if head.contains("transfer-encoding: chunked") {
        let (mut out, mut i) = (Vec::new(), 0);
        while let Some(end) = body[i..].windows(2).position(|w| w == b"\r\n") {
            let n = usize::from_str_radix(
                String::from_utf8_lossy(&body[i..i + end])
                    .split(';')
                    .next()
                    .unwrap_or("0")
                    .trim(),
                16,
            )
            .unwrap_or(0);
            if n == 0 {
                break;
            }
            let from = i + end + 2;
            out.extend_from_slice(&body[from..(from + n).min(body.len())]);
            i = from + n + 2;
            if i >= body.len() {
                break;
            }
        }
        body = out;
    }
    Ok((status, body))
}

/// The pointer's newest part, the folder its parts are in (`g/<generation>/` for a public stream with a baseline,
/// else the stream's own), and its anchor.
fn pointer(bytes: &[u8]) -> Option<(Option<u64>, String, Pointer)> {
    let p = Pointer::read(bytes).ok()?;
    let generation = match decode(bytes).ok()?.value {
        Value::Map(m) => match m.get(&8) {
            Some(Value::Bytes(h)) => format!("g/{}/", to_hex(h)),
            _ => String::new(),
        },
        _ => String::new(),
    };
    Some((p.newest, generation, p))
}

/// Whether an effect shows something on the page: changes, a transfer, or events (a say's `souls:said`).
fn visible(e: &replica::effects::Effect) -> bool {
    match &e.body {
        Body::Changes(c) => !c.is_empty() || e.events.as_ref().is_some_and(|v| !v.is_empty()),
        Body::Transfer(_) => true,
        _ => e.events.as_ref().is_some_and(|v| !v.is_empty()),
    }
}

/// Reads the stream at `base` until `stop`, then hands back what it saw.
// A tool, not the engine: arrival times are wall-clock time (K7, v2/clippy.toml).
#[allow(clippy::disallowed_methods)]
pub async fn read(base: String, stop: Arc<AtomicBool>) -> Seen {
    let now_ms = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64)
    };
    let mut seen = Seen::default();
    let mut last: Option<(String, u64)> = None;
    let mut tick = tokio::time::interval(POLL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    while !stop.load(Ordering::Relaxed) {
        tick.tick().await;
        let Ok((200, b)) = get(&base, "pointer").await else {
            seen.failed += 1;
            continue;
        };
        let Some((Some(newest), dir, p)) = pointer(&b) else {
            continue;
        };
        let from = match &last {
            // The parts written before the run are not the run's.
            None => {
                last = Some((dir, newest));
                continue;
            }
            Some((d, n)) if *d == dir => n + 1,
            // A new generation: its parts are numbered afresh.
            Some(_) => 0,
        };
        for n in from..=newest {
            let Ok((200, bytes)) = get(&base, &format!("{dir}{n}")).await else {
                seen.failed += 1;
                continue;
            };
            let at = now_ms();
            let Ok(sp) = StreamPart::read(&bytes) else {
                seen.failed += 1;
                continue;
            };
            seen.parts += 1;
            let end_wall = p.anchor_wall_ms as i64 + (sp.to - p.anchor_world) / 1000;
            seen.lag_ms.push(at as i64 - end_wall);
            let Ok(part) = Part::read(&sp.part) else {
                seen.failed += 1;
                continue;
            };
            for e in &part.effects {
                if let (Cause::Intent(id), true) = (e.envelope.cause, visible(e)) {
                    seen.first.entry(id).or_insert(at);
                }
            }
        }
        last = Some((dir, newest));
    }
    seen
}
