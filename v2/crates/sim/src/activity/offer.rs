//! Offers (Engine v2 E8, #2779): "do this with me" as B5's proposal with an audience and an expiry. Bodies touch only
//! inside an activity both joined; an offer is how the other one is asked.
//!
//! - **An offer is one effect, however many it asks.** It writes the activity's node, proposed, with the asker already
//!   in its role, and the event `souls:offer` listing the bodies asked (`replica::activity::OFFER`), resolved when it
//!   is written (T8): one Soul, several, or everyone in a room at that instant ([`present`]); one who comes in later
//!   was not asked. The view tier addresses it to each body asked (R4). The kind has two roles; the offer expires after
//!   the kind's `proposal_lasts`.
//! - **Accepting is joining**, an ordinary intent of the Soul asked ([`Activities::accept`]). Each acceptor makes a
//!   pair with the asker, with its own expiry: the first one joins the offer's own node, each later one a new node.
//!   Pairs are held in order of arrival; the one at the front starts when both its bodies are free: at once, or when
//!   the pair before it is left.
//! - **A kind that takes more than two** (`most`, 0.134 T3: a dance offered to several): the first accept makes the
//!   pair as above, and each later one joins that same activity, taking its role's claims at once if it has started.
//!   A kind of three roles that takes more than three (0.135 C5, a crew's carry) has a role several take ([`several`]).
//! - **Declining is an intent** ([`Activities::decline`]) and **a lapse is a timer** ([`Activities::lapse`]). Each
//!   reaches the asker as a named outcome, `souls:offer-declined` or `souls:offer-lapsed`. An offer that every body
//!   asked declined, or that nobody accepted in time, ends: its node goes. A pair that waited past its own expiry lapses
//!   the same way and goes.
//! - **Standing consent is not here.** A Soul that accepts some offers with no model turn does so by a reflex rule in
//!   its own client (R9, `v2/client/src/reflex/consent.mjs`), which sends the same accept. With that client stopped
//!   nothing answers, and the offer lapses. The engine holds no setting that fires when an offer arrives (TRUNK T10).
//!
//! - **A give** (0.133 R4, the smallest part of E24 #2793) is an offer that names a thing the asker holds: accepting
//!   it moves that thing from the asker's hand to a free hand of the one who accepts (T1's leave and arrive, one part),
//!   then ends the offer with [`GIVEN`]. A give makes no activity node: its offer is the `souls:offer` event alone
//!   (field 6 the thing), so nothing but the event and the thing's move reaches the world's stream. At the accept the world checks again: the asker still holds it
//!   (`give.not-held`), the two stand on the same floor within [`GIVE_REACH`] (`give.too-far`), and the one who accepts
//!   has a free hand, two for a two-handed thing (`give.no-free-hand`). A refused accept leaves the offer open: free a
//!   hand or come closer, and accept again. A decline or a lapse is any offer's.
//!
//! Not here: lasting groups, a gesture at someone who did not join (E11), swapping and lending (E24's rest), the
//! gateway's verbs for an accept and a decline (I7), charging an offer per body asked (I8), open offers across a
//! restart.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use replica::activity::{
    ActivityKind, F_EXPIRES, F_MEMBERS, MEMBER, Member, Node, OFFER, OFFER_DECLINED, OFFER_LAPSED,
    State,
};
use replica::effects::{Actor, Cause, Change, Refusal};
use replica::encode::{Name, Value};
use replica::ids::{Id, Minter};
use replica::pose::Frame;
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::{Audience, End, show};

use super::{Activities, Ask, Bound, Live, R, create, minted, name, refuse};
use crate::controller::Controller;
use crate::slots::hands::{free_hands, hands, occupies, transfer};
use crate::timers::{DueList, Timer};

/// The role several take in a kind of three roles that takes more members than that (0.135 C5: a crew's carry, its
/// sides): its third. It is offered in one of the other two; each accept after the first takes it, and the activity
/// starts without it.
pub(super) fn several(k: &ActivityKind) -> Option<&Name> {
    (k.roles.len() == 3 && k.most > 3).then(|| &k.roles[2].name)
}

/// The event of a give accepted: `{1: offer, 2: the thing, 3: the giver's body, 4: the taker's body}`.
pub const GIVEN: &str = "souls:given";
/// How far apart, µm, two bodies may stand on one floor for a give: an arm's length each.
pub const GIVE_REACH: i64 = 1_500_000;

