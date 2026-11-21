//! A creator's undo and redo, served (Engine v2 G4 on the wire, #3694). The engine's history (`sim::edit::undo`) is
//! kept on the clock thread, which records each committed edit's before-values and, asked for an undo or a redo,
//! previews the inverse effects it would write (G1's gate and the conflict check, lookups only). The edit checker's
//! thread then does here what it does for an edit: it confirms the asker is the world's creator, judges the would-be
//! part by G2's safety rule on its town (BUILDSAFE: an undo that would bury a Soul, cut it off or change what it uses
//! is refused by name, never repaired), and prepares the walkers' maps from the same part. At the next tick the clock
//! writes the undo through the history, whose rule finds the same effects and judges the bodies as they stand.

use crate::buildsafe::{self, PreparedMaps, TownCopy};
use replica::apply::Replica;
use replica::edit::{Refused, Unsafe};
use replica::effects::{Actor, Effect, Part};
use replica::encode::{Value, encode};
use replica::ids::Id;
use replica::kinds::sizes::Size;
use replica::world_model::Kind;
use sim::edit::safety::{self, Guard, Known, Who};
use std::collections::BTreeMap;
use std::sync::Arc;

/// An undo or a redo checked off the clock: the effects previewed, G2's guard for them with the Souls it judged, and
/// the walkers' maps when the world has walkers.
pub struct Checked {
    pub redo: bool,
    pub effects: Vec<Effect>,
    pub guard: Guard,
    /// The guard for each body size other than the standard one (as an edit's, `sim::edit::plan_classes`).
    pub classes: BTreeMap<Size, Guard>,
    pub souls: Vec<Who>,
    pub maps: Option<PreparedMaps>,
}

fn refused(name: &'static str, detail: impl Into<String>) -> Refused {
    Refused {
        op: None,
        name,
        detail: detail.into(),
    }
}

/// `effects` as a part on `copy`, numbered from its version, not applied.
pub fn part_on(copy: &Replica, mut effects: Vec<Effect>) -> Result<Part, Refused> {
    for (k, e) in effects.iter_mut().enumerate() {
        e.envelope.sequence = copy.version() + k as u64;
    }
    let v = Value::Map(BTreeMap::from([
        (1, Value::Bytes(copy.header().hash().to_bytes())),
        (
            2,
            Value::Array(effects.iter().map(Effect::to_value).collect()),
        ),
    ]));
    let bytes = encode(&v).map_err(|e| refused("encoding", e.to_string()))?;
    Part::read(&bytes).map_err(|r| refused(r.name, r.detail))
}

/// The first unsafe body, as an edit's refusal names it.
pub fn verdict(v: &[Unsafe]) -> Result<(), Refused> {
    match v.first() {
        Some(u) => Err(refused(u.name, format!("{:?} at {:?}", u.soul, u.node))),
        None => Ok(()),
    }
}

/// Whether `a` writes what `b` does: the same changes by the same nodes to the same audiences, in order (their
/// sequences and times aside).
pub fn same(a: &[Effect], b: &[Effect]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| {
            x.body == y.body
                && x.envelope.node == y.envelope.node
                && x.envelope.audience == y.envelope.audience
                && x.envelope.cause == y.envelope.cause
        })
}

/// Each body judged by the guard for its size: the standard guard, or its class's; a body whose class has no guard
/// is refused `edit.class-unchecked`, as an edit's commit refuses it.
pub fn judge(
    guard: &Guard,
    classes: &BTreeMap<Size, Guard>,
    sizes: &BTreeMap<Id, Size>,
    bodies: &[Who],
) -> Result<(), Refused> {
    for body in bodies {
        let size = sizes.get(&body.body).copied().unwrap_or(Size::Standard);
        let g = if size == Size::Standard {
            guard
        } else {
            classes.get(&size).ok_or_else(|| {
                refused(
                    "edit.class-unchecked",
                    "the current body's footprint was not prepared",
                )
            })?
        };
        verdict(&g.judge(std::slice::from_ref(body)))?;
    }
    Ok(())
}

/// What the edit checker's thread reads for one undo.
pub struct Ask<'a> {
    pub actor: Actor,
    pub creator: Option<Id>,
    pub redo: bool,
    pub effects: Vec<Effect>,
    pub copy: &'a Replica,
    pub kinds: &'a BTreeMap<String, Kind>,
    pub moving: &'a [Who],
    pub sizes: &'a BTreeMap<Id, Size>,
    pub source: Option<&'a buildsafe::MapBasis>,
    pub movers: &'a [sim::controller::BuildBasis],
}

/// Off the clock: the creator, G2's rule on `town` (or on the copy's whole ground without one) and the maps.
pub fn check(a: Ask<'_>, town: &mut TownCopy) -> Result<Checked, Refused> {
    match (a.creator, a.actor) {
        (Some(c), Actor::Creator(x)) if c == x => {}
        _ => {
            return Err(refused(
                "edit.not-the-creator",
                "only the world's creator undoes",
            ));
        }
    }
    // A live claim's area is its holder's: the lead's undo may not reach into it (#3727).
    replica::edit::claims::judge_effects(a.copy, &a.effects)?;
    let part = part_on(a.copy, a.effects.clone())?;
    let souls = buildsafe::judged(buildsafe::souls(a.copy, a.kinds), a.moving);
    let ground = buildsafe::open_ground(a.copy);
    let header = a.copy.header();
    let unchecked = |e: String| refused("edit.unsafe-check", e);
    let guard = match town.on(a.copy, ground, false) {
        Some(t) => safety::guard_on(a.copy.tree(), header, &part, &Known::of(t)),
        None => safety::guard(a.copy.tree(), header, ground, &part),
    }
    .map_err(unchecked)?;
    let mut classes = BTreeMap::new();
    for &size in a.sizes.values() {
        if size != Size::Standard && !classes.contains_key(&size) {
            let g =
                safety::guard_for(a.copy.tree(), header, ground, &part, size).map_err(unchecked)?;
            classes.insert(size, g);
        }
    }
    judge(&guard, &classes, a.sizes, &souls)?;
    let maps = a
        .source
        .map(|s| PreparedMaps::prepare_part(a.copy, Arc::new(part), s, a.movers))
        .transpose()?;
    Ok(Checked {
        redo: a.redo,
        effects: a.effects,
        guard,
        classes,
        souls,
        maps,
    })
}
