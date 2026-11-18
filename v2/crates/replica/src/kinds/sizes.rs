//! Body sizes and floaters as kind data (Engine v2 B12, #2743). A body's family kind states its size class, its
//! height and how it answers the controller's walk: on its feet, or hovering a set height over the surface below.
//!
//! - **Size classes** are a short fixed list ([`Size`]), each a radius. The walkable ground bakes the radius in, so
//!   the ground is cut once per class, never per body: a body of any radius takes the class at or above it
//!   ([`Size::for_radius`]), and one wider than the largest is refused (`body-too-large`).
//! - **The kind's fields** (section 3, by name): `size`, an enum of the class names; `height`, the body's height in
//!   whole mm; and `hover`, the height it is held above its surface in whole mm (0 or absent: it stands). A floater
//!   walks on a surface like any walker, crosses nothing a walker of its class cannot, and its height is part of its
//!   pose: `Support::Surface` with that height (T4 rule 6, settled at reconciliation), which the viewer draws.
//! - Not here: flying and swimming, custom meshes (B13), reach and seat height from the height (a later task reads
//!   [`Build::height_mm`]).

use super::{KindDef, Type};
use crate::effects::Refusal;
use crate::encode::Value;
use crate::ids::Id;
use crate::pose::Support;

type R<T> = Result<T, Refusal>;

fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

/// A body's size class: what its walkable ground is cut for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Size {
    /// 0.2 m.
    Small,
    /// 0.28 m, today's walking body.
    Standard,
    /// 0.5 m.
    Large,
}

impl Size {
    /// Every class, smallest first.
    pub const ALL: [Size; 3] = [Size::Small, Size::Standard, Size::Large];

    /// The class's radius, mm.
    pub const fn radius_mm(self) -> i64 {
        match self {
            Size::Small => 200,
            Size::Standard => 280,
            Size::Large => 500,
        }
    }

    /// The class's name, as a kind's `size` field gives it.
    pub fn name(self) -> &'static str {
        match self {
            Size::Small => "small",
            Size::Standard => "standard",
            Size::Large => "large",
        }
    }

    /// The class of that name (`size-unknown`).
    pub fn from_name(name: &str) -> R<Size> {
        Size::ALL
            .into_iter()
            .find(|s| s.name() == name)
            .ok_or(())
            .or_else(|()| refuse("size-unknown", format!("no size class {name:?}")))
    }

    /// The smallest class whose radius is at least `mm` (rounded up), or `body-too-large`.
    pub fn for_radius(mm: i64) -> R<Size> {
        Size::ALL
            .into_iter()
            .find(|s| s.radius_mm() >= mm)
            .ok_or(())
            .or_else(|()| {
                refuse(
                    "body-too-large",
                    format!(
                        "a radius of {mm} mm is over the largest class's {} mm",
                        Size::Large.radius_mm()
                    ),
                )
            })
    }
}

/// What a family's kind says of its body's size: its class, height and hover height.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Build {
    pub size: Size,
    /// Head to foot, mm.
    pub height_mm: i64,
    /// Held this far above the surface below it, mm; 0 stands.
    pub hover_mm: i64,
}

impl Build {
    /// Reads a family kind's `size`, `height` and `hover` fields (their defaults). A field missing, of another type
    /// or out of range is refused as `family-size`.
    pub fn of(kind: &KindDef) -> R<Build> {
        let field = |name: &str| kind.state.values().find(|f| f.name.as_str() == name);
        let bad = |what: &str| refuse("family-size", format!("{}: {what}", kind.name.as_str()));
        let size = match field("size") {
            Some(f) => match (&f.ty, &f.default) {
                (Type::Enum(_), Value::Text(t)) => Size::from_name(t.as_str())?,
                _ => return bad("size is an enum of size classes"),
            },
            None => return bad("no size field"),
        };
        let mm = |name: &str, need: bool| match field(name) {
            None if !need => Ok(0),
            Some(f) => match (&f.ty, &f.default) {
                (Type::Int, Value::Uint(v)) => i64::try_from(*v).or(Err(())),
                _ => Err(()),
            },
            None => Err(()),
        };
        let Ok(height_mm) = mm("height", true) else {
            return bad("height is a whole number of mm");
        };
        let Ok(hover_mm) = mm("hover", false) else {
            return bad("hover is a whole number of mm");
        };
        if height_mm == 0 {
            return bad("height is more than nothing");
        }
        Ok(Build {
            size,
            height_mm,
            hover_mm,
        })
    }

    /// Its support on `surface`: standing (height 0) or hovering at its height, in µm.
    pub fn support(self, surface: Id) -> Support {
        Support::Surface {
            surface,
            height: self.hover_mm * 1000,
        }
    }
}
