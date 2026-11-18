//! A body's change of size class (Engine v2 B12, #2743): N10's check when geometry changes
//! ([`super::exits::check`]) is run on the new class's cut of the node the body stands on, before anything changes.
//!
//! - **Read, never cut.** The check reads the new class's cut as it is kept ([`Ready`]: the open ground's squares and
//!   the buildings read with it, as the walk's town keeps them, `crate::walk::town::Cut`). Nothing is cut here, so a
//!   check costs no cutting on the world's tick: a class is cut off the tick, and a check for a class not yet cut is
//!   refused by its caller as `size-not-ready` (retry once it is).
//! - **Refused, the old body kept.** A body the new class's ground would leave off the ground is refused as
//!   `size-would-not-fit`; one on a piece with no way out for that class as `size-no-way-out`. Either way the body's
//!   [`Build`] is left as it was.
//! - **A way out** is N10's: a doorway or step that still passes the new class's centre, the end of a stair, ramp or
//!   ladder of the floor that the class can use, or, on the open ground, the square's edge. A stair, ramp, doorway or
//!   step narrower than the body with its clearance ([`too_narrow`]) is no way out, as it is no route
//!   (`crate::routes`), and nor is one whose far side has no ground for the class: a doorway between rooms, or a
//!   doorway or step to the open ground that the class's open ground does not meet with room for the body.
//!
//! Integers only: µm and mm.

use super::exits::{Finding, check};
use super::{MARGIN, Patch, SQUARE};
use crate::links::{Building, Kind};
use replica::effects::Refusal;
use replica::ids::Id;
use replica::kinds::sizes::{Build, Size};
use replica::pose::Vec3;
use replica::world_model::show;
use std::collections::BTreeMap;

/// A link walked through, `width_um` wide (0: not known), is too narrow for a body of `radius` mm with its clearance.
pub fn too_narrow(width_um: i64, radius: i64) -> bool {
    width_um > 0 && width_um < 2 * (radius + MARGIN) * 1000
}

/// One size class's cut as it is kept, ready to be read: each square of the open ground, and every building read
/// with that open ground (its floors' patches and its links, a link to the open ground with both ends).
#[derive(Clone, Copy)]
pub struct Ready<'a> {
    pub squares: &'a BTreeMap<(i32, i32), Patch>,
    pub buildings: &'a [Building],
}

fn refusal(name: &'static str, detail: String) -> Refusal {
    Refusal { name, detail }
}

/// Changes `build` to the class `to` for the body `body` standing at `at` (µm, the frame of `node`: a floor, or the
/// open ground `ground`), reading `ready`, the cut of `to`; or refuses it by name and leaves `build` as it was.
pub fn change_size(
    ready: Ready,
    ground: Id,
    node: Id,
    body: Id,
    at: Vec3,
    build: &mut Build,
    to: Size,
) -> Result<(), Refusal> {
    let r = to.radius_mm();
    let none = Patch {
        radius: r,
        pieces: Vec::new(),
        meets: Vec::new(),
    };
    let found = if node == ground {
        let sq = |v: i64| (v / 1000).div_euclid(SQUARE) as i32;
        let patch = ready.squares.get(&(sq(at.x), sq(at.z))).unwrap_or(&none);
        check(patch, true, &[], &[(body, at)])
    } else {
        match ready
            .buildings
            .iter()
            .find_map(|b| b.floors.get(&node).map(|(_, p)| (b, p)))
        {
            // A floor the class has no ground on.
            None => check(&none, false, &[], &[(body, at)]),
            Some((b, patch)) => {
                // A doorway or step this class cannot cross (too narrow, or its far side has no ground for it) is no
                // way out, though its own width may still pass the centre.
                let dead: Vec<Id> = b
                    .links
                    .iter()
                    .filter(|l| matches!(l.kind, Kind::Doorway | Kind::Step))
                    .filter(|l| l.blocked.is_some() || too_narrow(l.width, r))
                    .map(|l| l.id)
                    .collect();
                let ends: Vec<Vec3> = b
                    .links
                    .iter()
                    .filter(|l| {
                        !matches!(l.kind, Kind::Doorway | Kind::Step) && l.blocked.is_none()
                    })
                    .filter(|l| l.kind == Kind::Ladder || !too_narrow(l.width, r))
                    .flat_map(|l| l.ends.iter().flatten().filter(|e| e.floor == node))
                    .map(|e| e.middle())
                    .collect();
                // A meet of no link the building holds (a step the open ground does not meet) leads nowhere.
                let held = |id: Id| b.links.iter().any(|l| l.id == id);
                if patch
                    .meets
                    .iter()
                    .any(|m| dead.contains(&m.link) || !held(m.link))
                {
                    let mut patch = patch.clone();
                    for m in patch
                        .meets
                        .iter_mut()
                        .filter(|m| dead.contains(&m.link) || !held(m.link))
                    {
                        m.width_left = 0;
                    }
                    check(&patch, false, &ends, &[(body, at)])
                } else {
                    check(patch, false, &ends, &[(body, at)])
                }
            }
        }
    };
    match found.first() {
        None => {
            build.size = to;
            Ok(())
        }
        Some(Finding { why, .. }) => Err(refusal(
            if *why == "off-ground" {
                "size-would-not-fit"
            } else {
                "size-no-way-out"
            },
            format!(
                "{} as {} ({} mm wide) at ({}, {}) mm on {}: {why}; it stays {}",
                show(body),
                to.name(),
                2 * r,
                at.x / 1000,
                at.z / 1000,
                show(node),
                build.size.name()
            ),
        )),
    }
}
