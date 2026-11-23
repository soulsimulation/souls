//! The stream writer (Engine v2 V1, #2710): it follows one key of the view tier (R3) and writes its frames as the
//! numbered files of `replica::stream`, which a reader plays with no other connection. The formats and the reader are
//! there; this is the writer.
//!
//! 1. **Only what is on the disk.** The writer is a subscriber of the tier, which reads ticks once K4 has synced them,
//!    so a part never holds an effect the log could lose.
//! 2. **Decoded once before publishing.** The records of a stretch are assembled into one T6 part, read back
//!    (`Part::read`) and applied to the writer's own copy of the view (R1's replica): a part the copy refuses is never
//!    written, and the copy's state hash is what every tenth part carries.
//! 3. **A part is cut by world time**, every [`stream::PERIOD_US`], when the first record of a later stretch arrives
//!    (or once its time has passed, rule 11, or on [`Writer::flush`]); it is numbered in the order written. A stretch
//!    with no records writes no part.
//! 4. **Temporary name, then rename.** Each file is written whole under `<name>.tmp` and renamed to its name, so a
//!    writer killed mid-write leaves no broken file under a final name, and a cache never keeps half a part. The
//!    pointer is written after its part, the same way.
//! 5. **No wall clock here.** The world's clock hands the writer its anchor (a world time and the wall time it fell
//!    at) when the writer starts; the writer copies it into the pointer and never reads a clock (K7).
//! 6. **A gap ends the stream.** A subscriber that fell behind is handed a snapshot (R3 rule 6), which a numbered
//!    stream cannot carry yet: the writer stops with `stream-gap` rather than write a stream that skips.
//!
//! 7. **The view's gaps are declared.** A view skips the entries it does not hold (another audience's, or outside its
//!    node), so its records' sequences jump. Each jump is written in the part that holds the record after it
//!    (`replica::stream` rule 6), and the writer's copy applies the part with those gaps and no others.
//! 8. **A fork's stream starts at its head** (#3300; [`Writer::fork`]). A fork (K6) starts mid-sequence, with a state
//!    that a reader starting from the root alone has never seen. Its part 0 carries that state as ordinary T6
//!    entries: one that sets the root's fields, creates the view's nodes (parents first) and its links; one with the
//!    zone's time effects; one per node with timers. They are numbered just below the fork's next sequence, the
//!    sequences before them declared as one gap (rule 7), so any reader plays part 0 as it plays any part, and part 0
//!    always carries the state hash. The header written is the fork's, with the kinds the state rests on added, the
//!    root's first, when it does not list them (K6's head lists none). The view's nodes are its key's subtree in its
//!    audience, as a snapshot holds them (R3 rule 6), so the key must be the zone's root (`stream-start-node`); a node
//!    in motion is refused as `stream-start-moving` (a fork has removed its bodies), and a link whose owning end is
//!    not in the view is left out.
//!    A checkpoint continuation uses [`Writer::resume`]: its exact recorded hand-offs are seeded canonically,
//!    and its real-time observations are mapped through published and pending mapping records. The new-fork
//!    moving-state guard remains unchanged. Transfer checkpoint state is explicitly refused until it has a seed.
//! 9. **A subtree carried in goes with its arrive.** A view that did not hold an arrival's leave writes the subtree as
//!    it was in flight, and where it lands, just before the arrive (T7 rule 4). The writer puts that record in the
//!    part that holds the arrive (`replica::stream` rule 7), and its copy lands it as a reader does. A carried record
//!    that names no destination (views revision 1), or one with no arrive after it (a view of another audience than
//!    the arrival's), is refused as `stream-carried`.
//!
//! 10. **Words beside the public parts** (V1b, #3361). A writer given K16's store ([`Writer::fork_with_text`]) of a
//!     public view writes, before each part, its text file `<number>.text`: the words of the part's references
//!     (`{21: id}`) as `[[reference, words], ...]` in reference order, the words as bytes, each read from the store as
//!     the public audience reads it (`Store::read` with no ids), so a removed reference (the redaction list) and words
//!     of any other audience are never in it. A whisper's entry is not in a public view at all, so its reference is
//!     not either. The file is written whole and renamed (rule 4) before the part, so a reader that finds a part finds
//!     its words. The public writer ([`PublicWriter`]) given the importer's name dictionary also writes the words of
//!     the place names its public nodes reference (import-eden's field 4, a SHA-256 of the words; #3574) as
//!     `[hash, words]` rows: the baseline's for its state, a part's for the nodes its records create, each checked
//!     against its hash (#3571's rule).
//! 11. **A still world says so** (V5b, #3460). [`follow`] is handed the world's clock and tells the writer the world's
//!     time now ([`Writer::idle`]) after each frame, and at least every 20 ms without one. Once a stretch's time has
//!     passed, with [`SETTLE_US`] more for its last records to be synced, the open stretch is written, so a burst after a
//!     still while is on the page within the usual lag rather than waiting for the next record. With nothing open, the
//!     pointer says the world is still up to world-now less [`SETTLE_US`] (`quiet(until)`), every [`QUIET_EVERY_US`] of
//!     world time; a page plays a still world to there, and no empty part is ever written (rule 3). A record that
//!     reaches the writer later than [`SETTLE_US`] after its world time is still written, in its own stretch; a page
//!     that has drawn past it has missed only its motion, never its state.
//! 12. **A hiding place's contents stay out** (#3948). The public writer opened with the world's closed kinds
//!     ([`PublicWriter::open_hiding`]) leaves what a closed container holds out of its state and baselines
//!     ([`crate::closed::Closed::hides`]) and its entries ([`crate::closed::Inside`], the hub's rule), until it is
//!     taken out. A generation's recovery seed says so (field 17); one begun before keeps them until the next.
//! 13. **A sleeping world is still until its next due change** (#2731, 0.133 S4). Before a still world exits to sleep,
//!     [`PublicWriter::sleep`] writes its pointer once more, as `idle` would (field 7 quiet up to world-now less
//!     [`SETTLE_US`]), with field 11: `[]` when nothing is due, or `[t]`, the world time (µs) of its next due change.
//!     Nothing changes in the world before `t`, so a page may play it as still, its time moving on, up to `t`; the
//!     world is woken before then and writes its pointer again, without field 11. A viewer's read wakes nothing.
//!
//! Not here: serving (V2), history (V3), snapshot chunks for a reader that joins late, and drawing the words (W4).

#[cfg(test)]
mod tests;

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use replica::apply::Replica;
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, NodeState, Part, Refusal,
    Rest, State, TimerRec,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::Id;
use replica::pose::{HandOff, Pose};
use replica::stream::{self, HASH_EVERY, POINTER, Pointer, StreamPart};
use replica::time::{Mapping, Micros, TimeEffect};
use replica::views::{Carried, Key};
use replica::world_model::{Audience, End};

use crate::views::{Delivery, Subscriber};
use sim::text::Store;

/// Where the public writer's core goes (#4192): with `STREAM_PROFILE=1`, each stage's wall time on the writer's
/// thread, summed and printed to stderr every 10 s with the thread's own processor time. A measurement only: it never
/// changes a byte written, and off (the default) it reads no clock.
mod prof {
    // A profile is wall time on the writer's thread, off unless asked for (K7 allows it, as in `measures`).
    #![allow(clippy::disallowed_methods)]
    use std::cell::RefCell;
    use std::time::Instant;
    pub const NAMES: [&str; 13] = [
        "push.apply",
        "flush.state",
        "flush.context",
        "flush.encode",
        "flush.put",
        "flush.words",
        "flush.play",
        "flush.commit",
        "flush.files",
        "flush.prune",
        "flush.pointer",
        "idle.check",
        "idle.pointer",
    ];
    struct P {
        ns: [u128; 13],
        records: u64,
        parts: u64,
        whole: u64,
        since: Instant,
        cpu0: u64,
        causes: std::collections::BTreeMap<&'static str, u64>,
    }
    thread_local!(static P_: RefCell<Option<P>> = const { RefCell::new(None) });
    fn on() -> bool {
        static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *ON.get_or_init(|| std::env::var("STREAM_PROFILE").is_ok_and(|v| v == "1"))
    }
    fn cpu() -> u64 {
        std::fs::read_to_string("/proc/thread-self/stat")
            .ok()
            .and_then(|s| {
                let f: Vec<&str> = s[s.rfind(')')? + 2..].split(' ').collect();
                Some(f.get(11)?.parse::<u64>().ok()? + f.get(12)?.parse::<u64>().ok()?)
            })
            .unwrap_or(0)
    }
    pub struct Lap(Option<Instant>);
    impl Lap {
        pub fn start() -> Lap {
            Lap(on().then(Instant::now))
        }
        pub fn mark(&mut self, stage: usize) {
            let Some(t) = self.0 else { return };
            let now = Instant::now();
            let d = now.duration_since(t).as_nanos();
            self.0 = Some(now);
            P_.with(|p| {
                let mut p = p.borrow_mut();
                let p = p.get_or_insert_with(|| P {
                    ns: [0; 13],
                    records: 0,
                    parts: 0,
                    whole: 0,
                    since: now,
                    cpu0: cpu(),
                    causes: Default::default(),
                });
                p.ns[stage] += d;
            });
        }
    }
    /// What made a record's cut whole (`structural`), by change kind.
    pub fn cause(name: &'static str) {
        if !on() {
            return;
        }
        P_.with(|p| {
            if let Some(p) = p.borrow_mut().as_mut() {
                *p.causes.entry(name).or_default() += 1;
            }
        });
    }
    pub fn count(records: u64, parts: u64, whole: u64) {
        if !on() {
            return;
        }
        P_.with(|p| {
            let mut g = p.borrow_mut();
            let Some(p) = g.as_mut() else { return };
            p.records += records; p.parts += parts; p.whole += whole;
            let wall = p.since.elapsed();
            if wall.as_secs() < 10 { return; }
            let c = cpu();
            let ms = |n: u128| n as f64 / 1e6;
            let busy: u128 = p.ns.iter().sum();
            let mut line = format!(
                "public-stream profile: wall {:.1}s cpu {:.2}s staged {:.0}ms records {} parts {} whole-cuts {}",
                wall.as_secs_f64(), (c - p.cpu0) as f64 / 100.0, ms(busy), p.records, p.parts, p.whole
            );
            for (i, n) in NAMES.iter().enumerate() { line += &format!(" {n} {:.0}ms", ms(p.ns[i])); }
            line += &format!(" structural-by {:?}", p.causes);
            eprintln!("{line}");
            *g = None;
        });
    }
}

type R<T> = Result<T, Refusal>;

enum Start {
    Fork,
    Resume(Option<Mapping>),
}

/// How long past a stretch's world time the writer waits for its last records before writing it (rule 11): records
/// reach the writer once K4 has synced them, a little after the world time they carry.
pub const SETTLE_US: Micros = 250_000;
/// How often, in world time, a still world's pointer moves its "quiet until" on (rule 11).
pub const QUIET_EVERY_US: Micros = stream::PERIOD_US;
/// Parts in one public generation before the next baseline (#3825): 2 minutes of a busy world at 2 parts a second,
/// so a new viewer fetches the baseline and at most 2 minutes of parts.
pub const GENERATION_PARTS: u64 = 240;
/// Recovery-store objects of old generations deleted after each published part (#3833): a generation's few hundred
/// objects go in about a minute of a busy world, and no part waits on more than this many deletes.
const DELETES_PER_PART: usize = 16;
/// How long a public generation older than the previous one is kept after its last write (#3825).
pub const PRUNE_GRACE: Duration = Duration::from_secs(600);

fn env_u64(name: &str) -> Option<u64> {
    std::env::var(name).ok()?.parse().ok()
}

fn fault(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

fn io(e: std::io::Error) -> Refusal {
    fault("stream-write", e.to_string())
}

// Source diagnostics name the bootstrap stage, never a device path. Required sources must not silently vanish.
fn source_io(stage: &'static str, error: std::io::Error) -> Refusal {
    let name = if error.kind() == std::io::ErrorKind::NotFound {
        "stream-source-missing"
    } else {
        "stream-source-io"
    };
    fault(name, format!("{stage}: {:?}", error.kind()))
}
fn source_invalid(stage: &'static str, error: Refusal) -> Refusal {
    fault("stream-source-invalid", format!("{stage}: {}", error.name))
}
/// Own the selected engine checkpoint bytes before its writer can prune files. CRC, hashes and the complete root
/// must still match the actual selected restore; neither a changed source nor a missing one is a fresh bootstrap.
pub fn capture_checkpoint(path: &Path, expected: &sim::checkpoint::Root) -> R<Vec<u8>> {
    let bytes = fs::read(path).map_err(|e| source_io("selected checkpoint bytes", e))?;
    let captured = sim::checkpoint::read_bytes(&bytes)
        .map_err(|e| source_invalid("selected checkpoint validation", e))?;
    if captured.root != *expected {
        return Err(fault(
            "stream-source-changed",
            "selected checkpoint root differs",
        ));
    }
    Ok(bytes)
}

/// Writes `bytes` to `path` under a temporary name, then renames it (rule 4).
pub fn write_whole(path: &Path, bytes: &[u8]) -> R<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let mut f = fs::File::create(&tmp).map_err(io)?;
    f.write_all(bytes).map_err(io)?;
    drop(f);
    fs::rename(&tmp, path).map_err(io)
}

/// What a writer has written.
#[derive(Clone, Debug, Default)]
pub struct Written {
    pub parts: u64,
    pub entries: u64,
    /// Each part's file size, in number order.
    pub bytes: Vec<u64>,
}

/// One key's stream writer.
pub struct Writer {
    dir: PathBuf,
    header: Header,
    copy: Replica,
    anchor: (Micros, u64),
    quiet_until: Option<Micros>,
    window: Option<i64>,
    pending: Vec<Value>,
    /// The open stretch's declared gaps (rule 7), and the sequence the view's next record would have with none.
    gaps: Vec<(u64, u64)>,
    expect: u64,
    /// A carried record waiting for its arrive, and the open stretch's carried records (rule 9).
    lead: Option<(u64, Value)>,
    carried: Vec<Value>,
    last_to: Option<Micros>,
    written: Written,
    /// K16's store, for the text file beside each part of a public view (rule 10).
    text: Option<Arc<Store>>,
    public: bool,
    /// A resumed stream observes the supplied real clock through its recorded mappings.
    mapped_clock: bool,
    /// Observer-only provenance from a canonically validated durable head, when the checkpoint precedes it.
    clock_seed: Option<Mapping>,
}

impl Writer {
    /// A writer of `key`'s stream under `root`: writes the bundle's header once and an empty pointer. `anchor` is a
    /// world time and the wall time, in ms since the Unix epoch, it fell at (rule 5).
    pub fn create(root: &Path, header: &Header, key: &Key, anchor: (Micros, u64)) -> R<Writer> {
        // The header first, then the stream's folder: a writer killed between the two leaves no folder without its
        // header (rule 4).
        let hp = root.join(stream::header_path(header));
        if let Some(parent) = hp.parent() {
            fs::create_dir_all(parent).map_err(io)?;
        }
        if !hp.exists() {
            write_whole(&hp, header.stored())?;
        }
        let dir = root.join(stream::dir(header, key));
        fs::create_dir_all(&dir).map_err(io)?;
        let w = Writer {
            dir,
            header: header.clone(),
            copy: Replica::start(header.stored())?,
            anchor,
            quiet_until: None,
            window: None,
            pending: Vec::new(),
            gaps: Vec::new(),
            expect: 0,
            lead: None,
            carried: Vec::new(),
            last_to: None,
            written: Written::default(),
            text: None,
            public: key.audience == Audience::Everyone,
            mapped_clock: false,
            clock_seed: None,
        };
        w.pointer()?;
        Ok(w)
    }

