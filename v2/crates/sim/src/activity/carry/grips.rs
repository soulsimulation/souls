//! Who holds which grip (#5067 item 1): the carry's own rule ([`Load::of`]'s grips, [`Load::side_places`]'s order),
//! said once per carrier and kept on the carry's node, so a page can put each carrier's two hands on its grip.
//!
//! - **The rule** ([`assign`]): the load's two outermost grips along its own long axis are its ends' (as
//!   [`Load::of`] has them), the back taking the one nearer the carry's back as the load is held in its slot, the front
//!   the other; its grips between them ([`INNER`] at most) go to its side carriers in join order, from the back toward
//!   the front ([`Load::side_places`]). A load lifted the other way round ([`Load::reversed`]) or taken turned as it
//!   lay is read as it is held, so its back carrier holds the grip at its back.
//! - **Kept, not renumbered.** The holds are written on the carry's activity node ([`F_GRIPS`]) and said to its
//!   audience ([`GRIPS`]) whenever they change: at the lift or a take (`carry`), a seating's set-in and its way back
//!   (`set-in`, `return`, each with when its track ends), a carry taken up again (`carry`) and its end (`released`, the
//!   last holds kept so a page can show the hands letting go). A side carrier who leaves takes only its own hold away:
//!   every other carrier keeps its grip. The node is in the log, so the holds are there after a restart.
//! - **What a hold says** ([`Hold`]): the carrier's body, its grip (the entry's point name), the grip's point and its two
//!   hands' points, each µm in the load's own frame (its entry's frame: x and z centred, y from its floor up). The
//!   hands are [`HAND_HALF`] either side of where the carrier holds along the load's long axis (kept within its
//!   length): an end carrier at its grip, a side carrier at the grip's edge on the side it stands. The hands are in the
//!   order they lie along the carry, from its back toward its front, so a page gives each to the hand on that side of
//!   the body as it is drawn. A hand's target is the load's drawn pose times its point.
//!
//! The word and the field, `{1: activity, 2: load, 3: phase, 4: since µs, 5?: until µs, 6: [hold, ...]}`, a hold
//! `{1: body, 2: grip, 3: [x, y, z], 4: [[x, y, z], [x, y, z]]}`. B9's board, a load of no entry, has no grips: its
//! holds are empty.

use std::collections::BTreeMap;

use replica::encode::{Name, Value};
use replica::ids::Id;
use replica::pose::{Quat, Vec3};
use replica::rules::json::Value as Json;
use replica::time::Micros;

use super::{INNER, Load, R, pose_refusal};

/// The carry's activity node's field that holds who holds which grip.
pub const F_GRIPS: u64 = 5;
/// The world's word each time the holds or their phase change, to the carry's audience.
pub const GRIPS: &str = "souls:carry-grips";
/// How far either side of where a carrier holds its load its two hands are, along the load's long axis, µm.
pub const HAND_HALF: i64 = 200_000;

/// The phases a carry's holds are in: carried, on a seating's set-in track, on its way back, let go.
pub const CARRY: &str = "souls:carry";
pub const SET_IN: &str = "souls:set-in";
pub const RETURN: &str = "souls:return";
pub const RELEASED: &str = "souls:released";
/// A grip is said by its entry's point name after this (a part's texts are all `namespace:name`).
pub const POINT: &str = "point:";

/// A grip of a load's entry: its point's name, the point in the load's own frame (µm), and where it lies along the
/// load's long axis from its middle (µm), as [`Load::of`] reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grip {
    pub name: String,
    pub at: Vec3,
    pub along: i64,
}