/// The due list's name for an offer's expiry.
const OFFER_TIMER: &str = "souls:offer-lapse";
/// The due list's name for an accepted pair's own expiry.
const PAIR_TIMER: &str = "souls:offer-pair-lapse";

fn at(m: Micros) -> Value {
    Value::Uint(u64::try_from(m).unwrap_or(0))
}

fn ids<'a>(xs: impl IntoIterator<Item = &'a Id>) -> Value {
    Value::Array(xs.into_iter().map(|x| x.to_value()).collect())
}

/// An offer still open to answers.
#[derive(Clone)]
pub(super) struct Open {
    kind: Name,
    /// The asker's body and Soul, and the intent that made the offer.
    asker: Id,
    asker_soul: Id,
    intent: Id,
    /// The asker's role and the one an acceptor takes.
    role: Name,
    other: Name,
    place: Id,
    audience: Audience,
    /// The offer's effect: the cause of its lapse.
    sequence: u64,
    asked: BTreeSet<Id>,
    answered: BTreeSet<Id>,
    expires: Micros,
    timer: Id,
    /// Whether the offer's own node has its pair.
    taken: bool,
    /// The thing a give hands over: held by the asker when offered.
    given: Option<Id>,
}

/// A pair accepted and not yet started.
pub(super) struct Pair {
    offer: Id,
    asker: Id,
    body: Id,
    soul: Id,
    intent: Id,
    expires: Micros,
    timer: Id,
    sequence: u64,
}

/// Every open offer and waiting pair of a zone.
#[derive(Default)]
pub(super) struct Offers {
    pub(super) open: BTreeMap<Id, Open>,
    /// Pairs accepted and not started, by their activity.
    pub(super) pairs: BTreeMap<Id, Pair>,
    /// Each asker's waiting pairs, in order of arrival.
    pub(super) queues: BTreeMap<Id, VecDeque<Id>>,
    /// What each timer is for: an offer or a pair, by its activity.
    pub(super) timers: BTreeMap<Id, Id>,
}

/// The bodies in `room` at this instant: its children that the controller drives. An offer to a room asks these.
pub fn present(tree: &Tree, c: &Controller, room: Id) -> BTreeSet<Id> {
    let Some(children) = tree.handle(room).and_then(|h| tree.children(h)) else {
        return BTreeSet::new();
    };
    children
        .iter()
        .filter_map(|h| tree.node(*h).map(|n| n.id()))
        .filter(|id| c.claims(*id).is_some())
        .collect()
}