    /// A writer of `key`'s stream for a world whose log continues from `state` (a fork's state after the head of its
    /// log), and its part 0, which holds that state (rule 8). The records it is handed next start at `state.next`.
    pub fn fork(
        root: &Path,
        header: &Header,
        key: &Key,
        anchor: (Micros, u64),
        state: &State,
    ) -> R<Writer> {
        Writer::fork_with_text(root, header, key, anchor, state, None)
    }

    /// As [`Writer::fork`], with K16's store from part 0 on (rule 10): a state's references get their words too.
    pub fn fork_with_text(
        root: &Path,
        header: &Header,
        key: &Key,
        anchor: (Micros, u64),
        state: &State,
        text: Option<Arc<Store>>,
    ) -> R<Writer> {
        Self::seed(root, header, key, anchor, state, text, Start::Fork)
    }

    /// A checkpoint continuation, including recorded motion. `anchor`'s first value is real time; the public
    /// stream's anchor and subsequent idle observations are mapped into world time by the recorded timeline.
    /// Unlike a new fork, this represents an existing body's exact canonical hand-off, not a new movement.
    pub fn resume(
        root: &Path,
        header: &Header,
        key: &Key,
        anchor: (Micros, u64),
        state: &State,
    ) -> R<Writer> {
        Self::seed(root, header, key, anchor, state, None, Start::Resume(None))
    }

    /// As [`Writer::resume`], when the authoritative checkpoint precedes its first mapping. The caller has
    /// canonically applied the durable post-base part containing `mapping`; it seeds the observer only, never the
    /// replica state. That part must still be replayed once at its original physical/effect position.
    pub fn resume_with_mapping(
        root: &Path,
        header: &Header,
        key: &Key,
        anchor: (Micros, u64),
        state: &State,
        mapping: Mapping,
    ) -> R<Writer> {
        Self::seed(
            root,
            header,
            key,
            anchor,
            state,
            None,
            Start::Resume(Some(mapping)),
        )
    }

    fn seed(
        root: &Path,
        header: &Header,
        key: &Key,
        anchor: (Micros, u64),
        state: &State,
        text: Option<Arc<Store>>,
        start: Start,
    ) -> R<Writer> {
        let (resume, clock_seed) = match start {
            Start::Fork => (false, None),
            Start::Resume(mapping) => (true, mapping),
        };
        if key.node != state.root {
            return Err(fault(
                "stream-start-node",
                "a fork's stream starts at the zone's root",
            ));
        }
        let top = state
            .nodes
            .get(&state.root)
            .ok_or_else(|| fault("stream-start-root", "the state has no root"))?;
        if !top.kind.as_str().starts_with("souls:place@") {
            return Err(fault("stream-start-root", "the root is not a souls:place"));
        }
        // The view's nodes, parents first.
        let mut viewed: Vec<(usize, Id, &NodeState)> = state
            .nodes
            .iter()
            .filter(|(id, n)| **id != state.root && n.audience == key.audience)
            .filter_map(|(id, n)| depth(state, *id).map(|d| (d, *id, n)))
            .collect();
        viewed.sort_by_key(|(d, id, _)| (*d, *id));
        if !resume && viewed.iter().any(|(_, _, n)| n.motion.is_some()) {
            return Err(fault(
                "stream-start-moving",
                "a node of the view is in motion",
            ));
        }
        if resume && (!state.in_flight.is_empty() || !state.arrived.is_empty()) {
            return Err(fault(
                "stream-start-transfer",
                "a checkpoint with transfer state needs a canonical transfer seed",
            ));
        }
        let header = with_kinds(header, &top.kind, viewed.iter().map(|(_, _, n)| &n.kind))?;

        let mut at = state
            .time
            .iter()
            .rev()
            .find_map(|t| match t {
                TimeEffect::Mapping(m) => Some(m.world_us),
                _ => None,
            })
            .unwrap_or(0);
        let everyone = key.audience == Audience::Everyone;
        let mut changes = Vec::new();
        let mut motions = Vec::new();
        if everyone {
            for (f, v) in &top.fields {
                changes.push(Change::Set {
                    node: state.root,
                    field: *f,
                    to: v.clone(),
                    by: None,
                });
            }
        }
        for (_, id, n) in &viewed {
            let mut frame = vec![n.parent.unwrap_or(state.root).to_value()];
            frame.extend(n.slot.map(Value::Uint));
            let Some(Value::Map(mut place)) = n.place.clone() else {
                return Err(fault("stream-start-place", "a node with no place"));
            };
            place.insert(1, Value::Array(frame));
            let pose = Pose::from_value(&Value::Map(place))
                .map_err(|e| fault("stream-start-place", e.name()))?;
            if let Some(Value::Map(m)) = &n.motion {
                if m.len() != 4 || !(1..=4).all(|k| m.contains_key(&k)) {
                    return Err(fault(
                        "stream-start-motion",
                        "a recorded motion has four fields",
                    ));
                }
                let handoff = Value::Map(
                    [
                        (1, id.to_value()),
                        (2, m[&1].clone()),
                        (3, m[&4].clone()),
                        (4, m[&4].clone()),
                        (5, pose.to_value()),
                        (6, m[&2].clone()),
                        (7, m[&3].clone()),
                    ]
                    .into(),
                );
                let handoff = HandOff::from_value(&handoff)
                    .map_err(|e| fault("stream-start-motion", e.name()))?;
                at = at.max(handoff.at);
                motions.push(Change::Motion(handoff));
            } else if n.motion.is_some() {
                return Err(fault("stream-start-motion", "a recorded motion is a map"));
            }
            changes.push(Change::Create {
                node: *id,
                kind: n.kind.clone(),
                pose,
                audience: n.audience,
                fields: n.fields.clone(),
            });
        }
        changes.extend(motions);
        let made =
            |e: &Id| viewed.iter().any(|(_, id, _)| id == e) || (everyone && *e == state.root);
        for (id, l) in &state.links {
            let owning = l.ends[usize::from(l.owner == End::Second)];
            if l.audience == key.audience && made(&owning) {
                changes.push(Change::Link {
                    link: *id,
                    ty: l.ty.clone(),
                    ends: l.ends,
                    owner: l.owner,
                    audience: l.audience,
                });
            }
        }
        let mut seed: Vec<(Id, Audience, Body)> = Vec::new();
        if !changes.is_empty() {
            let recs = changes.into_iter().map(|change| ChangeRec {
                change,
                rest: Rest::new(),
            });
            seed.push((state.root, key.audience, Body::Changes(recs.collect())));
        }
        if everyone && !state.time.is_empty() {
            seed.push((
                state.root,
                Audience::Everyone,
                Body::Time(state.time.clone()),
            ));
        }
        let mut timers: std::collections::BTreeMap<Id, Vec<TimerRec>> = Default::default();
        for (timer, t) in &state.timers {
            if made(&t.node) {
                timers.entry(t.node).or_default().push(TimerRec::Set {
                    timer: *timer,
                    due: t.due,
                    name: t.name.clone(),
                });
            }
        }
        for (node, list) in timers {
            let audience = state.nodes.get(&node).map_or(key.audience, |n| n.audience);
            seed.push((node, audience, Body::Timers(list)));
        }

        let k = u64::try_from(seed.len()).unwrap_or(u64::MAX);
        let first = state.next.checked_sub(k).ok_or_else(|| {
            fault(
                "stream-start-short",
                format!("{k} entries of state below sequence {}", state.next),
            )
        })?;
        // Validate every projected pose and motion, and the mapped anchor, before publishing any output.
        let anchor = if resume {
            (mapped_now(&state.time, clock_seed, anchor.0)?, anchor.1)
        } else {
            anchor
        };
        let mut w = Writer::create(root, &header, key, anchor)?;
        w.text = text;
        w.mapped_clock = resume;
        w.clock_seed = clock_seed;
        if seed.is_empty() {
            // The root alone: the first part declares the sequences before the fork (rule 7).
            return Ok(w);
        }
        let records = seed
            .into_iter()
            .zip(first..)
            .map(|((node, audience, body), sequence)| {
                Effect {
                    envelope: Envelope {
                        sequence,
                        at,
                        cause: Cause::World,
                        actor: Actor::World,
                        audience,
                        node,
                    },
                    body,
                    events: None,
                    rest: Rest::new(),
                }
                .to_value()
            })
            .collect();
        let gaps = if first > 0 {
            vec![(0, first)]
        } else {
            Vec::new()
        };
        w.write(
            at.div_euclid(stream::PERIOD_US),
            records,
            gaps,
            Vec::new(),
            true,
        )?;
        w.expect = state.next;
        Ok(w)
    }

    /// The stream's directory.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn written(&self) -> &Written {
        &self.written
    }

    /// Takes one frame of the tier's key (R3 rule 5) and writes every stretch it closes.
    pub fn frame(&mut self, bytes: &[u8]) -> R<()> {
        let v = decode(bytes)
            .map_err(|e| fault("encoding", e.to_string()))?
            .value;
        let Value::Map(mut m) = v else {
            return Err(fault("stream-frame", "a frame is a map"));
        };
        let Some(Value::Array(records)) = m.remove(&8) else {
            return Err(fault("stream-frame", "a frame has no records"));
        };
        for r in records {
            let Value::Map(rm) = &r else {
                return Err(fault("stream-frame", "a record is a map"));
            };
            if let Some(c) = Carried::read(&r)? {
                if c.pose.is_none() {
                    return Err(fault(
                        "stream-carried",
                        "a carried subtree (an arrival) does not name where it lands (a views revision 1 record)",
                    ));
                }
                if self.lead.is_some() {
                    return Err(fault(
                        "stream-carried",
                        "a carried subtree lands only with its arrive",
                    ));
                }
                self.lead = Some((c.sequence, r));
                continue;
            }
            let at = match rm.get(&2) {
                Some(Value::Uint(u)) => i64::try_from(*u).unwrap_or(i64::MAX),
                Some(Value::Nint(n)) => -1 - i64::try_from(*n).unwrap_or(i64::MAX - 1),
                _ => return Err(fault("stream-frame", "a record has no world time")),
            };
            let Some(Value::Uint(seq)) = rm.get(&1) else {
                return Err(fault("stream-frame", "a record has no sequence"));
            };
            let seq = *seq;
            if seq < self.expect {
                return Err(fault(
                    "stream-frame",
                    format!("record {seq} after {}", self.expect - 1),
                ));
            }
            let w = at.div_euclid(stream::PERIOD_US);
            if self.window.is_some_and(|x| x != w) {
                self.cut()?;
            }
            self.window = Some(w);
            if seq > self.expect {
                // The view skipped these (rule 7): said in the part, never left for the reader to guess.
                self.gaps.push((self.expect, seq - self.expect));
            }
            self.expect = seq + 1;
            if let Some((s, c)) = self.lead.take() {
                if s != seq {
                    return Err(fault(
                        "stream-carried",
                        format!(
                            "the subtree carried in at {s} has no arrive (record {seq} came next)"
                        ),
                    ));
                }
                // Into the part that holds its arrive (rule 9).
                self.carried.push(c);
            }
            self.pending.push(r);
        }
        Ok(())
    }

    /// Writes the open stretch, if any.
    pub fn flush(&mut self) -> R<()> {
        if let Some((s, _)) = self.lead {
            return Err(fault(
                "stream-carried",
                format!("the subtree carried in at {s} has no arrive"),
            ));
        }
        self.cut()
    }

    /// Says in the pointer that the world is still until `until` (world time); it writes nothing until then.
    pub fn quiet(&mut self, until: Option<Micros>) -> R<()> {
        self.quiet_until = until;
        self.pointer()
    }

    /// Told the world's time `now` (rule 11): writes the open stretch once its time and [`SETTLE_US`] have passed, and,
    /// with nothing open, marks the pointer quiet up to `now - SETTLE_US` every [`QUIET_EVERY_US`].
    pub fn idle(&mut self, now: Micros) -> R<()> {
        if self.lead.is_some() {
            // A carried subtree waits for its arrive, which belongs to the open stretch or a later one.
            return Ok(());
        }
        let settled = now.saturating_sub(SETTLE_US);
        if let Some(w) = self.window {
            if (w + 1) * stream::PERIOD_US > settled {
                return Ok(());
            }
            self.cut()?;
        }
        let due = match (self.quiet_until, self.last_to) {
            (Some(q), _) => settled >= q.saturating_add(QUIET_EVERY_US),
            (None, Some(to)) => settled > to,
            (None, None) => true,
        };
        if due {
            self.quiet(Some(settled))
        } else {
            Ok(())
        }
    }

    /// Includes mappings already accepted by the tier but not yet cut into a published part. A slowdown in the
    /// pending stretch must govern that stretch's settlement; the old published mapping cannot advance quiet time.
    fn observed_now(&self, real: Micros) -> R<Micros> {
        let mut mapping = mapping_at(self.copy.tree().time(), real)
            .or_else(|| self.clock_seed.filter(|m| m.real_us <= real));
        for value in &self.pending {
            if let Value::Map(record) = value
                && let Some(Value::Array(effects)) = record.get(&10)
            {
                for value in effects {
                    let effect = TimeEffect::from_value(value)
                        .map_err(|e| fault("stream-clock", e.name()))?;
                    if effect.to_value() != *value {
                        return Err(fault("stream-clock", "a noncanonical time effect"));
                    }
                    if let TimeEffect::Mapping(m) = effect
                        && m.real_us <= real
                    {
                        mapping = Some(m);
                    }
                }
            }
        }
        mapping
            .ok_or_else(|| fault("stream-clock", "no mapping at the observed real time"))?
            .world_at(real)
            .map_err(|e| fault("stream-clock", e.name()))
    }

    fn idle_observed(&mut self, now: Micros) -> R<()> {
        if !self.mapped_clock {
            return self.idle(now);
        }
        if self.lead.is_some() {
            return Ok(());
        }
        let settled = self.observed_now(now)?.saturating_sub(SETTLE_US);
        if let Some(window) = self.window {
            if (window + 1) * stream::PERIOD_US > settled {
                return Ok(());
            }
            self.cut()?;
        }
        // cut() validates and applies the pending mapping; observe again before any quiet publication.
        self.idle(self.observed_now(now)?)
    }

    fn pointer(&self) -> R<()> {
        let p = Pointer {
            newest: self.written.parts.checked_sub(1),
            period: stream::PERIOD_US,
            header: self.header.hash().to_bytes(),
            newest_to: self.last_to,
            anchor_world: self.anchor.0,
            anchor_wall_ms: self.anchor.1,
            quiet_until: self.quiet_until,
        };
        write_whole(&self.dir.join(POINTER), &p.to_bytes()?)
    }

    fn cut(&mut self) -> R<()> {
        let Some(w) = self.window.take() else {
            return Ok(());
        };
        let records = std::mem::take(&mut self.pending);
        let gaps = std::mem::take(&mut self.gaps);
        let carried = std::mem::take(&mut self.carried);
        if records.is_empty() {
            return Ok(());
        }
        self.write(w, records, gaps, carried, false)
    }

    /// Writes one part of `records` in world-time window `w`, with the carried records its arrives land (rule 9),
    /// carrying the state hash when due or when `hashed`.
    fn write(
        &mut self,
        w: i64,
        records: Vec<Value>,
        gaps: Vec<(u64, u64)>,
        carried: Vec<Value>,
        hashed: bool,
    ) -> R<()> {
        let first = match records.first() {
            Some(Value::Map(m)) => match m.get(&1) {
                Some(Value::Uint(s)) => *s,
                _ => return Err(fault("stream-frame", "a record has no sequence")),
            },
            _ => return Err(fault("stream-frame", "a record is a map")),
        };
        let entries = u64::try_from(records.len()).unwrap_or(u64::MAX);
        let text = match (&self.text, self.public) {
            (Some(store), true) => {
                let refs = replica::audience::references(&Value::Array(records.clone()));
                let words: Vec<Value> = refs
                    .into_iter()
                    .filter_map(|r| {
                        let w = store.read(r, &[]).ok()?;
                        Some(Value::Array(vec![r.to_value(), Value::Bytes(w)]))
                    })
                    .collect();
                Some(words)
            }
            _ => None,
        };
        let raw = encode(&Value::Map(
            [
                (1, Value::Bytes(self.header.hash().to_bytes())),
                (2, Value::Array(records)),
            ]
            .into(),
        ))
        .map_err(|e| fault("encoding", e.to_string()))?;
        let (from, to) = (w * stream::PERIOD_US, (w + 1) * stream::PERIOD_US);
        let mut sp = StreamPart {
            number: self.written.parts,
            from,
            to,
            first,
            entries,
            part: raw,
            hash: None,
            gaps,
            carried,
        };
        // Decoded once, and applied to the view's copy, before it is published (rule 2).
        let part = Part::read(&sp.part)?;
        self.copy
            .apply_view(&part, &sp.gaps, &sp.flights(&self.header)?)?;
        let number = sp.number;
        if hashed || (number + 1).is_multiple_of(HASH_EVERY) {
            sp.hash = Some(replica::hash::state_hash(self.copy.tree())?.to_bytes());
        }
        let bytes = sp.to_bytes()?;
        if let Some(words) = text {
            let b = encode(&Value::Array(words)).map_err(|e| fault("encoding", e.to_string()))?;
            write_whole(&self.dir.join(format!("{number}.text")), &b)?;
        }
        write_whole(&self.dir.join(number.to_string()), &bytes)?;
        self.written.parts += 1;
        self.written.entries += entries;
        self.written
            .bytes
            .push(u64::try_from(bytes.len()).unwrap_or(u64::MAX));
        self.last_to = Some(to);
        self.quiet_until = None;
        self.pointer()
    }
}

