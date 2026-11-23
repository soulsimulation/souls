//! The engine's own acts in a running world (Engine v2 C2, #3366): joint activities (B5) and their offers (E8), and
//! carrying together (B9), each asked by a Soul's intent through the gateway. No code here names a kind.
//!
//! - **Verbs.** An engine act is an act verb in its system's namespace ([`Verb::of`]): `activity:propose`, `:offer`,
//!   `:join`, `:accept`, `:decline`, `:start` and `:leave`, and `carry:lift` and `carry:set-down`. They are not
//!   `souls:` verbs: T10 rule 4 keeps those a closed list of moves, cancels and orders, and an intent with any other
//!   `souls:` verb is refused `order-unknown` before it reaches the world.
//! - **Parameters.** The target is the place (propose, offer), the activity (join, start, leave, lift, set down) or the
//!   offer (accept, decline). Propose: 1 the activity's kind. Offer: 1 the kind, 2 the asker's role, 3 the bodies
//!   asked (ids), 4 for a give the thing the asker holds (0.133 R4: accepting hands it over, `sim::activity::offer`). Join: 1 the role, 2 the revision (default 1). Lift: 1 the thing carried, 2 where its front goes (optional, `[x, y, z]` µm: the way there is swept first, 0.135 C2). Its two carriers are the
//!   activity's first two members, the first in front. `carrier:steer`, `carrier:stop` and `carrier:land` steer the
//!   boat the Soul sits in ([`crate::carrier`], #3603): the target the boat, steer's 1 a point `[x, z]` µm (land's 1
//!   optional, a point by its home).
//! - **Seating parts** (0.135 A2, [`crate::assembly`]): `part:take`, `part:unseat` and `part:put`, the target the crew's
//!   activity (its two members, the first in front). Take and unseat: 1 the part. Seat: 1 the node it goes in, 2 its
//!   slot, or 3 a point `[x, y, z]` µm in that node's frame, 4 the parts it joins (ids; by default a bearing part
//!   joins the bay's standing parts). Their commits go through the walkers' maps, so they are answered then.
//! - **Written once, as the Soul's.** Each system writes through its own writer onto a copy of the tree; its entries,
//!   caused by the intent and acted by its Soul, are applied to the world with the tick's other entries
//!   ([`Engine::out`]), so the intent's receipt names them. An act is answered at once: a receipt, or its refusal by
//!   name (a take or a seating once its commit is written, below). A carry in progress is sampled each tick between
//!   its carriers ([`Engine::tick`]). A carry that breaks off (a carrier's leave, carriers drifted apart, a restart)
//!   sets its load down where it is and says why (0.135 C3).
//! - **A restart keeps its activities** (E26, #3329): once the bodies are back, [`Engine::restore`] reads them from
//!   their nodes and membership links, so a member speaks in one and leaves it as before. Open offers and carries in
//!   progress are not restored.
//!
//! A served world reads its activity kinds from its entries (`crate::serve::activity_kinds`) and births its Souls'
//! bodies as tree nodes (C3), so these acts run there as in a world given them (0.135 A2's served test,
//! `tests/edit_served.rs`).
//!
//! Not here: the view tier addressing an offer to the bodies asked (#3368's follow-up).

use std::collections::{BTreeMap, BTreeSet};

use replica::activity::ActivityKind;
use replica::effects::{Actor, Cause, Effect, Header, Refusal, read_id};
use replica::encode::{Name, Value};
use replica::ids::{Id, Minter, Scope};
use replica::moves::{Effector, Move};
use replica::pose::Vec3;
use replica::rules::json::Value as Json;
use replica::time::Micros;
use replica::tree::{Rules, Tree};
use replica::world_model::plain;
use replica::world_model::show;
use sim::activity::carry::{Carry, Fixed, Load};
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
    /// A crew takes a part, takes one out of a bay, or asm the part it carries (0.135 A2, [`crate::assembly`]).
    Take,
    Unseat,
    Put,
}

impl Verb {
    /// Whether the act is answered once its entries are committed through the walkers' maps, not at once (a take or
    /// a seating, 0.135 A2).
    pub fn deferred(self) -> bool {
        matches!(self, Verb::Take | Verb::Unseat | Verb::Put)
    }

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
            "part:take" => Verb::Take,
            "part:unseat" => Verb::Unseat,
            "part:put" => Verb::Put,
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
    /// The loads the world's entries state, by plain kind (0.135 C2, [`Engine::with_loads`]).
    loads: BTreeMap<String, Load>,
    /// The crews' seating, when the world's kinds join parts (0.135 A2, [`Engine::with_structure`]).
    asm: Option<crate::assembly::Assembly>,
    /// Each take waiting for its commit: the crew's ground, its node's pose and its audience, to start its carry.
    taking: BTreeMap<Id, (Id, Vec3, replica::pose::Quat, i64)>,
    /// The entries the joined-part rule was read from, to read it again for the activities after a restart.
    joining: Option<Json>,
    /// Loads found riding a carry at a restart, set down at the first tick (0.135 C3): (activity, load).
    riding: Vec<(Id, Id)>,
}

