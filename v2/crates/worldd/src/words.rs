//! The words path, world side (Engine v2 V1b, #3361; T8 rule 6, `v2/docs/audience.md`): an intent's words go to K16's
//! text store (`sim::text`) and the log holds their reference only.
//!
//! - **Words in, a reference logged.** Words come in an intent as T8's `{23: words}` (bytes). Each is kept in the
//!   store for its audience, as resolved now (T8 rule 1), by the body that sent it, and replaced in the intent by
//!   `{21: id}` before the intent is logged or acted on: no byte of the words reaches the log.
//! - **Who may read them**, by the intent's form (its verb's name after the namespace; `souls:` verbs are the
//!   engine's own, T10 rule 4): `say`, `shout` and `describe` are public; `whisper` is its listener's alone (an audience of
//!   one, never in a public view or a public text file); a `say` into an activity (target: the activity) is its
//!   members' alone, the activity's audience (E26a, #3504); words in any other intent are their sender's alone until
//!   a form says otherwise.
//! - **What the world writes** (in [`crate::answers`], at the intent's arrival, answered with a receipt after its
//!   tick's sync): a `say` is a `souls:said` entry of the public audience, written by the speaker's body
//!   (`replica::speech`), and a `shout` the same at a raised voice's reach ([`SHOUT_REACH_MM`]); a `whisper` (target: the listener's body) is the same event in an entry of the listener's
//!   audience, its one hearer the listener; a `say` into an activity is that event in an entry of the activity's
//!   audience, its hearers the members' bodies, and is refused `not-a-member` before its words are kept when the
//!   speaker's body is not one ([`members`]), and its public record beside it ([`public_record`], #3775: who spoke,
//!   when and among whom, never the words); a `describe` sets the body's public name ([`NAME`], parameter 1) and
//!   one-line description ([`DESCRIPTION`], parameter 2) as references on its node, as a Soul does when it joins.
//!
//! Not here: who else hears ordinary talk (the bodies' interest sets, `sim::speech`, need the controller's index, so a
//! `say` lists no hearers yet), the voice resource, drawing the words (W4), removal (W7).

use std::collections::{BTreeMap, BTreeSet};

use replica::activity::MEMBER;
use replica::audience::REFERENCE;
use replica::effects::{Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Refusal, Rest};
use replica::encode::Value;
use replica::ids::{Id, Minter, Scope, sha256};
use replica::intents::{Intent, Target};
use replica::speech::{RATE, SAID, SHORTEST, Said};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::Audience;
use sim::log::Mem;
use sim::text::Store;

type R<T> = Result<T, Refusal>;

/// T8's words in an intent: `{23: words}`, the words as bytes.
pub const WORDS: u64 = 23;
/// The body node's field holding its public name (`{21: id}`).
pub const NAME: u64 = 30;
/// The body node's field holding its public one-line description (`{21: id}`).
pub const DESCRIPTION: u64 = 31;
/// How far ordinary talk carries, mm (`sim::speech::LEAVE`).
pub const SAY_REACH_MM: u64 = (sim::speech::LEAVE / 1_000) as u64;
/// How far a whisper carries, mm.
pub const WHISPER_REACH_MM: u64 = 1_000;
/// How far a shout carries, mm: a raised voice's reach (`replica::speech::Radii::loud`), farther than talk's.
pub const SHOUT_REACH_MM: u64 = 12_000;

/// The text store's scope for a world of `lineage`: its own, so a reference is never a world id.
pub fn scope(lineage: Scope) -> Scope {
    let mut input = b"souls/text/1".to_vec();
    input.extend_from_slice(&lineage.0);
    let h = sha256(&input);
    let mut s = [0; 16];
    s.copy_from_slice(&h[..16]);
    Scope(s)
}

/// A store in memory, for a world given none (its words do not outlive the process).
pub fn in_memory(lineage: Scope) -> R<Store> {
    Store::open_mem(Mem::default(), Mem::default(), Minter::new(scope(lineage)))
}

