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
//!   activity's first two members, the first in front. Only a load is lifted, a kind whose entry states its grips
//!   (`lift-not-a-load`), and only in a carry, an activity whose kind has a slot 1 for a thing (`not-a-carry`, 0.135
//!   C4). `carrier:steer`, `carrier:stop` and `carrier:land` steer the
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
use replica::time::{Mapping, Micros, Tempo, TickRate, Timeline};
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
    /// The world's clock, whose beats a dance's moves start on (0.134 T3): the world's own ([`Engine::with_beats`]).
    line: Timeline,
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

/// How far a crew's carriers' middle may be from where its refused set-in started for its carry to start again there.
const BACK_SLACK: i64 = 300_000;
/// How far out from a seated part, along the side it is laid on, its middle rests, µm.
const LAY_OUT: i64 = 2_200_000;

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
            asm: None,
            taking: BTreeMap::new(),
            joining: None,
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
            loads: BTreeMap::new(),
            riding: Vec::new(),
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
                // 0.134 T1: a touch starts only where its moves reach; then the two take their places (0.135 G3).
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
                // 0.135 A2: while a crew's part is on its way in or back, or its take or seating waits for its commit,
                // the crew is not left; at any other time a leave breaks its carry off, as any carry's.
                if self.taking.contains_key(&activity)
                    || self.asm.as_ref().is_some_and(|s| s.busy(activity))
                {
                    return Err(refusal("crew.setting-in", show(activity)));
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
                    if let Some(s) = self.asm.as_mut() {
                        s.ended(activity);
                    }
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
                // A lone holder of a seated part lays it down beside its bay (0.135 A2): it cannot carry it alone, and
                // B18 would keep it holding the part for good.
                if a.verb == Verb::Unseat
                    && let Some(activity) = a.target
                    && let Some([m]) = self.activities.members(activity)
                    && m.body == a.body
                {
                    let part = param_id(&a.params, 1, "take-needs-a-part")?;
                    return self.lay_down(
                        &mut tree,
                        c,
                        (a.id, a.soul),
                        activity,
                        a.body,
                        part,
                        now,
                    );
                }
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
                // 0.135 C4: a carry is an activity whose kind has the slot a load rides in, for a thing.
                let kind = tree
                    .handle(activity)
                    .and_then(|h| tree.node(h))
                    .map(|n| n.kind().as_str().to_owned())
                    .ok_or_else(|| refusal("activity-missing", show(activity)))?;
                let carries = self.rules.kinds.get(&kind).is_some_and(|k| {
                    k.owner == "activity"
                        && k.slots
                            .get(&sim::activity::carry::SLOT)
                            .is_some_and(|s| s.contains("thing"))
                });
                if !carries {
                    return Err(refusal("not-a-carry", plain(&kind).to_owned()));
                }
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
                    // 0.135 C4: only a load, a kind whose entry states its grips and crew, is carried.
                    let mut load =
                        *self.loads.get(plain(node.kind().as_str())).ok_or_else(|| {
                            refusal(
                                "lift-not-a-load",
                                format!("{} ({})", show(board), plain(node.kind().as_str())),
                            )
                        })?;
                    let pose = |e| refusal("carry-pose", format!("{e:?}"));
                    // Its middle, wherever its origin is (a laid-flat upright's is at its end).
                    let (middle, axis) = match (node.parent(), node.place()) {
                        (Some(p), Some(at)) if p == ground => {
                            let m = at.orientation.rotate(load.middle).map_err(pose)?;
                            let middle = Vec3::new(at.position.x + m.x, 0, at.position.z + m.z);
                            (middle, load.lies_along(at.orientation)?)
                        }
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
                    // Its grips along its own long axis; the front at its − end lifts it the other way round.
                    let axis = match axis {
                        Some(v)
                            if i128::from(v[0]) * i128::from(f.x - k.x)
                                + i128::from(v[1]) * i128::from(f.z - k.z)
                                < 0 =>
                        {
                            load = load.reversed()?;
                            Some([-v[0], -v[1]])
                        }
                        v => v,
                    };
                    let to = param_point(&a.params, 2, "lift-destination")?;
                    let fixed = match to {
                        Some(_) => Some(
                            Fixed::of(&tree, ground).map_err(|e| refusal("carry-geometry", e))?,
                        ),
                        None => None,
                    };
                    let xz = |v: Vec3| [v.x, v.z];
                    load.check(
                        crew,
                        xz(f),
                        xz(k),
                        xz(middle),
                        axis,
                        to.map(xz).zip(fixed.as_ref()),
                    )?;
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
                    carry.load = load;
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
        // A crew started on a part ends the kept holds on it (0.135 A2).
        if a.verb == Verb::Accept
            && let Some(t) = a.target
            && self.activities.started(t)
            && let Some(part) = tree
                .handle(t)
                .and_then(|h| tree.node(h))
                .and_then(|n| n.parent())
        {
            self.unkeep(&mut tree, part, t, ask)?;
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
        // A handshake, a hug or a high-five whose moves have ended ends: both arms free (0.134 T1).
        if self.activities.finishing() {
            let tr = tree.get_or_insert_with(|| live.frozen());
            self.activities.next = tr.next();
            for (body, r) in
                self.activities
                    .finish(tr, c, &mut self.moves, &mut self.due, &mut self.mint, now)
            {
                eprintln!("worldd: {} did not leave its touch: {r}", show(body));
            }
        }
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
            // 0.135 C4: set down the way it is held, as its entry states it.
            if let Some((l, held)) = tr.handle(load).and_then(|h| tr.node(h)).and_then(|n| {
                Some((
                    self.loads.get(plain(n.kind().as_str()))?,
                    n.place()?.orientation,
                ))
            }) {
                carry.load = Load { turn: held, ..*l };
            }
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
                // A carrier with no body (retired, or gone from the world) has left (0.135 A2's review).
                let (Ok((_, f)), Ok((_, k))) = (stands(c, f), stands(c, k)) else {
                    gone.push(*activity);
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
            self.came_back(tr, c, now);
        }
        self.collect(None);
    }

    /// The seatings refused at their track's end or at their commit (0.135 A2): each crew's node handed back from its
    /// track to its mover where the track ended, and its carry started again from there, the part still in its slot.
    fn stop_refused(&mut self, tree: &mut Tree, now: Micros) {
        let Some(asm) = self.asm.as_mut() else { return };
        let mut written = std::mem::take(&mut asm.moved);
        for (activity, s) in std::mem::take(&mut asm.stopped) {
            let by = s.by;
            match asm.stop(tree, now, activity, s) {
                Ok(effects) => written.push((by, effects)),
                Err(r) => eprintln!(
                    "worldd: a refused seating was not stopped: {}: {r}",
                    show(activity)
                ),
            }
        }
        self.send(written);
    }

    fn send(&mut self, written: Vec<((Id, Id), Vec<Effect>)>) {
        for ((intent, soul), effects) in written {
            for mut e in effects {
                e.envelope.cause = Cause::Intent(intent);
                e.envelope.actor = Actor::Soul(soul);
                self.out.push(e);
            }
        }
    }

    /// The crews' nodes back where their refused set-in started (0.135 A2): each crew's carry starts again there when
    /// its carriers' middle is still within [`BACK_SLACK`] of it; else (they walked off meanwhile) it breaks off there
    /// and the part is set down where it is (C3), never pulled to where they went.
    fn came_back(&mut self, tree: &mut Tree, c: &Controller, now: Micros) {
        let Some(asm) = self.asm.as_mut() else { return };
        let back = asm.returned(tree, now);
        for (activity, s, effects) in back {
            self.send(vec![(s.by, effects)]);
            let Some(audience) = tree
                .handle(activity)
                .and_then(|h| tree.node(h))
                .map(|n| n.audience())
            else {
                continue;
            };
            let mut carry = Carry::new(
                activity,
                s.part,
                s.ground,
                audience,
                self.header.clone(),
                self.rules.clone(),
            );
            carry.track.push((now, s.start.0, s.start.1));
            carry.span = s.span;
            if let Some(l) = self.held_load(tree, s.part) {
                carry.load = l;
            }
            let middle = match self.activities.members(activity) {
                Some([f, k]) => match (stands(c, f.body), stands(c, k.body)) {
                    (Ok((_, f)), Ok((_, k))) => Some([(f.x + k.x) / 2, (f.z + k.z) / 2]),
                    _ => None,
                },
                _ => None,
            };
            let near =
                middle.is_some_and(|m| apart(Vec3::new(m[0], 0, m[1]), s.start.0) <= BACK_SLACK);
            if near {
                self.carries.insert(activity, carry);
                continue;
            }
            match break_off(
                &mut carry,
                &mut self.activities,
                &mut self.mint,
                tree,
                now,
                None,
                "souls:carriers-apart",
                Some(s.by),
            ) {
                Ok(()) => {
                    if let Some(asm) = self.asm.as_mut() {
                        asm.ended(activity);
                    }
                }
                Err(r) => eprintln!("worldd: a crew's part was not set down: {r}"),
            }
        }
    }

    /// Body `body` leaves the world (C3's retire, at `now`, for `intent` of `soul`): it leaves every activity it is a
    /// member of, as a leave (a carry it was in breaks off, `souls:partner-left`, its part set down where it is), so its
    /// partners are free to lay a part down, take it over or leave. The entries, to be written before the body goes.
    pub fn retiring(
        &mut self,
        live: &Tree,
        c: &mut Controller,
        body: Id,
        intent: Id,
        soul: Id,
        now: Micros,
    ) -> Vec<Effect> {
        let mut tree = live.frozen();
        let ask = Ask {
            soul,
            intent,
            at: now,
        };
        for activity in self.activities.ids() {
            let member = self
                .activities
                .members(activity)
                .is_some_and(|m| m.iter().any(|m| m.body == body));
            if !member {
                continue;
            }
            if let Some(mut carry) = self.carries.remove(&activity) {
                let r = break_off(
                    &mut carry,
                    &mut self.activities,
                    &mut self.mint,
                    &mut tree,
                    now,
                    None,
                    "souls:partner-left",
                    Some((intent, soul)),
                );
                match r {
                    Ok(()) => {
                        if let Some(s) = self.asm.as_mut() {
                            s.ended(activity);
                        }
                    }
                    Err(r) => eprintln!("worldd: a carry was not set down at a retire: {r}"),
                }
            }
            self.activities.next = tree.next();
            let mut left = self.activities.leave(
                &mut tree,
                c,
                &mut self.moves,
                &mut self.due,
                &mut self.mint,
                ask,
                body,
                activity,
            );
            // The last holder of a part B18 would leave hanging: the part is set down as its retire's first step
            // (laid beside its bay, or where it stands), each part that hangs by it laid down before it, all checked by
            // B18 together; when that cannot be done whole, the structure is kept as it stands, its hold left for
            // another crew to take over. Named in the retire's entries; B18 is never broken by a Soul going.
            if left.as_ref().is_err_and(|r| r.name == "support.none")
                && let Some(part) = tree
                    .handle(activity)
                    .and_then(|h| tree.node(h))
                    .and_then(|n| n.parent())
            {
                match self.holder_left(&mut tree, c, body, activity, part, now, (intent, soul)) {
                    Ok(true) => {
                        self.activities.next = tree.next();
                        left = self.activities.leave(
                            &mut tree,
                            c,
                            &mut self.moves,
                            &mut self.due,
                            &mut self.mint,
                            ask,
                            body,
                            activity,
                        );
                    }
                    Ok(false) => continue,
                    Err(r) => {
                        eprintln!("worldd: a retiring holder's part was not set down: {r}")
                    }
                }
            }
            if let Err(r) = left {
                eprintln!(
                    "worldd: {} did not leave {} as it retired: {r}",
                    show(body),
                    show(activity)
                );
            }
            if self.activities.members(activity).is_none()
                && let Some(s) = self.asm.as_mut()
            {
                s.ended(activity);
            }
        }
        self.activities
            .stream
            .drain(..)
            .map(|mut e| {
                e.envelope.cause = Cause::Intent(intent);
                e.envelope.actor = Actor::Soul(soul);
                e
            })
            .collect()
    }

    /// The last holder `body` of crew `activity` leaves the world while it holds `part` in its bay (0.135 A2), for
    /// `by` (intent, Soul) at `now`. Each part joined to `part` in the bay (it would hang by it) is laid down first as a
    /// lone holder's lay-down lays a part ([`Engine::lay_place`], with no reach), then `part` itself
    /// ([`Engine::holder_rest`]); B18 judges all of it together against the tree as it was. Written to `tree` and the
    /// activities' entries when it holds: `true`. When a part has no room, or B18 refuses, nothing moves: the
    /// structure is kept as it stands with its hold (`souls:holder-left-structure-kept`), `false`.
    #[allow(clippy::too_many_arguments)]
    fn holder_left(
        &mut self,
        tree: &mut Tree,
        c: &Controller,
        body: Id,
        activity: Id,
        part: Id,
        now: Micros,
        by: (Id, Id),
    ) -> R<bool> {
        let audience =
            |t: &Tree, id: Id| t.handle(id).and_then(|h| t.node(h)).map(|n| n.audience());
        let ground = stands(c, body)?.0;
        let crew_audience =
            audience(tree, activity).ok_or_else(|| refusal("activity-missing", show(activity)))?;
        let mut scratch = tree.frozen();
        let mut laid: Vec<Effect> = Vec::new();
        let mut room = true;
        for hanging in self.joined_in_bay(tree, part) {
            let skip = self.joined_in_bay(&scratch, hanging);
            let Some(a) = audience(&scratch, hanging) else {
                room = false;
                break;
            };
            let Ok((_, place, yaw, load)) =
                self.lay_place(&scratch, c, body, hanging, false, &skip)
            else {
                room = false;
                break;
            };
            let mut carry = Carry::new(
                hanging,
                hanging,
                ground,
                a,
                self.header.clone(),
                self.rules.clone(),
            );
            // Its joints undone, each by the node that owns the link, then the part laid down.
            let unlinks = self.joints_of(&scratch, hanging, a);
            if !unlinks.is_empty() {
                carry.log.next = scratch.next();
                carry.log.write(&mut scratch, now, unlinks)?;
            }
            carry.load = load;
            carry.track.push((now, place, yaw));
            let transfer = self
                .mint
                .mint()
                .map_err(|e| refusal("id-counter-exhausted", e.to_string()))?;
            carry.set_down_here(&mut scratch, now, ground, None, transfer)?;
            laid.extend(carry.log.parts.drain(..).flatten());
        }
        let rest = match room {
            true => self.holder_rest(&scratch, c, body, part, ground),
            false => None,
        };
        let (header, rules) = (self.header.clone(), self.rules.clone());
        let held = |load: Load, place: Vec3, yaw: replica::pose::Quat| {
            let mut carry = Carry::new(
                activity,
                part,
                ground,
                crew_audience,
                header.clone(),
                rules.clone(),
            );
            carry.load = load;
            carry.track.push((now, place, yaw));
            carry
        };
        // B18 on the whole set-down, as the tree was.
        let whole = match (&rest, self.asm.as_ref()) {
            (None, _) => false,
            (Some(_), None) => true,
            (Some((load, place, yaw, _)), Some(asm)) => {
                let mut probe = held(*load, *place, *yaw);
                let mut t = scratch.frozen();
                let transfer = self
                    .mint
                    .mint()
                    .map_err(|e| refusal("id-counter-exhausted", e.to_string()))?;
                probe.set_down_here(&mut t, now, ground, None, transfer)?;
                let mut all = laid.clone();
                all.extend(probe.log.parts.drain(..).flatten());
                asm.structure().check(tree, &all).is_ok()
            }
        };
        let act = (now, Actor::Soul(by.1), Cause::Intent(by.0));
        let Some((load, place, yaw, why)) = rest.filter(|_| whole) else {
            // The hold keeps counting, for B18, the holders it has now, once its holder's body (and so its membership
            // link) is gone: the bay stays as B18 had it until another crew holds the part ([`Engine::unkeep`]).
            let holding = tree
                .handle(activity)
                .and_then(|h| tree.links_of(h))
                .unwrap_or(&[])
                .iter()
                .filter(|e| tree.ty(e).as_str() == replica::activity::MEMBER)
                .count()
                .max(1) as u64;
            self.mark(tree, now, activity, crew_audience, holding)?;
            self.activities.next = tree.next();
            self.activities.hold_kept(
                tree,
                activity,
                part,
                "souls:holder-left-structure-kept",
                act,
            )?;
            return Ok(false);
        };
        self.activities.stream.extend(laid);
        *tree = scratch;
        let mut carry = held(load, place, yaw);
        break_off(
            &mut carry,
            &mut self.activities,
            &mut self.mint,
            tree,
            now,
            None,
            why,
            Some(by),
        )?;
        Ok(true)
    }

    /// Sets crew `activity`'s kept holders ([`sim::structure::F_KEPT`]) to `holding` on `tree`, its entry added to the
    /// activities' entries.
    fn mark(
        &mut self,
        tree: &mut Tree,
        now: Micros,
        activity: Id,
        audience: replica::world_model::Audience,
        holding: u64,
    ) -> R<()> {
        use replica::effects::{Body, Change, ChangeRec, Rest};
        let mut log =
            sim::slots::hands::Log::new(self.header.clone(), self.rules.clone(), tree.next());
        let set = Change::Set {
            node: activity,
            field: sim::structure::F_KEPT,
            to: Value::Uint(holding),
            by: None,
        };
        log.write(
            tree,
            now,
            vec![(
                activity,
                audience,
                Body::Changes(vec![ChangeRec {
                    change: set,
                    rest: Rest::new(),
                }]),
            )],
        )?;
        self.activities.stream.extend(log.parts.drain(..).flatten());
        self.activities.next = tree.next();
        Ok(())
    }

    /// Another crew, `activity`, holds `part` now, or has taken or unseated it (0.135 A2): every kept hold on it (its
    /// last holder gone, [`Engine::holder_left`]) ends, its node removed and forgotten, for `ask`.
    fn unkeep(&mut self, tree: &mut Tree, part: Id, activity: Id, ask: Ask) -> R<()> {
        let kept: Vec<Id> = tree
            .handle(part)
            .and_then(|h| tree.children(h))
            .unwrap_or(&[])
            .iter()
            .filter_map(|h| tree.node(*h))
            .filter(|n| n.id() != activity)
            .filter(|n| {
                matches!(n.fields().get(&sim::structure::F_KEPT), Some(Value::Uint(k)) if *k > 0)
            })
            .map(|n| n.id())
            .collect();
        for k in kept {
            self.activities.next = tree.next();
            self.activities.forget(tree, k, ask)?;
            if let Some(s) = self.asm.as_mut() {
                s.ended(k);
            }
        }
        Ok(())
    }

    /// The parts of `part`'s bay joined to it (B18's joints): each would hang by it.
    fn joined_in_bay(&self, tree: &Tree, part: Id) -> Vec<Id> {
        let Some(s) = self.asm.as_ref().map(|a| a.structure()) else {
            return Vec::new();
        };
        let node = |id: Id| tree.handle(id).and_then(|h| tree.node(h));
        let Some(ph) = tree.handle(part) else {
            return Vec::new();
        };
        let bay = node(part).and_then(|n| n.parent());
        let mut out = Vec::new();
        for e in tree.links_of(ph).unwrap_or(&[]) {
            if !s.joint(tree.ty(e).as_str()) {
                continue;
            }
            let Some((_, ends, _, _)) = tree.link(e.link) else {
                continue;
            };
            let other = if ends[0] == part { ends[1] } else { ends[0] };
            let in_bay =
                node(other).is_some_and(|n| s.is_part(n.kind().as_str()) && n.parent() == bay);
            if in_bay && !out.contains(&other) {
                out.push(other);
            }
        }
        out
    }

    /// The entries undoing `part`'s joints, each written by the node that owns the link (as an unseat undoes them).
    fn joints_of(
        &self,
        tree: &Tree,
        part: Id,
        audience: replica::world_model::Audience,
    ) -> Vec<sim::slots::hands::Entry> {
        use replica::effects::{Body, Change, ChangeRec, Rest};
        let Some(s) = self.asm.as_ref().map(|a| a.structure()) else {
            return Vec::new();
        };
        let Some(ph) = tree.handle(part) else {
            return Vec::new();
        };
        tree.links_of(ph)
            .unwrap_or(&[])
            .iter()
            .filter(|e| s.joint(tree.ty(e).as_str()))
            .filter_map(|e| {
                let (_, ends, owner, _) = tree.link(e.link)?;
                let by = ends[usize::from(owner == replica::world_model::End::Second)];
                Some((
                    by,
                    audience,
                    Body::Changes(vec![ChangeRec {
                        change: Change::Unlink { link: e.link },
                        rest: Rest::new(),
                    }]),
                ))
            })
            .collect()
    }

    /// Where a retiring last holder `body` sets its seated `part` down on `ground` (0.135 A2): laid beside its bay
    /// when it is within reach and a side is free ([`Engine::lay_place`], `souls:holder-left`); else laid flat where
    /// it stands, as its entry lays it, when that resting outline is clear (`souls:holder-left-flat`); else left
    /// standing as it is (`souls:holder-left-standing`). Either of the last two rests on the part's own base, the
    /// ground under it (raised or sloped terrain included). Its load, the middle of its resting place at carrying
    /// height (C3's set-down takes it down from there), its turn, and why; `None` when it has no place on `ground`.
    fn holder_rest(
        &self,
        tree: &Tree,
        c: &Controller,
        body: Id,
        part: Id,
        ground: Id,
    ) -> Option<(Load, Vec3, replica::pose::Quat, &'static str)> {
        if let Ok((_, place, yaw, load)) = self.lay_place(tree, c, body, part, true, &[]) {
            return Some((load, place, yaw, "souls:holder-left"));
        }
        let entry = tree
            .handle(part)
            .and_then(|h| tree.node(h))
            .and_then(|n| self.loads.get(plain(n.kind().as_str())).copied())
            .unwrap_or_else(Load::board);
        let st = tree
            .handle(part)
            .zip(tree.handle(ground))
            .and_then(|(p, g)| sim::ground::scene::xform_to(tree, p, g).ok())?;
        let ax = st
            .rot
            .rotate(Vec3::new(1_000_000, 0, 0))
            .map_or([1_000_000, 0], |v| [v.x, v.z]);
        let yaw = sim::activity::carry::yaw_toward(ax).unwrap_or(replica::pose::Quat::IDENTITY);
        let a = [
            (i128::from(ax[0]) * i128::from(entry.half_length) / 1_000_000) as i64,
            (i128::from(ax[1]) * i128::from(entry.half_length) / 1_000_000) as i64,
        ];
        let flat = sim::activity::carry::outline(
            [st.pos.x + a[0], st.pos.z + a[1]],
            [st.pos.x - a[0], st.pos.z - a[1]],
            &entry,
        );
        let over = Vec3::new(st.pos.x, st.pos.y + sim::activity::carry::HEIGHT, st.pos.z);
        if self.room_at(tree, c, ground, part, &flat, body) {
            return Some((entry, over, yaw, "souls:holder-left-flat"));
        }
        let standing = Load {
            turn: st.rot,
            middle: Vec3::ZERO,
            rest: 0,
            ..entry
        };
        Some((
            standing,
            over,
            replica::pose::Quat::IDENTITY,
            "souls:holder-left-standing",
        ))
    }

    /// Where a lone holder `holder` lays its seated `part` down beside its bay (0.135 A2): its ground, the middle of
    /// its resting place at carrying height (C3's set-down takes it down from there), its turn, and its load. The holder
    /// must be within reach of it. The sides of the part in its bay's frame are tried out of the bay first, then the
    /// free side nearest the holder, never into the bay: each a resting place [`LAY_OUT`] out, the part lying along
    /// that side. A side is taken when the plan area the part sweeps from where it stands to where it rests (their
    /// hull, as C4's route check sweeps a lift) is clear of fixed geometry (`carry::Fixed`), of every other part the
    /// joined-part rule reads at any height, and of every body but its holder's, and its resting outline of its holder
    /// too; else `laydown.no-room`.
    #[allow(clippy::too_many_arguments)]
    fn lay_place(
        &self,
        tree: &Tree,
        c: &Controller,
        holder: Id,
        part: Id,
        reach: bool,
        skip: &[Id],
    ) -> R<(Id, Vec3, replica::pose::Quat, Load)> {
        use sim::activity::carry::{Fixed, Quad, outline, overlap};
        let node = |id: Id| tree.handle(id).and_then(|h| tree.node(h));
        let pn = node(part).ok_or_else(|| refusal("part-missing", show(part)))?;
        let load = self
            .loads
            .get(plain(pn.kind().as_str()))
            .copied()
            .unwrap_or_else(Load::board);
        let (ground, at) = stands(c, holder)?;
        let (ph, gh) = match (tree.handle(part), tree.handle(ground)) {
            (Some(p), Some(g)) => (p, g),
            _ => return Err(refusal("part-missing", show(part))),
        };
        let x = sim::ground::scene::xform_to(tree, ph, gh).map_err(|e| refusal("part-pose", e))?;
        if reach && apart(at, x.pos) > crate::assembly::GRASP {
            return Err(refusal("part.out-of-reach", show(part)));
        }
        let fixed = Fixed::of(tree, ground).map_err(|e| refusal("laydown.geometry", e))?;
        // Every other part the rule reads, at any height, as a square about its middle as wide as it is long.
        let is_part = |k: &str| self.asm.as_ref().is_some_and(|s| s.is_part(k));
        let mut others: Vec<Quad> = Vec::new();
        let mut stack = vec![tree.root()];
        while let Some(h) = stack.pop() {
            stack.extend(tree.children(h).unwrap_or(&[]).iter().copied());
            let Some(n) = tree.node(h) else { continue };
            if n.id() == part || skip.contains(&n.id()) || !is_part(n.kind().as_str()) {
                continue;
            }
            let Ok(o) = sim::ground::scene::xform_to(tree, h, gh) else {
                continue;
            };
            let l = self
                .loads
                .get(plain(n.kind().as_str()))
                .copied()
                .unwrap_or_else(Load::board);
            let m = o
                .rot
                .rotate(l.middle)
                .map_or(o.pos, |v| Vec3::new(o.pos.x + v.x, 0, o.pos.z + v.z));
            let r = l.half_length;
            others.push([
                [m.x - r, m.z - r],
                [m.x + r, m.z - r],
                [m.x + r, m.z + r],
                [m.x - r, m.z + r],
            ]);
        }
        // Bodies on this ground, in its frame (`place_of`), each a square of a body's radius; its holder apart.
        let radius = sim::ground::HUMAN_RADIUS * 1000;
        let square = |p: [i64; 2]| -> Quad {
            [
                [p[0] - radius, p[1] - radius],
                [p[0] + radius, p[1] - radius],
                [p[0] + radius, p[1] + radius],
                [p[0] - radius, p[1] + radius],
            ]
        };
        let (mut bodies, mut own) = (Vec::new(), None);
        for id in c.ids() {
            let Some(m) = c.body(id) else { continue };
            let (on, p) = sim::index::place_of(m);
            if on != ground {
                continue;
            }
            match id == holder {
                true => own = Some(square(p)),
                false => bodies.push(square(p)),
            }
        }
        // The part's own footprint where it stands, and its own fixed outlines, which it leaves.
        let (lx, lz) = (
            load.half_length.max(load.half_width),
            load.half_width.min(load.half_length),
        );
        let unit = |v: Vec3| x.rot.rotate(v).map(|r| [r.x, r.z]);
        let to_holder = [at.x - x.pos.x, at.z - x.pos.z];
        let bay_at = pn
            .parent()
            .and_then(|b| tree.handle(b))
            .and_then(|bh| sim::ground::scene::xform_to(tree, bh, gh).ok())
            .map_or(x.pos, |b| b.pos);
        let outward = [x.pos.x - bay_at.x, x.pos.z - bay_at.z];
        let dot = |d: &[i64; 2], v: [i64; 2]| {
            i128::from(d[0]) * i128::from(v[0]) + i128::from(d[1]) * i128::from(v[1])
        };
        // Each side as a vector LAY_OUT long, along the part's own axes (exact, not rounded to a diagonal).
        let mut sides: Vec<[i64; 2]> = [
            Vec3::new(LAY_OUT, 0, 0),
            Vec3::new(-LAY_OUT, 0, 0),
            Vec3::new(0, 0, LAY_OUT),
            Vec3::new(0, 0, -LAY_OUT),
        ]
        .into_iter()
        .filter_map(|v| unit(v).ok())
        .collect();
        sides.retain(|d| dot(d, outward) >= 0);
        sides.sort_by_key(|d| (dot(d, outward) <= 0, -dot(d, to_holder)));
        // Its own fixed outlines, and those of the parts it is joined to (`skip`, which it slides off): those lying
        // wholly within one of their plan footprints where they stand.
        let boxes: Vec<[i64; 4]> = std::iter::once(part)
            .chain(skip.iter().copied())
            .filter_map(|id| self.plan_box(tree, id, gh))
            .collect();
        let mine = |q: &Quad| {
            boxes.iter().any(|b| {
                q.iter()
                    .all(|p| p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3])
            })
        };
        let scaled = |d: [i64; 2], by: i64| {
            [
                (i128::from(d[0]) * i128::from(by) / i128::from(LAY_OUT)) as i64,
                (i128::from(d[1]) * i128::from(by) / i128::from(LAY_OUT)) as i64,
            ]
        };
        let free = sides.into_iter().find_map(|d| {
            let c0 = [x.pos.x + d[0], x.pos.z + d[1]];
            let along = [-d[1], d[0]];
            let a = scaled(along, load.half_length);
            let rest = outline(
                [c0[0] + a[0], c0[1] + a[1]],
                [c0[0] - a[0], c0[1] - a[1]],
                &load,
            );
            // The sweep: from the part's far edge behind where it stands to the far edge of where it rests, as wide as
            // the larger of the two.
            let (from, to) = (scaled(d, -lz), scaled(d, LAY_OUT + load.half_width));
            let mid = [
                x.pos.x + (from[0] + to[0]) / 2,
                x.pos.z + (from[1] + to[1]) / 2,
            ];
            let half_d = (LAY_OUT + load.half_width + lz) / 2;
            let e = scaled(d, half_d);
            let sweep_load = Load {
                half_length: half_d,
                half_width: load.half_length.max(lx),
                ..load
            };
            let sweep = outline(
                [mid[0] + e[0], mid[1] + e[1]],
                [mid[0] - e[0], mid[1] - e[1]],
                &sweep_load,
            );
            let fixed_hit = fixed
                .within([
                    sweep.iter().map(|p| p[0]).min().unwrap_or(0),
                    sweep.iter().map(|p| p[1]).min().unwrap_or(0),
                    sweep.iter().map(|p| p[0]).max().unwrap_or(0),
                    sweep.iter().map(|p| p[1]).max().unwrap_or(0),
                ])
                .into_iter()
                .filter(|q| !mine(q))
                .any(|q| overlap(&sweep, q));
            let clear = !fixed_hit
                && !others.iter().any(|q| overlap(&sweep, q))
                && !bodies.iter().any(|b| overlap(&sweep, b))
                && !own.as_ref().is_some_and(|b| overlap(&rest, b));
            clear.then_some((c0, along))
        });
        let Some((c0, along)) = free else {
            return Err(refusal("laydown.no-room", show(part)));
        };
        // At the ground's height where it rests (raised or sloped terrain), as C4's set-down rests a load at its
        // carriers' feet; read near its bay's base (its own, out of a bay), never near a far-off holder's feet.
        let base = sim::ground::scene::Terrain::within(
            tree,
            ground,
            [c0[0] - 1, c0[1] - 1, c0[0] + 1, c0[1] + 1],
        )
        .ok()
        .flatten();
        let floor = sim::ground::scene::Terrain::ground(base.as_ref(), c0[0], c0[1], bay_at.y);
        let place = Vec3::new(c0[0], floor + sim::activity::carry::HEIGHT, c0[1]);
        Ok((
            ground,
            place,
            sim::activity::carry::yaw_toward(along)?,
            load,
        ))
    }

    /// The plan box of part `id` where it stands, in the frame of ground `gh` (µm): its long axis's ends (its kind's
    /// load, C4) widened by its half width and 10 mm.
    fn plan_box(&self, tree: &Tree, id: Id, gh: replica::tree::Handle) -> Option<[i64; 4]> {
        let h = tree.handle(id)?;
        let l = self
            .loads
            .get(plain(tree.node(h)?.kind().as_str()))
            .copied()
            .unwrap_or_else(Load::board);
        let x = sim::ground::scene::xform_to(tree, h, gh).ok()?;
        let a = x.point(l.middle.plus(l.long).ok()?).ok()?;
        let b = x.point(l.middle.minus(l.long).ok()?).ok()?;
        let w = l.half_width + 10_000;
        Some([
            a.x.min(b.x) - w,
            a.z.min(b.z) - w,
            a.x.max(b.x) + w,
            a.z.max(b.z) + w,
        ])
    }

    /// Whether `quad` (a resting outline on `ground`, µm) is clear of fixed geometry (`part`'s own outlines aside), of
    /// every other part B18 reads, at any height, and of every body but `skip`'s.
    fn room_at(
        &self,
        tree: &Tree,
        c: &Controller,
        ground: Id,
        part: Id,
        quad: &sim::activity::carry::Quad,
        skip: Id,
    ) -> bool {
        use sim::activity::carry::{Fixed, overlap};
        let (Some(gh), Some(ph)) = (tree.handle(ground), tree.handle(part)) else {
            return false;
        };
        let Ok(fixed) = Fixed::of(tree, ground) else {
            return false;
        };
        let Ok(x) = sim::ground::scene::xform_to(tree, ph, gh) else {
            return false;
        };
        let hw = tree
            .node(ph)
            .and_then(|n| self.loads.get(plain(n.kind().as_str())))
            .map_or(0, |l| l.half_width)
            + 10_000;
        let mine = |q: &sim::activity::carry::Quad| {
            q.iter()
                .all(|p| (p[0] - x.pos.x).abs() <= hw && (p[1] - x.pos.z).abs() <= hw)
        };
        let b = [
            quad.iter().map(|p| p[0]).min().unwrap_or(0),
            quad.iter().map(|p| p[1]).min().unwrap_or(0),
            quad.iter().map(|p| p[0]).max().unwrap_or(0),
            quad.iter().map(|p| p[1]).max().unwrap_or(0),
        ];
        if fixed
            .within(b)
            .into_iter()
            .any(|q| !mine(q) && overlap(quad, q))
        {
            return false;
        }
        let is_part = |k: &str| self.asm.as_ref().is_some_and(|s| s.is_part(k));
        let mut stack = vec![tree.root()];
        while let Some(h) = stack.pop() {
            stack.extend(tree.children(h).unwrap_or(&[]).iter().copied());
            let Some(n) = tree.node(h) else { continue };
            if n.id() == part || !is_part(n.kind().as_str()) {
                continue;
            }
            let Ok(o) = sim::ground::scene::xform_to(tree, h, gh) else {
                continue;
            };
            let r = self
                .loads
                .get(plain(n.kind().as_str()))
                .map_or(1_000_000, |l| l.half_length);
            let sq = [
                [o.pos.x - r, o.pos.z - r],
                [o.pos.x + r, o.pos.z - r],
                [o.pos.x + r, o.pos.z + r],
                [o.pos.x - r, o.pos.z + r],
            ];
            if overlap(quad, &sq) {
                return false;
            }
        }
        let radius = sim::ground::HUMAN_RADIUS * 1000;
        !c.ids()
            .filter(|id| *id != skip)
            .filter_map(|id| c.body(id))
            .any(|m| {
                let (on, p) = sim::index::place_of(m);
                on == ground
                    && overlap(
                        quad,
                        &[
                            [p[0] - radius, p[1] - radius],
                            [p[0] + radius, p[1] - radius],
                            [p[0] + radius, p[1] + radius],
                            [p[0] - radius, p[1] + radius],
                        ],
                    )
            })
    }

    /// A lone holder `holder` of crew `activity` lays its seated `part` down beside its bay ([`Engine::lay_place`]), at
    /// rest as its kind's entry lays it (C3's set-down, C4's load); written through the walkers' maps as a seating is,
    /// and refused by B18 when another part hangs by it. Then its holder may leave.
    #[allow(clippy::too_many_arguments)]
    fn lay_down(
        &mut self,
        tree: &mut Tree,
        c: &Controller,
        by: (Id, Id),
        activity: Id,
        holder: Id,
        part: Id,
        now: Micros,
    ) -> R<()> {
        let node = |id: Id| tree.handle(id).and_then(|h| tree.node(h));
        let pn = node(part).ok_or_else(|| refusal("part-missing", show(part)))?;
        if node(activity).and_then(|n| n.parent()) != Some(part) {
            return Err(refusal("part.not-held", show(activity)));
        }
        let in_bay = pn.parent().and_then(&node).is_some_and(|b| {
            self.asm
                .as_ref()
                .is_some_and(|s| s.is_bay(b.kind().as_str()))
        });
        if !in_bay {
            return Err(refusal("part.not-seated", show(part)));
        }
        let audience = node(activity)
            .map(|n| n.audience())
            .ok_or_else(|| refusal("activity-missing", show(activity)))?;
        let (ground, place, yaw, load) = self.lay_place(tree, c, holder, part, true, &[])?;
        let mut carry = Carry::new(
            activity,
            part,
            ground,
            audience,
            self.header.clone(),
            self.rules.clone(),
        );
        carry.load = load;
        carry.track.push((now, place, yaw));
        let transfer = self
            .mint
            .mint()
            .map_err(|e| refusal("id-counter-exhausted", e.to_string()))?;
        carry.set_down_here(tree, now, ground, None, transfer)?;
        let effects: Vec<Effect> = carry
            .log
            .parts
            .drain(..)
            .flatten()
            .map(|mut e| {
                e.envelope.cause = Cause::Intent(by.0);
                e.envelope.actor = Actor::Soul(by.1);
                e
            })
            .collect();
        let asm = self
            .asm
            .as_mut()
            .ok_or_else(|| refusal("seating-off", "the world's kinds join no parts"))?;
        asm.ready.push(crate::assembly::Ready {
            intent: by.0,
            soul: by.1,
            activity,
            step: crate::assembly::Step::Laid,
            effects,
        });
        Ok(())
    }

    /// The load `part` is as its kind's entry states it, turned as it is held in its crew's slot (0.135 C4's
    /// `Load`), so a carry that breaks off sets it down the way it is held.
    fn held_load(&self, tree: &Tree, part: Id) -> Option<Load> {
        let n = tree.handle(part).and_then(|h| tree.node(h))?;
        let l = self.loads.get(plain(n.kind().as_str()))?;
        Some(Load {
            turn: n.place()?.orientation,
            ..*l
        })
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
        let Some((ground, at, turn, span)) = taking else {
            return;
        };
        let part = self
            .asm
            .as_ref()
            .and_then(|a| a.held.get(&r.activity).copied());
        let audience = live
            .handle(r.activity)
            .and_then(|h| live.node(h))
            .map(|n| n.audience());
        // A take or an unseat committed ends the kept holds on the part (0.135 A2): they rode out with it.
        if written && let Some(p) = part {
            let mut tree = live.frozen();
            let ask = Ask {
                soul: r.soul,
                intent: r.intent,
                at: now,
            };
            match self.unkeep(&mut tree, p, r.activity, ask) {
                Ok(()) => self.collect(Some((r.intent, r.soul))),
                Err(e) => eprintln!("worldd: a kept hold did not end at a take: {e}"),
            }
        }
        let Some(asm) = self.asm.as_mut() else {
            return;
        };
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
                if let Some(l) = self.held_load(live, part) {
                    carry.load = l;
                }
                self.carries.insert(r.activity, carry);
            }
            _ => asm.written(r.activity, r.step, false),
        }
    }

    /// The follow `activity` is over (0.135 G2: its follower's order ended): its follower leaves it, as
    /// `activity:leave` does, caused by the intent that joined, and so the leader too. Its entries wait in
    /// [`Engine::out`].
    pub fn end_follow(&mut self, live: &Tree, c: &mut Controller, activity: Id, now: Micros) {
        let Some((_, _, follower, _)) = self
            .activities
            .following()
            .into_iter()
            .find(|f| f.0 == activity)
        else {
            return;
        };
        let Some(m) = self
            .activities
            .members(activity)
            .and_then(|ms| ms.iter().find(|m| m.body == follower).cloned())
        else {
            return;
        };
        let mut tree = live.frozen();
        self.activities.next = tree.next();
        let ask = Ask {
            soul: m.soul,
            intent: m.intent,
            at: now,
        };
        if let Err(r) = self.activities.leave(
            &mut tree,
            c,
            &mut self.moves,
            &mut self.due,
            &mut self.mint,
            ask,
            follower,
            activity,
        ) {
            eprintln!("worldd: {}'s follow did not end: {r}", show(follower));
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

    /// The places still to take (0.135 G3, `sim::activity::places`), each activity's frame set from where its members
    /// stand in `c`, on their node (`sim::index::place_of`): `(activity, body, Soul, node, point, facing)`.
    pub fn pending_places(
        &mut self,
        c: &Controller,
    ) -> Vec<(Id, Id, Id, Id, Vec3, replica::pose::Quat)> {
        self.activities.pending_places(|b| {
            c.body(b)
                .map(|m| (sim::index::place_of(m).0, m.pose.position))
        })
    }

    /// Members that have taken their places (0.135 G3), by (activity, body): an activity's moves begin once all
    /// have, at `now` on a copy of `live`. Its entries wait in [`Engine::out`].
    pub fn placed(&mut self, live: &Tree, c: &mut Controller, done: &[(Id, Id)], now: Micros) {
        if done.is_empty() {
            return;
        }
        for &(a, b) in done {
            self.activities.placed(a, b);
        }
        let mut tree = live.frozen();
        self.activities.next = tree.next();
        self.begin_moves(&mut tree, c, now);
        self.collect(None);
    }

    /// Every follow running (0.135 G2): its activity, the leader's body, and the follower's body and Soul.
    pub fn following(&self) -> Vec<(Id, Id, Id, Id)> {
        self.activities.following()
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
