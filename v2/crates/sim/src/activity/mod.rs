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
//! - **Following another Soul (0.135 G2).** A kind may name the role that follows
//!   ([`replica::activity::ActivityKind::follows`]); the other member leads. The offer and its accept are the consent;
//!   while it runs, worldd keeps the follower's own `souls:follow` order on the leader (`v2/docs/intents.md` rule 5,
//!   `crate::orders`), so following is the one existing order and its skill. Either member's leave ends it for both;
//!   the follower's own walk leaves it ([`Activities::walk_leaves`]); its order ending (displaced by the follower's
//!   own act, expired, the leader gone) ends it too ([`Activities::following`]).
//! - **Members take their places (0.135 G3).** A role whose kind says where its members stand has them walk there
//!   and turn to their facing when the activity starts, before its moves begin ([`places`], [`Activities::pending_places`]).
//! - **A held move lasts while both stay (0.134 T2).** A role's move whose last phase holds (`hold_hand`) holds until
//!   a member leaves: then every member's held move is released, so both hands come free, each release goes out
//!   for viewers as its record again, ended `released`, and the others leave the hold too ([`Activities::leave`]). A walk sent by a member ends it the same
//!   way ([`Activities::walk_leaves`] names the activity; worldd sends the leave).
//! - **Walking hand in hand (0.135 R1).** In a hold, the first member to walk leads ([`Activities::lead`]): its walk
//!   does not let go, and the other keeps its place beside it, the width of the kind's two stands apart
//!   (`v2/docs/moving-group.md`, a walker steering to its place), by its own `souls:follow` order, as a follower
//!   does ([`Activities::following`]). The other's own walk lets go, as before; so does its order ending (its own
//!   act, or a place it could not keep). When the leader stops, both stand holding hands.
//! - **An activity whose roles name moves does not outlast a restart (0.135 R1).** Its moves are not stored, so a
//!   started one (not a dance) is ended at the first tick after a restart, each member leaving as its own leave
//!   would ([`Activities::restore`], [`Activities::finish`]): nobody is kept in a hold whose hands came apart. This is
//!   every such kind, not only touches and holds, because the engine treats them all as touches: each ends when its
//!   moves end, or, if they hold, when a member leaves ([`Activities::begin_moves`]). After a restart no move comes
//!   back to end, so without this its members would keep its role claims with nothing playing, and every later
//!   activity of theirs would be refused `body-in-activity` until each left by hand.
//! - **Dancing together on one beat (0.134 T3).** A kind whose moves go on the beat (`beat`) takes up to its `most`
//!   members, offered to several at once; each later accept joins the offer's own activity ([`offer`]). Its first
//!   beat is fixed when it starts: the last whole beat of the world's clock at most 2 s ahead (`v2/docs/time.md`
//!   rule 7), so accepts that arrive within about 1.5 s of the first all begin on it. Each member's move is aimed at
//!   its own body and starts on that beat, or, for a member who joins after it, on the next whole beat; when it ends
//!   it begins again on the next whole beat, until the member leaves. A leave is always accepted, as any leave.
//! - **A leave completes within the time the kind states.** Membership ends at once, in the log. A body with no move
//!   in progress is let go at once; a body in a move is let go at the move's next phase end, or at the kind's
//!   `leave_within`, whichever is first, by a timer in K9's due list ([`Activities::fire`]).
//! - **A role binds its member on the activity's thing (B10, #4239).** An activity offered or proposed at a thing
//!   whose kind its roles' links are on (an entry's own thing, [`replica::activity::RoleLink`]) is that thing's: each
//!   member holds its role's link on the thing, its body (or Soul) to the thing, owned by the thing, so the entry's
//!   forms that ask for the link (`who: {link}`, a `linked` need) pass for it and refuse others by name. The link is
//!   written in the part of the offer, accept or join that makes the member, one more effect at the thing acted and
//!   caused as that step; it is taken down in the part of its leave, or of the offer's lapse or decline that ends the
//!   node, unless the member holds the same role at the thing in another activity. On the open ground none is written.
//!   A role the thing already holds as often as its link's `most` allows, by others, is not taken again: the offer,
//!   accept or join is refused `role-taken` and writes nothing. An offer asks bodies only (`offer-asked-not-a-body`).
//!   A bound activity claims no part of its members' bodies: the thing's forms, which its members play it through,
//!   take what they use.
//! - **Nothing bound outlives its reason (B10).** An unstarted activity past its expiry that no offer or pair waits on
//!   (a proposal nobody started, or an offer or waiting pair a restart did not keep) ends at worldd's tick, with its
//!   memberships and role links ([`Activities::expire`], `souls:activity-expired`). A bound activity whose thing a
//!   creator's edit removed (the tree takes its node and links with it) is forgotten at the next tick and its members
//!   let go at once, each told at its body by name ([`Activities::release_gone`], [`ENDED`] why [`THING_GONE`]).
//! - **A restart does not end an activity**, except one whose roles name moves (above). Its node and its membership
//!   links are in the log; [`Activities::restore`] reads them back and takes each started activity's claims again. A move in progress is not stored, so after a
//!   restart no claim is held by a move that did not come back, and a member can leave at once.
//!
//! Not here: contact rules (B6), the beat (B8), activities that keep members while empty, the gateway path (I7), a new
//! revision when roles or places change, walking a member to its role's place. Offers, accepted, declined or lapsed,
//! are [`offer`] (E8); standing consent is a rule in the Soul's own client (R9), never here.

