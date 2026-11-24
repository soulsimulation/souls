//! The public stream's recovery chain, written to the local spool first and backed up to the store behind it (R15).
//!
//! Viewers read the stream's parts from this machine's disk. A part, its words, its recovery objects and the chain's
//! head are written here (the spool, `<world>/stream-backup/<store key>`) before the part is published; the store is
//! written by this module's own thread, behind the stream: a store that stalls or refuses delays only the backup,
//! never a viewer, the world's clock or the stream. The thread tries again with back-off (1, 2, 4 … 60 s) for ever.
//!
//! The spool is the queue: what is in it is not yet in the store. Each pass reads the spool's head first, then puts
//! every object the spool holds (create-only: an object already there is the same bytes, as its name is their hash),
//! then the head, and then removes the objects it put. A restart recovers its chain from the spool's head, reading an
//! object from the spool where it is still there and from the store where it was backed up, so a crash before the
//! backup replays the exact published bytes. Nothing is dropped: the spool's bound is the disk, as the log's is, and
//! what it holds is said in `health.json` (`stream_backup.behind`, `behind_bytes`).
//!
//! **One writer.** The head is put only over the head this writer last confirmed in the store (`head.confirmed` in
//! the spool: its ETag and bytes, from the store as the writer found it at open, or from its own last put), and a
//! head it tried whose answer was lost (`head.tried`) counts as its own. A head in the store that is neither is
//! another writer's: the backup is **fenced**, for good. It never adopts that head nor puts over it, and says so in
//! `health.json`; the stream and its viewers go on from the local disk.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use directoryd::directory::store::{Store as ObjectStore, When};
use replica::encode::to_hex;

/// The waits between refused passes: 1, 2, 4 … 32 s, then every 60 s.
pub const BACKOFF_MS: [u64; 7] = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
/// Old generations' recovery objects deleted from the store in one pass (#3833).
const DELETES_PER_PASS: usize = 64;
/// The generations closed long enough ago to delete waiting, at most: a rollover adds one, so this holds hours of
/// them; past it the oldest is left in the store (best effort, as deletion always was).
const PRUNES_HELD: usize = 64;

/// How the backup stands, for `health.json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum State {
    /// The store holds the spool's head.
    Current,
    /// A pass was refused `tries` times in a row, the last with `fault`; the next in `next_try_ms`. `behind` objects
    /// (`behind_bytes` bytes) wait in the spool.
    Degraded {
        fault: String,
        tries: u64,
        next_try_ms: u64,
        behind: u64,
        behind_bytes: u64,
    },
    /// The store's head is another writer's: this backup has stopped for good.
    Fenced { fault: String },
}

/// The writer's side of the backup: where the spool is, and how it tells the thread there is more.
pub struct Spool {
    pub(super) dir: PathBuf,
    wake: Option<SyncSender<()>>,
    prunes: Prunes,
    progress: Arc<Progress>,
}

/// Old generations' records to delete by, each with the objects the chain then named (never deleted).
type Prunes = Arc<Mutex<Vec<(String, BTreeSet<Vec<u8>>)>>>;

/// The passes made, whether the last left the store holding the spool's head, and whether the backup is fenced.
#[derive(Default)]
struct Progress {
    passes: AtomicU64,
    current: AtomicBool,
    over: AtomicBool,
}

/// A handle that waits, bounded, for the backup to hold the spool's head ([`Drain::drain`]).
#[derive(Clone)]
pub struct Drain {
    wake: SyncSender<()>,
    progress: Arc<Progress>,
}

impl Drain {
    /// Asks for a pass and waits until one begun after the ask leaves the store holding the spool's head, or `limit`
    /// passes: before a stop, so a move to a new machine finds the store current. Whether it is.
    #[allow(clippy::disallowed_methods)] // A stop's wait is real time, off the world's clock.
    pub fn drain(&self, limit: Duration) -> bool {
        let end = Instant::now() + limit;
        let asked = self.progress.passes.load(Ordering::Acquire);
        let _ = self.wake.try_send(());
        while Instant::now() < end {
            if self.progress.over.load(Ordering::Acquire) {
                return false;
            }
            // One pass may be under way with an older head: the one after it began after the ask.
            if self.progress.passes.load(Ordering::Acquire) >= asked + 2
                && self.progress.current.load(Ordering::Acquire)
            {
                return true;
            }
            let _ = self.wake.try_send(());
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }
}

fn confirmed_key(head_key: &str) -> String {
    format!("{head_key}.confirmed")
}

fn tried_key(head_key: &str) -> String {
    format!("{head_key}.tried")
}

impl Spool {
    pub(super) fn new(dir: PathBuf) -> Spool {
        Spool {
            dir,
            wake: None,
            prunes: Arc::default(),
            progress: Arc::default(),
        }
    }