fn mapping_at(time: &[TimeEffect], real: Micros) -> Option<Mapping> {
    time.iter().rev().find_map(|t| match t {
        TimeEffect::Mapping(m) if m.real_us <= real => Some(*m),
        _ => None,
    })
}

fn mapped_now(time: &[TimeEffect], seed: Option<Mapping>, real: Micros) -> R<Micros> {
    let mapping = mapping_at(time, real)
        .or_else(|| seed.filter(|m| m.real_us <= real))
        .ok_or_else(|| fault("stream-clock", "no mapping at the observed real time"))?;
    mapping
        .world_at(real)
        .map_err(|e| fault("stream-clock", e.name()))
}

/// How far `id` is below the root, or none when it is not in the state's tree.
fn depth(state: &State, id: Id) -> Option<usize> {
    let mut at = id;
    for d in 0..=state.nodes.len() {
        if at == state.root {
            return Some(d);
        }
        at = state.nodes.get(&at)?.parent?;
    }
    None
}

/// `h` with `root` as its first kind and every kind in `used` listed (rule 8); `h` itself when it already is so.
fn with_kinds<'a>(h: &Header, root: &Name, used: impl Iterator<Item = &'a Name>) -> R<Header> {
    let mut missing: Vec<&Name> = Vec::new();
    for k in used {
        if !h.kinds.contains(k) && !missing.contains(&k) && k != root {
            missing.push(k);
        }
    }
    let first = h
        .kinds
        .iter()
        .find(|k| k.as_str().starts_with("souls:place@"));
    if first == Some(root) && missing.is_empty() {
        return Ok(h.clone());
    }
    let kinds = std::iter::once(root)
        .chain(h.kinds.iter().filter(|k| *k != root))
        .chain(missing)
        .map(|k| Value::Text(k.clone()))
        .collect();
    let Value::Map(mut m) = h.to_value() else {
        return Err(fault("encoding", "a header is a map"));
    };
    m.insert(6, Value::Array(kinds));
    Header::read(&encode(&Value::Map(m)).map_err(|e| fault("encoding", e.to_string()))?)
}

/// Follows `sub`, writing each frame, on its own thread, until `stop` is set and the queue is empty; then writes the
/// open stretch and gives the writer back. A snapshot delivery ends it with `stream-gap` (rule 6). `now` is the world's
/// clock, read only to tell the writer the world's time (rule 11), never by the writer itself (rule 5).
pub fn follow(
    mut writer: Writer,
    sub: Subscriber,
    stop: Arc<AtomicBool>,
    mut now: impl FnMut() -> Micros + Send + 'static,
) -> JoinHandle<R<Writer>> {
    std::thread::spawn(move || {
        loop {
            match sub.recv_timeout(Duration::from_millis(20)) {
                Some(Delivery::Frame { bytes, .. }) => writer.frame(&bytes)?,
                Some(Delivery::Snapshot { .. }) => {
                    return Err(fault(
                        "stream-gap",
                        "the writer fell behind the tier and was handed a snapshot",
                    ));
                }
                // A view's subscriber is never sent the index (E1).
                Some(Delivery::Index { .. }) => {}
                None if stop.load(Ordering::Relaxed) => break,
                None => {}
            }
            writer.idle_observed(now())?;
        }
        writer.flush()?;
        Ok(writer)
    })
}

// A stream observer has its own durable publication cursor. The canonical source copy validates WHOLE parts
// before any projection is exposed; the public copy never receives the source's private ledger.
use directoryd::directory::store::{Store as ObjectStore, When};
use replica::stream::public::{PublicPlayer, digest, project};
use replica::views::{Redactions, View};

use crate::closed::{Closed, Inside};

/// The public projection of `tree` (#3948): with `closed`, what a closed container holds is left out, its links and
/// its timers with it, as a Soul's copy leaves it out (#3915; `closed`). Without, the projection as before.
fn shown(header: &Header, closed: Option<&Closed>, tree: &replica::tree::Tree) -> R<Value> {
    let mut state = tree.to_state();
    let hidden = closed.map(|c| c.hidden(tree)).unwrap_or_default();
    leave_out(&mut state, &hidden);
    // A node the public state cannot hold (a kind it cannot check, a frame or pose it cannot read) is left out and
    // logged by name, never the stream stopped for every viewer (C5). Leaving one out can leave out another (a
    // definition), so until none is left.
    loop {
        let bad = replica::stream::public::unplaceable(header, &state);
        if bad.is_empty() {
            break;
        }
        for (id, e) in &bad {
            left_out(*id, e);
        }
        leave_out(&mut state, &bad.into_iter().map(|(id, _)| id).collect());
    }
    project(header, &state)
}

/// `state` without `ids`, the links with an end in them and their timers.
fn leave_out(state: &mut replica::effects::State, ids: &std::collections::BTreeSet<Id>) {
    if ids.is_empty() {
        return;
    }
    state.nodes.retain(|id, _| !ids.contains(id));
    state
        .links
        .retain(|_, l| !l.ends.iter().any(|e| ids.contains(e)));
    state.timers.retain(|_, t| !ids.contains(&t.node));
}

/// Logs a node the public stream leaves out, once per node a process (C5).
fn left_out(id: Id, e: &Refusal) {
    static LOGGED: std::sync::Mutex<std::collections::BTreeSet<Id>> =
        std::sync::Mutex::new(std::collections::BTreeSet::new());
    if LOGGED.lock().is_ok_and(|mut l| l.insert(id)) {
        eprintln!(
            "worldd: the public stream leaves out {}: {} ({})",
            replica::world_model::show(id),
            e.name,
            e.detail
        );
    }
}

/// The public place names a value's public nodes reference (#3574), under #3571's rule: a node of the public
/// audience whose name reference (its field 4, import-eden's 32-byte hash) is in the importer's dictionary with words
/// of exactly that hash. A node is one in the state layout (kind 1, audience 4, fields 5), as a baseline holds it, or
/// a create in a part's records (change 1, kind 3, audience 5, fields 6). Rows go after the K16 words in a text file
/// as `[hash, words]`, in hash order, each once; a node of any other audience, or a hash the dictionary's words do
/// not match, adds nothing.
fn public_names(
    value: &Value,
    names: &crate::views::names::PublicNames,
) -> BTreeMap<[u8; 32], Vec<u8>> {
    fn walk(
        v: &Value,
        names: &crate::views::names::PublicNames,
        out: &mut BTreeMap<[u8; 32], Vec<u8>>,
    ) {
        match v {
            Value::Map(m) => {
                let public = |k| matches!(m.get(&k), Some(Value::Map(a)) if a.len() == 1 && a.get(&1) == Some(&Value::Uint(1)));
                let node = matches!(m.get(&1), Some(Value::Text(_))) && public(4);
                let create = m.get(&1) == Some(&Value::Uint(1))
                    && matches!(m.get(&3), Some(Value::Text(_)))
                    && public(5);
                let fields = match (node, create) {
                    (true, _) => m.get(&5),
                    (_, true) => m.get(&6),
                    _ => None,
                };
                if let Some(Value::Map(fields)) = fields
                    && let Some(Value::Bytes(r)) = fields.get(&4)
                    && let Ok(key) = <[u8; 32]>::try_from(r.as_slice())
                    && let Some(text) = names
                        .get(&key)
                        .filter(|t| replica::ids::sha256(t.as_bytes()) == key)
                {
                    out.insert(key, text.as_bytes().to_vec());
                }
                m.values().for_each(|x| walk(x, names, out));
            }
            Value::Array(a) => a.iter().for_each(|x| walk(x, names, out)),
            _ => {}
        }
    }
    let mut out = BTreeMap::new();
    walk(value, names, &mut out);
    out
}

/// Public baseline stream plus exact immutable recovery records in the world's existing Store.
/// The caller owns this off-clock follower; no engine acknowledgement or checkpoint policy changes.
pub struct PublicWriter<S> {
    store: S,
    prefix: String,
    dir: PathBuf,
    root: PathBuf,
    header: Header,
    canonical: Replica,
    player: PublicPlayer,
    baseline: Vec<u8>,
    seed: Vec<u8>,
    head: Option<Vec<u8>>,
    etag: Option<String>,
    cursor: u64,
    chunk_start: u64,
    chunks: Vec<Vec<u8>>,
    records: Vec<Value>,
    duplicates: Vec<(u64, Id)>,
    changes: BTreeMap<Id, u64>,
    view: View,
    window: Option<i64>,
    last_to: Option<i64>,
    text: Option<Arc<Store>>,
    names: Option<Arc<crate::views::names::PublicNames>>,
    clock_seed: Option<Mapping>,
    migration_cut: Option<u64>,
    migration_state: Option<Value>,
    legacy: Option<(u64, u64, Vec<u8>)>,
    /// The generation this one took over from (#3825): `(old generation id, public version, its next part, digest)`.
    handoff: Option<(Vec<u8>, u64, u64, Vec<u8>)>,
    /// The recovery object holding the current generation's `baseline.text` (#3825).
    baseline_text: Vec<u8>,
    /// After how many parts a generation closes and the next starts from a fresh baseline (#3825; 0: never).
    /// Read from `SOULS_STREAM_GENERATION_PARTS` at open; the boundary is a part count, so a restart cuts at the same
    /// place. A rollover is recorded in the recovery chain, so a restart with another setting replays it exactly.
    pub generation_parts: u64,
    /// How long a generation older than the previous one is kept after its last file was written (#3825), so a live
    /// viewer can drain it. `SOULS_STREAM_PRUNE_GRACE_S`, default [`PRUNE_GRACE`].
    pub prune_grace: Duration,
    force_remainder: bool,
    /// Every recovery object the current generation's chain names (#3833): never deleted.
    live: std::collections::BTreeSet<Vec<u8>>,
    /// The records of the generations before this one still in the recovery store, newest first (#3833):
    /// `(record hash, when that generation closed, wall µs)`.
    closed: Vec<(Vec<u8>, i64)>,
    /// Recovery-store keys waiting to be deleted, a few after each part (#3833); none once the store refused one.
    deletes: std::collections::VecDeque<String>,
    deleting: bool,
    /// Off: every cut works out the public state whole (the reference the incremental cut is compared with, #3799).
    pub incremental: bool,
    /// Whether the open cut holds anything but motion and fields set on nodes; else the nodes it set (#3799).
    structural: bool,
    touched: std::collections::BTreeSet<Id>,
    /// The timers the open cut set or cleared (#3799).
    timers: std::collections::BTreeSet<Id>,
    /// The links the open cut made or ended, the transfers it began and the nodes they moved, with what is under
    /// them (#4192): a take or a sit, a leave and its arrive in the same cut, changes only these rows.
    links: std::collections::BTreeSet<Id>,
    left: std::collections::BTreeSet<Id>,
    moved: std::collections::BTreeSet<Id>,
    /// Cuts worked out whole since the writer opened (#4192).
    pub whole_cuts: u64,
    /// The references each node row of the published state holds, and those of the rest of it (#3799).
    /// Kept with the version of the state they are of.
    #[allow(clippy::type_complexity)]
    refs: Option<(
        u64,
        BTreeMap<Id, std::collections::BTreeSet<Id>>,
        std::collections::BTreeSet<Id>,
    )>,
    /// Where [`PublicWriter::idle`] last found the published state equal to the source's: the source's version and
    /// the published version and part count then (#3603). While all three stand nothing new can be public, so the
    /// whole tree is not projected again: on full Eden one projection is about 170 ms, and idle runs every 20 ms.
    still_at: Option<(u64, u64, u64)>,
    /// While [`PublicWriter::sleep`] writes its pointer: the next due change's world time, or none (#2731).
    asleep: Option<Option<Micros>>,
    /// The world's closed kinds (#3948) and the containers and things it follows them by, for the entries.
    closed_kinds: Closed,
    inside: Inside,
    /// Whether this generation keeps what closed containers hold out (#3948): its recovery seed's field 17. A stream
    /// begun before keeps it all until its next generation ([`PublicWriter::rollover`]).
    hides: bool,
}
use std::collections::BTreeMap;
/// What the public view reads of the source just before one entry (#3667): the parent chains of the nodes the entry
/// names, removes or sends away, and the one transfer it names, taken from the tree before the entry applies. The
/// writer's view is the full public view of the zone (checked at open), whose step reads nothing else before an entry.
struct Before {
    parents: BTreeMap<Id, Option<Id>>,
    flight: Option<(Id, replica::effects::Flight)>,
}

impl Before {
    fn of(tree: &replica::tree::Tree, entry: &Effect) -> Before {
        use replica::effects::TransferRec;
        use replica::views::Read as _;
        let mut parents = BTreeMap::new();
        let mut chain = |node: Id| {
            let mut at = Some(node);
            for _ in 0..=replica::world_model::DEPTH_LIMIT {
                let Some(n) = at else { break };
                if parents.contains_key(&n) {
                    break;
                }
                let Some(parent) = tree.parent_of(n) else {
                    break;
                };
                parents.insert(n, parent);
                at = parent;
            }
        };
        chain(entry.envelope.node);
        let transfer = match &entry.body {
            Body::Changes(cs) => {
                for c in cs {
                    if let Change::Remove { node } = &c.change {
                        chain(*node);
                    }
                }
                None
            }
            Body::Transfer(TransferRec::Leave { transfer, node, .. }) => {
                chain(*node);
                Some(*transfer)
            }
            Body::Transfer(
                TransferRec::Arrive { transfer, .. }
                | TransferRec::Return { transfer, .. }
                | TransferRec::Settle { transfer },
            ) => Some(*transfer),
            _ => None,
        };
        let flight = transfer.and_then(|t| tree.flight(t).map(|f| (t, f)));
        Before { parents, flight }
    }
}

impl replica::views::Read for Before {
    fn parent_of(&self, node: Id) -> Option<Option<Id>> {
        self.parents.get(&node).copied()
    }

    fn flight(&self, transfer: Id) -> Option<std::borrow::Cow<'_, replica::effects::Flight>> {
        self.flight
            .as_ref()
            .filter(|(t, _)| *t == transfer)
            .map(|(_, f)| std::borrow::Cow::Borrowed(f))
    }

    fn live(&self, _: Audience, _: Id) -> u64 {
        unreachable!("the public writer's full view counts nothing before an entry")
    }
}

