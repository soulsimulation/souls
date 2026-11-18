//! A body someone authored, as kind data (Engine v2 B13, #2744). The importer (`v2/tools/import-body`) admits a body
//! from today's authoring kit and writes a family kind; this reads the part of it that is not B12's size.
//!
//! Section 13 of a family kind, in its meaning (so a changed mesh or action list renames the kind):
//! `{1: [resource, ...], 2: [action, ...], 3: full model, 4: simple model}`. Resources are `v2/docs/bodies.md` rule 1's
//! `{1: name, 2: class, 3: slot}`; actions are the physical actions the body declares (`go`, `pick-up`, ...); the models
//! are content hashes as text, the full mesh as admitted and the crowd's cut-down copy of it. Size class, height and
//! hover stay B12's state fields ([`super::sizes::Build`]).
//!
//! A physical action the body does not declare is refused by name ([`Decl::check`]). Which actions are physical, and
//! that a gesture or mood is never refused for want of a clip, is the caller's (E11), not this table's.

use super::KindDef;
use crate::bodies::Family;
use crate::effects::Refusal;
use crate::encode::{Name, Value};
use std::collections::BTreeMap;

pub const SECTION_BODY: u64 = 13;

/// What a family kind's section 13 declares.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decl {
    /// The family: the kind's `namespace:name` and its resources.
    pub family: Family,
    /// The physical actions the body declares, in the order given.
    pub actions: Vec<Name>,
    /// The full model's content hash.
    pub full: Name,
    /// The simple model's content hash.
    pub simple: Name,
}

impl Decl {
    /// Reads section 13 of kind `kind` (its `namespace:name` names the family). The reason is the refusal's text.
    pub(super) fn read(kind: &str, m: &BTreeMap<u64, Value>) -> Result<Decl, String> {
        if m.keys().any(|k| !(1..=4).contains(k)) {
            return Err("a body is {1: resources, 2: actions, 3: full, 4: simple}".into());
        }
        let resources = m.get(&1).ok_or("1, the resources, is a list")?.clone();
        let as_family = Value::Map(BTreeMap::from([
            (
                1,
                Value::Text(Name::new(kind).ok_or("the kind's name is a name")?),
            ),
            (2, resources),
        ]));
        let family = Family::from_value(&as_family)
            .map_err(|r| format!("1, the resources: {}: {}", r.name, r.detail))?;
        let actions = match m.get(&2) {
            Some(Value::Array(a)) => a
                .iter()
                .map(|x| match x {
                    Value::Text(t) => Ok(t.clone()),
                    _ => Err("2, the actions, is a list of names".to_owned()),
                })
                .collect::<Result<Vec<_>, _>>()?,
            _ => return Err("2, the actions, is a list of names".into()),
        };
        let hash = |n: u64, what: &str| match m.get(&n) {
            Some(Value::Text(t)) if t.as_str().contains(':') => Ok(t.clone()),
            _ => Err(format!("{n}, the {what} model, is a content hash")),
        };
        Ok(Decl {
            family,
            actions,
            full: hash(3, "full")?,
            simple: hash(4, "simple")?,
        })
    }

    /// The body section of `kind`, if it has one.
    pub fn of(kind: &KindDef) -> Option<&Decl> {
        kind.body.as_ref()
    }

    /// Whether the body declares physical action `action`; if not, `action-undeclared` naming it.
    pub fn check(&self, action: &str) -> Result<(), Refusal> {
        if self.actions.iter().any(|a| a.as_str() == action) {
            return Ok(());
        }
        Err(Refusal {
            name: "action-undeclared",
            detail: format!("{} declares no {action}", self.family.name.as_str()),
        })
    }
}
