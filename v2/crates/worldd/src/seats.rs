//! The seats a served world registers at start-up (C17, #3453): each body slot its entries declare, placed on the floor
//! a body stands on, with a stand point a body can stand on. `worldd serve` and the C22 sweep both register them here.

use replica::ids::Id;
use replica::pose::{Quat, Vec3};
use replica::rules::json::Value as Json;
use sim::ground::scene::Solid;
use sim::slots::PlaceAt;
use sim::walk::town::Town;

/// The seats the world's entries `kinds` declare on its things ([`import_eden::body_slots`]), each placed on the floor a
/// body stands on: its point and facing there, and its stand point in the slot's frame. A stand point a body cannot
/// stand on (under a table, against a wall) is moved to the nearest place within a form's reach of it where a body
/// can (C15's rule, `skills::form_runner::REACH`), so a rise always sets the body down on clear ground; one in a
/// doorway's clearance is moved out of it ([`out_of_passage`]), so the gateway's walk to the seat ends at it. Returns the
/// seats, the things they are on, the count of every body slot on those things, the seats that could not be placed (no
/// floor above the thing) and the stand points moved.
pub fn places(
    town: &mut Town,
    kinds: &[(String, Json)],
) -> (Vec<PlaceAt>, usize, usize, usize, usize) {
    let (found, all) = import_eden::body_slots(&town.tree, kinds);
    let (buildings, ground) = (town.buildings.clone(), town.ground);
    let view = town.view();
    let (mut out, mut moved) = (Vec::new(), 0);
    // Seats whose stand point no body can stand on or near, but whose slot has a boarding reach: (index in `out`, the
    // slot, its stand point on the floor), boarded from clear ground below ([`board_from`]).
    let mut boarded = Vec::new();
    for s in &found {
        let Some((floor, point, facing)) = view.on_floor(s.thing, s.at) else {
            continue;
        };
        let mut place = PlaceAt {
            thing: s.thing,
            place: replica::moves::Place {
                slot: s.slot,
                height: s.at.y.max(0),
                stand: [s.stand.x - s.at.x, s.stand.z - s.at.z],
            },
            point,
            facing,
            floor,
        };
        // The stand point on the floor, at the floor's height under the seat.
        let stand = place.stand().map(|p| Vec3::new(p.x, point.y - s.at.y, p.z));
        let [w, x, y, z] = facing.parts();
        let back = replica::pose::Quat::new(w, -x, -y, -z);
        // A stand point in a doorway's clearance is one the spot tables never give a walker (N9): a walk to it ends
        // a ring out, beyond the sit's reach, so it is moved out of the doorway as a blocked one is moved clear.
        let passage = |p: Vec3| sim::walk::town::in_passage(&buildings, &[], ground, floor, p);
        let clear = stand.as_ref().ok().and_then(|&stand| {
            if view.stand_near(floor, stand, 1, None).is_none() {
                view.stand_near(floor, stand, skills::form_runner::REACH, None)
            } else if passage(stand) {
                out_of_passage(&view, floor, stand, point, &passage)
            } else {
                None
            }
        });
        if let (Some(clear), Ok(back)) = (clear, back)
            && let Ok(d) = back.rotate(Vec3::new(clear.x - point.x, 0, clear.z - point.z))
        {
            place.place.stand = [d.x, d.z];
            moved += 1;
        } else if let Ok(stand) = stand
            && s.board > 0
            && view.stand_near(floor, stand, 1, None).is_none()
        {
            boarded.push((out.len(), s.board, stand));
        }
        out.push(place);
    }
    drop(view);
    // The thing's own solids, in its floor's frame: the boarding step crosses only them and ground.
    let own: Vec<Vec<Solid>> = boarded
        .iter()
        .map(|&(i, _, _)| {
            let tree = &town.tree;
            let (thing, floor) = (out[i].thing, out[i].floor);
            tree.handle(thing)
                .zip(tree.handle(floor))
                .and_then(|(h, f)| sim::ground::scene::solids_under(tree, h, f).ok())
                .unwrap_or_default()
        })
        .collect();
    let view = town.view();
    for (&(i, board, stand), own) in boarded.iter().zip(&own) {
        let place = &mut out[i];
        let floor = place.floor;
        let [w, x, y, z] = place.facing.parts();
        let Ok(back) = Quat::new(w, -x, -y, -z) else {
            continue;
        };
        let slot = Vec3::new(place.point.x, stand.y, place.point.z);
        let passage = |p: Vec3| sim::walk::town::in_passage(&buildings, &[], ground, floor, p);
        if let Some(clear) = board_from(&view, floor, slot, stand, board, own, &passage)
            && let Ok(d) = back.rotate(Vec3::new(clear.x - slot.x, 0, clear.z - slot.z))
        {
            place.place.stand = [d.x, d.z];
            moved += 1;
        }
    }
    drop(view);
    let left = found.len() - out.len();
    let mut things: Vec<Id> = out.iter().map(|p| p.thing).collect();
    things.dedup();
    (out, things.len(), all, left, moved)
}

