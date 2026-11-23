//! The moves a form's step may name (Engine v2 C23, #3494): every move content declares (`content/moves`,
//! `souls-move/1`, validated by `tools/entry/move.mjs`), read into B2's [`Move`], and the body's own moves into and out
//! of a place, which content does not declare (B3's fixtures: sit, lie and rise). No code here names a move.
//!
//! - **Claims.** A class is claimed as B2's fixtures claim it: locomotion is every leg (a body moving lowers or turns
//!   on all of them), a manipulator, the gaze and the voice are one each. What it blocks is its `blocks`.
//! - **Cancels.** `claim_taken` is cancelled by a new claim on any class it claims; `out_of_reach` is B2's own check at
//!   contact, for every move.
//! - **Phases** are its `phases`, in order, each named for its key without `_us` (`start_up_us` is `souls:start-up`):
//!   contact is the end of the first.
//! - **Effector.** A `hand` reaches with the hand it holds; a `held_point` with the hand too: the held thing's tip
//!   lengthens it (B4), and the step's `at` names the point it reaches.
//! - **Contact** is the move's own `contact` when it names one (a handshake reaches the other body's `hand_right`, read
//!   as `souls:hand-right`); else the step's `at` (the runner sets it), and a move read here names `souls:surface`.

use replica::bodies::{Class, Want};
use replica::effects::{Refusal, fixture_bytes};
use replica::encode::{Name, decode};
use replica::moves::{Effector, Move, Phase};
use replica::rules::json::{Value as Json, parse};

type R<T> = Result<T, Refusal>;

/// The body's moves into and out of a place (B3), which content does not declare.
const OWN: [&str; 3] = [
    include_str!("../../replica/fixtures/moves/lie.diag"),
    include_str!("../../replica/fixtures/moves/rise.diag"),
    include_str!("../../replica/fixtures/moves/sit.diag"),
];

/// Every file of `content/moves`, by name. A test holds this list to the folder (`tests/content_moves.rs`).
pub const CONTENT: [(&str, &str); 33] = [
    ("bow", include_str!("../../../../content/moves/bow.json")),
    (
        "cheer",
        include_str!("../../../../content/moves/cheer.json"),
    ),
    ("clap", include_str!("../../../../content/moves/clap.json")),
    (
        "consume",
        include_str!("../../../../content/moves/consume.json"),
    ),
    (
        "craft",
        include_str!("../../../../content/moves/craft.json"),
    ),
    (
        "dance",
        include_str!("../../../../content/moves/dance.json"),
    ),
    ("fill", include_str!("../../../../content/moves/fill.json")),
    (
        "handshake",
        include_str!("../../../../content/moves/handshake.json"),
    ),
    (
        "high_five",
        include_str!("../../../../content/moves/high_five.json"),
    ),
    ("hug", include_str!("../../../../content/moves/hug.json")),
    ("jump", include_str!("../../../../content/moves/jump.json")),
    (
        "knock",
        include_str!("../../../../content/moves/knock.json"),
    ),
    ("lock", include_str!("../../../../content/moves/lock.json")),
    ("look", include_str!("../../../../content/moves/look.json")),
    (
        "look_around",
        include_str!("../../../../content/moves/look_around.json"),
    ),
    ("nod", include_str!("../../../../content/moves/nod.json")),
    (
        "point",
        include_str!("../../../../content/moves/point.json"),
    ),
    ("pour", include_str!("../../../../content/moves/pour.json")),
    (
        "press",
        include_str!("../../../../content/moves/press.json"),
    ),
    ("pump", include_str!("../../../../content/moves/pump.json")),
    (
        "shake_head",
        include_str!("../../../../content/moves/shake_head.json"),
    ),
    (
        "shrug",
        include_str!("../../../../content/moves/shrug.json"),
    ),
    (
        "slide",
        include_str!("../../../../content/moves/slide.json"),
    ),
    (
        "slump",
        include_str!("../../../../content/moves/slump.json"),
    ),
    (
        "steer",
        include_str!("../../../../content/moves/steer.json"),
    ),
    (
        "stretch",
        include_str!("../../../../content/moves/stretch.json"),
    ),
    (
        "strike",
        include_str!("../../../../content/moves/strike.json"),
    ),
    (
        "stroke",
        include_str!("../../../../content/moves/stroke.json"),
    ),
    (
        "swing",
        include_str!("../../../../content/moves/swing.json"),
    ),
    (
        "touch",
        include_str!("../../../../content/moves/touch.json"),
    ),
    ("tug", include_str!("../../../../content/moves/tug.json")),
    ("turn", include_str!("../../../../content/moves/turn.json")),
    ("wave", include_str!("../../../../content/moves/wave.json")),
];

