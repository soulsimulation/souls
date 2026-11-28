//! The public stream's recovery chain, written to the local spool first and backed up to the store behind it (R15).
//!
//! Viewers read the stream's parts from this machine's disk. A part, its words, its recovery objects and the chain's
//! head are written here (the spool, `<world>/stream-backup/<store key>`) before the part is published; the store is
//! written by this module's own thread, behind the stream: a store that stalls or refuses delays only the backup,
//! never a viewer, the world's clock or the stream. The thread tries again with back-off (1, 2, 4 … 60 s) for ever.
//!
//! The spool is the queue: what is in it is not yet in the store. Each pass reads the spool's head first, then puts
//! every object the spool holds (create-only: an object already there is the same bytes, as its name is their hash),
//! moving each one put into `kept/` (the spool's copy of what the store holds), then the head. A restart recovers its
//! chain from the spool's head and its objects from this disk, the spool or `kept/`, so it never waits on the store
//! to serve viewers (24 Nov: three worlds served none for ten minutes while the store held every read of a backed-up
//! object); only a chain this machine did not write (a new machine, a spool lost) is read from the store, and what it
//! reads is kept too. A crash before the backup replays the exact published bytes. Nothing is dropped: the spool's
//! bound is the disk, as the log's is, and what waits in it is said in `health.json` (`stream_backup.behind`,
//! `behind_bytes`); `kept/` loses an old generation's objects as the store does (#3833).
//!
//! **One writer.** The head is put only over the head this writer last confirmed in the store (`head.confirmed` in
//! the spool: its ETag and bytes, from the store as the writer found it at open, or from its own last put), and a
//! head it tried whose answer was lost (`head.tried`) counts as its own. A head in the store that is neither is
//! another writer's: the backup is **fenced**, for good. It never adopts that head nor puts over it, and says so in
//! `health.json`; the stream and its viewers go on from the local disk. A confirmed head is kept with the store's
//! identity: a spool with none, or one of another store, learns the store's head again (and puts over it), and a
//! store with no head gets this writer's; neither is fenced. A spool of another store (the store moved: its address
//! changed) also puts every object kept on this disk to the new one again before its first head there, so the new
//! store holds the whole chain its head names, as a new machine reads it.
//!
//! **Clean-up** (#3833, #4954). Old generations' chains are deleted from the store by a second thread with its own
//! client ([`Cleanup`]), never by the backup's: a slow or refusing delete holds back no put, and neither touches the
//! world's clock or the stream. A refused delete is tried again after its own back-off (1, 2, 4 … 60 s, for ever) while
//! the rest go on; the clean-up never switches itself off (before #4954 one refused delete did, until the world
//! restarted, and Eden's store kept 35,257 stream objects against about 1,300 live). An object the current chain names
//! is never deleted: the spool keeps the chain's objects as the writer last handed them over, and every object written
//! to it since ([`Spool::live`]), and each delete is checked against both under the lock the writer names an object
//! under; one the chain comes to name while its delete is under way goes back in the spool's queue and is put again
//! ([`Named`]). Nothing is deleted until a backup pass begun after the chain was last handed over has left the store
//! holding its head, so never an object of an older chain the store's head still names. A copy in `kept/` leaves it
//! before its delete is sent, so a stop meanwhile leaves no copy saying the store holds it (the start queues what it
//! finds in `deleting/` again). A generation's record is deleted after its objects and every older generation's, so a
//! restart, which walks back from the newest record, still finds one whose delete waits.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use directoryd::directory::store::{Store as ObjectStore, When};
use replica::encode::to_hex;

/// The waits between refused passes that put nothing: 1, 2, 4 … 32 s, then every 60 s. A refused pass that put objects
/// first waits the shortest again: the store is answering, and one unanswered put in a few hundred (the offsite bucket
/// holds about one request in a hundred past 5 s, 25 Nov 2026) must not hold a backlog of thousands at a pass a minute.
pub const BACKOFF_MS: [u64; 7] = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
/// Old generations' recovery objects the clean-up deletes before it looks for new work (#3833): it goes on at once
/// while more wait, one delete at a time, so its pace is the store's.
const DELETES_PER_PASS: usize = 64;
/// The generations waiting for the clean-up's thread held with the chain's objects as they were then, at most: past
/// it, each is held by its key alone (a chain's objects are about 40 KB; a backup fenced for a day holds 720).
const PRUNES_HELD: usize = 64;
/// The spool's copies of the objects the store holds, under their store keys.
const KEPT: &str = "kept";
/// The copies of objects whose delete from the store is under way: moved here from `kept/` before the delete is sent,
/// so a stop before it is settled leaves no copy saying the store holds them; a start puts them back in the queue.
const DELETING: &str = "deleting";

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
    store: String,
    wake: Option<SyncSender<()>>,
    /// Tells the clean-up's thread there is more; dropped with the spool, which ends it.
    tidy: Option<SyncSender<()>>,
    prunes: Prunes,
    live: Live,
    progress: Arc<Progress>,
}

/// Old generations' records to delete by, oldest first, held for the clean-up's thread, each with the objects the chain
/// then named (never deleted; past [`PRUNES_HELD`] held, none: the check at each delete alone keeps the chain's).
#[derive(Default)]
struct Held {
    records: Vec<(String, BTreeSet<Vec<u8>>)>,
}

type Prunes = Arc<Mutex<Held>>;

/// What the writer, the backup and the clean-up share about the objects the clean-up may delete, under one lock: each
/// looks at or moves an object's copies on this disk under it, so none acts on what another saw a moment before.
#[derive(Default)]
struct Named {
    /// The store keys of the current chain's objects as the writer last handed them over ([`Spool::live`]).
    handed: BTreeSet<String>,
    /// Every object written to the spool since.
    since: BTreeSet<String>,
    /// The backup's passes finished when the chain was handed over: the clean-up deletes nothing until a pass begun
    /// after that leaves the store holding the spool's head, so never an object of a chain the store's head still names.
    handed_at: u64,
    /// The chain before (handed over and written since), which the store's head may still name until that pass.
    before: BTreeSet<String>,
    /// Objects the clean-up deleted from the store while the chain came to name them again: the backup keeps none of
    /// them on this disk before it has put it once more ([`Cleanup::settle`]).
    resend: BTreeSet<String>,
}

impl Named {
    fn names(&self, key: &str) -> bool {
        self.handed.contains(key) || self.since.contains(key)
    }

    /// Whether a chain the store's head may name, now or after the backup's next passes, names `key`.
    fn wants(&self, key: &str, progress: &Progress) -> bool {
        self.names(key) || (self.before.contains(key) && !progress.past(self.handed_at))
    }
}

type Live = Arc<Mutex<Named>>;

/// The shared names; a lock poisoned by a panic is taken as it stands (the clean-up's own check deletes nothing then).
fn named(live: &Live) -> std::sync::MutexGuard<'_, Named> {
    live.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The passes made, whether the last left the store holding the spool's head, and whether the backup is fenced.
#[derive(Default)]
struct Progress {
    passes: AtomicU64,
    current: AtomicBool,
    over: AtomicBool,
}

impl Progress {
    /// Whether a pass begun after the first `n` finished has left the store holding the spool's head. One pass may be
    /// under way at the `n`th with an older head: the one after it began after.
    fn past(&self, n: u64) -> bool {
        self.passes.load(Ordering::Acquire) >= n + 2 && self.current.load(Ordering::Acquire)
    }
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
            if self.progress.past(asked) {
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

fn requeued_key(head_key: &str) -> String {
    format!("{head_key}.requeued")
}

impl Spool {
    /// The spool in `dir`, backed up to the store whose identity is `store` (a digest of its address: a store moved to
    /// another bucket is another store, whose head the backup learns again).
    pub(super) fn new(dir: PathBuf, store: String) -> Spool {
        Spool {
            dir,
            store,
            wake: None,
            tidy: None,
            prunes: Arc::default(),
            live: Arc::default(),
            progress: Arc::default(),
        }
    }

    pub(super) fn path(&self, key: &str) -> PathBuf {
        self.dir.join(key)
    }

    fn kept(&self, key: &str) -> PathBuf {
        self.dir.join(KEPT).join(key)
    }

    fn write(&self, key: &str, bytes: &[u8]) -> super::R<()> {
        let path = self.path(key);
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).map_err(super::io)?;
        }
        super::write_whole(&path, bytes)
    }

