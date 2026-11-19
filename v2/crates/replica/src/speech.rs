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
//!
//! - **Its reach, from a closed list** (E13, #2784): [`Reach`] is what the speaker asks for, a whisper to one named
//!   Soul, talk, a raised voice, the members of an activity it is in (a call), or through a thing ([`Device`]). Field 2
//!   is how far the voice carries in the air; a call's or a device's hearers beyond it are in field 3. How far each
//!   carries is data on the world ([`Radii`]).
//!
//! Not here: who hears (the world's `sim::speech`), the voice resource (`sim::controller`), refusing oversized text
//! (the gateway, I2).

use std::collections::{BTreeMap, BTreeSet};

use crate::audience::REFERENCE;
use crate::effects::{Event, Refusal, read_id};
use crate::encode::{Name, Value};
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

/// An utterance's reach (E13): who it is for, from a closed list. The world works out its hearers when it writes it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Reach {
    /// To one named Soul within arm's length ([`Radii::whisper`]): its body hears it and its Soul alone may read it
    /// (an audience of one, never the public).
    Whisper { body: Id, soul: Id },
    /// Ordinary talk: the Souls whose interest set holds the speaker (B11). Public.
    #[default]
    Talk,
    /// A raised voice: every Soul within [`Radii::loud`] of the speaker, on its node. Public.
    Loud,
    /// To the members of an activity the speaker is in, at any distance (a call is an activity both joined, E8), and
    /// to talk's hearers. Public.
    Members(Id),
    /// Through a thing: to the Souls near each receiver of the device link it sends on that is on ([`Device`]), and
    /// to talk's hearers. Public.
    Through(Id),
}

/// How far a voice carries, µm: data on the world, so a shipped world keeps its own. The defaults start from today's
/// (the server's earshot is 12 m); talk's reach is the interest set's (R4, `sim::speech::LEAVE`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Radii {
    /// A whisper's, arm's length.
    pub whisper: i64,
    /// A raised voice's, farther than talk's.
    pub loud: i64,
}

impl Default for Radii {
    fn default() -> Radii {
        Radii {
            whisper: 1_000_000,
            loud: 12_000_000,
        }
    }
}

/// One receiver of a device link: the thing, the node it is in and where on it (µm), whether it is on, and how far
/// it is heard from, µm (its volume).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Receiver {
    pub thing: Id,
    pub node: Id,
    pub at: [i64; 2],
    pub on: bool,
    pub radius: i64,
}

/// A device link (E13): from a sender thing to its receivers. A voice through the sender is heard by the Souls within
/// the radius of each receiver that is on, in that receiver's node, wherever the sender is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub sender: Id,
    pub receivers: Vec<Receiver>,
}

/// One utterance, as written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Said {
    /// The reference its words are kept under.
    pub words: Id,
    /// How far the voice carries in the air, mm: the farthest a hearer can be but through an activity or a device.
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