/// What an intent's words are for, by its form.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Form {
    Say,
    /// A say at a raised voice's reach (C26, #3689): public, heard farther by the same rule.
    Shout,
    Whisper(Id),
    /// A turn into an activity, its members' alone.
    Members(Id),
    Describe,
    Other,
}

/// The form of `intent`, the body it comes from being `body`.
pub fn form(intent: &Intent) -> Form {
    let form = match intent.verb.as_str().split_once(':') {
        Some((ns, form)) if ns != "souls" => form,
        _ => return Form::Other,
    };
    match (form, &intent.target) {
        ("say", Some(Target::Node(activity))) => Form::Members(*activity),
        ("say", _) => Form::Say,
        ("shout", _) => Form::Shout,
        ("whisper", Some(Target::Node(to))) => Form::Whisper(*to),
        ("describe", _) => Form::Describe,
        // A Soul's join (C3, #3367) names its body as a describe does: at its birth, or again once it is here.
        _ if intent.verb.as_str() == crate::answers::JOIN => Form::Describe,
        _ => Form::Other,
    }
}

/// Who may read the words of an intent of `form` sent by `body`.
pub fn audience(form: Form, body: Id) -> Audience {
    match form {
        Form::Say | Form::Shout | Form::Describe => Audience::Everyone,
        Form::Whisper(to) | Form::Members(to) => Audience::Of(to),
        Form::Other => Audience::Of(body),
    }
}

/// `v` with each `{23: words}` kept in `store` for `audience` by `author` and replaced by `{21: id}`; the references
/// kept, with each one's length in characters, in the order found.
pub fn keep(
    v: Value,
    store: &Store,
    audience: Audience,
    author: Id,
    kept: &mut Vec<(Id, usize)>,
) -> R<Value> {
    Ok(match v {
        Value::Map(m) => match m.get(&WORDS) {
            Some(Value::Bytes(words)) => {
                let id = store.write(words, audience, author)?;
                kept.push((id, String::from_utf8_lossy(words).chars().count()));
                Value::Map(BTreeMap::from([(REFERENCE, id.to_value())]))
            }
            Some(_) => {
                return Err(Refusal {
                    name: "intent.words-not-bytes",
                    detail: "T8's words are bytes".into(),
                });
            }
            None => Value::Map(
                m.into_iter()
                    .map(|(k, v)| keep(v, store, audience, author, kept).map(|v| (k, v)))
                    .collect::<R<_>>()?,
            ),
        },
        Value::Array(a) => Value::Array(
            a.into_iter()
                .map(|v| keep(v, store, audience, author, kept))
                .collect::<R<_>>()?,
        ),
        other => other,
    })
}

/// The bodies that are members of `activity` now (its `souls:member` links, B5), if `body` is one of them; refused
/// `not-a-member` when it is not (or `activity` is no activity).
pub fn members(tree: &Tree, activity: Id, body: Id) -> Result<BTreeSet<Id>, &'static str> {
    let bodies: BTreeSet<Id> = tree
        .links_at(activity)
        .iter()
        .filter(|e| tree.ty(e).as_str() == MEMBER)
        .filter_map(|e| tree.link(e.link))
        .filter(|(_, ends, _, _)| ends[1] == activity)
        .map(|(_, ends, _, _)| ends[0])
        .collect();
    if bodies.contains(&body) {
        Ok(bodies)
    } else {
        Err("not-a-member")
    }
}

/// The reference in parameter `n` of a logged intent's value (`{4: {n: {21: id}}}`), if any.
fn parameter(value: &Value, n: u64) -> Option<Id> {
    let Value::Map(m) = value else { return None };
    let Some(Value::Map(p)) = m.get(&4) else {
        return None;
    };
    let Some(Value::Map(r)) = p.get(&n) else {
        return None;
    };
    replica::effects::read_id(r.get(&REFERENCE)?).ok()
}

/// A body's name and description fields ([`NAME`], [`DESCRIPTION`]) as references, from a logged describe's or
/// join's parameters 1 and 2 (C3, #3367: what a birth's node is created with).
pub fn naming(value: &Value) -> BTreeMap<u64, Value> {
    [(NAME, 1), (DESCRIPTION, 2)]
        .into_iter()
        .filter_map(|(field, n)| {
            let r = parameter(value, n)?;
            Some((
                field,
                Value::Map(BTreeMap::from([(REFERENCE, r.to_value())])),
            ))
        })
        .collect()
}