/// Its entry's grips, in [`Load::of`]'s order: along its long axis from the back, then by name. None for an entry
/// that is not a load.
pub fn grips_of(entry: &Json) -> Result<Vec<Grip>, String> {
    // The axis and the middle as `Load::of` takes them (its longest side; the entry's y from the floor up).
    let load = Load::of(entry)?;
    let axis = if load.long.x != 0 {
        0
    } else if load.long.y != 0 {
        1
    } else {
        2
    };
    let middle = [0, load.middle.y, 0][axis];
    let mut grips: Vec<Grip> = entry
        .get("points")
        .and_then(Json::obj)
        .unwrap_or(&[])
        .iter()
        .filter(|(_, p)| p.get("role").and_then(Json::str) == Some("grip"))
        .filter_map(|(name, p)| {
            let at = p.get("at_mm").and_then(Json::arr)?;
            let mm = |k: usize| match at.get(k)? {
                Json::Int(n) => i64::try_from(*n).ok().map(|v| v * 1000),
                _ => None,
            };
            let at = Vec3::new(mm(0)?, mm(1)?, mm(2)?);
            Some(Grip {
                name: name.clone(),
                at,
                along: [at.x, at.y, at.z][axis] - middle,
            })
        })
        .collect();
    grips.sort_by(|a, b| (a.along, &a.name).cmp(&(b.along, &b.name)));
    Ok(grips)
}

/// One carrier's hold: its body, its grip's name, the grip's point and its two hands' points (µm, the load's own
/// frame), the hands from the carry's back toward its front.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hold {
    pub body: Id,
    pub grip: String,
    pub at: Vec3,
    pub hands: [Vec3; 2],
}

/// A carry's holds as said: its load, its phase, since when, until when (a track's end), and each carrier's hold.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Holds {
    pub load: Id,
    pub phase: String,
    pub since: Micros,
    pub until: Option<Micros>,
    pub holds: Vec<Hold>,
}

fn int(v: i64) -> Value {
    u64::try_from(v).map_or_else(|_| Value::Nint(v.unsigned_abs() - 1), Value::Uint)
}

fn read_int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(n) => i64::try_from(*n).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

fn point(v: Vec3) -> Value {
    Value::Array(vec![int(v.x), int(v.y), int(v.z)])
}

fn read_point(v: &Value) -> Option<Vec3> {
    match v {
        Value::Array(a) => match a.as_slice() {
            [x, y, z] => Some(Vec3::new(read_int(x)?, read_int(y)?, read_int(z)?)),
            _ => None,
        },
        _ => None,
    }
}

impl Holds {
    /// The word's fields, and the node's field's value: `{1: activity, 2: load, 3: phase, 4: since, 5?: until, 6:
    /// holds}`.
    pub fn fields(&self, activity: Id) -> R<BTreeMap<u64, Value>> {
        let phase = Name::new(&self.phase).ok_or_else(|| replica::effects::Refusal {
            name: "carry-grips",
            detail: format!("the phase {}", self.phase),
        })?;
        let mut holds = Vec::new();
        for h in &self.holds {
            let grip = Name::new(&format!("{POINT}{}", h.grip)).ok_or_else(|| {
                replica::effects::Refusal {
                    name: "carry-grips",
                    detail: format!("the grip {}", h.grip),
                }
            })?;
            holds.push(Value::Map(BTreeMap::from([
                (1, h.body.to_value()),
                (2, Value::Text(grip)),
                (3, point(h.at)),
                (4, Value::Array(vec![point(h.hands[0]), point(h.hands[1])])),
            ])));
        }
        let mut f = BTreeMap::from([
            (1, activity.to_value()),
            (2, self.load.to_value()),
            (3, Value::Text(phase)),
            (4, int(self.since)),
            (6, Value::Array(holds)),
        ]);
        if let Some(u) = self.until {
            f.insert(5, int(u));
        }
        Ok(f)
    }