    pub(super) fn path(&self, key: &str) -> PathBuf {
        self.dir.join(key)
    }

    fn write(&self, key: &str, bytes: &[u8]) -> super::R<()> {
        let path = self.path(key);
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).map_err(super::io)?;
        }
        super::write_whole(&path, bytes)
    }

    /// Writes `bytes` under `key` (an object once: its name is their hash).
    pub(super) fn object(&self, key: &str, bytes: &[u8]) -> super::R<()> {
        if self.path(key).is_file() {
            return Ok(());
        }
        self.write(key, bytes)
    }

    /// The chain's head, written whole; then the thread is told.
    pub(super) fn head(&self, key: &str, bytes: &[u8]) -> super::R<()> {
        self.write(key, bytes)?;
        self.poke();
        Ok(())
    }

    /// The store's head under `head_key` as the writer found it there (`etag`, `bytes`): what its backup puts over.
    pub(super) fn confirm(&self, head_key: &str, bytes: &[u8], etag: &str) -> super::R<()> {
        confirm(&self.dir, head_key, bytes, etag)
    }

    pub(super) fn read(&self, key: &str) -> Option<Vec<u8>> {
        std::fs::read(self.path(key)).ok()
    }

    /// An old generation's record to delete by, with the objects the current chain names (never deleted).
    pub(super) fn prune(&self, record_key: String, live: BTreeSet<Vec<u8>>) {
        if let Ok(mut p) = self.prunes.lock()
            && p.len() < PRUNES_HELD
        {
            p.push((record_key, live));
        }
    }

    /// The handle a stop drains the backup by, once the backup runs.
    pub(super) fn drainer(&self) -> Option<Drain> {
        Some(Drain {
            wake: self.wake.clone()?,
            progress: Arc::clone(&self.progress),
        })
    }

    fn poke(&self) {
        // Never waits: a wake already queued covers this one.
        if let Some(w) = &self.wake {
            let _ = w.try_send(());
        }
    }
}

/// `head.confirmed`: the ETag, a newline, the head's bytes; and no head tried since.
fn confirm(dir: &Path, head_key: &str, bytes: &[u8], etag: &str) -> super::R<()> {
    let mut b = etag.as_bytes().to_vec();
    b.push(b'\n');
    b.extend_from_slice(bytes);
    let path = dir.join(confirmed_key(head_key));
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(super::io)?;
    }
    super::write_whole(&path, &b)?;
    match std::fs::remove_file(dir.join(tried_key(head_key))) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(super::io(e)),
        _ => Ok(()),
    }
}

/// Starts the backup of `spool`'s chain under `prefix` to `store`, on its own thread; `report` is told each change of
/// its state.
pub(super) fn start<S: ObjectStore + Send + 'static>(
    spool: &mut Spool,
    store: S,
    prefix: String,
    report: Box<dyn Fn(State) + Send>,
) -> super::R<()> {
    let (wake, woken) = std::sync::mpsc::sync_channel(1);
    spool.wake = Some(wake);
    let head_key = format!("{prefix}head");
    let confirmed = std::fs::read(spool.dir.join(confirmed_key(&head_key)))
        .ok()
        .and_then(|b| {
            let at = b.iter().position(|c| *c == b'\n')?;
            Some((
                b[at + 1..].to_vec(),
                String::from_utf8(b[..at].to_vec()).ok()?,
            ))
        });
    let tried = std::fs::read(spool.dir.join(tried_key(&head_key)))
        .map(|b| unframe(&b))
        .unwrap_or_default();
    let worker = Worker {
        store,
        dir: spool.dir.clone(),
        prefix,
        head_key,
        prunes: Arc::clone(&spool.prunes),
        progress: Arc::clone(&spool.progress),
        confirmed,
        tried,
        deletes: std::collections::VecDeque::new(),
        deleting: true,
    };
    std::thread::Builder::new()
        .name("stream-backup".into())
        .spawn(move || worker.run(&woken, &*report))
        .map_err(super::io)?;
    Ok(())
}

