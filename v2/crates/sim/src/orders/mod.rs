//! Orders the agent wrote (Engine v2 B7, #2726; `v2/docs/intents.md` rules 5 and 7): a held stance, follow, and
//! standing in a queue. The world keeps doing the one thing an order names, and nothing the agent did not write.
//!
//! - **One intent starts one.** [`Orders::accept`] reads an order intent and starts its skill (`skills::orders`) on
//!   the body under a driver of its own, claiming what the skill's shape claims (B1, T9). Its record is an entry on
//!   the body carrying K13b's [`ORDER`] event (`{1: intent, 2: verb, 3: target node, 4: [0, 0, 0], 5: expiry}`) with
//!   the intent itself as field 6, so the log alone hands it back after a restart ([`Orders::resume`]).
//! - **Ends, each a named effect** (K13b's [`ORDER_ENDED`]): [`EXPIRED`] at its expiry, [`CANCELLED`] by a
//!   `souls:cancel` naming its sequence, [`REPLACED`] by an intent whose field 10 names it, [`TARGET_GONE`] when the
//!   leader or the slot is gone, and [`DISPLACED`] when another claim took what it held (B2's cancel rules: a body
//!   that walks away has left its queue). A queue's head that took its slot ends [`DONE`].
//! - **Every input it produces is logged** as an entry on the body whose cause is the order's intent and whose actor
//!   is the order's Soul: each controller input of its skill when it changes ([`INPUT`]), the stance a hold sets, and
//!   the act a queue's head takes ([`TAKE`]).
//! - **Refused by name:** an order with no expiry ([`NO_EXPIRY`]: 0 or the end of time), one longer than [`LONGEST`],
//!   any verb outside the closed list (`order-unknown`: there is no order that waits for a time or a condition), and
//!   a parameter the order's kind does not have (`order-parameter-unknown`, a condition smuggled as one among them).
//!
//! **The line** (standing in a queue). One line per slot, owned by the world: bodies in arrival order (the order in
//! which their intents were accepted, never by id), each at its own spot, [`PITCH`] apart, going back from the slot's
//! stand point away from the slot. As N9's places, a spot is kept only on walkable ground ([`Ground::stand`]) and
//! never in a doorway or on a stair ([`Ground::passage`]). The world gives each body its spot in the field
//! [`F_LINE`]; when one leaves, the rest move up. When the slot frees, the world says so ([`Orders::freed`]): that
//! change wakes the line, nothing polls the slot. The head then walks onto the stand point and takes the slot by the
//! act its order names, once ([`Take`]); the world commits it (B3) and the next body is the head. A bare queue (no act
//! named) keeps the head spot and takes nothing: what to do there is the agent's.
//!
//! Not here: the gateway's path from an arriving intent (I4 hands an order here), ranked fallbacks (I5), plans (I9),
//! reflexes (R9), a ride's boarding point (E7).

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;

use replica::effects::{
    Actor, Body as Entry, Cause, Effect, Envelope, Event, Part, Refusal, Rest, read_id,
};
use replica::encode::{Name, Value, encode};
use replica::host::{Answer, Ask, Seen, Skill};
use replica::ids::{Id, Minter, Scope};
use replica::intents::{CANCEL, Intent, Kind, Target as Aim};
use replica::pose::{ControllerInput, Vec3};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::{Audience, show};
use skills::orders::{F_LINE, FOLLOW, HOLD, Hold, QUEUE, Queue, follow};

use crate::controller::{Controller, Driver, Part as Set, Stance};
use crate::host::restart::{self, ORDER, ORDER_ENDED};
use crate::host::{Geometry, Run, hand_on, step};
use crate::spots::{Ground, PITCH};
use crate::walk::node_of;

type R<T> = Result<T, Refusal>;