/// The nearest place to `at` (µm, `floor`'s frame) within [`skills::form_runner::REACH`] where a body may stand, that
/// is out of every doorway and stair (`passage`) and no nearer the slot's point `slot_at` than `at` is (so not into the
/// thing: a bed's mattress is not a solid), on [`sim::spots::within`]'s rings; `None` when none is.
fn out_of_passage(
    view: &sim::walk::town::View<'_>,
    floor: Id,
    at: Vec3,
    slot_at: Vec3,
    passage: &dyn Fn(Vec3) -> bool,
) -> Option<Vec3> {
    let pitch = sim::spots::REACH_PITCH;
    let mut best: Option<(i64, Vec3)> = None;
    for ring in 1..=skills::form_runner::REACH / pitch {
        let n = 6_283 * ring / 1_000;
        for k in 0..n {
            let Ok(off) = replica::pose::Quat::from_yaw_mdeg(k * 360_000 / n)
                .and_then(|q| q.rotate(Vec3::new(0, 0, ring * pitch)))
            else {
                continue;
            };
            let Some(p) =
                view.stand_near(floor, Vec3::new(at.x + off.x, at.y, at.z + off.z), 1, None)
            else {
                continue;
            };
            let gap = sim::spots::flat(p, at);
            let out = sim::spots::flat(p, slot_at) >= sim::spots::flat(at, slot_at);
            if out && !passage(p) && best.is_none_or(|b| gap < b.0) {
                best = Some((gap, p));
            }
        }
        if best.is_some() {
            break;
        }
    }
    best.map(|b| b.1)
}

/// Between the samples of a boarding step's straight line, µm.
const BOARD_STEP: i64 = 50_000;

/// Where a body gets onto a seat whose stand point `stand` no body can stand on or near (a boat's side afloat, #1960):
/// the nearest clear ground to the seat's slot `slot` (µm, `floor`'s frame, at the stand point's height) within the
/// slot's boarding reach `board`, on [`sim::spots::within`]'s rings round the slot; out of every doorway and stair
/// (`passage`); from which the straight step onto the slot crosses only ground (dry, wading or swimming) and the
/// thing's own solids `own`, grown by a standard body's radius, never another solid. On a ring, the place nearest the
/// entry's stand point wins, so a boat is boarded from the side its entry names; ties by place. `None` when none is.
fn board_from(
    view: &sim::walk::town::View<'_>,
    floor: Id,
    slot: Vec3,
    stand: Vec3,
    board: i64,
    own: &[Solid],
    passage: &dyn Fn(Vec3) -> bool,
) -> Option<Vec3> {
    let pitch = sim::spots::REACH_PITCH;
    let grow = replica::kinds::sizes::Size::Standard.radius_mm() * 1000;
    let crossed = |p: Vec3| {
        let n = (sim::spots::flat(p, slot) / BOARD_STEP).max(1);
        (0..=n).all(|k| {
            let at = Vec3::new(
                p.x + (slot.x - p.x) * k / n,
                p.y,
                p.z + (slot.z - p.z) * k / n,
            );
            view.on_any_ground(floor, at) || own.iter().any(|s| within_solid(s, at, grow))
        })
    };
    for ring in 1..=board / pitch {
        let n = 6_283 * ring / 1_000;
        let mut best: Option<(i64, Vec3)> = None;
        for k in 0..n {
            let Ok(off) = Quat::from_yaw_mdeg(k * 360_000 / n)
                .and_then(|q| q.rotate(Vec3::new(0, 0, ring * pitch)))
            else {
                continue;
            };
            let Some(p) = view.stand_near(
                floor,
                Vec3::new(slot.x + off.x, slot.y, slot.z + off.z),
                1,
                None,
            ) else {
                continue;
            };
            let gap = sim::spots::flat(p, stand);
            if std::env::var("SEAT_DIAG").is_ok() {
                eprintln!(
                    "BOARD ring {ring} p ({}, {}) slot-gap {} passage {} crossed {}",
                    p.x,
                    p.z,
                    sim::spots::flat(p, slot),
                    passage(p),
                    crossed(p)
                );
            }
            if sim::spots::flat(p, slot) <= board
                && best.is_none_or(|b| gap < b.0)
                && !passage(p)
                && crossed(p)
            {
                best = Some((gap, p));
            }
        }
        if best.is_some() {
            return best.map(|b| b.1);
        }
    }
    None
}

/// Whether `at` (x and z, µm) lies within `grow` of the solid `s`'s box, its four corners in order round it.
fn within_solid(s: &Solid, at: Vec3, grow: i64) -> bool {
    let p = [at.x, at.z];
    let mut inside = true;
    let mut gap = i64::MAX;
    for i in 0..4 {
        let (a, b) = (s.ring[i], s.ring[(i + 1) % 4]);
        let cross = i128::from(b[0] - a[0]) * i128::from(p[1] - a[1])
            - i128::from(b[1] - a[1]) * i128::from(p[0] - a[0]);
        if (cross < 0) != (signed_area(s) < 0) && cross != 0 {
            inside = false;
        }
        gap = gap.min(sim::spots::to_segment(
            Vec3::new(p[0], 0, p[1]),
            Vec3::new(a[0], 0, a[1]),
            Vec3::new(b[0], 0, b[1]),
        ));
    }
    inside || gap <= grow
}

/// Twice the signed area of the solid's ring: its winding.
fn signed_area(s: &Solid) -> i128 {
    (0..4)
        .map(|i| {
            let (a, b) = (s.ring[i], s.ring[(i + 1) % 4]);
            i128::from(a[0]) * i128::from(b[1]) - i128::from(b[0]) * i128::from(a[1])
        })
        .sum()
}
