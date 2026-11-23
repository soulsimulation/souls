//! Joint activities (Engine v2 B5, #2724): the one way Souls agree to act on each other. An activity is a node made
//! from a kind (`replica::activity`), each Soul joins it by its own intent, and each can always leave. Bodies touch
//! only inside an activity both joined.
//!
//! - **Five steps, each the acting Soul's in the log.** Propose creates the node under a place and reserves nothing;
//!   it expires unstarted. Join links the Soul's body to the activity in a role, against the activity's revision; a
//!   resent join (the same intent id) is answered from the node and makes no second membership. Start takes every
//!   role's claims on every member's body through the controller (B1), all or none: a body another started activity
//!   holds is refused naming that activity, so the first to start has it. Leave is always accepted, unless it would
//!   leave a part of a bay unsupported (B18, [`crate::structure`]). The activity ends (its node is removed) when its
//!   last member leaves. Every step is one effect whose actor is the Soul and whose cause is its intent, with an event
//!   naming the step (`souls:activity-proposed`, `-joined`, `-started`, `-left`).
//! - **Only the activity aims a move at its members.** [`Activities::aim`] starts a B2 move by one member at
//!   another's body only when both are members of the same started activity; anything else is refused
//!   (`target-outside-activity`) and changes nothing. A move whose claims meet the activity's own claim on the actor
//!   runs in its place, and the activity takes its role's claims back when it ends ([`Activities::settle`]).
//! - **A role may name a move (0.134 T1).** When an activity of such a kind starts, each member whose role names
//!   one aims it at the other member through [`Activities::aim`] ([`Activities::begin_moves`]), and the move's record
//!   goes out for viewers as a form's does (`souls:form-move`): a handshake, a hug, a high-five.
//! - **A touch ends with its moves.** When every member's move of a touch has ended by itself, each member leaves it
//!   ([`Activities::finish`]), so its role claims are let go: both arms are free, and the next touch between the
//!   same two starts and plays its moves. A touch whose move holds (T2) is not ended this way.
//! - **A held move lasts while both stay (0.134 T2).** A role's move whose last phase holds (`hold_hand`) holds until
//!   a member leaves: then every member's held move is released, so both hands come free, each release goes out
//!   for viewers as its record again, ended `released`, and the others leave the hold too ([`Activities::leave`]). A walk sent by a member ends it the same
//!   way ([`Activities::walk_leaves`] names the activity; worldd sends the leave).
//! - **Dancing together on one beat (0.134 T3).** A kind whose moves go on the beat (`beat`) takes up to its `most`
//!   members, offered to several at once; each later accept joins the offer's own activity ([`offer`]). Its first
//!   beat is fixed when it starts: the last whole beat of the world's clock at most 2 s ahead (`v2/docs/time.md`
//!   rule 7), so accepts that arrive within about 1.5 s of the first all begin on it. Each member's move is aimed at
//!   its own body and starts on that beat, or, for a member who joins after it, on the next whole beat; when it ends
//!   it begins again on the next whole beat, until the member leaves. A leave is always accepted, as any leave.
//! - **A leave completes within the time the kind states.** Membership ends at once, in the log. A body with no move
//!   in progress is let go at once; a body in a move is let go at the move's next phase end, or at the kind's
//!   `leave_within`, whichever is first, by a timer in K9's due list ([`Activities::fire`]).
//! - **A restart does not end an activity.** Its node and its membership links are in the log; [`Activities::restore`]
//!   reads them back and takes each started activity's claims again. A move in progress is not stored, so after a
//!   restart no claim is held by a move that did not come back, and a member can leave at once.
//!
//! Not here: contact rules (B6), the beat (B8), activities that keep members while empty, the gateway path (I7), a new
//! revision when roles or places change, walking a member to its role's place. Offers, accepted, declined or lapsed,
//! are [`offer`] (E8); standing consent is a rule in the Soul's own client (R9), never here.

use std::collections::{BTreeMap, BTreeSet};

use replica::activity::{ActivityKind, F_MEMBERS, F_STATE, MEMBER, Member, Node, State};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Event, Header, Part, Refusal, Rest,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Id, Minter};
use replica::moves::Move;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::time::{Micros, Timeline};
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, End, show};

use crate::controller::{Controller, Driver};
use crate::moves::{Instance, Moves, Reach};
use crate::structure::Structure;
use crate::timers::{DueList, Timer};

pub mod carry;
pub mod offer;
pub mod seating;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// The event a move's record goes out in, a form's own (#3741), so the page draws a role's move as it draws a form's.
const FORM_MOVE: &str = "souls:form-move";

/// `v` with every text as bytes, as a form's move record goes out (`forms::as_bytes`): its names need no namespace.
fn as_bytes(v: Value) -> Value {
    match v {
        Value::Text(t) => Value::Bytes(t.as_str().as_bytes().to_vec()),
        Value::Array(a) => Value::Array(a.into_iter().map(as_bytes).collect()),
        Value::Map(m) => Value::Map(m.into_iter().map(|(k, v)| (k, as_bytes(v))).collect()),
        v => v,
    }
}

