//! A described spot as an intent's target (T10 rule 3): selector number [`SPOT`] in I5's closed list
//! (`crate::selector`), so it can stand in an act's ranked list beside named nodes and free-slot selectors.
//!
//! `{1: relation, 2: node, 3: other, 4: order, 5: number, 6: kind, 7: among}`, every field a relation does not use
//! absent:
//!
//! | relation | 1 | uses |
//! |---|---|---|
//! | pick | 1 | 2 the node, 3 the anchor (absent: me), 4, 5 the rank (0 last, n the Nth), 6, 7 (1 slots, 2 things) |
//! | middle, front, behind | 2, 8, 9 | 2 |
//! | corner, end | 3, 4 | 2, 3 the anchor (absent: me), 4 (1 nearest, 2 furthest) |
//! | along | 5 | 2, 3 the anchor it is measured from (absent: me), 5 per mille |
//! | edge | 6 | 2, 3 the node it is toward |
//! | by | 7 | 2, 3 the anchor it is toward (absent: me) |
//! | between | 10 | 2, 3 |
//!
//! Refused `selector-not-a-record` for a field missing, extra or of the wrong shape, `spot-relation-unknown` for a
//! relation not on the list.

use std::collections::BTreeMap;

use super::{Among, Anchor, Order, Rank, Spot};
use crate::effects::{Refusal, read_id};
use crate::encode::{Name, Value};
use crate::ids::Id;
use crate::intents::Target;

/// The selector number of a described spot.
pub const SPOT: u64 = 2;

type R<T> = Result<T, Refusal>;

fn shape<T>(detail: &str) -> R<T> {
    Err(Refusal {
        name: "selector-not-a-record",
        detail: detail.into(),
    })
}

impl Spot {
    fn number(&self) -> u64 {
        match self {
            Spot::Pick { .. } => 1,
            Spot::Middle(_) => 2,
            Spot::Corner { .. } => 3,
            Spot::End { .. } => 4,
            Spot::Along { .. } => 5,
            Spot::Edge { .. } => 6,
            Spot::By { .. } => 7,
            Spot::Front(_) => 8,
            Spot::Behind(_) => 9,
            Spot::Between(..) => 10,
        }
    }

    /// The spot as an intent's target.
    pub fn target(&self) -> Target {
        let mut f = BTreeMap::from([(1, Value::Uint(self.number()))]);
        let anchor = |f: &mut BTreeMap<u64, Value>, a: &Anchor| {
            if let Anchor::Node(n) = a {
                f.insert(3, n.to_value());
            }
        };
        let order = |o: &Order| Value::Uint(if *o == Order::Nearest { 1 } else { 2 });
        match self {
            Spot::Pick {
                among,
                kind,
                node,
                order: o,
                anchor: a,
                rank,
            } => {
                f.insert(2, node.to_value());
                anchor(&mut f, a);
                f.insert(4, order(o));
                let r = match rank {
                    Rank::First => 1,
                    Rank::Last => 0,
                    Rank::Nth(n) => u64::from(*n),
                };
                f.insert(5, Value::Uint(r));
                f.insert(6, Value::Text(kind.clone()));
                f.insert(7, Value::Uint(if *among == Among::Slots { 1 } else { 2 }));
            }
            Spot::Middle(n) | Spot::Front(n) | Spot::Behind(n) => {
                f.insert(2, n.to_value());
            }
            Spot::Corner {
                node,
                order: o,
                anchor: a,
            }
            | Spot::End {
                node,
                order: o,
                anchor: a,
            } => {
                f.insert(2, node.to_value());
                anchor(&mut f, a);
                f.insert(4, order(o));
            }
            Spot::Along {
                node,
                permille,
                from,
            } => {
                f.insert(2, node.to_value());
                anchor(&mut f, from);
                f.insert(5, Value::Uint(u64::from(*permille)));
            }
            Spot::Edge { node, toward } | Spot::Between(node, toward) => {
                f.insert(2, node.to_value());
                f.insert(3, toward.to_value());
            }
            Spot::By { node, toward } => {
                f.insert(2, node.to_value());
                anchor(&mut f, toward);
            }
        }
        Target::Selector(SPOT, f)
    }