/// The entry an intent of `form` writes, its words already kept (`value` is the intent as logged, `kept` its
/// references with their lengths; `members` a turn's hearers, [`members`]), or none when the form writes none.
/// Refused by name when it is malformed.
pub fn entry(
    form: Form,
    value: &Value,
    kept: &[(Id, usize)],
    body: Id,
    members: BTreeSet<Id>,
    envelope: Envelope,
) -> Option<Result<Effect, &'static str>> {
    let said = |audience, reach_mm, hearers: BTreeSet<Id>| match kept.first() {
        Some((words, chars)) if parameter(value, 1) == Some(*words) => {
            let us = (*chars as u64).saturating_mul(1_000_000) / RATE;
            let length = Micros::try_from(us).unwrap_or(Micros::MAX).max(SHORTEST);
            let s = Said {
                words: *words,
                reach_mm,
                audience,
                hearers,
                length,
            };
            Ok(sim::speech::entry(envelope, body, &s))
        }
        _ => Err("intent.no-words"),
    };
    Some(match form {
        Form::Say => said(Audience::Everyone, SAY_REACH_MM, BTreeSet::new()),
        Form::Shout => said(Audience::Everyone, SHOUT_REACH_MM, BTreeSet::new()),
        Form::Whisper(to) => said(Audience::Of(to), WHISPER_REACH_MM, BTreeSet::from([to])),
        Form::Members(activity) => said(Audience::Of(activity), SAY_REACH_MM, members),
        Form::Describe => {
            let set = |field, r: Id| ChangeRec {
                change: Change::Set {
                    node: body,
                    field,
                    to: Value::Map(BTreeMap::from([(REFERENCE, r.to_value())])),
                    by: None,
                },
                rest: Rest::new(),
            };
            let changes: Vec<ChangeRec> = [(NAME, 1), (DESCRIPTION, 2)]
                .into_iter()
                .filter_map(|(field, n)| parameter(value, n).map(|r| set(field, r)))
                .collect();
            if changes.is_empty() {
                Err("intent.no-words")
            } else {
                Ok(Effect {
                    envelope: Envelope {
                        node: body,
                        audience: Audience::Everyone,
                        ..envelope
                    },
                    body: Body::Changes(changes),
                    events: None,
                    rest: Rest::new(),
                })
            }
        }
        Form::Other => return None,
    })
}

/// The public entry the world writes beside `entry`, the entry of an intent of `form`: for a turn into an activity, its
/// record without words (`sim::speech::private_record`, #3775); none for any other form.
pub fn public_record(form: Form, entry: &Effect) -> Option<Effect> {
    let Form::Members(activity) = form else {
        return None;
    };
    let ev = entry
        .events
        .iter()
        .flatten()
        .find(|e| e.name.as_str() == SAID)?;
    let said = Said::read(&ev.to_value(), entry.envelope.audience).ok()?;
    Some(sim::speech::private_record(
        entry.envelope,
        entry.envelope.node,
        activity,
        &said,
    ))
}

/// The envelope of an entry an intent writes: at the world's next sequence `sequence`, world time `at`.
pub fn envelope(sequence: u64, at: Micros, intent: Id, actor: Actor, node: Id) -> Envelope {
    Envelope {
        sequence,
        at,
        cause: Cause::Intent(intent),
        actor,
        audience: Audience::Everyone,
        node,
    }
}

#[cfg(test)]
mod reserved_tests {
    use replica::fields::{On, reserved};

    /// The body fields this crate and `skills` number are in the engine's one list of reserved fields.
    #[test]
    fn body_fields_are_reserved() {
        for n in [super::NAME, super::DESCRIPTION, skills::wear::BODY] {
            assert!(
                reserved().iter().any(|f| f.n == n && f.on == On::Body),
                "{n}"
            );
        }
    }
}