impl Activities {
    /// `ask.soul` offers an activity of `kind` with `body` in `role`, under `place`, to the bodies `asked` (resolved by
    /// the caller as they are now: one, several, or [`present`] in a room). One effect: the node with the asker in its
    /// role, its membership link and `souls:offer`; its lapse is set for the kind's `proposal_lasts`.
    /// `activity-kind-unknown`, `offer-kind-not-a-pair`, `role-unknown`, `offer-to-nobody`, `place-missing`.
    #[allow(clippy::too_many_arguments)]
    pub fn offer(
        &mut self,
        tree: &mut Tree,
        mint: &mut Minter,
        due: &mut DueList,
        ask: Ask,
        body: Id,
        kind: &Name,
        role: &Name,
        place: Id,
        mut asked: BTreeSet<Id>,
        given: Option<Id>,
    ) -> R<Id> {
        if let Some(thing) = given
            && holder(tree, thing) != Some(body)
        {
            return refuse(
                "give.not-held",
                format!("{} holds no {}", show(body), show(thing)),
            );
        }
        let Some(k) = self.kinds.get(kind) else {
            return refuse("activity-kind-unknown", kind.as_str());
        };
        if (k.roles.len() != 2 && several(k).is_none()) || several(k) == Some(role) {
            return refuse("offer-kind-not-a-pair", kind.as_str());
        }
        if k.role(role).is_none() {
            return refuse("role-unknown", role.as_str());
        }
        let other = k
            .roles
            .iter()
            .find(|r| r.name != *role && Some(&r.name) != several(k))
            .map(|r| r.name.clone())
            .unwrap_or_else(|| unreachable!("two roles"));
        asked.remove(&body);
        if asked.is_empty() {
            return refuse("offer-to-nobody", show(body));
        }
        // B10: only a body is asked (a node of a kind of the `family` owner, as a Soul's body is).
        if let Some(not) = asked.iter().find(|b| {
            tree.handle(**b)
                .and_then(|h| tree.node(h))
                .and_then(|n| self.rules.kinds.get(n.kind().as_str()))
                .is_none_or(|k| k.owner != "family")
        }) {
            return refuse("offer-asked-not-a-body", show(*not));
        }
        let audience = tree
            .handle(place)
            .and_then(|h| tree.node(h))
            .map(|n| n.audience())
            .ok_or_else(|| Refusal {
                name: "place-missing",
                detail: show(place),
            })?;
        let expires = ask.at.saturating_add(k.proposal_lasts);
        let revision = k.revision;
        let (id, link, timer) = (minted(mint)?, minted(mint)?, minted(mint)?);
        let node = Node {
            revision,
            state: State::Proposed,
            expires,
            members: vec![Member {
                role: role.clone(),
                body,
                soul: ask.soul,
                link,
                intent: ask.intent,
            }],
        };
        // A give makes no activity node: the offer is its event, and the accept moves the thing (see the notes).
        let changes = match given {
            Some(_) => Vec::new(),
            None => vec![
                create(id, kind, place, audience, &node),
                Change::Link {
                    link,
                    ty: name(MEMBER),
                    ends: [body, id],
                    owner: End::Second,
                    audience,
                },
            ],
        };
        let mut fields = BTreeMap::from([
            (1, id.to_value()),
            (2, Value::Text(kind.clone())),
            (3, ids(&asked)),
            (4, at(expires)),
            (5, body.to_value()),
        ]);
        if let Some(thing) = given {
            fields.insert(6, thing.to_value());
        }
        // B10: the asker's role link on the activity's thing, when it is offered at one.
        let bound: Vec<Bound> = match given {
            Some(_) => Vec::new(),
            None => self
                .role_link(tree, mint, kind, place, &node.members[0])?
                .into_iter()
                .collect(),
        };
        let sequence = self.next;
        let by = (ask.at, Actor::Soul(ask.soul), Cause::Intent(ask.intent));
        self.emit_with(tree, place, audience, by, OFFER, fields, changes, bound)?;
        if given.is_none() {
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
        }
        due.set(Timer {
            node: body,
            id: timer,
            due: expires,
            name: name(OFFER_TIMER),
        })?;
        self.offers.timers.insert(timer, id);
        self.offers.open.insert(
            id,
            Open {
                kind: kind.clone(),
                asker: body,
                asker_soul: ask.soul,
                intent: ask.intent,
                role: role.clone(),
                other,
                place,
                audience,
                sequence,
                asked,
                answered: BTreeSet::new(),
                expires,
                timer,
                taken: false,
                given,
            },
        );
        Ok(id)
    }

    /// The kind and the asking body of `offer` while it is open (0.134 T1: the engine checks a touch's reach before
    /// an accept starts it).
    pub fn offered(&self, offer: Id) -> Option<(&ActivityKind, Id)> {
        let o = self.offers.open.get(&offer)?;
        Some((self.kinds.get(&o.kind)?, o.asker))
    }

    /// The asker's role in `offer` and the one an acceptor takes, while it is open: a pair's members in order.
    pub fn offered_roles(&self, offer: Id) -> Option<[&Name; 2]> {
        let o = self.offers.open.get(&offer)?;
        Some([&o.role, &o.other])
    }

    fn answerable(&self, offer: Id, body: Id, now: Micros) -> R<Open> {
        let Some(o) = self.offers.open.get(&offer) else {
            return refuse("offer-missing", show(offer));
        };
        if !o.asked.contains(&body) {
            return refuse("not-asked", show(body));
        }
        if o.answered.contains(&body) {
            return refuse("offer-answered", show(body));
        }
        if now >= o.expires {
            return refuse("offer-expired", show(offer));
        }
        if o.given.is_none() && !o.taken && !self.live.contains_key(&offer) {
            return refuse("offer-withdrawn", show(offer));
        }
        Ok(o.clone())
    }