use std::collections::{BTreeMap, BTreeSet};

use replica::activity::{ActivityKind, F_MEMBERS, F_STATE, MEMBER, Member, Node, RoleLink, State};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Event, Header, Part, Refusal, Rest,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Id, Minter};
use replica::moves::Move;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::time::{Micros, Timeline};
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, End, plain, show};

use replica::bodies::SkillShape;

use crate::controller::{Controller, Driver};
use crate::moves::{Instance, Moves, Reach};
use crate::structure::Structure;
use crate::timers::{DueList, Timer};

pub mod carry;
pub mod offer;
pub mod places;
pub mod seating;

type R<T> = Result<T, Refusal>;

/// One more effect in an activity's part (B10): its node, its audience and its changes.
type Bound = (Id, Audience, Vec<Change>);

/// The conversation's kind, by its plain name (E26): it claims one voice, so a Soul in one still walks, sits and does
/// any other activity with the same or another Soul (trial of 25 Nov: a follow offered by two Souls who were talking
/// never started). Its holds are kept apart from every other activity's ([`Activities::talking`]).
pub const CONVERSATION: &str = "souls:conversation";

/// Whether activities of `kind` are conversations, held apart from the rest.
fn talk(kind: &Name) -> bool {
    plain(kind.as_str()) == CONVERSATION
}

/// The node `id` is under, if it is in the tree.
fn parent(tree: &Tree, id: Id) -> Option<Id> {
    tree.handle(id)
        .and_then(|h| tree.node(h))
        .and_then(|n| n.parent())
}

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

/// How far apart two Souls walking hand in hand keep, µm, when the kind's stands do not say (0.135 R1).
const HAND_IN_HAND: i64 = 500_000;

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
    /// Bound to its thing (B10): it was made under a thing its roles' links are on, so it claims nothing.
    bound: bool,
    /// The node it was made under: its place, or its thing when bound.
    under: Id,
}

/// What `role` of `kind` claims on its member's body: its claims, or nothing when its activity is bound to its thing
/// (B10): it is played through the thing's own forms, whose runs take what they use, so its members' hands stay theirs.
fn shape_of(kind: &ActivityKind, role: &replica::activity::Role, bound: bool) -> SkillShape {
    let mut shape = kind.shape(role);
    if bound {
        shape.claims.clear();
    }
    shape
}

/// The event of an activity that ended without a member's leave (B10): `{1: activity, 2: why}`, at each member's body.
pub const ENDED: &str = "souls:activity-ended";
/// Why: its node went with the thing it was under (a creator's edit removed it).
pub const THING_GONE: &str = "souls:thing-gone";
/// Why: it did not start before it expired, and no offer or pair waits on it (or its offer did not survive a restart).
pub const EXPIRED: &str = "souls:activity-expired";

