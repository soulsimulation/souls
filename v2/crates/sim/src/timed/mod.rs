//! Values that change with time, on the world's side (Engine v2 F5, #2770): a thing whose value changes by itself
//! costs nothing until it crosses a level the kind names, and the crossing starts the kind's form with the world as
//! actor. No code here names a kind, a field or a form.
//!
//! - **Three numbers and one due entry.** Each timed value is kept as [`replica::timed::Timed`] (value, rate per
//!   second, time set), the same three a viewer draws from. Its kind gives its limits and levels ([`Field`]). Of the
//!   levels not met, the next crossing is worked out exactly and is the value's one entry on K9's due list
//!   (`souls:timed-cross`): between changes and crossings the value costs no tick anything.
//! - **Any change settles and replaces.** [`Values::change`] settles the value to now, rewrites the three numbers and
//!   replaces the entry: the old one is cancelled on the due list, and one that still reaches [`Values::fire`] is
//!   not the value's entry and fires nothing.
//! - **A crossing starts a form by an event.** [`Values::fire`] hands back each level the value reached at the entry's
//!   time ([`Crossed`]) and sets the next entry; [`start_form`] hands the level's form to F1's runner with an intent
//!   whose actor is the world, keyed by the due entry, so F2 writes its effect once (a doubled timer joins the run).
//! - **Order.** Entries due at one instant run in the due list's order: time, then entry id, which is the order they
//!   were set (K9), fixed and kept across a checkpoint.
//!
//! Not here: a value jumping a level by a change (only crossings with time fire), several runs on one thing at one
//! instant (the second is refused `form-running`), rebuilding the values from a checkpoint, any trigger but a value
//! crossing a level (E18).

use std::collections::{BTreeMap, HashMap};

use replica::effects::{Actor, Refusal};
use replica::encode::Name;
use replica::ids::{Id, Minter};
use replica::rules::json::Value as J;
use replica::time::Micros;
use replica::timed::{Bounds, Level, Timed};
use replica::world_model::show;
use skills::form_runner::{Limits, bind, bind_effects};

use crate::forms::{Asked, Forms, Intent, World};
use crate::host::Geometry;
use crate::moves::Reach;
use crate::timers::{DueList, Key, Timer};

/// The due entry's name.
pub const CROSS: &str = "souls:timed-cross";

/// A timed field as its kind gives it: its number, its limits, and its levels each with the form a crossing starts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Field {
    pub n: u64,
    pub bounds: Bounds,
    pub levels: Vec<(Level, String)>,
}

fn refuse<T>(name: &'static str, detail: &str) -> Result<T, Refusal> {
    Err(Refusal {
        name,
        detail: detail.to_owned(),
    })
}

fn whole(v: Option<&J>) -> Option<i64> {
    match v? {
        J::Int(n) => i64::try_from(*n).ok(),
        _ => None,
    }
}

/// Reads timed field `name` of kind entry `entry`: `{"n", "type": "timed", "min"?, "max"?, "levels"?: [{"at_least" |
/// "at_most": L, "form"}]}`. Refused `field-unknown`, `field-not-timed`, `level-malformed`.
pub fn field_of(entry: &J, name: &str) -> Result<Field, Refusal> {
    let Some(f) = entry.get("state").and_then(|s| s.get(name)) else {
        return refuse("field-unknown", name);
    };
    let n = whole(f.get("n")).and_then(|n| u64::try_from(n).ok());
    let (Some(n), Some("timed")) = (n, f.get("type").and_then(J::str)) else {
        return refuse("field-not-timed", name);
    };
    let mut levels = Vec::new();
    for l in f.get("levels").and_then(J::arr).unwrap_or(&[]) {
        let level = match (whole(l.get("at_least")), whole(l.get("at_most"))) {
            (Some(v), None) => Level::AtLeast(v),
            (None, Some(v)) => Level::AtMost(v),
            _ => return refuse("level-malformed", name),
        };
        let Some(form) = l.get("form").and_then(J::str) else {
            return refuse("level-malformed", name);
        };
        levels.push((level, form.to_owned()));
    }
    Ok(Field {
        n,
        bounds: Bounds {
            min: whole(f.get("min")),
            max: whole(f.get("max")),
        },
        levels,
    })
}

/// A level a value reached: the thing, the field, the level and its form, the time, and the due entry that fired.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Crossed {
    pub node: Id,
    pub field: u64,
    pub level: Level,
    pub form: String,
    pub at: Micros,
    pub entry: Id,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Kept {
    now: Timed,
    field: Field,
    /// The value's entry on the due list, and the time its crossing was worked out from.
    due: Option<(Key, Micros)>,
}

/// Every timed value of a zone, with its entry on the due list.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Values {
    kept: BTreeMap<(Id, u64), Kept>,
    by_entry: HashMap<Id, (Id, u64)>,
}

fn timed_refusal(r: replica::timed::TimedRefusal, node: Id) -> Refusal {
    Refusal {
        name: r.name(),
        detail: show(node),
    }
}

impl Values {
    pub fn new() -> Values {
        Values::default()
    }

    /// Timed values kept.
    pub fn len(&self) -> usize {
        self.kept.len()
    }

    pub fn is_empty(&self) -> bool {
        self.kept.is_empty()
    }

    /// The three numbers of `node`'s field `field`.
    pub fn get(&self, node: Id, field: u64) -> Option<Timed> {
        self.kept.get(&(node, field)).map(|k| k.now)
    }