    /// `ask.soul`, asked with `body`, accepts `offer` in time: its pair with the asker, the offer's own node for the
    /// first to accept and a new one for each after, expiring after the kind's `proposal_lasts`. The pair waits its
    /// turn behind the asker's earlier pairs and starts when both bodies are free, perhaps now. Returns the pair's
    /// activity. `offer-missing`, `not-asked`, `offer-answered`, `offer-expired`, `offer-withdrawn`.
    #[allow(clippy::too_many_arguments)]
    pub fn accept(
        &mut self,
        tree: &mut Tree,
        mint: &mut Minter,
        c: &mut Controller,
        due: &mut DueList,
        ask: Ask,
        body: Id,
        offer: Id,
    ) -> R<Id> {
        let o = self.answerable(offer, body, ask.at)?;
        if let Some(thing) = o.given {
            return self.give(tree, mint, c, due, ask, body, offer, &o, thing);
        }
        let k = &self.kinds[&o.kind];
        if o.taken && k.most > 2 {
            return self.join_offer(tree, mint, c, ask, body, offer, &o);
        }
        let expires = ask.at.saturating_add(k.proposal_lasts);
        let revision = k.revision;
        let first = !o.taken;
        let link = minted(mint)?;
        let me = Member {
            role: o.other.clone(),
            body,
            soul: ask.soul,
            link,
            intent: ask.intent,
        };
        let joins = |pair: Id| Change::Link {
            link,
            ty: name(MEMBER),
            ends: [body, pair],
            owner: End::Second,
            audience: o.audience,
        };
        let (pair, node, changes) = if first {
            let mut node = self.live[&offer].node.clone();
            node.members.push(me);
            node.expires = expires;
            let changes = vec![
                joins(offer),
                Change::Set {
                    node: offer,
                    field: F_MEMBERS,
                    to: node.members_value(),
                    by: None,
                },
                Change::Set {
                    node: offer,
                    field: F_EXPIRES,
                    to: at(expires),
                    by: None,
                },
            ];
            (offer, node, changes)
        } else {
            let (pair, asker_link) = (minted(mint)?, minted(mint)?);
            let node = Node {
                revision,
                state: State::Proposed,
                expires,
                members: vec![
                    Member {
                        role: o.role.clone(),
                        body: o.asker,
                        soul: o.asker_soul,
                        link: asker_link,
                        intent: o.intent,
                    },
                    me,
                ],
            };
            let changes = vec![
                create(pair, &o.kind, o.place, o.audience, &node),
                Change::Link {
                    link: asker_link,
                    ty: name(MEMBER),
                    ends: [o.asker, pair],
                    owner: End::Second,
                    audience: o.audience,
                },
                joins(pair),
            ];
            (pair, node, changes)
        };
        // B10: the role links of the pair's members on the activity's thing (the asker's is there already).
        let mut bound: Vec<Bound> = Vec::new();
        for m in &node.members {
            bound.extend(self.role_link(tree, mint, &o.kind, o.place, m)?);
        }
        let fields = BTreeMap::from([(1, offer.to_value())]);
        let sequence = self.next;
        let by = (ask.at, Actor::Soul(ask.soul), Cause::Intent(ask.intent));
        self.emit_with(
            tree,
            if first { offer } else { o.place },
            o.audience,
            by,
            "souls:activity-joined",
            fields,
            changes,
            bound,
        )?;
        let bound = self.binds(tree, &o.kind, o.place);
        self.live
            .entry(pair)
            .and_modify(|l| l.node = node.clone())
            .or_insert_with(|| Live {
                kind: o.kind.clone(),
                audience: o.audience,
                node,
                drivers: BTreeMap::new(),
                moves: BTreeMap::new(),
                bound,
                under: o.place,
            });
        if let Some(open) = self.offers.open.get_mut(&offer) {
            open.answered.insert(body);
            open.taken = true;
        }
        let timer = minted(mint)?;
        due.set(Timer {
            node: body,
            id: timer,
            due: expires,
            name: name(PAIR_TIMER),
        })?;
        self.offers.timers.insert(timer, pair);
        self.offers.pairs.insert(
            pair,
            Pair {
                offer,
                asker: o.asker,
                body,
                soul: ask.soul,
                intent: ask.intent,
                expires,
                timer,
                sequence,
            },
        );
        self.offers
            .queues
            .entry(o.asker)
            .or_default()
            .push_back(pair);
        self.advance(tree, c, due, body, ask.at);
        Ok(pair)
    }

