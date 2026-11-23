//! The engine's own acts in a running world (Engine v2 C2, #3366): joint activities (B5) and their offers (E8), and
//! carrying together (B9), each asked by a Soul's intent through the gateway. No code here names a kind.
//!
//! - **Verbs.** An engine act is an act verb in its system's namespace ([`Verb::of`]): `activity:propose`, `:offer`,
//!   `:join`, `:accept`, `:decline`, `:start` and `:leave`, and `carry:lift` and `carry:set-down`. They are not
//!   `souls:` verbs: T10 rule 4 keeps those a closed list of moves, cancels and orders, and an intent with any other
//!   `souls:` verb is refused `order-unknown` before it reaches the world.
//! - **Parameters.** The target is the place (propose, offer), the activity (join, start, leave, lift, set down) or the
//!   offer (accept, decline). Propose: 1 the activity's kind. Offer: 1 the kind, 2 the asker's role, 3 the bodies
//!   asked (ids), 4 for a give the thing the asker holds (0.133 R4: accepting hands it over, `sim::activity::offer`). Join: 1 the role, 2 the revision (default 1). Lift: 1 the thing carried. Its two carriers are the
//!   activity's first two members, the first in front. `carrier:steer`, `carrier:stop` and `carrier:land` steer the
//!   boat the Soul sits in ([`crate::carrier`], #3603): the target the boat, steer's 1 a point `[x, z]` µm (land's 1
//!   optional, a point by its home).
//! - **Written once, as the Soul's.** Each system writes through its own writer onto a copy of the tree; its entries,
//!   caused by the intent and acted by its Soul, are applied to the world with the tick's other entries
//!   ([`Engine::out`]), so the intent's receipt names them. An act is answered at once: a receipt, or its refusal by
//!   name. A carry in progress is sampled each tick between its carriers ([`Engine::tick`]).
//! - **A restart keeps its activities** (E26, #3329): once the bodies are back, [`Engine::restore`] reads them from
//!   their nodes and membership links, so a member speaks in one and leaves it as before. Open offers and carries in
//!   progress are not restored.
//!
//! Not here: activity kinds read from a world's entries (a world is given them, [`crate::answers::Config`]); bodies
//! as nodes of the tree (Eden's Souls are not yet, so a join, a lift or a take there is refused by T2); the view
//! tier addressing an offer to the bodies asked (#3368's follow-up).

use std::collections::{BTreeMap, BTreeSet};

use replica::activity::ActivityKind;
use replica::effects::{Actor, Cause, Effect, Header, Refusal, read_id};
use replica::encode::{Name, Value};
use replica::ids::{Id, Minter, Scope};
use replica::moves::{Effector, Move};
use replica::pose::Vec3;
use replica::time::{Mapping, Micros, Tempo, TickRate, Timeline};
use replica::tree::{Rules, Tree};
use replica::world_model::show;
use sim::activity::carry::Carry;
use sim::activity::{Activities, Ask};
use sim::controller::Controller;
use sim::moves::{Moves, Reach};
use sim::slots::Slots;
use sim::timers::DueList;

type R<T> = Result<T, Refusal>;

fn refusal(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

/// An engine act's verb.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verb {
    Propose,
    Offer,
    Join,
    Accept,
    Decline,
    Start,
    Leave,
    Lift,
    SetDown,
    /// A rider steers or lands the boat it sits in (#3603, [`crate::carrier`]).
    Steer,
    Land,
    Stop,
}

impl Verb {
    /// The engine act a verb names, if it names one.
    pub fn of(verb: &str) -> Option<Verb> {
        Some(match verb {
            "activity:propose" => Verb::Propose,
            "activity:offer" => Verb::Offer,
            "activity:join" => Verb::Join,
            "activity:accept" => Verb::Accept,
            "activity:decline" => Verb::Decline,
            "activity:start" => Verb::Start,
            "activity:leave" => Verb::Leave,
            "carry:lift" => Verb::Lift,
            "carry:set-down" => Verb::SetDown,
            "carrier:steer" => Verb::Steer,
            "carrier:land" => Verb::Land,
            "carrier:stop" => Verb::Stop,
            _ => return None,
        })
    }
}

