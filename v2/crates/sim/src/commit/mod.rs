//! Confirm and apply (Engine v2 I3, #2686): the clock thread's whole share of an act. Checker threads (`worldd`'s
//! `checkers`) run the form rules (R2) on a frozen copy (K8) for each candidate of an act's ranked list and hand over
//! [`Checks`]: each candidate's verdict, its prepared changes and its read set, the version stamp of every node the
//! check read. At commit the clock thread compares those stamps with the live replica's, in rank order, and applies
//! the first candidate whose reads are unchanged and whose verdict is yes. That is all it does: it runs no form rule
//! and no route search ([`off_clock`] catches one that does). The one rule it runs is the structure rule
//! ([`crate::structure`], B18), on [`write_guarded`]: it reads only the bays the part changes.
//!
//! This is optimistic concurrency, as HTTP's `If-Match`: what was read is confirmed unchanged at commit. A stamp is
//! per node, so a change to any field of a node read invalidates the check (a false conflict costs a re-check, never
//! a wrong commit). If every candidate's reads changed, the act goes back for one re-check on a newer copy
//! ([`Outcome::Recheck`]); stale again after that, it is refused (`stale`).
//!
//! An act's life around the commit (repeats, receipts, deadlines, expiry) is [`acts`] (I4, #2687). A slot's ranked
//! fallbacks, named slots and selectors a checker resolved, are bound in rank order by [`bind`] (I5, #2690); a
//! described spot by [`spot`] (E2, #2709).
//!
//! **Size.** Every write is refused `part.too-large`, before anything applies, when its part's bytes exceed
//! [`PART_MOST`] or the room left in the calling thread's tick ([`open_room`]): a tick's parts go into one log
//! record, which holds at most [`crate::log::MAX_RECORD`] bytes, and a record the log refuses would leave the live
//! world ahead of its disk. The world opens a tick's room on its clock thread; elsewhere only [`PART_MOST`] binds.

pub mod acts;
pub mod bind;
pub mod spot;

use crate::structure::Structure;
use replica::apply::Replica;
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Part, Refusal, Rest,
};
use replica::encode::{Value, encode};
use replica::ids::Id;
use replica::read::Read;
use replica::time::Micros;
use replica::world_model::Audience;
use std::cell::Cell;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

/// A candidate's verdict as its checker found it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Yes,
    /// R2's reason, the binder's (`effect-not-built`, ...), or the checker's own (`unknown`).
    No(String),
}

/// One candidate, checked on a frozen copy.
#[derive(Clone, Debug)]
pub struct Checked {
    pub verdict: Verdict,
    /// The node whose system writes the effect: the candidate's thing.
    pub node: Id,
    /// The changes to apply if it commits, prepared by the checker.
    pub changes: Vec<Change>,
    /// Every node the check read and its version stamp on the copy (0 for one not there).
    pub reads: Vec<(Id, u64)>,
}

/// An act's candidates in rank order, checked on one frozen copy.
#[derive(Clone, Debug)]
pub struct Checks {
    pub act: u64,
    pub cause: Cause,
    pub actor: Actor,
    /// The version of the copy the candidates were checked on.
    pub version: u64,
    /// Whether this is the act's one re-check.
    pub rechecked: bool,
    pub candidates: Vec<Checked>,
}

/// What a commit did.
#[derive(Clone, Debug)]
pub enum Outcome {
    /// The candidate of this rank applied, as this part (for the publisher).
    Applied { rank: usize, part: Arc<Part> },
    /// Some candidate's reads changed and none applied: check again on a copy at the live version or newer.
    Recheck { version: u64 },
    /// No candidate applies: the first unchanged candidate's reason, or `stale` after the re-check.
    Refused { reason: String },
}

/// Whether every read stamp equals the live one.
pub fn unchanged(live: &impl Read, reads: &[(Id, u64)]) -> bool {
    reads.iter().all(|(id, stamp)| live.stamp(*id) == *stamp)
}

/// The clock thread: confirms `checks` against `live` and applies the first candidate that holds (see the module's
/// notes), as one effect at the live version, written at `at`.
pub fn commit(live: &mut Replica, checks: &Checks, at: Micros) -> Outcome {
    commit_guarded(live, checks, at, &Structure::default())
}

/// [`commit`], with the world's structure rule ([`crate::structure`], B18) checked on the write.
pub fn commit_guarded(
    live: &mut Replica,
    checks: &Checks,
    at: Micros,
    structure: &Structure,
) -> Outcome {
    let mut stale = false;
    let mut first_no: Option<&str> = None;
    for (rank, c) in checks.candidates.iter().enumerate() {
        if !unchanged(live, &c.reads) {
            stale = true;
            continue;
        }
        match &c.verdict {
            Verdict::No(reason) => {
                first_no.get_or_insert(reason);
            }
            Verdict::Yes => {
                return match apply(live, checks, c, at, structure) {
                    Ok(part) => Outcome::Applied { rank, part },
                    Err(r) => Outcome::Refused {
                        reason: r.name.to_owned(),
                    },
                };
            }
        }
    }
    if stale && !checks.rechecked {
        return Outcome::Recheck {
            version: live.version(),
        };
    }
    Outcome::Refused {
        reason: match (stale, first_no) {
            (true, _) => "stale".to_owned(),
            (false, Some(r)) => r.to_owned(),
            (false, None) => "no_candidate".to_owned(),
        },
    }
}