/// The longest an order may run, µs of world time: one hour, the silence after which the world winds a body down
/// (B16). `v2/docs/intents.md` states none; proposed here.
pub const LONGEST: Micros = 3_600_000_000;
/// A follow's band when the intent names none, µm: nearest and furthest along the leader's trail.
pub const BAND: (i64, i64) = (1_000_000, 2_500_000);
/// The farthest a follow's place may be from its leader, µm, beside or at an offset on either axis: well past a crew's
/// widest span, and far from where a step's sum could overflow.
pub const PLACE_MOST: i64 = 20_000_000;
/// The farthest a turning follow's goal may be from the frame's origin on either axis, µm: far past any world, and far
/// from where a distance to it could overflow.
pub const GOAL_MOST: u64 = 1 << 50;
/// A queue's head counts as on the stand point this near, µm.
pub const ARRIVED: i64 = 50_000;
/// The most spots tried along a line.
pub const LINE_MOST: i64 = 512;

/// The refusal of an order with no expiry.
pub const NO_EXPIRY: &str = "order-without-expiry";
/// The ends of an order, each the reason of its [`ORDER_ENDED`] effect.
pub const EXPIRED: &str = "souls:order-expired";
pub const CANCELLED: &str = "souls:order-cancelled";
pub const REPLACED: &str = "souls:order-replaced";
pub const TARGET_GONE: &str = "souls:order-target-gone";
pub const DISPLACED: &str = "souls:order-displaced";
/// A queue's head took its slot.
pub const DONE: &str = "souls:done";
/// An input an order produced: `{1: intent, 2: velocity [x, y, z] µm/s}` or `{1: intent, 3: stance}`.
pub const INPUT: &str = "souls:order-input";
/// The act a queue's head took: `{1: intent, 2: slot's thing, 3: act}`.
pub const TAKE: &str = "souls:order-take";

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

fn named(t: &str) -> Name {
    Name::new(t).unwrap_or_else(|| unreachable!("a fixed name"))
}

fn int(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

fn read_int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

fn xyz(p: Vec3) -> Value {
    Value::Array(vec![int(p.x), int(p.y), int(p.z)])
}

/// What an order keeps doing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum What {
    /// Hold `stance` (parameter 1: 1 stand, 2 sit, 3 lie) and the hands named (parameter 2).
    Hold { stance: Stance, hands: Vec<Name> },
    /// Follow `leader` (the target) within `band` µm (parameters 1 and 2), or keep a place `beside` it, that many µm
    /// to its side (parameter 3, 0.135 R1: walking hand in hand), or a place `at` an offset from it on the plan
    /// (parameter 4, `[x, z]` µm: carrying together, `v2/docs/moving-group.md` rule 3), turning as the leader nears
    /// its goal when parameter 5 names it and the offset there (`[goal x, goal z, x, z]` µm: a crew turned with its
    /// front).
    Follow {
        leader: Id,
        band: (i64, i64),
        beside: Option<i64>,
        at: Option<[i64; 2]>,
        turn: Option<([i64; 2], [i64; 2])>,
    },
    /// Stand in line for the slot of `slot` (the target), and take it at the head by `act` (parameter 1), if named.
    Queue { slot: Id, act: Option<Name> },
}

/// An order as accepted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub intent: Id,
    pub actor: Actor,
    pub sequence: u64,
    pub body: Id,
    pub what: What,
    pub expires: Micros,
    /// The intent as received, kept in the order's record.
    pub source: Intent,
}

/// A slot where it is, as a line reads it: its floor, its stand point and its own point (µm, the floor's frame).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SlotAt {
    pub floor: Id,
    pub stand: Vec3,
    pub point: Vec3,
}

/// The world as orders read it: N9's ground, and the slots that are there.
pub trait Where: Ground {
    fn slot(&self, thing: Id) -> Option<SlotAt>;
}

/// A queue's head taking its slot by the act its order names: the world commits it (B3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Take {
    pub intent: Id,
    pub body: Id,
    pub slot: Id,
    pub act: Name,
}