/// An engine act as the clock thread takes it.
#[derive(Clone, Debug)]
pub struct Act {
    pub id: Id,
    pub soul: Id,
    pub body: Id,
    pub verb: Verb,
    pub target: Option<Id>,
    pub params: BTreeMap<u64, Value>,
}

/// The engine's systems, with their own due list, moves and minter.
pub struct Engine {
    header: Header,
    rules: Rules,
    kinds: Vec<ActivityKind>,
    activities: Activities,
    carries: BTreeMap<Id, Carry>,
    due: DueList,
    moves: Moves,
    mint: Minter,
    /// Entries written and not yet applied.
    out: Vec<Effect>,
    /// The boats steered off their own loops (#3603).
    steered: BTreeSet<Id>,
    /// The moves an activity's roles may name (0.134 T1): content's, [`crate::moves::library`].
    library: Vec<Move>,
    /// The world's clock, whose beats a dance's moves start on (0.134 T3): the world's own ([`Engine::with_beats`]).
    line: Timeline,
}

/// Where bodies stand, read from the controller before a move needs them (0.134 T1): a move one member of an activity
/// aims at another reaches across x and z from feet to feet, on one floor; on two floors it reaches nothing.
struct Feet(BTreeMap<Id, (Id, [i64; 2])>);

impl Feet {
    fn of(c: &Controller, bodies: impl IntoIterator<Item = Id>) -> Feet {
        Feet(
            bodies
                .into_iter()
                .filter_map(|b| c.body(b).map(|m| (b, sim::index::place_of(m))))
                .collect(),
        )
    }
}

impl Reach for Feet {
    fn distance(
        &self,
        body: Id,
        _: &Effector,
        _: Option<&Name>,
        target: Id,
        _: &Name,
    ) -> Option<i64> {
        let ((f, a), (g, b)) = (self.0.get(&body)?, self.0.get(&target)?);
        let (dx, dz) = (i128::from(a[0] - b[0]), i128::from(a[1] - b[1]));
        (f == g).then(|| i64::try_from((dx * dx + dz * dz).isqrt()).unwrap_or(i64::MAX))
    }
}

fn param_id(p: &BTreeMap<u64, Value>, k: u64, what: &'static str) -> R<Id> {
    p.get(&k)
        .and_then(|v| read_id(v).ok())
        .ok_or_else(|| refusal(what, format!("parameter {k}: an id")))
}

fn param_name(p: &BTreeMap<u64, Value>, k: u64, what: &'static str) -> R<Name> {
    match p.get(&k) {
        Some(Value::Text(n)) => Ok(n.clone()),
        _ => Err(refusal(what, format!("parameter {k}: a name"))),
    }
}

/// A pinned activity kind uses a bounded plain name and binary SHA-256 multihash (C30); short names stay names.
fn param_kind(p: &BTreeMap<u64, Value>, k: u64, what: &'static str) -> R<Name> {
    match p.get(&k) {
        Some(Value::Array(pair)) => match pair.as_slice() {
            [Value::Text(plain), Value::Bytes(hash)]
                if !plain.as_str().is_empty()
                    && plain.as_str().len()
                        <= replica::intent_decode::LIMITS.text_bytes as usize
                    && !plain.as_str().contains('@')
                    && hash.len() == 34
                    && hash[..2] == [0x12, 0x20] =>
            {
                Name::new(&format!(
                    "{}@{}",
                    plain.as_str(),
                    replica::encode::to_hex(hash)
                ))
                .ok_or_else(|| refusal(what, "a pinned kind"))
            }
            _ => Err(refusal(what, "a plain name and binary SHA-256 multihash")),
        },
        _ => param_name(p, k, what),
    }
}

