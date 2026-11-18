//! The gateway's receipts file: one JSON line per answered intent, appended to `<dir>/<UTC day>.jsonl`, where `dir`
//! is the world's `<worlds root>/worlds/<world>/receipts` (`--receipts`). The operator's daily usage roll-up reads it
//! (O21, #3325, `v2/tools/ops/health/usage.mjs`):
//!
//! `{"t": <ms since 1970>, "soul": "<grant>", "account": "<id>" | null, "outcome": "receipt" | "refusal", "client":
//! "<name/version>" | null}`
//!
//! A line holds those five fields and nothing else: never an intent's bytes or text, never a token. The account comes
//! from the tokens file and the client from the socket's `souls-client` (else `user-agent`) header; both are cut to
//! [`FIELD_MOST`] plain characters, shorter than any token. A line is handed to one writer thread through a bounded
//! queue and never waited for: a full queue or a failed write drops the line and counts it ([`Receipts::dropped`]),
//! so a slow or broken disk never blocks or slows an answer.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};

/// Lines queued to the writer before more are dropped.
pub const QUEUE: usize = 4096;
/// The longest account or client kept in a line, in characters. A token is longer (`token.rs`).
pub const FIELD_MOST: usize = 64;

/// Who an answer counts for: the signed-in grant, its account, its client.
#[derive(Clone, Debug, Default)]
pub struct Who {
    pub soul: String,
    pub account: Option<String>,
    pub client: Option<String>,
}

impl Who {
    pub fn new(soul: String, account: Option<&str>, client: Option<&str>) -> Who {
        Who {
            soul: plain(&soul),
            account: account.map(plain).filter(|s| !s.is_empty()),
            client: client.map(plain).filter(|s| !s.is_empty()),
        }
    }
}

/// Plain characters only, at most [`FIELD_MOST`]: nothing a JSON string must escape.
fn plain(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || " ._/+:()-;,".contains(*c))
        .take(FIELD_MOST)
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Receipt,
    Refusal,
}

struct Line {
    t: u64,
    who: Arc<Who>,
    outcome: Outcome,
}

/// The receipts writer, or none (`off`).
pub struct Receipts {
    tx: Option<SyncSender<Line>>,
    dropped: Arc<AtomicU64>,
}

impl Receipts {
    /// Writes no receipts.
    pub fn off() -> Receipts {
        Receipts {
            tx: None,
            dropped: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Appends receipts under `dir`, from a thread of their own.
    pub fn to_dir(dir: PathBuf) -> Receipts {
        let (tx, rx) = sync_channel(QUEUE);
        let dropped = Arc::new(AtomicU64::new(0));
        let counted = dropped.clone();
        let spawned = std::thread::Builder::new()
            .name("receipts".into())
            .spawn(move || writer(dir, rx, counted));
        Receipts {
            tx: spawned.is_ok().then_some(tx),
            dropped,
        }
    }

    /// Queues one line; never waits. A line that cannot be queued is dropped and counted.
    pub fn write(&self, who: &Arc<Who>, outcome: Outcome) {
        let Some(tx) = &self.tx else { return };
        let line = Line {
            t: now_ms(),
            who: who.clone(),
            outcome,
        };
        if let Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) = tx.try_send(line) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Lines dropped so far: the queue was full, or the write failed.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

fn writer(dir: PathBuf, rx: Receiver<Line>, dropped: Arc<AtomicU64>) {
    let mut open: Option<(String, File)> = None;
    while let Ok(line) = rx.recv() {
        let day = utc_day(line.t);
        if open.as_ref().is_none_or(|(d, _)| *d != day) {
            open = std::fs::create_dir_all(&dir)
                .and_then(|()| {
                    OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(dir.join(format!("{day}.jsonl")))
                })
                .ok()
                .map(|f| (day, f));
        }
        let ok = open
            .as_mut()
            .is_some_and(|(_, f)| f.write_all(json(&line).as_bytes()).is_ok());
        if !ok {
            dropped.fetch_add(1, Ordering::Relaxed);
            open = None;
        }
    }
}

fn json(l: &Line) -> String {
    let opt = |v: &Option<String>| v.as_ref().map_or("null".to_owned(), |s| format!("\"{s}\""));
    let outcome = match l.outcome {
        Outcome::Receipt => "receipt",
        Outcome::Refusal => "refusal",
    };
    format!(
        "{{\"t\":{},\"soul\":\"{}\",\"account\":{},\"outcome\":\"{outcome}\",\"client\":{}}}\n",
        l.t,
        l.who.soul,
        opt(&l.who.account),
        opt(&l.who.client)
    )
}

/// The time of day in ms. Allowed by name: a receipt's time names the UTC day of the operator's usage file; it never
/// reaches the world (the wall-clock rule, `v2/clippy.toml`).
#[allow(clippy::disallowed_methods)]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// `YYYY-MM-DD` of a time in ms, in UTC (the civil-from-days algorithm).
pub fn utc_day(ms: u64) -> String {
    let z = (ms / 86_400_000) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_days() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(utc_day(951_782_400_000), "2000-02-29");
        assert_eq!(utc_day(1_795_046_399_999), "2026-11-18");
        assert_eq!(utc_day(1_795_046_400_000), "2026-11-19");
    }

    #[test]
    fn a_full_queue_drops_and_counts_without_waiting() {
        // A writer that never reads: the queue fills, and every further line is dropped at once.
        let (tx, _rx) = sync_channel(2);
        let r = Receipts {
            tx: Some(tx),
            dropped: Arc::new(AtomicU64::new(0)),
        };
        let who = Arc::new(Who::new("soul-01-1".into(), None, None));
        for _ in 0..10 {
            r.write(&who, Outcome::Receipt);
        }
        assert_eq!(r.dropped(), 8);
    }

    #[test]
    fn fields_are_plain_and_short() {
        let who = Who::new(
            "soul-01-1".into(),
            Some("acct_\"x\"\n"),
            Some(&"a".repeat(200)),
        );
        assert_eq!(who.account.as_deref(), Some("acct_x"));
        assert_eq!(who.client.map(|c| c.len()), Some(FIELD_MOST));
    }
}
