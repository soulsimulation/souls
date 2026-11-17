//! Bodies as resources and skills as claims (contract T9; Engine v2 T9, #2663). A body's family declares its
//! resources; a skill instance claims some of them, says what it blocks and what cancels it, and always releases what
//! it holds when it ends. The rules are numbered in `v2/docs/bodies.md`. The controller (B1) and the real skills (K13)
//! are not here.

use std::collections::BTreeMap;

use crate::effects::Refusal;
use crate::encode::{Name, Value};

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// A resource's class (rule 1), a closed list: what a skill may ask for without naming anatomy. A class added later
/// takes the next number.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Class {
    /// 1: moves the body over the ground (legs, wheels, fins).
    Locomotion,
    /// 2: holds and moves things (a hand, a beak, a trunk).
    Manipulator,
    /// 3: looks (eyes, a head that turns).
    Gaze,
    /// 4: makes sound (a voice, a bark).
    Voice,
}

impl Class {
    pub fn from_number(n: u64) -> R<Class> {
        match n {
            1 => Ok(Class::Locomotion),
            2 => Ok(Class::Manipulator),
            3 => Ok(Class::Gaze),
            4 => Ok(Class::Voice),
            _ => refuse("class-unknown", format!("class {n}")),
        }
    }
}

/// One resource of a family (rule 1): a name and a class. Reach is measured from a manipulator's effector, which may
/// be a held tool (rule 6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resource {
    pub name: Name,
    pub class: Class,
}

/// A body's family (rule 1): its name and its resources, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Family {
    pub name: Name,
    pub resources: Vec<Resource>,
}

impl Family {
    /// Reads a family from its fixture value, `{1: name, 2: [{1: name, 2: class}, ...]}`. Two resources of one name
    /// are refused (`resource-duplicate`).
    pub fn from_value(v: &Value) -> R<Family> {
        let not = || refuse("not-a-family", "a family is {1: name, 2: [resource, ...]}");
        let Value::Map(m) = v else { return not() };
        let (Some(Value::Text(name)), Some(Value::Array(rs))) = (m.get(&1), m.get(&2)) else {
            return not();
        };
        let mut resources: Vec<Resource> = Vec::new();
        for r in rs {
            let Value::Map(r) = r else { return not() };
            let (Some(Value::Text(n)), Some(Value::Uint(c))) = (r.get(&1), r.get(&2)) else {
                return not();
            };
            if resources.iter().any(|x| x.name == *n) {
                return refuse("resource-duplicate", n.as_str());
            }
            resources.push(Resource {
                name: n.clone(),
                class: Class::from_number(*c)?,
            });
        }
        Ok(Family {
            name: name.clone(),
            resources,
        })
    }
}

/// What a skill claims (rule 2): every resource of a class, one resource of a class, or a resource by name. Never a
/// limb or a bone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Want {
    /// Every resource of the class the body has, at least one (a walk takes all the legs).
    All(Class),
    /// Any one free resource of the class (a carry takes one hand).
    One(Class),
    /// The resource of that name (a family's own skill).
    Named(Name),
}

/// A skill's shape (rule 3): what it claims, what classes it blocks others from claiming while it runs, and which
/// classes cancel it when another skill claims them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillShape {
    pub name: Name,
    pub claims: Vec<Want>,
    pub blocks: Vec<Class>,
    pub cancelled_by: Vec<Class>,
}

/// A running skill on a body: its shape and the resources it holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Instance {
    pub shape: SkillShape,
    pub holds: Vec<Name>,
}

/// A body as skills see it (rule 3): its family, and the skill instances running on it, by instance number.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Body {
    pub family: Family,
    pub running: BTreeMap<u64, Instance>,
}

/// What starting a skill did: the resources it holds, and the instances it cancelled (each ended and released).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Started {
    pub holds: Vec<Name>,
    pub cancelled: Vec<u64>,
}

impl Body {
    pub fn new(family: Family) -> Body {
        Body {
            family,
            running: BTreeMap::new(),
        }
    }