struct Open {
    order: Order,
    driver: Driver,
    last: Option<ControllerInput>,
}

struct Line {
    at: SlotAt,
    /// In arrival order; the first is the head.
    bodies: Vec<Id>,
    /// The slot freed and no one has taken it since.
    free: bool,
}

/// Reads an order from `intent` (minted `id`) at world time `now`, or refuses it by name.
pub fn read(intent: &Intent, id: Id, now: Micros) -> R<Order> {
    let verb = intent.verb.as_str();
    match intent.kind()? {
        Kind::Order => {}
        _ => return refuse("order-unknown", verb.to_owned()),
    }
    if intent.expiry <= 0 || intent.expiry == Micros::MAX {
        return refuse(NO_EXPIRY, "an order ends at a world time");
    }
    if intent.expiry <= now {
        return refuse("order-expired", format!("at {} µs", intent.expiry));
    }
    if intent.expiry - now > LONGEST {
        return refuse(
            "order-expiry-too-long",
            format!("at most {LONGEST} µs from now"),
        );
    }
    let body = match (intent.actor, intent.body) {
        (Actor::Soul(s), b) => b.unwrap_or(s),
        (Actor::Creator(_), Some(b)) => b,
        _ => return refuse("order-without-body", verb.to_owned()),
    };
    let p = &intent.parameters;
    let has = |keys: &[u64]| match p.keys().find(|k| !keys.contains(k)) {
        Some(k) => refuse(
            "order-parameter-unknown",
            format!("{verb} has no parameter {k}; an order holds no time and no condition"),
        ),
        None => Ok(()),
    };
    let bad = |what: &str| refuse("order-parameter-bad", format!("{verb}: {what}"));
    let node = || match &intent.target {
        Some(Aim::Node(n)) => Ok(*n),
        _ => refuse("order-target-not-a-node", verb.to_owned()),
    };
    let what = match verb {
        HOLD => {
            has(&[1, 2])?;
            let stance = match p.get(&1) {
                None | Some(Value::Uint(1)) => Stance::Stand,
                Some(Value::Uint(2)) => Stance::Sit,
                Some(Value::Uint(3)) => Stance::Lie,
                _ => return bad("a stance is 1, 2 or 3"),
            };
            let hands = match p.get(&2) {
                None => Vec::new(),
                Some(Value::Array(a)) => {
                    let mut hands = Vec::new();
                    for h in a {
                        match h {
                            Value::Text(n) => hands.push(n.clone()),
                            _ => return bad("a hand is a resource's name"),
                        }
                    }
                    hands
                }
                _ => return bad("hands are a list"),
            };
            What::Hold { stance, hands }
        }
        FOLLOW => {
            has(&[1, 2, 3, 4, 5])?;
            let near = p.get(&1).map_or(Some(BAND.0), read_int);
            let far = p.get(&2).map_or(Some(BAND.1), read_int);
            let beside = match p.get(&3).map(read_int) {
                None => None,
                Some(Some(w)) if w > 0 && w <= PLACE_MOST => Some(w),
                Some(_) => return bad("a place beside is a width over 0, µm, at most 20 m"),
            };
            let at = match p.get(&4) {
                None => None,
                Some(Value::Array(a)) => match a.iter().map(read_int).collect::<Option<Vec<_>>>() {
                    Some(v)
                        if v.len() == 2
                            && beside.is_none()
                            && v.iter()
                                .all(|c| c.unsigned_abs() <= PLACE_MOST.unsigned_abs()) =>
                    {
                        Some([v[0], v[1]])
                    }
                    _ => {
                        return bad(
                            "a place at is [x, z] µm from the leader, each at most 20 m, and not beside",
                        );
                    }
                },
                Some(_) => return bad("a place at is [x, z] µm from the leader"),
            };
            let turn = match p.get(&5) {
                None => None,
                Some(Value::Array(a)) => match a.iter().map(read_int).collect::<Option<Vec<_>>>() {
                    Some(v)
                        if v.len() == 4
                            && at.is_some()
                            && v[0].unsigned_abs() <= GOAL_MOST
                            && v[1].unsigned_abs() <= GOAL_MOST
                            && v[2].unsigned_abs() <= PLACE_MOST.unsigned_abs()
                            && v[3].unsigned_abs() <= PLACE_MOST.unsigned_abs() =>
                    {
                        Some(([v[0], v[1]], [v[2], v[3]]))
                    }
                    _ => {
                        return bad(
                            "a turn is [goal x, goal z, x, z] µm, the place at the goal at most 20 m from the leader, with a place at",
                        );
                    }
                },
                Some(_) => return bad("a turn is [goal x, goal z, x, z] µm"),
            };
            match (near, far) {
                (Some(n), Some(f)) if 0 <= n && n <= f => What::Follow {
                    leader: node()?,
                    band: (n, f),
                    beside,
                    at,
                    turn,
                },
                _ => return bad("a band is 0 <= nearest <= furthest, µm"),
            }
        }
        QUEUE => {
            has(&[1])?;
            let act = match p.get(&1) {
                None => None,
                Some(Value::Text(n)) => Some(n.clone()),
                _ => return bad("the act at the head is a verb"),
            };
            What::Queue { slot: node()?, act }
        }
        _ => return refuse("order-unknown", verb.to_owned()),
    };
    Ok(Order {
        intent: id,
        actor: intent.actor,
        sequence: intent.sequence,
        body,
        what,
        expires: intent.expiry,
        source: intent.clone(),
    })
}