    /// Writes `bytes` under `key` (an object once: its name is their hash). Named by the chain from now on, so the
    /// clean-up never deletes it, even when an old generation named the same bytes.
    pub(super) fn object(&self, key: &str, bytes: &[u8]) -> super::R<()> {
        // Named and looked for under the clean-up's lock (#4954): a copy found here is one the clean-up has not removed,
        // and once named it removes none; one it deleted from the store meanwhile goes back in the queue.
        let there = {
            let mut named = named(&self.live);
            named.since.insert(key.to_owned());
            self.path(key).is_file() || self.kept(key).is_file()
        };
        if there {
            return Ok(());
        }
        self.write(key, bytes)
    }

    /// [`Spool::object`] into a part's `group` (#2803 follow-up): named by the chain at once, as there, and written
    /// to be synced with the part's other files.
    pub(super) fn object_into(
        &self,
        key: &str,
        bytes: &[u8],
        group: &mut super::Group<'_>,
    ) -> super::R<()> {
        let there = {
            let mut named = named(&self.live);
            named.since.insert(key.to_owned());
            self.path(key).is_file() || self.kept(key).is_file()
        };
        if there {
            return Ok(());
        }
        let path = self.path(key);
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).map_err(super::io)?;
        }
        group.whole(&path, bytes)
    }

    /// The chain's head into a part's `group`, named after its objects; the thread is told once it is
    /// ([`Spool::poke`]).
    pub(super) fn head_into(
        &self,
        key: &str,
        bytes: &[u8],
        group: &mut super::Group<'_>,
    ) -> super::R<()> {
        let path = self.path(key);
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).map_err(super::io)?;
        }
        group.whole(&path, bytes)
    }

    /// Keeps `bytes`, read from the store under `key`, on this disk: the next restart reads them here.
    pub(super) fn keep(&self, key: &str, bytes: &[u8]) {
        let path = self.kept(key);
        if path.is_file() {
            return;
        }
        if let Some(p) = path.parent()
            && std::fs::create_dir_all(p).is_ok()
        {
            let _ = super::write_whole(&path, bytes);
        }
    }

    /// The chain's head, written whole; then the thread is told.
    pub(super) fn head(&self, key: &str, bytes: &[u8]) -> super::R<()> {
        self.write(key, bytes)?;
        self.poke();
        Ok(())
    }

    /// The store's head under `head_key` as the writer found it there (`etag`, `bytes`): what its backup puts over.
    pub(super) fn confirm(&self, head_key: &str, bytes: &[u8], etag: &str) -> super::R<()> {
        confirm(&self.dir, &self.store, head_key, bytes, etag)
    }

    /// `key` from this disk: the spool, or its copy of what the store holds.
    pub(super) fn read(&self, key: &str) -> Option<Vec<u8>> {
        std::fs::read(self.path(key))
            .or_else(|_| std::fs::read(self.kept(key)))
            .or_else(|_| std::fs::read(self.dir.join(DELETING).join(key)))
            .ok()
    }

    /// An old generation's record to delete by, with the objects the current chain names (never deleted).
    pub(super) fn prune(&self, record_key: String, live: BTreeSet<Vec<u8>>) {
        if let Ok(mut held) = self.prunes.lock() {
            let live = if held.records.len() < PRUNES_HELD {
                live
            } else {
                BTreeSet::new()
            };
            held.records.push((record_key, live));
        }
        if let Some(t) = &self.tidy {
            let _ = t.try_send(());
        }
    }

    /// The current chain's objects (store keys), as the writer holds them after a rollover or a start: what the
    /// clean-up never deletes, with every object written to the spool from now on. Its head is in the spool already;
    /// the clean-up deletes nothing until the store holds it.
    pub(super) fn live(&self, keys: BTreeSet<String>) {
        let mut named = named(&self.live);
        let handed = std::mem::replace(&mut named.handed, keys);
        let since = std::mem::take(&mut named.since);
        named.before = handed;
        named.before.extend(since);
        named.handed_at = self.progress.passes.load(Ordering::Acquire);
    }

    /// The handle a stop drains the backup by, once the backup runs.
    pub(super) fn drainer(&self) -> Option<Drain> {
        Some(Drain {
            wake: self.wake.clone()?,
            progress: Arc::clone(&self.progress),
        })
    }

    pub(super) fn poke(&self) {
        // Never waits: a wake already queued covers this one.
        if let Some(w) = &self.wake {
            let _ = w.try_send(());
        }
    }
}