/// Heads, each as its length (4 bytes, big-endian) and bytes.
fn frame(heads: &[Vec<u8>]) -> Vec<u8> {
    let mut b = Vec::new();
    for h in heads {
        b.extend_from_slice(&u32::try_from(h.len()).unwrap_or(u32::MAX).to_be_bytes());
        b.extend_from_slice(h);
    }
    b
}

fn unframe(mut b: &[u8]) -> Vec<Vec<u8>> {
    let mut heads = Vec::new();
    while b.len() >= 4 {
        let n = u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize;
        let Some(h) = b.get(4..4 + n) else { break };
        heads.push(h.to_vec());
        b = &b[4 + n..];
    }
    heads
}

/// Why a pass ended short.
enum Short {
    /// Tried again after the back-off.
    Refused(super::Refusal),
    /// The store's head is another writer's.
    Fenced(String),
}

impl From<super::Refusal> for Short {
    fn from(e: super::Refusal) -> Short {
        Short::Refused(e)
    }
}

struct Worker<S> {
    store: S,
    dir: PathBuf,
    prefix: String,
    head_key: String,
    prunes: Prunes,
    progress: Arc<Progress>,
    /// The head this writer last knew the store to hold, and its ETag; none: the store had no head.
    confirmed: Option<(Vec<u8>, String)>,
    /// Heads put since, whose answers were lost: if the store holds one, it is this writer's.
    tried: Vec<Vec<u8>>,
    deletes: std::collections::VecDeque<String>,
    deleting: bool,
}

impl<S: ObjectStore> Worker<S> {
    #[allow(clippy::disallowed_methods)] // The backup's waits are real time, off the world's clock.
    fn run(mut self, woken: &Receiver<()>, report: &dyn Fn(State)) {
        let mut tries = 0u64;
        loop {
            let pass = self.pass();
            self.progress
                .current
                .store(matches!(pass, Ok(true)), Ordering::Release);
            self.progress.passes.fetch_add(1, Ordering::AcqRel);
            match pass {
                Ok(_) => {
                    if tries > 0 {
                        eprintln!(
                            "worldd: the public stream's backup caught up after {tries} refused passes"
                        );
                        report(State::Current);
                    }
                    tries = 0;
                    if let Err(std::sync::mpsc::RecvTimeoutError::Disconnected) =
                        woken.recv_timeout(Duration::from_secs(1))
                    {
                        // The writer is gone: one last pass for what it left, then the thread ends.
                        let _ = self.pass();
                        return;
                    }
                }
                Err(Short::Fenced(fault)) => {
                    eprintln!(
                        "worldd: the public stream's backup is fenced, viewers unaffected: {fault}; it stops for good"
                    );
                    self.progress.over.store(true, Ordering::Release);
                    report(State::Fenced { fault });
                    return;
                }
                Err(Short::Refused(e)) => {
                    tries += 1;
                    let wait = BACKOFF_MS[(tries as usize - 1).min(BACKOFF_MS.len() - 1)];
                    let fault = format!("{}: {}", e.name, e.detail);
                    let objects = self.objects();
                    let behind = objects.len() as u64;
                    let behind_bytes = objects
                        .iter()
                        .filter_map(|k| std::fs::metadata(self.dir.join(k)).ok())
                        .map(|m| m.len())
                        .sum();
                    eprintln!(
                        "worldd: the public stream's backup is behind, viewers unaffected: {fault}; pass {tries} refused, {behind} objects ({behind_bytes} bytes) wait, the next in {wait} ms"
                    );
                    report(State::Degraded {
                        fault,
                        tries,
                        next_try_ms: wait,
                        behind,
                        behind_bytes,
                    });
                    // A drain's wake does not cut the back-off short: the store was refusing.
                    std::thread::sleep(Duration::from_millis(wait));
                }
            }
        }
    }