fn refuse<T>(detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name: "not-a-move",
        detail: detail.into(),
    })
}

fn name(t: &str) -> R<Name> {
    Name::new(t).map_or_else(|| refuse(format!("{t}: not a name")), Ok)
}

fn class(c: &Json) -> R<Class> {
    match c.str() {
        Some("locomotion") => Ok(Class::Locomotion),
        Some("manipulator") => Ok(Class::Manipulator),
        Some("gaze") => Ok(Class::Gaze),
        Some("voice") => Ok(Class::Voice),
        _ => refuse(format!("class {}", c.to_json())),
    }
}

fn classes(m: &Json, key: &str) -> R<Vec<Class>> {
    m.get(key)
        .and_then(Json::arr)
        .unwrap_or(&[])
        .iter()
        .map(class)
        .collect()
}

/// One `souls-move/1` record as B2's move, refused `not-a-move` by name (or B2's own checks: reach, phases).
pub fn from_content(text: &str) -> R<Move> {
    let m = parse(text).or_else(refuse)?;
    if m.get("format").and_then(Json::str) != Some("souls-move/1") {
        return refuse("format: souls-move/1");
    }
    let Some(mv) = m.get("move").and_then(Json::str) else {
        return refuse("move: a name");
    };
    let claimed = classes(&m, "claims")?;
    if claimed.is_empty() {
        return refuse(format!("{mv}: claims nothing"));
    }
    let claims = claimed
        .iter()
        .map(|c| match c {
            Class::Locomotion => Want::All(*c),
            _ => Want::One(*c),
        })
        .collect();
    let cancels = m.get("cancels_on").and_then(Json::arr).unwrap_or(&[]);
    let cancelled_by = if cancels.iter().any(|c| c.str() == Some("claim_taken")) {
        claimed.clone()
    } else {
        Vec::new()
    };
    let mut phases = Vec::new();
    for (k, v) in m.get("phases").and_then(Json::obj).unwrap_or(&[]) {
        let (Some(p), Json::Int(us)) = (k.strip_suffix("_us"), v) else {
            return refuse(format!("{mv}: phase {k}"));
        };
        phases.push(Phase {
            name: name(&format!("souls:{}", p.replace('_', "-")))?,
            length: i64::try_from(*us).or_else(|_| refuse(format!("{mv}: phase {k}")))?,
        });
    }
    let effector = match m.get("effector").and_then(Json::str) {
        Some("hand" | "held_point") => Effector::Held,
        Some("aim") => Effector::Aim,
        _ => return refuse(format!("{mv}: effector")),
    };
    let reach = match m.get("reach_mm") {
        Some(Json::Int(mm)) => i64::try_from(*mm).unwrap_or(i64::MAX).saturating_mul(1000),
        _ => return refuse(format!("{mv}: reach_mm")),
    };
    // B2's own checks, as a fixture's move is read.
    if phases.len() < 2 || phases.iter().any(|p| p.length <= 0) {
        return Err(Refusal {
            name: "move-phases-too-few",
            detail: format!("{mv}: start-up, then at least one more, each above zero"),
        });
    }
    if !(1..=effector.reach_most()).contains(&reach) {
        return Err(Refusal {
            name: "move-reach-out-of-range",
            detail: format!("{mv}: {reach} µm"),
        });
    }
    Ok(Move {
        name: name(&format!("souls:{mv}"))?,
        revision: 1,
        claims,
        blocks: classes(&m, "blocks")?,
        cancelled_by,
        phases,
        effector,
        reach,
        contact: match m.get("contact").and_then(Json::str) {
            Some(point) => name(&format!("souls:{}", point.replace('_', "-")))?,
            None => name("souls:surface")?,
        },
    })
}

/// The moves a form's step may name: every move content declares, and the body's own (sit, lie, rise).
pub fn library() -> R<Vec<Move>> {
    let own = OWN.iter().map(|t| {
        let v = decode(&fixture_bytes(t)?)
            .map_err(|e| Refusal {
                name: "move-unread",
                detail: e.to_string(),
            })?
            .value;
        Move::from_value(&v)
    });
    own.chain(CONTENT.iter().map(|(_, t)| from_content(t)))
        .collect()
}
