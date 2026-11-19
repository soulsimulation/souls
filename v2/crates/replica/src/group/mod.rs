//! One moving group, defined once (Engine v2 E23, #2736). The rules are in `v2/docs/moving-group.md`.
//!
//! Several bodies and things that move as one, each keeping its place, with one of them steering: carrying
//! together (B9, B14), pushing and wheeling (E5), walking together (E9), driven vehicles (E12) and rides (N12).
//! A [`Group`] is a view built from what the world already stores (a node whose frame moves, its children, the
//! member links to it and its kind), never a record of its own. [`Scene::check`] refuses by name a group that would
//! move something twice or hold someone in it. The fixtures are in [`fixtures`].

pub mod fixtures;

use std::collections::BTreeMap;

use crate::effects::Refusal;
use crate::ids::Id;
use crate::pose::Vec3;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// The link from a walker's body to its group's node, when the group is a joint activity: B5's membership link.
pub const WALKER_LINK: &str = crate::activity::MEMBER;

/// How a member belongs to its group (rules 2 and 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Belonging {
    /// The group's child at a fixed pose: its T2 parent is the group's node and its owner is the slot (T4 rule 7), so
    /// it moves with the frame and nothing writes it while the group moves.
    Rider,
    /// Linked to the group's node; keeps its own parent and its own mover and steers toward `place`, a point in the
    /// group's frame. The place is a target, never a constraint. Walkers fall into single file in member order.
    Walker { place: Vec3 },
}

/// A member: a node, how it belongs, and whether it is the group's steerer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Member {
    pub node: Id,
    pub belongs: Belonging,
    pub steers: bool,
}

/// What the route check sweeps along the way (rule 7): the footprint in the group's frame, half its length (x) and
/// half its width (z) in µm, or the walkers' own bodies, who may fall into single file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outline {
    Rigid { half_length: i64, half_width: i64 },
    Loose,
}

/// What happens when a member leaves (rule 8). A leave is always accepted; the rule says what the rest do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Leave {
    /// The rest close up and go on.
    CloseUp,
    /// The group stops and sets down what it moves, where it stands.
    StopAndSetDown,
    /// The leaver is let go at the next stop, which the kind states is reached within a bounded time.
    AtStop,
}

/// Who steers the frame (rule 6), derived from the group: a walker that steers leads, a rider that steers drives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Steerer {
    /// The frame follows this walker's own walk.
    Leader(Id),
    /// This rider's intents route the frame.
    Driver(Id),
    /// A closed-form track owns the frame's motion (T4 rule 8); no member steers.
    Track,
}

impl std::fmt::Display for Steerer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Steerer::Leader(id) => write!(f, "leader {}", id.counter()),
            Steerer::Driver(id) => write!(f, "driver {}", id.counter()),
            Steerer::Track => write!(f, "its track"),
        }
    }
}

/// One moving group: its node (whose frame moves), whether a track owns that frame's motion, its members in order,
/// its outline and the rule for leaving its kind states (`None`: the kind states none).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Group {
    pub node: Id,
    pub track: bool,
    pub members: Vec<Member>,
    pub outline: Outline,
    pub leave: Option<Leave>,
}