/// The open orders, their skills, the lines, and the order effects written, in order.
pub struct Orders {
    open: BTreeMap<Id, Open>,
    runs: Vec<Run>,
    lines: BTreeMap<Id, Line>,
    /// Each queueing body's spot ([`F_LINE`]), as its skill reads it.
    fields: BTreeMap<Id, BTreeMap<u64, Value>>,
    /// The effects written, in order: each order's record, inputs and end.
    pub log: Vec<Effect>,
    sequence: u64,
    tree: Tree,
    minter: Minter,
}

impl Default for Orders {
    fn default() -> Orders {
        Orders::new()
    }
}

/// The world a tick's order skills read: the controller's bodies and the lines' fields.
struct Seeing<'a> {
    c: &'a Controller,
    fields: &'a BTreeMap<Id, BTreeMap<u64, Value>>,
}

impl Geometry for Seeing<'_> {
    fn ask(&self, _: Id, _: &Ask) -> Option<Answer> {
        None
    }

    fn read(&self, node: Id) -> Option<Seen> {
        let (b, _) = self.c.seen(node)?;
        Some(Seen {
            id: node,
            kind: named("souls:body"),
            parent: Some(node_of(b)),
            position: b.pose.position,
            fields: self.fields.get(&node).cloned().unwrap_or_default(),
        })
    }
}

fn isqrt(n: i128) -> i128 {
    if n <= 0 { 0 } else { n.isqrt() }
}

fn apart(a: Vec3, b: Vec3) -> i64 {
    let (dx, dz) = (i128::from(b.x - a.x), i128::from(b.z - a.z));
    i64::try_from(isqrt(dx * dx + dz * dz)).unwrap_or(i64::MAX)
}

impl Orders {
    pub fn new() -> Orders {
        let mut minter = Minter::new(Scope([0xb7; 16]));
        let root = minter
            .mint()
            .unwrap_or_else(|_| unreachable!("a fresh scope"));
        Orders {
            open: BTreeMap::new(),
            runs: Vec::new(),
            lines: BTreeMap::new(),
            fields: BTreeMap::new(),
            log: Vec::new(),
            sequence: 0,
            tree: Tree::start(root, named("souls:orders")),
            minter,
        }
    }

    /// The open order on `body`, if any.
    pub fn open(&self, body: Id) -> Option<&Order> {
        self.open.get(&body).map(|o| &o.order)
    }