    /// A later accept of an offer whose kind takes more than two (0.134 T3: a dance, offered to several): `body`
    /// joins the offer's own activity in the other role, its role's claims taken now if it has started (else at its
    /// start, with every member's). Returns the activity. `activity-full`, `already-member`, `body-in-activity`, T9's
    /// refusals by name.
    #[allow(clippy::too_many_arguments)]
    fn join_offer(
        &mut self,
        tree: &mut Tree,
        mint: &mut Minter,
        c: &mut Controller,
        ask: Ask,
        body: Id,
        offer: Id,
        o: &Open,
    ) -> R<Id> {
        let k = &self.kinds[&o.kind];
        let Some(l) = self.live.get(&offer) else {
            return refuse("offer-withdrawn", show(offer));
        };
        if l.node.members.len() >= k.most {
            return refuse(
                "activity-full",
                format!("{}: {} members", show(offer), k.most),
            );
        }
        if l.node.members.iter().any(|m| m.body == body) {
            return refuse("already-member", show(body));
        }
        let link = minted(mint)?;
        // C5: the third and later joiners of a crew take its several role; others the offer's other role.
        let role = several(k).unwrap_or(&o.other).clone();
        let me = Member {
            role,
            body,
            soul: ask.soul,
            link,
            intent: ask.intent,
        };
        // B10: its role link on the activity's thing, refused (`role-taken`) before anything is claimed.
        let bound: Vec<Bound> = self
            .role_link(tree, mint, &o.kind, o.place, &me)?
            .into_iter()
            .collect();
        let driver = match l.node.state {
            State::Started => {
                if let Some(other) = self.holding.get(&body) {
                    return refuse(
                        "body-in-activity",
                        format!("{} is held by {}", show(body), show(*other)),
                    );
                }
                let role = k.role(&me.role).expect("the joiner's role");
                Some(c.claim(body, &super::shape_of(k, role, l.bound))?)
            }
            State::Proposed => None,
        };
        let mut node = l.node.clone();
        node.members.push(me);
        let changes = vec![
            Change::Link {
                link,
                ty: name(MEMBER),
                ends: [body, offer],
                owner: End::Second,
                audience: o.audience,
            },
            Change::Set {
                node: offer,
                field: F_MEMBERS,
                to: node.members_value(),
                by: None,
            },
        ];
        let fields = BTreeMap::from([(1, offer.to_value())]);
        let by = (ask.at, Actor::Soul(ask.soul), Cause::Intent(ask.intent));
        if let Err(r) = self.emit_with(
            tree,
            offer,
            o.audience,
            by,
            "souls:activity-joined",
            fields,
            changes,
            bound,
        ) {
            if let Some(d) = driver {
                let _ = c.release(body, d);
            }
            return Err(r);
        }
        if let Some(l) = self.live.get_mut(&offer) {
            l.node = node;
            if let Some(d) = driver {
                l.drivers.insert(body, d);
                self.holding.insert(body, offer);
            }
        }
        // 0.135 G3: one who joins a started activity takes its place too.
        if driver.is_some() {
            self.mark_places(offer, Some(body));
        }
        if let Some(open) = self.offers.open.get_mut(&offer) {
            open.answered.insert(body);
        }
        Ok(offer)
    }

