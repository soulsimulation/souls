//! `carry:turn` (#5067, Gene's "orienting"): a crew turns the load it carries about its middle, on open ground.
//!
//! - **The ask.** Any member asks, the crew's activity as the target, parameter 3 the load's heading wanted on the plan
//!   (`[x, z]`, from its back toward its front: the field a front's walk names its heading in). A carry on a lift's or
//!   a set-down's track, or broken off, is refused by name.
//! - **The turn.** The shorter way round, at most [`RATE`] a tick (30 degrees a second), so in whole ticks. Each
//!   carrier, the front, the back and every side, is walked by the world round the load's middle on its own arc, a
//!   point every tick, at the pace that has it there when the turn ends: they keep their places at their grips. The
//!   carry's own step puts the load between its front and its back each tick, so the load turns with them, one motion
//!   sample a tick, and goes on at its new heading.
//! - **Refused before anything moves** (`carry-turn-blocked`): when the load, as it is held, would meet fixed
//!   geometry at any tick of the turn (naming where), or a carrier's arc is not ground its body stands on (naming it).
//! - **Words.** `souls:carry-track` `souls:turn` with the turn's start and end.

use replica::effects::{Actor, Cause};
use replica::ids::Id;
use replica::pose::{Quat, Vec3};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::show;
use sim::activity::carry::{Fixed, HOIST_TICK, outline};
use sim::controller::{Controller, Track};

use super::{Act, Engine, R, refusal, stands, way_is_ground};

/// How far a carried load turns in one tick at most, millidegrees: 30 degrees a second at 20 ticks a second.
pub const RATE: i64 = 1_500;

/// The yaw of `d` on the plan, millidegrees in `[0, 360000)`, as `Quat::from_yaw_mdeg` turns +x: the nearest whole
/// one, found by a search (no floating point).
fn yaw_of(d: [i64; 2]) -> R<i64> {
    let pose = |e| refusal("part-pose", format!("{e:?}"));
    let dot = |m: i64| -> R<i128> {
        let v = Quat::from_yaw_mdeg(m)
            .and_then(|q| q.rotate(Vec3::new(1 << 20, 0, 0)))
            .map_err(pose)?;
        Ok(i128::from(v.x) * i128::from(d[0]) + i128::from(v.z) * i128::from(d[1]))
    };
    let mut best = (0, i128::MIN);
    for step in [1_000, 10, 1] {
        let (lo, hi) = if step == 1_000 {
            (0, 359_999)
        } else {
            (best.0 - step * 100, best.0 + step * 100)
        };
        let mut m = lo;
        while m <= hi {
            let d = dot(m)?;
            if d > best.1 {
                best = (m, d);
            }
            m += step;
        }
    }
    Ok(best.0.rem_euclid(360_000))
}

/// `p` turned `mdeg` about `mid` on the plan.
fn turned(p: Vec3, mid: Vec3, mdeg: i64) -> R<Vec3> {
    let v = Quat::from_yaw_mdeg(mdeg)
        .and_then(|q| q.rotate(Vec3::new(p.x - mid.x, 0, p.z - mid.z)))
        .map_err(|e| refusal("part-pose", format!("{e:?}")))?;
    Ok(Vec3::new(mid.x + v.x, p.y, mid.z + v.z))
}