    /// Reads a target's described spot.
    pub fn read(target: &Target) -> R<Spot> {
        let Target::Selector(SPOT, f) = target else {
            return shape("not a described spot");
        };
        let Some(Value::Uint(rel)) = f.get(&1) else {
            return shape("1 is the relation");
        };
        let uses: &[u64] = match rel {
            1 => &[1, 2, 3, 4, 5, 6, 7],
            2 | 8 | 9 => &[1, 2],
            3 | 4 => &[1, 2, 3, 4],
            5 => &[1, 2, 3, 5],
            6 | 7 | 10 => &[1, 2, 3],
            _ => {
                return Err(Refusal {
                    name: "spot-relation-unknown",
                    detail: rel.to_string(),
                });
            }
        };
        if f.keys().any(|k| !uses.contains(k)) {
            return shape("a field the relation does not use");
        }
        let id = |k: u64| -> R<Id> {
            match f.get(&k) {
                Some(v) => read_id(v),
                None => shape("a node is missing"),
            }
        };
        let anchor = || -> R<Anchor> {
            match f.get(&3) {
                None => Ok(Anchor::Me),
                Some(v) => Ok(Anchor::Node(read_id(v)?)),
            }
        };
        let uint = |k: u64| -> R<u64> {
            match f.get(&k) {
                Some(Value::Uint(n)) => Ok(*n),
                _ => shape("a whole number is missing"),
            }
        };
        let order = || -> R<Order> {
            match uint(4)? {
                1 => Ok(Order::Nearest),
                2 => Ok(Order::Furthest),
                _ => shape("4 is 1 or 2"),
            }
        };
        let small = |k: u64| u32::try_from(uint(k)?).or_else(|_| shape("too large"));
        let node = id(2)?;
        Ok(match rel {
            1 => {
                let Some(Value::Text(kind)) = f.get(&6) else {
                    return shape("6 is a kind");
                };
                Spot::Pick {
                    among: match uint(7)? {
                        1 => Among::Slots,
                        2 => Among::Things,
                        _ => return shape("7 is 1 or 2"),
                    },
                    kind: Name::clone(kind),
                    node,
                    order: order()?,
                    anchor: anchor()?,
                    rank: match small(5)? {
                        0 => Rank::Last,
                        1 => Rank::First,
                        n => Rank::Nth(n),
                    },
                }
            }
            2 => Spot::Middle(node),
            8 => Spot::Front(node),
            9 => Spot::Behind(node),
            3 => Spot::Corner {
                node,
                order: order()?,
                anchor: anchor()?,
            },
            4 => Spot::End {
                node,
                order: order()?,
                anchor: anchor()?,
            },
            5 => Spot::Along {
                node,
                permille: small(5)?,
                from: anchor()?,
            },
            6 => Spot::Edge {
                node,
                toward: id(3)?,
            },
            7 => Spot::By {
                node,
                toward: anchor()?,
            },
            _ => Spot::Between(node, id(3)?),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::Scope;

    fn id(n: u64) -> Id {
        Id::new(Scope([4; 16]), n).unwrap()
    }

    #[test]
    fn every_relation_reads_back_from_its_target() {
        let (a, b) = (id(1), id(2));
        let all = [
            Spot::Pick {
                among: Among::Slots,
                kind: Name::new("t:k").unwrap(),
                node: a,
                order: Order::Furthest,
                anchor: Anchor::Node(b),
                rank: Rank::First,
            },
            Spot::Pick {
                among: Among::Things,
                kind: Name::new("t:k").unwrap(),
                node: a,
                order: Order::Nearest,
                anchor: Anchor::Me,
                rank: Rank::Nth(3),
            },
            Spot::Middle(a),
            Spot::Corner {
                node: a,
                order: Order::Furthest,
                anchor: Anchor::Node(b),
            },
            Spot::End {
                node: a,
                order: Order::Nearest,
                anchor: Anchor::Me,
            },
            Spot::Along {
                node: a,
                permille: 333,
                from: Anchor::Node(b),
            },
            Spot::Edge { node: a, toward: b },
            Spot::By {
                node: a,
                toward: Anchor::Me,
            },
            Spot::Front(a),
            Spot::Behind(a),
            Spot::Between(a, b),
        ];
        for s in all {
            assert_eq!(Spot::read(&s.target()).unwrap(), s);
        }
        let Target::Selector(_, mut f) = Spot::Middle(a).target() else {
            unreachable!()
        };
        f.insert(4, Value::Uint(1));
        let r = Spot::read(&Target::Selector(SPOT, f.clone())).unwrap_err();
        assert_eq!(r.name, "selector-not-a-record");
        f.insert(1, Value::Uint(11));
        let r = Spot::read(&Target::Selector(SPOT, f)).unwrap_err();
        assert_eq!(r.name, "spot-relation-unknown");
    }
}