/// Who turns to face its activity's middle (#423, [`Activities::turns`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Turn {
    /// The bodies that turn.
    pub bodies: Vec<Id>,
    /// Every member of the activity: whose middle they face.
    pub members: Vec<Id>,
    /// The middle when the world set it (an activity with places): the node its members stand on and the point there.
    pub middle: Option<(Id, Vec3)>,
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
    /// The started activity that holds each body, a conversation apart.
    holding: BTreeMap<Id, Id>,
    /// The started conversation that holds each body (E26): a body talks in one and does one other activity at once.
    talking: BTreeMap<Id, Id>,
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
    /// Members still taking their places, by activity (0.135 G3); each activity's frame once set, with the node its
    /// members stand on (None: they stand where they are); and each member's stand, its index in its role.
    placing: BTreeMap<Id, BTreeSet<Id>>,
    frames: BTreeMap<Id, Option<(Id, places::Frame)>>,
    stands: BTreeMap<Id, BTreeMap<Id, usize>>,
    /// The member leading each hold that walks hand in hand (0.135 R1), by activity.
    leaders: BTreeMap<Id, Id>,
    /// Activities started, or another joined after they started (a group's later accept), since [`Activities::turns`]
    /// last ran, and members of placed activities left where they stand ([`Activities::pending_places`]), by
    /// (activity, body): who turns to face its activity's middle (#423). Each is read once.
    to_face: Vec<Id>,
    unplaced: Vec<(Id, Id)>,
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
            talking: BTreeMap::new(),
            leaving: BTreeMap::new(),
            offers: offer::Offers::default(),
            begun: Vec::new(),
            beats: BTreeMap::new(),
            stalled: BTreeSet::new(),
            ending: BTreeSet::new(),
            placing: BTreeMap::new(),
            frames: BTreeMap::new(),
            stands: BTreeMap::new(),
            leaders: BTreeMap::new(),
            to_face: Vec::new(),
            unplaced: Vec::new(),
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

    /// Why `activity`, not started, is not: the refusal its accepted pair's last start met (a member held by another
    /// activity, say), or that no one has accepted its offer yet. None once it has started, or when it is not live.
    pub fn unstarted_why(&self, activity: Id) -> Option<String> {
        if self.started(activity) || !self.live.contains_key(&activity) {
            return None;
        }
        Some(match self.offers.why.get(&activity) {
            Some(r) => format!("its start was refused {}: {}", r.name, r.detail),
            None if self.offers.pairs.contains_key(&activity) => {
                "its pair waits behind its asker's earlier one".to_owned()
            }
            None => "no one has accepted its offer yet".to_owned(),
        })
    }

    /// The started activity holding `body`, if any: the one besides a conversation, else its conversation.
    pub fn holder(&self, body: Id) -> Option<Id> {
        self.holding
            .get(&body)
            .or_else(|| self.talking.get(&body))
            .copied()
    }

    /// The started activities of `kind`'s sort (a conversation, or any other) holding each body.
    fn holds_of(&self, kind: &Name) -> &BTreeMap<Id, Id> {
        if talk(kind) {
            &self.talking
        } else {
            &self.holding
        }
    }

    /// `body` held by started `activity` of `kind`.
    fn hold(&mut self, kind: &Name, body: Id, activity: Id) {
        if talk(kind) {
            self.talking.insert(body, activity);
        } else {
            self.holding.insert(body, activity);
        }
    }

    /// Whether `driver` on `body` is held by a live activity: its own claim, or a move it aimed.
    pub fn holds(&self, moves: &Moves, body: Id, driver: Driver) -> bool {
        [self.holding.get(&body), self.talking.get(&body)]
            .into_iter()
            .flatten()
            .filter_map(|a| self.live.get(a))
            .any(|l| {
                l.drivers.get(&body) == Some(&driver)
                    || l.moves
                        .get(&body)
                        .is_some_and(|n| moves.record(*n).is_some())
            })
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
        self.write_with(tree, node, audience, ask, event, changes, Vec::new())
    }

    /// [`Activities::write`] with `bound` in its part ([`Activities::emit_with`]).
    #[allow(clippy::too_many_arguments)]
    fn write_with(
        &mut self,
        tree: &mut Tree,
        node: Id,
        audience: Audience,
        ask: Ask,
        event: &'static str,
        changes: Vec<Change>,
        bound: Vec<Bound>,
    ) -> R<()> {
        let by = (ask.at, Actor::Soul(ask.soul), Cause::Intent(ask.intent));
        self.emit_with(
            tree,
            node,
            audience,
            by,
            event,
            BTreeMap::new(),
            changes,
            bound,
        )
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
        self.emit_with(tree, node, audience, by, event, fields, changes, Vec::new())
    }

    /// [`Activities::emit`] with `bound` after it in the same part: each one more effect at its node, with no event,
    /// acted and caused alike (B10: a role's links written or taken down with the membership that holds them).
    #[allow(clippy::too_many_arguments)]
    fn emit_with(
        &mut self,
        tree: &mut Tree,
        node: Id,
        audience: Audience,
        by: (Micros, Actor, Cause),
        event: &'static str,
        fields: BTreeMap<u64, Value>,
        changes: Vec<Change>,
        bound: Vec<Bound>,
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
        let mut effects = vec![effect];
        for (k, (node, audience, changes)) in bound.into_iter().enumerate() {
            effects.push(Effect {
                envelope: Envelope {
                    sequence: self.next + 1 + k as u64,
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
                events: None,
                rest: Rest::new(),
            });
        }
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

    /// The role link (B10) `kind`'s `role` names, and `place`'s audience, when `place` is a thing of the kind that
    /// link is on; else None (an activity on the open ground binds nothing).
    fn bound_on(
        &self,
        tree: &Tree,
        kind: &Name,
        place: Id,
        role: &Name,
    ) -> Option<(RoleLink, Audience)> {
        let link = self.kinds.get(kind)?.role(role)?.link.as_ref()?;
        let n = tree.handle(place).and_then(|h| tree.node(h))?;
        (plain(n.kind().as_str()) == link.on).then(|| (link.clone(), n.audience()))
    }

    /// Whether an activity of `kind` under `place` is bound to its thing there (B10): a role of it links on `place`.
    pub(super) fn binds(&self, tree: &Tree, kind: &Name, place: Id) -> bool {
        self.kinds.get(kind).is_some_and(|k| {
            k.roles
                .iter()
                .any(|r| self.bound_on(tree, kind, place, &r.name).is_some())
        })
    }

    /// `place`'s own links of type `ty` ending at `end`.
    fn role_links_at(tree: &Tree, place: Id, ty: &Name, end: Id) -> Vec<Id> {
        tree.links_at(place)
            .iter()
            .filter(|e| tree.ty(e) == ty && e.other == end)
            .filter(|e| {
                tree.link(e.link).is_some_and(|(_, ends, owner, _)| {
                    ends[usize::from(owner == End::Second)] == place
                })
            })
            .map(|e| e.link)
            .collect()
    }

    /// The entry that gives member `m` of an activity of `kind` under `place` its role's link (B10): its body (or its
    /// Soul) linked to the thing, owned by the thing. None when its role binds nothing there, or the link is there;
    /// `role-taken` when the thing holds the role's `most` already, by others.
    fn role_link(
        &self,
        tree: &Tree,
        mint: &mut Minter,
        kind: &Name,
        place: Id,
        m: &Member,
    ) -> R<Option<Bound>> {
        let Some((rl, audience)) = self.bound_on(tree, kind, place, &m.role) else {
            return Ok(None);
        };
        let end = if rl.soul { m.soul } else { m.body };
        if !Self::role_links_at(tree, place, &rl.ty, end).is_empty() {
            return Ok(None);
        }
        // Held by as many others as it takes: one more is refused, and nothing is written.
        let held: Vec<Id> = tree
            .links_at(place)
            .iter()
            .filter(|e| tree.ty(e) == &rl.ty && e.other != end)
            .map(|e| e.other)
            .collect();
        if rl.most.is_some_and(|most| held.len() as u64 >= most) {
            return refuse(
                "role-taken",
                format!(
                    "{} at {} is held by {}",
                    m.role.as_str(),
                    show(place),
                    held.iter().map(|h| show(*h)).collect::<Vec<_>>().join(", ")
                ),
            );
        }
        let link = minted(mint)?;
        Ok(Some((
            place,
            audience,
            vec![Change::Link {
                link,
                ty: rl.ty,
                ends: [end, place],
                owner: End::Second,
                audience,
            }],
        )))
    }

    /// The entry that takes down the role link (B10) member `m` of `activity` holds on its thing, as it stops being a
    /// member. None when it binds nothing, or the member holds the same role on the same thing in another activity.
    fn role_unlink(&self, tree: &Tree, activity: Id, m: &Member) -> Option<Bound> {
        let l = self.live.get(&activity)?;
        let place = parent(tree, activity)?;
        let (rl, audience) = self.bound_on(tree, &l.kind, place, &m.role)?;
        let other = self.live.iter().any(|(id, o)| {
            *id != activity
                && o.kind == l.kind
                && parent(tree, *id) == Some(place)
                && o.node
                    .members
                    .iter()
                    .any(|x| x.body == m.body && x.role == m.role)
        });
        let end = if rl.soul { m.soul } else { m.body };
        let links = Self::role_links_at(tree, place, &rl.ty, end);
        if other || links.is_empty() {
            return None;
        }
        Some((
            place,
            audience,
            links
                .into_iter()
                .map(|link| Change::Unlink { link })
                .collect(),
        ))
    }

    /// The entries that take down the role links of every member of `activity` (B10), as its node ends.
    pub(super) fn role_unlinks(&self, tree: &Tree, activity: Id) -> Vec<Bound> {
        self.live.get(&activity).map_or_else(Vec::new, |l| {
            l.node
                .members
                .iter()
                .filter_map(|m| self.role_unlink(tree, activity, m))
                .collect()
        })
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
        let bound = self.binds(tree, kind, place);
        self.live.insert(
            id,
            Live {
                kind: kind.clone(),
                audience,
                node,
                drivers: BTreeMap::new(),
                moves: BTreeMap::new(),
                bound,
                under: place,
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
        let me = Member {
            role: role.clone(),
            body,
            soul: ask.soul,
            link,
            intent: ask.intent,
        };
        let kind = l.kind.clone();
        node.members.push(me.clone());
        let audience = l.audience;
        // B10: the role's link on the activity's thing, in the join's part.
        let bound: Vec<Bound> = match parent(tree, activity) {
            Some(place) => self
                .role_link(tree, mint, &kind, place, &me)?
                .into_iter()
                .collect(),
            None => Vec::new(),
        };
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
        self.write_with(
            tree,
            activity,
            audience,
            ask,
            "souls:activity-joined",
            changes,
            bound,
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
            .filter(|r| Some(&r.name) != offer::several(kind))
            .filter(|r| !l.node.members.iter().any(|m| m.role == r.name))
            .map(|r| r.name.as_str())
            .collect();
        if !open.is_empty() {
            return refuse("roles-unfilled", open.join(", "));
        }
        for m in &l.node.members {
            if let Some(other) = self.holds_of(&l.kind).get(&m.body) {
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
                let role = kind.role(&m.role).expect("a member's role");
                (m.body, shape_of(kind, role, l.bound))
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
        let (audience, kind) = (l.audience, l.kind.clone());
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
            self.hold(&kind, *body, activity);
        }
        if let Some(l) = self.live.get_mut(&activity) {
            l.node.state = State::Started;
            l.drivers = drivers;
        }
        self.begun.push(activity);
        self.to_face.push(activity);
        self.mark_places(activity, None);
        Ok(())
    }

    /// Whether a bound activity's thing is gone from `tree` (B10: a creator's edit removed it, and the activity's node
    /// and links with it).
    pub fn stranded(&self, tree: &Tree) -> bool {
        self.live
            .values()
            .any(|l| l.bound && tree.handle(l.under).is_none())
    }

    /// Every bound activity whose thing is gone from `tree` (B10: a creator's edit removed it, and the tree took the
    /// activity's node and links with it) forgotten, its members' claims let go, and each member told by name at
    /// its body ([`ENDED`], why [`THING_GONE`]), acted and caused by the world. Its members are free at once: they may
    /// act, offer and join again. Returns the activities forgotten.
    pub fn release_gone(&mut self, tree: &mut Tree, c: &mut Controller, at: Micros) -> Vec<Id> {
        let gone: Vec<Id> = self
            .live
            .iter()
            .filter(|(_, l)| l.bound && tree.handle(l.under).is_none())
            .map(|(a, _)| *a)
            .collect();
        for a in &gone {
            let Some(l) = self.live.get(a) else { continue };
            let members: Vec<Id> = l.node.members.iter().map(|m| m.body).collect();
            for (b, d) in l.drivers.clone() {
                let _ = c.release(b, d);
            }
            self.forgotten(*a);
            for body in members {
                let Some(audience) = tree
                    .handle(body)
                    .and_then(|h| tree.node(h))
                    .map(|n| n.audience())
                else {
                    continue;
                };
                let fields =
                    BTreeMap::from([(1, a.to_value()), (2, Value::Text(name(THING_GONE)))]);
                let by = (at, Actor::World, Cause::World);
                if let Err(r) = self.emit(tree, body, audience, by, ENDED, fields, Vec::new()) {
                    eprintln!("an activity's end was not told to {}: {r}", show(body));
                }
            }
        }
        gone
    }

    /// When the next unstarted activity no offer or pair waits on expires ([`Activities::expire`]): a sleeping world
    /// wakes for it.
    pub fn next_expiry(&self) -> Option<Micros> {
        self.live
            .iter()
            .filter(|(a, l)| self.lapses(**a, l, Micros::MAX))
            .map(|(_, l)| l.node.expires)
            .min()
    }

    /// Whether an unstarted activity no offer or pair waits on is past its expiry at `now` ([`Activities::expire`]).
    pub fn expiring(&self, now: Micros) -> bool {
        self.live.iter().any(|(a, l)| self.lapses(*a, l, now))
    }

    fn lapses(&self, a: Id, l: &Live, now: Micros) -> bool {
        l.node.state == State::Proposed
            && l.node.expires <= now
            && !self.offers.open.contains_key(&a)
            && !self.offers.pairs.contains_key(&a)
    }

    /// Ends every unstarted activity past its expiry that no offer or pair waits on (B10): a proposal nobody started,
    /// or an offer or waiting pair whose offer did not survive a restart (offers are not restored). Its node goes with
    /// its memberships and its members' role links, in one part acted and caused by the world, event [`EXPIRED`].
    pub fn expire(&mut self, tree: &mut Tree, now: Micros) -> Vec<Id> {
        let due: Vec<Id> = self
            .live
            .iter()
            .filter(|(a, l)| self.lapses(**a, l, now))
            .map(|(a, _)| *a)
            .collect();
        for a in &due {
            let Some(l) = self.live.get(a) else { continue };
            let audience = l.audience;
            let mut changes: Vec<Change> = l
                .node
                .members
                .iter()
                .map(|m| Change::Unlink { link: m.link })
                .collect();
            changes.push(Change::Remove { node: *a });
            let bound = self.role_unlinks(tree, *a);
            let fields = BTreeMap::from([(1, a.to_value())]);
            let by = (now, Actor::World, Cause::World);
            match self.emit_with(tree, *a, audience, by, EXPIRED, fields, changes, bound) {
                Ok(()) => self.forgotten(*a),
                Err(r) => eprintln!("an expired activity {} did not end: {r}", show(*a)),
            }
        }
        due
    }

    /// Every activity running, by id (0.135 C3: worldd finds the loads riding them after a restart).
    pub fn ids(&self) -> Vec<Id> {
        self.live.keys().copied().collect()
    }

    /// The world's word that a carry in `activity` broke off and `load` was set down where it was, and `why`
    /// (`souls:partner-left`, `souls:carriers-apart`, `souls:world-restarted`, C7's `souls:carry-blocked`):
    /// `souls:carry-set-down`, `{1: activity, 2: load, 3: why}`, to the activity's audience, acted and caused as `by`
    /// says (0.135 C3).
    pub fn carry_set_down(
        &mut self,
        tree: &mut Tree,
        activity: Id,
        load: Id,
        why: &'static str,
        by: (Micros, Actor, Cause),
    ) -> R<()> {
        self.load_word(tree, activity, load, "souls:carry-set-down", why, by)
    }

    /// The world's word of the way `activity`'s carriers walk `load` (0.135 R2: one that turns it, found at the lift):
    /// `souls:carry-way`, `{1: activity, 2: load, 3: [[front x, front z, back x, back z], ...]}`, each pose where its
    /// front and back carriers stand on the open ground's plan, µm, the first where they stand at the lift.
    pub fn carry_way(
        &mut self,
        tree: &mut Tree,
        activity: Id,
        load: Id,
        way: &[carry::turn::Ends],
        by: (Micros, Actor, Cause),
    ) -> R<()> {
        let audience = self
            .live
            .get(&activity)
            .map_or(Audience::Everyone, |l| l.audience);
        let num = |v: i64| {
            u64::try_from(v).map_or_else(|_| Value::Nint(v.unsigned_abs() - 1), Value::Uint)
        };
        let poses = way
            .iter()
            .map(|(f, b)| Value::Array(vec![num(f[0]), num(f[1]), num(b[0]), num(b[1])]))
            .collect();
        let fields = BTreeMap::from([
            (1, activity.to_value()),
            (2, load.to_value()),
            (3, Value::Array(poses)),
        ]);
        self.emit(
            tree,
            activity,
            audience,
            by,
            "souls:carry-way",
            fields,
            Vec::new(),
        )
    }

    /// The world's word that `load`, held by `activity`, was kept as it stands, and `why` (0.135 A2: its last holder
    /// left and setting it down would leave a joined part hanging): `souls:hold-kept`, `{1: activity, 2: load, 3: why}`,
    /// as [`Activities::carry_set_down`] says it.
    pub fn hold_kept(
        &mut self,
        tree: &mut Tree,
        activity: Id,
        load: Id,
        why: &'static str,
        by: (Micros, Actor, Cause),
    ) -> R<()> {
        self.load_word(tree, activity, load, "souls:hold-kept", why, by)
    }

    /// Ends kept hold `activity` (0.135 A2: its last holder left the world and its part was kept as it stood), as
    /// another crew holds, takes or unseats its part: its node is removed, caused and acted as `ask` says
    /// (`souls:hold-ended`), and it is forgotten here. Nothing else is held by it: its members' bodies are gone.
    pub fn forget(&mut self, tree: &mut Tree, activity: Id, ask: Ask) -> R<()> {
        let audience = self
            .live
            .get(&activity)
            .map_or(Audience::Everyone, |l| l.audience);
        self.write(
            tree,
            activity,
            audience,
            ask,
            "souls:hold-ended",
            vec![Change::Remove { node: activity }],
        )?;
        self.forgotten(activity);
        Ok(())
    }

    /// Forgets `activity`, whose node is gone (0.135 A2: a kept hold removed with its part's set-down).
    pub fn forgotten(&mut self, activity: Id) {
        self.live.remove(&activity);
        self.offers.open.remove(&activity);
        if self.offers.pairs.remove(&activity).is_some() {
            for q in self.offers.queues.values_mut() {
                q.retain(|p| *p != activity);
            }
        }
        self.offers.why.remove(&activity);
        self.offers.timers.retain(|_, a| *a != activity);
        self.beats.remove(&activity);
        self.ending.remove(&activity);
        self.begun.retain(|a| *a != activity);
        self.holding.retain(|_, a| *a != activity);
        self.talking.retain(|_, a| *a != activity);
        self.stalled.retain(|(a, _)| *a != activity);
        self.placing.remove(&activity);
        self.frames.remove(&activity);
        self.stands.remove(&activity);
        self.leaders.remove(&activity);
    }

    /// The world's word `event` about `load`, held by `activity`, and `why`: `{1: activity, 2: load, 3: why}`, as
    /// [`Activities::carry_set_down`] says it (0.135 C5: `souls:carry-going-on`, a side carrier left).
    pub fn load_word(
        &mut self,
        tree: &mut Tree,
        activity: Id,
        load: Id,
        event: &'static str,
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
        self.emit(tree, node, audience, by, event, fields, Vec::new())
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

    /// Who turns to face its activity's middle (#423), read once. The members of an activity whose
    /// roles say nowhere to stand (a conversation; a follow and a crew apart) turn as it begins, and again whenever
    /// another joins it (a group's later accept), so two face each other (trial of 25 Nov: two Souls talking faced
    /// different ways) and a group of three or more faces its middle. A member of an activity with places that is left
    /// where it stands ([`Activities::pending_places`]) faces the activity's middle. Members given places face as their
    /// stands say (0.135 G3), and a crew's carriers as their carry says.
    pub fn turns(&mut self) -> Vec<Turn> {
        let to_face = std::mem::take(&mut self.to_face);
        let unplaced = std::mem::take(&mut self.unplaced);
        let bodies = |l: &Live| -> Vec<Id> { l.node.members.iter().map(|m| m.body).collect() };
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for a in &to_face {
            let Some(l) = self.live.get(a).filter(|_| seen.insert(*a)) else {
                continue;
            };
            let kind = &self.kinds[&l.kind];
            if kind.follows.is_none()
                && offer::several(kind).is_none()
                && kind.roles.iter().all(|r| r.stands.is_empty())
                && l.node.members.len() > 1
            {
                out.push(Turn {
                    bodies: bodies(l),
                    members: bodies(l),
                    middle: None,
                });
            }
        }
        for (a, body) in unplaced {
            if let Some(l) = self
                .live
                .get(&a)
                .filter(|l| offer::several(&self.kinds[&l.kind]).is_none())
            {
                let middle = self.frames.get(&a).copied().flatten();
                out.push(Turn {
                    bodies: vec![body],
                    members: bodies(l),
                    middle: middle.map(|(n, f)| (n, f.origin)),
                });
            }
        }
        out
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
        let mut waiting = Vec::new();
        for activity in std::mem::take(&mut self.begun) {
            let Some(l) = self.live.get(&activity) else {
                continue;
            };
            let kind = &self.kinds[&l.kind];
            if kind.beat {
                continue;
            }
            // 0.135 G3: the moves begin once every member has taken its place.
            if self.placing.get(&activity).is_some_and(|p| !p.is_empty()) {
                waiting.push(activity);
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
        self.begun.extend(waiting);
        for activity in self.dancing() {
            // 0.135 G3: a dance's first beat is set once every member has taken its place; one who joins later
            // starts on the next beat after it has.
            let placing = self.placing.get(&activity).cloned().unwrap_or_default();
            if !placing.is_empty() && !self.beats.contains_key(&activity) {
                continue;
            }
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
                        && !placing.contains(&m.body)
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

    /// Marks every member of `activity` (or only `only`) whose role says where it stands as still to take its place
    /// (0.135 G3).
    pub(crate) fn mark_places(&mut self, activity: Id, only: Option<Id>) {
        let Some(l) = self.live.get(&activity) else {
            return;
        };
        let kind = &self.kinds[&l.kind];
        let bodies: BTreeSet<Id> = l
            .node
            .members
            .iter()
            .filter(|m| only.is_none_or(|b| b == m.body))
            .filter(|m| kind.role(&m.role).is_some_and(|r| !r.stands.is_empty()))
            .map(|m| m.body)
            .collect();
        if !bodies.is_empty() {
            self.placing.entry(activity).or_default().extend(bodies);
        }
    }

    /// The places still to take (0.135 G3): `(activity, body, Soul, node, point, facing)`, the point in the axes of
    /// the node its members stand on. `at` is where a body stands: its node and its position there
    /// (`sim::index::place_of`). An activity's frame is set once, from where its members stand, and only when they
    /// all stand on one node; otherwise, or when the frame cannot be set, every member keeps where it stands and is
    /// taken as placed, as is a member on another node than the frame's, farther from its middle than its role's
    /// `within`, or with no stand left in its role. A member
    /// keeps the stand it is given; one given a stand later takes the first of its role no other member holds.
    pub fn pending_places(
        &mut self,
        at: impl Fn(Id) -> Option<(Id, Vec3)>,
    ) -> Vec<(Id, Id, Id, Id, Vec3, Quat)> {
        let live = &self.live;
        self.placing.retain(|a, _| live.contains_key(a));
        let mut out = Vec::new();
        let mut none = Vec::new();
        for (activity, bodies) in &self.placing {
            if bodies.is_empty() {
                continue;
            }
            let Some(l) = self.live.get(activity) else {
                continue;
            };
            let kind = &self.kinds[&l.kind];
            // Each member's stand: the one it holds, else the first of its role no other member holds.
            let held = self.stands.entry(*activity).or_default();
            let mut stands = Vec::new();
            for m in &l.node.members {
                let role = kind.role(&m.role).map_or(&[][..], |r| r.stands.as_slice());
                let k = match held.get(&m.body) {
                    Some(k) => Some(*k),
                    None if bodies.contains(&m.body) => {
                        let taken: BTreeSet<usize> = l
                            .node
                            .members
                            .iter()
                            .filter(|o| o.role == m.role)
                            .filter_map(|o| held.get(&o.body).copied())
                            .collect();
                        let k = (0..role.len()).find(|k| !taken.contains(k));
                        if let Some(k) = k {
                            held.insert(m.body, k);
                        }
                        k
                    }
                    None => None,
                };
                stands.push((m.clone(), k.and_then(|k| role.get(k).copied())));
            }
            let frame = *self.frames.entry(*activity).or_insert_with(|| {
                let pos: Option<Vec<(Id, Vec3)>> =
                    l.node.members.iter().map(|m| at(m.body)).collect();
                let pos = pos?;
                let node = pos.first()?.0;
                if pos.iter().any(|p| p.0 != node) {
                    return None;
                }
                let first = stands
                    .iter()
                    .find_map(|(_, s)| s.map(|s| s.0))
                    .unwrap_or(Vec3::ZERO);
                let pts: Vec<Vec3> = pos.iter().map(|p| p.1).collect();
                places::Frame::of(&pts, first).ok().map(|f| (node, f))
            });
            for (m, s) in stands {
                if !bodies.contains(&m.body) {
                    continue;
                }
                // On the frame's node, and near enough its middle where the role says how near (never walked from
                // far away).
                let within = kind.role(&m.role).and_then(|r| r.within);
                let place = frame.filter(|(node, f)| {
                    at(m.body).is_some_and(|(n, p)| {
                        let (dx, dz) = (i128::from(p.x - f.origin.x), i128::from(p.z - f.origin.z));
                        n == *node
                            && within.is_none_or(|w| dx * dx + dz * dz <= i128::from(w).pow(2))
                    })
                });
                match place
                    .zip(s)
                    .map(|((node, f), (p, yaw))| (node, f.place(p, yaw)))
                {
                    Some((node, Ok((p, q)))) => out.push((*activity, m.body, m.soul, node, p, q)),
                    _ => none.push((*activity, m.body)),
                }
            }
        }
        for (a, b) in none {
            self.placed(a, b);
            self.unplaced.push((a, b));
        }
        out
    }

    /// `body` has taken its place in `activity` (0.135 G3).
    pub fn placed(&mut self, activity: Id, body: Id) {
        if let Some(p) = self.placing.get_mut(&activity) {
            p.remove(&body);
        }
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
        // 0.135 G2: a follow is over for both when either leaves, as a hold is.
        let holds = self.live.get(&activity).is_some_and(|l| {
            l.node.members.iter().any(|m| m.body == body)
                && (self.kinds[&l.kind].follows.is_some()
                    || l.moves.values().any(|n| held(moves, *n)))
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
        // B10: the role's link on the activity's thing goes with the membership.
        let bound: Vec<Bound> = self
            .role_unlink(tree, activity, &member)
            .into_iter()
            .collect();
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
        self.write_with(
            tree,
            activity,
            audience,
            ask,
            "souls:activity-left",
            changes,
            bound,
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
        if let Some(p) = self.placing.get_mut(&activity) {
            p.remove(&body);
        }
        if let Some(s) = self.stands.get_mut(&activity) {
            s.remove(&body);
        }
        if self.leaders.get(&activity) == Some(&body) || !self.live.contains_key(&activity) {
            self.leaders.remove(&activity);
        }
        if !self.live.contains_key(&activity) {
            self.placing.remove(&activity);
            self.frames.remove(&activity);
            self.stands.remove(&activity);
        }
        if self.holding.get(&body) == Some(&activity) {
            self.holding.remove(&body);
        }
        if self.talking.get(&body) == Some(&activity) {
            self.talking.remove(&body);
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
        let kind = &self.kinds[&l.kind];
        // 0.135 G2: the follower's own walk ends the follow; the leader's walks are what it follows.
        let follower = kind.follows.as_ref().is_some_and(|f| {
            l.node
                .members
                .iter()
                .any(|m| m.body == body && m.role == *f)
        });
        (kind.beat || follower || l.moves.values().any(|n| held(moves, *n))).then_some(a)
    }

    /// Whether a walk `body` sends leads the hold it is in (0.135 R1, walking hand in hand): a hold of two whose
    /// leader is none yet (then `body` leads it from now on) or `body`. The other member's walk still lets go.
    pub fn lead(&mut self, moves: &Moves, body: Id) -> bool {
        let Some(&a) = self.holding.get(&body) else {
            return false;
        };
        let Some(l) = self.live.get(&a) else {
            return false;
        };
        let kind = &self.kinds[&l.kind];
        let hold = !kind.beat
            && kind.follows.is_none()
            && l.node.members.len() == 2
            && l.moves.values().any(|n| held(moves, *n));
        if !hold || self.leaders.get(&a).is_some_and(|b| *b != body) {
            return false;
        }
        self.leaders.insert(a, body);
        true
    }

    /// Every follow running (0.135 G2): its activity, the leader's body, the follower's body and Soul, and for a
    /// hold walking hand in hand (R1) the width of the follower's place beside the leader, µm: the distance between
    /// the kind's first two stands, or half a metre.
    pub fn following(&self) -> Vec<(Id, Id, Id, Id, Option<i64>)> {
        self.live
            .iter()
            .filter(|(_, l)| l.node.state == State::Started)
            .filter_map(|(a, l)| {
                let kind = &self.kinds[&l.kind];
                if let Some(lead) = self.leaders.get(a) {
                    let leader = l.node.members.iter().find(|m| m.body == *lead)?;
                    let follower = l.node.members.iter().find(|m| m.body != *lead)?;
                    let at = |m: &Member| {
                        kind.role(&m.role)
                            .and_then(|r| r.stands.first())
                            .map(|s| s.0)
                    };
                    let width = match (at(leader), at(follower)) {
                        (Some(p), Some(q)) => {
                            let (dx, dz) = (i128::from(q.x - p.x), i128::from(q.z - p.z));
                            i64::try_from((dx * dx + dz * dz).isqrt()).unwrap_or(HAND_IN_HAND)
                        }
                        _ => HAND_IN_HAND,
                    };
                    let width = if width > 0 { width } else { HAND_IN_HAND };
                    return Some((*a, leader.body, follower.body, follower.soul, Some(width)));
                }
                let f = kind.follows.as_ref()?;
                let follower = l.node.members.iter().find(|m| m.role == *f)?;
                let leader = l.node.members.iter().find(|m| m.role != *f)?;
                Some((*a, leader.body, follower.body, follower.soul, None))
            })
            .collect()
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
                let shape = shape_of(kind, kind.role(&m.role).expect("a member's role"), l.bound);
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
        // A move at the actor's own body touches nobody (0.134 T3: a dance on the beat). The activity both are in: the
        // one besides a conversation, else the conversation they share.
        let shared = |m: &BTreeMap<Id, Id>| {
            m.get(&actor)
                .filter(|a| actor == target || m.get(&target) == Some(*a))
                .copied()
        };
        let Some(activity) = shared(&self.holding).or_else(|| shared(&self.talking)) else {
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
        let shape = shape_of(kind, kind.role(&m.role).expect("a member's role"), l.bound);
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
            let under = parent(tree, *id).unwrap_or(*id);
            let bound = a.binds(tree, &n.kind, under);
            if node.state == State::Started {
                let kind = &a.kinds[&n.kind];
                // 0.135 R1: an activity whose roles' moves did not come back is over (a touch, a hold, and any kind
                // the engine plays as one); the first tick ends it.
                if !kind.beat && kind.roles.iter().any(|r| r.mv.is_some()) {
                    a.ending.insert(*id);
                }
                for m in &node.members {
                    let role = kind.role(&m.role).ok_or_else(|| Refusal {
                        name: "role-unknown",
                        detail: m.role.as_str().to_owned(),
                    })?;
                    let shape = shape_of(kind, role, bound);
                    match c.claim(m.body, &shape) {
                        Ok(d) => {
                            drivers.insert(m.body, d);
                            // Fields apart (`kind` borrows the kinds): as [`Activities::hold`].
                            if talk(&n.kind) {
                                a.talking.insert(m.body, *id);
                            } else {
                                a.holding.insert(m.body, *id);
                            }
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
                    bound,
                    under,
                },
            );
        }
        Ok(a)
    }
}

#[cfg(test)]
mod tests;
