//! A body's change of size class (Engine v2 B12, #2743): the node it stands on is cut for the new class, and N10's
//! check when geometry changes ([`super::exits::check`]) is run on that cut before anything changes.
//!
//! - **Refused, the old body kept.** A body the new class's ground would leave off the ground is refused as
//!   `size-would-not-fit`; one on a piece with no way out for that class as `size-no-way-out`. Either way the body's
//!   [`Build`] is left as it was.
//! - **A way out** is N10's: a doorway that still passes the new class's centre, the end of a stair, ramp or ladder of
//!   the floor that the class can use, or, on the open ground, the square's edge. A stair, ramp or doorway narrower
//!   than the body with its clearance ([`too_narrow`]) is no way out, as it is no route (`crate::routes`), and nor is a
//!   doorway between two rooms whose far side has no ground for the class. A doorway to the open ground is taken to
//!   lead out: the open ground is not cut here.
//!
//! Integers only: µm and mm.

use super::exits::{Finding, check};
use super::{MARGIN, OpenGround, SQUARE, Scene, Turn, cut_floor};
use crate::links::{Building, Kind};
use replica::effects::Refusal;
use replica::ids::Id;
use replica::kinds::sizes::{Build, Size};
use replica::pose::Vec3;
use replica::tree::Tree;
use replica::world_model::show;

/// A link walked through, `width_um` wide (0: not known), is too narrow for a body of `radius` mm with its clearance.
pub fn too_narrow(width_um: i64, radius: i64) -> bool {
    width_um > 0 && width_um < 2 * (radius + MARGIN) * 1000
}

fn refusal(name: &'static str, detail: String) -> Refusal {
    Refusal { name, detail }
}

/// Changes `build` to the class `to` for the body `body` standing at `at` (µm, the frame of `node`: a floor, or the
/// open ground `ground`), or refuses it by name and leaves `build` as it was.
pub fn change_size(
    tree: &Tree,
    ground: Id,
    node: Id,
    body: Id,
    at: Vec3,
    build: &mut Build,
    to: Size,
) -> Result<(), Refusal> {
    let r = to.radius_mm();
    let fail = |e: String| refusal("size-not-checked", e);
    let (patch, ends) = if node == ground {
        let open = OpenGround::prepare(&Scene::of(tree, ground).map_err(fail)?, r).map_err(fail)?;
        let sq = |v: i64| (v / 1000).div_euclid(SQUARE) as i32;
        (open.cut_square(sq(at.x), sq(at.z)), Vec::new())
    } else {
        let h = tree
            .handle(node)
            .ok_or_else(|| fail("no such node".into()))?;
        let thing = tree
            .node(h)
            .and_then(|n| n.parent())
            .ok_or_else(|| fail("a floor with no thing".into()))?;
        let b = Building::read_sized(tree, thing, None, r).map_err(fail)?;
        let mut patch = match b.floors.get(&node) {
            Some((_, p)) => p.clone(),
            None => {
                cut_floor(&Scene::of(tree, node).map_err(fail)?, r, Turn::NONE).map_err(fail)?
            }
        };
        // A doorway inside the building that this class cannot cross (its far side has no ground for it, or it is
        // too narrow) is no way out, though its own width still passes the centre.
        let dead: Vec<Id> = b
            .links
            .iter()
            .filter(|l| l.kind == Kind::Doorway && !l.nodes.contains(&ground))
            .filter(|l| l.blocked.is_some() || too_narrow(l.width, r))
            .map(|l| l.id)
            .collect();
        for m in patch.meets.iter_mut().filter(|m| dead.contains(&m.link)) {
            m.width_left = 0;
        }
        let ends: Vec<Vec3> = b
            .links
            .iter()
            .filter(|l| !matches!(l.kind, Kind::Doorway | Kind::Step) && l.blocked.is_none())
            .filter(|l| l.kind == Kind::Ladder || !too_narrow(l.width, r))
            .flat_map(|l| l.ends.iter().flatten().filter(|e| e.floor == node))
            .map(|e| e.middle())
            .collect();
        (patch, ends)
    };
    match check(&patch, node == ground, &ends, &[(body, at)]).first() {
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
