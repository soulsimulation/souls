//! Steering a rowing punt (#3603): today's `carrier_steer` (`mars/viewer/engine/vehicles/carrier.ts`) as two engine
//! verbs ([`crate::engine`]) on the punt, from a rider seated in it. No code here names a kind: a thing on a course
//! ([`replica::schedule::F_COURSE`]) is steered.
//!
//! - **`carrier:steer`**, parameter 1 a point `[x, z]` (or `[x, y, z]`) µm in the punt's parent's frame: one straight
//!   leg from where the punt is now, over water deep enough to float it, ending 3 m short of the first shore on the
//!   way (`sim::courses::punts::reach`), rowed at 0.6 m/s.
//! - **`carrier:land`**: back along its wake to where it left its own loop, round the rest of that lap, to its home.
//!   A punt lets riders off only at its own bank: a land with a point (parameter 1, as a steer's) more than 6 m from
//!   its home is refused `no-landing-spot`, as today's is.
//! - **`carrier:stop`**: holds the punt where it is, refused `not-aloft` while it still stands at its own loop's
//!   boarding stop.
//! - **A hold runs out.** A steered punt standing where a steer or a stop left it, away from its home, rows back to it
//!   by itself after 120 s with no new steer, as today's does ([`settle`]), so a rider is never left on the water.
//! - **Written once.** Each is one entry on the punt: its course set to the new one, run once
//!   ([`replica::schedule::course::Shape::Once`]) from now, and its steer ([`replica::schedule::F_STEER`]: who steers,
//!   the loop it left and when, the wake). A replay or a restart reads the same course; [`restore`] hands each course
//!   to the slots again. The punt's riders are carried because their frame is its slot; nothing is written per tick.
//! - **Refusals** keep today's names: `not-aboard` (the body is not seated in it), `steered` (another rider still
//!   aboard steers it), `out-of-bounds` (more than 1200 m from its home), `no-water-route` (no open water that way),
//!   `no-landing-spot`, `not-aloft`, and `steer-needs-a-point` for a steer with no point. Nothing moves on a refusal.
//! - **Home again.** A steered punt standing at its home with nobody aboard takes up its own loop again from that
//!   moment ([`settle`]), its boarding stop first: an entry of the world's.

use std::collections::{BTreeMap, BTreeSet};

use replica::effects::Change;
use replica::effects::{Actor, Body, Cause, ChangeRec, Effect, Envelope, Refusal, Rest};
use replica::encode::Value;
use replica::ids::Id;
use replica::pose::Vec3;
use replica::schedule::course::{Course, place_at};
use replica::schedule::{F_COURSE, F_STEER};
use replica::sky::as_int;
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::show;
use sim::courses::punts::{self, STEER_RANGE, Steer};
use sim::slots::Slots;

type R<T> = Result<T, Refusal>;

fn refusal(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

/// What a rider asks of the punt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ask {
    Steer,
    Land,
    Stop,
}

/// How long a steered punt holds where a steer or a stop left it before it rows home by itself, µs (today's
/// `STEER_HOVER`).
pub const HOLD: Micros = 120_000_000;
/// How near its home a land's point must be, µm: a punt lets riders off only at its own bank (today's 6 m).
pub const LAND_NEAR: i64 = 6_000_000;

/// One entry on `node` of `changes`, caused by `cause`, acted by `actor`.
fn entry(
    tree: &Tree,
    node: Id,
    changes: Vec<Change>,
    now: Micros,
    cause: Cause,
    actor: Actor,
) -> R<Effect> {
    let audience = tree
        .handle(node)
        .and_then(|h| tree.node(h))
        .map(|n| n.audience())
        .ok_or_else(|| refusal("not-a-carrier", show(node)))?;
    Ok(Effect {
        envelope: Envelope {
            sequence: 0,
            at: now,
            cause,
            actor,
            audience,
            node,
        },
        body: Body::Changes(
            changes
                .into_iter()
                .map(|change| ChangeRec {
                    change,
                    rest: Rest::new(),
                })
                .collect(),
        ),
        events: None,
        rest: Rest::new(),
    })
}

fn set(node: Id, field: u64, to: Value) -> Change {
    Change::Set {
        node,
        field,
        to,
        by: None,
    }
}