impl Engine {
    /// The act `carry:turn` on `tree`. See the module's notes.
    pub(super) fn turn_act(
        &mut self,
        tree: &mut Tree,
        c: &mut Controller,
        town: &sim::walk::town::Town,
        a: &Act,
        now: Micros,
    ) -> R<()> {
        let activity = a
            .target
            .ok_or_else(|| refusal("carry-needs-an-activity", "a target node"))?;
        let members: Vec<Id> = self
            .activities
            .members(activity)
            .ok_or_else(|| refusal("activity-missing", show(activity)))?
            .iter()
            .map(|m| m.body)
            .collect();
        if !members.contains(&a.body) {
            return Err(refusal("not-a-member", show(a.body)));
        }
        let carry = self
            .carries
            .get(&activity)
            .ok_or_else(|| refusal("carry-not-lifted", show(activity)))?;
        if carry.lifting() {
            return Err(refusal("carry-lifting", show(activity)));
        }
        if carry.lowering() {
            return Err(refusal("carry-setting-down", show(activity)));
        }
        let want = match super::param_point(&a.params, 3, "carry-turn-heading")? {
            Some(v) if v.x != 0 || v.z != 0 => [v.x, v.z],
            _ => return Err(refusal("carry-turn-heading", "parameter 3: a heading [x, z]")),
        };
        let (front, back) = carry
            .ends()?
            .ok_or_else(|| refusal("carry-not-lifted", show(activity)))?;
        let mid = carry
            .track
            .last()
            .map(|(_, p, _)| *p)
            .ok_or_else(|| refusal("carry-not-lifted", show(activity)))?;
        let mid = Vec3::new(mid.x, 0, mid.z);
        let now_yaw = yaw_of([front[0] - back[0], front[1] - back[1]])?;
        let mut turn = (yaw_of(want)? - now_yaw).rem_euclid(360_000);
        if turn > 180_000 {
            turn -= 360_000;
        }
        let turn = turn.clamp(-179_000, 179_000);
        let ticks = (turn.abs() + RATE - 1) / RATE;
        if ticks == 0 {
            return Ok(());
        }
        let ground = carry.ground;
        // The load as it is held, at every tick of the turn, against its ground's fixed geometry.
        let fixed = Fixed::of(tree, ground).map_err(|e| refusal("carry-geometry", e))?;
        let (plan, band) = carry.load.as_held()?;
        let (f0, b0) = (Vec3::new(front[0], 0, front[1]), Vec3::new(back[0], 0, back[1]));
        let start = fixed.hits(&outline(front, back, &plan));
        for k in 1..=ticks {
            let m = turn * k / ticks;
            let (f, b) = (turned(f0, mid, m)?, turned(b0, mid, m)?);
            let q = outline([f.x, f.z], [b.x, b.z], &plan);
            if let Some(hit) = fixed.hit_but(&q, band, &start) {
                return Err(refusal(
                    "carry-turn-blocked",
                    format!(
                        "turned {} degrees of {}, the load meets the box at ({}, {}) mm; next: carry it to open ground, \
                         then turn it",
                        m / 1000,
                        turn / 1000,
                        hit[0][0] / 1000,
                        hit[0][1] / 1000
                    ),
                ));
            }
        }
        // Each carrier's arc, a point a tick, over ground its body stands on.
        let span = ticks * HOIST_TICK;
        let mut walks = Vec::new();
        for body in &members {
            let (on, feet) = stands(c, *body)?;
            if on != ground || c.carried(*body) {
                return Err(refusal(
                    "carry-turn-blocked",
                    format!("{} does not stand on the crew's ground", show(*body)),
                ));
            }
            let mut line = Vec::new();
            let mut last = feet;
            let mut far = 0i128;
            for k in 1..=ticks {
                let p = turned(feet, mid, turn * k / ticks)?;
                if !way_is_ground(c, town, ground, *body, last, p) {
                    return Err(refusal(
                        "carry-turn-blocked",
                        format!(
                            "{}'s way round the load, at ({}, {}) mm, is not ground it can walk; next: carry it to open \
                             ground, then turn it",
                            show(*body),
                            p.x / 1000,
                            p.z / 1000
                        ),
                    ));
                }
                far += (i128::from(p.x - last.x).pow(2) + i128::from(p.z - last.z).pow(2)).isqrt();
                last = p;
                line.push(p);
            }
            let speed = i64::try_from(far * 1_000_000 / i128::from(span)).unwrap_or(1).max(1);
            walks.push((*body, line, speed));
        }
        // A walk the front led is over: the world walks every carrier now.
        self.led.remove(&activity);
        for (body, line, speed) in walks {
            let track = Track {
                link: None,
                line,
                speed,
                to: ground,
                arrive: None,
                hold: false,
            };
            if let Err(e) = c.carry_on(body, track) {
                eprintln!("worldd: {} was not walked round its load: {e}", show(body));
            }
        }
        let word = (now, Actor::Soul(a.soul), Cause::Intent(a.id));
        self.activities.next = tree.next();
        let load = self.carries.get(&activity).map(|c| c.board).unwrap_or(activity);
        if let Err(e) = self.activities.carry_track(
            tree,
            activity,
            load,
            "souls:turn",
            (now, now + span),
            None,
            word,
        ) {
            eprintln!("worldd: a turn's track was not said: {e}");
        }
        self.collect(Some((a.id, a.soul)));
        Ok(())
    }
}