/// Where the controller has a body: the node it stands on and its position there.
fn stands(c: &Controller, body: Id) -> R<(Id, Vec3)> {
    c.body(body)
        .map(|m| (sim::index::place_of(m).0, m.pose.position))
        .ok_or_else(|| refusal("body-unknown", show(body)))
}

impl Engine {
    /// The earliest due time of the activities and the boats on their loops (O2: when a sleeping world must be up).
    pub fn next_due(&self) -> Option<Micros> {
        self.due.next_due()
    }

    /// The systems for a zone under `header`, checked by `rules`, with activities of `kinds`, minting ids of `scope`.
    pub fn new(header: Header, rules: Rules, kinds: Vec<ActivityKind>, scope: Scope) -> Engine {
        Engine {
            activities: Activities::new(header.clone(), rules.clone(), 0, kinds.clone()),
            kinds,
            header,
            rules,
            carries: BTreeMap::new(),
            due: DueList::new(),
            moves: Moves::new(),
            mint: Minter::new(scope),
            out: Vec::new(),
            steered: BTreeSet::new(),
            library: crate::moves::library().unwrap_or_else(|r| {
                eprintln!("worldd: no moves for activities: {r}");
                Vec::new()
            }),
            line: Timeline::start(
                Mapping::new(0, 0, 1, 1).expect("rate one"),
                TickRate::new(0, 0, 20).expect("20 a second"),
                Tempo::per_minute(0, 0, 120).expect("120 a minute"),
            )
            .expect("a line from zero"),
        }
    }

    /// The engine on the world's own clock `line`, whose beats a dance's moves start on (0.134 T3).
    pub fn with_beats(mut self, line: Timeline) -> Engine {
        self.line = line;
        self
    }

    /// The roles' moves of the activities just started, aimed by each member at the other (0.134 T1). A refused one
    /// is left out, and the member plays its role without it.
    fn begin_moves(&mut self, tree: &mut Tree, c: &mut Controller, now: Micros) {
        let bodies = self.activities.beginning();
        if bodies.is_empty() {
            return;
        }
        let feet = Feet::of(c, bodies);
        for (body, r) in self.activities.begin_moves(
            tree,
            c,
            &mut self.moves,
            &mut self.due,
            &mut self.mint,
            &self.library,
            &feet,
            &self.line,
            now,
        ) {
            eprintln!("worldd: {}'s move was not aimed: {r}", show(body));
        }
    }

    /// The activities `live` holds after a restart (their nodes and membership links are in the log), so a member can
    /// still speak in one and leave it: each started one takes its members' role claims again through `c`.
    /// The things on a course are handed to `slots` with the courses the log left them (#3603).
    pub fn restore(&mut self, live: &Tree, c: &mut Controller, slots: &mut Slots) -> R<()> {
        let kinds = self.kinds.clone();
        self.activities =
            Activities::restore(self.header.clone(), self.rules.clone(), kinds, live, c)?;
        self.steered = crate::carrier::restore(live, slots)?;
        Ok(())
    }

