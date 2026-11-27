//! The never-stuck ladder in a served world (0.133 N1, after 0.132 A2-3): `sim::unstick`'s [`Ladder`] climbed over
//! the bodies' own runner after each tick ([`crate::bodies::Bodies::step`]).
//!
//! - **The walkers.** Each gateway walk the planner places (K18b's answer: its place and legs) is kept by the ladder
//!   for its order, the first time it is placed; a walk that ended is let go.
//! - **The rungs**, as `sim::unstick` declares them, by time without progress: at 3 s routed again from where it
//!   stands; at 5 s each still body in its way with no order to stay is stepped aside by the world (A2-3's rule); at
//!   9 s it passes with a shoulder turn; at 15 s its order ends by name, `goal-unreachable`, naming what it waited for.
//!   The walk's receipt is that refusal by name.
//! - **The last rung.** A body the runner found off the ground after an edit (`Runner::off_ground`, G3) walks out to
//!   the nearest point it may stand on, at walking speed, collision off.
//! - **Recorded.** Every rung climbed is one entry of the world's own, actor and cause the world, on the walker (on
//!   the body moved for a step aside): an event named for the rung ([`event`]), with the walker and its order, and
//!   what the rung names.
//!
//! A gateway walk is no longer ended by C21's 3 s watch: the ladder decides (`crate::acts`).

use std::collections::{BTreeMap, BTreeSet};

use replica::effects::{Actor, Body, Cause, Effect, Envelope, Event, Rest};
use replica::encode::{Name, Value};
use replica::ids::Id;
use replica::pose::Vec3;
use replica::time::Micros;
use replica::world_model::Audience;
use sim::host::{Planned, Runner};
use sim::unstick::{Ladder, Record, Rung};
use sim::walk::town::Town;

/// The ladder over a served world's walkers. Its records are taken from it as they are written ([`Unstuck::after`]),
/// so it holds a tick's at most, never every rung climbed in the world's life (#2803).
pub struct Unstuck {
    pub ladder: Ladder,
    /// The bodies off the ground a walk-out was asked for (each once while it is off the ground).
    asked_out: BTreeSet<Id>,
}

impl Default for Unstuck {
    fn default() -> Unstuck {
        Unstuck {
            ladder: Ladder::served(),
            asked_out: BTreeSet::new(),
        }
    }
}

impl Unstuck {
    /// Keeps each walk the planner placed this tick, the first time it is placed for its order.
    pub fn planned(&mut self, runner: &Runner, planned: &Planned) {
        for (who, (order, placed)) in &planned.places {
            let Ok((place, legs, _)) = placed else {
                continue;
            };
            if self.ladder.order(*who) == Some(*order) {
                // Placed again for the same order: the ladder's reroute asked for it.
                self.ladder.routed(runner, *who, legs.clone());
                continue;
            }
            if !runner.asks.contains_key(who) {
                continue;
            }
            // The node it stands on there: the target's, or an overflow's round a crowded target (A2-5).
            self.ladder.add(
                *who,
                *order,
                crate::bodies::WALK,
                place.node,
                place.at,
                legs.clone(),
            );
        }
    }

    /// After the runner's tick: the bodies off the ground walk out, the rungs are climbed, the walks that ended are let
    /// go. Returns the world's entries for the rungs climbed since the last call.
    pub fn after(&mut self, runner: &mut Runner, town: &mut Town) -> Vec<Effect> {
        self.asked_out.retain(|b| runner.off_ground.contains(b));
        let off: Vec<Id> = runner
            .off_ground
            .iter()
            .filter(|b| !self.asked_out.contains(*b))
            .copied()
            .collect();
        for b in off {
            self.asked_out.insert(b);
            if self.ladder.order(b).is_none()
                && let Some(me) = runner.controller.body(b)
            {
                let (node, at) = (sim::walk::node_of(me), me.pose.position);
                self.ladder
                    .add(b, b, crate::bodies::WALK, node, at, Vec::new());
            }
            if let Err(r) = self.ladder.walk_out(runner, &*town, b) {
                eprintln!(
                    "worldd: {} could not walk out: {}",
                    replica::world_model::show(b),
                    r.name
                );
            }
        }
        self.ladder.after(runner, town);
        self.ladder.forget_ended(runner);
        self.written()
    }

    /// The world's entries for the rungs climbed since the last call, taken from the ladder: its records are not
    /// kept once they are written (#2803; kept, they grew by about half a megabyte a minute at 1,000 agents).
    fn written(&mut self) -> Vec<Effect> {
        self.ladder.log.drain(..).map(|r| entry(&r)).collect()
    }
}

/// The event name of a rung: `souls:` and the rung's own name (`reroute`, `make-way`, `step-aside`, `shoulder-turn`,
/// `order-ended`, `walk-out`, `walked-out`).
pub fn event(rung: &Rung) -> String {
    format!("souls:{}", rung.name())
}

fn point(p: Vec3) -> Value {
    let i =
        |n: i64| u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint);
    Value::Array(vec![i(p.x), i(p.y), i(p.z)])
}