/// `head.confirmed`: the store's identity, a newline, the ETag, a newline, the head's bytes (an empty ETag and no
/// bytes: the store had no head); and no head tried since.
fn confirm(dir: &Path, store: &str, head_key: &str, bytes: &[u8], etag: &str) -> super::R<()> {
    let mut b = format!("{store}\n{etag}\n").into_bytes();
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
/// its state. Old generations are deleted from the store through `cleanup`, another client, on a thread of their own.
pub(super) fn start<S: ObjectStore + Send + 'static, C: ObjectStore + Send + 'static>(
    spool: &mut Spool,
    store: S,
    cleanup: C,
    prefix: String,
    report: Box<dyn Fn(State) + Send>,
) -> super::R<()> {
    let (wake, woken) = std::sync::mpsc::sync_channel(1);
    spool.wake = Some(wake);
    let (tidy, tidied) = std::sync::mpsc::sync_channel(1);
    spool.tidy = Some(tidy);
    let cleanup = Cleanup::new(
        cleanup,
        spool.dir.clone(),
        Arc::clone(&spool.prunes),
        Arc::clone(&spool.live),
        Arc::clone(&spool.progress),
    );
    std::thread::Builder::new()
        .name("stream-cleanup".into())
        .spawn(move || cleanup.run(&tidied))
        .map_err(super::io)?;
    let head_key = format!("{prefix}head");
    let found = std::fs::read(spool.dir.join(confirmed_key(&head_key))).ok();
    // Known only when it is this store's: a spool with none, or one of another store, learns the store's head again.
    let confirmed = found.as_deref().and_then(|b| {
        let mut fields = b.splitn(3, |c| *c == b'\n');
        let (store, etag, bytes) = (fields.next()?, fields.next()?, fields.next()?);
        if store != spool.store.as_bytes() {
            return None;
        }
        let etag = String::from_utf8(etag.to_vec()).ok()?;
        Some((!etag.is_empty()).then(|| (bytes.to_vec(), etag)))
    });
    // The store moved (its address changed: the head confirmed is another store's). The new store holds none of the
    // chain's objects this writer already put to the old one, and the spool queues only what it has not put: every
    // object kept on this disk goes back in the queue, so the next pass puts the whole chain before its head there.
    // Once per move (`head.requeued` names the store they were queued for): a restart before the first head lands
    // there finds them queued or, put, kept again, and sends none twice.
    if let Some((queued, left)) = requeue_if_moved(
        &spool.dir,
        &spool.store,
        found.as_deref(),
        &head_key,
        &prefix,
    ) {
        eprintln!(
            "worldd: the public stream's store moved; {queued} recovery objects kept on this disk are queued for it again{}",
            if left > 0 {
                format!(", {left} could not be (the new store lacks them)")
            } else {
                String::new()
            }
        );
    }
    // A stop while deletes were under way (#4954): the store may lack what they named, and the chain may name it again.
    // Back in the queue, put again create-only; one the chain no longer names is deleted again from its record.
    let (back, _) = requeue(&spool.dir, DELETING, &prefix);
    if back > 0 {
        eprintln!(
            "worldd: {back} stream objects whose delete was under way at the stop are queued for the store again"
        );
    }
    let known = confirmed.is_some();
    let confirmed = confirmed.flatten();
    let tried = std::fs::read(spool.dir.join(tried_key(&head_key)))
        .map(|b| unframe(&b))
        .unwrap_or_default();
    let worker = Worker {
        store,
        dir: spool.dir.clone(),
        prefix,
        head_key,
        identity: spool.store.clone(),
        progress: Arc::clone(&spool.progress),
        live: Arc::clone(&spool.live),
        confirmed,
        known,
        tried,
        moved: 0,
    };
    std::thread::Builder::new()
        .name("stream-backup".into())
        .spawn(move || worker.run(&woken, &*report))
        .map_err(super::io)?;
    Ok(())
}

/// [`requeue`] when the head confirmed (`found`, `head.confirmed`'s bytes) is another store's and this store's objects
/// were not queued yet (`head.requeued`); what it did, or none.
fn requeue_if_moved(
    dir: &Path,
    store: &str,
    found: Option<&[u8]>,
    head_key: &str,
    prefix: &str,
) -> Option<(u64, u64)> {
    let moved = found
        .and_then(|b| b.split(|c| *c == b'\n').next())
        .is_some_and(|s| s != store.as_bytes());
    let marker = dir.join(requeued_key(head_key));
    if !moved || std::fs::read(&marker).ok().as_deref() == Some(store.as_bytes()) {
        return None;
    }
    let done = requeue(dir, KEPT, prefix);
    // Best effort: without it a restart before the first head queues what was put again (the store keeps one copy).
    let _ = super::write_whole(&marker, store.as_bytes());
    Some(done)
}

/// The chain's objects kept on this disk under `from` (`kept/<prefix>objects/`, or `deleting/`) back in the spool's
/// queue (`<prefix>objects/`), for a store that may hold none of them: how many were queued, and how many could not be
/// (they stay where they are, and readable).
fn requeue(dir: &Path, from: &str, prefix: &str) -> (u64, u64) {
    let rel = format!("{prefix}objects");
    let Ok(entries) = std::fs::read_dir(dir.join(from).join(&rel)) else {
        return (0, 0);
    };
    let to = dir.join(&rel);
    let made = std::fs::create_dir_all(&to).is_ok();
    let (mut n, mut left) = (0, 0);
    for e in entries.flatten() {
        let name = e.file_name();
        let hex = name
            .to_str()
            .is_some_and(|n| n.len() == 64 && n.bytes().all(|b| b.is_ascii_hexdigit()));
        if !hex {
            continue;
        }
        if made && std::fs::rename(e.path(), to.join(&name)).is_ok() {
            n += 1;
        } else {
            left += 1;
        }
    }
    (n, left)
}

/// After a refused pass that put `moved` objects, with `stuck` refused passes before it in a row that put nothing: the
/// new count of those, and the wait before the next pass ([`BACKOFF_MS`]).
fn backoff(stuck: usize, moved: u64) -> (usize, u64) {
    let stuck = if moved > 0 { 0 } else { stuck + 1 };
    (
        stuck,
        BACKOFF_MS[stuck.saturating_sub(1).min(BACKOFF_MS.len() - 1)],
    )
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
    /// The store's identity, kept with the confirmed head.
    identity: String,
    progress: Arc<Progress>,
    /// The clean-up's names: an object it deleted while the chain came to name it again is put once more ([`Named`]).
    live: Live,
    /// The head this writer last knew the store to hold, and its ETag; none: the store had no head.
    confirmed: Option<(Vec<u8>, String)>,
    /// Whether `confirmed` is known (this store's, from the spool or this run); else learned at the first put.
    known: bool,
    /// Heads put since, whose answers were lost: if the store holds one, it is this writer's.
    tried: Vec<Vec<u8>>,
    /// Objects the current pass has put (or found there).
    moved: u64,
}

impl<S: ObjectStore> Worker<S> {
    #[allow(clippy::disallowed_methods)] // The backup's waits are real time, off the world's clock.
    fn run(mut self, woken: &Receiver<()>, report: &dyn Fn(State)) {
        let mut tries = 0u64;
        // Refused passes in a row that put nothing: the back-off's step.
        let mut stuck = 0usize;
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
                    stuck = 0;
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
                    let wait;
                    (stuck, wait) = backoff(stuck, self.moved);
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
        self.moved = 0;
        for key in self.objects() {
            let bytes = std::fs::read(self.dir.join(&key)).map_err(super::io)?;
            match self.store.put(&key, &bytes, When::Absent) {
                Ok(_) => {}
                // Its name is its hash: the object there is these bytes.
                Err(e) if e.name == "precondition-failed" => {}
                Err(e) => return Err(e.into()),
            }
            // In the store now, and named by the spool's head or the next: out of the queue at once, so a pass refused
            // later resumes from here rather than sending the whole spool again, and kept on this disk, where a restart
            // reads it.
            self.keep(&key);
            self.moved += 1;
        }
        let current = match head {
            Some(head) if self.confirmed.as_ref().map(|c| &c.0) != Some(&head) => {
                self.put_head(head)?
            }
            _ => true,
        };
        Ok(current)
    }

    fn kept(&self, key: &str) -> PathBuf {
        self.dir.join(KEPT).join(key)
    }

    /// Moves the spool's `key` into `kept/`; one that cannot be moved leaves the queue all the same. Under the
    /// clean-up's lock: one it deleted from the store meanwhile, which the chain names again, stays in the queue and is
    /// put once more, as this put may have landed before that delete.
    fn keep(&self, key: &str) {
        let mut named = named(&self.live);
        if named.resend.remove(key) {
            return;
        }
        let from = self.dir.join(key);
        let to = self.kept(key);
        let moved = to
            .parent()
            .is_some_and(|p| std::fs::create_dir_all(p).is_ok())
            && std::fs::rename(&from, &to).is_ok();
        if !moved {
            let _ = std::fs::remove_file(&from);
        }
    }

    /// Puts `head` over the confirmed one; whether the store holds it now.
    fn put_head(&mut self, head: Vec<u8>) -> Result<bool, Short> {
        if !self.known {
            self.reseed()?;
            if self.confirmed.as_ref().is_some_and(|c| c.0 == head) {
                return Ok(true);
            }
        }
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
            // No head there (a store emptied or moved): learned again, and created next pass.
            None => {
                if self.confirmed.is_some() {
                    eprintln!(
                        "worldd: the public stream's backup finds no head in the store; it writes its own"
                    );
                    self.confirm_absent()?;
                }
                Err(lost.into())
            }
            Some(_) => Err(Short::Fenced(format!(
                "stream-backup-fenced: the store's head {} is another writer's",
                self.head_key
            ))),
        }
    }

    /// The store's head learned again, as the store holds it now: a spool with no confirmed head (or one of another
    /// store) puts over what is there rather than fencing on it.
    fn reseed(&mut self) -> super::R<()> {
        match self.store.get(&self.head_key)? {
            Some(o) => self.confirm(o.bytes, o.etag)?,
            None => self.confirm_absent()?,
        }
        eprintln!("worldd: the public stream's backup learned the store's head again");
        self.known = true;
        Ok(())
    }

    fn confirm(&mut self, head: Vec<u8>, etag: String) -> super::R<()> {
        confirm(&self.dir, &self.identity, &self.head_key, &head, &etag)?;
        self.tried.clear();
        self.confirmed = Some((head, etag));
        Ok(())
    }

    fn confirm_absent(&mut self) -> super::R<()> {
        confirm(&self.dir, &self.identity, &self.head_key, &[], "")?;
        self.tried.clear();
        self.confirmed = None;
        Ok(())
    }
}

/// What the clean-up has to do, each in its generation (numbered in the order handed over, oldest first): an old
/// generation's record to read (with the objects the chain then named, never deleted), one of its objects to delete,
/// or the record itself to delete once nothing of its generation or an older one waits. A restart finds an object only
/// through its record, and a record only through every newer one (each names the one before).
enum Job {
    Record(String, BTreeSet<Vec<u8>>, u64),
    Object(String, u64),
    Drop(String, u64),
}

