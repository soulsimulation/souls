//! The utterance record (Engine v2 B11, #2742; `v2/docs/audience.md` rule 4): what a voice said, as the log holds it.
//!
//! An utterance is the event `souls:said {1: {21: words}, 2: reach mm, 3: [hearer, ...], 4: length µs}` in an entry
//! whose audience says who may read it (T8). So reach and audience are two fields: how far the voice carried and who
//! heard it (2, 3) is not who may read it (the entry's audience). Ordinary talk has the public audience and a short
//! reach; a whisper (an audience of one), a shout (a longer reach) and a device that carries a voice (E13) are other
//! values of the same fields, with no change of format.
//!
//! - **Words by reference** (T8 rule 6): field 1 is `{21: id}`; the words live in the store, never in the log, so a
//!   removed sentence leaves its event and no words.
//! - **Hearers resolved at write.** Field 3 lists the hearing Souls (their bodies, which name them by `souls:body-of`;
//!   never an account), in id order, worked out by the world when it writes the entry. A replay and every view read
//!   this list; nothing works hearers out again when read.
//! - **Its length in time** comes from its words at [`RATE`] characters a second, at least [`SHORTEST`]: one timer.
//! - **Heard, as a Soul's view stream carries it** (C6, #3390): the view tier addresses an utterance to each
//!   subscription that follows one of its hearers, as R4's item `{1: 9, 2: entry, 3: words}`, the words read from
//!   the store for that subscriber's audiences; [`heard`] reads it back.
//!
//! Not here: who hears (the world's `sim::speech`), the voice resource (`sim::controller`), refusing oversized text
//! (the gateway, I2).

use std::collections::{BTreeMap, BTreeSet};

use crate::audience::REFERENCE;
use crate::effects::{Effect, Event, Refusal, read_id};
use crate::encode::{Name, Value, decode};
use crate::ids::Id;
use crate::time::Micros;
use crate::world_model::Audience;

type R<T> = Result<T, Refusal>;

/// The event's name.
pub const SAID: &str = "souls:said";
/// The rate an utterance's length is worked out at, characters a second (about 180 words a minute).
pub const RATE: u64 = 15;
/// The shortest an utterance lasts, µs.
pub const SHORTEST: Micros = 500_000;

/// How long `words` take to say: their characters at [`RATE`] a second, at least [`SHORTEST`].
pub fn length_of(words: &str) -> Micros {
    let chars = words.chars().count() as u64;
    let us = chars.saturating_mul(1_000_000) / RATE;
    Micros::try_from(us).unwrap_or(Micros::MAX).max(SHORTEST)
}

/// One utterance, as written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Said {
    /// The reference its words are kept under.
    pub words: Id,
    /// How far the voice carries, mm: the farthest a hearer can be.
    pub reach_mm: u64,
    /// Who may read it: the entry's audience (T8), not a field of the event.
    pub audience: Audience,
    /// The Souls that heard it, resolved when it was written.
    pub hearers: BTreeSet<Id>,
    /// How long it lasts, µs.
    pub length: Micros,
}

fn bad<T>(detail: &str) -> R<T> {
    Err(Refusal {
        name: "not-an-utterance",
        detail: detail.to_string(),
    })
}

impl Said {
    /// The event the entry carries: `souls:said {1: {21: words}, 2: reach, 3: [hearer, ...], 4: length}`, 3 left
    /// out when no one heard.
    pub fn event(&self) -> Event {
        let mut fields = BTreeMap::from([
            (
                1,
                Value::Map(BTreeMap::from([(REFERENCE, self.words.to_value())])),
            ),
            (2, Value::Uint(self.reach_mm)),
            (4, Value::Uint(u64::try_from(self.length).unwrap_or(0))),
        ]);
        if !self.hearers.is_empty() {
            fields.insert(
                3,
                Value::Array(self.hearers.iter().map(|h| h.to_value()).collect()),
            );
        }
        Event {
            name: Name::new(SAID).unwrap_or_else(|| unreachable!("a literal name")),
            fields,
            changes: Vec::new(),
            rest: BTreeMap::new(),
        }
    }

    /// Reads an utterance back from its event as the log holds it (`{1: "souls:said", 2: fields}`) and its entry's
    /// audience: what a replay or a view takes as said, and to whom, without working anything out again.
    pub fn read(v: &Value, audience: Audience) -> R<Said> {
        let Value::Map(e) = v else {
            return bad("an event is a map");
        };
        if !matches!(e.get(&1), Some(Value::Text(n)) if n.as_str() == SAID) {
            return bad("not souls:said");
        }
        let Some(Value::Map(fields)) = e.get(&2) else {
            return bad("2 is its fields");
        };
        let words = match fields.get(&1) {
            Some(Value::Map(m)) if m.len() == 1 => match m.get(&REFERENCE) {
                Some(v) => read_id(v)?,
                None => return bad("1 is a reference {21: id}"),
            },
            _ => return bad("1 is a reference {21: id}"),
        };
        let Some(Value::Uint(reach_mm)) = fields.get(&2) else {
            return bad("2 is a reach in mm");
        };
        let hearers = match fields.get(&3) {
            None => BTreeSet::new(),
            Some(Value::Array(a)) => a.iter().map(read_id).collect::<R<_>>()?,
            Some(_) => return bad("3 is a list of hearers"),
        };
        let Some(Value::Uint(length)) = fields.get(&4) else {
            return bad("4 is a length in µs");
        };
        Ok(Said {
            words,
            reach_mm: *reach_mm,
            audience,
            hearers,
            length: Micros::try_from(*length).unwrap_or(Micros::MAX),
        })
    }
}

/// R4's addressed item's kind (`{1: 9, 2: entry}`).
pub const ADDRESSED: u64 = 9;
/// The field of an addressed item that holds an utterance's words, as read for its subscriber (C6, #3390).
pub const HEARD_WORDS: u64 = 3;

/// An utterance as a Soul's view stream hands it on: who said it, when, to which audience, and its words when the
/// subscriber may read them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Heard {
    /// Its entry's place in the log.
    pub sequence: u64,
    pub at: Micros,
    /// The body that said it: the node its entry is written by.
    pub speaker: Id,
    pub said: Said,
    pub words: Option<Vec<u8>>,
}

fn unread(e: impl std::fmt::Display) -> Refusal {
    Refusal {
        name: "not-an-utterance",
        detail: e.to_string(),
    }
}

/// An utterance from one of R4's items (`{1: 9, 2: entry, 3: words}`), or none when the item is anything else.
pub fn heard(item: &[u8]) -> R<Option<Heard>> {
    let Value::Map(mut m) = decode(item).map_err(unread)?.value else {
        return bad("an item is a map");
    };
    if m.get(&1) != Some(&Value::Uint(ADDRESSED)) {
        return Ok(None);
    }
    let Some(Value::Bytes(entry)) = m.remove(&2) else {
        return bad("2 is an entry's bytes");
    };
    let e = Effect::read(decode(&entry).map_err(unread)?.value)?;
    let Some(ev) = e
        .events
        .iter()
        .flatten()
        .find(|ev| ev.name.as_str() == SAID)
    else {
        return Ok(None);
    };
    let said = Said::read(&ev.to_value(), e.envelope.audience)?;
    let words = match m.remove(&HEARD_WORDS) {
        Some(Value::Bytes(w)) => Some(w),
        _ => None,
    };
    Ok(Some(Heard {
        sequence: e.envelope.sequence,
        at: e.envelope.at,
        speaker: e.envelope.node,
        said,
        words,
    }))
}