    /// Every open order, by body.
    pub fn opened(&self) -> impl Iterator<Item = &Order> {
        self.open.values().map(|o| &o.order)
    }

    /// The line for the slot of `slot`, head first.
    pub fn line(&self, slot: Id) -> Vec<Id> {
        self.lines
            .get(&slot)
            .map(|l| l.bodies.clone())
            .unwrap_or_default()
    }

    /// The spot `body` was given in its line, if any (µm, its floor's frame).
    pub fn spot(&self, body: Id) -> Option<Vec3> {
        let Value::Array(a) = self.fields.get(&body)?.get(&F_LINE)? else {
            return None;
        };
        match a.iter().filter_map(read_int).collect::<Vec<_>>()[..] {
            [x, y, z] => Some(Vec3::new(x, y, z)),
            _ => None,
        }
    }

    fn write(&mut self, o: &Order, at: Micros, name: &str, fields: Vec<(u64, Value)>) {
        let ev = Event {
            name: named(name),
            fields: fields.into_iter().collect(),
            changes: Vec::new(),
            rest: Rest::new(),
        };
        self.entry(o, at, ev);
    }

    fn entry(&mut self, o: &Order, at: Micros, ev: Event) {
        self.log.push(Effect {
            envelope: Envelope {
                sequence: self.sequence,
                at,
                cause: Cause::Intent(o.intent),
                actor: o.actor,
                audience: Audience::Everyone,
                node: o.body,
            },
            body: Entry::Changes(Vec::new()),
            events: Some(vec![ev]),
            rest: Rest::new(),
        });
        self.sequence += 1;
    }

    /// Accepts `intent` (minted `id`) at `now`: a cancel ends the actor's order it names (`order-not-open` when none
    /// is open); an order is read ([`read`]), ends the one its field 10 names, and starts. A refusal changes nothing.
    pub fn accept(
        &mut self,
        c: &mut Controller,
        w: &dyn Where,
        intent: &Intent,
        id: Id,
        now: Micros,
    ) -> R<()> {
        let named_open = |s: &Orders, seq: Option<u64>| {
            s.open
                .values()
                .find(|o| o.order.actor == intent.actor && Some(o.order.sequence) == seq)
                .map(|o| o.order.body)
        };
        if intent.verb.as_str() == CANCEL {
            let Some(body) = named_open(self, intent.replaces) else {
                return refuse("order-not-open", format!("sequence {:?}", intent.replaces));
            };
            self.end(c, w, body, CANCELLED, now);
            return Ok(());
        }
        let order = read(intent, id, now)?;
        self.check(c, w, &order)?;
        if let Some(body) = named_open(self, intent.replaces) {
            self.end(c, w, body, REPLACED, now);
        }
        self.begin(c, w, order, now, true)
    }

    /// What must hold for `o` to start: its target is there.
    fn check(&self, c: &Controller, w: &dyn Where, o: &Order) -> R<()> {
        if c.body(o.body).is_none() {
            return refuse("body-unknown", show(o.body));
        }
        match &o.what {
            What::Follow { leader, .. } if c.body(*leader).is_none() => {
                refuse("order-target-gone", show(*leader))
            }
            What::Queue { slot, .. } if w.slot(*slot).is_none() => {
                refuse("order-target-gone", show(*slot))
            }
            _ => Ok(()),
        }
    }

