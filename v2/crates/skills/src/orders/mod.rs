//! The three standing orders (Engine v2 B7, #2726; `v2/docs/intents.md` rules 5 and 7): an order is a skill instance
//! that keeps doing one thing the agent wrote, and nothing it did not write. Each claims what its kind needs, ends at
//! its expiry (world time) standing still, and is cancelled by B2's rules when another skill claims what it holds. The
//! order's record, its ends and a queue's line are the world's (`sim::orders`); here are only the skills.
//!
//! - **Hold** (`souls:hold`): claims the legs (the stance is theirs, B1) and the hands named, and stands still. The
//!   world sets the stance under its driver. Cancelled by a claim on the legs or on a hand.
//! - **Follow** (`souls:follow`): N13's follow ([`crate::close::Follow`]) with the order's expiry; it claims the legs.
//! - **Queue** (`souls:queue`): claims the legs and walks straight to the spot in the line the world gave it (field
//!   [`F_LINE`] on its own body), then stands. When the line moves up, the world gives it the next spot. Taking the
//!   slot at the head is the world's act, named by the order, once (`sim::orders`).
//!
//! None of them waits for a time or a condition: the expiry is when the order ends, never when it starts.

use replica::bodies::{Class, SkillShape, Want};
use replica::encode::{Name, Value};
use replica::host::{Host, Progress, Skill};
use replica::ids::Id;
use replica::pose::Vec3;
use replica::time::Micros;

use crate::close::{FAST, Follow, THERE, along, apart, go};

/// The verbs of the three orders (`replica::intents::ORDERS`).
pub const HOLD: &str = "souls:hold";
pub const FOLLOW: &str = "souls:follow";
pub const QUEUE: &str = "souls:queue";

/// A field the world sets on a queueing body: its spot in the line, `[x, y, z]` µm in its floor's frame.
pub use replica::host::F_LINE;

fn name(t: &str) -> Name {
    Name::new(t).unwrap_or_else(|| unreachable!("a fixed name"))
}

/// Whether the order has expired: it then stands and ends, `Done`.
fn expired(host: &mut dyn Host, until: Micros) -> bool {
    if host.now() >= until {
        go(host, Vec3::ZERO);
        return true;
    }
    false
}

/// A held stance: the legs and the hands named, held still until `until`.
pub struct Hold {
    pub hands: Vec<Name>,
    pub until: Micros,
}

impl Skill for Hold {
    fn shape(&self) -> SkillShape {
        let mut claims = vec![Want::All(Class::Locomotion)];
        claims.extend(self.hands.iter().cloned().map(Want::Named));
        SkillShape {
            name: name(HOLD),
            claims,
            blocks: Vec::new(),
            cancelled_by: vec![Class::Locomotion, Class::Manipulator],
        }
    }

    fn step(&mut self, host: &mut dyn Host) -> Progress {
        if expired(host, self.until) {
            return Progress::Done;
        }
        go(host, Vec3::ZERO);
        Progress::Going
    }
}

/// Follow `leader` within `band` (µm) until `until`: N13's follow, ended by the order's expiry. With `beside`, a
/// place that many µm beside the leader instead of its trail (0.135 R1, walking hand in hand); with `at`, a place at
/// that offset from the leader on the plan (x, z, µm: carrying together, moving-group rule 3).
pub fn follow(
    leader: Id,
    band: (i64, i64),
    beside: Option<i64>,
    at: Option<[i64; 2]>,
    until: Micros,
) -> Follow {
    match (beside, at) {
        (_, Some(o)) => Follow::at(leader, o, Some(until)),
        (Some(w), None) => Follow::beside(leader, w, Some(until)),
        (None, None) => Follow::new(leader, band, Some(until)),
    }
}

/// Standing in a queue until `until`: walks to the spot the world gives it in the line and stands there.
pub struct Queue {
    pub until: Micros,
}

/// A spot from an [`F_LINE`] value.
fn spot(v: &Value) -> Option<Vec3> {
    let Value::Array(a) = v else { return None };
    let c: Vec<i64> = a
        .iter()
        .filter_map(|x| match x {
            Value::Uint(u) => i64::try_from(*u).ok(),
            Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
            _ => None,
        })
        .collect();
    match c[..] {
        [x, y, z] => Some(Vec3::new(x, y, z)),
        _ => None,
    }
}

impl Skill for Queue {
    fn shape(&self) -> SkillShape {
        SkillShape {
            name: name(QUEUE),
            claims: vec![Want::All(Class::Locomotion)],
            blocks: Vec::new(),
            cancelled_by: vec![Class::Locomotion],
        }
    }

    fn step(&mut self, host: &mut dyn Host) -> Progress {
        if expired(host, self.until) {
            return Progress::Done;
        }
        let body = host.body();
        let Some(me) = host.read(body) else {
            return Progress::Failed(name("souls:body-gone"));
        };
        let Some(to) = me.fields.get(&F_LINE).and_then(spot) else {
            go(host, Vec3::ZERO);
            return Progress::Going;
        };
        let gap = apart(me.position, to);
        // Slowing as it comes in, so it stops on its spot: the gap closed in half a second, at most FAST.
        let speed = if gap <= THERE { 0 } else { (gap * 2).min(FAST) };
        go(
            host,
            along(to.x - me.position.x, to.z - me.position.z, speed),
        );
        Progress::Going
    }
}
