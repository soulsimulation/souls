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

type R<T> = Result<T, Refusal>;
struct World<'a> {
    ground: &'a mut dyn Ground,
    slots: &'a Slots,
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
pub fn step(b: &mut Bodies, now: Micros) {
    let changed = b.slots.changes();
    // A climb out of a seat (E11d) is seen as the body's own motion; its record is not kept here.
    let _ = b.slots.climbs();
    let takes = b.town.with_ground(|_, ground| {
        let w = World {
            ground,
            slots: &b.slots,
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
}

/// Restore the accepted order records in log order, after the bodies and seats have been restored.
pub fn resume(b: &mut Bodies, parts: &[Part], now: Micros) -> R<()> {
    b.town.with_ground(|_, ground| {
        let w = World {
            ground,
            slots: &b.slots,
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