impl Job {
    #[cfg(test)]
    fn key(&self) -> &str {
        match self {
            Job::Record(k, _, _) | Job::Object(k, _) | Job::Drop(k, _) => k,
        }
    }

    fn generation(&self) -> u64 {
        match self {
            Job::Record(_, _, g) | Job::Object(_, g) | Job::Drop(_, g) => *g,
        }
    }
}

/// What one job came to.
enum Step {
    /// Read, or gone already.
    Next,
    Deleted,
    /// Named by the current chain: never deleted.
    Live,
    /// A record whose objects wait: behind them in line (none of them waits its back-off), or until the last does.
    Behind,
    After(Instant),
    /// The store may not hold the current chain's head yet: nothing is deleted until it does.
    Wait,
    Refused(super::Refusal),
}

/// Old generations' chains off the store (#3833) and off `kept/`, on the clean-up's own thread with its own client
/// (#4954). A refused read or delete is tried again after its own back-off ([`BACKOFF_MS`]), longer at each refusal in
/// a row, while the rest go on.
struct Cleanup<S> {
    store: S,
    dir: PathBuf,
    prunes: Prunes,
    live: Live,
    /// The backup's: the clean-up deletes only once a pass begun after the chain was last handed over has left the
    /// store holding the spool's head ([`Named::handed_at`]), so never an object of the chain the store's head names
    /// (a backup behind, or still putting a new generation's seed, names an older one) nor, fenced, another writer's.
    progress: Arc<Progress>,
    /// What waits its turn, oldest generation first, each with its refusals in a row so far.
    due: std::collections::VecDeque<(u32, Job)>,
    /// What waits its time: refused (with its refusals in a row), or a record behind its refused objects.
    later: Vec<(Instant, u32, Job)>,
    deleted: u64,
    refused: u64,
    /// Objects found named by the current chain, so not deleted.
    kept_live: u64,
    /// Generations taken so far: the next one's number.
    generations: u64,
}

impl<S: ObjectStore> Cleanup<S> {
    fn new(
        store: S,
        dir: PathBuf,
        prunes: Prunes,
        live: Live,
        progress: Arc<Progress>,
    ) -> Cleanup<S> {
        Cleanup {
            store,
            dir,
            prunes,
            live,
            progress,
            due: std::collections::VecDeque::new(),
            later: Vec::new(),
            deleted: 0,
            refused: 0,
            kept_live: 0,
            generations: 0,
        }
    }

    #[allow(clippy::disallowed_methods)] // The clean-up's waits are real time, off the world's clock.
    fn run(mut self, woken: &Receiver<()>) {
        // Passes in a row that were refused and deleted nothing: the back-off's step.
        let mut stuck = 0usize;
        loop {
            let (done, fault) = if self.open() {
                self.pass(Instant::now())
            } else {
                (0, None)
            };
            self.gauge();
            let wait = match fault {
                Some(fault) => {
                    let wait;
                    (stuck, wait) = backoff(stuck, done);
                    eprintln!(
                        "worldd: the stream's clean-up was refused, viewers unaffected: {fault}; {} to delete wait, {} of them to try again, the next pass in {wait} ms",
                        self.due.len() + self.later.len(),
                        self.later.len()
                    );
                    wait
                }
                None => {
                    stuck = 0;
                    // More waiting: on at once, at the store's pace; else when told, or a second on.
                    if done == 0 || self.due.is_empty() {
                        1_000
                    } else {
                        0
                    }
                }
            };
            let gone = if wait == 0 {
                matches!(
                    woken.try_recv(),
                    Err(std::sync::mpsc::TryRecvError::Disconnected)
                )
            } else {
                matches!(
                    woken.recv_timeout(Duration::from_millis(wait)),
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
                )
            };
            if gone {
                // The writer is gone, and the world with it.
                return;
            }
        }
    }

    /// Whether the store holds the current chain's head: else nothing is read or deleted, and the generations handed
    /// over wait where they are held.
    fn open(&self) -> bool {
        self.live
            .lock()
            .is_ok_and(|n| self.progress.past(n.handed_at))
    }

    /// How the clean-up stands, in `health.json` (`stream_cleanup`): old generations not read yet (held, or in line),
    /// each standing for its objects; the deletes in line; and those of them tried again after a refusal.
    fn gauge(&self) {
        let held = self.prunes.lock().map_or(0, |h| h.records.len());
        let jobs = self
            .due
            .iter()
            .map(|(n, j)| (*n, j))
            .chain(self.later.iter().map(|(_, n, j)| (*n, j)));
        let (mut unread, mut deletes, mut retrying) = (0u64, 0u64, 0u64);
        for (n, j) in jobs {
            if matches!(j, Job::Record(..)) {
                unread += 1;
            } else {
                deletes += 1;
                retrying += u64::from(n > 0);
            }
        }
        crate::measures::CLEANUP.set(
            held as u64 + unread,
            deletes,
            retrying,
            self.deleted,
            self.refused,
        );
    }

    fn kept(&self, key: &str) -> PathBuf {
        self.dir.join(KEPT).join(key)
    }

    /// Up to [`DELETES_PER_PASS`] reads and deletes at `now`; the deletes it made, and the refusal that ended it.
    fn pass(&mut self, now: Instant) -> (u64, Option<String>) {
        if let Ok(mut held) = self.prunes.lock() {
            for (key, live) in held.records.drain(..) {
                self.due
                    .push_back((0, Job::Record(key, live, self.generations)));
                self.generations += 1;
            }
        }
        // What has waited its time goes back in line, behind the rest.
        let (again, wait): (Vec<_>, Vec<_>) = std::mem::take(&mut self.later)
            .into_iter()
            .partition(|(at, _, _)| *at <= now);
        self.later = wait;
        self.due
            .extend(again.into_iter().map(|(_, tries, job)| (tries, job)));
        let mut done = 0u64;
        for _ in 0..DELETES_PER_PASS {
            let Some((tries, job)) = self.due.pop_front() else {
                break;
            };
            let step = match &job {
                // This disk's copy first: the store is read only for a record this machine never held.
                Job::Record(key, live, g) => match std::fs::read(self.kept(key)) {
                    Ok(b) => {
                        self.expand(key, &b, live, *g);
                        Step::Next
                    }
                    Err(_) => match self.store.get(key) {
                        Ok(Some(o)) => {
                            self.expand(key, &o.bytes, live, *g);
                            Step::Next
                        }
                        // Gone already.
                        Ok(None) => Step::Next,
                        Err(e) => Step::Refused(e),
                    },
                },
                Job::Drop(key, g) => self.older(*g).unwrap_or_else(|| self.delete(key)),
                Job::Object(key, _) => self.delete(key),
            };
            match step {
                Step::Next => {}
                Step::Deleted => {
                    self.deleted += 1;
                    done += 1;
                }
                Step::Live => self.kept_live += 1,
                Step::Behind => self.due.push_back((tries, job)),
                Step::After(at) => self.later.push((at, tries, job)),
                Step::Wait => {
                    self.due.push_front((tries, job));
                    return (done, None);
                }
                Step::Refused(e) => {
                    // Skipped and tried again after its own back-off. The pass ends here, so a store out of reach is
                    // asked once a pass, not once an object.
                    self.refused += 1;
                    let wait = BACKOFF_MS[(tries as usize).min(BACKOFF_MS.len() - 1)];
                    self.later
                        .push((now + Duration::from_millis(wait), tries + 1, job));
                    return (done, Some(format!("{}: {}", e.name, e.detail)));
                }
            }
        }
        (done, None)
    }

    /// Where jobs of generation `g` or an older one still wait, for its record: in line ([`Step::Behind`]), or their
    /// back-off ([`Step::After`] the last).
    fn older(&self, g: u64) -> Option<Step> {
        let after = self
            .later
            .iter()
            .filter(|(_, _, j)| j.generation() <= g)
            .map(|(at, _, _)| *at)
            .max();
        match after {
            Some(at) => Some(Step::After(at)),
            None => self
                .due
                .iter()
                .any(|(_, j)| j.generation() <= g)
                .then_some(Step::Behind),
        }
    }