    /// Who holds `resource`, if anyone.
    pub fn holder(&self, resource: &Name) -> Option<u64> {
        self.running
            .iter()
            .find(|(_, i)| i.holds.contains(resource))
            .map(|(n, _)| *n)
    }

    /// The resources `shape` would take and the instances it would cancel, or the refusal by name (rule 4):
    /// `resource-missing` (the family has none of that class or name), `resource-held` (another skill holds it and is
    /// not cancelled by its class) or `resource-blocked` (a running skill blocks that class). Nothing changes.
    pub fn plan(&self, shape: &SkillShape) -> R<Started> {
        let mut holds: Vec<Name> = Vec::new();
        let mut cancelled: Vec<u64> = Vec::new();
        for want in &shape.claims {
            let fits = |r: &&Resource| match want {
                Want::All(c) | Want::One(c) => r.class == *c,
                Want::Named(n) => r.name == *n,
            };
            let mut candidates: Vec<&Resource> =
                self.family.resources.iter().filter(fits).collect();
            if candidates.is_empty() {
                return refuse(
                    "resource-missing",
                    format!(
                        "{} wants {want:?}; {} has none",
                        shape.name.as_str(),
                        self.family.name.as_str()
                    ),
                );
            }
            if let Want::One(_) = want {
                // Prefer a free one; else the first, which may be held.
                candidates.sort_by_key(|r| self.holder(&r.name).is_some());
                candidates.truncate(1);
            }
            for r in candidates {
                if let Some((n, i)) = self
                    .running
                    .iter()
                    .find(|(_, i)| i.shape.blocks.contains(&r.class) && !i.holds.contains(&r.name))
                {
                    return refuse(
                        "resource-blocked",
                        format!(
                            "{} is blocked by {} (instance {n})",
                            r.name.as_str(),
                            i.shape.name.as_str()
                        ),
                    );
                }
                if let Some(n) = self.holder(&r.name) {
                    let i = &self.running[&n];
                    if !i.shape.cancelled_by.contains(&r.class) {
                        return refuse(
                            "resource-held",
                            format!(
                                "{} is held by {} (instance {n})",
                                r.name.as_str(),
                                i.shape.name.as_str()
                            ),
                        );
                    }
                    if !cancelled.contains(&n) {
                        cancelled.push(n);
                    }
                }
                if !holds.contains(&r.name) {
                    holds.push(r.name.clone());
                }
            }
        }
        Ok(Started { holds, cancelled })
    }

    /// Starts `shape` as instance `n` (rule 4): all of its claims or none. The instances it cancels end first and
    /// release everything they hold.
    pub fn start(&mut self, n: u64, shape: &SkillShape) -> R<Started> {
        if self.running.contains_key(&n) {
            return refuse("instance-duplicate", format!("instance {n}"));
        }
        let s = self.plan(shape)?;
        for c in &s.cancelled {
            self.end(*c);
        }
        self.running.insert(
            n,
            Instance {
                shape: shape.clone(),
                holds: s.holds.clone(),
            },
        );
        Ok(s)
    }

    /// Ends instance `n`, however it ends (done, cancelled, refused, failed): it always releases what it holds
    /// (rule 3). Returns what it held.
    pub fn end(&mut self, n: u64) -> Vec<Name> {
        self.running.remove(&n).map(|i| i.holds).unwrap_or_default()
    }
}

/// Starts a joint activity's claims on several bodies (rule 5): all or none. A refusal on any body names it and
/// changes no body.
pub fn start_joint(bodies: &mut [(&mut Body, u64, &SkillShape)]) -> R<Vec<Started>> {
    for (i, (b, _, shape)) in bodies.iter().enumerate() {
        if let Err(r) = b.plan(shape) {
            return refuse(r.name, format!("body {i}: {}", r.detail));
        }
    }
    bodies
        .iter_mut()
        .map(|(b, n, shape)| b.start(*n, shape))
        .collect()
}
