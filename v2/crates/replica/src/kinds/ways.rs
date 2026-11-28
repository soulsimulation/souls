//! What a kind's entry says a thing of it is walked on and up (racks T9, T6): `geometry.floors`, `geometry.stairs` and
//! `geometry.ladders` (`docs/soul-actions/entry-format.md`, section 7). A thing placed of the kind gets them as a
//! building's are given from a world's facts: a floor child per floor, and a stair or ladder row from the ground's
//! level to the floor its top is at, or to a level of its own with no floor to stand on (a flight's top then lands on
//! the floor it meets at its height: a deck's). Every length is whole mm in the thing's own frame.
//!
//! - **A floor** `{top_mm, size_mm: [x, z], at_mm: [x, z], while_joined}`: a rectangle `size_mm` about `at_mm` (the
//!   thing's origin when left out) at height `top_mm`. With `while_joined: true` it is ground only while a part
//!   joined to the thing sits at its height (a frame's standing place, there while a beam braces the frame at that
//!   level): read by `sim::ground::scene::braced`. A standing place is declared only [`STANDING_HEIGHT_MM`] or more
//!   above the ground or the thing's floor under it (a body fits under it); a ladder may still reach a lower level.
//! - **A stair** `{from_mm: [x, z], to_mm: [x, z], bottom_mm, top_mm, width_mm}`: a flight from its foot to its top.
//! - **A ladder** `{face, at_mm, bottom_mm, top_mm, width_mm, run_mm}`: a ladder up the thing's `front` (+z) or `back`
//!   (-z) face, `at_mm` along x (0 when left out), from `run_mm` (600 when left out) out from that face to the face;
//!   `width_mm` 600 when left out.
//!
//! In the kind's hash they are section 7's keys 4, 5 and 6, each a list of rows of whole mm ([`Ways::diag`]).

use crate::rules::json::Value;

/// A floor a thing holds of its own.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Floor {
    pub top: i64,
    pub size: [i64; 2],
    pub at: [i64; 2],
    pub while_joined: bool,
}

/// A stair a thing holds: its line from foot to top, its bottom and top heights and its width.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stair {
    pub from: [i64; 2],
    pub to: [i64; 2],
    pub bottom: i64,
    pub top: i64,
    pub width: i64,
}

/// A ladder up one face of a thing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ladder {
    /// +1 the front (+z), -1 the back.
    pub face: i64,
    pub at: i64,
    pub bottom: i64,
    pub top: i64,
    pub width: i64,
    pub run: i64,
}

impl Ladder {
    /// Its line, foot to top, for a thing whose face lies `half_depth` mm from its origin: from `run` out from the face
    /// to the face.
    pub fn path(&self, half_depth: i64) -> [[i64; 2]; 2] {
        let face = self.face * half_depth;
        [[self.at, face + self.face * self.run], [self.at, face]]
    }
}

/// Everything an entry declares a thing is walked on and up.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Ways {
    pub floors: Vec<Floor>,
    pub stairs: Vec<Stair>,
    pub ladders: Vec<Ladder>,
}

/// A standing body's height, mm (`sim::ground::BODY_HIGH`): a standing place's floor is at least this far above the
/// ground or the thing's floor under it, so nobody walks under a floor they cannot fit beneath.
pub const STANDING_HEIGHT_MM: i64 = 1_800;

const DEFAULT_WIDTH: i64 = 600;
const DEFAULT_RUN: i64 = 600;

fn whole(v: Option<&Value>, what: &str) -> Result<i64, String> {
    match v {
        Some(Value::Int(n)) => i64::try_from(*n).map_err(|_| format!("{what} is out of range")),
        _ => Err(format!("{what} is a whole number of mm")),
    }
}

fn pair(v: Option<&Value>, what: &str) -> Result<[i64; 2], String> {
    match v.and_then(Value::arr) {
        Some([a, b]) => Ok([whole(Some(a), what)?, whole(Some(b), what)?]),
        _ => Err(format!("{what} is [x, z] in whole mm")),
    }
}

fn rows<'a>(g: &'a Value, key: &str) -> &'a [Value] {
    g.get(key).and_then(Value::arr).unwrap_or(&[])
}