    /// Runs act `a` at `now` on a copy of `live`, the bodies' controller `c`. Its entries wait in [`Engine::out`].
    pub fn act(
        &mut self,
        live: &Tree,
        c: &mut Controller,
        slots: &mut Slots,
        a: &Act,
        now: Micros,
    ) -> R<()> {
        if let Some(ask) = match a.verb {
            Verb::Steer => Some(crate::carrier::Ask::Steer),
            Verb::Land => Some(crate::carrier::Ask::Land),
            Verb::Stop => Some(crate::carrier::Ask::Stop),
            _ => None,
        } {
            let by = (Cause::Intent(a.id), Actor::Soul(a.soul));
            let e = crate::carrier::act(live, slots, ask, a.body, a.target, &a.params, now, by)?;
            if let Some(t) = a.target {
                self.steered.insert(t);
            }
            self.out.push(e);
            return Ok(());
        }
        let mut tree = live.frozen();
        let target = |what| a.target.ok_or_else(|| refusal(what, "a target node"));
        let ask = Ask {
            soul: a.soul,
            intent: a.id,
            at: now,
        };
        self.activities.next = tree.next();
        let e = &mut self.activities;
        match a.verb {
            Verb::Propose => {
                let kind = param_kind(&a.params, 1, "propose-needs-a-kind")?;
                e.propose(
                    &mut tree,
                    &mut self.mint,
                    ask,
                    &kind,
                    target("propose-needs-a-place")?,
                )?;
            }
            Verb::Offer => {
                let kind = param_kind(&a.params, 1, "offer-needs-a-kind")?;
                let role = param_name(&a.params, 2, "offer-needs-a-role")?;
                let asked: BTreeSet<Id> = match a.params.get(&3) {
                    Some(Value::Array(v)) => v.iter().filter_map(|x| read_id(x).ok()).collect(),
                    _ => BTreeSet::new(),
                };
                let place = target("offer-needs-a-place")?;
                // A give (0.133 R4): 4 the thing the asker holds and hands over when the offer is accepted.
                let given = match a.params.get(&4) {
                    None => None,
                    Some(v) => Some(read_id(v).map_err(|_| Refusal {
                        name: "give-needs-a-thing",
                        detail: "parameter 4 is the thing given, an id".into(),
                    })?),
                };
                e.offer(
                    &mut tree,
                    &mut self.mint,
                    &mut self.due,
                    ask,
                    a.body,
                    &kind,
                    &role,
                    place,
                    asked,
                    given,
                )?;
            }
            Verb::Join => {
                let role = param_name(&a.params, 1, "join-needs-a-role")?;
                let revision = match a.params.get(&2) {
                    Some(Value::Uint(r)) => *r,
                    _ => 1,
                };
                let activity = target("join-needs-an-activity")?;
                e.join(
                    &mut tree,
                    &mut self.mint,
                    ask,
                    a.body,
                    activity,
                    &role,
                    revision,
                )?;
            }
            Verb::Accept => {
                let offer = target("accept-needs-an-offer")?;
                // 0.134 T1: a touch starts only where its moves reach; nothing walks the two to their places yet.
                // A dance (T3) touches nobody: its moves are at each member's own body.
                if let Some((kind, asker)) = e.offered(offer).filter(|(k, _)| !k.beat) {
                    let feet = Feet::of(c, [asker, a.body]);
                    for mv in kind.roles.iter().filter_map(|r| r.mv.as_ref()) {
                        let Some(m) = self.library.iter().find(|m| m.name == *mv) else {
                            continue;
                        };
                        let held = Effector::Held;
                        match feet.distance(asker, &held, None, a.body, &m.contact) {
                            Some(d) if d <= m.reach => {}
                            d => {
                                return Err(refusal(
                                    "together.too-far",
                                    format!(
                                        "{}: {} µm apart, it reaches {} µm: stand closer, facing each other",
                                        mv.as_str(),
                                        d.map_or("not on one floor".into(), |d| d.to_string()),
                                        m.reach
                                    ),
                                ));
                            }
                        }
                    }
                }
                e.accept(
                    &mut tree,
                    &mut self.mint,
                    c,
                    &mut self.due,
                    ask,
                    a.body,
                    offer,
                )?;
            }
            Verb::Decline => {
                let offer = target("decline-needs-an-offer")?;
                e.decline(&mut tree, &mut self.due, ask, a.body, offer)?;
            }
            Verb::Start => e.start(&mut tree, c, ask, target("start-needs-an-activity")?)?,
            Verb::Leave => {
                let activity = target("leave-needs-an-activity")?;
                e.leave(
                    &mut tree,
                    c,
                    &mut self.moves,
                    &mut self.due,
                    &mut self.mint,
                    ask,
                    a.body,
                    activity,
                )?;
                // A carry ends with its activity: what it carried stays where the last sample put it.
                if self.activities.members(activity).is_none() {
                    self.carries.remove(&activity);
                }
            }
            Verb::Steer | Verb::Land | Verb::Stop => {}
            Verb::Lift | Verb::SetDown => {
                let activity = target("carry-needs-an-activity")?;
                let members = self
                    .activities
                    .members(activity)
                    .ok_or_else(|| refusal("activity-missing", show(activity)))?;
                if !members.iter().any(|m| m.body == a.body) {
                    return Err(refusal("not-a-member", show(a.body)));
                }
                let (front, back) = match members {
                    [f, b, ..] => (f.body, b.body),
                    _ => return Err(refusal("carry-needs-two", show(activity))),
                };
                if !self.activities.started(activity) {
                    return Err(refusal("activity-not-started", show(activity)));
                }
                let ((ground, f), (_, k)) = (stands(c, front)?, stands(c, back)?);
                let transfer = self
                    .mint
                    .mint()
                    .map_err(|e| refusal("id-counter-exhausted", e.to_string()))?;
                if a.verb == Verb::Lift {
                    if self.carries.contains_key(&activity) {
                        return Err(refusal("carry-lifted", show(activity)));
                    }
                    let board = param_id(&a.params, 1, "lift-needs-a-thing")?;
                    let audience = tree
                        .handle(activity)
                        .and_then(|h| tree.node(h))
                        .map(|n| n.audience())
                        .ok_or_else(|| refusal("activity-missing", show(activity)))?;
                    let mut carry = Carry::new(
                        activity,
                        board,
                        ground,
                        audience,
                        self.header.clone(),
                        self.rules.clone(),
                    );
                    carry.lift(&mut tree, now, f, k, transfer)?;
                    self.carries.insert(activity, carry);
                } else {
                    let mut carry = self
                        .carries
                        .remove(&activity)
                        .ok_or_else(|| refusal("not-carried", show(activity)))?;
                    let done = carry.set_down(&mut tree, now, ground, f, k, transfer);
                    self.take(&mut carry, Some((a.id, a.soul)));
                    if let Err(r) = done {
                        self.carries.insert(activity, carry);
                        return Err(r);
                    }
                }
            }
        }
        self.begin_moves(&mut tree, c, now);
        self.collect(Some((a.id, a.soul)));
        Ok(())
    }