    fn begin(
        &mut self,
        c: &mut Controller,
        w: &dyn Where,
        order: Order,
        now: Micros,
        record: bool,
    ) -> R<()> {
        let (body, until) = (order.body, order.expires);
        let skill: Box<dyn Skill> = match &order.what {
            What::Hold { hands, .. } => Box::new(Hold {
                hands: hands.clone(),
                until,
            }),
            What::Follow {
                leader,
                band,
                beside,
                at,
                turn,
            } => Box::new(follow(*leader, *band, *beside, *at, *turn, until)),
            What::Queue { .. } => Box::new(Queue { until }),
        };
        let driver = c.claim(body, &skill.shape())?;
        if record {
            let to = match &order.what {
                What::Hold { .. } => body,
                What::Follow { leader, .. } => *leader,
                What::Queue { slot, .. } => *slot,
            };
            let mut ev = restart::Order {
                intent: order.intent,
                body,
                skill: order.source.verb.clone(),
                to,
                goal: Vec3::ZERO,
                expires: until,
            }
            .event();
            let mut source = order.source.clone();
            if matches!(source.actor, Actor::Soul(_)) {
                source.body = None;
            }
            ev.fields.insert(6, source.to_value());
            self.entry(&order, now, ev);
        }
        // The claim cancelled any order this body held before (B2): it ends now, displaced.
        self.sweep(c, w, now);
        if let What::Hold { stance, .. } = &order.what {
            c.set(body, driver, Set::Stance(*stance))?;
            let n = match stance {
                Stance::Stand => 1,
                Stance::Sit => 2,
                Stance::Lie => 3,
            };
            self.write(
                &order,
                now,
                INPUT,
                vec![(1, order.intent.to_value()), (3, Value::Uint(n))],
            );
        }
        if let What::Queue { slot, .. } = &order.what {
            let slot = *slot;
            if let Some(at) = w.slot(slot) {
                self.lines
                    .entry(slot)
                    .or_insert(Line {
                        at,
                        bodies: Vec::new(),
                        free: false,
                    })
                    .bodies
                    .push(body);
                self.place(w, slot);
            }
        }
        self.runs.push(Run {
            body,
            driver,
            skill,
        });
        self.open.insert(
            body,
            Open {
                order,
                driver,
                last: None,
            },
        );
        Ok(())
    }

    /// Gives each body in the slot's line its spot: back from the stand point, away from the slot, a pitch apart, on
    /// walkable ground and never in a doorway or on a stair. A head walking in to take the slot keeps the stand point.
    fn place(&mut self, w: &dyn Where, slot: Id) {
        let Some(l) = self.lines.get(&slot) else {
            return;
        };
        let SlotAt {
            floor,
            stand,
            point,
        } = l.at;
        let (dx, dz) = (i128::from(stand.x - point.x), i128::from(stand.z - point.z));
        let len = isqrt(dx * dx + dz * dz);
        let (ux, uz) = if len == 0 { (0, 1) } else { (dx, dz) };
        let len = len.max(1);
        let mut spots = Vec::new();
        let mut k = 1;
        while spots.len() < l.bodies.len() && k <= LINE_MOST {
            let d = i128::from(PITCH) * i128::from(k);
            let off = |u: i128| i64::try_from(u * d / len).unwrap_or(0);
            let p = Vec3::new(stand.x + off(ux), stand.y, stand.z + off(uz));
            if !w.passage(floor, p)
                && let Some((on, _)) = w.stand(floor, p)
            {
                spots.push(on);
            }
            k += 1;
        }
        let walking_in = l.free && self.head_takes(slot);
        for (i, b) in l.bodies.clone().into_iter().enumerate() {
            let to = if i == 0 && walking_in {
                Some(stand)
            } else {
                spots.get(i).copied()
            };
            let f = self.fields.entry(b).or_default();
            match to {
                Some(p) => f.insert(F_LINE, xyz(p)),
                None => f.remove(&F_LINE),
            };
        }
    }

    /// Whether the slot's head has an act to take it by.
    fn head_takes(&self, slot: Id) -> bool {
        let Some(head) = self.lines.get(&slot).and_then(|l| l.bodies.first()) else {
            return false;
        };
        matches!(
            self.open.get(head).map(|o| &o.order.what),
            Some(What::Queue { act: Some(_), .. })
        )
    }