/// A steer's point, parameter 1: `[x, z]` or `[x, y, z]` µm.
fn point(params: &BTreeMap<u64, Value>) -> R<[i64; 2]> {
    let bad = || {
        refusal(
            "steer-needs-a-point",
            "parameter 1: [x, z] um in the boat's frame",
        )
    };
    let Some(Value::Array(p)) = params.get(&1) else {
        return Err(bad());
    };
    match p.as_slice() {
        [x, z] | [x, _, z] => Ok([as_int(x).ok_or_else(bad)?, as_int(z).ok_or_else(bad)?]),
        _ => Err(bad()),
    }
}

/// `body` steers or lands `punt` at `now` on `live`, the seats in `slots`: the punt's entry, its new course handed to
/// the slots. `None` for `punt` is refused `steer-needs-a-boat`.
#[allow(clippy::too_many_arguments)]
pub fn act(
    live: &Tree,
    slots: &mut Slots,
    ask: Ask,
    body: Id,
    punt: Option<Id>,
    params: &BTreeMap<u64, Value>,
    now: Micros,
    by: (Cause, Actor),
) -> R<Effect> {
    let punt = punt.ok_or_else(|| refusal("steer-needs-a-boat", "a target node"))?;
    let node = live
        .handle(punt)
        .and_then(|h| live.node(h))
        .ok_or_else(|| refusal("not-a-carrier", show(punt)))?;
    let fields = node.fields();
    let course = fields
        .get(&F_COURSE)
        .and_then(Course::read)
        .ok_or_else(|| {
            refusal(
                "not-a-carrier",
                format!("{} moves on no course", show(punt)),
            )
        })?;
    let aboard = slots
        .seated()
        .iter()
        .any(|&(b, thing, _)| b == body && thing == punt);
    if !aboard {
        return Err(refusal(
            "not-aboard",
            format!("{} is not seated in {}", show(body), show(punt)),
        ));
    }
    let steering = fields.get(&F_STEER).and_then(Steer::read);
    if let Some(s) = &steering
        && s.by != body
        && slots.holders(punt).contains(&s.by)
    {
        return Err(refusal(
            "steered",
            format!("{} is steering {}", show(s.by), show(punt)),
        ));
    }
    let placed = node.place().map_or(Vec3::ZERO, |p| p.position);
    let (here, _) = place_at(fields, placed, now);
    let steered = steering.is_some();
    let mut s = steering.unwrap_or(Steer {
        by: body,
        own: course.clone(),
        left: now,
        wake: Vec::new(),
    });
    s.by = body;
    let home = s.home();
    let far = |d: i64| i128::from(d) * i128::from(d);
    let next = match ask {
        Ask::Steer => {
            let to = point(params)?;
            if far(to[0] - home.x) + far(to[1] - home.z) > far(STEER_RANGE) {
                return Err(refusal(
                    "out-of-bounds",
                    format!(
                        "({:.0}, {:.0}) m is outside the world {} can travel",
                        to[0] as f64 / 1e6,
                        to[1] as f64 / 1e6,
                        show(punt)
                    ),
                ));
            }
            let no_route = || {
                refusal(
                    "no-water-route",
                    format!(
                        "there is no open water from here toward ({:.0}, {:.0}) m",
                        to[0] as f64 / 1e6,
                        to[1] as f64 / 1e6
                    ),
                )
            };
            let ground = node.parent().ok_or_else(no_route)?;
            let (waters, terrain) = punts::waters_of(live, ground).map_err(|_| no_route())?;
            let at = punts::reach(&waters, terrain.as_ref(), here, to).ok_or_else(no_route)?;
            s.wake.push(here);
            punts::once(here, &[at], now)?
        }
        Ask::Land => {
            if params.contains_key(&1) {
                let to = point(params)?;
                if far(to[0] - home.x) + far(to[1] - home.z) > far(LAND_NEAR) {
                    return Err(refusal(
                        "no-landing-spot",
                        format!(
                            "{} lets riders off only at its own bank; land with no point to row back there",
                            show(punt)
                        ),
                    ));
                }
            }
            punts::once(here, &punts::back(&s), now)?
        }
        Ask::Stop => {
            let boarding = !steered
                && course
                    .load()
                    .is_ok_and(|t| matches!(t.stopped(now), Ok(Some(st)) if st.station == 0));
            if boarding {
                return Err(refusal(
                    "not-aloft",
                    format!("{} has not left yet", show(punt)),
                ));
            }
            s.wake.push(here);
            punts::once(here, &[], now)?
        }
    };
    let e = entry(
        live,
        punt,
        vec![
            set(punt, F_COURSE, next.to_value()),
            set(punt, F_STEER, s.to_value()),
        ],
        now,
        by.0,
        by.1,
    )?;
    slots.moving(punt, &next, home)?;
    Ok(e)
}