    /// A give's accept (see the module's notes): the thing from the asker's hand to a free hand of `body`, then the
    /// offer's node ended with [`GIVEN`]. Returns the offer. `give.not-held`, `give.too-far`, `give.no-free-hand`.
    #[allow(clippy::too_many_arguments)]
    fn give(
        &mut self,
        tree: &mut Tree,
        mint: &mut Minter,
        c: &Controller,
        due: &mut DueList,
        ask: Ask,
        body: Id,
        offer: Id,
        o: &Open,
        thing: Id,
    ) -> R<Id> {
        if holder(tree, thing) != Some(o.asker) {
            return refuse(
                "give.not-held",
                format!("{} no longer holds {}", show(o.asker), show(thing)),
            );
        }
        let near = match (standing(tree, o.asker), standing(tree, body)) {
            (Some((fa, pa)), Some((fb, pb))) => {
                let (dx, dz) = (pa.x - pb.x, pa.z - pb.z);
                fa == fb
                    && dx.saturating_mul(dx).saturating_add(dz.saturating_mul(dz))
                        <= GIVE_REACH * GIVE_REACH
            }
            _ => false,
        };
        if !near {
            return refuse(
                "give.too-far",
                format!(
                    "{} and {} are not within {} m on one floor",
                    show(o.asker),
                    show(body),
                    GIVE_REACH / 1_000_000
                ),
            );
        }
        let all = c
            .claims(body)
            .map(|b| hands(b.family()))
            .unwrap_or_default();
        let free = free_hands(tree, &self.rules, body, &all);
        let (kind, audience) = tree
            .handle(thing)
            .and_then(|h| tree.node(h))
            .map(|n| (n.kind().as_str().to_owned(), n.audience()))
            .ok_or_else(|| Refusal {
                name: "give.not-held",
                detail: format!("{} is gone", show(thing)),
            })?;
        let needs = usize::from(occupies(&self.rules, &kind).unwrap_or(1).max(1));
        let Some(hand) = free.first().filter(|_| free.len() >= needs) else {
            return refuse(
                "give.no-free-hand",
                format!("{} has no free hand", show(body)),
            );
        };
        let to = Frame {
            node: body,
            slot: Some(hand.slot),
        };
        let moved = transfer(&self.header, thing, audience, to, minted(mint)?);
        let fields = BTreeMap::from([
            (1, offer.to_value()),
            (2, thing.to_value()),
            (3, o.asker.to_value()),
            (4, body.to_value()),
        ]);
        let changes = self.withdraw(offer);
        let by = (ask.at, Actor::Soul(ask.soul), Cause::Intent(ask.intent));
        let node = if self.live.contains_key(&offer) {
            offer
        } else {
            o.place
        };
        // The thing first, as a hand's take is written (its own part: the public stream reads a transfer that way),
        // then the offer's end with the event, as a decline ends it. Every check is made before either is written.
        self.emit_part(tree, by, moved.to_vec())?;
        self.emit(tree, node, o.audience, by, GIVEN, fields, changes)?;
        self.live.remove(&offer);
        self.offers.open.remove(&offer);
        self.offers.timers.remove(&o.timer);
        due.cancel((o.expires, o.timer));
        Ok(offer)
    }

    /// `ask.soul`, asked with `body`, declines `offer`: `souls:offer-declined`, addressed to the asker. When every body
    /// asked has answered and none accepted, the offer ends in the same effect. Refused as [`Activities::accept`].
    pub fn decline(
        &mut self,
        tree: &mut Tree,
        due: &mut DueList,
        ask: Ask,
        body: Id,
        offer: Id,
    ) -> R<()> {
        let o = self.answerable(offer, body, ask.at)?;
        let ended = !o.taken && o.answered.len() + 1 == o.asked.len();
        let (changes, bound) = match ended {
            true => (self.withdraw(offer), self.role_unlinks(tree, offer)),
            false => (Vec::new(), Vec::new()),
        };
        let fields = BTreeMap::from([
            (1, offer.to_value()),
            (2, o.asker.to_value()),
            (3, ids([&body])),
        ]);
        let node = if self.live.contains_key(&offer) {
            offer
        } else {
            o.place
        };
        let by = (ask.at, Actor::Soul(ask.soul), Cause::Intent(ask.intent));
        self.emit_with(
            tree,
            node,
            o.audience,
            by,
            OFFER_DECLINED,
            fields,
            changes,
            bound,
        )?;
        if ended {
            self.live.remove(&offer);
            self.offers.open.remove(&offer);
            self.offers.timers.remove(&o.timer);
            due.cancel((o.expires, o.timer));
        } else if let Some(open) = self.offers.open.get_mut(&offer) {
            open.answered.insert(body);
        }
        Ok(())
    }

    /// The changes that end an offer's node while only its asker is in it.
    fn withdraw(&self, offer: Id) -> Vec<Change> {
        let Some(l) = self.live.get(&offer) else {
            return Vec::new();
        };
        let mut out: Vec<Change> = l
            .node
            .members
            .iter()
            .map(|m| Change::Unlink { link: m.link })
            .collect();
        out.push(Change::Remove { node: offer });
        out
    }

    /// Runs a timer the due list handed back: `None` when it is not an offer's or a waiting pair's. An offer's lapse
    /// writes `souls:offer-lapsed` naming the bodies that did not answer, addressed to the asker, and ends the offer's
    /// node if nobody accepted. A pair's lapse, when it has not started, ends its node the same way, and the asker's
    /// next pair may start.
    pub fn lapse(
        &mut self,
        tree: &mut Tree,
        c: &mut Controller,
        due: &mut DueList,
        t: &Timer,
    ) -> Option<R<()>> {
        let pair = match t.name.as_str() {
            OFFER_TIMER => false,
            PAIR_TIMER => true,
            _ => return None,
        };
        let target = self.offers.timers.remove(&t.id)?;
        Some(if pair {
            self.lapse_pair(tree, c, due, target, t.due)
        } else {
            self.lapse_offer(tree, target, t.due)
        })
    }