    fn take(&mut self, carry: &mut Carry, by: Option<(Id, Id)>) {
        let effects: Vec<Effect> = carry.log.parts.drain(..).flatten().collect();
        self.push(effects, by);
    }

    fn push(&mut self, effects: Vec<Effect>, by: Option<(Id, Id)>) {
        for mut e in effects {
            if let Some((intent, soul)) = by {
                e.envelope.cause = Cause::Intent(intent);
                e.envelope.actor = Actor::Soul(soul);
            }
            self.out.push(e);
        }
    }

    /// Moves the writers' entries to [`Engine::out`], caused by `by`'s intent and acted by its Soul.
    fn collect(&mut self, by: Option<(Id, Id)>) {
        let mut effects: Vec<Effect> = self.activities.stream.drain(..).collect();
        for c in self.carries.values_mut() {
            effects.extend(c.log.parts.drain(..).flatten());
        }
        self.push(effects, by);
    }

    /// The engine's part of a tick at `now`: its due timers (a leave let go, an offer or a pair lapsed), then one
    /// sample of each carry between its carriers.
    pub fn tick(&mut self, live: &Tree, c: &mut Controller, slots: &mut Slots, now: Micros) {
        if !self.steered.is_empty() {
            let home = crate::carrier::settle(live, slots, &mut self.steered, now);
            self.out.extend(home);
        }
        let mut tree = None;
        while let Some(t) = self.due.fire(now) {
            let tr = tree.get_or_insert_with(|| live.frozen());
            self.activities.next = tr.next();
            // A role's move (0.134 T1): its phases end here, and at contact its reach is asked again.
            let aimed = self
                .moves
                .instance_of(&t)
                .and_then(|n| self.moves.record(n));
            if let Some((body, target)) = aimed.map(|r| (r.body, r.target)) {
                let feet = Feet::of(c, [body, target]);
                let _ = self.moves.fire(c, &mut self.due, &mut self.mint, &feet, &t);
                continue;
            }
            if self
                .activities
                .fire(c, &mut self.moves, &mut self.due, &t)
                .is_none()
            {
                let _ = self.activities.lapse(tr, c, &mut self.due, &t);
            }
        }
        if let Some(tr) = tree.as_mut() {
            self.begin_moves(tr, c, now);
        }
        let _ = self.activities.settle(c, &self.moves, &mut self.due);
        if !self.carries.is_empty() {
            let tr = tree.get_or_insert_with(|| live.frozen());
            let mut gone = Vec::new();
            for (activity, carry) in &mut self.carries {
                let carriers = self
                    .activities
                    .members(*activity)
                    .map(|m| m.iter().map(|m| m.body).collect::<Vec<_>>());
                let (f, k) = match carriers.as_deref() {
                    Some([f, k, ..]) => (*f, *k),
                    _ => {
                        gone.push(*activity);
                        continue;
                    }
                };
                if let (Ok((_, f)), Ok((_, k))) = (stands(c, f), stands(c, k))
                    && let Err(r) = carry.step(tr, now, f, k)
                {
                    eprintln!("worldd: a carry's sample was not written: {r}");
                }
            }
            for a in gone {
                self.carries.remove(&a);
            }
        }
        self.collect(None);
    }

