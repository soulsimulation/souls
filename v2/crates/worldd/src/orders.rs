//! Standing orders on served bodies: the existing order skills, real town ground and seat-change notifications. A
//! queue walks to its spot by the town's supported route (B7c, #3593): the existing planner's corner for the body's
//! admitted class, asked in the runner's own batch, never a straight line through furniture.
use std::cell::RefCell;
use std::collections::BTreeMap;

use crate::bodies::{Ask, Asked, Bodies};
use replica::effects::{Actor, Part, Refusal};
use replica::ids::Id;
use replica::intents::{Intent, Target};
use replica::kinds::sizes::Size;
use replica::pose::Vec3;
use replica::time::Micros;
use sim::mover::Body as Moved;
use sim::orders::{SlotAt, Where};
use sim::slots::Slots;
use sim::spots::Ground;
use sim::walk::town::Plans;
use skills::close::THERE;

type R<T> = Result<T, Refusal>;

/// A queueing body's way this tick: where it stood, the spot asked for, and the planner's corner toward it (none: the
/// planner refused the route).
struct Approach {
    at: Vec3,
    goal: Option<Vec3>,
    corner: Option<Vec3>,
}

struct World<'a> {
    ground: &'a mut dyn Ground,
    slots: &'a Slots,
    approaches: &'a BTreeMap<Id, Approach>,
}
impl Ground for World<'_> {
    fn stand(&self, n: Id, p: Vec3) -> Option<(Vec3, Vec3)> {
        self.ground.stand(n, p)
    }
    fn passage(&self, n: Id, p: Vec3) -> bool {
        self.ground.passage(n, p)
    }
    fn walk(&mut self, an: Id, a: Vec3, bn: Id, b: Vec3) -> Option<i64> {
        self.ground.walk(an, a, bn, b)
    }
}
impl Where for World<'_> {
    fn toward(&self, body: Id, to: Vec3) -> Option<Vec3> {
        let a = self.approaches.get(&body)?;
        if a.goal == Some(to) {
            a.corner
        } else {
            // A seat change moved this body's spot during the tick: it stands until its new spot's way is asked.
            Some(a.at)
        }
    }
    fn slot(&self, thing: Id) -> Option<SlotAt> {
        let p = self.slots.place(thing)?;
        Some(SlotAt {
            floor: p.floor,
            stand: p.stand().ok()?,
            point: p.point,
        })
    }
}
fn available(slots: &Slots, thing: Id) -> bool {
    slots
        .places_of(thing)
        .any(|p| !slots.full(thing, p.place.slot))
}

/// `body` is resolved by the authenticated actor's world membership, never taken from the submitted field.
pub fn accept(b: &mut Bodies, source: &Intent, body: Id, id: Id, now: Micros) -> R<()> {
    let mut intent = source.clone();
    intent.body = Some(body);
    if intent.verb.as_str() == "souls:queue"
        && let Some(replica::encode::Value::Text(act)) = intent.parameters.get(&1)
        && !matches!(act.as_str().rsplit(':').next(), Some("sit" | "lie"))
    {
        return Err(Refusal {
            name: "order-queue-act",
            detail: "a slot's sit or lie".into(),
        });
    }
    b.town.with_ground(|_, ground| {
        let w = World {
            ground,
            slots: &b.slots,
            approaches: &BTreeMap::new(),
        };
        b.orders
            .accept(&mut b.runner.controller, &w, &intent, id, now)?;
        if intent.verb.as_str() == "souls:queue"
            && let Some(Target::Node(slot)) = intent.target
            && available(&b.slots, slot)
        {
            b.orders.freed(&w, slot);
        }
        Ok(())
    })
}

/// The planner's corner toward each queueing body's spot, read as any walker's is (K18b): the line it found last
/// tick, else the controller's dry run of the straight way, else asked of it now (the body stands this tick). Returns
/// the lines asked, for this tick's planner batch.
fn approaches(b: &mut Bodies, now: Micros) -> (BTreeMap<Id, Approach>, Vec<(Moved, Vec3)>) {
    let c = &b.runner.controller;
    let goals: Vec<(Moved, Size, Option<Vec3>)> = b
        .orders
        .approaches(c, now)
        .map(|(body, goal)| {
            let size = c.build(body.id).map_or(Size::Standard, |d| d.size);
            (*body, size, goal)
        })
        .collect();
    let asked = RefCell::new(Vec::new());
    let mut out = BTreeMap::new();
    for (body, size, goal) in goals {
        let corner = goal.and_then(|to| {
            // On its spot: the skill stands without asking, so the planner is not asked either.
            let (dx, dz) = (to.x - body.pose.position.x, to.z - body.pose.position.z);
            if i128::from(dx).pow(2) + i128::from(dz).pow(2) <= i128::from(THERE).pow(2) {
                return Some(to);
            }
            let view = b.town.view_for_size(size).ok()?;
            let plans = Plans {
                found: &b.planned.lines,
                asked: &asked,
            };
            let [x, z] = view.corner_planned(&body, to, &plans).ok()?;
            Some(Vec3::new(
                x,
                if [x, z] == [to.x, to.z] { to.y } else { 0 },
                z,
            ))
        });
        out.insert(
            body.id,
            Approach {
                at: body.pose.position,
                goal,
                corner,
            },
        );
    }
    (out, asked.into_inner())
}

/// Seat events wake the queue; its skills run before this tick's one controller step. Returns the lines its
/// approaches asked of the planner.
pub fn step(b: &mut Bodies, now: Micros) -> Vec<(Moved, Vec3)> {
    let (approaches, asked) = approaches(b, now);
    let changed = b.slots.changes();
    // A climb out of a seat (E11d) is seen as the body's own motion; its record is not kept here.
    let _ = b.slots.climbs();
    let takes = b.town.with_ground(|_, ground| {
        let w = World {
            ground,
            slots: &b.slots,
            approaches: &approaches,
        };
        for slot in changed {
            if available(&b.slots, slot) {
                b.orders.freed(&w, slot);
            } else {
                b.orders.taken(&w, slot);
            }
        }
        b.orders.step(&mut b.runner.controller, &w, now)
    });
    for t in takes {
        let actor = b
            .orders
            .log
            .iter()
            .rev()
            .find(|e| e.envelope.cause == replica::effects::Cause::Intent(t.intent))
            .map(|e| e.envelope.actor)
            .unwrap_or(Actor::World);
        let ask = if t.act.as_str().ends_with(":lie") {
            Ask::Lie { thing: t.slot }
        } else {
            Ask::Sit { thing: t.slot }
        };
        // Takes pass through the same reach, ownership, admission and move path as an ordinary sit.
        let _ = b.start(vec![(
            t.intent,
            Asked {
                body: t.body,
                actor,
                ask,
                fallbacks: Vec::new(),
            },
        )]);
    }
    asked
}

/// Restore the accepted order records in log order, after the bodies and seats have been restored.
pub fn resume(b: &mut Bodies, parts: &[Part], now: Micros) -> R<()> {
    b.town.with_ground(|_, ground| {
        let w = World {
            ground,
            slots: &b.slots,
            approaches: &BTreeMap::new(),
        };
        b.orders.resume(&mut b.runner.controller, &w, parts, now)?;
        let slots: std::collections::BTreeSet<Id> = b
            .runner
            .controller
            .ids()
            .filter_map(|body| match &b.orders.open(body)?.what {
                sim::orders::What::Queue { slot, .. } => Some(*slot),
                _ => None,
            })
            .collect();
        for slot in slots {
            if available(&b.slots, slot) {
                b.orders.freed(&w, slot);
            }
        }
        Ok(())
    })
}
