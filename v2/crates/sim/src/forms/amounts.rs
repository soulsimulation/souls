//! Amounts, take and put, make and remove (Engine v2 F4, #2769): what each of a form's effects writes, worked out at
//! the effect's instant against the tree as of the tick's start and the entries the forms wrote since ([`View`]), so
//! two effects in one tick never read the same stale amount or the same free slot. No code here names a kind.
//!
//! - **Amounts** are whole numbers in the field's unit, with the least and the capacity its kind gives (K3 section 3,
//!   [`replica::kinds::Field`]). A transfer works out one number, the least of what was asked, what the source has
//!   above its least and the room the target has left, and writes the source's set (minus it) and the target's (plus
//!   it), each with its signed `by`, as two entries of one part: the tree's balance check sums them to zero. Nothing
//!   to move is refused `nothing-to-move`.
//! - **Take and put** are B4's transfer ([`crate::slots::transfer`], called, not edited): T1's leave and arrive under
//!   one transfer id, into a free hand of the body or a slot of the node.
//! - **Make** creates a thing of a kind into a free hand of the body or a slot of the node, written by its parent's
//!   entry; a place that is not free is refused (`hands-full`, `slot-occupied`). It writes nothing about how long the
//!   thing lasts: that is its kind's data (F10).
//! - **Remove** takes only a thing the node contains or the body holds (`not-held` otherwise), written by its own
//!   entry; its subtree goes with it (T2).
//!
//! Not here: a source whose amount changes with time (F5's timed fields are not transferred), a thing made or set down
//! where there is no slot (E4), the second hand a two-handed thing fills (B4's `free_hands` reads the zone's rules).

use std::collections::BTreeMap;

use replica::effects::{Body, Change, ChangeRec, Effect, Header, Refusal, Rest, TransferRec};
use replica::encode::{Name, Value};
use replica::ids::{Id, Minter};
use replica::kinds::Kinds;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::tree::Tree;
use replica::world_model::{Audience, plain, show};
use skills::form_runner::{Amount, Effect as Bound, Of, Place};

use crate::slots::{Entry, in_slot, transfer};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// An amount field as its kind gives it: its default, its least and its capacity, in its unit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limit {
    pub default: i64,
    pub min: Option<i64>,
    pub max: Option<i64>,
}

/// The amount fields of every kind loaded, by the kind's full name and the field's number.
pub type Limits = BTreeMap<String, BTreeMap<u64, Limit>>;

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

fn value(n: i64) -> Value {
    match u64::try_from(n) {
        Ok(u) => Value::Uint(u),
        Err(_) => Value::Nint(n.unsigned_abs() - 1),
    }
}

/// The amount fields of `kinds`: each `int` field, with its default, least and capacity.
pub fn limits(kinds: &Kinds) -> Limits {
    kinds
        .admits()
        .keys()
        .filter_map(|k| kinds.get(k))
        .map(|def| {
            let fields = def
                .state
                .iter()
                .filter_map(|(n, f)| {
                    let default = int(&f.default)?;
                    Some((
                        *n,
                        Limit {
                            default,
                            min: f.min,
                            max: f.max,
                        },
                    ))
                })
                .collect();
            (def.name.as_str().to_owned(), fields)
        })
        .collect()
}

/// The tree as of the tick's start, and the entries written since, latest last.
pub(super) struct View<'a> {
    pub tree: &'a Tree,
    pub out: &'a [Effect],
}

