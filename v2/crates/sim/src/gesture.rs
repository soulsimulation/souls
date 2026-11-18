//! Gestures and moods (Engine v2 E11, #2782): any harmless expression can be said and remembered, whether or not
//! anyone drew it yet. No code here names a gesture or a clip.
//!
//! - **A gesture** carries its words, by reference (T8: `{21: id}`, the audience of ordinary speech), and optionally
//!   `like`: one stand-in from the family's table ([`StandIns`]), chosen by the agent. With none, the table's neutral
//!   stand-in is used. The engine never judges which stand-in is nearest.
//! - **It is a move on the body's own kind** (B2): the stand-in is a [`Move`] named by its clip, so the gesture claims
//!   what the stand-in claims, through the controller, and lasts as long. Its contact point is the body's own, so it
//!   reaches nothing; a named target only turns the gaze and changes nothing on the target.
//! - **The record** ([`GestureRecord`]) is the move's record with the words' reference, the stand-in the agent named
//!   and the gaze target beside it. A viewer draws a clip of its own for the words when it has one, else the
//!   stand-in, with a caption of the words; a later viewer with a real clip draws it from the same record.
//! - **A mood** ([`Moods`]) is a field on the body: words by reference and a stand-in, held until changed. It claims
//!   nothing, so a walk or a gesture leaves it as it is.
//! - **The fact** ([`GestureRecord::fact`]) says "gestured, by reference": the reference, never the words.
//!
//! Not here: making clips, choosing a stand-in on the server, falling, touching another (an activity, E8).

use std::collections::BTreeMap;
use std::path::Path;

use replica::audience::REFERENCE;
use replica::effects::{Refusal, read_id};
use replica::encode::{Name, Value};
use replica::ids::{Id, Minter};
use replica::moves::{Effector, Ended, Move, MoveRecord};
use replica::time::Micros;

use crate::controller::Controller;
use crate::moves::{Fired, Instance, Moves, Reach};
use crate::timers::{DueList, Timer};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// The family's table of stand-ins, by name, and the one used when a gesture names none.
#[derive(Clone, Debug)]
pub struct StandIns {
    table: BTreeMap<Name, Move>,
    neutral: Name,
}

impl StandIns {
    /// The table of `moves`, with `neutral` among them (`stand-in-unknown` otherwise).
    pub fn new(moves: Vec<Move>, neutral: Name) -> R<StandIns> {
        let table: BTreeMap<_, _> = moves.into_iter().map(|m| (m.name.clone(), m)).collect();
        if !table.contains_key(&neutral) {
            return refuse("stand-in-unknown", neutral.as_str());
        }
        Ok(StandIns { table, neutral })
    }

    /// Reads every `.diag` move in `dir` (B2's [`crate::moves::load`]) as the table.
    pub fn load(dir: &Path, neutral: Name) -> Result<StandIns, String> {
        StandIns::new(crate::moves::load(dir)?, neutral).map_err(|r| r.to_string())
    }

    /// The stand-in `like` names, or the neutral one: `stand-in-unknown` for a name not in the table.
    pub fn pick(&self, like: Option<&Name>) -> R<&Move> {
        let name = like.unwrap_or(&self.neutral);
        match self.table.get(name) {
            Some(m) => Ok(m),
            None => refuse("stand-in-unknown", name.as_str()),
        }
    }
}

/// A gesture intent: its words by reference, the stand-in the agent named, and whom it looks at.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Gesture {
    pub words: Id,
    pub like: Option<Name>,
    pub gaze: Option<Id>,
}

/// What the log carries of one gesture: its move's record (the stand-in, its limbs, start and phase ends, how it
/// ended), the words' reference, the stand-in the agent named (none: the neutral one) and the gaze target.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GestureRecord {
    pub mv: MoveRecord,
    pub words: Id,
    pub like: Option<Name>,
    pub gaze: Option<Id>,
}

fn reference(id: Id) -> Value {
    Value::Map(BTreeMap::from([(REFERENCE, id.to_value())]))
}