/// The steered punts of `steered` that stand at their home at `now` with nobody aboard take up their own loop again
/// from `now`: one entry of the world's each, their courses handed to the slots. A punt no longer steered is dropped.
pub fn settle(
    live: &Tree,
    slots: &mut Slots,
    steered: &mut BTreeSet<Id>,
    now: Micros,
) -> Vec<Effect> {
    let mut out = Vec::new();
    let mut done = Vec::new();
    for &punt in steered.iter() {
        let Some(node) = live.handle(punt).and_then(|h| live.node(h)) else {
            done.push(punt);
            continue;
        };
        let (Some(s), Some(course)) = (
            node.fields().get(&F_STEER).and_then(Steer::read),
            node.fields().get(&F_COURSE).and_then(Course::read),
        ) else {
            done.push(punt);
            continue;
        };
        let home = s.home();
        let Ok(t) = course.load() else { continue };
        let stopped = matches!(t.stopped(now), Ok(Some(_)));
        let at_home = t.at(now).is_ok_and(|(p, _)| p.x == home.x && p.z == home.z);
        if stopped && !at_home && now >= course.t0.saturating_add(course.within).saturating_add(HOLD) {
            // The hold ran out: rowed home along its wake, its rider (if any) carried.
            let (here, _) = t.at(now).unwrap_or((home, Vec3::ZERO));
            let back = punts::once(here, &punts::back(&s), now).and_then(|c| {
                let e = entry(
                    live,
                    punt,
                    vec![set(punt, F_COURSE, c.to_value())],
                    now,
                    Cause::World,
                    Actor::World,
                )?;
                slots.moving(punt, &c, home)?;
                Ok(e)
            });
            match back {
                Ok(e) => out.push(e),
                Err(r) => eprintln!("worldd: {} holds where it is: {r}", show(punt)),
            }
            continue;
        }
        if !(stopped && at_home) || !slots.holders(punt).is_empty() {
            continue;
        }
        let own = Course { t0: now, ..s.own };
        let e = entry(
            live,
            punt,
            vec![
                set(punt, F_COURSE, own.to_value()),
                set(punt, F_STEER, Value::Map(BTreeMap::new())),
            ],
            now,
            Cause::World,
            Actor::World,
        );
        match (e, slots.moving(punt, &own, home)) {
            (Ok(e), Ok(())) => {
                out.push(e);
                done.push(punt);
            }
            (Err(r), _) | (_, Err(r)) => eprintln!("worldd: {} keeps its course: {r}", show(punt)),
        }
    }
    for p in done {
        steered.remove(&p);
    }
    out
}

/// After a start: every thing on a course in `live` is handed to the slots with its course as the log left it, its home
/// its own loop's first station; the steered ones are returned.
pub fn restore(live: &Tree, slots: &mut Slots) -> R<BTreeSet<Id>> {
    let mut steered = BTreeSet::new();
    let mut stack = vec![live.root()];
    while let Some(h) = stack.pop() {
        stack.extend(live.children(h).unwrap_or(&[]).iter().copied());
        let Some(n) = live.node(h) else { continue };
        let Some(course) = n.fields().get(&F_COURSE).and_then(Course::read) else {
            continue;
        };
        let home = match n.fields().get(&F_STEER).and_then(Steer::read) {
            Some(s) => {
                steered.insert(n.id());
                s.home()
            }
            None => course.stations.first().map_or(Vec3::ZERO, |s| s.at),
        };
        slots.moving(n.id(), &course, home)?;
    }
    Ok(steered)
}