    /// A move `body` started for `intent` (a walk, a sit) at `now` (0.134 T2): if `body` holds hands, or dances on the
    /// beat (T3), it leaves that activity as `activity:leave` does, and both hands come free. Its entries wait in [`Engine::out`].
    pub fn walked(&mut self, live: &Tree, c: &mut Controller, body: Id, intent: Id, now: Micros) {
        let Some(activity) = self.activities.walk_leaves(&self.moves, body) else {
            return;
        };
        let Some(soul) = self
            .activities
            .members(activity)
            .and_then(|m| m.iter().find(|m| m.body == body))
            .map(|m| m.soul)
        else {
            return;
        };
        let mut tree = live.frozen();
        self.activities.next = tree.next();
        let ask = Ask {
            soul,
            intent,
            at: now,
        };
        if let Err(r) = self.activities.leave(
            &mut tree,
            c,
            &mut self.moves,
            &mut self.due,
            &mut self.mint,
            ask,
            body,
            activity,
        ) {
            eprintln!("worldd: {}'s walk did not let go: {r}", show(body));
        }
        self.collect(Some((intent, soul)));
    }

    /// The entries written since the last call, in order, to be numbered and applied.
    pub fn out(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.out)
    }
}

#[cfg(test)]
mod kind_tests {
    use super::*;

    #[test]
    fn activity_kinds_preserve_the_exact_pin_and_short_names() {
        let plain = Name::new("souls:conversation").unwrap();
        let mut hash = vec![0x12, 0x20];
        hash.extend([7; 32]);
        let params = |v| BTreeMap::from([(1, v)]);
        let pair = |h| Value::Array(vec![Value::Text(plain.clone()), Value::Bytes(h)]);
        assert_eq!(
            param_kind(&params(pair(hash.clone())), 1, "bad")
                .unwrap()
                .as_str(),
            format!("souls:conversation@{}", replica::encode::to_hex(&hash))
        );
        assert_eq!(
            param_kind(&params(Value::Text(plain.clone())), 1, "bad").unwrap(),
            plain
        );
        for h in [
            vec![0; 34],
            hash[..33].to_vec(),
            [hash.as_slice(), &[0]].concat(),
        ] {
            assert_eq!(
                param_kind(&params(pair(h)), 1, "bad").unwrap_err().name,
                "bad"
            );
        }
    }
}