fn read_reference(v: Option<&Value>) -> R<Id> {
    match v {
        Some(r) => replica::audience::reference(r)
            .map_or_else(|| refuse("not-a-gesture", "the words are a reference"), Ok),
        None => refuse("not-a-gesture", "the words are a reference"),
    }
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

fn read_int(v: Option<&Value>) -> R<i64> {
    match v {
        Some(Value::Uint(n)) => i64::try_from(*n).or_else(|_| refuse("not-a-gesture", "a time")),
        Some(Value::Nint(n)) => i64::try_from(*n)
            .map(|n| -1 - n)
            .or_else(|_| refuse("not-a-gesture", "a time")),
        _ => refuse("not-a-gesture", "a time is a whole number"),
    }
}

fn read_name(v: Option<&Value>) -> R<Name> {
    match v {
        Some(Value::Text(t)) => Ok(t.clone()),
        _ => refuse("not-a-gesture", "a name"),
    }
}

fn read_names(v: Option<&Value>) -> R<Vec<Name>> {
    match v {
        Some(Value::Array(a)) => a.iter().map(|x| read_name(Some(x))).collect(),
        _ => refuse("not-a-gesture", "a list of names"),
    }
}

/// B2's record back from its value (`MoveRecord::to_value`'s fields).
fn move_record(v: &Value) -> R<MoveRecord> {
    let Value::Map(m) = v else {
        return refuse("not-a-gesture", "a move record is a map");
    };
    let id = |k| {
        m.get(&k)
            .map_or_else(|| refuse("not-a-gesture", "an id"), read_id)
    };
    let ends = match m.get(&8) {
        Some(Value::Array(a)) => a.iter().map(|x| read_int(Some(x))).collect::<R<_>>()?,
        _ => return refuse("not-a-gesture", "phase ends are a list"),
    };
    let ended = match m.get(&9) {
        None => None,
        Some(Value::Map(e)) => Some(Ended {
            at: read_int(e.get(&1))?,
            how: read_name(e.get(&2))?,
        }),
        Some(_) => return refuse("not-a-gesture", "how it ended is a map"),
    };
    let revision = match m.get(&3) {
        Some(Value::Uint(n)) => *n,
        _ => return refuse("not-a-gesture", "a revision"),
    };
    Ok(MoveRecord {
        body: id(1)?,
        name: read_name(m.get(&2))?,
        revision,
        limbs: read_names(m.get(&4))?,
        target: id(5)?,
        contact: read_name(m.get(&6))?,
        start: read_int(m.get(&7))?,
        ends,
        ended,
    })
}

impl GestureRecord {
    /// `{1: move record, 2: {21: words}, 3: like, 4: gaze}`; 3 and 4 only when named.
    pub fn to_value(&self) -> Value {
        let mut m = BTreeMap::from([(1, self.mv.to_value()), (2, reference(self.words))]);
        if let Some(l) = &self.like {
            m.insert(3, Value::Text(l.clone()));
        }
        if let Some(g) = self.gaze {
            m.insert(4, g.to_value());
        }
        Value::Map(m)
    }

    /// The record back from [`GestureRecord::to_value`]'s value (`not-a-gesture`).
    pub fn from_value(v: &Value) -> R<GestureRecord> {
        let Value::Map(m) = v else {
            return refuse("not-a-gesture", "a gesture record is a map");
        };
        if let Some(k) = m.keys().find(|k| **k == 0 || **k > 4) {
            return refuse("not-a-gesture", format!("field {k}"));
        }
        let mv = m
            .get(&1)
            .map_or_else(|| refuse("not-a-gesture", "a move record"), move_record)?;
        Ok(GestureRecord {
            mv,
            words: read_reference(m.get(&2))?,
            like: m.get(&3).map(|x| read_name(Some(x))).transpose()?,
            gaze: m.get(&4).map(read_id).transpose()?,
        })
    }

    /// The fact sheet's line (V10): `{1: body, 2: "souls:gestured", 3: start, 4: {21: words}}`. The words stay behind
    /// their reference; what was drawn is the viewer's.
    pub fn fact(&self) -> Value {
        Value::Map(BTreeMap::from([
            (1, self.mv.body.to_value()),
            (
                2,
                Value::Text(Name::new("souls:gestured").unwrap_or_else(|| unreachable!())),
            ),
            (3, int(self.mv.start)),
            (4, reference(self.words)),
        ]))
    }
}

/// The geometry a gesture asks: the body's own contact point is where it stands (distance 0); anything else is the
/// world's to answer, and a stand-in reaches nothing else.
struct Own<'a, G: Reach> {
    body: Id,
    geo: &'a G,
}

impl<G: Reach> Reach for Own<'_, G> {
    fn distance(
        &self,
        body: Id,
        effector: &Effector,
        limb: Option<&Name>,
        target: Id,
        point: &Name,
    ) -> Option<i64> {
        if target == self.body && body == self.body {
            Some(0)
        } else {
            self.geo.distance(body, effector, limb, target, point)
        }
    }
}