impl Ways {
    /// What `entry`'s geometry declares, or why it cannot be read (`geometry.floors row 0: ...`).
    pub fn read(entry: &Value) -> Result<Ways, String> {
        let Some(g) = entry.get("geometry") else {
            return Ok(Ways::default());
        };
        let mut w = Ways::default();
        for (k, f) in rows(g, "floors").iter().enumerate() {
            let what = |p: &str| format!("geometry.floors row {k}: {p}");
            let size = pair(f.get("size_mm"), &what("size_mm"))?;
            if size[0] <= 0 || size[1] <= 0 {
                return Err(what("size_mm is above 0 each way"));
            }
            w.floors.push(Floor {
                top: whole(f.get("top_mm"), &what("top_mm"))?,
                size,
                at: match f.get("at_mm") {
                    None => [0, 0],
                    v => pair(v, &what("at_mm"))?,
                },
                while_joined: f.get("while_joined").is_some_and(Value::truthy),
            });
        }
        // A standing place only where a body fits under it: its top this far above the ground (the thing's origin)
        // or above the highest of the thing's floors under it.
        for (k, f) in w.floors.iter().enumerate() {
            if !f.while_joined {
                continue;
            }
            let over = |o: &Floor| {
                (o.at[0] - f.at[0]).abs() * 2 < o.size[0] + f.size[0]
                    && (o.at[1] - f.at[1]).abs() * 2 < o.size[1] + f.size[1]
            };
            let below = w
                .floors
                .iter()
                .filter(|o| o.top < f.top && over(o))
                .map(|o| o.top)
                .max()
                .unwrap_or(0);
            if f.top - below < STANDING_HEIGHT_MM {
                return Err(format!(
                    "geometry.floors row {k}: a standing place (while_joined) is {} mm above what is under it; one is \
                     declared only {STANDING_HEIGHT_MM} mm or more up, so a body fits under it",
                    f.top - below
                ));
            }
        }
        for (k, s) in rows(g, "stairs").iter().enumerate() {
            let what = |p: &str| format!("geometry.stairs row {k}: {p}");
            let st = Stair {
                from: pair(s.get("from_mm"), &what("from_mm"))?,
                to: pair(s.get("to_mm"), &what("to_mm"))?,
                bottom: whole(s.get("bottom_mm"), &what("bottom_mm"))?,
                top: whole(s.get("top_mm"), &what("top_mm"))?,
                width: whole(s.get("width_mm"), &what("width_mm"))?,
            };
            if st.top <= st.bottom || st.width <= 0 || st.from == st.to {
                return Err(what("rises from bottom to top, over a run, with a width"));
            }
            w.stairs.push(st);
        }
        for (k, l) in rows(g, "ladders").iter().enumerate() {
            let what = |p: &str| format!("geometry.ladders row {k}: {p}");
            let face = match l.get("face").and_then(Value::str) {
                Some("front") => 1,
                Some("back") => -1,
                _ => return Err(what("face is \"front\" or \"back\"")),
            };
            let opt = |key: &str, d: i64| match l.get(key) {
                None => Ok(d),
                v => whole(v, &what(key)),
            };
            let ld = Ladder {
                face,
                at: opt("at_mm", 0)?,
                bottom: whole(l.get("bottom_mm"), &what("bottom_mm"))?,
                top: whole(l.get("top_mm"), &what("top_mm"))?,
                width: opt("width_mm", DEFAULT_WIDTH)?,
                run: opt("run_mm", DEFAULT_RUN)?,
            };
            if ld.top <= ld.bottom || ld.width <= 0 || ld.run <= 0 {
                return Err(what("rises from bottom to top, over a run, with a width"));
            }
            w.ladders.push(ld);
        }
        Ok(w)
    }

    pub fn is_empty(&self) -> bool {
        self.floors.is_empty() && self.stairs.is_empty() && self.ladders.is_empty()
    }

    /// Section 7's keys 4 (floors), 5 (stairs) and 6 (ladders) as diagnostic notation, each a list of whole-mm rows:
    /// a floor `[top, x size, z size, x, z, while joined]`, a stair `[x0, z0, x1, z1, bottom, top, width]`, a ladder
    /// `[face, x, bottom, top, width, run]`. None for a key with no rows.
    pub fn diag(&self) -> [Option<String>; 3] {
        let list = |r: Vec<Vec<i64>>| {
            (!r.is_empty()).then(|| {
                let rows: Vec<String> = r
                    .iter()
                    .map(|x| {
                        let n: Vec<String> = x.iter().map(i64::to_string).collect();
                        format!("[{}]", n.join(", "))
                    })
                    .collect();
                format!("[{}]", rows.join(", "))
            })
        };
        [
            list(
                self.floors
                    .iter()
                    .map(|f| {
                        vec![
                            f.top,
                            f.size[0],
                            f.size[1],
                            f.at[0],
                            f.at[1],
                            i64::from(f.while_joined),
                        ]
                    })
                    .collect(),
            ),
            list(
                self.stairs
                    .iter()
                    .map(|s| {
                        vec![
                            s.from[0], s.from[1], s.to[0], s.to[1], s.bottom, s.top, s.width,
                        ]
                    })
                    .collect(),
            ),
            list(
                self.ladders
                    .iter()
                    .map(|l| vec![l.face, l.at, l.bottom, l.top, l.width, l.run])
                    .collect(),
            ),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::json::parse;

    #[test]
    fn a_frames_standing_places_and_ladders_read_and_number() {
        let e = parse(
            r#"{"geometry": {"bounds_mm": [1219, 3658, 76],
                "floors": [{"top_mm": 1800, "size_mm": [1144, 700], "at_mm": [0, -388], "while_joined": true}],
                "ladders": [{"face": "back", "bottom_mm": 0, "top_mm": 1800}]}}"#,
        )
        .unwrap();
        let w = Ways::read(&e).unwrap();
        assert!(w.floors[0].while_joined);
        assert_eq!(w.ladders[0].path(38), [[0, -638], [0, -38]]);
        let [f, s, l] = w.diag();
        assert_eq!(f.as_deref(), Some("[[1800, 1144, 700, 0, -388, 1]]"));
        assert_eq!(s, None);
        assert_eq!(l.as_deref(), Some("[[-1, 0, 0, 1800, 600, 600]]"));
    }

    #[test]
    fn a_standing_place_a_body_cannot_walk_under_is_refused() {
        let e = parse(
            r#"{"geometry": {"floors": [{"top_mm": 500, "size_mm": [1144, 900], "while_joined": true}]}}"#,
        )
        .unwrap();
        let why = Ways::read(&e).unwrap_err();
        assert!(why.contains("1800 mm or more up"), "{why}");
    }

    #[test]
    fn a_stair_that_does_not_rise_is_refused_by_its_row() {
        let e = parse(
            r#"{"geometry": {"stairs": [{"from_mm": [0, 0], "to_mm": [1000, 0], "bottom_mm": 500, "top_mm": 500, "width_mm": 900}]}}"#,
        )
        .unwrap();
        let why = Ways::read(&e).unwrap_err();
        assert!(why.starts_with("geometry.stairs row 0"), "{why}");
    }
}
