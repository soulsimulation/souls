//! Hands, holding and tools (Engine v2 B4, #2739): a hand holds a thing, so that a thing taken or put is never in two
//! places or in none, and a held tool lengthens the hand. No code here names a kind or a move.
//!
//! - **A hand is a resource and a slot.** A family's manipulators that name a slot (`replica::bodies::Resource`) are
//!   its hands ([`hands`]). A thing held is a child of that hand's slot of the body (`v2/docs/world-model.md` rule
//!   2): a change of parent, never a link, so it moves with the hand and ends with the body.
//! - **Take and put are moves** (B2's `crate::moves`), steered to the hand they use ([`steer`]). Their contact instant
//!   does the transfer: T1's leave and arrive under one transfer id, written in one part, so that at every position
//!   of the log the thing has exactly one parent. A move cancelled before contact transfers nothing. A transfer is
//!   written for any parent and slot ([`transfer`]), not only a hand: E4's setting down uses the same one.
//! - **What a thing occupies.** Its kind says how many hands it takes, one or two (`replica::world_model::Kind::hands`,
//!   section 18). A two-handed thing is a child of one hand's slot, and the other hand counts as full while it is held
//!   ([`free_hands`]). A thing whose kind says neither is not taken (`thing-not-carried`).
//! - **Refusals by name.** A body with no hands asking to take: `take-needs-hands`, before any claim, so it never gets
//!   an imaginary grip (`docs/design/custom-bodies.md`). Not enough free hands: `hands-full`. A put of a thing the body
//!   does not hold: `not-held`. A put target filled at the check, or filled since (at contact): `slot-occupied`, and
//!   the thing stays in the hand. A filled slot is asked of the one slot model ([`super::Slots::occupant`]): a seat a
//!   body holds is filled too. A thing gone by contact: `thing-missing`. A refusal at contact cancels the move.
//! - **A held tool's tip.** Reach is measured from the effector: the hand, or the named tip of the tool held in it
//!   (`crate::moves::Reach::tip`), so a body holding a pole presses what its bare hand cannot reach.
//! - **Before retiring.** A parent is lifetime, so a body that retires puts down what it holds first
//!   ([`Holding::put_down`]): each thing into a free slot in reach the caller names, in one part; with nowhere to put
//!   one, `retire-nowhere-to-put` and nothing changes. Retiring itself is one path, K10's `Life::retire`, which calls
//!   this first once the stacks meet; there is no second retire here.
//!
//! Not here: amounts (F4), handing to another Soul (E8), setting down where there is no slot (E4), things worn (E15),
//! carrying by two (B9: the load is a child of the carry activity's node, which nothing here prevents), throwing (N14),
//! and the route mask for a door that needs a free hand (N5).

use std::collections::{BTreeMap, BTreeSet};

use replica::bodies::{Class, Family, Want};
use replica::effects::{
    Actor, Body, Cause, Effect, Envelope, Header, Part, Refusal, Rest, TransferRec,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Id, Minter};
use replica::moves::Move;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::time::Micros;
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, show};

use super::Slots;
use crate::controller::Controller;
use crate::moves::{Fired, Instance, Moves, Reach};
use crate::timers::DueList;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// A hand: a manipulator resource, and the body's slot that holds what it holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hand {
    pub resource: Name,
    pub slot: u64,
}

/// A family's hands, in its order: its manipulators that name a slot. A beak or a trunk with a slot is a hand too.
pub fn hands(family: &Family) -> Vec<Hand> {
    family
        .resources
        .iter()
        .filter(|r| r.class == Class::Manipulator)
        .filter_map(|r| {
            r.slot.map(|slot| Hand {
                resource: r.name.clone(),
                slot,
            })
        })
        .collect()
}

/// The thing in slot `slot` of node `parent`, if any.
pub fn in_slot(tree: &Tree, parent: Id, slot: u64) -> Option<Id> {
    let h = tree.handle(parent)?;
    tree.children(h)?
        .iter()
        .filter_map(|c| tree.node(*c))
        .find(|n| n.slot() == Some(slot))
        .map(|n| n.id())
}

