//! Putting a thing down where there is no slot (Engine v2 E4, #2772): what a kind says about it, and the words.
//!
//! - **Two outlines** from section 7's size (`bounds_mm`, [width, height, depth] in whole millimetres, centred on the
//!   thing's origin in x and z, standing on it in y): what the thing may not overlap ([`Outlines::clear`], its
//!   footprint), and what walkers go round ([`Outlines::walk`], its box). A thing lower than [`FLAT`] has only the
//!   first: a body's lowest blocking height is N3's (`sim::ground::BODY_LOW`), so a chalk mark or a rug is walked
//!   over, and setting it down rebuilds no ground.
//! - **A front** is the thing's own +z unless its geometry says `2: "none"` (a round table): facing toward something
//!   needs one.
//! - **The words** are one closed list with Soul Actions' (`packages/form-rules/placements.json`, SA-F11 #2883): the
//!   placement words ([`Word`]) and the facings ([`Facing`]), by the file's names. The list is the file's; v2's crates
//!   never read today's packages (K14), so the names are written here once, and a word added there is added here.
//!   Which spot each word becomes is the engine's (`sim::setdown`), recorded.

use crate::encode::Value;
use crate::ids::Id;

/// The geometry section of a kind.
pub const SECTION_GEOMETRY: u64 = 7;
/// Below this height a thing is walked over, mm (N3's lowest height a box blocks a body at).
pub const FLAT: i64 = 220;

/// A kind's section 7: its size and whether it has a front.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Geometry {
    /// Width, height and depth, mm.
    pub bounds_mm: [i64; 3],
    pub front: bool,
}

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

impl Geometry {
    /// Section 7 as written: `{1: [w, h, d], 2: "z" | "none"}`; `2` absent is a front.
    pub fn read(v: &Value) -> Result<Geometry, String> {
        let Value::Map(m) = v else {
            return Err("{1: bounds_mm, 2: front}".into());
        };
        let bounds_mm = match m.get(&1) {
            Some(Value::Array(a)) if a.len() == 3 => {
                let n: Vec<i64> = a.iter().filter_map(int).filter(|n| *n >= 0).collect();
                <[i64; 3]>::try_from(n).map_err(|_| "bounds_mm is three whole mm, none below 0")?
            }
            _ => return Err("1, bounds_mm, is [width, height, depth]".into()),
        };
        let front = match m.get(&2) {
            None => true,
            Some(Value::Text(t)) if t.as_str() == "z" => true,
            Some(Value::Text(t)) if t.as_str() == "none" => false,
            Some(_) => return Err("2, front, is \"z\" or \"none\"".into()),
        };
        Ok(Geometry { bounds_mm, front })
    }

    pub fn outlines(&self) -> Outlines {
        let [w, h, d] = self.bounds_mm;
        Outlines {
            clear: [w / 2, d / 2],
            walk: (h >= FLAT).then_some([w / 2, h, d / 2]),
            front: self.front,
        }
    }
}

/// A thing's two outlines in its own frame, mm, and whether it has a front.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outlines {
    /// Half its width and half its depth: what no other thing's footprint may overlap.
    pub clear: [i64; 2],
    /// Half its width, its height and half its depth: the box walkers go round; `None` for a thing walked over.
    pub walk: Option<[i64; 3]>,
    pub front: bool,
}

impl Outlines {
    /// The walk outline as N1's solids field (`[[cx, cz, hx, hz, yaw, y0, y1]]`, mm, the thing's frame), the one the
    /// ground is cut from; `None` for a thing walked over.
    pub fn solids(&self) -> Option<Value> {
        let [hx, h, hz] = self.walk?;
        let u = |n: i64| Value::Uint(n.unsigned_abs());
        Some(Value::Array(vec![Value::Array(vec![
            u(0),
            u(0),
            u(hx),
            u(hz),
            u(0),
            u(0),
            u(h),
        ])]))
    }
}

/// Where a thing is put, in a person's words: one closed list with `packages/form-rules/placements.json`'s words.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Word {
    /// On the anchor: it rests on the anchor's top (or its sill), a child of the anchor where it admits things.
    On,
    /// In the anchor (a room or an area): its middle, or the nearest free spot to it.
    In,
    /// Where the body stands: the nearest free spot to it.
    Here,
    NextTo,
    InFrontOf,
    Behind,
    /// By the anchor, its back to it.
    Against,
    /// Turned where it stands: the position is not touched.
    Facing,
    /// The middle of the room the body is in.
    Middle,
}

impl Word {
    pub const ALL: [Word; 9] = [
        Word::On,
        Word::In,
        Word::Here,
        Word::NextTo,
        Word::InFrontOf,
        Word::Behind,
        Word::Against,
        Word::Facing,
        Word::Middle,
    ];

    /// Its name in the placements file.
    pub fn name(self) -> &'static str {
        match self {
            Word::On => "on",
            Word::In => "in",
            Word::Here => "here",
            Word::NextTo => "next_to",
            Word::InFrontOf => "in_front_of",
            Word::Behind => "behind",
            Word::Against => "against",
            Word::Facing => "facing",
            Word::Middle => "middle",
        }
    }

    pub fn from_name(s: &str) -> Option<Word> {
        Word::ALL.into_iter().find(|w| w.name() == s)
    }
}

/// Which way a thing set down faces.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Facing {
    /// Its front toward a node.
    Toward(Id),
    /// As it faced before (in its new parent's frame, as near as the turn between the two allows).
    AsItWas,
    /// Its back to the wall or the anchor it is set against.
    ToWall,
}

impl Facing {
    /// The facings' names in the placements file.
    pub const NAMES: [&'static str; 3] = ["toward", "as_it_was", "to_wall"];

    pub fn name(self) -> &'static str {
        match self {
            Facing::Toward(_) => "toward",
            Facing::AsItWas => "as_it_was",
            Facing::ToWall => "to_wall",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encode::Name;
    use std::collections::BTreeMap;

    #[test]
    fn each_word_and_facing_has_one_name() {
        for w in Word::ALL {
            assert_eq!(Word::from_name(w.name()), Some(w));
        }
        let mut names: Vec<&str> = Word::ALL.iter().map(|w| w.name()).collect();
        names.extend(Facing::NAMES);
        let n = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!((n, names.len()), (12, 12));
        assert_eq!(Facing::ToWall.name(), Facing::NAMES[2]);
    }

    #[test]
    fn a_flat_thing_has_one_outline_and_a_round_one_no_front() {
        let g = |w: u64, h: u64, d: u64, front: Option<&str>| {
            let mut m = BTreeMap::from([(
                1,
                Value::Array(vec![Value::Uint(w), Value::Uint(h), Value::Uint(d)]),
            )]);
            if let Some(f) = front {
                m.insert(2, Value::Text(Name::new(f).unwrap()));
            }
            Geometry::read(&Value::Map(m)).unwrap()
        };
        let mark = g(2_000, 0, 3_000, None).outlines();
        assert_eq!(mark.clear, [1_000, 1_500]);
        assert_eq!((mark.walk, mark.solids()), (None, None));
        let tent = g(2_400, 1_500, 2_000, None).outlines();
        assert_eq!(tent.walk, Some([1_200, 1_500, 1_000]));
        assert!(tent.solids().is_some() && tent.front);
        assert!(!g(800, 750, 800, Some("none")).outlines().front);
        assert!(Geometry::read(&Value::Uint(1)).is_err());
    }
}