impl View<'_> {
    fn changes(&self) -> impl Iterator<Item = &Change> {
        self.out.iter().rev().flat_map(|e| match &e.body {
            Body::Changes(c) => c.iter().rev().map(|c| &c.change).collect::<Vec<_>>(),
            _ => Vec::new(),
        })
    }

    /// Where `node` is: its parent and slot, or `None` once removed (or never there).
    pub fn at(&self, node: Id) -> Option<Frame> {
        for e in self.out.iter().rev() {
            match &e.body {
                Body::Transfer(TransferRec::Leave { node: n, pose, .. }) if *n == node => {
                    return Some(pose.frame);
                }
                Body::Changes(cs) => {
                    for c in cs.iter().rev() {
                        match &c.change {
                            Change::Remove { node: n } if *n == node => return None,
                            Change::Create { node: n, pose, .. }
                            | Change::Reparent { node: n, pose, .. }
                                if *n == node =>
                            {
                                return Some(pose.frame);
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        let n = self.tree.node(self.tree.handle(node)?)?;
        Some(Frame {
            node: n.parent()?,
            slot: n.slot(),
        })
    }

    /// Whether `node` is `thing` or under it.
    pub fn within(&self, node: Id, thing: Id) -> bool {
        let mut at = Some(node);
        for _ in 0..64 {
            match at {
                Some(n) if n == thing => return true,
                Some(n) => at = self.at(n).map(|f| f.node),
                None => return false,
            }
        }
        false
    }

    /// Whether the entries written since remove `node`, or a node it is under.
    pub fn removed(&self, node: Id) -> bool {
        let mut n = node;
        for _ in 0..64 {
            if self
                .changes()
                .any(|c| matches!(c, Change::Remove { node: r } if *r == n))
            {
                return true;
            }
            match self.at(n) {
                Some(f) => n = f.node,
                None => return false,
            }
        }
        false
    }

    /// The thing in slot `slot` of `parent`, if any.
    fn occupant(&self, parent: Id, slot: u64) -> Option<Id> {
        let here = Frame {
            node: parent,
            slot: Some(slot),
        };
        let mut seen = in_slot(self.tree, parent, slot)
            .into_iter()
            .collect::<Vec<_>>();
        for e in self.out {
            match &e.body {
                Body::Transfer(TransferRec::Leave { node, pose, .. }) if pose.frame == here => {
                    seen.push(*node);
                }
                Body::Changes(cs) => seen.extend(cs.iter().filter_map(|c| match &c.change {
                    Change::Create { node, pose, .. } if pose.frame == here => Some(*node),
                    _ => None,
                })),
                _ => {}
            }
        }
        seen.into_iter().find(|t| self.at(*t) == Some(here))
    }

    /// A node's kind (a thing made this tick has the kind its create names).
    fn kind(&self, node: Id) -> Option<Name> {
        let made = self.changes().find_map(|c| match c {
            Change::Create { node: n, kind, .. } if *n == node => Some(kind.clone()),
            _ => None,
        });
        made.or_else(|| {
            self.tree
                .handle(node)
                .and_then(|h| self.tree.node(h))
                .map(|n| n.kind().clone())
        })
    }

    fn audience(&self, node: Id) -> Audience {
        self.tree
            .handle(node)
            .and_then(|h| self.tree.node(h))
            .map_or(Audience::Everyone, |n| n.audience())
    }

    /// Field `field` of `node`: the last value written, else the tree's, else `None` (the kind's default).
    pub fn amount(&self, node: Id, field: u64) -> Option<i64> {
        let written = self.changes().find_map(|c| match c {
            Change::Set {
                node: n,
                field: f,
                to,
                ..
            } if *n == node && *f == field => Some(to),
            _ => None,
        });
        match written {
            Some(v) => int(v),
            None => {
                let n = self.tree.node(self.tree.handle(node)?)?;
                n.fields().get(&field).and_then(int)
            }
        }
    }
}

/// What an effect works on: the view, the amount fields, the zone's header (for B4's transfer), the body, its hands'
/// slots, and the node the form is done at.
pub(super) struct Cx<'a> {
    pub view: View<'a>,
    pub limits: &'a Limits,
    pub header: Option<&'a Header>,
    pub body: Id,
    pub hands: &'a [u64],
    pub node: Id,
    /// The things other runs reserve: none is removed, nor anything holding one.
    pub reserved: &'a [Id],
}

fn set(node: Id, field: u64, to: i64, by: i64) -> Entry {
    (
        node,
        Audience::Everyone,
        Body::Changes(vec![ChangeRec {
            change: Change::Set {
                node,
                field,
                to: value(to),
                by: Some(by),
            },
            rest: Rest::new(),
        }]),
    )
}

fn mint(m: &mut Minter) -> R<Id> {
    m.mint().map_err(|e| Refusal {
        name: "id-counter-exhausted",
        detail: e.to_string(),
    })
}

impl Cx<'_> {
    fn of(&self, o: Of) -> Id {
        match o {
            Of::This => self.node,
            Of::Node(id) => id,
        }
    }

    /// Field `field`'s limit on `node`'s kind: by its full name, or, for a kind written without its hash, the one
    /// revision loaded of that `namespace:name`.
    fn limit(&self, node: Id, field: u64) -> R<Limit> {
        let kind = self.view.kind(node);
        let by_plain = |k: &str| {
            let mut same = self.limits.iter().filter(|(n, _)| plain(n) == plain(k));
            match (same.next(), same.next()) {
                (Some((_, fs)), None) => Some(fs),
                _ => None,
            }
        };
        kind.as_ref()
            .and_then(|k| self.limits.get(k.as_str()).or_else(|| by_plain(k.as_str())))
            .and_then(|fs| fs.get(&field))
            .copied()
            .ok_or_else(|| Refusal {
                name: "field-unknown",
                detail: format!("field {field} of {}", show(node)),
            })
    }

    /// The first of the body's hands whose slot is free: `take-needs-hands` with none, `hands-full` with none free.
    fn free_hand(&self) -> R<Frame> {
        if self.hands.is_empty() {
            return refuse(
                "take-needs-hands",
                format!("{} has no hands", show(self.body)),
            );
        }
        self.hands
            .iter()
            .find(|s| self.view.occupant(self.body, **s).is_none())
            .map(|s| Frame {
                node: self.body,
                slot: Some(*s),
            })
            .ok_or_else(|| Refusal {
                name: "hands-full",
                detail: format!("{} has no free hand", show(self.body)),
            })
    }

    /// Slot `slot` of the node, refused `slot-occupied` when something is in it.
    fn free_slot(&self, slot: u64) -> R<Frame> {
        match self.view.occupant(self.node, slot) {
            Some(t) => refuse(
                "slot-occupied",
                format!("slot {slot} of {} holds {}", show(self.node), show(t)),
            ),
            None => Ok(Frame {
                node: self.node,
                slot: Some(slot),
            }),
        }
    }

    fn transfer(&self, m: &mut Minter, thing: Id, to: Frame) -> R<Vec<Entry>> {
        let Some(header) = self.header else {
            return refuse("zone-unknown", "a transfer needs the zone's header");
        };
        let id = mint(m)?;
        Ok(transfer(header, thing, self.view.audience(thing), to, id).to_vec())
    }

    /// The entries effect `e` writes, in order, as one part: refused by name when it cannot be done. A thing it names
    /// that is gone (removed, or under a thing removed, this tick or before) is refused `thing-missing`.
    pub fn entries(&self, m: &mut Minter, e: &Bound) -> R<Vec<Entry>> {
        let named = match e {
            Bound::Set { .. } => Vec::new(),
            Bound::Transfer { from, into, .. } => vec![self.of(*from), self.of(*into)],
            Bound::Make { .. } => vec![self.node],
            Bound::Remove { what } | Bound::Take { what } => vec![self.of(*what)],
            Bound::Put { what, .. } => vec![self.of(*what), self.node],
        };
        let missing = |t: &Id| self.view.at(*t).is_none() || self.view.removed(*t);
        if let Some(t) = named.iter().find(|t| missing(t)) {
            return refuse("thing-missing", show(*t));
        }
        if self.view.removed(self.node) {
            return refuse("thing-missing", show(self.node));
        }
        match e {
            Bound::Set { field, to } => Ok(vec![(
                self.node,
                Audience::Everyone,
                Body::Changes(vec![ChangeRec {
                    change: Change::Set {
                        node: self.node,
                        field: *field,
                        to: to.clone(),
                        by: None,
                    },
                    rest: Rest::new(),
                }]),
            )]),
            Bound::Transfer {
                field,
                from,
                into,
                amount,
            } => {
                let (from, into) = (self.of(*from), self.of(*into));
                if from == into {
                    return refuse("transfer-to-itself", show(from));
                }
                let (src, dst) = (self.limit(from, *field)?, self.limit(into, *field)?);
                let there = self.view.amount(from, *field).unwrap_or(src.default);
                let has = self.view.amount(into, *field).unwrap_or(dst.default);
                let above = there.saturating_sub(src.min.unwrap_or(0)).max(0);
                let room = dst.max.map_or(i64::MAX, |m| m.saturating_sub(has).max(0));
                let asked = match amount {
                    Amount::Units(n) => *n,
                    Amount::Room => room,
                };
                let moved = asked.min(above).min(room);
                if moved <= 0 {
                    return refuse(
                        "nothing-to-move",
                        format!(
                            "{} has {there}, {} has room for {room}",
                            show(from),
                            show(into)
                        ),
                    );
                }
                Ok(vec![
                    set(from, *field, there - moved, -moved),
                    set(into, *field, has + moved, moved),
                ])
            }
            Bound::Make { kind, into } => {
                let frame = match into {
                    Place::Hand => self.free_hand()?,
                    Place::Slot(s) => self.free_slot(*s)?,
                };
                let node = mint(m)?;
                Ok(vec![(
                    frame.node,
                    Audience::Everyone,
                    Body::Changes(vec![ChangeRec {
                        change: Change::Create {
                            node,
                            kind: kind.clone(),
                            pose: Pose {
                                frame,
                                position: Vec3::ZERO,
                                orientation: Quat::IDENTITY,
                                support: Support::Slot,
                            },
                            audience: Audience::Everyone,
                            fields: BTreeMap::new(),
                        },
                        rest: Rest::new(),
                    }]),
                )])
            }
            Bound::Remove { what } => {
                let thing = self.of(*what);
                if let Some(t) = self.reserved.iter().find(|t| self.view.within(**t, thing)) {
                    return refuse(
                        "thing-reserved",
                        format!("{} is held by another run", show(*t)),
                    );
                }
                match self.view.at(thing) {
                    Some(f) if f.node == self.node || f.node == self.body => Ok(vec![(
                        thing,
                        self.view.audience(thing),
                        Body::Changes(vec![ChangeRec {
                            change: Change::Remove { node: thing },
                            rest: Rest::new(),
                        }]),
                    )]),
                    _ => refuse(
                        "not-held",
                        format!(
                            "neither {} nor {} holds {}",
                            show(self.node),
                            show(self.body),
                            show(thing)
                        ),
                    ),
                }
            }
            Bound::Take { what } => {
                let thing = self.of(*what);
                let to = self.free_hand()?;
                self.transfer(m, thing, to)
            }
            Bound::Put { what, slot } => {
                let thing = self.of(*what);
                if self.view.at(thing).is_none_or(|f| f.node != self.body) {
                    return refuse(
                        "not-held",
                        format!("{} holds no {}", show(self.body), show(thing)),
                    );
                }
                if self.view.within(self.node, thing) {
                    return refuse(
                        "would-hold-itself",
                        format!("{} is {} or in it", show(self.node), show(thing)),
                    );
                }
                let to = self.free_slot(*slot)?;
                self.transfer(m, thing, to)
            }
        }
    }
}