/// The hands a thing of kind `kind` (full name) occupies when held: 1 or 2, or none when it is not held in a hand.
pub fn occupies(rules: &Rules, kind: &str) -> Option<u8> {
    rules.kinds.get(kind).and_then(|k| k.hands)
}

/// `body`'s hands that are free: their slot holds nothing, and no two-handed thing held in another hand counts them.
pub fn free_hands(tree: &Tree, rules: &Rules, body: Id, all: &[Hand]) -> Vec<Hand> {
    let mut free = Vec::new();
    let mut second = 0usize;
    for h in all {
        match in_slot(tree, body, h.slot) {
            None => free.push(h.clone()),
            Some(t) => {
                let kind = tree.handle(t).and_then(|x| tree.node(x));
                if kind.is_some_and(|n| occupies(rules, n.kind().as_str()) == Some(2)) {
                    second += 1;
                }
            }
        }
    }
    free.truncate(free.len().saturating_sub(second));
    free
}

/// `mv` steered to `hands`: its claims of any one manipulator name these hands, in order, and a hand left over is
/// added as a claim by name (a two-handed take holds both). Other claims are kept.
pub fn steer(mv: &Move, hands: &[Name]) -> Move {
    let mut left = hands.iter();
    let mut out = mv.clone();
    for w in &mut out.claims {
        if *w == Want::One(Class::Manipulator)
            && let Some(h) = left.next()
        {
            *w = Want::Named(h.clone());
        }
    }
    out.claims.extend(left.cloned().map(Want::Named));
    out
}

/// The pose a thing arrives at in `to`: the frame's origin, held by the slot, or standing on the parent with none.
fn arrival(to: Frame) -> Pose {
    Pose {
        frame: to,
        position: Vec3::ZERO,
        orientation: Quat::IDENTITY,
        support: match to.slot {
            Some(_) => Support::Slot,
            None => Support::Surface {
                surface: to.node,
                height: 0,
            },
        },
    }
}

/// One entry of a part: the node whose system writes it, the audience, and what it writes.
pub type Entry = (Id, Audience, Body);

/// The transfer of `thing` (whose audience is `audience`) into `to`, any parent and slot: T1's leave, written by the
/// thing's entry, and the arrive, written by the new parent's, under the one id `transfer`, inside this zone.
pub fn transfer(header: &Header, thing: Id, audience: Audience, to: Frame, id: Id) -> [Entry; 2] {
    [
        (
            thing,
            audience,
            Body::Transfer(TransferRec::Leave {
                transfer: id,
                node: thing,
                lineage: header.lineage,
                zone: header.zone,
                pose: arrival(to),
            }),
        ),
        (
            to.node,
            audience,
            Body::Transfer(TransferRec::Arrive {
                transfer: id,
                carried: Vec::new(),
            }),
        ),
    ]
}

/// The zone's writer for holding: each part it commits, in order, is the log.
pub struct Log {
    pub header: Header,
    pub rules: Rules,
    /// The zone's next sequence.
    pub next: u64,
    /// Every part committed, in order.
    pub parts: Vec<Vec<Effect>>,
}

impl Log {
    pub fn new(header: Header, rules: Rules, next: u64) -> Log {
        Log {
            header,
            rules,
            next,
            parts: Vec::new(),
        }
    }

