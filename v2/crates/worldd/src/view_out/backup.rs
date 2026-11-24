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
//! what it holds is said in `health.json` (`stream.backup.behind`).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
    /// wait in the spool.
    Degraded {
        fault: String,
        tries: u64,
        next_try_ms: u64,
        behind: u64,
    },
}

/// The writer's side of the backup: where the spool is, and how it tells the thread there is more.
pub struct Spool {
    pub(super) dir: PathBuf,
    wake: Option<SyncSender<()>>,
    prunes: Prunes,
}

/// Old generations' records to delete by, each with the objects the chain then named (never deleted).
type Prunes = Arc<Mutex<Vec<(String, BTreeSet<Vec<u8>>)>>>;

impl Spool {
    pub(super) fn new(dir: PathBuf) -> Spool {
        Spool {
            dir,
            wake: None,
            prunes: Arc::default(),
        }
    }

    pub(super) fn path(&self, key: &str) -> PathBuf {
        self.dir.join(key)
    }

    /// Writes `bytes` under `key` (an object once: its name is their hash).
    pub(super) fn object(&self, key: &str, bytes: &[u8]) -> super::R<()> {
        let path = self.path(key);
        if path.is_file() {
            return Ok(());
        }
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).map_err(super::io)?;
        }
        super::write_whole(&path, bytes)
    }

    /// The chain's head, written whole; then the thread is told.
    pub(super) fn head(&self, key: &str, bytes: &[u8]) -> super::R<()> {
        let path = self.path(key);
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).map_err(super::io)?;
        }
        super::write_whole(&path, bytes)?;
        self.poke();
        Ok(())
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

    fn poke(&self) {
        // Never waits: a wake already queued covers this one.
        if let Some(w) = &self.wake {
            let _ = w.try_send(());
        }
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
    let worker = Worker {
        store,
        dir: spool.dir.clone(),
        prefix,
        prunes: Arc::clone(&spool.prunes),
        etag: None,
        known: false,
        put_head: None,
        deletes: std::collections::VecDeque::new(),
        deleting: true,
    };
    std::thread::Builder::new()
        .name("stream-backup".into())
        .spawn(move || worker.run(&woken, &*report))
        .map_err(super::io)?;
    Ok(())
}

struct Worker<S> {
    store: S,
    dir: PathBuf,
    prefix: String,
    prunes: Prunes,
    /// The store's head's ETag, once read (`known`); none when the store has no head.
    etag: Option<String>,
    known: bool,
    /// The head bytes last put.
    put_head: Option<Vec<u8>>,
    deletes: std::collections::VecDeque<String>,
    deleting: bool,
}

impl<S: ObjectStore> Worker<S> {
    #[allow(clippy::disallowed_methods)] // The backup's waits are real time, off the world's clock.
    fn run(mut self, woken: &Receiver<()>, report: &dyn Fn(State)) {
        let mut tries = 0u64;
        loop {
            match self.pass() {
                Ok(()) => {
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
                Err(e) => {
                    tries += 1;
                    let wait = BACKOFF_MS[(tries as usize - 1).min(BACKOFF_MS.len() - 1)];
                    let fault = format!("{}: {}", e.name, e.detail);
                    let behind = self.objects().len() as u64;
                    eprintln!(
                        "worldd: the public stream's backup is behind, viewers unaffected: {fault}; pass {tries} refused, {behind} objects wait, the next in {wait} ms"
                    );
                    report(State::Degraded {
                        fault,
                        tries,
                        next_try_ms: wait,
                        behind,
                    });
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

    fn pass(&mut self) -> super::R<()> {
        let head_key = format!("{}head", self.prefix);
        // The head first: every object it names was in the spool before it, or is already in the store.
        let head = std::fs::read(self.dir.join(&head_key)).ok();
        let objects = self.objects();
        for key in &objects {
            let Ok(bytes) = std::fs::read(self.dir.join(key)) else {
                continue;
            };
            match self.store.put(key, &bytes, When::Absent) {
                Ok(_) => {}
                // Its name is its hash: the object there is these bytes.
                Err(e) if e.name == "precondition-failed" => {}
                Err(e) => return Err(e),
            }
        }
        if let Some(head) = head.filter(|h| self.put_head.as_ref() != Some(h)) {
            if !self.known {
                self.etag = self.store.get(&head_key)?.map(|o| o.etag);
                self.known = true;
            }
            let when = match self.etag.as_deref() {
                Some(e) => When::Is(e),
                None => When::Absent,
            };
            match self.store.put(&head_key, &head, when) {
                Ok(etag) => self.etag = Some(etag),
                Err(e) if e.name == "precondition-failed" => {
                    // A put whose answer was lost may have landed: the head there is ours, or another writer's.
                    match self.store.get(&head_key)? {
                        Some(o) if o.bytes == head => self.etag = Some(o.etag),
                        Some(o) => {
                            self.etag = Some(o.etag);
                            return Err(super::fault(
                                "stream-backup-head",
                                "the store's head is not the one this writer last put",
                            ));
                        }
                        None => {
                            self.etag = None;
                            return Err(e);
                        }
                    }
                }
                Err(e) => {
                    // Unknown whether it landed: the ETag is read again next pass.
                    self.known = false;
                    return Err(e);
                }
            }
            self.put_head = Some(head);
        }
        // In the store now, and named by a head there or by the next: off the spool.
        for key in &objects {
            let _ = std::fs::remove_file(self.dir.join(key));
        }
        self.prune();
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