/// One effect with the candidate's changes, at the live version, applied whole or not at all.
fn apply(
    live: &mut Replica,
    checks: &Checks,
    c: &Checked,
    at: Micros,
    structure: &Structure,
) -> Result<Arc<Part>, Refusal> {
    let effect = Effect {
        envelope: Envelope {
            sequence: live.version(),
            at,
            cause: checks.cause,
            actor: checks.actor,
            audience: Audience::Everyone,
            node: c.node,
        },
        body: Body::Changes(
            c.changes
                .iter()
                .map(|change| ChangeRec {
                    change: change.clone(),
                    rest: Rest::new(),
                })
                .collect(),
        ),
        events: None,
        rest: Rest::new(),
    };
    write_guarded(live, &[effect], structure)
}

/// The one write path: `effects` as one part, applied to `live` whole or not at all. Acts (above) and a creator's
/// edits (`crate::edit`, G1, #2746) both commit through it.
pub fn write(live: &mut Replica, effects: &[Effect]) -> Result<Arc<Part>, Refusal> {
    write_guarded(live, effects, &Structure::default())
}

/// [`write`], refused before anything applies when it would leave a part of a bay unsupported ([`Structure`], B18).
pub fn write_guarded(
    live: &mut Replica,
    effects: &[Effect],
    structure: &Structure,
) -> Result<Arc<Part>, Refusal> {
    let v = Value::Map(BTreeMap::from([
        (1, Value::Bytes(live.header().hash().to_bytes())),
        (
            2,
            Value::Array(effects.iter().map(Effect::to_value).collect()),
        ),
    ]));
    let bytes = encode(&v).map_err(|e| Refusal {
        name: "encoding",
        detail: e.to_string(),
    })?;
    let part = Part::read(&bytes)?;
    structure.check(live.tree(), &part.effects)?;
    let room = ROOM.get();
    take_room(bytes.len())?;
    if let Err(r) = live.apply(&part) {
        ROOM.set(room);
        return Err(r);
    }
    Ok(Arc::new(part))
}

/// The most bytes one part holds: half a log record, so a part and the rest of its tick fit in one.
pub const PART_MOST: usize = crate::log::MAX_RECORD / 2;
/// The bytes a tick's parts may hold together, leaving room in its record for its answers, bodies and state.
pub const TICK_PARTS_MOST: usize = crate::log::MAX_RECORD - (8 << 20);

thread_local! {
    static CLOCK: Cell<bool> = const { Cell::new(false) };
    /// The bytes the calling thread's tick still has room for, once [`open_room`] has opened one.
    static ROOM: Cell<Option<usize>> = const { Cell::new(None) };
}

/// Opens a new tick's room on the calling thread: from now its writes together hold at most `most` bytes (the world
/// gives [`TICK_PARTS_MOST`]), until the next call. The world calls it each time it hands a tick's record to the log.
pub fn open_room(most: usize) {
    ROOM.set(Some(most));
}

/// `part.too-large` when `len` bytes exceed [`PART_MOST`] or the calling thread's room; else takes them from it.
fn take_room(len: usize) -> Result<(), Refusal> {
    let room = ROOM.get();
    let most = room.map_or(PART_MOST, |r| r.min(PART_MOST));
    if len > most {
        return Err(Refusal {
            name: "part.too-large",
            detail: format!("{len} bytes, over the {most} this tick has room for"),
        });
    }
    if let Some(r) = room {
        ROOM.set(Some(r - len));
    }
    Ok(())
}

static ON_CLOCK: AtomicU64 = AtomicU64::new(0);

/// Marks the calling thread as the clock thread, for [`off_clock`].
pub fn mark_clock_thread() {
    CLOCK.set(true);
}

/// A checker calls this before each rule check or route search. On the clock thread it panics in a debug build (so
/// a test that runs one there fails) and is counted in a release build ([`checks_on_clock`]): the clock never stops.
pub fn off_clock() {
    if CLOCK.get() {
        ON_CLOCK.fetch_add(1, Relaxed);
        debug_assert!(
            false,
            "a rule check or route search ran on the clock thread"
        );
    }
}

/// Rule checks and route searches that ran on a clock thread (release builds; a debug build panics first).
pub fn checks_on_clock() -> u64 {
    ON_CLOCK.load(Relaxed)
}