/// A dance's first beat when it starts at `at` (0.134 T3): the last whole beat at most 2 s ahead, or the next beat
/// when none falls in that time. At `at` itself on error (a time before the world's start).
fn first_beat(line: &Timeline, at: Micros) -> Micros {
    let last = line
        .beat_of(at.saturating_add(BEAT_AHEAD))
        .and_then(|k| line.beat_time(k));
    match last {
        Ok(t) if t > at => t,
        _ => on_beat(line, at),
    }
}

/// The first whole beat at or after `t`.
fn on_beat(line: &Timeline, t: Micros) -> Micros {
    let Ok(k) = line.beat_of(t) else {
        return t;
    };
    match line.beat_time(k) {
        Ok(b) if b >= t => b,
        _ => line.beat_time(k + 1).unwrap_or(t),
    }
}

/// How far ahead a dance's first beat may be, µs (0.134 T3).
const BEAT_AHEAD: Micros = 2_000_000;

/// Whether move `n` is live and has a phase that holds until released (0.134 T2): its record ends it never.
fn held(moves: &Moves, n: Instance) -> bool {
    moves
        .record(n)
        .is_some_and(|r| r.ends.contains(&Micros::MAX))
}

fn name(s: &'static str) -> Name {
    Name::new(s).unwrap_or_else(|| unreachable!("a literal name"))
}

fn minted(mint: &mut Minter) -> R<Id> {
    mint.mint().map_err(|e| Refusal {
        name: "id-counter-exhausted",
        detail: e.to_string(),
    })
}

/// The change that makes activity node `id` of `kind` under `place`, holding `node`.
fn create(id: Id, kind: &Name, place: Id, audience: Audience, node: &Node) -> Change {
    Change::Create {
        node: id,
        kind: kind.clone(),
        pose: Pose {
            frame: Frame {
                node: place,
                slot: None,
            },
            position: Vec3::ZERO,
            orientation: Quat::IDENTITY,
            support: Support::Surface {
                surface: place,
                height: 0,
            },
        },
        audience,
        fields: node.fields(),
    }
}

/// The due list's name for the timer that lets a leaving body go.
const LEAVE_TIMER: &str = "souls:activity-leave";

/// Who asks: the Soul, the intent it sent, and the world time it is handled at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ask {
    pub soul: Id,
    pub intent: Id,
    pub at: Micros,
}

struct Live {
    kind: Name,
    audience: Audience,
    node: Node,
    /// The activity's driver on each member's body while it holds the role's claims.
    drivers: BTreeMap<Id, Driver>,
    /// The move each member's body is making inside the activity.
    moves: BTreeMap<Id, Instance>,
}

/// A body that left while in a move: it is let go when the timer fires or the move ends first.
struct Leaving {
    body: Id,
    instance: Instance,
    due: Micros,
}

/// Every activity of a zone, and the writer of their nodes' effects.
pub struct Activities {
    pub header: Header,
    pub rules: Rules,
    /// The structure rule (B18): a leave that would leave a part of a bay unsupported is refused.
    pub structure: Structure,
    /// The zone's next sequence.
    pub next: u64,
    /// Every effect written, in order: the activities' share of the log.
    pub stream: Vec<Effect>,
    kinds: BTreeMap<Name, ActivityKind>,
    live: BTreeMap<Id, Live>,
    /// The started activity that holds each body.
    holding: BTreeMap<Id, Id>,
    /// Leaves in progress, by their timer's id.
    leaving: BTreeMap<Id, Leaving>,
    /// Offers still open or with pairs waiting (E8), and their bookkeeping.
    offers: offer::Offers,
    /// Activities started since [`Activities::begin_moves`] last ran, whose roles' moves are still to be aimed.
    begun: Vec<Id>,
    /// Each dancing activity's first beat, µs (0.134 T3), and the members whose move was refused there, not tried
    /// again.
    beats: BTreeMap<Id, Micros>,
    stalled: BTreeSet<(Id, Id)>,
    /// Touches that end when their moves end (0.134 T1: a handshake, a hug, a high-five), by activity.
    ending: BTreeSet<Id>,
}

impl Activities {
    /// A writer for activities of `kinds`, writing from sequence `next` under `header`, checked by `rules`.
    pub fn new(header: Header, rules: Rules, next: u64, kinds: Vec<ActivityKind>) -> Activities {
        Activities {
            header,
            rules,
            structure: Structure::default(),
            next,
            stream: Vec::new(),
            kinds: kinds.into_iter().map(|k| (k.name.clone(), k)).collect(),
            live: BTreeMap::new(),
            holding: BTreeMap::new(),
            leaving: BTreeMap::new(),
            offers: offer::Offers::default(),
            begun: Vec::new(),
            beats: BTreeMap::new(),
            stalled: BTreeSet::new(),
            ending: BTreeSet::new(),
        }
    }

    /// The members of `activity`, in the order they joined.
    pub fn members(&self, activity: Id) -> Option<&[Member]> {
        self.live.get(&activity).map(|l| l.node.members.as_slice())
    }

    /// Whether `activity` has started.
    pub fn started(&self, activity: Id) -> bool {
        self.live
            .get(&activity)
            .is_some_and(|l| l.node.state == State::Started)
    }

