//! Who hears (Engine v2 B11, #2742): an utterance's hearers, resolved when the world writes it and recorded with it
//! (`replica::speech`), so a replay and every view read the same set.
//!
//! - **Ordinary talk reaches the Souls whose interest set holds the speaker** (R4, #2698). The interest set's rule is
//!   here, shared with the view tier's (`worldd::views::interest`): a body enters a Soul's set closer than [`ENTER`]
//!   and leaves it at [`LEAVE`] or farther, on the node the Soul stands on; its own body is in it.
//! - **Kept on the clock thread, from the controller's index** (N16, `Controller::near`). [`Hearing::update`] works
//!   a body's set out again only when it moved, was added or was taken out, and tells each body it entered or left:
//!   the rule is symmetric (the same distance and the same history both ways), so "whose set holds the speaker" is
//!   answered from the bodies within [`LEAVE`] of it, never a scan of the hall ([`Hearing::holders`]).
//! - **Resolved at write.** [`said`] gives the record for an utterance the controller started this tick: the words'
//!   reference, the reach, the public audience and the hearers as they are at that instant.
//! - **Each tick** (#3231): after the controller's step the world's tick calls [`heard`], which brings the sets up to
//!   date from the bodies that moved and gives each started utterance's record, and writes each as [`entry`] says. The
//!   view tier reads the entry from the log and addresses it to each hearer's subscription
//!   (`worldd::views::subscription`, R4's addressed queue).
//!
//! - **A reach from a closed list** (E13, #2784; `replica::speech::Reach`), resolved by [`said_by`] against what
//!   carries a voice ([`Carriers`]): a whisper is heard by the one named body within the world's whisper radius and
//!   read by its Soul alone; a raised voice by every body within the loud radius on the speaker's node; a call by the
//!   members of the activity, wherever they are, if the speaker is one; a device by the bodies near each receiver of
//!   its link that is on. A call and a device are heard by talk's hearers too. The format of the record is B11's.
//!
//! Not here: sound through walls, recorded sounds (Soul Actions), charging a speaker by its hearers (I8), who may
//! speak through a thing (F6), the device link read from the tree, conversations (E26), playing sound (lane V).

use std::collections::{BTreeMap, BTreeSet};

use crate::controller::Line;
use crate::index::Index;
use replica::effects::{Body, Effect, Envelope, Rest};
use replica::ids::Id;
use replica::speech::{Device, Radii, Reach, Said};
use replica::time::Micros;
use replica::world_model::Audience;

/// A body enters a Soul's interest set closer than this, µm (talking distance and a step).
pub const ENTER: i64 = 4_000_000;
/// A body in a Soul's interest set leaves it at this distance or farther, µm: so ordinary talk reaches no farther.
pub const LEAVE: i64 = 5_000_000;

/// Every body's interest set, kept from the controller's index as the bodies move.
#[derive(Default)]
pub struct Hearing {
    sets: BTreeMap<Id, BTreeSet<Id>>,
    /// Where each body was when its set was last worked out.
    at: BTreeMap<Id, (Id, [i64; 2])>,
}

impl Hearing {
    pub fn new() -> Hearing {
        Hearing::default()
    }

    /// Brings the sets up to date after a tick: `bodies` are every body the world holds, `index` where each not being
    /// carried stands. A body that moved, was added or has no place now has its set worked out again by R4's rule,
    /// and each body it entered or left has it added or taken out; a body gone is taken out of every set.
    pub fn update(&mut self, index: &Index, bodies: impl IntoIterator<Item = Id>) {
        let bodies: BTreeSet<Id> = bodies.into_iter().collect();
        let gone: Vec<Id> = self
            .sets
            .keys()
            .filter(|id| !bodies.contains(id))
            .copied()
            .collect();
        for id in gone {
            self.put(id, BTreeSet::new());
            self.sets.remove(&id);
            self.at.remove(&id);
        }
        for id in bodies {
            let now = index.body(id);
            if self.sets.contains_key(&id) && self.at.get(&id).copied() == now {
                continue;
            }
            let set = match now {
                None => {
                    self.at.remove(&id);
                    BTreeSet::new()
                }
                Some((node, p)) => {
                    self.at.insert(id, (node, p));
                    let old = self.sets.get(&id);
                    index
                        .bodies_within(node, p, LEAVE)
                        .into_iter()
                        .filter(|&(b, d)| d < ENTER || old.is_some_and(|o| o.contains(&b)))
                        .map(|(b, _)| b)
                        .collect()
                }
            };
            self.put(id, set);
        }
    }

    /// Sets `id`'s set to `set`, and adds `id` to, or takes it out of, the set of every body that entered or left.
    fn put(&mut self, id: Id, set: BTreeSet<Id>) {
        let old = self.sets.remove(&id).unwrap_or_default();
        for b in old.difference(&set) {
            if let Some(s) = self.sets.get_mut(b) {
                s.remove(&id);
            }
        }
        for b in set.difference(&old) {
            if *b != id {
                self.sets.entry(*b).or_default().insert(id);
            }
        }
        self.sets.insert(id, set);
    }

    /// Body `id`'s interest set now.
    pub fn set(&self, id: Id) -> Option<&BTreeSet<Id>> {
        self.sets.get(&id)
    }