    /// Every value's three numbers, by thing and field.
    pub fn all(&self) -> impl Iterator<Item = ((Id, u64), Timed)> + '_ {
        self.kept.iter().map(|(k, v)| (*k, v.now))
    }

    /// Writes `to` as `node`'s value of `field` at `now` (`to.set_us` at or before it) and sets its entry.
    pub fn set(
        &mut self,
        due: &mut DueList,
        mint: &mut Minter,
        node: Id,
        field: &Field,
        to: Timed,
        now: Micros,
    ) -> Result<(), Refusal> {
        let next = next(to, field, now).map_err(|r| timed_refusal(r, node))?;
        let key = (node, field.n);
        if let Some(old) = self.kept.remove(&key) {
            self.unset(due, old.due);
        }
        let mut kept = Kept {
            now: to,
            field: field.clone(),
            due: None,
        };
        if let Some(at) = next {
            kept.due = Some((self.entry(due, mint, node, key, at)?, now));
        }
        self.kept.insert(key, kept);
        Ok(())
    }

    /// Changes `node`'s rate of `field` at `now`: the value settled to now, the three numbers rewritten and the entry
    /// replaced. Returns the new three, for the writer to log. `timed-unknown` for a value not kept.
    pub fn change(
        &mut self,
        due: &mut DueList,
        mint: &mut Minter,
        node: Id,
        field: u64,
        per_s: i64,
        now: Micros,
    ) -> Result<Timed, Refusal> {
        let Some(k) = self.kept.get(&(node, field)) else {
            return refuse("timed-unknown", &show(node));
        };
        let to = k
            .now
            .settle(k.field.bounds, now, per_s)
            .map_err(|r| timed_refusal(r, node))?;
        let f = k.field.clone();
        self.set(due, mint, node, &f, to, now)?;
        Ok(to)
    }

    /// Runs a timer the due list handed back, at its due time: when it is a value's entry, every level the value
    /// reached then, in the kind's order, and the value's next entry set. `None` for any other timer, a stale
    /// entry included.
    pub fn fire(
        &mut self,
        due: &mut DueList,
        mint: &mut Minter,
        t: &Timer,
    ) -> Option<Vec<Crossed>> {
        let key = *self.by_entry.get(&t.id)?;
        let k = self.kept.get_mut(&key)?;
        let ((at, id), from) = k.due.filter(|((_, id), _)| *id == t.id)?;
        self.by_entry.remove(&id);
        k.due = None;
        let (now, field) = (k.now, k.field.clone());
        let crossed = field
            .levels
            .iter()
            .filter(|(l, _)| now.crossing(field.bounds, *l, from) == Ok(Some(at)))
            .map(|(l, form)| Crossed {
                node: key.0,
                field: key.1,
                level: *l,
                form: form.clone(),
                at,
                entry: id,
            })
            .collect();
        if let Ok(Some(n)) = next(now, &field, at)
            && let Ok(e) = self.entry(due, mint, key.0, key, n)
            && let Some(k) = self.kept.get_mut(&key)
        {
            k.due = Some((e, at));
        }
        Some(crossed)
    }

    fn entry(
        &mut self,
        due: &mut DueList,
        mint: &mut Minter,
        node: Id,
        key: (Id, u64),
        at: Micros,
    ) -> Result<Key, Refusal> {
        let Ok(id) = mint.mint() else {
            return refuse("ids-exhausted", &show(node));
        };
        due.set(Timer {
            node,
            id,
            due: at,
            name: Name::new(CROSS).unwrap_or_else(|| unreachable!("a name")),
        })?;
        self.by_entry.insert(id, key);
        Ok((at, id))
    }

    fn unset(&mut self, due: &mut DueList, old: Option<(Key, Micros)>) {
        if let Some((k, _)) = old {
            due.cancel(k);
            self.by_entry.remove(&k.1);
        }
    }
}

/// The next time a level not met at `from` is reached, if any.
fn next(v: Timed, f: &Field, from: Micros) -> Result<Option<Micros>, replica::timed::TimedRefusal> {
    let now = v.at(f.bounds, from)?;
    let mut best = None;
    for (l, _) in &f.levels {
        if l.met(now) {
            continue;
        }
        if let Some(t) = v.crossing(f.bounds, *l, from)? {
            best = Some(best.map_or(t, |b: Micros| b.min(t)));
        }
    }
    Ok(best)
}

/// Starts the form of crossing `c` on its thing, by the event: steps and effects bound from kind entry `entry`, run
/// by F1 and F2 with the world as actor and the due entry as the intent's key, so a doubled entry joins the run and
/// its effect is written once.
pub fn start_form<G: Geometry, R: Reach>(
    forms: &mut Forms,
    w: &mut World<'_, G, R>,
    c: &Crossed,
    entry: &J,
    limits: Limits,
) -> Result<Asked, Refusal> {
    let steps = bind(entry, &c.form)?;
    let effects = bind_effects(entry, &c.form)?;
    let mut digest = [0u8; 32];
    digest[..8].copy_from_slice(&c.field.to_be_bytes());
    digest[8..16].copy_from_slice(&c.at.to_be_bytes());
    let (kind, l) = match c.level {
        Level::AtLeast(l) => (1u8, l),
        Level::AtMost(l) => (2, l),
    };
    digest[16] = kind;
    digest[17..25].copy_from_slice(&l.to_be_bytes());
    let intent = Intent {
        id: c.entry,
        expiry: c.at,
        actor: Actor::World,
        digest,
    };
    forms.start(w, c.node, c.node, intent, steps, effects, limits, c.at)
}

#[cfg(test)]
mod tests;