    /// The spool's objects not yet in the store, as store keys.
    fn objects(&self) -> Vec<String> {
        let rel = format!("{}objects", self.prefix);
        let Ok(entries) = std::fs::read_dir(self.dir.join(&rel)) else {
            return Vec::new();
        };
        let mut keys: Vec<String> = entries
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.len() == 64 && n.bytes().all(|b| b.is_ascii_hexdigit()))
            .map(|n| format!("{rel}/{n}"))
            .collect();
        keys.sort();
        keys
    }

    /// One pass; whether it left the store holding the spool's head.
    fn pass(&mut self) -> Result<bool, Short> {
        // The head first: every object it names was in the spool before it, or is already in the store.
        let head = std::fs::read(self.dir.join(&self.head_key)).ok();
        let mut put = Vec::new();
        for key in self.objects() {
            let bytes = std::fs::read(self.dir.join(&key)).map_err(super::io)?;
            match self.store.put(&key, &bytes, When::Absent) {
                Ok(_) => {}
                // Its name is its hash: the object there is these bytes.
                Err(e) if e.name == "precondition-failed" => {}
                Err(e) => return Err(e.into()),
            }
            put.push(key);
        }
        let current = match head {
            Some(head) if self.confirmed.as_ref().map(|c| &c.0) != Some(&head) => {
                self.put_head(head)?
            }
            _ => true,
        };
        // In the store now, and named by a head there or by the next: off the spool.
        for key in &put {
            let _ = std::fs::remove_file(self.dir.join(key));
        }
        self.prune();
        Ok(current)
    }

    /// Puts `head` over the confirmed one; whether the store holds it now.
    fn put_head(&mut self, head: Vec<u8>) -> Result<bool, Short> {
        if !self.tried.contains(&head) {
            self.tried.push(head.clone());
            let path = self.dir.join(tried_key(&self.head_key));
            super::write_whole(&path, &frame(&self.tried))?;
        }
        let when = match &self.confirmed {
            Some((_, etag)) => When::Is(etag),
            None => When::Absent,
        };
        let lost = match self.store.put(&self.head_key, &head, when) {
            Ok(etag) => {
                self.confirm(head, etag)?;
                return Ok(true);
            }
            Err(e) => e,
        };
        // Refused or unanswered: what the store holds now says whose head it is.
        let there = self.store.get(&self.head_key).map_err(|_| lost.clone())?;
        match there {
            Some(o) if o.bytes == head => {
                self.confirm(head, o.etag)?;
                Ok(true)
            }
            // An earlier try of this writer's landed, or the confirmed head is still there: put over it next pass.
            Some(o)
                if self.tried.contains(&o.bytes)
                    || self.confirmed.as_ref().is_some_and(|c| c.0 == o.bytes) =>
            {
                self.confirm(o.bytes, o.etag)?;
                Err(lost.into())
            }
            None if self.confirmed.is_none() => Err(lost.into()),
            Some(_) => Err(Short::Fenced(format!(
                "stream-backup-fenced: the store's head {} is another writer's",
                self.head_key
            ))),
            None => Err(Short::Fenced(format!(
                "stream-backup-fenced: the store's head {} is gone",
                self.head_key
            ))),
        }
    }

    fn confirm(&mut self, head: Vec<u8>, etag: String) -> super::R<()> {
        confirm(&self.dir, &self.head_key, &head, &etag)?;
        self.tried.clear();
        self.confirmed = Some((head, etag));
        Ok(())
    }

    /// Old generations' chains off the store (#3833), a few at a time; a store that cannot delete is left as it is.
    fn prune(&mut self) {
        if !self.deleting {
            return;
        }
        if self.deletes.is_empty() {
            let todo = self
                .prunes
                .lock()
                .map(|mut p| std::mem::take(&mut *p))
                .unwrap_or_default();
            for (record_key, live) in todo {
                let Ok(Some(o)) = self.store.get(&record_key) else {
                    continue;
                };
                let Ok(r) = super::object_map(&o.bytes) else {
                    continue;
                };
                if let Some(replica::encode::Value::Array(objects)) = r.get(&3) {
                    for o in objects {
                        if let replica::encode::Value::Bytes(h) = o
                            && !live.contains(h)
                        {
                            self.deletes
                                .push_back(format!("{}objects/{}", self.prefix, to_hex(h)));
                        }
                    }
                }
                self.deletes.push_back(record_key);
            }
        }
        for _ in 0..DELETES_PER_PASS {
            let Some(key) = self.deletes.pop_front() else {
                return;
            };
            if self.store.delete(&key).is_err() {
                self.deletes.clear();
                self.deleting = false;
                return;
            }
        }
    }
}

/// The spool beside a world's `views/`: never under it, as the chunks hold the world's own records.
pub fn beside(views: &Path) -> PathBuf {
    views.with_file_name("stream-backup")
}