impl Group {
    /// The one steerer, refused by name: `group-two-steerers` (a track and a member, or two members) and
    /// `group-no-steerer` (the frame's motion would have no owner).
    pub fn steerer(&self) -> R<Steerer> {
        let mut found: Vec<Steerer> = Vec::new();
        if self.track {
            found.push(Steerer::Track);
        }
        for m in self.members.iter().filter(|m| m.steers) {
            found.push(match m.belongs {
                Belonging::Walker { .. } => Steerer::Leader(m.node),
                Belonging::Rider => Steerer::Driver(m.node),
            });
        }
        match found.as_slice() {
            [one] => Ok(*one),
            [] => refuse("group-no-steerer", format!("group {}", self.node.counter())),
            many => refuse(
                "group-two-steerers",
                format!(
                    "group {}: {}",
                    self.node.counter(),
                    many.iter()
                        .map(Steerer::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ),
        }
    }
}

/// The groups of a world and the T2 parent of every node they name, as the tree holds it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Scene {
    pub parents: BTreeMap<Id, Id>,
    pub groups: Vec<Group>,
}

impl Scene {
    /// Checks every group and refuses the first fault, group by group, by name: `group-no-leave-rule`, then the
    /// steerer's two names ([`Group::steerer`]), then `member-two-parents` (a rider whose T2 parent is not the
    /// group's node, or a rider of two groups) and `walker-is-child` (a walker whose T2 parent is the group's node:
    /// its pose would be rewritten on every step).
    pub fn check(&self) -> R<()> {
        let mut rides: BTreeMap<Id, Id> = BTreeMap::new();
        for g in &self.groups {
            if g.leave.is_none() {
                return refuse("group-no-leave-rule", format!("group {}", g.node.counter()));
            }
            g.steerer()?;
            for m in &g.members {
                let parent = self.parents.get(&m.node).copied();
                match m.belongs {
                    Belonging::Rider => {
                        if parent != Some(g.node) {
                            return refuse(
                                "member-two-parents",
                                format!(
                                    "{} rides group {} but its parent is {:?}",
                                    m.node.counter(),
                                    g.node.counter(),
                                    parent.map(Id::counter)
                                ),
                            );
                        }
                        if let Some(other) = rides.insert(m.node, g.node) {
                            return refuse(
                                "member-two-parents",
                                format!(
                                    "{} rides groups {} and {}",
                                    m.node.counter(),
                                    other.counter(),
                                    g.node.counter()
                                ),
                            );
                        }
                    }
                    Belonging::Walker { .. } => {
                        if parent == Some(g.node) {
                            return refuse(
                                "walker-is-child",
                                format!("{} in group {}", m.node.counter(), g.node.counter()),
                            );
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::{all, carried_load, pair_side_by_side, ride_on_track};
    use super::*;

    #[test]
    fn a2_the_five_fixtures_pass_the_check() {
        let names: Vec<&str> = all().iter().map(|(n, _)| *n).collect();
        assert_eq!(
            names,
            [
                "carried-load",
                "pushed-thing",
                "pair-side-by-side",
                "rowed-with-passenger",
                "ride-on-track"
            ]
        );
        for (name, scene) in all() {
            scene.check().unwrap_or_else(|r| panic!("{name}: {r}"));
            let steerer = scene.groups[0].steerer().unwrap();
            println!("{name}: passes, steered by {steerer}");
        }
    }

    #[test]
    fn a3_two_steerers_are_refused_by_name() {
        let mut s = pair_side_by_side();
        s.groups[0].members[1].steers = true;
        let r = s.check().unwrap_err();
        println!("{r}");
        assert_eq!(r.name, "group-two-steerers");

        let mut s = ride_on_track();
        s.groups[0].members[0].steers = true;
        assert_eq!(s.check().unwrap_err().name, "group-two-steerers");
    }

    #[test]
    fn a3_a_member_with_two_parents_is_refused_by_name() {
        // The load in a carrier's hand slot as well as the group's: the hand would move it too.
        let mut s = carried_load();
        let load = s.groups[0].members[0].node;
        let carrier = s.groups[0].members[1].node;
        s.parents.insert(load, carrier);
        let r = s.check().unwrap_err();
        println!("{r}");
        assert_eq!(r.name, "member-two-parents");

        // One rider in two groups.
        let mut s = carried_load();
        let mut second = s.groups[0].clone();
        second.node = Id::new(second.node.scope(), 99).unwrap();
        s.groups.push(second);
        assert_eq!(s.check().unwrap_err().name, "member-two-parents");
    }

    #[test]
    fn a3_a_group_with_no_rule_for_leaving_is_refused_by_name() {
        let mut s = ride_on_track();
        s.groups[0].leave = None;
        let r = s.check().unwrap_err();
        println!("{r}");
        assert_eq!(r.name, "group-no-leave-rule");
    }

    #[test]
    fn a_walker_made_the_groups_child_is_refused() {
        let mut s = pair_side_by_side();
        let g = s.groups[0].node;
        let walker = s.groups[0].members[0].node;
        s.parents.insert(walker, g);
        assert_eq!(s.check().unwrap_err().name, "walker-is-child");
    }
}
