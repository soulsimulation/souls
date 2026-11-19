//! Selectors (Engine v2 I5, #2690): the closed list a target may name instead of a node (T10 rule 3,
//! [`crate::intents::Target::Selector`]), and its first entry. The agent writes the selector; the engine binds it at
//! commit and names what it bound. E2 adds described spots and the other relations to this same list.
//!
//! - **[`FREE_SLOT`]** (number 1): any free slot of a kind in a node: `{1: 1, 2: {1: kind, 2: node, 3: rule}}`, the
//!   kind a name (`eden:chair`), the node the room's id.
//! - **The binding rule is part of the selector** (field 3), from its own closed list: [`Rule::Nearest`] (1), nearest
//!   to the body, ties by id. E2 adds others (furthest from, the Nth along a row, beside, between).
//! - **Resolving is a checker's** ([`best`]): it ranks what is free on its copy and hands over the best [`FEW`]; the
//!   clock thread confirms them in order with one lookup each, and never scans.

use std::collections::BTreeMap;

use crate::effects::{Refusal, read_id};
use crate::encode::{Name, Value};
use crate::ids::Id;
use crate::intents::Target;
use crate::pose::Vec3;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// The first selector: any free slot of a kind in a node.
pub const FREE_SLOT: u64 = 1;

/// How many of a selector's best a checker hands over: the Soul Actions decision that `any:sit` spreads a crowd over
/// the 3 nearest free seats (#3106).
pub const FEW: usize = 3;

/// A selector's binding rule (field 3), a closed list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rule {
    /// Nearest to the body, ties by id.
    Nearest,
}

impl Rule {
    pub fn number(self) -> u64 {
        match self {
            Rule::Nearest => 1,
        }
    }

    fn read(n: u64) -> R<Rule> {
        match n {
            1 => Ok(Rule::Nearest),
            _ => refuse("selector-rule-unknown", n.to_string()),
        }
    }
}

/// A selector from the closed list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Selector {
    /// Any free slot of `kind` in `node`, bound by `rule`.
    FreeSlot { kind: Name, node: Id, rule: Rule },
}

impl Selector {
    /// Reads a target's selector: `selector-unknown` for a number not on the list, `selector-not-a-record` for its
    /// fields' shape (every field is required, none other allowed), `selector-rule-unknown` for its rule.
    pub fn read(target: &Target) -> R<Selector> {
        let Target::Selector(n, f) = target else {
            return refuse("selector-not-a-record", "a node, not a selector");
        };
        if *n != FREE_SLOT {
            return refuse("selector-unknown", n.to_string());
        }
        let shape = || {
            refuse(
                "selector-not-a-record",
                "a free slot is {1: kind, 2: node, 3: rule}",
            )
        };
        if f.keys().any(|k| *k > 3) {
            return shape();
        }
        let (Some(Value::Text(kind)), Some(node), Some(Value::Uint(rule))) =
            (f.get(&1), f.get(&2), f.get(&3))
        else {
            return shape();
        };
        Ok(Selector::FreeSlot {
            kind: kind.clone(),
            node: read_id(node)?,
            rule: Rule::read(*rule)?,
        })
    }

    pub fn target(&self) -> Target {
        match self {
            Selector::FreeSlot { kind, node, rule } => Target::Selector(
                FREE_SLOT,
                BTreeMap::from([
                    (1, Value::Text(kind.clone())),
                    (2, node.to_value()),
                    (3, Value::Uint(rule.number())),
                ]),
            ),
        }
    }

    pub fn rule(&self) -> Rule {
        match self {
            Selector::FreeSlot { rule, .. } => *rule,
        }
    }
}

/// The best `few` of `free` (each slot's thing and its point, in the body's frame) for a body at `body`, by `rule`, in
/// rank order. A checker's work: it reads every free slot once.
pub fn best(rule: Rule, body: Vec3, free: impl Iterator<Item = (Id, Vec3)>, few: usize) -> Vec<Id> {
    match rule {
        Rule::Nearest => {
            let d2 = |p: Vec3| {
                let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
                d(p.x, body.x) + d(p.y, body.y) + d(p.z, body.z)
            };
            let mut ranked: Vec<(i128, Id)> = free.map(|(id, p)| (d2(p), id)).collect();
            let few = few.min(ranked.len());
            if few == 0 {
                return Vec::new();
            }
            ranked.select_nth_unstable(few - 1);
            ranked.truncate(few);
            ranked.sort_unstable();
            ranked.into_iter().map(|(_, id)| id).collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::Scope;

    fn id(n: u64) -> Id {
        Id::new(Scope([7; 16]), n).unwrap()
    }

    #[test]
    fn a_free_slot_selector_reads_back_and_its_rule_is_a_field() {
        let s = Selector::FreeSlot {
            kind: Name::new("eden:chair").unwrap(),
            node: id(1),
            rule: Rule::Nearest,
        };
        assert_eq!(Selector::read(&s.target()).unwrap(), s);
        let Target::Selector(_, mut f) = s.target() else {
            unreachable!()
        };
        f.insert(3, Value::Uint(9));
        let r = Selector::read(&Target::Selector(FREE_SLOT, f.clone())).unwrap_err();
        assert_eq!(r.name, "selector-rule-unknown");
        f.remove(&3);
        let r = Selector::read(&Target::Selector(FREE_SLOT, f)).unwrap_err();
        assert_eq!(r.name, "selector-not-a-record");
        let r = Selector::read(&Target::Selector(2, BTreeMap::new())).unwrap_err();
        assert_eq!(r.name, "selector-unknown");
    }

    #[test]
    fn nearest_ranks_by_distance_then_id() {
        let p = |x| Vec3::new(x, 0, 0);
        let free = vec![(id(5), p(3)), (id(2), p(-1)), (id(4), p(1)), (id(3), p(2))];
        assert_eq!(
            best(Rule::Nearest, p(0), free.clone().into_iter(), 3),
            vec![id(2), id(4), id(3)],
            "a tie at 1 µm goes to the lower id"
        );
        assert_eq!(best(Rule::Nearest, p(0), free.into_iter(), 9).len(), 4);
        assert!(best(Rule::Nearest, p(0), std::iter::empty(), 3).is_empty());
    }
}