    /// Ends `body`'s open order by `reason`, written as its [`ORDER_ENDED`] effect: its skill stops, its driver is
    /// released, and it leaves its line, the rest moving up.
    fn end(&mut self, c: &mut Controller, w: &dyn Where, body: Id, reason: &str, now: Micros) {
        let Some(o) = self.open.remove(&body) else {
            return;
        };
        self.runs
            .retain(|r| !(r.body == body && r.driver == o.driver));
        let _ = c.release(body, o.driver);
        if let What::Queue { slot, .. } = o.order.what {
            if let Some(f) = self.fields.get_mut(&body) {
                f.remove(&F_LINE);
            }
            if let Some(l) = self.lines.get_mut(&slot) {
                l.bodies.retain(|b| *b != body);
                if l.bodies.is_empty() {
                    self.lines.remove(&slot);
                } else {
                    self.place(w, slot);
                }
            }
        }
        let ev = restart::ended(o.order.intent, reason);
        self.entry(&o.order, now, ev);
    }

    /// Ends each order whose driver no longer holds its claim: another claim took it (B2).
    fn sweep(&mut self, c: &mut Controller, w: &dyn Where, now: Micros) {
        let gone: Vec<Id> = self
            .open
            .iter()
            .filter(|(b, o)| {
                !c.claims(**b)
                    .is_some_and(|cl| cl.running().contains_key(&o.driver))
            })
            .map(|(b, _)| *b)
            .collect();
        for b in gone {
            self.end(c, w, b, DISPLACED, now);
        }
    }

    /// The slot of `slot` freed: the line wakes, and its head walks onto the stand point to take it.
    pub fn freed(&mut self, w: &dyn Where, slot: Id) {
        if let Some(l) = self.lines.get_mut(&slot) {
            l.free = true;
            self.place(w, slot);
        }
    }

    /// The slot of `slot` was taken by someone outside the line: the head goes back to its spot.
    pub fn taken(&mut self, w: &dyn Where, slot: Id) {
        if let Some(l) = self.lines.get_mut(&slot) {
            l.free = false;
            self.place(w, slot);
        }
    }