    /// Deletes `key` from the store, unless the current chain names it or the store may not hold that chain's head yet,
    /// then settles its copy on this disk ([`Cleanup::settle`]). Asked under the lock the writer names an object under.
    fn delete(&self, key: &str) -> Step {
        {
            // A poisoned lock: deleting nothing is the safe side.
            let Ok(named) = self.live.lock() else {
                return Step::Live;
            };
            if named.names(key) {
                return Step::Live;
            }
            if !self.progress.past(named.handed_at) {
                return Step::Wait;
            }
            // Before the delete is sent: a stop before it is settled leaves no copy saying the store holds it.
            let doomed = self.dir.join(DELETING).join(key);
            if doomed
                .parent()
                .is_some_and(|p| std::fs::create_dir_all(p).is_ok())
            {
                let _ = std::fs::rename(self.kept(key), &doomed);
            }
        }
        let deleted = self.store.delete(key);
        self.settle(key);
        match deleted {
            Ok(()) => Step::Deleted,
            Err(e) => Step::Refused(e),
        }
    }

    /// After `key`'s delete, answered or not, under the lock the writer names an object under: its copies on this disk
    /// go. Unless a chain the store's head may name came to name it meanwhile (a words file repeats across
    /// generations): then the writer found no copy and spooled it, and the backup may have put it before the delete
    /// landed, or the old chain's last head named it. Either way the store may lack it, so it goes back in the spool's
    /// queue and the backup puts it once more before it keeps it.
    fn settle(&self, key: &str) {
        let mut named = named(&self.live);
        let doomed = self.dir.join(DELETING).join(key);
        let kept = self.kept(key);
        if !named.wants(key, &self.progress) {
            let _ = std::fs::remove_file(&doomed);
            let _ = std::fs::remove_file(&kept);
            return;
        }
        let queued = self.dir.join(key);
        if !queued.is_file()
            && queued
                .parent()
                .is_some_and(|p| std::fs::create_dir_all(p).is_ok())
        {
            let _ = std::fs::rename(&doomed, &queued).or_else(|_| std::fs::rename(&kept, &queued));
        }
        let _ = std::fs::remove_file(&doomed);
        named.resend.insert(key.to_owned());
    }

    /// An old generation's record read: its objects the chain then did not name, then the record, first in line.
    fn expand(&mut self, record_key: &str, bytes: &[u8], live: &BTreeSet<Vec<u8>>, g: u64) {
        let Ok(r) = super::object_map(bytes) else {
            return;
        };
        let prefix = record_key.rsplit_once("objects/").map_or("", |(p, _)| p);
        let mut jobs = Vec::new();
        if let Some(replica::encode::Value::Array(objects)) = r.get(&3) {
            for o in objects {
                if let replica::encode::Value::Bytes(h) = o
                    && !live.contains(h)
                {
                    jobs.push(Job::Object(format!("{prefix}objects/{}", to_hex(h)), g));
                }
            }
        }
        jobs.push(Job::Drop(record_key.to_owned(), g));
        for job in jobs.into_iter().rev() {
            self.due.push_front((0, job));
        }
    }
}

/// The spool beside a world's `views/`: never under it, as the chunks hold the world's own records.
pub fn beside(views: &Path) -> PathBuf {
    views.with_file_name("stream-backup")
}

#[cfg(test)]
mod tests {
    use super::*;
    use directoryd::directory::store::{Memory, Object, R};
    use std::cell::{Cell, RefCell};

    /// A store that keeps the keys put to it and does not answer the `refuse`th put.
    struct Counting {
        store: Memory,
        puts: Cell<usize>,
        refuse: usize,
        sent: RefCell<Vec<String>>,
    }