    /// The started activity holding `body`, if any.
    pub fn holder(&self, body: Id) -> Option<Id> {
        self.holding.get(&body).copied()
    }

    /// Whether `driver` on `body` is held by a live activity: its own claim, or a move it aimed.
    pub fn holds(&self, moves: &Moves, body: Id, driver: Driver) -> bool {
        let Some(l) = self.holding.get(&body).and_then(|a| self.live.get(a)) else {
            return false;
        };
        l.drivers.get(&body) == Some(&driver)
            || l.moves
                .get(&body)
                .is_some_and(|n| moves.record(*n).is_some())
    }

    fn write(
        &mut self,
        tree: &mut Tree,
        node: Id,
        audience: Audience,
        ask: Ask,
        event: &'static str,
        changes: Vec<Change>,
    ) -> R<()> {
        let by = (ask.at, Actor::Soul(ask.soul), Cause::Intent(ask.intent));
        self.emit(tree, node, audience, by, event, BTreeMap::new(), changes)
    }

    /// Writes one effect at `node`: `by` is (when, who acted, why), with one event of `fields` naming every change.
    #[allow(clippy::too_many_arguments)]
    fn emit(
        &mut self,
        tree: &mut Tree,
        node: Id,
        audience: Audience,
        by: (Micros, Actor, Cause),
        event: &'static str,
        fields: BTreeMap<u64, Value>,
        changes: Vec<Change>,
    ) -> R<()> {
        let n = changes.len() as u64;
        let effect = Effect {
            envelope: Envelope {
                sequence: self.next,
                at: by.0,
                cause: by.2,
                actor: by.1,
                audience,
                node,
            },
            body: Body::Changes(
                changes
                    .into_iter()
                    .map(|change| ChangeRec {
                        change,
                        rest: Rest::new(),
                    })
                    .collect(),
            ),
            events: Some(vec![Event {
                name: name(event),
                fields,
                changes: (0..n).collect(),
                rest: Rest::new(),
            }]),
            rest: Rest::new(),
        };
        let bytes = encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (2, Value::Array(vec![effect.to_value()])),
        ])))
        .map_err(|e| Refusal {
            name: "encoding",
            detail: e.to_string(),
        })?;
        let part = Part::read(&bytes)?;
        self.structure.check(tree, &part.effects)?;
        tree.commit(&self.header, &part, &self.rules)?;
        self.next += 1;
        self.stream.push(effect);
        Ok(())
    }

    /// `entries` as one part, caused and acted as `by` says, with no event: a give's transfer (T1's leave and arrive).
    fn emit_part(
        &mut self,
        tree: &mut Tree,
        by: (Micros, Actor, Cause),
        entries: Vec<(Id, Audience, Body)>,
    ) -> R<()> {
        let effects: Vec<Effect> = entries
            .into_iter()
            .zip(self.next..)
            .map(|((node, audience, body), sequence)| Effect {
                envelope: Envelope {
                    sequence,
                    at: by.0,
                    cause: by.2,
                    actor: by.1,
                    audience,
                    node,
                },
                body,
                events: None,
                rest: Rest::new(),
            })
            .collect();
        let bytes = encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (
                2,
                Value::Array(effects.iter().map(Effect::to_value).collect()),
            ),
        ])))
        .map_err(|e| Refusal {
            name: "encoding",
            detail: e.to_string(),
        })?;
        let part = Part::read(&bytes)?;
        self.structure.check(tree, &part.effects)?;
        tree.commit(&self.header, &part, &self.rules)?;
        self.next += effects.len() as u64;
        self.stream.extend(effects);
        Ok(())
    }

    /// Proposes an activity of `kind` under `place`: its node, with no members, expiring after the kind's
    /// `proposal_lasts`. Reserves nothing. `activity-kind-unknown`, `place-missing`.
    pub fn propose(
        &mut self,
        tree: &mut Tree,
        mint: &mut Minter,
        ask: Ask,
        kind: &Name,
        place: Id,
    ) -> R<Id> {
        let Some(k) = self.kinds.get(kind) else {
            return refuse("activity-kind-unknown", kind.as_str());
        };
        let audience = tree
            .handle(place)
            .and_then(|h| tree.node(h))
            .map(|n| n.audience())
            .ok_or_else(|| Refusal {
                name: "place-missing",
                detail: show(place),
            })?;
        let node = Node {
            revision: k.revision,
            state: State::Proposed,
            expires: ask.at.saturating_add(k.proposal_lasts),
            members: Vec::new(),
        };
        let id = minted(mint)?;
        let create = create(id, kind, place, audience, &node);
        self.write(
            tree,
            place,
            audience,
            ask,
            "souls:activity-proposed",
            vec![create],
        )?;
        self.live.insert(
            id,
            Live {
                kind: kind.clone(),
                audience,
                node,
                drivers: BTreeMap::new(),
                moves: BTreeMap::new(),
            },
        );
        Ok(id)
    }

    /// `ask.soul` joins `activity` with `body` in `role`, against the activity's `revision`: the membership link, owned
    /// by the activity, and the member written on its node. A join already made by `ask.intent` returns its link and
    /// writes nothing. `activity-missing`, `activity-started`, `activity-expired`, `activity-revision-stale`,
    /// `role-unknown`, `role-taken`, `already-member`.
    #[allow(clippy::too_many_arguments)]
    pub fn join(
        &mut self,
        tree: &mut Tree,
        mint: &mut Minter,
        ask: Ask,
        body: Id,
        activity: Id,
        role: &Name,
        revision: u64,
    ) -> R<Id> {
        let Some(l) = self.live.get(&activity) else {
            return refuse("activity-missing", show(activity));
        };
        if let Some(m) = l.node.members.iter().find(|m| m.intent == ask.intent) {
            return Ok(m.link);
        }
        if l.node.state == State::Started {
            return refuse("activity-started", show(activity));
        }
        if ask.at >= l.node.expires {
            return refuse("activity-expired", show(activity));
        }
        if revision != l.node.revision {
            return refuse(
                "activity-revision-stale",
                format!(
                    "{} is at revision {}, the join names {revision}",
                    show(activity),
                    l.node.revision
                ),
            );
        }
        let kind = &self.kinds[&l.kind];
        if kind.role(role).is_none() {
            return refuse("role-unknown", role.as_str());
        }
        if let Some(m) = l.node.members.iter().find(|m| m.role == *role) {
            return refuse(
                "role-taken",
                format!("{} by {}", role.as_str(), show(m.body)),
            );
        }
        if l.node.members.iter().any(|m| m.body == body) {
            return refuse("already-member", show(body));
        }
        let link = minted(mint)?;
        let mut node = l.node.clone();
        node.members.push(Member {
            role: role.clone(),
            body,
            soul: ask.soul,
            link,
            intent: ask.intent,
        });
        let audience = l.audience;
        let changes = vec![
            Change::Link {
                link,
                ty: name(MEMBER),
                ends: [body, activity],
                owner: End::Second,
                audience,
            },
            Change::Set {
                node: activity,
                field: F_MEMBERS,
                to: node.members_value(),
                by: None,
            },
        ];
        self.write(
            tree,
            activity,
            audience,
            ask,
            "souls:activity-joined",
            changes,
        )?;
        if let Some(l) = self.live.get_mut(&activity) {
            l.node = node;
        }
        Ok(link)
    }

    /// Starts `activity` at a member's ask: every role filled, and every role's claims taken on its member's body
    /// through the controller, all or none. `activity-missing`, `not-a-member`, `activity-started`,
    /// `activity-expired`, `roles-unfilled`, `body-in-activity` (naming the activity that holds it), and T9's
    /// refusals by name, naming the body.
    pub fn start(&mut self, tree: &mut Tree, c: &mut Controller, ask: Ask, activity: Id) -> R<()> {
        let Some(l) = self.live.get(&activity) else {
            return refuse("activity-missing", show(activity));
        };
        if !l.node.members.iter().any(|m| m.soul == ask.soul) {
            return refuse("not-a-member", show(ask.soul));
        }
        if l.node.state == State::Started {
            return refuse("activity-started", show(activity));
        }
        if ask.at >= l.node.expires {
            return refuse("activity-expired", show(activity));
        }
        let kind = &self.kinds[&l.kind];
        let open: Vec<&str> = kind
            .roles
            .iter()
            .filter(|r| !l.node.members.iter().any(|m| m.role == r.name))
            .map(|r| r.name.as_str())
            .collect();
        if !open.is_empty() {
            return refuse("roles-unfilled", open.join(", "));
        }
        for m in &l.node.members {
            if let Some(other) = self.holding.get(&m.body) {
                return refuse(
                    "body-in-activity",
                    format!("{} is held by {}", show(m.body), show(*other)),
                );
            }
        }
        let shapes: Vec<_> = l
            .node
            .members
            .iter()
            .map(|m| {
                (
                    m.body,
                    kind.shape(kind.role(&m.role).expect("a member's role")),
                )
            })
            .collect();
        for (body, shape) in &shapes {
            let Some(claims) = c.claims(*body) else {
                return refuse("body-unknown", show(*body));
            };
            claims.plan(Driver::MAX, shape).map_err(|r| Refusal {
                name: r.name,
                detail: format!("{}: {}", show(*body), r.detail),
            })?;
        }
        let mut drivers = BTreeMap::new();
        for (body, shape) in &shapes {
            match c.claim(*body, shape) {
                Ok(d) => {
                    drivers.insert(*body, d);
                }
                Err(r) => {
                    for (b, d) in drivers {
                        let _ = c.release(b, d);
                    }
                    return Err(r);
                }
            }
        }
        let audience = l.audience;
        let set = Change::Set {
            node: activity,
            field: F_STATE,
            to: Value::Uint(2),
            by: None,
        };
        if let Err(r) = self.write(
            tree,
            activity,
            audience,
            ask,
            "souls:activity-started",
            vec![set],
        ) {
            for (b, d) in drivers {
                let _ = c.release(b, d);
            }
            return Err(r);
        }
        for body in drivers.keys() {
            self.holding.insert(*body, activity);
        }
        if let Some(l) = self.live.get_mut(&activity) {
            l.node.state = State::Started;
            l.drivers = drivers;
        }
        self.begun.push(activity);
        Ok(())
    }

    /// Every activity running, by id (0.135 C3: worldd finds the loads riding them after a restart).
    pub fn ids(&self) -> Vec<Id> {
        self.live.keys().copied().collect()
    }

    /// The world's word that a carry in `activity` broke off and `load` was set down where it was, and `why`
    /// (`souls:partner-left`, `souls:carriers-apart`, `souls:world-restarted`): `souls:carry-set-down`, `{1: activity, 2: load, 3: why}`,
    /// to the activity's audience, acted and caused as `by` says (0.135 C3).
    pub fn carry_set_down(
        &mut self,
        tree: &mut Tree,
        activity: Id,
        load: Id,
        why: &'static str,
        by: (Micros, Actor, Cause),
    ) -> R<()> {
        let audience = self
            .live
            .get(&activity)
            .map_or(Audience::Everyone, |l| l.audience);
        let fields = BTreeMap::from([
            (1, activity.to_value()),
            (2, load.to_value()),
            (3, Value::Text(name(why))),
        ]);
        let node = if tree.handle(activity).is_some() {
            activity
        } else {
            load
        };
        self.emit(
            tree,
            node,
            audience,
            by,
            "souls:carry-set-down",
            fields,
            Vec::new(),
        )
    }

    /// The bodies of the activities started since [`Activities::begin_moves`] last ran: whom their moves reach.
    pub fn beginning(&self) -> Vec<Id> {
        self.begun
            .iter()
            .chain(self.dancing().iter())
            .filter_map(|a| self.live.get(a))
            .flat_map(|l| l.node.members.iter().map(|m| m.body))
            .collect()
    }

    /// The started activities whose moves go on the beat (0.134 T3).
    fn dancing(&self) -> Vec<Id> {
        self.live
            .iter()
            .filter(|(_, l)| l.node.state == State::Started && self.kinds[&l.kind].beat)
            .map(|(a, _)| *a)
            .collect()
    }

    /// The roles' moves of the activities started since the last call (0.134 T1): each member whose role names a move
    /// of `library` aims it at the other member through [`Activities::aim`], at `at`, and its record goes out for
    /// viewers as a form's move does (`souls:form-move`: 1 the activity, 2 the body, 3 the record, its texts as
    /// bytes). A move refused (unknown, out of reach, its claims held) is left out and the member plays its role
    /// without it; the refusals come back, by body.
    #[allow(clippy::too_many_arguments)]
    pub fn begin_moves(
        &mut self,
        tree: &mut Tree,
        c: &mut Controller,
        moves: &mut Moves,
        due: &mut DueList,
        mint: &mut Minter,
        library: &[Move],
        geo: &impl Reach,
        line: &Timeline,
        at: Micros,
    ) -> Vec<(Id, Refusal)> {
        let mut refused = Vec::new();
        for activity in std::mem::take(&mut self.begun) {
            let Some(l) = self.live.get(&activity) else {
                continue;
            };
            let kind = &self.kinds[&l.kind];
            if kind.beat {
                continue;
            }
            let audience = l.audience;
            let aims: Vec<(Member, Option<Id>, Name)> = l
                .node
                .members
                .iter()
                .filter_map(|m| {
                    let mv = kind.role(&m.role)?.mv.clone()?;
                    let other = l.node.members.iter().find(|o| o.body != m.body);
                    Some((m.clone(), other.map(|o| o.body), mv))
                })
                .collect();
            // A touch whose moves all end by themselves ends with them ([`Activities::finish`]); one that holds (T2's
            // hands) lasts until a member leaves.
            let mut held_any = false;
            let touches = !aims.is_empty();
            for (m, other, mv) in aims {
                let Some(found) = library.iter().find(|x| x.name == mv) else {
                    refused.push((
                        m.body,
                        Refusal {
                            name: "move-unknown",
                            detail: mv.as_str().to_owned(),
                        },
                    ));
                    continue;
                };
                let Some(target) = other else {
                    continue;
                };
                let n = match self.aim(c, moves, due, mint, geo, m.body, found, target, at) {
                    Ok(n) => n,
                    Err(r) => {
                        refused.push((m.body, r));
                        continue;
                    }
                };
                let Some(r) = moves.record(n) else {
                    continue;
                };
                held_any |= r.ends.contains(&Micros::MAX);
                let fields = BTreeMap::from([
                    (1, activity.to_value()),
                    (2, m.body.to_value()),
                    (3, as_bytes(r.to_value())),
                ]);
                let by = (at, Actor::Soul(m.soul), Cause::Intent(m.intent));
                if let Err(r) =
                    self.emit(tree, activity, audience, by, FORM_MOVE, fields, Vec::new())
                {
                    refused.push((m.body, r));
                }
            }
            if touches && !held_any {
                self.ending.insert(activity);
            }
        }
        for activity in self.dancing() {
            let first = *self
                .beats
                .entry(activity)
                .or_insert_with(|| first_beat(line, at));
            let l = &self.live[&activity];
            let (kind, audience) = (&self.kinds[&l.kind], l.audience);
            let due_now: Vec<(Member, Name)> = l
                .node
                .members
                .iter()
                .filter(|m| {
                    l.moves
                        .get(&m.body)
                        .is_none_or(|n| moves.record(*n).is_none())
                        && !self.stalled.contains(&(activity, m.body))
                })
                .filter_map(|m| Some((m.clone(), kind.role(&m.role)?.mv.clone()?)))
                .collect();
            let start = if at <= first {
                first
            } else {
                on_beat(line, at)
            };
            for (m, mv) in due_now {
                if let Some(l) = self.live.get_mut(&activity) {
                    l.moves.remove(&m.body);
                }
                let found = library.iter().find(|x| x.name == mv);
                let aimed = match found {
                    Some(f) => self.aim(c, moves, due, mint, geo, m.body, f, m.body, start),
                    None => refuse("move-unknown", mv.as_str()),
                };
                let n = match aimed {
                    Ok(n) => n,
                    Err(r) => {
                        self.stalled.insert((activity, m.body));
                        refused.push((m.body, r));
                        continue;
                    }
                };
                let Some(r) = moves.record(n) else {
                    continue;
                };
                let fields = BTreeMap::from([
                    (1, activity.to_value()),
                    (2, m.body.to_value()),
                    (3, as_bytes(r.to_value())),
                ]);
                let by = (at, Actor::Soul(m.soul), Cause::Intent(m.intent));
                if let Err(r) =
                    self.emit(tree, activity, audience, by, FORM_MOVE, fields, Vec::new())
                {
                    refused.push((m.body, r));
                }
            }
        }
        refused
    }

    /// Ends each touch whose moves have all ended (0.134 T1: a handshake, a hug, a high-five): every member leaves it,
    /// as its own `activity:leave` would (caused by the intent that joined it, at `at`), so its role claims are let
    /// go and both arms are free for the next act or the next touch. Returns the leaves refused, by body.
    #[allow(clippy::too_many_arguments)]
    pub fn finish(
        &mut self,
        tree: &mut Tree,
        c: &mut Controller,
        moves: &mut Moves,
        due: &mut DueList,
        mint: &mut Minter,
        at: Micros,
    ) -> Vec<(Id, Refusal)> {
        let done: Vec<Id> = self
            .ending
            .iter()
            .filter(|a| {
                self.live
                    .get(a)
                    .is_none_or(|l| l.moves.values().all(|n| moves.record(*n).is_none()))
            })
            .copied()
            .collect();
        let mut refused = Vec::new();
        for activity in done {
            self.ending.remove(&activity);
            let members = self
                .live
                .get(&activity)
                .map(|l| l.node.members.clone())
                .unwrap_or_default();
            for m in members {
                let ask = Ask {
                    soul: m.soul,
                    intent: m.intent,
                    at,
                };
                if let Err(r) = self.leave(tree, c, moves, due, mint, ask, m.body, activity) {
                    refused.push((m.body, r));
                }
            }
        }
        refused
    }

    /// Whether a touch that ends with its moves is waiting for them to end.
    pub fn finishing(&self) -> bool {
        !self.ending.is_empty()
    }

    /// `ask.soul` takes `body` out of `activity`. Always accepted: membership ends now, in the log, and the activity
    /// ends when its last member has left. Returns when the body is let go: now, or, in a move, at the move's next
    /// phase end or the kind's `leave_within`, whichever is first ([`Activities::fire`]). A body that is not a member
    /// is let go now and nothing is written.
    #[allow(clippy::too_many_arguments)]
    pub fn leave(
        &mut self,
        tree: &mut Tree,
        c: &mut Controller,
        moves: &mut Moves,
        due: &mut DueList,
        mint: &mut Minter,
        ask: Ask,
        body: Id,
        activity: Id,
    ) -> R<Micros> {
        // A hold (T2) lasts while both stay: when one leaves, the rest leave it too, so nobody is kept in a hold that
        // is over and the next hold between them starts.
        let holds = self.live.get(&activity).is_some_and(|l| {
            l.node.members.iter().any(|m| m.body == body)
                && l.moves.values().any(|n| held(moves, *n))
        });
        let at = self.leave_one(tree, c, moves, due, mint, ask, body, activity)?;
        if holds {
            let rest: Vec<Member> = self
                .live
                .get(&activity)
                .map(|l| l.node.members.clone())
                .unwrap_or_default();
            for m in rest {
                let theirs = Ask {
                    soul: m.soul,
                    intent: m.intent,
                    at: ask.at,
                };
                self.leave_one(tree, c, moves, due, mint, theirs, m.body, activity)?;
            }
        }
        Ok(at)
    }

    /// One member's leave ([`Activities::leave`]).
    #[allow(clippy::too_many_arguments)]
    fn leave_one(
        &mut self,
        tree: &mut Tree,
        c: &mut Controller,
        moves: &mut Moves,
        due: &mut DueList,
        mint: &mut Minter,
        ask: Ask,
        body: Id,
        activity: Id,
    ) -> R<Micros> {
        let Some(l) = self.live.get(&activity) else {
            return Ok(ask.at);
        };
        if !l.node.members.iter().any(|m| m.body == body) {
            return Ok(ask.at);
        }
        self.let_go(tree, c, moves, due, ask, activity)?;
        let l = self.live.get(&activity).expect("live above");
        let Some(i) = l.node.members.iter().position(|m| m.body == body) else {
            return Ok(ask.at);
        };
        let mut node = l.node.clone();
        let member = node.members.remove(i);
        let audience = l.audience;
        let within = self.kinds[&l.kind].leave_within;
        let mut changes = vec![Change::Unlink { link: member.link }];
        changes.push(if node.members.is_empty() {
            Change::Remove { node: activity }
        } else {
            Change::Set {
                node: activity,
                field: F_MEMBERS,
                to: node.members_value(),
                by: None,
            }
        });
        self.write(
            tree,
            activity,
            audience,
            ask,
            "souls:activity-left",
            changes,
        )?;
        let l = self.live.get_mut(&activity).expect("live above");
        l.node = node;
        let driver = l.drivers.remove(&body);
        let instance = l.moves.remove(&body);
        if l.node.members.is_empty() {
            self.live.remove(&activity);
            self.beats.remove(&activity);
        }
        self.stalled.remove(&(activity, body));
        if self.holding.get(&body) == Some(&activity) {
            self.holding.remove(&body);
        }
        if let Some(d) = driver {
            let _ = c.release(body, d);
        }
        let Some((n, record)) = instance.and_then(|n| moves.record(n).map(|r| (n, r))) else {
            // Let go now: a pair accepted from its offer and waiting for this body starts (E8).
            self.advance(tree, c, due, body, ask.at);
            return Ok(ask.at);
        };
        let bound = ask.at.saturating_add(within);
        let at = record
            .ends
            .iter()
            .copied()
            .find(|e| *e > ask.at)
            .map_or(bound, |e| e.min(bound));
        let id = minted(mint)?;
        due.set(Timer {
            node: body,
            id,
            due: at,
            name: name(LEAVE_TIMER),
        })?;
        self.leaving.insert(
            id,
            Leaving {
                body,
                instance: n,
                due: at,
            },
        );
        Ok(at)
    }

    /// The started activity holding `body` that a walk `body` sends leaves, as a leave does, if any: one in which a
    /// member's move holds (0.134 T2: holding hands), or one on the beat (T3: a dance).
    pub fn walk_leaves(&self, moves: &Moves, body: Id) -> Option<Id> {
        let a = *self.holding.get(&body)?;
        let l = self.live.get(&a)?;
        (self.kinds[&l.kind].beat || l.moves.values().any(|n| held(moves, *n))).then_some(a)
    }

    /// Releases every member's held move in `activity` (0.134 T2), so both hands come free, each written for viewers
    /// as its record again, ended `released`, caused by `ask`.
    fn let_go(
        &mut self,
        tree: &mut Tree,
        c: &mut Controller,
        moves: &mut Moves,
        due: &mut DueList,
        ask: Ask,
        activity: Id,
    ) -> R<()> {
        let Some(l) = self.live.get(&activity) else {
            return Ok(());
        };
        let audience = l.audience;
        let held: Vec<(Id, Instance)> = l
            .moves
            .iter()
            .filter(|(_, n)| held(moves, **n))
            .map(|(b, n)| (*b, *n))
            .collect();
        for (body, n) in held {
            let Some(r) = moves.release(c, due, n, ask.at) else {
                continue;
            };
            let fields = BTreeMap::from([
                (1, activity.to_value()),
                (2, body.to_value()),
                (3, as_bytes(r.to_value())),
            ]);
            let by = (ask.at, Actor::Soul(ask.soul), Cause::Intent(ask.intent));
            self.emit(tree, activity, audience, by, FORM_MOVE, fields, Vec::new())?;
        }
        Ok(())
    }

    /// Runs a timer the due list handed back: `None` when it is not a leave's. The leaving body's move is cancelled
    /// `left` if it still runs, which releases what it held. Returns the body and when it was let go.
    pub fn fire(
        &mut self,
        c: &mut Controller,
        moves: &mut Moves,
        due: &mut DueList,
        t: &Timer,
    ) -> Option<(Id, Micros)> {
        if t.name.as_str() != LEAVE_TIMER {
            return None;
        }
        let lv = self.leaving.remove(&t.id)?;
        let _ = moves.cancel(c, due, lv.instance, t.due, name("left"));
        Some((lv.body, t.due))
    }

    /// After moves have fired: each member whose move inside the activity has ended has its role's claims taken
    /// again, and a leaving body whose move ended first is let go then (its timer cleared). Returns the bodies whose
    /// role claims could not be taken again, each with T9's refusal.
    pub fn settle(
        &mut self,
        c: &mut Controller,
        moves: &Moves,
        due: &mut DueList,
    ) -> Vec<(Id, Refusal)> {
        let mut refused = Vec::new();
        for l in self.live.values_mut() {
            let ended: Vec<Id> = l
                .moves
                .iter()
                .filter(|(_, n)| moves.record(**n).is_none())
                .map(|(b, _)| *b)
                .collect();
            for body in ended {
                l.moves.remove(&body);
                if l.drivers.contains_key(&body) {
                    continue;
                }
                let kind = &self.kinds[&l.kind];
                let Some(m) = l.node.members.iter().find(|m| m.body == body) else {
                    continue;
                };
                let shape = kind.shape(kind.role(&m.role).expect("a member's role"));
                match c.claim(body, &shape) {
                    Ok(d) => {
                        l.drivers.insert(body, d);
                    }
                    Err(r) => refused.push((body, r)),
                }
            }
        }
        let done: Vec<Id> = self
            .leaving
            .iter()
            .filter(|(_, lv)| moves.record(lv.instance).is_none())
            .map(|(id, _)| *id)
            .collect();
        for id in done {
            if let Some(lv) = self.leaving.remove(&id) {
                due.cancel((lv.due, id));
            }
        }
        refused
    }

    /// Starts move `mv` by `actor` at `target`'s body, which only the activity may do: both must be members of the
    /// same started activity (`target-outside-activity`, which changes nothing), and the actor must have no move in
    /// progress in it (`move-in-progress`). A move whose claims meet the activity's own claim on the actor runs in its
    /// place until it ends; B2's refusals come back by name, with the activity's claim kept or taken back.
    #[allow(clippy::too_many_arguments)]
    pub fn aim(
        &mut self,
        c: &mut Controller,
        moves: &mut Moves,
        due: &mut DueList,
        mint: &mut Minter,
        geo: &impl Reach,
        actor: Id,
        mv: &Move,
        target: Id,
        at: Micros,
    ) -> R<Instance> {
        let a = self.holding.get(&actor);
        // A move at the actor's own body touches nobody (0.134 T3: a dance on the beat).
        let same = a.is_some() && (actor == target || a == self.holding.get(&target));
        let Some(activity) = a.copied().filter(|_| same) else {
            return refuse(
                "target-outside-activity",
                format!(
                    "{} at {}: no started activity holds both",
                    show(actor),
                    show(target)
                ),
            );
        };
        let l = self
            .live
            .get_mut(&activity)
            .expect("a holding activity is live");
        if l.moves.contains_key(&actor) {
            return refuse("move-in-progress", show(actor));
        }
        let kind = &self.kinds[&l.kind];
        let m = l
            .node
            .members
            .iter()
            .find(|m| m.body == actor)
            .expect("a held body is a member");
        let shape = kind.shape(kind.role(&m.role).expect("a member's role"));
        let first = moves.start(c, due, mint, geo, actor, mv, target, at);
        let held =
            matches!(&first, Err(r) if r.name == "resource-held" || r.name == "resource-blocked");
        let started = match (first, l.drivers.remove(&actor)) {
            (Err(_), Some(d)) if held => {
                let _ = c.release(actor, d);
                let again = moves.start(c, due, mint, geo, actor, mv, target, at);
                if again.is_err()
                    && let Ok(d) = c.claim(actor, &shape)
                {
                    l.drivers.insert(actor, d);
                }
                again
            }
            (r, d) => {
                l.drivers.extend(d.map(|d| (actor, d)));
                r
            }
        };
        let n = started?;
        l.moves.insert(actor, n);
        Ok(n)
    }

    /// The activities of `tree` after a restart, read from their nodes and membership links: each started one takes
    /// its members' role claims again through `c`, all or none. A member whose link is not in the tree is dropped.
    /// No move is restored, since none is stored.
    pub fn restore(
        header: Header,
        rules: Rules,
        kinds: Vec<ActivityKind>,
        tree: &Tree,
        c: &mut Controller,
    ) -> R<Activities> {
        let state = tree.to_state();
        let mut a = Activities::new(header, rules, state.next, kinds);
        for (id, n) in &state.nodes {
            if !a.kinds.contains_key(&n.kind) {
                continue;
            }
            let mut node = Node::from_fields(&n.fields)?;
            let links: BTreeSet<Id> = tree.links_at(*id).iter().map(|e| e.link).collect();
            node.members.retain(|m| links.contains(&m.link));
            let mut drivers = BTreeMap::new();
            if node.state == State::Started {
                let kind = &a.kinds[&n.kind];
                for m in &node.members {
                    let shape = kind.shape(kind.role(&m.role).ok_or_else(|| Refusal {
                        name: "role-unknown",
                        detail: m.role.as_str().to_owned(),
                    })?);
                    match c.claim(m.body, &shape) {
                        Ok(d) => {
                            drivers.insert(m.body, d);
                            a.holding.insert(m.body, *id);
                        }
                        Err(r) => {
                            for (b, d) in drivers {
                                let _ = c.release(b, d);
                            }
                            return Err(r);
                        }
                    }
                }
            }
            a.live.insert(
                *id,
                Live {
                    kind: n.kind.clone(),
                    audience: n.audience,
                    node,
                    drivers,
                    moves: BTreeMap::new(),
                },
            );
        }
        Ok(a)
    }
}

#[cfg(test)]
mod tests;