struct Said {
    words: Id,
    like: Option<Name>,
    gaze: Option<Id>,
}

/// Gestures in progress: the words and stand-in beside each move B2 runs.
#[derive(Default)]
pub struct Gestures {
    said: BTreeMap<Instance, Said>,
}

impl Gestures {
    pub fn new() -> Gestures {
        Gestures::default()
    }

    /// Starts `g` on `body` at `now`: the stand-in it names (or the neutral one) as a move on the body itself, all or
    /// none (`stand-in-unknown`, then B2's and T9's refusals by name).
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &mut self,
        moves: &mut Moves,
        c: &mut Controller,
        due: &mut DueList,
        mint: &mut Minter,
        geo: &impl Reach,
        table: &StandIns,
        body: Id,
        g: &Gesture,
        now: Micros,
    ) -> R<Instance> {
        let mv = table.pick(g.like.as_ref())?;
        let n = moves.start(c, due, mint, &Own { body, geo }, body, mv, body, now)?;
        self.said.insert(
            n,
            Said {
                words: g.words,
                like: g.like.clone(),
                gaze: g.gaze,
            },
        );
        Ok(n)
    }

    /// The record of gesture `n` in progress.
    pub fn record(&self, moves: &Moves, n: Instance) -> Option<GestureRecord> {
        let s = self.said.get(&n)?;
        Some(GestureRecord {
            mv: moves.record(n)?.clone(),
            words: s.words,
            like: s.like.clone(),
            gaze: s.gaze,
        })
    }

    /// Runs a timer the due list handed back, as [`Moves::fire`] does, asking the reach of a gesture's own body as
    /// its start did. With it, the gesture's record once its move ended (done or cancelled); `None` when the timer is
    /// no move's.
    pub fn fire(
        &mut self,
        moves: &mut Moves,
        c: &mut Controller,
        due: &mut DueList,
        mint: &mut Minter,
        geo: &impl Reach,
        t: &Timer,
    ) -> Option<(Fired, Option<GestureRecord>)> {
        let n = moves.instance_of(t)?;
        let body = moves.record(n)?.body;
        let fired = moves.fire(c, due, mint, &Own { body, geo }, t)?;
        let mv = match &fired {
            Fired::Done(r) | Fired::Cancelled(r) => r.clone(),
            Fired::Phase { .. } => return Some((fired, None)),
        };
        let ended = self.said.remove(&n).map(|s| GestureRecord {
            mv,
            words: s.words,
            like: s.like,
            gaze: s.gaze,
        });
        Some((fired, ended))
    }
}

/// A body's mood: words by reference and the stand-in it is drawn as, held from `since` until changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mood {
    pub words: Id,
    pub like: Option<Name>,
    pub since: Micros,
}

impl Mood {
    /// `{1: since, 2: {21: words}, 3: like}`, 3 only when named.
    pub fn to_value(&self) -> Value {
        let mut m = BTreeMap::from([(1, int(self.since)), (2, reference(self.words))]);
        if let Some(l) = &self.like {
            m.insert(3, Value::Text(l.clone()));
        }
        Value::Map(m)
    }

    /// The mood back from [`Mood::to_value`]'s value (`not-a-gesture`).
    pub fn from_value(v: &Value) -> R<Mood> {
        let Value::Map(m) = v else {
            return refuse("not-a-gesture", "a mood is a map");
        };
        Ok(Mood {
            since: read_int(m.get(&1))?,
            words: read_reference(m.get(&2))?,
            like: m.get(&3).map(|x| read_name(Some(x))).transpose()?,
        })
    }
}

/// Each body's mood: a field on the body, set and cleared by intent and by nothing else.
#[derive(Default)]
pub struct Moods {
    by_body: BTreeMap<Id, Mood>,
}

impl Moods {
    pub fn new() -> Moods {
        Moods::default()
    }

    /// `body`'s mood, if it has one.
    pub fn get(&self, body: Id) -> Option<&Mood> {
        self.by_body.get(&body)
    }

    /// Sets `body`'s mood (none clears it): `stand-in-unknown` for a stand-in not in the table, and nothing changes.
    pub fn set(&mut self, table: &StandIns, body: Id, mood: Option<Mood>) -> R<()> {
        match mood {
            Some(m) => {
                table.pick(m.like.as_ref())?;
                self.by_body.insert(body, m);
            }
            None => {
                self.by_body.remove(&body);
            }
        }
        Ok(())
    }
}