    impl ObjectStore for Counting {
        fn get(&self, key: &str) -> R<Option<Object>> {
            self.store.get(key)
        }
        fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
            self.puts.set(self.puts.get() + 1);
            if self.puts.get() == self.refuse {
                return Err(super::super::Refusal {
                    name: "store-unreachable",
                    detail: format!("{key}: timeout: receive response"),
                });
            }
            self.sent.borrow_mut().push(key.to_owned());
            self.store.put(key, bytes, when)
        }
        fn list(&self, prefix: &str) -> R<Vec<String>> {
            self.store.list(prefix)
        }
    }

    /// Eden, 24 Nov: a backup 14,101 objects (690 MB) behind sent its whole spool again on every pass, and each pass
    /// was refused on one unanswered put before it reached the head, so it never caught up. A refused pass now leaves
    /// off the spool what the store already holds: the next sends each object left once, and the head after them.
    #[test]
    fn a_refused_pass_resumes_where_it_stopped_and_sends_nothing_twice() {
        let dir = std::env::temp_dir().join(format!("backup-resumes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let spool = Spool::new(dir.clone(), "test-store".into());
        let prefix = "s/w/".to_owned();
        for i in 0..10u8 {
            let bytes = vec![i; 1000];
            let key = format!("{prefix}objects/{}", to_hex(&replica::ids::sha256(&bytes)));
            spool.object(&key, &bytes).unwrap();
        }
        spool.write(&format!("{prefix}head"), b"head one").unwrap();
        let store = Counting {
            store: Memory::default(),
            puts: Cell::new(0),
            refuse: 6,
            sent: RefCell::default(),
        };
        let mut worker = Worker {
            store,
            dir: dir.clone(),
            prefix: prefix.clone(),
            head_key: format!("{prefix}head"),
            identity: "test-store".into(),
            progress: Arc::default(),
            live: Arc::default(),
            confirmed: None,
            known: true,
            tried: Vec::new(),
            moved: 0,
        };
        assert!(worker.pass().is_err(), "the sixth put is not answered");
        assert_eq!(
            worker.objects().len(),
            5,
            "the five the store holds are off the spool"
        );
        assert_eq!(worker.moved, 5, "the refused pass put five");
        assert!(
            matches!(worker.pass(), Ok(true)),
            "the next pass is current"
        );
        let sent = worker.store.sent.borrow().clone();
        let objects: Vec<&String> = sent.iter().filter(|k| k.contains("/objects/")).collect();
        let unique: BTreeSet<&String> = objects.iter().copied().collect();
        assert_eq!(objects.len(), 10, "each object sent once: {sent:?}");
        assert_eq!(unique.len(), 10);
        assert_eq!(sent.last().map(String::as_str), Some("s/w/head"));
        assert!(worker.objects().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// soul.game's store move (25 Nov 2026): a spool whose confirmed head is another store's queues every kept object
    /// again, once: a restart before the first head lands in the new store queues none twice, and a spool of the same
    /// store (a normal restart) or with no confirmed head queues nothing.
    #[test]
    fn a_moved_store_queues_the_kept_chain_again_once() {
        let dir = std::env::temp_dir().join(format!("backup-requeue-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let prefix = "s/w/";
        let head_key = format!("{prefix}head");
        let spool = Spool::new(dir.clone(), "new".into());
        spool.write(&head_key, b"head").unwrap();
        for i in 0..3u8 {
            let key = format!("{prefix}objects/{}", to_hex(&replica::ids::sha256(&[i])));
            spool.keep(&key, &[i]);
        }
        let queue = dir.join(format!("{prefix}objects"));
        let count = |d: &Path| std::fs::read_dir(d).map_or(0, |e| e.count());
        let kept = dir.join(KEPT).join(format!("{prefix}objects"));
        let at = |id: &str| format!("{id}\netag\nhead").into_bytes();
        assert_eq!(
            requeue_if_moved(&dir, "new", None, &head_key, prefix),
            None,
            "no confirmed head"
        );
        assert_eq!(
            requeue_if_moved(&dir, "new", Some(&at("new")), &head_key, prefix),
            None,
            "same store"
        );
        assert_eq!(count(&queue), 0);
        assert_eq!(
            requeue_if_moved(&dir, "new", Some(&at("old")), &head_key, prefix),
            Some((3, 0)),
            "moved: every kept object queued"
        );
        assert_eq!((count(&queue), count(&kept)), (3, 0));
        // Put to the new store and kept again, then a restart before its head lands there.
        for e in std::fs::read_dir(&queue).unwrap().flatten() {
            std::fs::rename(e.path(), kept.join(e.file_name())).unwrap();
        }
        assert_eq!(
            requeue_if_moved(&dir, "new", Some(&at("old")), &head_key, prefix),
            None
        );
        assert_eq!((count(&queue), count(&kept)), (0, 3));
        // A later move again (to a third store) queues them for it.
        assert_eq!(
            requeue_if_moved(&dir, "third", Some(&at("new")), &head_key, prefix),
            Some((3, 0))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Eden, 25 Nov: 20,702 objects (870 MB) behind, 67 refused passes in a row, the next a minute after each, though
    /// every pass put objects before one went unanswered. A refused pass that put objects waits the shortest step
    /// again; passes that put nothing back off 1, 2, 4 … 60 s as before.
    #[test]
    fn a_refused_pass_that_put_objects_waits_the_shortest_step_again() {
        let mut stuck = 0;
        let mut waits = Vec::new();
        for _ in 0..8 {
            let wait;
            (stuck, wait) = backoff(stuck, 0);
            waits.push(wait);
        }
        assert_eq!(
            waits,
            [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]
        );
        assert_eq!(
            backoff(stuck, 300),
            (0, 1_000),
            "it put 300: the store answers"
        );
        assert_eq!(backoff(0, 0), (1, 1_000));
        assert_eq!(backoff(1, 0), (2, 2_000));
    }

    /// A store that does not answer every `every`th delete.
    struct Flaky {
        store: Memory,
        deletes: Cell<usize>,
        every: usize,
    }

    impl ObjectStore for Flaky {
        fn get(&self, key: &str) -> R<Option<Object>> {
            self.store.get(key)
        }
        fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
            self.store.put(key, bytes, when)
        }
        fn list(&self, prefix: &str) -> R<Vec<String>> {
            self.store.list(prefix)
        }
        fn delete(&self, key: &str) -> R<()> {
            self.deletes.set(self.deletes.get() + 1);
            if self.deletes.get().is_multiple_of(self.every) {
                return Err(super::super::Refusal {
                    name: "store-unreachable",
                    detail: format!("{key}: timeout: receive response"),
                });
            }
            self.store.delete(key)
        }
    }

    /// An old generation in `store`: its objects, and its record naming them; the record's key.
    fn generation<S: ObjectStore>(store: &S, prefix: &str, g: u8, objects: &[Vec<u8>]) -> String {
        use replica::encode::Value;
        let key = |b: &[u8]| format!("{prefix}objects/{}", to_hex(&replica::ids::sha256(b)));
        for o in objects {
            store.put(&key(o), o, When::Absent).unwrap();
        }
        let record = super::super::wire(Value::Map(std::collections::BTreeMap::from([
            (1, Value::Bytes(Vec::new())),
            (2, Value::Uint(u64::from(g))),
            (
                3,
                Value::Array(
                    objects
                        .iter()
                        .map(|o| Value::Bytes(replica::ids::sha256(o).to_vec()))
                        .collect(),
                ),
            ),
        ])))
        .unwrap();
        store.put(&key(&record), &record, When::Absent).unwrap();
        key(&record)
    }

    /// Eden, 26 Nov (#4954): one refused delete switched the clean-up off until the world restarted, and the store kept
    /// 35,257 stream objects against about 1,300 live. Against a store that does not answer every third delete, the
    /// clean-up goes on past each refusal, tries the refused one again after its back-off, and catches up; an object
    /// the current chain names (handed over, or written to the spool since) is never deleted.
    #[test]
    #[allow(clippy::disallowed_methods)] // The clean-up's back-off is real time; the test moves it on by hand.
    fn refused_deletes_are_tried_again_and_the_clean_up_catches_up() {
        let dir = std::env::temp_dir().join(format!("backup-cleanup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let prefix = "s/w/";
        let key = |b: &[u8]| format!("{prefix}objects/{}", to_hex(&replica::ids::sha256(b)));
        let spool = Spool::new(dir.clone(), "test-store".into());
        let store = Flaky {
            store: Memory::default(),
            deletes: Cell::new(0),
            every: 3,
        };
        // Three old generations of 40 objects; the first also names an object the current chain names (handed over),
        // the second one the chain names later (written to the spool after the hand-over).
        let (handed, later) = (b"handed".to_vec(), b"later".to_vec());
        let mut records = Vec::new();
        for g in 0..3u8 {
            let mut objects: Vec<Vec<u8>> = (0..40u8).map(|i| vec![g, i]).collect();
            match g {
                0 => objects.push(handed.clone()),
                1 => objects.push(later.clone()),
                _ => {}
            }
            records.push(generation(&store.store, prefix, g, &objects));
        }
        spool.live([key(&handed)].into());
        // A backup pass begun after the hand-over left the store holding the spool's head.
        spool.progress.passes.store(2, Ordering::Release);
        spool.progress.current.store(true, Ordering::Release);
        for r in &records {
            // No live set with the prune: the check at each delete alone keeps the chain's objects.
            spool.prune(r.clone(), BTreeSet::new());
        }
        spool.object(&key(&later), &later).unwrap();
        let mut cleanup = Cleanup::new(
            store,
            dir.clone(),
            Arc::clone(&spool.prunes),
            Arc::clone(&spool.live),
            Arc::clone(&spool.progress),
        );
        let mut now = Instant::now();
        let (mut passes, mut refused_passes, mut deleted_after_refusal) = (0, 0, 0);
        loop {
            let (done, fault) = cleanup.pass(now);
            passes += 1;
            if refused_passes > 0 {
                deleted_after_refusal += done;
            }
            if fault.is_some() {
                refused_passes += 1;
            }
            if cleanup.due.is_empty() && cleanup.later.is_empty() || passes > 500 {
                break;
            }
            // Past the longest back-off: whatever was refused is due again.
            now += Duration::from_secs(61);
        }
        assert!(
            cleanup.due.is_empty() && cleanup.later.is_empty(),
            "caught up in {passes} passes"
        );
        assert!(refused_passes > 10, "{refused_passes} refused passes");
        assert!(deleted_after_refusal > 100, "{deleted_after_refusal}");
        assert_eq!(
            cleanup.deleted,
            3 * 41,
            "every old object and record, once each"
        );
        assert_eq!(cleanup.refused, refused_passes);
        assert_eq!(cleanup.kept_live, 2);
        let mut left = cleanup.store.store.list("").unwrap();
        left.sort();
        let mut live = vec![key(&handed), key(&later)];
        live.sort();
        assert_eq!(left, live, "only the current chain's objects are left");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A store whose deletes each say they began (`began`), then wait until the test lets them go (`go` sent or
    /// dropped).
    struct Slow {
        store: Memory,
        began: std::sync::mpsc::Sender<()>,
        go: std::sync::mpsc::Receiver<()>,
    }

    impl ObjectStore for Slow {
        fn get(&self, key: &str) -> R<Option<Object>> {
            self.store.get(key)
        }
        fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
            self.store.put(key, bytes, when)
        }
        fn delete(&self, key: &str) -> R<()> {
            let _ = self.began.send(());
            let _ = self.go.recv();
            self.store.delete(key)
        }
    }

    /// #4954: the clean-up runs on its own thread with its own client. A delete that does not return holds back no
    /// put: with one under way, the backup still puts a new part and head and holds them.
    #[test]
    fn slow_deletes_hold_back_no_put() {
        let dir = std::env::temp_dir().join(format!("backup-slow-cleanup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let prefix = "s/w/";
        let mut spool = Spool::new(dir.clone(), "test-store".into());
        let (began, delete_began) = std::sync::mpsc::channel();
        let (go, wait) = std::sync::mpsc::channel();
        let old = Slow {
            store: Memory::default(),
            began,
            go: wait,
        };
        let objects: Vec<Vec<u8>> = (0..5u8).map(|i| vec![9, i]).collect();
        let record = generation(&old.store, prefix, 9, &objects);
        start(
            &mut spool,
            Memory::default(),
            old,
            prefix.to_owned(),
            Box::new(|_| {}),
        )
        .unwrap();
        spool.prune(record, BTreeSet::new());
        // The clean-up may delete once the backup has made two passes; the first delete then begins, and waits.
        spool.poke();
        assert!(
            delete_began.recv_timeout(Duration::from_secs(20)).is_ok(),
            "a delete is under way"
        );
        let new = b"new part".to_vec();
        let key = format!("{prefix}objects/{}", to_hex(&replica::ids::sha256(&new)));
        spool.object(&key, &new).unwrap();
        spool.head(&format!("{prefix}head"), b"head").unwrap();
        assert!(
            spool.drainer().unwrap().drain(Duration::from_secs(20)),
            "the backup holds the head while the delete is under way"
        );
        assert!(
            delete_began.try_recv().is_err(),
            "the first delete has not returned"
        );
        drop(go);
        drop(spool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A client of a shared store that calls `before_delete` with each key it is about to delete and `after_put` with
    /// each it has put: where another thread's steps fall between two of the caller's, without a sleep.
    struct Hooked<'a> {
        store: &'a Memory,
        before_delete: Box<dyn Fn(&str) + 'a>,
        after_put: Box<dyn Fn(&str) + 'a>,
    }

    impl ObjectStore for Hooked<'_> {
        fn get(&self, key: &str) -> R<Option<Object>> {
            self.store.get(key)
        }
        fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
            let put = self.store.put(key, bytes, when);
            (self.after_put)(key);
            put
        }
        fn list(&self, prefix: &str) -> R<Vec<String>> {
            self.store.list(prefix)
        }
        fn delete(&self, key: &str) -> R<()> {
            (self.before_delete)(key);
            self.store.delete(key)
        }
    }

    fn worker<S: ObjectStore>(spool: &Spool, store: S, prefix: &str) -> Worker<S> {
        Worker {
            store,
            dir: spool.dir.clone(),
            prefix: prefix.to_owned(),
            head_key: format!("{prefix}head"),
            identity: "test-store".into(),
            progress: Arc::clone(&spool.progress),
            live: Arc::clone(&spool.live),
            confirmed: None,
            known: true,
            tried: Vec::new(),
            moved: 0,
        }
    }

    fn cleanup<S: ObjectStore>(spool: &Spool, store: S) -> Cleanup<S> {
        Cleanup::new(
            store,
            spool.dir.clone(),
            Arc::clone(&spool.prunes),
            Arc::clone(&spool.live),
            Arc::clone(&spool.progress),
        )
    }

    /// The clean-up may delete: a backup pass begun after the last hand-over left the store holding the spool's head.
    fn backed_up(spool: &Spool) {
        let n = spool.live.lock().unwrap().handed_at;
        spool.progress.passes.store(n + 2, Ordering::Release);
        spool.progress.current.store(true, Ordering::Release);
    }

    const WORDS: &[u8] = b"the words of a part, as an old generation's";

    /// A spool and a store holding an old generation that names [`WORDS`] and one other object: its record's key, the
    /// words' key and the other's.
    fn old_words(name: &str) -> (PathBuf, Spool, Memory, [String; 3]) {
        let dir = std::env::temp_dir().join(format!("backup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let spool = Spool::new(dir.clone(), "test-store".into());
        let store = Memory::default();
        let other = b"other".to_vec();
        let record = generation(&store, "s/w/", 0, &[WORDS.to_vec(), other.clone()]);
        let key = |b: &[u8]| format!("s/w/objects/{}", to_hex(&replica::ids::sha256(b)));
        (dir, spool, store, [record, key(WORDS), key(&other)])
    }

    /// Review of #4990, blocking 1: words files repeat across generations. The clean-up found an old generation's copy
    /// unnamed; the writer, naming it again for a new part, found the copy kept on this disk and spooled nothing; the
    /// clean-up then removed that copy and deleted the store's. The head named an object in no store (and on no disk),
    /// and a restart failed `stream-recovery-missing`. Here the writer names it and the backup makes a pass between the
    /// clean-up's check and its delete landing, with the copy kept on this disk or in the store only (a chain another
    /// machine wrote): the store holds it again after the backup's next passes, and this disk holds it throughout.
    #[test]
    #[allow(clippy::disallowed_methods)] // The passes are driven by hand.
    fn an_object_named_again_during_its_delete_is_put_again() {
        for kept in [true, false] {
            let (dir, spool, store, [record, words, other]) =
                old_words(&format!("named-again-{kept}"));
            if kept {
                spool.keep(&words, WORDS);
            }
            spool.live(BTreeSet::new());
            backed_up(&spool);
            spool.prune(record.clone(), BTreeSet::new());
            let backup = RefCell::new(worker(&spool, &store, "s/w/"));
            let mut cleanup = cleanup(
                &spool,
                Hooked {
                    store: &store,
                    before_delete: Box::new(|key: &str| {
                        if key == words {
                            spool.object(&words, WORDS).unwrap();
                            assert!(matches!(backup.borrow_mut().pass(), Ok(true)));
                        }
                    }),
                    after_put: Box::new(|_: &str| {}),
                },
            );
            // The first pass takes the generation handed over; it is caught up when nothing is left in line.
            loop {
                assert_eq!(cleanup.pass(Instant::now()).1, None);
                if cleanup.due.is_empty() {
                    break;
                }
            }
            assert_eq!(
                cleanup.deleted, 3,
                "kept {kept}: the words, the other object and the record"
            );
            assert!(
                store.get(&words).unwrap().is_none(),
                "kept {kept}: the delete landed after the writer named it"
            );
            assert_eq!(
                spool.read(&words).as_deref(),
                Some(WORDS),
                "kept {kept}: this disk holds it"
            );
            for _ in 0..2 {
                assert!(matches!(backup.borrow_mut().pass(), Ok(true)));
            }
            assert!(
                store.get(&words).unwrap().is_some(),
                "kept {kept}: the store holds it again"
            );
            assert!(
                backup.borrow().objects().is_empty(),
                "kept {kept}: nothing left to put"
            );
            assert_eq!(spool.read(&words).as_deref(), Some(WORDS));
            assert!(store.get(&other).unwrap().is_none() && store.get(&record).unwrap().is_none());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// Review of #4990, blocking 1, the backup's side: an object written for a part and left unnamed by the hand-over
    /// after it waits in the spool's queue. The backup puts it; before the backup keeps it, the clean-up deletes it while
    /// the writer names it again (finding it queued, so writing nothing). Keeping it then would leave the store without
    /// it for good: it stays queued and is put once more.
    #[test]
    #[allow(clippy::disallowed_methods)] // The passes are driven by hand.
    fn a_put_that_lands_before_the_delete_is_made_again() {
        let (dir, spool, store, [record, words, _]) = old_words("put-before-delete");
        spool.object(&words, WORDS).unwrap();
        spool.live(BTreeSet::new());
        backed_up(&spool);
        spool.prune(record, BTreeSet::new());
        let cleanup = RefCell::new(cleanup(
            &spool,
            Hooked {
                store: &store,
                before_delete: Box::new(|key: &str| {
                    if key == words {
                        spool.object(&words, WORDS).unwrap();
                    }
                }),
                after_put: Box::new(|_: &str| {}),
            },
        ));
        let ran = Cell::new(false);
        let mut backup = worker(
            &spool,
            Hooked {
                store: &store,
                before_delete: Box::new(|_: &str| {}),
                after_put: Box::new(|key: &str| {
                    if key == words && !ran.replace(true) {
                        assert_eq!(cleanup.borrow_mut().pass(Instant::now()).1, None);
                    }
                }),
            },
            "s/w/",
        );
        assert!(matches!(backup.pass(), Ok(true)));
        assert!(ran.get() && cleanup.borrow().deleted == 3);
        assert!(
            store.get(&words).unwrap().is_none(),
            "the delete landed after the put"
        );
        assert_eq!(
            backup.objects(),
            std::slice::from_ref(&words),
            "still queued"
        );
        assert!(matches!(backup.pass(), Ok(true)));
        assert!(
            store.get(&words).unwrap().is_some(),
            "the store holds it again"
        );
        assert!(backup.objects().is_empty());
        assert_eq!(spool.read(&words).as_deref(), Some(WORDS));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Review of #4990, blocking 2: the clean-up's gate was the last backup pass's answer, while the chain it checks
    /// against is the new generation's from the rollover on. With the backup still putting the new generation's seed,
    /// the store's head named the old chain, yet what the oldest generation shared with it was deleted, and a new machine
    /// could not recover meanwhile. Nothing is deleted now until a pass begun after the hand-over has left the store
    /// holding the new head.
    #[test]
    #[allow(clippy::disallowed_methods)] // The passes are driven by hand.
    fn the_clean_up_waits_for_the_store_to_hold_the_new_chain() {
        let (dir, spool, store, [record, shared, _]) = old_words("new-chain");
        // Generation 1's chain names the words too; the store holds its head.
        spool.progress.passes.store(3, Ordering::Release);
        spool.live([shared.clone()].into());
        spool.progress.passes.store(5, Ordering::Release);
        spool.progress.current.store(true, Ordering::Release);
        // The rollover: generation 2's chain is handed over (its head in the spool), and the oldest generation pruned.
        spool.live(["s/w/objects/g2".to_owned()].into());
        spool.prune(record, BTreeSet::new());
        let mut cleanup = cleanup(&spool, &store);
        let before = store.list("").unwrap();
        for (passes, current, what) in [
            (5, true, "no pass since"),
            (
                6,
                true,
                "the pass under way at the rollover, begun with the old head",
            ),
            (7, false, "a pass begun after, refused"),
        ] {
            spool.progress.passes.store(passes, Ordering::Release);
            spool.progress.current.store(current, Ordering::Release);
            assert!(!cleanup.open(), "{what}");
            assert_eq!(cleanup.pass(Instant::now()), (0, None), "{what}");
            assert_eq!(store.list("").unwrap(), before, "{what}: nothing deleted");
        }
        spool.progress.passes.store(8, Ordering::Release);
        spool.progress.current.store(true, Ordering::Release);
        assert!(cleanup.open());
        while !cleanup.due.is_empty() {
            assert_eq!(cleanup.pass(Instant::now()).1, None);
        }
        assert_eq!(cleanup.deleted, 3);
        assert!(
            store.list("").unwrap().is_empty(),
            "the old generation is gone"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A store that refuses the first `times` deletes of each of `keys`, and lists the deletes it made.
    struct Refusing {
        store: Memory,
        keys: Vec<String>,
        times: u32,
        tries: RefCell<std::collections::BTreeMap<String, u32>>,
        made: RefCell<Vec<String>>,
    }

    impl ObjectStore for Refusing {
        fn get(&self, key: &str) -> R<Option<Object>> {
            self.store.get(key)
        }
        fn put(&self, key: &str, bytes: &[u8], when: When) -> R<String> {
            self.store.put(key, bytes, when)
        }
        fn delete(&self, key: &str) -> R<()> {
            if self.keys.iter().any(|k| k == key) {
                let mut tries = self.tries.borrow_mut();
                let n = tries.entry(key.to_owned()).or_default();
                *n += 1;
                if *n <= self.times {
                    return Err(super::super::Refusal {
                        name: "store-unreachable",
                        detail: format!("{key}: timeout: receive response"),
                    });
                }
            }
            self.made.borrow_mut().push(key.to_owned());
            self.store.delete(key)
        }
    }

    /// Review of #4990, non-blocking 4: a refused object's back-off began again at 1 s whenever it came back behind other
    /// work, and its generation's record was deleted before it, so a restart found nothing naming it and it stayed in the
    /// store for good. Each refusal in a row now waits longer, for each object on its own, and a record waits for its
    /// objects.
    #[test]
    #[allow(clippy::disallowed_methods)] // The back-off is real time; the test moves it on by hand.
    fn a_refused_object_backs_off_longer_and_its_record_waits_for_it() {
        let dir = std::env::temp_dir().join(format!("backup-record-last-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let spool = Spool::new(dir.clone(), "test-store".into());
        let key = |b: &[u8]| format!("s/w/objects/{}", to_hex(&replica::ids::sha256(b)));
        let (x, y, z) = (b"x".to_vec(), b"y".to_vec(), b"z".to_vec());
        let store = Refusing {
            store: Memory::default(),
            keys: vec![key(&x), key(&y)],
            times: 3,
            tries: RefCell::default(),
            made: RefCell::default(),
        };
        let record = generation(&store.store, "s/w/", 0, &[x.clone(), y.clone(), z.clone()]);
        backed_up(&spool);
        spool.prune(record.clone(), BTreeSet::new());
        let mut cleanup = cleanup(&spool, store);
        let mut now = Instant::now();
        let mut waits: std::collections::BTreeMap<String, Vec<u64>> = Default::default();
        for _ in 0..100 {
            if cleanup.pass(now).1.is_some() {
                let (at, _, job) = cleanup.later.last().unwrap();
                waits
                    .entry(job.key().to_owned())
                    .or_default()
                    .push((*at - now).as_secs());
                continue;
            }
            if cleanup.due.is_empty() {
                match cleanup.later.iter().map(|(at, _, _)| *at).min() {
                    Some(at) => now = at,
                    None => break,
                }
            }
        }
        assert!(cleanup.due.is_empty() && cleanup.later.is_empty());
        assert_eq!(waits.get(&key(&x)).map(Vec::as_slice), Some(&[1, 2, 4][..]));
        assert_eq!(waits.get(&key(&y)).map(Vec::as_slice), Some(&[1, 2, 4][..]));
        assert_eq!(
            *cleanup.store.made.borrow(),
            [key(&z), key(&x), key(&y), record],
            "the record last, after its refused objects"
        );
        assert!(cleanup.store.store.list("").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Review of #4990, second read, blocking: a stop (a sleep, SIGTERM) between a delete landing and its settling left
    /// the copy in `kept/`, which says the store holds the object. After the restart the writer, naming it again, found
    /// that copy and spooled nothing, and the store lacked it while the chain named it. The copy now leaves `kept/`
    /// before the delete is sent, and the start queues what it finds in `deleting/` again.
    #[test]
    #[allow(clippy::disallowed_methods)] // The pass is driven by hand.
    fn a_stop_between_a_delete_and_its_settling_puts_the_object_again() {
        let dir =
            std::env::temp_dir().join(format!("backup-stop-mid-delete-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store: &'static Memory = Box::leak(Box::default());
        let record = generation(store, "s/w/", 0, &[WORDS.to_vec()]);
        let words = format!("s/w/objects/{}", to_hex(&replica::ids::sha256(WORDS)));
        let spool = Spool::new(dir.clone(), "test-store".into());
        spool.keep(&words, WORDS);
        spool.live(BTreeSet::new());
        backed_up(&spool);
        spool.prune(record, BTreeSet::new());
        let mut cleanup = cleanup(
            &spool,
            Hooked {
                store,
                before_delete: Box::new(|key: &str| {
                    if key == words {
                        store.delete(key).unwrap();
                        panic!("the world stops after the delete lands");
                    }
                }),
                after_put: Box::new(|_: &str| {}),
            },
        );
        let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            cleanup.pass(Instant::now())
        }));
        assert!(stopped.is_err());
        assert!(store.get(&words).unwrap().is_none(), "the delete landed");
        drop(cleanup);
        drop(spool);
        // The restart: the backup starts, then the writer names the words again for a new part.
        let mut spool = Spool::new(dir.clone(), "test-store".into());
        start(&mut spool, store, store, "s/w/".into(), Box::new(|_| {})).unwrap();
        spool.object(&words, WORDS).unwrap();
        spool.head("s/w/head", b"head").unwrap();
        assert!(spool.drainer().unwrap().drain(Duration::from_secs(20)));
        assert!(
            store.get(&words).unwrap().is_some(),
            "the store holds it again"
        );
        assert_eq!(spool.read(&words).as_deref(), Some(WORDS));
        drop(spool);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