    /// The holds read back from a node's field ([`F_GRIPS`]); None when it holds none or is malformed.
    pub fn read(v: &Value) -> Option<Holds> {
        let Value::Map(m) = v else { return None };
        let id = |v: &Value| replica::effects::read_id(v).ok();
        let Value::Text(phase) = m.get(&3)? else {
            return None;
        };
        let Value::Array(hs) = m.get(&6)? else {
            return None;
        };
        let mut holds = Vec::new();
        for h in hs {
            let Value::Map(h) = h else { return None };
            let (Value::Text(grip), Value::Array(hands)) = (h.get(&2)?, h.get(&4)?) else {
                return None;
            };
            let [a, b] = hands.as_slice() else {
                return None;
            };
            holds.push(Hold {
                body: id(h.get(&1)?)?,
                grip: grip.as_str().strip_prefix(POINT)?.to_owned(),
                at: read_point(h.get(&3)?)?,
                hands: [read_point(a)?, read_point(b)?],
            });
        }
        Some(Holds {
            load: id(m.get(&2)?)?,
            phase: phase.as_str().to_owned(),
            since: read_int(m.get(&4)?)?,
            until: m.get(&5).and_then(read_int),
            holds,
        })
    }

    /// The hold of `body`, if it holds the load.
    pub fn of(&self, body: Id) -> Option<&Hold> {
        self.holds.iter().find(|h| h.body == body)
    }
}

fn conj(q: Quat) -> R<Quat> {
    let [w, x, y, z] = q.parts();
    Quat::new(w, -x, -y, -z).map_err(pose_refusal)
}