    /// Commits `entries` at `at` as one part, all or none: T2's checks at commit (a slot that does not admit the thing
    /// is `child-not-admitted`).
    pub fn write(&mut self, tree: &mut Tree, at: Micros, entries: Vec<Entry>) -> R<()> {
        let effects: Vec<Effect> = entries
            .into_iter()
            .zip(self.next..)
            .map(|((node, audience, body), sequence)| Effect {
                envelope: Envelope {
                    sequence,
                    at,
                    cause: Cause::World,
                    actor: Actor::World,
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
        .or_else(|e| refuse("encoding", e.to_string()))?;
        tree.commit(&self.header, &Part::read(&bytes)?, &self.rules)?;
        self.next += effects.len() as u64;
        self.parts.push(effects);
        Ok(())
    }
}

/// What the engine's holding works on: the tree and its writer, the seats (who holds each), the controller, the due
/// list, the minter, the moves in progress and the geometry.
pub struct Cx<'a, G: Reach> {
    pub tree: &'a mut Tree,
    pub log: &'a mut Log,
    pub slots: &'a Slots,
    pub c: &'a mut Controller,
    pub due: &'a mut DueList,
    pub mint: &'a mut Minter,
    pub moves: &'a mut Moves,
    pub geo: &'a G,
}

#[derive(Clone, Copy, Debug)]
struct Pending {
    thing: Id,
    to: Frame,
}

/// The takes and puts in progress, by their move's instance: each transfers at its contact instant.
#[derive(Default)]
pub struct Holding {
    pending: BTreeMap<Instance, Pending>,
}

fn node_of(tree: &Tree, id: Id) -> R<(Name, Audience, Option<Id>, Option<u64>)> {
    let n = tree
        .handle(id)
        .and_then(|h| tree.node(h))
        .ok_or_else(|| Refusal {
            name: "thing-missing",
            detail: show(id),
        })?;
    Ok((n.kind().clone(), n.audience(), n.parent(), n.slot()))
}

fn family(c: &Controller, body: Id) -> R<Family> {
    c.claims(body)
        .map(|b| b.family().clone())
        .ok_or_else(|| Refusal {
            name: "body-unknown",
            detail: show(body),
        })
}

impl Holding {
    pub fn new() -> Holding {
        Holding::default()
    }

    /// Takes and puts in progress.
    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Starts `mv`, steered to free hands, for `body` to take `thing` at `now`: at contact the thing becomes a child of
    /// the first of those hands' slots. Refused, with nothing changed: `take-needs-hands`, `thing-missing`,
    /// `thing-not-carried`, `hands-full`, then the move's own refusals (`out-of-reach` among them).
    pub fn take<G: Reach>(
        &mut self,
        cx: &mut Cx<'_, G>,
        body: Id,
        mv: &Move,
        thing: Id,
        now: Micros,
    ) -> R<Instance> {
        let all = hands(&family(cx.c, body)?);
        if all.is_empty() {
            return refuse("take-needs-hands", format!("{} has no hands", show(body)));
        }
        let (kind, ..) = node_of(cx.tree, thing)?;
        let Some(need) = occupies(&cx.log.rules, kind.as_str()) else {
            return refuse(
                "thing-not-carried",
                format!("{} is not held in a hand", show(thing)),
            );
        };
        let free = free_hands(cx.tree, &cx.log.rules, body, &all);
        if free.len() < usize::from(need) {
            return refuse(
                "hands-full",
                format!("{} has {} free of {need} needed", show(body), free.len()),
            );
        }
        let using: Vec<Name> = free[..usize::from(need)]
            .iter()
            .map(|h| h.resource.clone())
            .collect();
        let n = cx.moves.start(
            cx.c,
            cx.due,
            cx.mint,
            cx.geo,
            body,
            &steer(mv, &using),
            thing,
            now,
        )?;
        let to = Frame {
            node: body,
            slot: Some(free[0].slot),
        };
        self.pending.insert(n, Pending { thing, to });
        Ok(n)
    }

    /// Starts `mv`, steered to the hand that holds `thing`, for `body` to put it into `to` (a parent and its slot) at
    /// `now`. Refused, with nothing changed: `thing-missing`, `not-held`, `slot-occupied`, then the move's own.
    pub fn put<G: Reach>(
        &mut self,
        cx: &mut Cx<'_, G>,
        body: Id,
        mv: &Move,
        thing: Id,
        to: Frame,
        now: Micros,
    ) -> R<Instance> {
        let (_, _, parent, slot) = node_of(cx.tree, thing)?;
        let hand = hands(&family(cx.c, body)?)
            .into_iter()
            .find(|h| parent == Some(body) && slot == Some(h.slot));
        let Some(hand) = hand else {
            return refuse(
                "not-held",
                format!("{} holds no {}", show(body), show(thing)),
            );
        };
        occupied(cx.slots, cx.tree, to)?;
        let n = cx.moves.start(
            cx.c,
            cx.due,
            cx.mint,
            cx.geo,
            body,
            &steer(mv, &[hand.resource]),
            to.node,
            now,
        )?;
        self.pending.insert(n, Pending { thing, to });
        Ok(n)
    }

    /// Answers what a move's timer did ([`Moves::fire`]): at a take's or a put's contact the thing is transferred, in
    /// one part. A refusal then (`slot-occupied`, `thing-missing`, or T2's at commit) cancels the move, under that name,
    /// and the thing stays where it was. A move that ended before contact transfers nothing. `None` when `fired` is
    /// not a contact of a take or a put.
    pub fn fired<G: Reach>(&mut self, cx: &mut Cx<'_, G>, fired: &Fired) -> Option<R<()>> {
        let moves = &*cx.moves;
        self.pending.retain(|n, _| moves.record(*n).is_some());
        match fired {
            Fired::Phase { instance, phase: 1 } => self.pending.remove(instance).map(|p| {
                let at = cx.moves.record(*instance).map_or(0, |r| r.contact_at());
                let done = self.contact(cx, p, at);
                if let Err(r) = &done {
                    cx.moves.cancel(
                        cx.c,
                        cx.due,
                        *instance,
                        at,
                        Name::new(r.name).unwrap_or_else(|| unreachable!("a refusal's name")),
                    );
                }
                done
            }),
            _ => None,
        }
    }

    fn contact<G: Reach>(&mut self, cx: &mut Cx<'_, G>, p: Pending, at: Micros) -> R<()> {
        let (_, audience, ..) = node_of(cx.tree, p.thing)?;
        occupied(cx.slots, cx.tree, p.to)?;
        let id = cx.mint.mint().map_err(|e| Refusal {
            name: "id-counter-exhausted",
            detail: e.to_string(),
        })?;
        let entries = transfer(&cx.log.header, p.thing, audience, p.to, id).to_vec();
        cx.log.write(cx.tree, at, entries)
    }

    /// Puts down everything `body` holds at `at`, before it retires: each thing into the first free slot of `down`
    /// (slots in reach, the caller's), in one part, written only when it holds something. Refused with nothing changed:
    /// `retire-nowhere-to-put` when a held thing has no free slot left, or T2's refusal at commit. K10's
    /// `Life::retire` calls this first, then retires the body by its one path.
    pub fn put_down<G: Reach>(
        &mut self,
        cx: &mut Cx<'_, G>,
        body: Id,
        down: &[Frame],
        at: Micros,
    ) -> R<()> {
        let all =
            cx.c.claims(body)
                .map(|b| hands(b.family()))
                .unwrap_or_default();
        let mut used = BTreeSet::new();
        let mut entries = Vec::new();
        for h in &all {
            let Some(thing) = in_slot(cx.tree, body, h.slot) else {
                continue;
            };
            let to = down
                .iter()
                .enumerate()
                .find(|(i, f)| !used.contains(i) && cx.slots.occupant(cx.tree, **f).is_none());
            let Some((i, to)) = to else {
                return refuse(
                    "retire-nowhere-to-put",
                    format!("{} holds {}", show(body), show(thing)),
                );
            };
            used.insert(i);
            let (_, audience, ..) = node_of(cx.tree, thing)?;
            let id = cx.mint.mint().map_err(|e| Refusal {
                name: "id-counter-exhausted",
                detail: e.to_string(),
            })?;
            entries.extend(transfer(&cx.log.header, thing, audience, *to, id));
        }
        if entries.is_empty() {
            return Ok(());
        }
        cx.log.write(cx.tree, at, entries)
    }
}

/// `slot-occupied` when `to` names a slot someone or something is in, asked of the one slot model: a seat a body
/// holds, or a slot the tree holds a thing in.
fn occupied(slots: &Slots, tree: &Tree, to: Frame) -> R<()> {
    match slots.occupant(tree, to) {
        Some(t) => refuse(
            "slot-occupied",
            format!("slot {:?} of {} holds {}", to.slot, show(to.node), show(t)),
        ),
        None => Ok(()),
    }
}
