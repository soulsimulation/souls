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
//!    (or on [`Writer::flush`]); it is numbered in the order written. A stretch with no records writes no part.
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
//!
//! Not here: serving (V2), history (V3), snapshot chunks for a reader that joins late, the words path (W4), and a
//! subtree carried in on an arrival whose leave the view did not hold (T7 rule 4): its record holds the subtree as it
//! was in flight but not where it lands, so no reader could land it, and the writer refuses it as `stream-carried`.
//! A view of a zone's root that starts with the zone holds every leave, so it never writes one.

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
use replica::pose::Pose;
use replica::stream::{self, HASH_EVERY, POINTER, Pointer, StreamPart};
use replica::time::{Micros, TimeEffect};
use replica::views::Key;
use replica::world_model::{Audience, End};

use crate::views::{Delivery, Subscriber};

type R<T> = Result<T, Refusal>;

fn fault(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

fn io(e: std::io::Error) -> Refusal {
    fault("stream-write", e.to_string())
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
    last_to: Option<Micros>,
    written: Written,
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
            last_to: None,
            written: Written::default(),
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
        if viewed.iter().any(|(_, _, n)| n.motion.is_some()) {
            return Err(fault(
                "stream-start-moving",
                "a node of the view is in motion",
            ));
        }
        let header = with_kinds(header, &top.kind, viewed.iter().map(|(_, _, n)| &n.kind))?;
        let mut w = Writer::create(root, &header, key, anchor)?;

        let at = state
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
            changes.push(Change::Create {
                node: *id,
                kind: n.kind.clone(),
                pose,
                audience: n.audience,
                fields: n.fields.clone(),
            });
        }
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
        w.write(at.div_euclid(stream::PERIOD_US), records, gaps, true)?;
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
            if rm.contains_key(&0) {
                return Err(fault(
                    "stream-carried",
                    "a carried subtree (an arrival) does not name where it lands (T7's record has no destination)",
                ));
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
            self.pending.push(r);
        }
        Ok(())
    }

    /// Writes the open stretch, if any.
    pub fn flush(&mut self) -> R<()> {
        self.cut()
    }

    /// Says in the pointer that the world is still until `until` (world time); it writes nothing until then.
    pub fn quiet(&mut self, until: Option<Micros>) -> R<()> {
        self.quiet_until = until;
        self.pointer()
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
        if records.is_empty() {
            return Ok(());
        }
        self.write(w, records, gaps, false)
    }

    /// Writes one part of `records` in world-time window `w`, carrying the state hash when due or when `hashed`.
    fn write(&mut self, w: i64, records: Vec<Value>, gaps: Vec<(u64, u64)>, hashed: bool) -> R<()> {
        let first = match records.first() {
            Some(Value::Map(m)) => match m.get(&1) {
                Some(Value::Uint(s)) => *s,
                _ => return Err(fault("stream-frame", "a record has no sequence")),
            },
            _ => return Err(fault("stream-frame", "a record is a map")),
        };
        let entries = u64::try_from(records.len()).unwrap_or(u64::MAX);
        let raw = encode(&Value::Map(
            [
                (1, Value::Bytes(self.header.hash().to_bytes())),
                (2, Value::Array(records)),
            ]
            .into(),
        ))
        .map_err(|e| fault("encoding", e.to_string()))?;
        // Decoded once, and applied to the view's copy, before it is published (rule 2).
        let part = Part::read(&raw)?;
        self.copy.apply_gaps(&part, &gaps)?;
        let number = self.written.parts;
        let hash = if hashed || (number + 1).is_multiple_of(HASH_EVERY) {
            Some(replica::hash::state_hash(self.copy.tree())?.to_bytes())
        } else {
            None
        };
        let (from, to) = (w * stream::PERIOD_US, (w + 1) * stream::PERIOD_US);
        let sp = StreamPart {
            number,
            from,
            to,
            first,
            entries,
            part: raw,
            hash,
            gaps,
        };
        let bytes = sp.to_bytes()?;
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
/// open stretch and gives the writer back. A snapshot delivery ends it with `stream-gap` (rule 6).
pub fn follow(mut writer: Writer, sub: Subscriber, stop: Arc<AtomicBool>) -> JoinHandle<R<Writer>> {
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
        }
        writer.flush()?;
        Ok(writer)
    })
}