/// Each carrier's hold of `load` (its kind's `grips`, [`grips_of`]), the load held at `held` in its carry's slot (its
/// position and turn in the carry's frame, µm), by the carry's rule (see the module's notes): `front` and `back` its
/// ends, `sides` its side carriers in join order with where each stands in the carry's frame (`[along, across]` µm,
/// [`super::Carry::place_of`]). A load of no grips has no holds; a side past its grips holds nothing.
pub fn assign(
    grips: &[Grip],
    load: &Load,
    held: (Vec3, Quat),
    front: Id,
    back: Id,
    sides: &[(Id, [i64; 2])],
) -> R<Vec<Hold>> {
    let n = grips.len();
    if n < 2 {
        return Ok(Vec::new());
    }
    // Where along the carry, from its back toward its front, a point of the load lies as it is held.
    let x = |p: Vec3| -> R<i64> { Ok(held.1.rotate(p).map_err(pose_refusal)?.x + held.0.x) };
    let along_carry = |a: Vec3, b: Vec3| -> R<std::cmp::Ordering> { Ok(x(a)?.cmp(&x(b)?)) };
    let (first, last) = (&grips[0], &grips[n - 1]);
    let (back_grip, front_grip) = if x(last.at)? < x(first.at)? {
        (last, first)
    } else {
        (first, last)
    };
    // The grips between, as many as `Load::of` keeps, from the carry's back toward its front.
    let mut inner: Vec<(usize, &Grip)> = grips[1..n - 1].iter().take(INNER).enumerate().collect();
    let mut err = None;
    inner.sort_by(|(i, a), (j, b)| match along_carry(a.at, b.at) {
        Ok(std::cmp::Ordering::Equal) => i.cmp(j),
        Ok(o) => o,
        Err(e) => {
            err.get_or_insert(e);
            i.cmp(j)
        }
    });
    if let Some(e) = err {
        return Err(e);
    }
    let unit = {
        let l = load.long;
        let m = l.x.abs().max(l.y.abs()).max(l.z.abs()).max(1);
        Vec3::new(
            l.x * 1_000_000 / m,
            l.y * 1_000_000 / m,
            l.z * 1_000_000 / m,
        )
    };
    let dot = |a: Vec3, b: Vec3| {
        (i128::from(a.x) * i128::from(b.x)
            + i128::from(a.y) * i128::from(b.y)
            + i128::from(a.z) * i128::from(b.z))
            / 1_000_000
    };
    let hold = |body: Id, g: &Grip, across: Option<i64>| -> R<Hold> {
        // A side carrier holds at its grip's edge on the side it stands: half the load's extent that way.
        let contact = match across {
            Some(c) => {
                let a = conj(held.1)?
                    .rotate(Vec3::new(0, 0, if c < 0 { -1_000_000 } else { 1_000_000 }))
                    .map_err(pose_refusal)?;
                let h = load.half;
                let e = (i128::from(h.x) * i128::from(a.x).abs()
                    + i128::from(h.y) * i128::from(a.y).abs()
                    + i128::from(h.z) * i128::from(a.z).abs())
                    / 1_000_000;
                let s = |v: i64| i64::try_from(i128::from(v) * e / 1_000_000).unwrap_or(0);
                Vec3::new(g.at.x + s(a.x), g.at.y + s(a.y), g.at.z + s(a.z))
            }
            None => g.at,
        };
        // Its hands either side along the long axis, kept within the load's length.
        let middle = i64::try_from(dot(load.middle, unit)).unwrap_or(0);
        let t = i64::try_from(dot(contact, unit)).unwrap_or(0) - middle;
        let half = load.half_length;
        let hand = |d: i64| {
            let to = (t + d).clamp(-half, half) - t;
            let s = |v: i64| i64::try_from(i128::from(v) * i128::from(to) / 1_000_000).unwrap_or(0);
            Vec3::new(
                contact.x + s(unit.x),
                contact.y + s(unit.y),
                contact.z + s(unit.z),
            )
        };
        let (a, b) = (hand(-HAND_HALF), hand(HAND_HALF));
        let hands = if x(b)? < x(a)? { [b, a] } else { [a, b] };
        Ok(Hold {
            body,
            grip: g.name.clone(),
            at: g.at,
            hands,
        })
    };
    let mut out = vec![hold(front, front_grip, None)?, hold(back, back_grip, None)?];
    for ((body, place), (_, g)) in sides.iter().zip(inner.iter()) {
        out.push(hold(*body, g, Some(place[1]))?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use replica::ids::Scope;
    use replica::rules::json;

    fn entry(family: &str, kind: &str) -> Json {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../content/kinds")
            .join(family)
            .join(format!("{kind}.json"));
        json::parse(&std::fs::read_to_string(p).expect("the entry")).expect("json")
    }

    fn id(n: u64) -> Id {
        Id::new(Scope([7; 16]), n).expect("an id")
    }

    /// Every load the crews carry (racks, the shade, the loading spot's): its grips in `Load::of`'s order.
    const LOADS: [(&str, &str); 9] = [
        ("construction", "rack_beam"),
        ("construction", "rack_upright"),
        ("construction", "rack_upright_6m"),
        ("construction", "timber_bundle"),
        ("construction", "generator"),
        ("construction", "pallet_crates"),
        ("carpentry", "timber_rail"),
        ("carpentry", "timber_bent"),
        ("carpentry", "shade_cloth"),
    ];

    #[test]
    fn a_loads_grips_are_in_its_carrys_order() {
        for (family, kind) in LOADS {
            let e = entry(family, kind);
            let load = Load::of(&e).expect("a load");
            let g = grips_of(&e).expect("its grips");
            assert_eq!(g.first().map(|g| g.along), Some(load.grips[0]), "{kind}");
            assert_eq!(g.last().map(|g| g.along), Some(load.grips[1]), "{kind}");
            let inner: Vec<i64> = g[1..g.len() - 1].iter().map(|g| g.along).collect();
            let kept: Vec<i64> = load.inner.iter().flatten().copied().collect();
            assert_eq!(inner, kept, "{kind}");
        }
    }

    fn names(h: &[Hold]) -> Vec<&str> {
        h.iter().map(|h| h.grip.as_str()).collect()
    }

    #[test]
    fn the_back_holds_the_grip_at_the_carrys_back_either_way_round() {
        let e = entry("construction", "rack_beam");
        let (load, g) = (Load::of(&e).unwrap(), grips_of(&e).unwrap());
        let (front, back, side) = (id(1), id(2), id(3));
        let sides = [(side, [0, -400_000])];
        let h = assign(&g, &load, load.held().unwrap(), front, back, &sides).unwrap();
        assert_eq!(names(&h), ["grip_r", "grip_l", "grip_mid"]);
        // Lifted the other way round, its + end behind: the front takes the other end.
        let r = load.reversed().unwrap();
        let h = assign(&g, &load, r.held().unwrap(), front, back, &sides).unwrap();
        assert_eq!(names(&h), ["grip_l", "grip_r", "grip_mid"]);
        for hold in &h {
            let [a, b] = hold.hands;
            // Its hands either side of its grip along the beam's length (its z), 0.4 m apart: an end's at its grip, the
            // side's on the beam's edge (it is 51 mm across).
            let x = if hold.body == side { -25_500 } else { 0 };
            assert_eq!(
                (a.x, a.y, b.x, b.y),
                (x, 51_000, x, 51_000),
                "{}",
                hold.grip
            );
            assert_eq!((a.z - b.z).abs(), 2 * HAND_HALF, "{}", hold.grip);
            assert_eq!(a.z + b.z, 2 * hold.at.z);
        }
        // The side stands on the beam's − side across the carry: its hands are on that edge, not through the beam.
        let held = r.held().unwrap();
        let across = |p: Vec3| held.1.rotate(p).unwrap().z + held.0.z;
        let mid = h.iter().find(|h| h.body == side).unwrap();
        assert!(across(mid.hands[0]) <= across(mid.at));
    }

    #[test]
    fn a_crew_of_six_holds_each_grip_once_in_join_order_hands_within_its_length() {
        for (family, kind) in [
            ("construction", "timber_bundle"),
            ("carpentry", "shade_cloth"),
        ] {
            let e = entry(family, kind);
            let (load, g) = (Load::of(&e).unwrap(), grips_of(&e).unwrap());
            let places = load.side_places();
            let sides: Vec<(Id, [i64; 2])> = places
                .iter()
                .enumerate()
                .map(|(k, p)| (id(3 + k as u64), *p))
                .collect();
            let held = load.held().unwrap();
            let h = assign(&g, &load, held, id(1), id(2), &sides).unwrap();
            assert_eq!(h.len(), 6, "{kind}");
            let mut grips: Vec<&str> = names(&h);
            grips.sort_unstable();
            grips.dedup();
            assert_eq!(grips.len(), 6, "{kind}: each grip held once");
            // The sides in join order, from the back toward the front.
            let x = |p: Vec3| held.1.rotate(p).unwrap().x;
            let along: Vec<i64> = h[2..].iter().map(|h| x(h.at)).collect();
            assert!(along.windows(2).all(|w| w[0] < w[1]), "{kind}: {along:?}");
            for hold in &h {
                // Back to front, and within its length.
                assert!(x(hold.hands[0]) <= x(hold.hands[1]), "{kind}");
                for p in hold.hands {
                    assert!(x(p).abs() <= load.half_length, "{kind} {}", hold.grip);
                }
            }
            // Each side's hands at the load's edge on the side it stands (the shade cloth is 1.9 m wide).
            let z = |p: Vec3| held.1.rotate(p).unwrap().z + held.0.z;
            for (hold, (_, place)) in h[2..].iter().zip(&sides) {
                let edge = z(hold.hands[0]);
                assert_eq!(edge.signum(), place[1].signum(), "{kind} {}", hold.grip);
                assert_eq!(edge.abs(), load.half_width, "{kind} {}", hold.grip);
            }
        }
    }

    #[test]
    fn holds_read_back_as_written() {
        let e = entry("carpentry", "timber_rail");
        let (load, g) = (Load::of(&e).unwrap(), grips_of(&e).unwrap());
        let sides = [(id(3), [-500_000, 400_000]), (id(4), [500_000, -400_000])];
        let holds = Holds {
            load: id(9),
            phase: SET_IN.into(),
            since: 1_500_000,
            until: Some(3_500_000),
            holds: assign(&g, &load, load.held().unwrap(), id(1), id(2), &sides).unwrap(),
        };
        let v = Value::Map(holds.fields(id(8)).unwrap());
        assert_eq!(Holds::read(&v), Some(holds.clone()));
        assert_eq!(holds.of(id(4)).map(|h| h.grip.as_str()), Some("grip_r"));
    }
}