    /// The bodies whose interest set holds `body` now: of the bodies within [`LEAVE`] of it on its node, those whose
    /// set holds it. A body with no place is held by none.
    pub fn holders(&self, index: &Index, body: Id) -> BTreeSet<Id> {
        let Some((node, p)) = index.body(body) else {
            return BTreeSet::new();
        };
        index
            .bodies_within(node, p, LEAVE)
            .into_iter()
            .map(|(b, _)| b)
            .filter(|b| self.sets.get(b).is_some_and(|s| s.contains(&body)))
            .collect()
    }
}

/// What carries a voice beyond the air (E13): the world's radii, the members of each activity and the device links.
pub struct Carriers<'a> {
    pub radii: Radii,
    /// The bodies of an activity's members (`activity::Activities::members`); none when it is not live.
    pub members: &'a dyn Fn(Id) -> Vec<Id>,
    /// The device links, by their sender thing.
    pub devices: &'a BTreeMap<Id, Device>,
}

/// No activity has members.
fn no_members(_: Id) -> Vec<Id> {
    Vec::new()
}

/// The record of ordinary talk by `speaker`, as the controller started it this tick: [`said_by`] with the default
/// radii, no activity and no device.
pub fn said(hearing: &Hearing, index: &Index, speaker: Id, line: &Line) -> Said {
    let devices = BTreeMap::new();
    let carriers = Carriers {
        radii: Radii::default(),
        members: &no_members,
        devices: &devices,
    };
    said_by(hearing, index, &carriers, speaker, line)
}

/// The bodies within `r` of `body`, on its node.
fn around(index: &Index, body: Id, r: i64) -> BTreeSet<Id> {
    let Some((node, p)) = index.body(body) else {
        return BTreeSet::new();
    };
    index
        .bodies_within(node, p, r)
        .into_iter()
        .map(|(b, _)| b)
        .collect()
}

/// The record of an utterance by `speaker`, as the controller started it this tick: its words' reference and length,
/// and the reach, audience and hearers its [`Reach`] gives now. Talk's reach is [`LEAVE`] and its hearers the Souls
/// whose interest set holds the speaker.
pub fn said_by(
    hearing: &Hearing,
    index: &Index,
    carriers: &Carriers,
    speaker: Id,
    line: &Line,
) -> Said {
    let radii = carriers.radii;
    let (reach, audience, hearers) = match line.reach {
        Reach::Whisper { body, soul } => {
            let hears = around(index, speaker, radii.whisper).contains(&body) && body != speaker;
            let hearers = hears.then_some(body).into_iter().collect();
            (radii.whisper, Audience::Of(soul), hearers)
        }
        Reach::Talk => (LEAVE, Audience::Everyone, hearing.holders(index, speaker)),
        Reach::Loud => (
            radii.loud,
            Audience::Everyone,
            around(index, speaker, radii.loud),
        ),
        Reach::Members(activity) => {
            let mut hearers = hearing.holders(index, speaker);
            let members = (carriers.members)(activity);
            if members.contains(&speaker) {
                hearers.extend(members);
            }
            (LEAVE, Audience::Everyone, hearers)
        }
        Reach::Through(sender) => {
            let mut hearers = hearing.holders(index, speaker);
            for r in carriers
                .devices
                .get(&sender)
                .into_iter()
                .flat_map(|d| &d.receivers)
                .filter(|r| r.on)
            {
                hearers.extend(
                    index
                        .bodies_within(r.node, r.at, r.radius)
                        .into_iter()
                        .map(|(b, _)| b),
                );
            }
            (LEAVE, Audience::Everyone, hearers)
        }
    };
    Said {
        words: line.words,
        reach_mm: (reach / 1_000).max(0) as u64,
        audience,
        hearers,
        length: line.length,
    }
}

/// One tick of speech, run by the world's tick after the controller's step: brings every body's interest set up to
/// date (`bodies` are every body the world holds; only those that moved, came or went are worked out again), then
/// gives the record of each utterance the step started (`Stepped::said`), its hearers as they are now, in order.
/// [`heard_by`] with the default radii, no activity and no device.
pub fn heard(
    hearing: &mut Hearing,
    index: &Index,
    bodies: impl IntoIterator<Item = Id>,
    started: &[(Id, Line, Micros)],
) -> Vec<(Id, Said)> {
    let devices = BTreeMap::new();
    let carriers = Carriers {
        radii: Radii::default(),
        members: &no_members,
        devices: &devices,
    };
    heard_by(hearing, index, &carriers, bodies, started)
}

/// [`heard`], each utterance resolved by its reach against `carriers` ([`said_by`]).
pub fn heard_by(
    hearing: &mut Hearing,
    index: &Index,
    carriers: &Carriers,
    bodies: impl IntoIterator<Item = Id>,
    started: &[(Id, Line, Micros)],
) -> Vec<(Id, Said)> {
    hearing.update(index, bodies);
    started
        .iter()
        .map(|(speaker, line, _)| (*speaker, said_by(hearing, index, carriers, *speaker, line)))
        .collect()
}

/// The log entry an utterance is written as: its `souls:said` event in an entry of no changes, written by the
/// speaker's body (`node`) with the utterance's audience. Sequence, time, cause and actor are the writer's.
pub fn entry(envelope: Envelope, speaker: Id, said: &Said) -> Effect {
    Effect {
        envelope: Envelope {
            node: speaker,
            audience: said.audience,
            ..envelope
        },
        body: Body::Changes(Vec::new()),
        events: Some(vec![said.event()]),
        rest: Rest::new(),
    }
}
