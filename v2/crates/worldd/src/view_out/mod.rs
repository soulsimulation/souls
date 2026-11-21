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
//!     its words.
//! 11. **A still world says so** (V5b, #3460). [`follow`] is handed the world's clock and tells the writer the world's
//!     time now ([`Writer::idle`]) after each frame, and at least every 20 ms without one. Once a stretch's time has
//!     passed, with [`SETTLE_US`] more for its last records to be synced, the open stretch is written, so a burst after a
//!     still while is on the page within the usual lag rather than waiting for the next record. With nothing open, the
//!     pointer says the world is still up to world-now less [`SETTLE_US`] (`quiet(until)`), every [`QUIET_EVERY_US`] of
//!     world time; a page plays a still world to there, and no empty part is ever written (rule 3). A record that
//!     reaches the writer later than [`SETTLE_US`] after its world time is still written, in its own stretch; a page
//!     that has drawn past it has missed only its motion, never its state.
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
use replica::stream::public::{
    PublicPlayer, baseline as public_baseline, context as public_context, digest, project,
};
use replica::views::{Redactions, View};

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
    clock_seed: Option<Mapping>,
    migration_cut: Option<u64>,
    migration_state: Option<Value>,
    legacy: Option<(u64, u64, Vec<u8>)>,
    force_remainder: bool,
    /// Off: every cut works out the public state whole (the reference the incremental cut is compared with, #3799).
    pub incremental: bool,
    /// Whether the open cut holds anything but motion and fields set on nodes; else the nodes it set (#3799).
    structural: bool,
    touched: std::collections::BTreeSet<Id>,
    /// The references each node row of the published state holds, and those of the rest of it (#3799).
    /// Kept with the version of the state they are of.
    #[allow(clippy::type_complexity)]
    refs: Option<(
        u64,
        BTreeMap<Id, std::collections::BTreeSet<Id>>,
        std::collections::BTreeSet<Id>,
    )>,
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
fn immutable(path: &Path, bytes: &[u8]) -> R<()> {
    if let Some(p) = path.parent() {
        fs::create_dir_all(p).map_err(io)?;
    }
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut f) => {
            if let Err(e) = f.write_all(bytes).and_then(|_| f.sync_all()) {
                let _ = fs::remove_file(path);
                return Err(io(e));
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let meta = fs::symlink_metadata(path).map_err(io)?;
            if !meta.is_file()
                || meta.file_type().is_symlink()
                || fs::read(path).map_err(io)? != bytes
            {
                return Err(fault("stream-immutable", "existing bytes differ"));
            }
            Ok(())
        }
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
        let PublicStart {
            root,
            header,
            key,
            initial,
            record,
            checkpoint,
            text,
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
        let baseline = public_baseline(header, &initial.tree().to_state(), record)?;
        let player = PublicPlayer::start(header.stored(), &baseline)?;
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
            clock_seed,
            migration_cut: None,
            migration_state: None,
            legacy: None,
            force_remainder: false,
            // SOULS_STREAM_WHOLE set: every cut worked out whole, the reference a recorded log is compared with.
            incremental: std::env::var_os("SOULS_STREAM_WHOLE").is_none(),
            structural: true,
            touched: std::collections::BTreeSet::new(),
            refs: None,
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
                    w.migration_state = Some(project(header, &w.canonical.tree().to_state())?);
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
            let seed = wire(Value::Map(BTreeMap::from([
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
                (9, Value::Bytes(w.put(&w.words(w.player.state())?)?)),
            ])))?;
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
        let seed = object_map(&w.get(&w.seed)?)?;
        immutable(
            &w.generation_dir().join("baseline.text"),
            &w.get(&obj_bytes(&seed, 9)?)?,
        )?;
        w.pointer(None)?;
        Ok(w)
    }
    /// The words file of a cut (#3799): the references of the state after it and of its records, as
    /// [`PublicWriter::words`] finds them in the two whole, each node row's kept from the last cut that set it.
    fn words_after(&mut self, after: Option<&Value>, delta: Option<&Value>) -> R<Vec<u8>> {
        if self.text.is_none() {
            return wire(Value::Array(Vec::new()));
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
        if after.is_some() || stale {
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
            && let (Some((at, rows, _)), Some(d)) = (&mut self.refs, delta)
        {
            *at = version(d);
            let Value::Map(d) = d else {
                return Err(fault("stream-words", "a delta is a map"));
            };
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
        self.words_of(all)
    }
    fn words(&self, value: &Value) -> R<Vec<u8>> {
        self.words_of(replica::audience::references(value))
    }
    fn words_of(&self, refs: std::collections::BTreeSet<Id>) -> R<Vec<u8>> {
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
    fn recover(&mut self, head: &[u8]) -> R<()> {
        let mut chain = Vec::new();
        let mut h = head.to_vec();
        let mut seen = std::collections::BTreeSet::new();
        while !h.is_empty() {
            if !seen.insert(h.clone()) {
                return Err(fault("stream-recovery", "manifest cycle"));
            }
            let m = object_map(&self.get(&h)?)?;
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
        self.player = PublicPlayer::start(self.header.stored(), &self.baseline)?;
        let checkpoint = obj_bytes(&seed, 2)?;
        let record = obj_uint(&seed, 3)?;
        self.canonical = if checkpoint.is_empty() {
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
                self.migration_state =
                    Some(project(&self.header, &self.canonical.tree().to_state())?);
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
            .unwrap_or(project(&self.header, &self.canonical.tree().to_state())?);
        if expected != *self.player.state() {
            return Err(fault(
                "stream-recovery",
                "baseline differs from canonical prefix",
            ));
        }
        self.chunks.clear();
        self.chunk_start = self.cursor;
        self.force_remainder = self.canonical.version() > self.player.version();

        for m in chain {
            if obj_bytes(&m, 1)? != self.seed {
                return Err(fault("stream-recovery", "generation source changed"));
            }
            let chunk = obj_bytes(&m, 3)?;
            if chunk.is_empty() {
                if obj_uint(&m, 7)? != self.cursor {
                    return Err(fault("stream-recovery", "initial cursor"));
                }
                continue;
            }
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
            self.player.play(&bytes)?;
            if project(&self.header, &self.canonical.tree().to_state())? != *self.player.state() {
                return Err(fault("stream-recovery", "canonical projection differs"));
            }
            immutable(&self.generation_dir().join(number.to_string()), &bytes)?;
            let text = obj_bytes(&m, 6)?;
            if !text.is_empty() {
                immutable(
                    &self.generation_dir().join(format!("{number}.text")),
                    &self.get(&text)?,
                )?;
            }
            self.last_to = Some(StreamPart::read(&bytes)?.to);
            self.clear_pending();
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
            // Whole canonical validation first. Never publish a partial producer result or private ledger. One copy
            // takes the part entry by entry, as a viewer applies it (all of it or none); the view, the duplicates and
            // the cut's state are kept only when every entry applied. The view reads the copy's tree around each
            // entry: no whole state is built per entry (#3667).
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
                        transfer, ..
                    }) = &effect.body
                    && checked.tree().arrived().contains(transfer)
                {
                    duplicates.push((effect.envelope.sequence, *transfer));
                }
                let one = wire(Value::Map(BTreeMap::from([
                    (1, Value::Bytes(self.header.hash().to_bytes())),
                    (2, Value::Array(vec![effect.to_value()])),
                ])))?;
                checked.apply(&Part::read(&one)?)?;
                if self.migration_cut == Some(checked.version()) {
                    migration_state = Some(project(&self.header, &checked.tree().to_state())?);
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
                    if self.migration_cut.is_none_or(|v| seq >= v) {
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
            };
            for (id, v) in checked.changed_since(before_version) {
                if (visible(self.canonical.tree(), id) || visible(checked.tree(), id))
                    && self.migration_cut.is_none_or(|cut| v > cut)
                {
                    self.changes.insert(id, v);
                }
            }
            self.duplicates
                .retain(|(seq, _)| self.migration_cut.is_none_or(|cut| *seq >= cut));
            self.canonical = checked;
            // What the cut can be published from (#3799): only motion and fields set on nodes touch only their rows.
            for e in &part.effects {
                match &e.body {
                    Body::Changes(cs) => {
                        for c in cs {
                            match &c.change {
                                replica::effects::Change::Motion(h) => {
                                    self.touched.insert(h.node);
                                }
                                replica::effects::Change::Set { node, .. } => {
                                    self.touched.insert(*node);
                                }
                                other => {
                                    eprintln!("CUTWHY change {}", match other { replica::effects::Change::Create{..}=>"create", replica::effects::Change::Remove{..}=>"remove", replica::effects::Change::Reparent{..}=>"reparent", replica::effects::Change::Link{..}=>"link", replica::effects::Change::Unlink{..}=>"unlink", _=>"?" });
                                    self.structural = true
                                }
                            }
                        }
                    }
                    b => {
                        eprintln!("CUTWHY body {}", match b { Body::Transfer(_)=>"transfer", Body::Time(_)=>"time", Body::Timers(_)=>"timers", _=>"?" });
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
                {
                    self.duplicates.push((effect.envelope.sequence, *transfer));
                }
                let one = wire(Value::Map(BTreeMap::from([
                    (1, Value::Bytes(self.header.hash().to_bytes())),
                    (2, Value::Array(vec![effect.to_value()])),
                ])))?;
                walk.apply(&Part::read(&one)?)?;
                if self.migration_cut == Some(walk.version()) {
                    self.migration_state = Some(project(&self.header, &walk.tree().to_state())?);
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
                    if self.migration_cut.is_none_or(|v| seq >= v) {
                        self.records.push(record)
                    }
                }
            }
            let after = checked.tree().to_state();
            let old = project(&self.header, &self.canonical.tree().to_state())?;
            let new = project(&self.header, &after)?;
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
        self.apply_record(record, raw)?;
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
    }
    pub fn flush(&mut self) -> R<()> {
        if self.chunks.is_empty() && !self.force_remainder {
            return Ok(());
        }
        // A cut of motion and fields set only (#3799): the published state with the touched nodes' rows replaced, its
        // digest worked out in place; any other cut, the public state whole. The same bytes either way.
        let delta = if self.incremental
            && !self.structural
            && !self.force_remainder
            && !self.records.is_empty()
            && self.migration_cut.is_none()
        {
            let tree = self.canonical.tree();
            let rows = self
                .touched
                .iter()
                .filter_map(|id| {
                    let n = tree.node_state_of(*id)?;
                    (n.audience == Audience::Everyone).then(|| (*id, n.to_value()))
                })
                .collect();
            self.player.row_delta(tree.next(), rows)?
        } else {
            None
        };
        let (after, after_digest) = match &delta {
            Some(d) => (None, self.player.digest_with(d)?),
            None => {
                let a = project(&self.header, &self.canonical.tree().to_state())?;
                let h = digest(&a)?;
                (Some(a), h)
            }
        };
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
        let changed = self
            .changes
            .iter()
            .map(|(i, v)| (*i, *v))
            .collect::<Vec<_>>();
        let context = match (&after, &delta) {
            (Some(after), _) => public_context(
                &self.baseline,
                self.player.state(),
                after,
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
        let chunk_hash = self.put(&chunk)?;
        let part_hash = self.put(&bytes)?;
        let text = self.words_after(after.as_ref(), delta.as_ref())?;
        let text_hash = self.put(&text)?;
        self.player.play(&bytes)?;
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
        // Commit exact recovery bytes before exposing local immutable files. A killed publication replays the
        // same committed bytes, never a new cut at an orphan file's address.
        immutable(&self.generation_dir().join(number.to_string()), &bytes)?;
        immutable(&self.generation_dir().join(format!("{number}.text")), &text)?;
        self.last_to = Some(sp.to);
        self.clear_pending();
        self.pointer(None)
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
        if let Some((version, number, hash)) = &self.legacy {
            value.insert(
                9,
                Value::Array(vec![
                    Value::Uint(*version),
                    Value::Uint(*number),
                    Value::Bytes(hash.clone()),
                ]),
            );
        }
        write_whole(&self.dir.join(POINTER), &wire(Value::Map(value))?)
    }
    pub fn idle(&mut self, real: i64) -> R<()> {
        if self.canonical.tree().time().is_empty() && self.clock_seed.is_none() {
            return Ok(());
        }
        let world = mapped_now(self.canonical.tree().time(), self.clock_seed, real)?;
        if self
            .window
            .is_some_and(|w| world >= (w + 1) * stream::PERIOD_US + SETTLE_US)
        {
            self.flush()?;
        }
        let mut published = self.player.state().clone();
        let current = project(&self.header, &self.canonical.tree().to_state())?;
        if let (Value::Map(a), Value::Map(b)) = (&mut published, &current) {
            a.insert(1, b[&1].clone());
        }
        if self.records.is_empty() && published == current {
            self.pointer(Some(world.saturating_sub(SETTLE_US)))?;
        }
        Ok(())
    }
}
