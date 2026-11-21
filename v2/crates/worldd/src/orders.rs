//! Standing orders on served bodies: the existing order skills, real town ground and seat-change notifications.
use crate::bodies::{Ask, Asked, Bodies};
use replica::effects::{Actor, Part, Refusal};
use replica::ids::Id;
use replica::intents::{Intent, Target};
use replica::pose::Vec3;
use replica::time::Micros;
use sim::orders::{SlotAt, Where};
use sim::slots::Slots;
use sim::spots::Ground;
use sim::walk::town::Plans;
use std::cell::RefCell;
use std::collections::BTreeMap;

type R<T> = Result<T, Refusal>;
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
        let approach = self.approaches.get(&body)?;
        if approach.goal == Some(to) {
            approach.corner
        } else {
            // A take or seat notification changed this line during the tick. Wait for its own planned goal.
            Some(approach.at)
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
        .any(|p| slots.holder_in(thing, p.place.slot).is_none())
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

/// Seat events wake the queue; its skills run before this tick's one controller step.
pub fn step(b: &mut Bodies, now: Micros) -> Vec<(sim::mover::Body, Vec3)> {
    let goals = b.orders.approaches(&b.runner.controller, now);
    let asked = RefCell::new(Vec::new());
    let mut approaches = BTreeMap::new();
    {
        let (town, planned) = b.order_route_parts();
        for (body, size, goal) in goals {
            let corner = goal.and_then(|to| {
                let view = town.view_for_size(size).ok()?;
                let [x, z] = view
                    .corner_planned(
                        &body,
                        to,
                        &Plans {
                            found: &planned.lines,
                            asked: &asked,
                        },
                    )
                    .ok()?;
                Some(Vec3::new(x, to.y, z))
            });
            approaches.insert(
                body.id,
                Approach {
                    at: body.pose.position,
                    goal,
                    corner,
                },
            );
        }
    }
    let changed = b.slots.changes();
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
    asked.into_inner()
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