    fn lapse_offer(&mut self, tree: &mut Tree, offer: Id, now: Micros) -> R<()> {
        let Some(o) = self.offers.open.remove(&offer) else {
            return Ok(());
        };
        let unanswered: Vec<&Id> = o.asked.difference(&o.answered).collect();
        let ended = !o.taken && self.live.contains_key(&offer);
        let (changes, bound) = match ended {
            true => (self.withdraw(offer), self.role_unlinks(tree, offer)),
            false => (Vec::new(), Vec::new()),
        };
        if unanswered.is_empty() && changes.is_empty() {
            return Ok(());
        }
        let fields = BTreeMap::from([
            (1, offer.to_value()),
            (2, o.asker.to_value()),
            (3, ids(unanswered)),
        ]);
        let node = if self.live.contains_key(&offer) {
            offer
        } else {
            o.place
        };
        let by = (now, Actor::World, Cause::Effect(o.sequence));
        self.emit_with(
            tree,
            node,
            o.audience,
            by,
            OFFER_LAPSED,
            fields,
            changes,
            bound,
        )?;
        if ended {
            self.live.remove(&offer);
        }
        Ok(())
    }

    fn lapse_pair(
        &mut self,
        tree: &mut Tree,
        c: &mut Controller,
        due: &mut DueList,
        pair: Id,
        now: Micros,
    ) -> R<()> {
        let Some(p) = self.offers.pairs.remove(&pair) else {
            return Ok(());
        };
        if let Some(q) = self.offers.queues.get_mut(&p.asker) {
            q.retain(|x| *x != pair);
        }
        let waiting = self
            .live
            .get(&pair)
            .is_some_and(|l| l.node.state == State::Proposed);
        if waiting {
            let audience = self.live[&pair].audience;
            let fields = BTreeMap::from([
                (1, p.offer.to_value()),
                (2, p.asker.to_value()),
                (3, ids([&p.body])),
                (4, pair.to_value()),
            ]);
            let changes = self.withdraw(pair);
            let bound = self.role_unlinks(tree, pair);
            let by = (now, Actor::World, Cause::Effect(p.sequence));
            self.emit_with(
                tree,
                pair,
                audience,
                by,
                OFFER_LAPSED,
                fields,
                changes,
                bound,
            )?;
            self.live.remove(&pair);
        }
        self.advance(tree, c, due, p.asker, now);
        Ok(())
    }

    /// Starts the waiting pairs that `body` is in, in order of arrival, while their bodies are free. A pair whose start
    /// is refused waits on, until its turn comes again or its own expiry.
    pub(super) fn advance(
        &mut self,
        tree: &mut Tree,
        c: &mut Controller,
        due: &mut DueList,
        body: Id,
        now: Micros,
    ) {
        let mut askers: BTreeSet<Id> = self
            .offers
            .pairs
            .values()
            .filter(|p| p.body == body)
            .map(|p| p.asker)
            .collect();
        askers.insert(body);
        for asker in askers {
            while let Some(pair) = self
                .offers
                .queues
                .get(&asker)
                .and_then(|q| q.front().copied())
            {
                let Some(p) = self.offers.pairs.get(&pair) else {
                    break;
                };
                let ask = Ask {
                    soul: p.soul,
                    intent: p.intent,
                    at: now,
                };
                if self.start(tree, c, ask, pair).is_err() {
                    break;
                }
                if let Some(q) = self.offers.queues.get_mut(&asker) {
                    q.pop_front();
                }
                if let Some(p) = self.offers.pairs.remove(&pair) {
                    self.offers.timers.remove(&p.timer);
                    due.cancel((p.expires, p.timer));
                }
            }
        }
    }
}

/// The body (or node) whose slot `thing` is in: what holds it.
fn holder(tree: &Tree, thing: Id) -> Option<Id> {
    tree.handle(thing)
        .and_then(|h| tree.node(h))
        .filter(|n| n.slot().is_some())
        .and_then(|n| n.parent())
}

/// The floor (its parent) a body stands on, and where on it.
fn standing(tree: &Tree, body: Id) -> Option<(Id, replica::pose::Vec3)> {
    let n = tree.handle(body).and_then(|h| tree.node(h))?;
    Some((n.parent()?, n.place()?.position))
}