    /// One tick of the orders at `now`, before the controller steps: the ends that are due (expiry, displacement,
    /// target gone), the heads that take their freed slots, then each order's skill stepped and its inputs handed to
    /// the controller and logged. Returns the takes, for the world to commit.
    pub fn step(&mut self, c: &mut Controller, w: &dyn Where, now: Micros) -> Vec<Take> {
        self.sweep(c, w, now);
        let due: Vec<(Id, &'static str)> = self
            .open
            .iter()
            .filter_map(|(b, o)| {
                let gone = match &o.order.what {
                    What::Hold { .. } => false,
                    What::Follow { leader, .. } => c.body(*leader).is_none(),
                    What::Queue { slot, .. } => w.slot(*slot).is_none(),
                };
                if now >= o.order.expires {
                    Some((*b, EXPIRED))
                } else if gone {
                    Some((*b, TARGET_GONE))
                } else {
                    None
                }
            })
            .collect();
        for (b, reason) in due {
            self.end(c, w, b, reason, now);
        }
        let mut takes = Vec::new();
        let free: Vec<Id> = self
            .lines
            .iter()
            .filter(|(_, l)| l.free)
            .map(|(s, _)| *s)
            .collect();
        for slot in free {
            let Some((head, stand)) = self
                .lines
                .get(&slot)
                .and_then(|l| Some((*l.bodies.first()?, l.at.stand)))
            else {
                continue;
            };
            let Some(Open { order, .. }) = self.open.get(&head) else {
                continue;
            };
            let What::Queue { act: Some(act), .. } = &order.what else {
                continue;
            };
            let there = c
                .body(head)
                .is_some_and(|b| apart(b.pose.position, stand) <= ARRIVED);
            if !there {
                continue;
            }
            let (order, act) = (order.clone(), act.clone());
            self.write(
                &order,
                now,
                TAKE,
                vec![
                    (1, order.intent.to_value()),
                    (2, slot.to_value()),
                    (3, Value::Text(act.clone())),
                ],
            );
            if let Some(l) = self.lines.get_mut(&slot) {
                l.free = false;
            }
            self.end(c, w, head, DONE, now);
            takes.push(Take {
                intent: order.intent,
                body: head,
                slot,
                act,
            });
        }
        let staged = {
            let seeing = Seeing {
                c,
                fields: &self.fields,
            };
            step(
                &self.tree,
                &seeing,
                now,
                1,
                &mut self.minter,
                &mut self.runs,
            )
        };
        for (b, p) in &staged.ended {
            let reason = match p {
                replica::host::Progress::Failed(n) => n.as_str().to_owned(),
                _ => EXPIRED.to_owned(),
            };
            self.end(c, w, *b, &reason, now);
        }
        let _ = hand_on(&staged, c);
        for (b, d, input) in &staged.controls {
            let Some(o) = self.open.get_mut(b) else {
                continue;
            };
            if o.driver != *d || o.last == Some(*input) {
                continue;
            }
            o.last = Some(*input);
            let order = o.order.clone();
            self.write(
                &order,
                now,
                INPUT,
                vec![(1, order.intent.to_value()), (2, xyz(input.velocity))],
            );
        }
        takes
    }

    /// After a restart: each order of the three kinds that `parts` (the log, in order) hold as accepted and not ended
    /// is handed to its skill again from where its body stands, in log order (so a line keeps its arrival order), or
    /// ended by name: expired by `now`, or its start refused. Returns the intents handed back.
    pub fn resume(
        &mut self,
        c: &mut Controller,
        w: &dyn Where,
        parts: &[Part],
        now: Micros,
    ) -> R<Vec<Id>> {
        let mut sources: BTreeMap<Id, Intent> = BTreeMap::new();
        for e in parts.iter().flat_map(|p| &p.effects) {
            for ev in e.events.iter().flatten() {
                if ev.name.as_str() != ORDER {
                    continue;
                }
                let (Some(id), Some(v)) = (ev.fields.get(&1), ev.fields.get(&6)) else {
                    continue;
                };
                let bytes = encode(v).map_err(|e| Refusal {
                    name: "order-bad",
                    detail: e.to_string(),
                })?;
                sources.insert(read_id(id)?, Intent::read(&bytes)?);
            }
        }
        let mut back = Vec::new();
        for o in restart::active(parts)? {
            let Some(intent) = sources.get(&o.intent) else {
                continue;
            };
            let mut order = match read(intent, o.intent, now) {
                Ok(order) => order,
                Err(r) => {
                    let gone = Order {
                        intent: o.intent,
                        actor: intent.actor,
                        sequence: intent.sequence,
                        body: o.body,
                        what: What::Hold {
                            stance: Stance::Stand,
                            hands: Vec::new(),
                        },
                        expires: o.expires,
                        source: intent.clone(),
                    };
                    let reason = if o.expires <= now { EXPIRED } else { r.name };
                    let ev = restart::ended(o.intent, reason);
                    self.entry(&gone, now, ev);
                    continue;
                }
            };
            order.body = o.body; // The trusted logged body, not a client-selected wire field.
            let started = self
                .check(c, w, &order)
                .and_then(|()| self.begin(c, w, order.clone(), now, false));
            match started {
                Ok(()) => back.push(o.intent),
                Err(r) => {
                    let ev = restart::ended(o.intent, r.name);
                    self.entry(&order, now, ev);
                }
            }
        }
        Ok(back)
    }
}

/// The reason an [`ORDER_ENDED`] event names, if `ev` is one.
pub fn end_reason(ev: &Event) -> Option<&str> {
    if ev.name.as_str() != ORDER_ENDED {
        return None;
    }
    match ev.fields.get(&2) {
        Some(Value::Text(n)) => Some(n.as_str()),
        _ => None,
    }
}