fn stream_effect(header: &Header, value: Value) -> R<Effect> {
    let bytes = wire(Value::Map(BTreeMap::from([
        (1, Value::Bytes(header.hash().to_bytes())),
        (2, Value::Array(vec![value])),
    ])))?;
    Part::read(&bytes)?
        .effects
        .pop()
        .ok_or_else(|| fault("stream-frame", "missing effect"))
}
fn int(n: i64) -> Value {
    u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint)
}
fn wire(v: Value) -> R<Vec<u8>> {
    encode(&v).map_err(|e| fault("encoding", e.to_string()))
}
fn object_map(bytes: &[u8]) -> R<BTreeMap<u64, Value>> {
    match decode(bytes)
        .map_err(|e| fault("stream-recovery", e.to_string()))?
        .value
    {
        Value::Map(m) => Ok(m),
        _ => Err(fault("stream-recovery", "expected map")),
    }
}
fn obj_bytes(m: &BTreeMap<u64, Value>, k: u64) -> R<Vec<u8>> {
    match m.get(&k) {
        Some(Value::Bytes(b)) => Ok(b.clone()),
        _ => Err(fault("stream-recovery", "missing object bytes")),
    }
}
fn obj_uint(m: &BTreeMap<u64, Value>, k: u64) -> R<u64> {
    match m.get(&k) {
        Some(Value::Uint(n)) => Ok(*n),
        _ => Err(fault("stream-recovery", "missing object integer")),
    }
}
fn id_of(header: &Header) -> String {
    format!(
        "{}/{}-{}/{}",
        replica::encode::to_hex(&header.lineage.0),
        replica::encode::to_hex(&header.zone.scope().0),
        header.zone.counter(),
        header.epoch
    )
}
/// Writes `bytes` under `path` once (rule 4): whole and synced under `<name>.tmp`, then linked to its name, which fails
/// if the name exists. A writer killed mid-write leaves only its `.tmp`, which the next write of that name replaces; a
/// file under a final name is always whole. A name already written must hold the same bytes.
fn immutable(path: &Path, bytes: &[u8]) -> R<()> {
    if let Some(p) = path.parent() {
        fs::create_dir_all(p).map_err(io)?;
    }
    let same = |path: &Path| -> R<()> {
        let meta = fs::symlink_metadata(path).map_err(io)?;
        if !meta.is_file() || meta.file_type().is_symlink() || fs::read(path).map_err(io)? != bytes
        {
            return Err(fault("stream-immutable", "existing bytes differ"));
        }
        Ok(())
    };
    if path.exists() {
        return same(path);
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let written =
        fs::File::create(&tmp).and_then(|mut f| f.write_all(bytes).and_then(|_| f.sync_all()));
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(io(e));
    }
    let linked = fs::hard_link(&tmp, path);
    let _ = fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => same(path),
        Err(e) => Err(io(e)),
    }
}
pub struct PublicStart<'a> {
    pub root: &'a Path,
    pub header: &'a Header,
    pub key: Key,
    pub initial: Replica,
    pub record: u64,
    pub checkpoint: Option<Vec<u8>>,
    pub text: Option<Arc<Store>>,
    /// The importer's immutable name dictionary (#3571): its words go beside the public nodes that reference them.
    pub names: Option<Arc<crate::views::names::PublicNames>>,
    pub clock_seed: Option<Mapping>,
    pub history: Option<&'a sim::log::Recovered>,
}
impl PublicStart<'_> {
    /// Only the public legacy transition may choose an older retained source. The engine's newest restore stays
    /// unchanged; each eligible checkpoint is independently CRC/hash/root checked before it can become a base.
    pub fn earlier_legacy_checkpoint(&mut self, checkpoints: &Path) -> R<()> {
        let path = self
            .root
            .join(stream::dir(self.header, &self.key))
            .join(POINTER);
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(source_io("legacy pointer", e)),
        };
        if object_map(&bytes)
            .map_err(|e| source_invalid("legacy pointer map", e))?
            .contains_key(&8)
        {
            return Ok(());
        }
        let pointer = Pointer::read(&bytes).map_err(|e| source_invalid("legacy pointer", e))?;
        let header = fs::read(self.root.join(format!(
            "{}/headers/{}",
            id_of(self.header),
            replica::encode::to_hex(&pointer.header)
        )))
        .map_err(|e| source_io("legacy header bytes", e))?;
        let old =
            Header::read(&header).map_err(|e| source_invalid("legacy header validation", e))?;
        if old.lineage != self.header.lineage
            || old.zone != self.header.zone
            || old.epoch != self.header.epoch
        {
            return Err(fault(
                "stream-legacy-identity",
                "source selection header differs",
            ));
        }
        let mut reader = replica::stream::Player::start(&header)
            .map_err(|e| source_invalid("legacy header player", e))?;
        if let Some(last) = pointer.newest {
            for n in 0..=last {
                let bytes = fs::read(path.parent().expect("pointer parent").join(n.to_string()))
                    .map_err(|e| source_io("legacy part bytes", e))?;
                if reader
                    .play(&bytes)
                    .map_err(|e| source_invalid("legacy part validation", e))?
                    .hash
                    == Some(false)
                {
                    return Err(fault("stream-legacy-hash", "legacy part differs"));
                }
            }
        }
        let target = reader.replica().version();
        if self.initial.version() <= target {
            return Ok(());
        }
        let mut selected = None;
        for entry in
            fs::read_dir(checkpoints).map_err(|e| source_io("legacy checkpoint directory", e))?
        {
            let entry = entry.map_err(|e| source_io("legacy checkpoint entry", e))?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Some(number) = name
                .strip_prefix("ckpt-")
                .filter(|n| n.len() == 20 && n.bytes().all(|b| b.is_ascii_digit()))
            else {
                continue;
            };
            let Ok(number) = number.parse::<u64>() else {
                continue;
            };
            let meta = fs::symlink_metadata(entry.path())
                .map_err(|e| source_io("legacy checkpoint metadata", e))?;
            if !meta.is_file() || meta.file_type().is_symlink() {
                continue;
            }
            let bytes =
                fs::read(entry.path()).map_err(|e| source_io("legacy checkpoint bytes", e))?;
            let Ok(restored) = sim::checkpoint::read_bytes(&bytes) else {
                continue;
            };
            let v = restored.root.version;
            if restored.root.record != number
                || v.lineage != self.header.lineage
                || v.zone != self.header.zone
                || v.epoch != self.header.epoch
                || v.sequence > target
                || restored.tree.next() != v.sequence
            {
                continue;
            }
            let state = restored.tree.to_state();
            if state
                .nodes
                .values()
                .chain(state.in_flight.values().flat_map(|f| f.nodes.values()))
                .any(|n| !self.header.kinds.contains(&n.kind))
            {
                continue;
            }
            if selected
                .as_ref()
                .is_none_or(|(seq, _, _, _)| v.sequence > *seq)
            {
                selected = Some((v.sequence, number, restored.tree, bytes));
            }
        }
        let Some((sequence, record, tree, bytes)) = selected else {
            return Err(fault(
                "stream-legacy-source-missing",
                "no eligible earlier canonical checkpoint",
            ));
        };
        self.initial = Replica::restored(self.header.clone(), tree, sequence);
        self.record = record;
        self.checkpoint = Some(bytes);
        Ok(())
    }
}
impl<S: ObjectStore> PublicWriter<S> {
    fn put(&self, bytes: &[u8]) -> R<Vec<u8>> {
        let hash = replica::ids::sha256(bytes).to_vec();
        let key = format!("{}objects/{}", self.prefix, replica::encode::to_hex(&hash));
        match self.store.put(&key, bytes, When::Absent) {
            Ok(_) => {}
            Err(e) if e.name == "precondition-failed" => {
                if self.store.get(&key)?.is_none_or(|o| o.bytes != bytes) {
                    return Err(fault("stream-immutable", "store bytes differ"));
                }
            }
            Err(e) => return Err(e),
        }
        Ok(hash)
    }
    fn get(&self, hash: &[u8]) -> R<Vec<u8>> {
        if hash.len() != 32 {
            return Err(fault("stream-recovery", "invalid object hash"));
        }
        let key = format!("{}objects/{}", self.prefix, replica::encode::to_hex(hash));
        let bytes = self
            .store
            .get(&key)?
            .ok_or_else(|| fault("stream-recovery-missing", "required immutable object"))?
            .bytes;
        if replica::ids::sha256(&bytes).as_slice() != hash {
            return Err(fault(
                "stream-recovery-hash",
                "object does not match its name",
            ));
        }
        Ok(bytes)
    }
    /// `checkpoint` is the exact selected canonical K5 file, or none only for an ordinary root at record zero.
    /// Existing recovery state wins over a newer supplied checkpoint; its header/identity must match.
    pub fn open(start: PublicStart<'_>, store: S) -> R<Self> {
        Self::open_hiding(start, store, Closed::default())
    }
    /// [`PublicWriter::open`] for a world whose kinds declare `closed` (#3948): what such a container holds is kept
    /// out of the stream, its state and its entries, until it is taken out.
    pub fn open_hiding(start: PublicStart<'_>, store: S, closed: Closed) -> R<Self> {
        let PublicStart {
            root,
            header,
            key,
            initial,
            record,
            checkpoint,
            text,
            names,
            clock_seed,
            history,
        } = start;
        if key.node != header.zone
            || key.audience != Audience::Everyone
            || key.level != replica::views::Level::Full
        {
            return Err(fault("public-stream-key", "requires the full public root"));
        }
        if initial.header().stored() != header.stored() {
            return Err(fault("header-mismatch", "stream initial header"));
        }
        let baseline = replica::stream::public::baseline_from_projection(
            header,
            shown(header, Some(&closed), initial.tree())?,
            record,
        )?;
        let player = PublicPlayer::start(header.stored(), &baseline)?;
        let mut inside = Inside::new(&closed);
        inside.seed(initial.tree());
        let prefix = format!("stream-recovery/{}/", id_of(header));
        let dir = root.join(stream::dir(header, &key));
        let mut w = Self {
            store,
            prefix,
            dir,
            root: root.to_owned(),
            header: header.clone(),
            canonical: initial,
            player,
            baseline,
            seed: Vec::new(),
            head: None,
            etag: None,
            cursor: record,
            chunk_start: record,
            chunks: Vec::new(),
            records: Vec::new(),
            duplicates: Vec::new(),
            changes: BTreeMap::new(),
            view: View::new(key, header, &Redactions::default()),
            window: None,
            last_to: None,
            text,
            names,
            clock_seed,
            migration_cut: None,
            migration_state: None,
            legacy: None,
            handoff: None,
            baseline_text: Vec::new(),
            generation_parts: env_u64("SOULS_STREAM_GENERATION_PARTS").unwrap_or(GENERATION_PARTS),
            prune_grace: Duration::from_secs(
                env_u64("SOULS_STREAM_PRUNE_GRACE_S").unwrap_or(PRUNE_GRACE.as_secs()),
            ),
            force_remainder: false,
            live: std::collections::BTreeSet::new(),
            closed: Vec::new(),
            deletes: std::collections::VecDeque::new(),
            deleting: true,
            // SOULS_STREAM_WHOLE set: every cut worked out whole, the reference a recorded log is compared with.
            incremental: std::env::var_os("SOULS_STREAM_WHOLE").is_none(),
            structural: true,
            touched: std::collections::BTreeSet::new(),
            timers: std::collections::BTreeSet::new(),
            links: std::collections::BTreeSet::new(),
            left: std::collections::BTreeSet::new(),
            moved: std::collections::BTreeSet::new(),
            whole_cuts: 0,
            refs: None,
            still_at: None,
            asleep: None,
            closed_kinds: closed,
            inside,
            hides: true,
        };
        if let Some(head) = w.store.get(&format!("{}head", w.prefix))? {
            let h = object_map(&head.bytes)?;
            let hash = obj_bytes(&h, 1)?;
            w.etag = Some(head.etag);
            w.recover(&hash)?;
            w.head = Some(hash);
        } else {
            if record != 0 && checkpoint.is_none() {
                return Err(fault(
                    "stream-recovery-checkpoint",
                    "a nonzero source needs a checkpoint",
                ));
            }
            if let Some(bytes) = &checkpoint {
                let restored = sim::checkpoint::read_bytes(bytes)?;
                if restored.root.record != record
                    || restored.root.version.sequence != w.canonical.version()
                    || restored.root.version.lineage != header.lineage
                    || restored.root.version.zone != header.zone
                    || restored.tree.to_state() != w.canonical.tree().to_state()
                {
                    return Err(fault(
                        "stream-recovery-checkpoint",
                        "source checkpoint differs",
                    ));
                }
            }
            let mut bootstrap = Vec::new();
            let mut legacy_files = Vec::new();
            let mut legacy_header = Vec::new();
            if w.dir.join(POINTER).exists() {
                let pointer = fs::read(w.dir.join(POINTER)).map_err(io)?;
                if object_map(&pointer)?.contains_key(&8) {
                    return Err(fault(
                        "stream-recovery-missing",
                        "public pointer has no recovery head",
                    ));
                }
                let old = Pointer::read(&pointer)?;
                let old_header = fs::read(w.root.join(format!(
                    "{}/headers/{}",
                    id_of(header),
                    replica::encode::to_hex(&old.header)
                )))
                .map_err(io)?;
                let oh = Header::read(&old_header)?;
                if oh.lineage != header.lineage
                    || oh.zone != header.zone
                    || oh.epoch != header.epoch
                    || oh.kinds.iter().collect::<std::collections::BTreeSet<_>>()
                        != header.kinds.iter().collect()
                {
                    return Err(fault("stream-legacy-identity", "legacy header differs"));
                }
                let mut reader = replica::stream::Player::start(&old_header)?;
                if let Some(last) = old.newest {
                    for n in 0..=last {
                        let bytes = fs::read(w.dir.join(n.to_string())).map_err(io)?;
                        let played = reader.play(&bytes)?;
                        legacy_files.push(Value::Array(vec![
                            Value::Text(Name::new(&n.to_string()).expect("part name")),
                            Value::Bytes(w.put(&bytes)?),
                        ]));
                        let file = format!("{n}.text");
                        match fs::read(w.dir.join(&file)) {
                            Ok(bytes) => legacy_files.push(Value::Array(vec![
                                Value::Text(Name::new(&file).expect("text name")),
                                Value::Bytes(w.put(&bytes)?),
                            ])),
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                            Err(e) => return Err(io(e)),
                        };
                        if played.hash == Some(false) {
                            return Err(fault("stream-legacy-hash", "legacy part hash differs"));
                        }
                    }
                }
                legacy_header = old_header.clone();
                // A legacy stream holds what closed containers hold (#3948): kept until its next generation.
                w.hides = false;
                let target = reader.replica().version();
                let expected = project(header, &reader.replica().tree().to_state())?;
                if w.canonical.version() > target {
                    return Err(fault(
                        "stream-legacy-source-missing",
                        "source checkpoint is newer than precise legacy terminal",
                    ));
                }
                w.migration_cut = Some(target);
                if w.canonical.version() == target {
                    w.migration_state = Some(w.shown(w.canonical.tree())?);
                }
                let history = history.ok_or_else(|| {
                    fault(
                        "stream-legacy-source-missing",
                        "canonical original records required",
                    )
                })?;
                if w.migration_state.is_none() {
                    w.bridge_to(history.first)?;
                }
                for (offset, raw) in history.records.iter().enumerate() {
                    let n = history.first + offset as u64;
                    if n < w.cursor {
                        continue;
                    }
                    if w.migration_state.is_some() {
                        break;
                    }
                    w.apply_record(n, raw)?;
                }
                let prefix = w.migration_state.take().ok_or_else(|| {
                    fault(
                        "stream-legacy-source-missing",
                        "legacy terminal is not in validated source",
                    )
                })?;
                if prefix != expected {
                    return Err(fault(
                        "stream-legacy-state",
                        "actual legacy public terminal differs from canonical prefix",
                    ));
                }
                // The whole original Part was validated before this prefix was selected. The source-applied cursor
                // is complete; baseline/public cursor may precede its retained genuine remainder.
                let public_record = if w.cursor > record {
                    w.cursor - 1
                } else {
                    record
                };
                w.baseline = replica::stream::public::baseline_from_projection(
                    header,
                    prefix,
                    public_record,
                )?;
                w.player = PublicPlayer::start(header.stored(), &w.baseline)?;
                w.legacy = Some((target, reader.next(), digest(&expected)?));
                w.force_remainder = w.canonical.version() > target;
                bootstrap = std::mem::take(&mut w.chunks);
                w.chunk_start = w.cursor;
            }
            let legacy = w
                .legacy
                .as_ref()
                .map(|(v, n, h)| {
                    Value::Array(vec![
                        Value::Uint(*v),
                        Value::Uint(*n),
                        Value::Bytes(h.clone()),
                    ])
                })
                .unwrap_or(Value::Array(Vec::new()));
            let mut seed = BTreeMap::from([
                (1, Value::Bytes(header.stored().to_vec())),
                (2, Value::Bytes(checkpoint.unwrap_or_default())),
                (3, Value::Uint(record)),
                (4, Value::Bytes(w.baseline.clone())),
                (
                    5,
                    Value::Array(bootstrap.iter().map(|b| Value::Bytes(b.clone())).collect()),
                ),
                (6, legacy),
                (7, Value::Array(legacy_files)),
                (8, Value::Bytes(legacy_header)),
                (
                    9,
                    Value::Bytes(w.put(&w.words(w.player.state(), w.player.state())?)?),
                ),
            ]);
            if w.hides {
                seed.insert(17, Value::Uint(1));
            }
            let seed = wire(Value::Map(seed))?;
            w.baseline_text = obj_bytes(&object_map(&seed)?, 9)?;
            w.seed = w.put(&seed)?;
            let manifest = wire(Value::Map(BTreeMap::from([
                (1, Value::Bytes(w.seed.clone())),
                (2, Value::Bytes(Vec::new())),
                (3, Value::Bytes(Vec::new())),
                (4, Value::Uint(0)),
                (5, Value::Bytes(Vec::new())),
                (6, Value::Bytes(Vec::new())),
                (7, Value::Uint(w.cursor)),
            ])))?;
            w.commit(&manifest)?;
        }
        immutable(&w.root.join(stream::header_path(header)), header.stored())?;
        immutable(&w.generation_dir().join("baseline"), &w.baseline)?;
        immutable(
            &w.generation_dir().join("baseline.text"),
            &w.get(&w.baseline_text)?,
        )?;
        w.closed_generations();
        // A writer stopped between a generation's last part and its rollover rolls over now, at the same place.
        if w.rollover_due() {
            w.rollover()?;
        }
        w.prune();
        w.prune_store();
        w.pointer(None)?;
        Ok(w)
    }
    /// The words file of a cut (#3799): the references of the state after it and of its records, as
    /// [`PublicWriter::words`] finds them in the two whole, each node row's kept from the last cut that set it.
    /// `whole_delta`, with a whole `after`: the rows of `after` that differ from the published state (the context's
    /// delta), so the index of the published state is brought up to date from them rather than rebuilt (#4192).
    fn words_after(
        &mut self,
        after: Option<&Value>,
        delta: Option<&Value>,
        whole_delta: Option<&Value>,
    ) -> R<Vec<u8>> {
        if self.text.is_none() {
            // No text store: no reference words to keep, but a part's own place names are still published (#3574).
            return self.words_of(
                std::collections::BTreeSet::new(),
                &Value::Array(self.records.clone()),
            );
        }
        let row_refs = |row: &Value| -> R<(Id, std::collections::BTreeSet<Id>)> {
            let Value::Array(p) = row else {
                return Err(fault("stream-words", "a row is a pair"));
            };
            let id = replica::effects::read_id(&p[0])?;
            Ok((id, replica::audience::references(&p[1])))
        };
        // From a whole state: the one after a whole cut, or the one before the first cut by rows.
        let version = |v: &Value| match v {
            Value::Map(m) => match m.get(&1) {
                Some(Value::Uint(n)) => *n,
                _ => u64::MAX,
            },
            _ => u64::MAX,
        };
        let stale = self
            .refs
            .as_ref()
            .is_none_or(|r| r.0 != self.player.version());
        if let (Some(after), Some(Value::Map(d)), false) = (after, whole_delta, stale) {
            // The node rows from the delta (a removed node is a row of its id alone), the rest of the state's
            // references read field by field, never copying the node rows.
            let Value::Map(a) = after else {
                return Err(fault("stream-words", "a state is a map"));
            };
            let changed: &[Value] = match d.get(&2) {
                Some(Value::Array(c)) => c,
                _ => &[],
            };
            let Some((at, rows, rest)) = &mut self.refs else {
                unreachable!("not stale")
            };
            for row in changed {
                let Value::Array(p) = row else {
                    return Err(fault("stream-words", "a row is a pair"));
                };
                let id = replica::effects::read_id(&p[0])?;
                let r = match p.get(1) {
                    Some(v) => replica::audience::references(v),
                    None => Default::default(),
                };
                if r.is_empty() {
                    rows.remove(&id);
                } else {
                    rows.insert(id, r);
                }
            }
            *rest = a
                .iter()
                .filter(|(k, _)| **k != 2)
                .flat_map(|(_, v)| replica::audience::references(v))
                .collect();
            *at = version(after);
        } else if after.is_some() || stale {
            let whole = after.unwrap_or(self.player.state());
            let at = version(whole);
            let Value::Map(mut m) = whole.clone() else {
                return Err(fault("stream-words", "a state is a map"));
            };
            let mut rows = BTreeMap::new();
            if let Some(Value::Array(nodes)) = m.remove(&2) {
                for row in &nodes {
                    let (id, r) = row_refs(row)?;
                    if !r.is_empty() {
                        rows.insert(id, r);
                    }
                }
            }
            self.refs = Some((at, rows, replica::audience::references(&Value::Map(m))));
        }
        if after.is_none()
            && let (Some((at, rows, rest)), Some(d)) = (&mut self.refs, delta)
        {
            *at = version(d);
            let Value::Map(d) = d else {
                return Err(fault("stream-words", "a delta is a map"));
            };
            // Links or timers changed (#4192): the rest of the state's references, read again from the published
            // state with the delta's rows of them in place. The node rows are not copied.
            if d.contains_key(&3) || d.contains_key(&6) {
                let Value::Map(st) = self.player.state() else {
                    return Err(fault("stream-words", "a state is a map"));
                };
                let mut m: BTreeMap<u64, Value> = st
                    .iter()
                    .filter(|(k, _)| **k != 2)
                    .map(|(k, v)| (*k, v.clone()))
                    .collect();
                for k in [3, 6] {
                    let (Some(Value::Array(rows)), Some(Value::Array(old))) =
                        (d.get(&k), m.get(&k))
                    else {
                        continue;
                    };
                    // The order of the rows does not matter to a set of references.
                    let mut by = BTreeMap::new();
                    for r in old.iter().chain(rows) {
                        let Value::Array(p) = r else {
                            return Err(fault("stream-words", "a row is a pair"));
                        };
                        let id = replica::effects::read_id(&p[0])?;
                        match p.get(1) {
                            Some(v) => by.insert(id, Value::Array(vec![p[0].clone(), v.clone()])),
                            None => by.remove(&id),
                        };
                    }
                    m.insert(k, Value::Array(by.into_values().collect()));
                }
                *rest = replica::audience::references(&Value::Map(m));
            }
            let changed: &[Value] = match d.get(&2) {
                Some(Value::Array(c)) => c,
                _ => &[],
            };
            for row in changed {
                let (id, r) = row_refs(row)?;
                if r.is_empty() {
                    rows.remove(&id);
                } else {
                    rows.insert(id, r);
                }
            }
        }
        let Some((_, rows, rest)) = &self.refs else {
            unreachable!("kept above")
        };
        let mut all = rest.clone();
        all.extend(rows.values().flatten().copied());
        all.extend(replica::audience::references(&Value::Array(
            self.records.clone(),
        )));
        // A part's names are those its own records create; the baseline's text holds the rest (#3574).
        self.words_of(all, &Value::Array(self.records.clone()))
    }
    fn words(&self, value: &Value, named: &Value) -> R<Vec<u8>> {
        self.words_of(replica::audience::references(value), named)
    }
    fn words_of(&self, refs: std::collections::BTreeSet<Id>, named: &Value) -> R<Vec<u8>> {
        let words = if let Some(store) = &self.text {
            refs.into_iter()
                .filter_map(|r| {
                    store
                        .read(r, &[])
                        .ok()
                        .map(|w| Value::Array(vec![r.to_value(), Value::Bytes(w)]))
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut words = words;
        if let Some(names) = &self.names {
            words.extend(public_names(named, names).into_iter().map(|(key, text)| {
                Value::Array(vec![Value::Bytes(key.to_vec()), Value::Bytes(text)])
            }));
        }
        wire(Value::Array(words))
    }
    fn generation_dir(&self) -> PathBuf {
        self.dir
            .join("g")
            .join(replica::encode::to_hex(&replica::ids::sha256(
                &self.baseline,
            )))
    }
    pub fn source_cursor(&self) -> u64 {
        self.cursor
    }
    /// Records `..durable_cursor()` are in published parts: a reopen needs the log from here on (#3837).
    pub fn durable_cursor(&self) -> u64 {
        self.chunk_start
    }
    /// Whether the current generation is full and nothing is open (#3825).
    fn rollover_due(&self) -> bool {
        self.generation_parts > 0
            && self.player.next() >= self.generation_parts
            && self.chunks.is_empty()
            && !self.force_remainder
    }
    /// The sequences of `part`'s entries that put a thing into a closed container or touch one in it, as the view
    /// hub keeps them to their actor (#3915, [`Inside`]): the public is nobody's, so they are left out (#3948). Each
    /// part is followed once, in order, whether or not this generation keeps them out.
    fn kept_out(&mut self, part: &Part) -> std::collections::BTreeSet<u64> {
        let mut out = std::collections::BTreeSet::new();
        for e in &part.effects {
            if self.inside.apply(e) && self.hides {
                out.insert(e.envelope.sequence);
            }
        }
        out
    }
    /// The public projection of `tree` by this generation's rule (#3948).
    fn shown(&self, tree: &replica::tree::Tree) -> R<Value> {
        shown(&self.header, self.hides.then_some(&self.closed_kinds), tree)
    }
    /// Whether node `id` of `tree` is kept out of this generation as in a closed container (#3948).
    fn hidden(&self, tree: &replica::tree::Tree, id: Id) -> bool {
        self.hides && self.closed_kinds.hides(tree, id)
    }
    /// The next generation's baseline: the public state now, at the source cursor (#3825).
    fn generation_baseline(&self) -> R<Vec<u8>> {
        replica::stream::public::baseline_from_projection(
            &self.header,
            self.player.state().clone(),
            self.cursor,
        )
    }
    /// Starts the next generation from `baseline` (#3825), keeping how a live viewer crosses over: the old
    /// generation, the public version and part count it ends at, and its state's digest, which the new baseline's is.
    fn next_generation(&mut self, baseline: Vec<u8>, text: Vec<u8>, switch: bool) -> R<()> {
        let handoff = (
            replica::ids::sha256(&self.baseline).to_vec(),
            self.player.version(),
            self.player.next(),
            self.player.hash()?,
        );
        let player = PublicPlayer::start(self.header.stored(), &baseline)?;
        // A generation that begins to keep closed contents out (#3948) holds less than the last: no hand-off, so a
        // viewer starts again from its baseline, as a new viewer does.
        let handoff = (player.hash()? == handoff.3).then_some(handoff);
        if handoff.is_none() && !switch {
            return Err(fault("stream-rollover", "baseline digest differs"));
        }
        self.baseline = baseline;
        self.player = player;
        self.baseline_text = text;
        self.handoff = handoff;
        self.legacy = None;
        self.migration_cut = None;
        Ok(())
    }
    /// Closes the current generation and starts the next one from the public state now (#3825). The rollover is
    /// committed to the recovery store first, then the new generation's baseline files are written; the pointer that
    /// names it is written after them by the caller. World time and the source cursor are untouched.
    ///
    /// The new generation's recovery chain starts afresh (#3833): its seed holds the canonical copy and what the
    /// writer carries at this place, so a restart reads only the newest generation. A record of the closed chain's
    /// objects is kept beside it, for [`PublicWriter::prune_store`].
    fn rollover(&mut self) -> R<()> {
        let number = self.player.next();
        // A generation begun before #3948 keeps closed contents out from the next one on: its baseline is the state
        // with them left out, and, when that differs from the last state, it has no hand-off.
        let switch = !self.hides;
        let (baseline, state) = if switch {
            let state = shown(
                &self.header,
                Some(&self.closed_kinds),
                self.canonical.tree(),
            )?;
            let baseline = replica::stream::public::baseline_from_projection(
                &self.header,
                state.clone(),
                self.cursor,
            )?;
            (baseline, state)
        } else {
            (self.generation_baseline()?, self.player.state().clone())
        };
        // A new generation's baseline text holds every public name, as the first baseline's does (#3574).
        let words = self.words(&state, &state)?;
        let text = self.put(&words)?;
        let closed_at = crate::answers::now();
        let record = self.put(&wire(Value::Map(BTreeMap::from([
            (
                1,
                Value::Bytes(self.closed.first().map(|c| c.0.clone()).unwrap_or_default()),
            ),
            (2, int(closed_at)),
            (
                3,
                Value::Array(self.live.iter().map(|h| Value::Bytes(h.clone())).collect()),
            ),
        ])))?)?;
        let handoff = self.handoff_now()?;
        let crosses = PublicPlayer::start(self.header.stored(), &baseline)?.hash()? == handoff.3;
        self.hides = true;
        let seed = self.generation_seed(&baseline, &text, crosses.then_some(&handoff), &record)?;
        let seed_hash = self.put(&seed)?;
        let manifest = wire(Value::Map(BTreeMap::from([
            (1, Value::Bytes(seed_hash.clone())),
            (2, Value::Bytes(Vec::new())),
            (3, Value::Bytes(Vec::new())),
            (4, Value::Uint(number)),
            (5, Value::Bytes(Vec::new())),
            (6, Value::Bytes(Vec::new())),
            (7, Value::Uint(self.cursor)),
        ])))?;
        let live = std::mem::take(&mut self.live);
        self.live = [seed_hash.clone(), text.clone()].into();
        if let Err(e) = self.commit(&manifest) {
            self.live = live;
            self.hides = !switch;
            return Err(e);
        }
        self.seed = seed_hash;
        self.closed.insert(0, (record, closed_at));
        self.next_generation(baseline, text, switch)?;
        immutable(&self.generation_dir().join("baseline"), &self.baseline)?;
        immutable(&self.generation_dir().join("baseline.text"), &words)?;
        self.prune();
        self.prune_store();
        Ok(())
    }
    /// How a live viewer crosses from the current generation (#3825): its id, the public version and part count it
    /// ends at, and its state's digest.
    fn handoff_now(&self) -> R<(Vec<u8>, u64, u64, Vec<u8>)> {
        Ok((
            replica::ids::sha256(&self.baseline).to_vec(),
            self.player.version(),
            self.player.next(),
            self.player.hash()?,
        ))
    }
    /// A generation's recovery seed (#3833): the fields of the first seed (`1` header, `3` source cursor, `4`
    /// baseline, `9` its words; no checkpoint, bootstrap or legacy), and what the writer carries at the rollover: `10`
    /// the canonical tree as a checkpoint's records `{1: [[audience, state hash], ...], 2: [[hash, record], ...]}`,
    /// `11` its version, `12` each node's last change `[[id, version], ...]`, `13` the public view's carried state,
    /// `14` the hand-off `[old generation, public version, its next part, digest]`, `15` the last part's end, `16`
    /// the record of the chain it closed.
    fn generation_seed(
        &self,
        baseline: &[u8],
        text: &[u8],
        handoff: Option<&(Vec<u8>, u64, u64, Vec<u8>)>,
        record: &[u8],
    ) -> R<Vec<u8>> {
        let sealed = self.canonical.tree().seal_whole()?;
        let audience = |a: Audience| match a {
            Audience::Everyone => Value::Map(BTreeMap::from([(1, Value::Uint(1))])),
            Audience::Of(id) => {
                Value::Map(BTreeMap::from([(1, Value::Uint(2)), (2, id.to_value())]))
            }
        };
        let tree = Value::Map(BTreeMap::from([
            (
                1,
                Value::Array(
                    sealed
                        .audiences
                        .iter()
                        .map(|(a, h, _)| {
                            Value::Array(vec![audience(*a), Value::Bytes(h.to_bytes())])
                        })
                        .collect(),
                ),
            ),
            (
                2,
                Value::Array(
                    sealed
                        .audiences
                        .into_iter()
                        .map(|(_, h, b)| (h, b))
                        .chain(sealed.nodes)
                        .map(|(h, b)| {
                            Value::Array(vec![Value::Bytes(h.to_bytes()), Value::Bytes(b)])
                        })
                        .collect(),
                ),
            ),
        ]));
        let mut m = BTreeMap::from([
            (1, Value::Bytes(self.header.stored().to_vec())),
            (2, Value::Bytes(Vec::new())),
            (3, Value::Uint(self.cursor)),
            (4, Value::Bytes(baseline.to_vec())),
            (5, Value::Array(Vec::new())),
            (6, Value::Array(Vec::new())),
            (7, Value::Array(Vec::new())),
            (8, Value::Bytes(Vec::new())),
            (9, Value::Bytes(text.to_vec())),
            (10, tree),
            (11, Value::Uint(self.canonical.version())),
            (
                12,
                Value::Array(
                    self.canonical
                        .changed_at()
                        .iter()
                        .map(|(id, v)| Value::Array(vec![id.to_value(), Value::Uint(*v)]))
                        .collect(),
                ),
            ),
            (13, self.view.carried()),
            (
                14,
                Value::Array(handoff.map_or_else(Vec::new, |h| {
                    vec![
                        Value::Bytes(h.0.clone()),
                        Value::Uint(h.1),
                        Value::Uint(h.2),
                        Value::Bytes(h.3.clone()),
                    ]
                })),
            ),
            (16, Value::Bytes(record.to_vec())),
        ]);
        if self.hides {
            m.insert(17, Value::Uint(1));
        }
        if let Some(to) = self.last_to {
            m.insert(15, int(to));
        }
        wire(Value::Map(m))
    }
    /// Takes back what a generation's seed carries (#3833; [`PublicWriter::generation_seed`]).
    fn carry(&mut self, seed: &BTreeMap<u64, Value>) -> R<Replica> {
        let bad = |what: &str| fault("stream-recovery", format!("generation seed: {what}"));
        let Some(Value::Map(tree)) = seed.get(&10) else {
            return Err(bad("tree"));
        };
        let (Some(Value::Array(tops)), Some(Value::Array(records))) = (tree.get(&1), tree.get(&2))
        else {
            return Err(bad("tree fields"));
        };
        let mut audiences = Vec::new();
        for top in tops {
            let Value::Array(p) = top else {
                return Err(bad("audience"));
            };
            let [Value::Map(a), Value::Bytes(h)] = p.as_slice() else {
                return Err(bad("audience"));
            };
            let a = match (a.get(&1), a.get(&2)) {
                (Some(Value::Uint(1)), None) => Audience::Everyone,
                (Some(Value::Uint(2)), Some(id)) => Audience::Of(replica::effects::read_id(id)?),
                _ => return Err(bad("audience")),
            };
            audiences.push((a, h.clone()));
        }
        let mut stored = BTreeMap::new();
        for r in records {
            let Value::Array(p) = r else {
                return Err(bad("record"));
            };
            let [Value::Bytes(h), Value::Bytes(b)] = p.as_slice() else {
                return Err(bad("record"));
            };
            stored.insert(h.clone(), b.clone());
        }
        let tree = replica::tree::Tree::unseal(&audiences, &mut |h| {
            stored
                .get(h)
                .cloned()
                .ok_or_else(|| fault("stream-recovery", "generation seed: a record is missing"))
        })?;
        let Some(Value::Array(changed)) = seed.get(&12) else {
            return Err(bad("versions"));
        };
        let mut changed_at = BTreeMap::new();
        for c in changed {
            let Value::Array(p) = c else {
                return Err(bad("version"));
            };
            let [id, Value::Uint(v)] = p.as_slice() else {
                return Err(bad("version"));
            };
            changed_at.insert(replica::effects::read_id(id)?, *v);
        }
        let canonical =
            Replica::restored_at(self.header.clone(), tree, obj_uint(seed, 11)?, changed_at);
        self.view.carry(seed.get(&13).ok_or_else(|| bad("view"))?)?;
        let Some(Value::Array(h)) = seed.get(&14) else {
            return Err(bad("hand-off"));
        };
        // None when the generation began to keep closed contents out (#3948).
        self.handoff = match h.as_slice() {
            [] => None,
            [
                Value::Bytes(from),
                Value::Uint(version),
                Value::Uint(next),
                Value::Bytes(hash),
            ] => Some((from.clone(), *version, *next, hash.clone())),
            _ => return Err(bad("hand-off")),
        };
        self.last_to = match seed.get(&15) {
            None => None,
            Some(Value::Uint(u)) => Some(i64::try_from(*u).map_err(|_| bad("last end"))?),
            Some(Value::Nint(n)) => Some(-1 - i64::try_from(*n).map_err(|_| bad("last end"))?),
            Some(_) => return Err(bad("last end")),
        };
        Ok(canonical)
    }
    /// The records of the closed generations still in the recovery store, from the current seed back (#3833).
    /// Best effort: a record that cannot be read ends the list, and its generation's objects are left where they are.
    fn closed_generations(&mut self) {
        self.closed.clear();
        let Ok(seed) = self.get(&self.seed).and_then(|b| object_map(&b)) else {
            return;
        };
        let mut at = match seed.get(&16) {
            Some(Value::Bytes(h)) => h.clone(),
            _ => return,
        };
        while !at.is_empty() && self.closed.iter().all(|c| c.0 != at) {
            let Ok(r) = self.get(&at).and_then(|b| object_map(&b)) else {
                break;
            };
            let closed = match r.get(&2) {
                Some(Value::Uint(u)) => i64::try_from(*u).unwrap_or(i64::MAX),
                _ => break,
            };
            self.closed.push((at, closed));
            at = match r.get(&1) {
                Some(Value::Bytes(h)) => h.clone(),
                _ => break,
            };
        }
    }
    /// Queues for deletion the recovery chains of the generations before the previous one that closed longer than
    /// the grace ago (#3833), as [`PublicWriter::prune`] removes their files: each chain's objects the current chain
    /// does not name, then the record that lists them, oldest generation first. A restart reads only the current
    /// chain; the grace leaves time to look into a recent one.
    fn prune_store(&mut self) {
        if !self.deleting || !self.deletes.is_empty() {
            return;
        }
        let now = crate::answers::now();
        let grace = i64::try_from(self.prune_grace.as_micros()).unwrap_or(i64::MAX);
        let keep = self
            .closed
            .iter()
            .enumerate()
            .position(|(i, c)| i > 0 && now.saturating_sub(c.1) >= grace)
            .unwrap_or(self.closed.len());
        let gone = self.closed.split_off(keep);
        for (record, _) in gone.iter().rev() {
            let Ok(r) = self.get(record).and_then(|b| object_map(&b)) else {
                continue;
            };
            if let Some(Value::Array(objects)) = r.get(&3) {
                for o in objects {
                    if let Value::Bytes(h) = o
                        && !self.live.contains(h)
                    {
                        self.deletes.push_back(self.object_key(h));
                    }
                }
            }
            self.deletes.push_back(self.object_key(record));
        }
    }
    fn object_key(&self, hash: &[u8]) -> String {
        format!("{}objects/{}", self.prefix, replica::encode::to_hex(hash))
    }
    /// Deletes up to `n` queued recovery objects (#3833). A store that cannot delete is left as it is.
    fn delete_some(&mut self, n: usize) {
        for _ in 0..n {
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
    /// Removes the generations before the previous one whose last write is older than the grace (#3825). The
    /// current and the previous generation are always kept, so a live viewer can drain the one it is on. Best effort:
    /// a generation that cannot be read or removed now is tried again at the next rollover or start.
    fn prune(&self) {
        let keep: Vec<String> = std::iter::once(replica::ids::sha256(&self.baseline).to_vec())
            .chain(self.handoff.as_ref().map(|h| h.0.clone()))
            .map(|h| replica::encode::to_hex(&h))
            .collect();
        let Ok(entries) = fs::read_dir(self.dir.join("g")) else {
            return;
        };
        let now = crate::answers::now();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if keep.contains(&name) {
                continue;
            }
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|t| i64::try_from(t.as_micros()).ok())
                .is_some_and(|at| {
                    now.saturating_sub(at)
                        >= i64::try_from(self.prune_grace.as_micros()).unwrap_or(i64::MAX)
                });
            if old {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    /// A newest-only O3 restore may begin after the observer's last publication. Recover the intervening actual
    /// immutable pieces through the existing takeover-aware reader; never jump to a newer checkpoint's state.
    pub fn bridge_to(&mut self, target: u64) -> R<()> {
        if self.cursor >= target {
            return Ok(());
        }
        let key = replica::directory::WorldRecord::key(&self.header.lineage.0, self.header.zone);
        let object = self.store.get(&key)?.ok_or_else(|| {
            fault(
                "stream-recovery-source-missing",
                "world source directory record",
            )
        })?;
        let authority = replica::directory::WorldRecord::read(&object.bytes)?;
        let prefix = format!("part/{}/", key.trim_start_matches("world/"));
        let keys = self.store.list(&prefix)?;
        while self.cursor < target {
            let mut found = None;
            for key in &keys {
                let bytes = self
                    .store
                    .get(key)?
                    .ok_or_else(|| {
                        fault("stream-recovery-source-missing", "source piece disappeared")
                    })?
                    .bytes;
                let piece = crate::shipping::Piece::read(&bytes)?;
                if piece.first <= self.cursor
                    && self.cursor < piece.first + piece.records.len() as u64
                    && let Some((_, actual, _)) =
                        crate::shipping::piece_at(&self.store, &authority, piece.first)?
                {
                    if actual != piece {
                        continue;
                    }
                    // An older piece may physically extend past a later claim's actual first upload. The
                    // existing no-first-upload fallback still applies; never replay that superseded suffix.
                    let mut end = piece.first + piece.records.len() as u64;
                    let mut superseded = false;
                    for takeover in authority.takeovers.iter().filter(|t| t.from > piece.first) {
                        let key = replica::durability::part_key(
                            &authority.lineage,
                            authority.zone,
                            takeover,
                            takeover.from,
                        );
                        if self.store.get(&key)?.is_some() {
                            if takeover.from <= self.cursor {
                                superseded = true;
                                break;
                            }
                            end = end.min(takeover.from);
                        }
                    }
                    if !superseded {
                        found = Some((piece, end));
                        break;
                    }
                }
            }
            let (piece, end) = found.ok_or_else(|| {
                fault(
                    "stream-recovery-source-missing",
                    "canonical source range is incomplete",
                )
            })?;
            if piece.header != self.header.stored() {
                return Err(fault("header-mismatch", "canonical source bridge"));
            }
            let start = usize::try_from(self.cursor - piece.first)
                .map_err(|_| fault("stream-recovery", "source range overflow"))?;
            for raw in &piece.records[start..] {
                if self.cursor >= target || self.cursor >= end || self.migration_state.is_some() {
                    break;
                }
                if self.migration_cut.is_some() {
                    self.apply_record(self.cursor, raw)?;
                } else {
                    self.push(self.cursor, raw)?;
                }
            }
            if self.migration_state.is_some() {
                break;
            }
        }
        Ok(())
    }
    pub fn public_player(&self) -> &PublicPlayer {
        &self.player
    }
    fn commit(&mut self, manifest: &[u8]) -> R<()> {
        let hash = self.put(manifest)?;
        self.name_live(&hash, &object_map(manifest)?);
        let bytes = wire(Value::Map(BTreeMap::from([(
            1,
            Value::Bytes(hash.clone()),
        )])))?;
        let etag = self.store.put(
            &format!("{}head", self.prefix),
            &bytes,
            match self.etag.as_deref() {
                Some(e) => When::Is(e),
                None => When::Absent,
            },
        )?;
        self.etag = Some(etag);
        self.head = Some(hash);
        Ok(())
    }
    /// Notes a manifest of the current chain and the objects it names (#3833).
    fn name_live(&mut self, hash: &[u8], m: &BTreeMap<u64, Value>) {
        self.live.insert(hash.to_vec());
        for k in [1, 3, 5, 6, 9] {
            if let Some(Value::Bytes(h)) = m.get(&k)
                && !h.is_empty()
            {
                self.live.insert(h.clone());
            }
        }
    }
    fn recover(&mut self, head: &[u8]) -> R<()> {
        let mut chain = Vec::new();
        let mut h = head.to_vec();
        let mut seen = std::collections::BTreeSet::new();
        while !h.is_empty() {
            if !seen.insert(h.clone()) {
                return Err(fault("stream-recovery", "manifest cycle"));
            }
            let m = object_map(&self.get(&h)?)?;
            self.name_live(&h, &m);
            h = obj_bytes(&m, 2)?;
            chain.push(m);
        }
        chain.reverse();
        let first = chain
            .first()
            .ok_or_else(|| fault("stream-recovery", "empty chain"))?;
        self.seed = obj_bytes(first, 1)?;
        let seed = object_map(&self.get(&self.seed)?)?;
        if obj_bytes(&seed, 1)? != self.header.stored() {
            return Err(fault("header-mismatch", "recovery seed"));
        }
        self.baseline = obj_bytes(&seed, 4)?;
        self.baseline_text = obj_bytes(&seed, 9)?;
        self.hides = seed.get(&17) == Some(&Value::Uint(1));
        self.live.insert(self.baseline_text.clone());
        self.player = PublicPlayer::start(self.header.stored(), &self.baseline)?;
        let checkpoint = obj_bytes(&seed, 2)?;
        let record = obj_uint(&seed, 3)?;
        self.canonical = if seed.contains_key(&10) {
            // A generation's seed (#3833): the copy and what the writer carried at its rollover.
            self.carry(&seed)?
        } else if checkpoint.is_empty() {
            if record != 0 {
                return Err(fault("stream-recovery", "empty nonzero checkpoint"));
            }
            Replica::start(self.header.stored())?
        } else {
            let r = sim::checkpoint::read_bytes(&checkpoint)?;
            if r.root.record != record
                || r.root.version.lineage != self.header.lineage
                || r.root.version.zone != self.header.zone
            {
                return Err(fault("stream-recovery", "checkpoint identity"));
            }
            Replica::restored(self.header.clone(), r.tree, r.root.version.sequence)
        };
        self.inside = Inside::new(&self.closed_kinds);
        self.inside.seed(self.canonical.tree());
        self.cursor = record;
        self.chunk_start = record;
        if let Some(Value::Bytes(old_header)) = seed.get(&8)
            && !old_header.is_empty()
        {
            let old = Header::read(old_header)?;
            if old.lineage != self.header.lineage
                || old.zone != self.header.zone
                || old.epoch != self.header.epoch
            {
                return Err(fault("stream-legacy-identity", "recovery legacy header"));
            }
            immutable(&self.root.join(stream::header_path(&old)), old_header)?;
        }
        if let Some(Value::Array(files)) = seed.get(&7) {
            for row in files {
                let Value::Array(row) = row else {
                    return Err(fault("stream-recovery", "legacy file shape"));
                };
                let [Value::Text(name), Value::Bytes(hash)] = row.as_slice() else {
                    return Err(fault("stream-recovery", "legacy file fields"));
                };
                let number = name.as_str().strip_suffix(".text").unwrap_or(name.as_str());
                if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(fault("stream-recovery", "invalid legacy file name"));
                }
                immutable(&self.dir.join(name.as_str()), &self.get(hash)?)?;
                self.live.insert(hash.clone());
            }
        }
        if let Some(Value::Array(legacy)) = seed.get(&6)
            && !legacy.is_empty()
        {
            let [Value::Uint(v), Value::Uint(n), Value::Bytes(hash)] = legacy.as_slice() else {
                return Err(fault("stream-recovery", "legacy cursor shape"));
            };
            self.legacy = Some((*v, *n, hash.clone()));
            self.migration_cut = Some(*v);
            if self.canonical.version() == *v {
                self.migration_state = Some(self.shown(self.canonical.tree())?);
            }
        }
        if let Some(Value::Array(bootstrap)) = seed.get(&5) {
            for raw in bootstrap {
                let Value::Bytes(raw) = raw else {
                    return Err(fault("stream-recovery", "bootstrap original bytes"));
                };
                self.apply_record(self.cursor, raw)?;
            }
        }
        let expected = self
            .migration_state
            .take()
            .unwrap_or(self.shown(self.canonical.tree())?);
        if expected != *self.player.state() {
            return Err(fault(
                "stream-recovery",
                "baseline differs from canonical prefix",
            ));
        }
        self.chunks.clear();
        self.chunk_start = self.cursor;
        self.force_remainder = self.canonical.version() > self.player.version();

        // Only the current generation's files are written again; older ones are on the disk or pruned (#3825).
        let current = chain.iter().rposition(|m| m.contains_key(&8)).unwrap_or(0);
        let mut played = false;
        let mut files = Vec::new();
        for (i, m) in chain.into_iter().enumerate() {
            if obj_bytes(&m, 1)? != self.seed {
                return Err(fault("stream-recovery", "generation source changed"));
            }
            let chunk = obj_bytes(&m, 3)?;
            if chunk.is_empty() {
                if obj_uint(&m, 7)? != self.cursor {
                    return Err(fault("stream-recovery", "initial cursor"));
                }
                if let Some(id) = m.get(&8) {
                    // A rollover (#3825): the same baseline worked out again from the same state.
                    self.player.verify()?;
                    if obj_uint(&m, 4)? != self.player.next() {
                        return Err(fault("stream-recovery", "rollover part number"));
                    }
                    let baseline = self.generation_baseline()?;
                    if *id != Value::Bytes(replica::ids::sha256(&baseline).to_vec()) {
                        return Err(fault("stream-recovery", "rollover baseline differs"));
                    }
                    self.next_generation(baseline, obj_bytes(&m, 9)?, false)?;
                }
                continue;
            }
            let write = i > current;
            let c = object_map(&self.get(&chunk)?)?;
            if obj_uint(&c, 1)? != self.cursor {
                return Err(fault("stream-recovery", "source record gap"));
            }
            let Some(Value::Array(records)) = c.get(&2) else {
                return Err(fault("stream-recovery", "source records missing"));
            };
            for raw in records {
                let Value::Bytes(raw) = raw else {
                    return Err(fault("stream-recovery", "source record bytes"));
                };
                self.apply_record(self.cursor, raw)?;
            }
            if self.cursor != obj_uint(&m, 7)? {
                return Err(fault("stream-recovery", "manifest source cursor"));
            }
            let number = obj_uint(&m, 4)?;
            if number != self.player.next() {
                return Err(fault("stream-recovery", "part number"));
            }
            let bytes = self.get(&obj_bytes(&m, 5)?)?;
            self.player.play_deferred(&bytes)?;
            played = true;
            let text = obj_bytes(&m, 6)?;
            if write {
                files.push((number.to_string(), bytes.clone()));
            }
            if write && !text.is_empty() {
                files.push((format!("{number}.text"), self.get(&text)?));
            }
            self.last_to = Some(StreamPart::read(&bytes)?.to);
            self.clear_pending();
        }
        // The parts' digests (#3822's deferred play) and the canonical copy's projection are checked once, for the
        // state the parts make together, before any file is written again (#3833): a whole digest and a whole
        // projection of a large world per part made a restart's time grow with the parts it reads.
        self.player.verify()?;
        if played && self.shown(self.canonical.tree())? != *self.player.state() {
            return Err(fault("stream-recovery", "canonical projection differs"));
        }
        for (name, bytes) in files {
            immutable(&self.generation_dir().join(name), &bytes)?;
        }
        Ok(())
    }
    fn apply_record(&mut self, record: u64, raw: &[u8]) -> R<()> {
        if record != self.cursor {
            return Err(fault(
                "stream-source-gap",
                "physical record does not follow",
            ));
        }
        #[cfg(test)]
        if tests::WHOLE_STATE.get() {
            return self.apply_record_whole_state(record, raw);
        }
        if !sim::recorder::is_input(raw) {
            let part = Part::read(raw)?;
            // The entries that put a thing into a closed container or touch one in it (#3948): never published.
            let kept = self.kept_out(&part);
            // Whole canonical validation first. Never publish a partial producer result or private ledger. One copy
            // takes the part entry by entry, as a viewer applies it (all of it or none); the view, the duplicates and
            // the cut's state are kept only when every entry applied. The view reads the copy's tree around each
            // entry: no whole state is built per entry (#3667).
            // A part of motion, fields and timers only (#3799) changes no node's parent and brings no node, so each
            // entry's view reads the same parent chains before and after it: the view steps over the tree as it stands,
            // and the part is applied to the one tree, all of it or none, with no copy. Any other part is taken entry by
            // entry on a copy, as above.
            let simple = self.incremental
                && self.migration_cut.is_none()
                && !part.effects.is_empty()
                && part.header == self.header.hash().to_bytes()
                && part.effects.iter().all(|e| match &e.body {
                    Body::Changes(cs) => cs.iter().all(|c| match &c.change {
                        replica::effects::Change::Motion(_)
                        | replica::effects::Change::Set { .. } => true,
                        // A body set still where it is: its frame unchanged.
                        replica::effects::Change::Reparent { from, pose, .. } => {
                            *from == pose.frame
                        }
                        _ => false,
                    }),
                    Body::Timers(_) => true,
                    _ => false,
                });
            if simple {
                let before_version = self.canonical.version();
                let mut view = self.view.clone();
                for effect in &part.effects {
                    let before = Before::of(self.canonical.tree(), effect);
                    view.step(&before, effect, &before, &Redactions::default())?;
                }
                self.canonical.apply(&part)?;
                self.view = view;
                for (_, record) in self.view.take() {
                    if Carried::read(&record)?.is_none()
                        && (kept.is_empty()
                            || !kept.contains(
                                &stream_effect(&self.header, record.clone())?
                                    .envelope
                                    .sequence,
                            ))
                    {
                        self.records.push(record)
                    }
                }
                let tree = self.canonical.tree();
                let changed: Vec<(Id, u64)> = self
                    .canonical
                    .changed_since(before_version)
                    .into_iter()
                    .filter(|(id, _)| {
                        tree.handle(*id)
                            .and_then(|h| tree.node(h))
                            .is_some_and(|n| n.audience() == Audience::Everyone)
                            && !self.hidden(tree, *id)
                    })
                    .collect();
                self.changes.extend(changed);
            } else {
                let mut checked = self.canonical.frozen();
                if part.effects.is_empty() || part.header != self.header.hash().to_bytes() {
                    checked.apply(&part)?;
                }
                let before_version = self.canonical.version();
                let mut view = self.view.clone();
                let mut duplicates = Vec::new();
                let mut migration_state = None;
                for effect in &part.effects {
                    let before = Before::of(checked.tree(), effect);
                    if effect.envelope.audience == Audience::Everyone
                        && let Body::Transfer(replica::effects::TransferRec::Arrive {
                            transfer,
                            ..
                        }) = &effect.body
                        && checked.tree().arrived().contains(transfer)
                        && !kept.contains(&effect.envelope.sequence)
                    {
                        duplicates.push((effect.envelope.sequence, *transfer));
                    }
                    let one = wire(Value::Map(BTreeMap::from([
                        (1, Value::Bytes(self.header.hash().to_bytes())),
                        (2, Value::Array(vec![effect.to_value()])),
                    ])))?;
                    checked.apply(&Part::read(&one)?)?;
                    if self.migration_cut == Some(checked.version()) {
                        migration_state = Some(self.shown(checked.tree())?);
                    }
                    view.step(&before, effect, checked.tree(), &Redactions::default())?;
                }
                self.view = view;
                self.duplicates.extend(duplicates);
                if migration_state.is_some() {
                    self.migration_state = migration_state;
                }
                for (_, record) in self.view.take() {
                    if Carried::read(&record)?.is_none() {
                        let seq = stream_effect(&self.header, record.clone())?
                            .envelope
                            .sequence;
                        if self.migration_cut.is_none_or(|v| seq >= v) && !kept.contains(&seq) {
                            self.records.push(record)
                        }
                    }
                }
                // A node is a row of the public projection when it is live here and public: read from the two trees,
                // never by projecting either whole (#3667).
                let visible = |t: &replica::tree::Tree, id: Id| {
                    t.handle(id)
                        .and_then(|h| t.node(h))
                        .is_some_and(|n| n.audience() == Audience::Everyone)
                        && !self.hidden(t, id)
                };
                let changed: Vec<(Id, u64)> = checked
                    .changed_since(before_version)
                    .into_iter()
                    .filter(|(id, v)| {
                        (visible(self.canonical.tree(), *id) || visible(checked.tree(), *id))
                            && self.migration_cut.is_none_or(|cut| *v > cut)
                    })
                    .collect();
                self.changes.extend(changed);
                self.duplicates
                    .retain(|(seq, _)| self.migration_cut.is_none_or(|cut| *seq >= cut));
                self.canonical = checked;
            }
            // What the cut can be published from (#3799): motion, fields set and nodes set in a slot touch only their
            // rows; links made or ended only theirs; a leave whose arrive is in the same cut only the rows of what it
            // moved (#4192).
            for e in &part.effects {
                match &e.body {
                    Body::Changes(cs) => {
                        for c in cs {
                            match &c.change {
                                replica::effects::Change::Motion(h) => {
                                    self.touched.insert(h.node);
                                }
                                replica::effects::Change::Set { node, .. }
                                | replica::effects::Change::Reparent { node, .. } => {
                                    self.touched.insert(*node);
                                }
                                replica::effects::Change::Link { link, .. }
                                | replica::effects::Change::Unlink { link } => {
                                    self.links.insert(*link);
                                }
                                c => {
                                    prof::cause(match c {
                                        replica::effects::Change::Create { .. } => "create",
                                        replica::effects::Change::Remove { .. } => "remove",
                                        _ => "other-change",
                                    });
                                    self.structural = true
                                }
                            }
                        }
                    }
                    Body::Transfer(replica::effects::TransferRec::Leave {
                        transfer, node, ..
                    }) => {
                        self.left.insert(*transfer);
                        self.moved.insert(*node);
                    }
                    Body::Transfer(replica::effects::TransferRec::Arrive { transfer, carried })
                        if carried.is_empty() && self.left.contains(transfer) => {}
                    Body::Timers(recs) => {
                        for r in recs {
                            match r {
                                replica::effects::TimerRec::Set { timer, .. }
                                | replica::effects::TimerRec::Clear { timer } => {
                                    self.timers.insert(*timer);
                                }
                            }
                        }
                    }
                    b => {
                        prof::cause(match b {
                            Body::Transfer(_) => "transfer",
                            Body::Time(_) => "time",
                            _ => "other-body",
                        });
                        self.structural = true
                    }
                }
            }
            let at = part.effects.last().map(|e| e.envelope.at);
            if let Some(at) = at {
                let win = at.div_euclid(stream::PERIOD_US);
                self.window.get_or_insert(win);
            }
        }
        self.cursor = self
            .cursor
            .checked_add(1)
            .ok_or_else(|| fault("stream-source-gap", "cursor overflow"))?;
        self.chunks.push(raw.to_vec());
        Ok(())
    }
    /// The replay as it was before #3667, a whole state and projection per entry: the reference the regression
    /// compares the tree-reading replay with, byte for byte.
    #[cfg(test)]
    fn apply_record_whole_state(&mut self, record: u64, raw: &[u8]) -> R<()> {
        if record != self.cursor {
            return Err(fault(
                "stream-source-gap",
                "physical record does not follow",
            ));
        }
        self.structural = true;
        if !sim::recorder::is_input(raw) {
            let part = Part::read(raw)?;
            let kept = self.kept_out(&part);
            let mut checked = self.canonical.frozen();
            checked.apply(&part)?;
            let before_version = self.canonical.version();
            let mut walk = self.canonical.frozen();
            for effect in &part.effects {
                let before = walk.tree().to_state();
                if effect.envelope.audience == Audience::Everyone
                    && let Body::Transfer(replica::effects::TransferRec::Arrive {
                        transfer, ..
                    }) = &effect.body
                    && before.arrived.contains(transfer)
                    && !kept.contains(&effect.envelope.sequence)
                {
                    self.duplicates.push((effect.envelope.sequence, *transfer));
                }
                let one = wire(Value::Map(BTreeMap::from([
                    (1, Value::Bytes(self.header.hash().to_bytes())),
                    (2, Value::Array(vec![effect.to_value()])),
                ])))?;
                walk.apply(&Part::read(&one)?)?;
                if self.migration_cut == Some(walk.version()) {
                    self.migration_state = Some(self.shown(walk.tree())?);
                }
                self.view.step(
                    &before,
                    effect,
                    &walk.tree().to_state(),
                    &Redactions::default(),
                )?;
            }
            for (_, record) in self.view.take() {
                if Carried::read(&record)?.is_none() {
                    let seq = stream_effect(&self.header, record.clone())?
                        .envelope
                        .sequence;
                    if self.migration_cut.is_none_or(|v| seq >= v) && !kept.contains(&seq) {
                        self.records.push(record)
                    }
                }
            }
            let old = self.shown(self.canonical.tree())?;
            let new = self.shown(checked.tree())?;
            let visible = |v: &Value, id: Id| matches!(v,Value::Map(m) if matches!(m.get(&2),Some(Value::Array(rows)) if rows.iter().any(|r|matches!(r,Value::Array(p) if p.first()==Some(&id.to_value())))));
            for (id, v) in checked.changed_since(before_version) {
                if (visible(&old, id) || visible(&new, id))
                    && self.migration_cut.is_none_or(|cut| v > cut)
                {
                    self.changes.insert(id, v);
                }
            }
            self.duplicates
                .retain(|(seq, _)| self.migration_cut.is_none_or(|cut| *seq >= cut));
            self.canonical = checked;
            let at = part.effects.last().map(|e| e.envelope.at);
            if let Some(at) = at {
                let win = at.div_euclid(stream::PERIOD_US);
                self.window.get_or_insert(win);
            }
        }
        self.cursor = self
            .cursor
            .checked_add(1)
            .ok_or_else(|| fault("stream-source-gap", "cursor overflow"))?;
        self.chunks.push(raw.to_vec());
        Ok(())
    }
    pub fn push(&mut self, record: u64, raw: &[u8]) -> R<()> {
        let window = self.window;
        let mut lap = prof::Lap::start();
        self.apply_record(record, raw)?;
        lap.mark(0);
        prof::count(1, 0, 0);
        if let (Some(before), Some(last)) = (window, self.records.last())
            && stream_effect(&self.header, last.clone())?
                .envelope
                .at
                .div_euclid(stream::PERIOD_US)
                > before
        {
            self.flush()?;
        }
        Ok(())
    }
    fn clear_pending(&mut self) {
        self.chunk_start = self.cursor;
        self.chunks.clear();
        self.records.clear();
        self.duplicates.clear();
        self.changes.clear();
        self.window = None;
        self.force_remainder = false;
        self.structural = false;
        self.touched.clear();
        self.timers.clear();
        self.links.clear();
        self.left.clear();
        self.moved.clear();
    }
    pub fn flush(&mut self) -> R<()> {
        if self.chunks.is_empty() && !self.force_remainder {
            return Ok(());
        }
        let mut lap = prof::Lap::start();
        // A cut of motion and fields set only (#3799): the published state with the touched nodes' rows replaced, its
        // digest worked out in place; any other cut, the public state whole. The same bytes either way.
        let delta = if self.incremental
            && !self.structural
            && !self.force_remainder
            && !self.records.is_empty()
            && self.migration_cut.is_none()
        {
            let tree = self.canonical.tree();
            // A moved node's row and those under it (#4192), each read once.
            let mut ids = self.touched.clone();
            let mut todo: Vec<Id> = self.moved.iter().copied().collect();
            while let Some(id) = todo.pop() {
                ids.insert(id);
                if let Some(h) = tree.handle(id) {
                    todo.extend(
                        tree.children(h)
                            .unwrap_or(&[])
                            .iter()
                            .filter_map(|c| tree.node(*c).map(|n| n.id())),
                    );
                }
            }
            let rows = ids
                .iter()
                .filter_map(|id| {
                    let n = tree.node_state_of(*id)?;
                    (n.audience == Audience::Everyone && !self.hidden(tree, *id))
                        .then(|| (*id, n.to_value()))
                })
                .collect();
            // A link's row as the public state holds it: public, with no end a node here that is not public or is
            // hidden in a closed container (#3948); none once ended. One with an end not live here (a node in flight,
            // or gone) is left to the whole cut.
            let links: Option<Vec<(Id, Option<Value>)>> = self
                .links
                .iter()
                .map(|id| match tree.link(*id) {
                    None => Some((*id, None)),
                    Some((ty, ends, owner, audience)) => {
                        let mut public = audience == Audience::Everyone;
                        for e in ends {
                            public &= tree.node_state_of(e)?.audience == Audience::Everyone
                                && !self.hidden(tree, e);
                        }
                        Some((
                            *id,
                            public.then(|| {
                                replica::effects::LinkState {
                                    ty: ty.clone(),
                                    ends,
                                    owner,
                                    audience,
                                }
                                .to_value()
                            }),
                        ))
                    }
                })
                .collect();
            // Every leave of the cut arrived in it: no flight is open at the cut. A thing put into a closed container
            // leaves the public state with what is under it, its links and its timers (#3948): the whole cut. One taken
            // out is not in the published state, so its row makes the cut whole too.
            let landed = self.left.iter().all(|t| tree.flight(*t).is_none())
                && !self.moved.iter().any(|id| self.hidden(tree, *id));
            // A timer's row as the public state holds it: of a public live owner; none once cleared. One whose
            // owner is not live here (in flight) is left to the whole cut.
            let int = |n: i64| {
                u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint)
            };
            let timers: Option<Vec<(Id, Option<Value>)>> = self
                .timers
                .iter()
                .map(|id| match tree.timers().get(id) {
                    None => Some((*id, None)),
                    Some(t) => {
                        let owner = tree.node_state_of(t.node)?;
                        Some((
                            *id,
                            (owner.audience == Audience::Everyone && !self.hidden(tree, t.node))
                                .then(|| {
                                    Value::Map(BTreeMap::from([
                                        (1, t.node.to_value()),
                                        (2, int(t.due)),
                                        (3, Value::Text(t.name.clone())),
                                    ]))
                                }),
                        ))
                    }
                })
                .collect();
            match (timers, links, landed) {
                (Some(timers), Some(links), true) => {
                    self.player.row_delta(tree.next(), rows, timers, links)?
                }
                _ => None,
            }
        } else {
            None
        };
        let (after, after_digest) = match &delta {
            Some(d) => (None, self.player.digest_with(d)?),
            None => {
                let a = self.shown(self.canonical.tree())?;
                let h = digest(&a)?;
                (Some(a), h)
            }
        };
        lap.mark(1);
        prof::count(0, 0, after.is_some() as u64);
        self.whole_cuts += after.is_some() as u64;
        if self.records.is_empty()
            && let Some(after) = &after
        {
            let mut old = self.player.state().clone();
            if let Value::Map(m) = &mut old
                && let Value::Map(a) = after
            {
                m.insert(1, a[&1].clone());
            }
            if &old == after && !self.force_remainder {
                return Ok(());
            }
        }
        let expected = self.player.version();
        let version = self.canonical.version();
        let mut cursor = expected;
        let mut gaps = Vec::new();
        for record in &self.records {
            let e = stream_effect(&self.header, record.clone())?;
            let seq = e.envelope.sequence;
            if seq < cursor {
                return Err(fault("stream-sequence", "public entry order"));
            }
            if seq > cursor {
                gaps.push((cursor, seq - cursor));
            }
            cursor = seq
                .checked_add(1)
                .ok_or_else(|| fault("stream-sequence", "overflow"))?;
        }
        if cursor < version {
            gaps.push((cursor, version - cursor));
        }
        let part = wire(Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (2, Value::Array(self.records.clone())),
        ])))?;
        let at = self
            .canonical
            .tree()
            .time()
            .iter()
            .rev()
            .find_map(|t| {
                if let TimeEffect::Mapping(m) = t {
                    Some(m.world_us)
                } else {
                    None
                }
            })
            .unwrap_or(0);
        let window = self.window.unwrap_or(at.div_euclid(stream::PERIOD_US));
        let mut sp = StreamPart {
            number: self.player.next(),
            from: window * stream::PERIOD_US,
            to: (window + 1) * stream::PERIOD_US,
            first: self
                .records
                .first()
                .and_then(|r| {
                    if let Value::Map(m) = r {
                        if let Some(Value::Uint(n)) = m.get(&1) {
                            Some(*n)
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                })
                .unwrap_or(version),
            entries: self.records.len() as u64,
            part,
            hash: Some(after_digest.clone()),
            gaps,
            carried: Vec::new(),
        };
        // The end covers every actual public effect in this cut, even across a still interval.
        if let Some(last) = self.records.last() {
            sp.to = sp
                .to
                .max(stream_effect(&self.header, last.clone())?.envelope.at);
        }
        // A returned public child can become live without being canonically touched by Return. Bind its
        // actual query version, including zero for an ordinary checkpoint's formerly flying child.
        // A cut of rows only (#3799) adds and removes no node, so no flying child becomes live in it.
        let flying = replica::stream::public::flying_ids(self.player.state())?;
        if let Some(after) = after.as_ref().filter(|_| !flying.is_empty()) {
            let before = object_map(&wire(self.player.state().clone())?)?;
            let Value::Array(old_rows) = &before[&2] else {
                unreachable!("validated projection")
            };
            let Value::Map(after_map) = after else {
                unreachable!("validated projection")
            };
            let Value::Array(new_rows) = &after_map[&2] else {
                unreachable!("validated projection")
            };
            for row in new_rows {
                let Value::Array(row) = row else {
                    unreachable!("validated pair")
                };
                let id = replica::effects::read_id(&row[0])?;
                // Only a flying id is looked up among the old rows: a scan per row is quadratic in the view (#3799).
                if !flying.contains(&id) || self.changes.contains_key(&id) {
                    continue;
                }
                let existed = old_rows
                    .iter()
                    .any(|r| matches!(r,Value::Array(p) if p.first()==Some(&id.to_value())));
                if !existed {
                    let query = wire(Value::Map(BTreeMap::from([
                        (1, Value::Uint(1)),
                        (2, id.to_value()),
                    ])))?;
                    let node = object_map(&self.canonical.query(&query)?)?;
                    let version = obj_uint(&node, 10)?;
                    self.changes.insert(id, version);
                }
            }
        }
        // A whole cut names change versions only of nodes in the state before or after it: one left out (C5) is
        // in neither, and a reader refuses a version for it.
        let rows_of = |v: &Value| -> std::collections::BTreeSet<Id> {
            match v {
                Value::Map(m) => match m.get(&2) {
                    Some(Value::Array(rows)) => rows
                        .iter()
                        .filter_map(|r| match r {
                            Value::Array(p) => {
                                p.first().and_then(|i| replica::effects::read_id(i).ok())
                            }
                            _ => None,
                        })
                        .collect(),
                    _ => Default::default(),
                },
                _ => Default::default(),
            }
        };
        let shown_ids = after.as_ref().map(|a| {
            let mut ids = rows_of(a);
            ids.extend(rows_of(self.player.state()));
            ids
        });
        let changed = self
            .changes
            .iter()
            .filter(|(i, _)| shown_ids.as_ref().is_none_or(|s| s.contains(i)))
            .map(|(i, v)| (*i, *v))
            .collect::<Vec<_>>();
        // A whole cut's rows that differ from the published state: its context's delta, and what the words index
        // is brought up to date from (#4192).
        let whole_delta = match &after {
            Some(after) => Some(replica::stream::public::context_delta(
                self.player.state(),
                after,
            )?),
            None => None,
        };
        let context = match (&after, &delta) {
            // The digests are already worked out: the player's state's, and the cut's above (#4192). Hashing either
            // state again was a sixth of the writer's core at 500 agents.
            (Some(_), _) => replica::stream::public::context_with(
                &self.baseline,
                self.player.digest(),
                &after_digest,
                whole_delta.clone().expect("a whole cut has its delta"),
                self.cursor,
                &self.duplicates,
                &changed,
            )?,
            (None, Some(delta)) => replica::stream::public::context_with(
                &self.baseline,
                self.player.digest(),
                &after_digest,
                delta.clone(),
                self.cursor,
                &self.duplicates,
                &changed,
            )?,
            (None, None) => unreachable!("a cut is worked out whole or by rows"),
        };
        lap.mark(2);
        let mut value = object_map(&sp.to_bytes()?)?;
        value.insert(10, Value::Bytes(context));
        let bytes = wire(Value::Map(value))?;
        // Validate exactly as the native/WASM reader before storing or publishing bytes.
        let number = self.player.next();
        let chunk = wire(Value::Map(BTreeMap::from([
            (1, Value::Uint(self.chunk_start)),
            (
                2,
                Value::Array(
                    self.chunks
                        .iter()
                        .map(|b| Value::Bytes(b.clone()))
                        .collect(),
                ),
            ),
        ])))?;
        lap.mark(3);
        let chunk_hash = self.put(&chunk)?;
        let part_hash = self.put(&bytes)?;
        lap.mark(4);
        let text = self.words_after(after.as_ref(), delta.as_ref(), whole_delta.as_ref())?;
        lap.mark(5);
        let text_hash = self.put(&text)?;
        lap.mark(4);
        self.player.play(&bytes)?;
        lap.mark(6);
        let manifest = wire(Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.seed.clone())),
            (2, Value::Bytes(self.head.clone().unwrap_or_default())),
            (3, Value::Bytes(chunk_hash)),
            (4, Value::Uint(number)),
            (5, Value::Bytes(part_hash)),
            (6, Value::Bytes(text_hash)),
            (7, Value::Uint(self.cursor)),
        ])))?;
        self.commit(&manifest)?;
        lap.mark(7);
        // Commit exact recovery bytes before exposing local immutable files. A killed publication replays the
        // same committed bytes, never a new cut at an orphan file's address.
        immutable(&self.generation_dir().join(number.to_string()), &bytes)?;
        immutable(&self.generation_dir().join(format!("{number}.text")), &text)?;
        lap.mark(8);
        self.last_to = Some(sp.to);
        self.clear_pending();
        self.delete_some(DELETES_PER_PART);
        if self.rollover_due() {
            self.rollover()?;
        }
        // The cut has just published the source's public state: the next idle need not project it again to find the
        // world still (C4; at 500 agents that projection was most of the writer's core).
        if self.migration_cut.is_none() {
            self.still_at = Some((
                self.canonical.version(),
                self.player.version(),
                self.player.next(),
            ));
        }
        lap.mark(9);
        self.pointer(None)?;
        lap.mark(10);
        prof::count(0, 1, 0);
        Ok(())
    }
    fn pointer(&self, quiet: Option<i64>) -> R<()> {
        let real = crate::answers::now();
        let world =
            mapped_now(self.canonical.tree().time(), self.clock_seed, real).or_else(|_| {
                if self.canonical.tree().time().is_empty() {
                    Ok(0)
                } else {
                    Err(fault("stream-clock", "no applicable mapping"))
                }
            })?;
        let pointer = Pointer {
            newest: self.player.next().checked_sub(1),
            period: stream::PERIOD_US,
            header: self.header.hash().to_bytes(),
            newest_to: self.last_to,
            anchor_world: world,
            anchor_wall_ms: u64::try_from(real.div_euclid(1000))
                .map_err(|_| fault("stream-clock", "negative wall time"))?,
            quiet_until: quiet,
        };
        let mut value = object_map(&pointer.to_bytes()?)?;
        value.insert(
            8,
            Value::Bytes(replica::ids::sha256(&self.baseline).to_vec()),
        );
        if let Some((from, version, number, hash)) = &self.handoff {
            value.insert(
                9,
                Value::Array(vec![
                    Value::Uint(*version),
                    Value::Uint(*number),
                    Value::Bytes(hash.clone()),
                ]),
            );
            value.insert(10, Value::Bytes(from.clone()));
        } else if let Some((version, number, hash)) = &self.legacy {
            value.insert(
                9,
                Value::Array(vec![
                    Value::Uint(*version),
                    Value::Uint(*number),
                    Value::Bytes(hash.clone()),
                ]),
            );
        }
        // Asleep (#2731, rule 13): still until the next due change, `[]` when none is due.
        if let Some(due) = self.asleep {
            value.insert(11, Value::Array(due.map(int).into_iter().collect()));
        }
        write_whole(&self.dir.join(POINTER), &wire(Value::Map(value))?)
    }
    /// Before the world exits to sleep (#2731, rule 13): what is open is written, and the pointer says the world is
    /// still up to now and until `next_due`, the world time of its next due change (none: nothing is due). Refused
    /// (`stream-sleep`) when the published state is not the world's, as then it is not still.
    pub fn sleep(&mut self, real: i64, next_due: Option<Micros>) -> R<()> {
        self.flush()?;
        self.asleep = Some(next_due);
        let wrote = self.quiet_now(real);
        self.asleep = None;
        if wrote? {
            Ok(())
        } else {
            Err(fault("stream-sleep", "the public stream is not still"))
        }
    }
    pub fn idle(&mut self, real: i64) -> R<()> {
        self.quiet_now(real).map(|_| ())
    }
    /// [`PublicWriter::idle`]: whether it wrote the pointer quiet.
    fn quiet_now(&mut self, real: i64) -> R<bool> {
        if self.canonical.tree().time().is_empty() && self.clock_seed.is_none() {
            return Ok(false);
        }
        let world = mapped_now(self.canonical.tree().time(), self.clock_seed, real)?;
        if self
            .window
            .is_some_and(|w| world >= (w + 1) * stream::PERIOD_US + SETTLE_US)
        {
            self.flush()?;
        }
        if !self.records.is_empty() {
            return Ok(false);
        }
        let mut lap = prof::Lap::start();
        let at = (
            self.canonical.version(),
            self.player.version(),
            self.player.next(),
        );
        if self.still_at != Some(at) {
            #[cfg(test)]
            tests::IDLE_PROJECTIONS.set(tests::IDLE_PROJECTIONS.get() + 1);
            let mut published = self.player.state().clone();
            let current = self.shown(self.canonical.tree())?;
            if let (Value::Map(a), Value::Map(b)) = (&mut published, &current) {
                a.insert(1, b[&1].clone());
            }
            if published != current {
                lap.mark(11);
                return Ok(false);
            }
            self.still_at = Some(at);
        }
        lap.mark(11);
        self.pointer(Some(world.saturating_sub(SETTLE_US)))?;
        lap.mark(12);
        Ok(true)
    }
}