/// Sets `carry`'s load down where the carry last had it, at rest on `ground`, and has the world say `why`
/// (`souls:carry-set-down`, 0.135 C3); its entries are stamped with `by`'s intent and Soul, or the world's, and go in
/// the activities' stream, so every entry leaves the engine in the order it was written.
#[allow(clippy::too_many_arguments)]
fn break_off(
    carry: &mut Carry,
    activities: &mut Activities,
    mint: &mut Minter,
    tree: &mut Tree,
    now: Micros,
    here: Option<(Vec3, replica::pose::Quat)>,
    why: &'static str,
    by: Option<(Id, Id)>,
) -> R<()> {
    let transfer = mint
        .mint()
        .map_err(|e| refusal("id-counter-exhausted", e.to_string()))?;
    carry.set_down_here(tree, now, carry.ground, here, transfer)?;
    let mut effects: Vec<Effect> = carry.log.parts.drain(..).flatten().collect();
    for e in &mut effects {
        if let Some((intent, soul)) = by {
            e.envelope.cause = Cause::Intent(intent);
            e.envelope.actor = Actor::Soul(soul);
        }
    }
    activities.stream.extend(effects);
    activities.next = tree.next();
    let (actor, cause) = match by {
        Some((intent, soul)) => (Actor::Soul(soul), Cause::Intent(intent)),
        None => (Actor::World, Cause::World),
    };
    activities.carry_set_down(tree, carry.activity, carry.board, why, (now, actor, cause))
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

/// A point `[x, y, z]` µm, parameter `k`.
fn param_point(p: &BTreeMap<u64, Value>, k: u64, what: &'static str) -> R<Option<Vec3>> {
    let Some(v) = p.get(&k) else {
        return Ok(None);
    };
    let int = |v: &Value| match v {
        Value::Uint(n) => i64::try_from(*n).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    };
    match v {
        Value::Array(a) => match a.iter().map(int).collect::<Option<Vec<_>>>().as_deref() {
            Some([x, y, z]) => Ok(Some(Vec3::new(*x, *y, *z))),
            _ => Err(refusal(what, format!("parameter {k}: [x, y, z] µm"))),
        },
        _ => Err(refusal(what, format!("parameter {k}: [x, y, z] µm"))),
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

/// How far apart two carriers stand along the ground, µm.
fn apart(f: Vec3, k: Vec3) -> i64 {
    let (dx, dz) = (i128::from(f.x - k.x), i128::from(f.z - k.z));
    i64::try_from((dx * dx + dz * dz).isqrt()).unwrap_or(i64::MAX)
}

/// Where the controller has a body: the node it stands on and its position there.
fn stands(c: &Controller, body: Id) -> R<(Id, Vec3)> {
    c.body(body)
        .map(|m| (sim::index::place_of(m).0, m.pose.position))
        .ok_or_else(|| refusal("body-unknown", show(body)))
}

impl Engine {
    /// The engine carrying each load whose kind `entries` states as its entry says (0.135 C2): `entries` is the
    /// world's kinds, an object of entries; one that is not a load (no bounds, fewer than two grips) is left out.
    pub fn with_loads(mut self, entries: &Json) -> Engine {
        for (_, e) in entries.obj().unwrap_or(&[]) {
            if let (Some(kind), Ok(load)) = (e.get("kind").and_then(Json::str), Load::of(e)) {
                self.loads.insert(kind.to_owned(), load);
            }
        }
        self
    }

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
            loads: BTreeMap::new(),
            asm: None,
            taking: BTreeMap::new(),
            joining: None,
            riding: Vec::new(),
            library: crate::moves::library().unwrap_or_else(|r| {
                eprintln!("worldd: no moves for activities: {r}");
                Vec::new()
            }),
        }
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
            now,
        ) {
            eprintln!("worldd: {}'s move was not aimed: {r}", show(body));
        }
    }

    /// The engine seating parts by the joined-part rule `structure` (0.135 A2), when the world's kinds join any.
    /// The joined-part rule of the world's `entries` (B18) also guards the activities' own writes: a holder leaving a
    /// part that would then hang is refused `support.none`, as it is after a restart.
    pub fn with_structure(mut self, entries: &Json) -> Engine {
        let structure = sim::structure::Structure::from_entries;
        let asm = crate::assembly::Assembly::new(
            self.header.clone(),
            self.rules.clone(),
            structure(entries),
        );
        if asm.any() {
            self.activities.structure = structure(entries);
            self.asm = Some(asm);
            self.joining = Some(entries.clone());
        }
        self
    }

    /// The activities `live` holds after a restart (their nodes and membership links are in the log), so a member can
    /// still speak in one and leave it: each started one takes its members' role claims again through `c`.
    /// The things on a course are handed to `slots` with the courses the log left them (#3603).
    pub fn restore(&mut self, live: &Tree, c: &mut Controller, slots: &mut Slots) -> R<()> {
        let kinds = self.kinds.clone();
        self.activities =
            Activities::restore(self.header.clone(), self.rules.clone(), kinds, live, c)?;
        if let Some(e) = &self.joining {
            self.activities.structure = sim::structure::Structure::from_entries(e);
        }
        self.steered = crate::carrier::restore(live, slots)?;
        // 0.135 C3: a carry is not stored, so a load still riding its carry is set down at the first tick.
        for a in self.activities.ids() {
            let Some(h) = live.handle(a) else { continue };
            for &k in live.children(h).into_iter().flatten() {
                if let Some(n) = live.node(k)
                    && n.slot() == Some(sim::activity::carry::SLOT)
                {
                    self.riding.push((a, n.id()));
                }
            }
        }
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
                if let Some((kind, asker)) = e.offered(offer) {
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
                // A crew holding a part in its slot is not left: it puts the part down first (0.135 A2). Its activity
                // would otherwise end with the part inside it.
                if self
                    .asm
                    .as_ref()
                    .is_some_and(|s| s.held.contains_key(&activity))
                {
                    return Err(refusal("crew.holds-a-part", show(activity)));
                }
                // 0.135 C3: a carrier's leave breaks the carry off; its load is set down where it is.
                if let Some(mut carry) = self.carries.remove(&activity) {
                    break_off(
                        &mut carry,
                        e,
                        &mut self.mint,
                        &mut tree,
                        now,
                        None,
                        "souls:partner-left",
                        Some((a.id, a.soul)),
                    )?;
                }
                e.next = tree.next();
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
                    if let Some(s) = self.asm.as_mut() {
                        s.ended(activity);
                    }
                }
            }
            Verb::Steer | Verb::Land | Verb::Stop => {}
            Verb::Take | Verb::Unseat | Verb::Put => {
                let asm = self
                    .asm
                    .as_mut()
                    .ok_or_else(|| refusal("seating-off", "the world's kinds join no parts"))?;
                let activity = target("part-needs-a-crew")?;
                let members = self
                    .activities
                    .members(activity)
                    .ok_or_else(|| refusal("activity-missing", show(activity)))?;
                if !members.iter().any(|m| m.body == a.body) {
                    return Err(refusal("not-a-member", show(a.body)));
                }
                let (front, back) = match members {
                    [f, b] => (f.body, b.body),
                    _ => {
                        return Err(refusal(
                            "crew.size",
                            format!("{} has {} members", show(activity), members.len()),
                        ));
                    }
                };
                let ((ground, f), (_, k)) = (stands(c, front)?, stands(c, back)?);
                let by = (a.id, a.soul);
                if a.verb == Verb::Put {
                    let carry = self
                        .carries
                        .get(&activity)
                        .ok_or_else(|| refusal("part.not-held", show(activity)))?;
                    let from = carry
                        .track
                        .last()
                        .map(|(_, p, q)| (*p, *q))
                        .ok_or_else(|| refusal("part.not-held", show(activity)))?;
                    let to = param_id(&a.params, 1, "part-needs-a-place")?;
                    let slot = match a.params.get(&2) {
                        Some(Value::Uint(n)) => Some(*n),
                        None => None,
                        _ => return Err(refusal("part-needs-a-place", "parameter 2: a slot")),
                    };
                    let point = param_point(&a.params, 3, "part-needs-a-place")?;
                    let joins = match a.params.get(&4) {
                        Some(Value::Array(v)) => Some(
                            v.iter()
                                .map(read_id)
                                .collect::<Result<Vec<_>, _>>()
                                .map_err(|_| refusal("part-joins", "parameter 4: ids"))?,
                        ),
                        None => None,
                        _ => return Err(refusal("part-joins", "parameter 4: ids")),
                    };
                    let reach = slots.reach_of(front).min(slots.reach_of(back));
                    let effects = asm.put(
                        &mut tree,
                        &self.activities,
                        &self.mint,
                        now,
                        by,
                        activity,
                        (to, slot, point),
                        joins,
                        reach,
                        from,
                        ground,
                        apart(f, k),
                    )?;
                    self.carries.remove(&activity);
                    self.push(effects, Some(by));
                } else {
                    if self.carries.contains_key(&activity) {
                        return Err(refusal("carry-lifted", show(activity)));
                    }
                    let part = param_id(&a.params, 1, "take-needs-a-part")?;
                    let (at, turn) = asm.take(
                        &mut tree,
                        &self.activities,
                        &mut self.mint,
                        now,
                        by,
                        activity,
                        part,
                        (f, k),
                        ground,
                        a.verb == Verb::Unseat,
                        slots.reach_of(front).min(slots.reach_of(back)),
                    )?;
                    self.taking
                        .insert(activity, (ground, at, turn, apart(f, k)));
                }
            }
            Verb::Lift | Verb::SetDown => {
                let activity = target("carry-needs-an-activity")?;
                let members = self
                    .activities
                    .members(activity)
                    .ok_or_else(|| refusal("activity-missing", show(activity)))?;
                if !members.iter().any(|m| m.body == a.body) {
                    return Err(refusal("not-a-member", show(a.body)));
                }
                let crew = members.len();
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
                    // 0.135 C2: a load whose kind has an entry is checked as it states, before anything is written.
                    let node = tree
                        .handle(board)
                        .and_then(|h| tree.node(h))
                        .ok_or_else(|| refusal("lift-needs-a-thing", show(board)))?;
                    if let Some(load) = self.loads.get(plain(node.kind().as_str())) {
                        let middle = match (node.parent(), node.place()) {
                            (Some(p), Some(at)) if p == ground => at.position,
                            _ => {
                                return Err(refusal(
                                    "carry-grip-out-of-reach",
                                    format!(
                                        "{} is not on the floor its carriers stand on",
                                        show(board)
                                    ),
                                ));
                            }
                        };
                        let to = param_point(&a.params, 2, "lift-destination")?;
                        let fixed = match to {
                            Some(_) => Some(
                                Fixed::of(&tree, ground)
                                    .map_err(|e| refusal("carry-geometry", e))?,
                            ),
                            None => None,
                        };
                        let xz = |v: Vec3| [v.x, v.z];
                        load.check(
                            crew,
                            xz(f),
                            xz(k),
                            xz(middle),
                            to.map(xz).zip(fixed.as_ref()),
                        )?;
                    }
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
                    // A crew's part set down is no longer its own (0.135 A2).
                    if let Some(s) = self.asm.as_mut() {
                        s.ended(activity);
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
        // 0.135 C3: loads found riding at a restart are set down where their carry last had them.
        for (activity, load) in std::mem::take(&mut self.riding) {
            let tr = tree.get_or_insert_with(|| live.frozen());
            let found = tr.handle(activity).and_then(|h| tr.node(h)).and_then(|n| {
                Some((
                    n.parent()?,
                    n.audience(),
                    n.place().map(|p| (p.position, p.orientation))?,
                ))
            });
            let Some((ground, audience, here)) = found else {
                continue;
            };
            let mut carry = Carry::new(
                activity,
                load,
                ground,
                audience,
                self.header.clone(),
                self.rules.clone(),
            );
            match break_off(
                &mut carry,
                &mut self.activities,
                &mut self.mint,
                tr,
                now,
                Some(here),
                "souls:world-restarted",
                None,
            ) {
                Ok(()) => {}
                Err(r) => eprintln!(
                    "worldd: {} was not set down after the restart: {r}",
                    show(load)
                ),
            }
        }
        if !self.carries.is_empty() {
            let tr = tree.get_or_insert_with(|| live.frozen());
            let mut gone = Vec::new();
            let mut apart = Vec::new();
            let mut step = Vec::new();
            for (activity, carry) in &self.carries {
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
                let (Ok((_, f)), Ok((_, k))) = (stands(c, f), stands(c, k)) else {
                    continue;
                };
                // 0.135 C3: one stopped (or its connection is gone) while the other walked on.
                if carry.stretched(f, k) {
                    apart.push(*activity);
                } else {
                    step.push((*activity, f, k));
                }
            }
            for (list, why) in [
                (gone, "souls:partner-left"),
                (apart, "souls:carriers-apart"),
            ] {
                for a in list {
                    let Some(mut carry) = self.carries.remove(&a) else {
                        continue;
                    };
                    match break_off(
                        &mut carry,
                        &mut self.activities,
                        &mut self.mint,
                        tr,
                        now,
                        None,
                        why,
                        None,
                    ) {
                        // A crew's part set down is no longer its own (0.135 A2).
                        Ok(()) => {
                            if let Some(s) = self.asm.as_mut() {
                                s.ended(a);
                            }
                        }
                        Err(r) => eprintln!("worldd: a carry was not set down: {r}"),
                    }
                }
            }
            for (activity, f, k) in step {
                if let Some(carry) = self.carries.get_mut(&activity)
                    && let Err(r) = carry.step(tr, now, f, k)
                {
                    eprintln!("worldd: a carry's sample was not written: {r}");
                }
            }
        }
        if let Some(s) = self.asm.as_mut()
            && s.setting_in()
        {
            let tr = tree.get_or_insert_with(|| live.frozen());
            s.due(tr, &self.activities, &mut self.mint, now);
        }
        if let Some(tr) = tree.as_mut() {
            self.stop_refused(tr, now);
        }
        self.collect(None);
    }

    /// The seatings refused at their track's end or at their commit (0.135 A2): each crew's node handed back from its
    /// track to its mover where the track ended, and its carry started again from there, the part still in its slot.
    fn stop_refused(&mut self, tree: &mut Tree, now: Micros) {
        let Some(asm) = self.asm.as_mut() else { return };
        for (activity, s) in std::mem::take(&mut asm.stopped) {
            let audience = tree
                .handle(activity)
                .and_then(|h| tree.node(h))
                .map(|n| n.audience());
            let (Some(audience), Ok(effects)) = (audience, asm.stop(tree, now, activity, &s))
            else {
                eprintln!(
                    "worldd: a refused seating was not stopped: {}",
                    show(activity)
                );
                continue;
            };
            for mut e in effects {
                e.envelope.cause = Cause::Intent(s.by.0);
                e.envelope.actor = Actor::Soul(s.by.1);
                self.out.push(e);
            }
            let mut carry = Carry::new(
                activity,
                s.part,
                s.ground,
                audience,
                self.header.clone(),
                self.rules.clone(),
            );
            carry.track.push((now, s.end.0, s.end.1));
            carry.span = s.span;
            self.carries.insert(activity, carry);
        }
    }

    /// The takes and seatings to commit through the walkers' maps (0.135 A2, `crate::answers`), and the seatings
    /// refused when their track ended (the intent, its Soul and why).
    pub fn assembled(&mut self) -> (Vec<crate::assembly::Ready>, Vec<(Id, Id, Refusal)>) {
        match self.asm.as_mut() {
            Some(s) => (std::mem::take(&mut s.ready), std::mem::take(&mut s.refused)),
            None => (Vec::new(), Vec::new()),
        }
    }

    /// A take or a seating was committed (`written`) or refused at its commit: a committed take starts its crew's
    /// carry (B9's samples between its carriers); a refused one leaves the crew holding nothing.
    pub fn part_written(
        &mut self,
        r: &crate::assembly::Ready,
        written: bool,
        now: Micros,
        live: &Tree,
    ) {
        let taking = self.taking.remove(&r.activity);
        if let Some(asm) = self.asm.as_mut() {
            asm.written(r.activity, r.step, written);
        }
        if r.step != crate::assembly::Step::Taken {
            // A seating refused at its commit is stopped where its track ended.
            let mut tree = live.frozen();
            self.stop_refused(&mut tree, now);
            return;
        }
        let (Some(asm), Some((ground, at, turn, span))) = (self.asm.as_mut(), taking) else {
            return;
        };
        let part = asm.held.get(&r.activity).copied();
        let audience = live
            .handle(r.activity)
            .and_then(|h| live.node(h))
            .map(|n| n.audience());
        match (written, part, audience) {
            (true, Some(part), Some(audience)) => {
                let mut carry = Carry::new(
                    r.activity,
                    part,
                    ground,
                    audience,
                    self.header.clone(),
                    self.rules.clone(),
                );
                carry.track.push((now, at, turn));
                // Its carriers' span at the take: a carry they let drift apart breaks off (0.135 C3).
                carry.span = span;
                self.carries.insert(r.activity, carry);
            }
            _ => asm.written(r.activity, r.step, false),
        }
    }

    /// A move `body` started for `intent` (a walk, a sit) at `now` (0.134 T2): if `body` holds hands, it leaves that
    /// activity as `activity:leave` does, and both hands come free. Its entries wait in [`Engine::out`].
    pub fn walked(&mut self, live: &Tree, c: &mut Controller, body: Id, intent: Id, now: Micros) {
        let Some(activity) = self.activities.holding_hands(&self.moves, body) else {
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