fn text(t: &str) -> Value {
    Value::Bytes(t.as_bytes().to_vec())
}

/// The world's entry for one record: on the walker (on the body moved, for a step aside), its event's fields 1 the
/// walker and 2 its order, then the rung's own: make-way 3 the still body; step-aside 3 the body, 4 from, 5 to;
/// order-ended 3 the name, 4 what it waited for; walk-out 3 its node, 4 from, 5 to; walked-out 3 where it stands.
pub fn entry(r: &Record) -> Effect {
    let mut fields = BTreeMap::from([(1, r.who.to_value()), (2, r.order.to_value())]);
    let mut node = r.who;
    match &r.rung {
        Rung::MakeWay { to } => {
            fields.insert(3, to.to_value());
        }
        Rung::StepAside { body, from, to, .. } => {
            node = *body;
            fields.extend([(3, body.to_value()), (4, point(*from)), (5, point(*to))]);
        }
        Rung::Ended { name, detail } => {
            fields.extend([(3, text(name)), (4, text(detail))]);
        }
        Rung::WalkOut { node: n, from, to } => {
            fields.extend([(3, n.to_value()), (4, point(*from)), (5, point(*to))]);
        }
        Rung::WalkedOut { at } => {
            fields.insert(3, point(*at));
        }
        Rung::Reroute | Rung::Shoulder => {}
    }
    Effect {
        envelope: Envelope {
            sequence: 0,
            at: r.at,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node,
        },
        body: Body::Changes(Vec::new()),
        events: Some(vec![Event {
            name: Name::new(&event(&r.rung))
                .unwrap_or_else(|| unreachable!("a rung's name is a name")),
            fields,
            changes: Vec::new(),
            rest: Rest::new(),
        }]),
        rest: Rest::new(),
    }
}

/// The world's entry for a still body stepped aside at `at` for walker `walker` (a form's walk, whose order the ladder
/// does not keep): the same entry as the ladder's step aside, with the walker as its own order.
pub fn stepped_aside(at: Micros, walker: Id, body: Id, node: Id, from: Vec3, to: Vec3) -> Effect {
    entry(&Record {
        at,
        who: walker,
        order: walker,
        rung: Rung::StepAside {
            body,
            node,
            from,
            to,
        },
    })
}

/// The event name of what a restart did with a body ([`restarted`]).
pub const RESTARTED: &str = "souls:restarted";

/// The world's entry for what a restart did with a body the log had where it may not stand, or that it could not place
/// again where the log had it (`crate::bodies::Bodies::add_body_at_built`): on the body, at `at`, changing nothing, so
/// its Soul's client reads it as it reads the ladder's entries on its body. Its event's fields: 1 the body, 2 how, by
/// name (`climb-out`, `resume-nearest`, `resume-seated`, `resume-seated-other`, `resume-placed`, `resume-stood`, `resume-entry`), 3 the
/// node it is on now, 4 where the log had it, 5 where it is placed (carried on: where it lands).
pub fn restarted(at: Micros, body: Id, how: &str, node: Id, from: Vec3, to: Vec3) -> Effect {
    Effect {
        envelope: Envelope {
            sequence: 0,
            at,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node: body,
        },
        body: Body::Changes(Vec::new()),
        events: Some(vec![Event {
            name: Name::new(RESTARTED).unwrap_or_else(|| unreachable!("a name")),
            fields: BTreeMap::from([
                (1, body.to_value()),
                (2, text(how)),
                (3, node.to_value()),
                (4, point(from)),
                (5, point(to)),
            ]),
            changes: Vec::new(),
            rest: Rest::new(),
        }]),
        rest: Rest::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #2803: each rung climbed is written once, and the ladder keeps none of them afterwards, however long the
    /// world runs.
    #[test]
    fn the_ladders_records_are_written_once_and_not_kept() {
        let id = |n| Id::new(replica::ids::Scope([0x2b; 16]), n).expect("an id");
        let mut u = Unstuck::default();
        let mut all = Vec::new();
        for tick in 0..1000i64 {
            for k in 0..3 {
                u.ladder.log.push(Record {
                    at: tick,
                    who: id(1 + k),
                    order: id(100 + tick as u64),
                    rung: if k == 0 {
                        Rung::Reroute
                    } else {
                        Rung::MakeWay { to: id(50) }
                    },
                });
            }
            let wrote = u.written();
            assert_eq!(wrote.len(), 3, "a tick's rungs are written with it");
            assert!(u.ladder.log.is_empty(), "none is kept once written");
            all.extend(wrote);
        }
        assert!(u.written().is_empty(), "nothing is written twice");
        let names: Vec<String> = all
            .iter()
            .take(3)
            .map(|e| e.events.as_ref().expect("an event")[0].name.as_str().to_owned())
            .collect();
        assert_eq!(
            names,
            ["souls:reroute", "souls:make-way", "souls:make-way"],
            "in the order climbed"
        );
        assert_eq!(all.len(), 3000);
    }
}
