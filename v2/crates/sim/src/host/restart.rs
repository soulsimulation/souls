//! Handing intents back after a restart (Engine v2 K13b, #3119; TRUNK's restart rule, `v2/docs/durability.md` rule
//! 13). A skill in progress is not stored. After K5's replay, each intent the log holds as accepted, with no record
//! that ends it, is handed to its skill again, which starts afresh from the body's present pose; or it is ended with a
//! named reason, written as a record. None is dropped in silence.
//!
//! - **The log's form, until I4 (#2687).** Real intents, receipts and outcomes arrive with I4; until then an accepted
//!   order is an entry on its body carrying the event [`ORDER`] (`{1: intent, 2: skill, 3: target node, 4: [x, y, z]
//!   µm, 5: expiry µs}`), and its end an entry carrying [`ORDER_ENDED`] (`{1: intent, 2: reason}`, the reason a name such
//!   as `souls:order-expired` or `souls:done`).
//! - **Active** ([`active`]): accepted, and no later [`ORDER_ENDED`] names it. In log order.
//! - **Handed back or ended** ([`hand_back`]), checked in this order: an expiry at or before the restart's time is
//!   `order-expired`; a body the world no longer holds is `body-unknown`; a skill the world does not know is
//!   `skill-unknown`; a skill that cannot start from where the body stands ends by its refusal's name (a goal now out
//!   of reach); and resources that cannot be claimed end by the controller's refusal's name.
//! - **Nothing assumed.** The skill is built from the body's pose as the restarted world holds it, never from where
//!   the run had got to.

use replica::effects::{Event, Part, Refusal, Rest, read_id};
use replica::encode::{Name, Value};
use replica::host::Skill;
use replica::ids::Id;
use replica::pose::Vec3;
use replica::time::Micros;

use super::{Runner, decode_int, int, named};
use crate::mover::Body as Moved;

/// The event of an accepted order, on its body's entry (a stand-in until I4).
pub const ORDER: &str = "souls:order";
/// The event of an order's end, with its reason's name.
pub const ORDER_ENDED: &str = "souls:order-ended";

/// An order the log holds as accepted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub intent: Id,
    pub body: Id,
    /// The skill that carries it out.
    pub skill: Name,
    /// Where it goes: a node, and a point in its frame (µm).
    pub to: Id,
    pub goal: Vec3,
    /// World time it expires, µs.
    pub expires: Micros,
}

fn bad(detail: &str) -> Refusal {
    Refusal {
        name: "order-bad",
        detail: detail.into(),
    }
}

fn event(name: &str, fields: Vec<(u64, Value)>) -> Event {
    Event {
        name: Name::new(name).expect("a constant name"),
        fields: fields.into_iter().collect(),
        changes: Vec::new(),
        rest: Rest::new(),
    }
}

impl Order {
    /// The event that records it as accepted, on `body`'s entry.
    pub fn event(&self) -> Event {
        event(
            ORDER,
            vec![
                (1, self.intent.to_value()),
                (2, Value::Text(self.skill.clone())),
                (3, self.to.to_value()),
                (
                    4,
                    Value::Array(vec![int(self.goal.x), int(self.goal.y), int(self.goal.z)]),
                ),
                (5, int(self.expires)),
            ],
        )
    }

    /// The order an [`ORDER`] event on `body`'s entry records.
    pub fn read(body: Id, ev: &Event) -> Result<Order, Refusal> {
        let f = |k: u64| ev.fields.get(&k).ok_or_else(|| bad(&format!("field {k}")));
        let goal = match f(4)? {
            Value::Array(a) if a.len() == 3 => {
                let c: Vec<i64> = a.iter().filter_map(decode_int).collect();
                match c[..] {
                    [x, y, z] => Vec3::new(x, y, z),
                    _ => return Err(bad("the goal")),
                }
            }
            _ => return Err(bad("the goal")),
        };
        Ok(Order {
            intent: read_id(f(1)?)?,
            body,
            skill: match f(2)? {
                Value::Text(n) => n.clone(),
                _ => return Err(bad("the skill")),
            },
            to: read_id(f(3)?)?,
            goal,
            expires: decode_int(f(5)?).ok_or_else(|| bad("the expiry"))?,
        })
    }
}

/// The event that ends `intent` by `reason`: a refusal's plain name is written in the `souls:` namespace, since a
/// record holds names, never words (T6 rule 10).
pub fn ended(intent: Id, reason: &str) -> Event {
    let reason = match reason.contains(':') {
        true => named(reason),
        false => named(&format!("souls:{reason}")),
    };
    event(
        ORDER_ENDED,
        vec![(1, intent.to_value()), (2, Value::Text(reason))],
    )
}

/// The intents `parts` (a log's records, in order) hold as accepted and not ended, in log order.
pub fn active(parts: &[Part]) -> Result<Vec<Order>, Refusal> {
    let mut open: Vec<Order> = Vec::new();
    for p in parts {
        for e in &p.effects {
            for ev in e.events.iter().flatten() {
                match ev.name.as_str() {
                    ORDER => open.push(Order::read(e.envelope.node, ev)?),
                    ORDER_ENDED => {
                        let intent = read_id(ev.fields.get(&1).ok_or_else(|| bad("field 1"))?)?;
                        open.retain(|o| o.intent != intent);
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(open)
}

/// Hands each of `orders` to its skill again on `runner`, or ends it: `skill` builds an order's skill from the body
/// as the restarted world holds it (`None`: no such skill; `Err`: it cannot start from there). `now` is the
/// restart's world time. Returns the orders ended, each with its reason, to be written as [`ended`] records.
pub fn hand_back(
    runner: &mut Runner,
    orders: &[Order],
    now: Micros,
    mut skill: impl FnMut(&Order, &Moved) -> Result<Option<Box<dyn Skill>>, Refusal>,
) -> Vec<(Order, Refusal)> {
    let mut out = Vec::new();
    let mut end = |o: &Order, name: &'static str, detail: String| {
        out.push((o.clone(), Refusal { name, detail }));
    };
    for o in orders {
        if o.expires <= now {
            end(o, "order-expired", format!("at {} µs", o.expires));
            continue;
        }
        let Some(body) = runner.controller.body(o.body).copied() else {
            end(o, "body-unknown", replica::world_model::show(o.body));
            continue;
        };
        let s = match skill(o, &body) {
            Ok(Some(s)) => s,
            Ok(None) => {
                end(o, "skill-unknown", o.skill.as_str().into());
                continue;
            }
            Err(r) => {
                end(o, r.name, r.detail);
                continue;
            }
        };
        if let Err(r) = runner.start(o.body, s) {
            end(o, r.name, r.detail);
        }
    }
    out
}
