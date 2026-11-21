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

/// What the edit checker's thread reads for one undo.
pub struct Ask<'a> {
    pub actor: Actor,
    pub creator: Option<Id>,
    pub redo: bool,
    pub effects: Vec<Effect>,
    pub copy: &'a Replica,
    pub kinds: &'a BTreeMap<String, Kind>,
    pub moving: &'a [Who],
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
    let part = part_on(a.copy, a.effects.clone())?;
    let souls = buildsafe::judged(buildsafe::souls(a.copy, a.kinds), a.moving);
    let ground = buildsafe::open_ground(a.copy);
    let header = a.copy.header();
    let checked = match town.on(a.copy, ground, false) {
        Some(t) => safety::check_on(a.copy.tree(), header, &part, &souls, &Known::of(t)),
        None => safety::check(a.copy.tree(), header, ground, &part, &souls),
    };
    let (guard, v) = checked.map_err(|e| refused("edit.unsafe-check", e))?;
    verdict(&v)?;
    let maps = a
        .source
        .map(|s| PreparedMaps::prepare_part(a.copy, Arc::new(part), s, a.movers))
        .transpose()?;
    Ok(Checked {
        redo: a.redo,
        effects: a.effects,
        guard,
        souls,
        maps,
    })
}
