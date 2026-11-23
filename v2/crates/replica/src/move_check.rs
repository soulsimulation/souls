//! A move intent read, and checked on what is known of it (Engine v2 C14, #3442): the one function the world and a
//! client both run for a walk, a sit, a lie or a rise, so `can` on a move answers the world's verdict instead of
//! `unknown` (R8).
//!
//! - **Read** ([`read`]): a form's verb named `walk`, `sit`, `lie` or `rise` (T10 rule 4 keeps `souls:` verbs for the
//!   engine's own), its target and a walk's point, parameter 1 `[x, y, z]` µm. Refused by name: `move.no-target`,
//!   `move.bad-point`. A walk may name its gait, parameter 2 `gait:<name>`, one of [`GAITS`] (0.135 G1; the
//!   speeds are `sim::gaits`'), else `move.unknown-gait`; with none it walks. Its ranked fallbacks (T10 rule 6) are
//!   moves of the same form on other targets (`move.fallback-not-alike` otherwise), tried in order by the world.
//! - **Checked** ([`check`]) on [`Seen`]: whether the target is known, whether the body is in a seat, whether a seat is
//!   free. The world fills it from its own tables; a client from its copy and its own moves' receipts, with `None`
//!   for what it does not hold. A `no` is given only from what is known, and is the name the world refuses by:
//!   `resource-held` (a walk while seated), `place-already-held`, `place-taken`, `not-seated`. Anything not known is
//!   `unknown` with why, and unknown never blocks a send.

use std::collections::BTreeMap;

use crate::encode::{Name, Value};
use crate::ids::{Id, Scope};
use crate::intents::{Intent, Target};
use crate::pose::Vec3;
use crate::rules::json;

/// The gaits a walk may name (0.135 G1): `sim::gaits`' gaits on dry ground, slowest first.
pub const GAITS: [&str; 3] = ["walk", "jog", "run"];

/// What a move intent asks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ask {
    /// Walk to `point` (µm, the frame of `node`), or, with no point, to the stand point of `node`'s seat, or else to a
    /// free standing spot in `node` (its middle, bound by N9). `gait`, one of [`GAITS`], or none for a walk.
    Walk {
        node: Id,
        point: Option<Vec3>,
        gait: Option<&'static str>,
    },
    /// Sit on the seat of `thing`.
    Sit {
        thing: Id,
    },
    /// Lie down in the slot of `thing`.
    Lie {
        thing: Id,
    },
    Rise,
}

impl Ask {
    /// The node it aims at, if any.
    pub fn target(&self) -> Option<Id> {
        match self {
            Ask::Walk { node, .. } => Some(*node),
            Ask::Sit { thing } | Ask::Lie { thing } => Some(*thing),
            Ask::Rise => None,
        }
    }

    fn form(&self) -> &'static str {
        match self {
            Ask::Walk { .. } => "walk",
            Ask::Sit { .. } => "sit",
            Ask::Lie { .. } => "lie",
            Ask::Rise => "rise",
        }
    }
}

/// The move form of `verb`, if it is one.
pub fn form(verb: &str) -> Option<&str> {
    match verb.split_once(':') {
        Some((ns, f @ ("walk" | "sit" | "lie" | "rise"))) if ns != "souls" => Some(f),
        _ => None,
    }
}

fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Uint(u) => i64::try_from(*u).ok(),
        Value::Nint(n) => i64::try_from(*n).ok().map(|n| -1 - n),
        _ => None,
    }
}

/// The gait of [`GAITS`] named `word`, or `move.unknown-gait`.
pub fn gait(word: &str) -> Result<&'static str, &'static str> {
    GAITS
        .into_iter()
        .find(|g| *g == word)
        .ok_or("move.unknown-gait")
}

/// One move from its form, its target node, its point (`Err` for a point of the wrong shape) and a walk's gait
/// (`Err` for one that is not a name).
pub fn ask(
    form: &str,
    node: Option<Id>,
    point: Option<Result<Vec3, ()>>,
    gait: Option<Result<&str, ()>>,
) -> Result<Ask, &'static str> {
    let node = node.ok_or("move.no-target");
    match form {
        "walk" => {
            let point = point.transpose().map_err(|()| "move.bad-point")?;
            let gait = match gait {
                None => None,
                Some(Ok(w)) => Some(self::gait(w)?),
                Some(Err(())) => return Err("move.unknown-gait"),
            };
            Ok(Ask::Walk {
                node: node?,
                point,
                gait,
            })
        }
        "sit" => Ok(Ask::Sit { thing: node? }),
        "lie" => Ok(Ask::Lie { thing: node? }),
        _ => Ok(Ask::Rise),
    }
}

fn one(
    verb: &Name,
    target: Option<&Target>,
    parameters: &BTreeMap<u64, Value>,
) -> Option<Result<Ask, &'static str>> {
    let form = form(verb.as_str())?;
    let node = match target {
        Some(Target::Node(n)) => Some(*n),
        _ => None,
    };
    let point = parameters.get(&1).map(|v| match v {
        Value::Array(p) => match p.iter().map(int).collect::<Option<Vec<_>>>() {
            Some(p) if p.len() == 3 => Ok(Vec3::new(p[0], p[1], p[2])),
            _ => Err(()),
        },
        _ => Err(()),
    });
    // A word in an intent is a name (`gait:jog`), as a set-down's `place:here`.
    let gait = parameters.get(&2).map(|v| match v {
        Value::Text(w) => w.as_str().strip_prefix("gait:").ok_or(()),
        _ => Err(()),
    });
    Some(ask(form, node, point, gait))
}

/// Reads a move intent: `None` when its verb is not a move, else its ranked list (the intent's own, then each
/// fallback's) or the reason it is not one.
pub fn read(intent: &Intent) -> Option<Result<Vec<Ask>, &'static str>> {
    let first = match one(&intent.verb, intent.target.as_ref(), &intent.parameters)? {
        Ok(a) => a,
        Err(r) => return Some(Err(r)),
    };
    let mut out = vec![first];
    for f in &intent.fallbacks {
        match one(&f.verb, f.target.as_ref(), &f.parameters) {
            Some(Ok(a)) if a.form() == out[0].form() => out.push(a),
            Some(Err(r)) => return Some(Err(r)),
            _ => return Some(Err("move.fallback-not-alike")),
        }
    }
    Some(Ok(out))
}

/// What is known when a move is checked; `None` is not known.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Seen {
    /// The target is known (a node of the copy, or a seat of the world's).
    pub has: bool,
    /// The body holds a seat or a bed.
    pub seated: Option<bool>,
    /// The seat aimed at is free.
    pub free: Option<bool>,
}

/// A move's verdict.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Yes,
    /// Refused by the world's name.
    No(&'static str),
    /// Not known here, and why.
    Unknown(&'static str),
}

/// Checks `ask` on what is `seen`.
pub fn check(ask: &Ask, seen: &Seen) -> Verdict {
    match ask {
        Ask::Walk { .. } if seen.seated == Some(true) => Verdict::No("resource-held"),
        Ask::Sit { .. } | Ask::Lie { .. } if seen.seated == Some(true) => {
            Verdict::No("place-already-held")
        }
        Ask::Rise => match seen.seated {
            Some(true) => Verdict::Yes,
            Some(false) => Verdict::No("not-seated"),
            None => Verdict::Unknown("posture-not-known"),
        },
        _ if !seen.has => Verdict::Unknown("not-in-copy"),
        Ask::Walk { .. } => Verdict::Yes,
        Ask::Sit { .. } | Ask::Lie { .. } => match seen.free {
            Some(true) => Verdict::Yes,
            Some(false) => Verdict::No("place-taken"),
            None => Verdict::Unknown("holds-not-in-copy"),
        },
    }
}

fn id_of(text: &str) -> Option<Id> {
    let (s, c) = text.split_once('-')?;
    let s: [u8; 16] = crate::encode::from_hex(s).ok()?.try_into().ok()?;
    Id::new(Scope(s), c.parse().ok()?)
}

/// [`check`] as JSON, for a client (R8): `{"verb", "this"?, "point"?: [x, y, z], "gait"?, "has", "seated"?, "free"?}`
/// in,
/// `{"verdict": "yes"}`, `{"verdict": "no", "reason"}` or `{"verdict": "unknown", "why"}` out.
#[cfg_attr(
    all(target_arch = "wasm32", not(feature = "checker")),
    wasm_bindgen::prelude::wasm_bindgen
)]
pub fn move_check(input: &str) -> String {
    let v = json::parse(input).unwrap_or(json::Value::Null);
    let verdict = |k: &str, w: &str, n: &str| {
        json::Value::Obj(vec![
            ("verdict".into(), json::Value::s(k)),
            (w.into(), json::Value::s(n)),
        ])
        .to_json()
    };
    let Some(form) = v.get("verb").and_then(json::Value::str).and_then(form) else {
        return verdict("unknown", "why", "not-a-move");
    };
    let node = v.get("this").and_then(json::Value::str).and_then(id_of);
    let point = match v.get("point") {
        None | Some(json::Value::Null) => None,
        Some(p) => Some(match p.arr() {
            Some([x, y, z]) => match (x, y, z) {
                (json::Value::Int(x), json::Value::Int(y), json::Value::Int(z)) => {
                    match (i64::try_from(*x), i64::try_from(*y), i64::try_from(*z)) {
                        (Ok(x), Ok(y), Ok(z)) => Ok(Vec3::new(x, y, z)),
                        _ => Err(()),
                    }
                }
                _ => Err(()),
            },
            _ => Err(()),
        }),
    };
    let gait = match v.get("gait") {
        None | Some(json::Value::Null) => None,
        Some(g) => Some(g.str().ok_or(())),
    };
    let known = |k: &str| match v.get(k) {
        Some(json::Value::Bool(b)) => Some(*b),
        _ => None,
    };
    let seen = Seen {
        has: known("has") == Some(true),
        seated: known("seated"),
        free: known("free"),
    };
    match ask(form, node, point, gait).map(|a| check(&a, &seen)) {
        Err(r) | Ok(Verdict::No(r)) => verdict("no", "reason", r),
        Ok(Verdict::Unknown(w)) => verdict("unknown", "why", w),
        Ok(Verdict::Yes) => json::Value::object([("verdict", json::Value::s("yes"))]).to_json(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_verdict_from_what_is_known_and_unknown_for_the_rest() {
        let id = "07070707070707070707070707070707-9002";
        let c = |s: &str| move_check(s);
        assert_eq!(
            c(r#"{"verb":"eden:walk","has":true}"#),
            r#"{"verdict":"no","reason":"move.no-target"}"#
        );
        assert_eq!(
            c(&format!(
                r#"{{"verb":"eden:walk","this":"{id}","point":[1,2],"has":true}}"#
            )),
            r#"{"verdict":"no","reason":"move.bad-point"}"#
        );
        assert_eq!(
            c(&format!(
                r#"{{"verb":"eden:walk","this":"{id}","has":true}}"#
            )),
            r#"{"verdict":"yes"}"#
        );
        assert_eq!(
            c(&format!(
                r#"{{"verb":"eden:walk","this":"{id}","gait":"run","has":true}}"#
            )),
            r#"{"verdict":"yes"}"#
        );
        assert_eq!(
            c(&format!(
                r#"{{"verb":"eden:walk","this":"{id}","gait":"sprint","has":true}}"#
            )),
            r#"{"verdict":"no","reason":"move.unknown-gait"}"#
        );
        assert_eq!(
            c(&format!(
                r#"{{"verb":"eden:walk","this":"{id}","has":false}}"#
            )),
            r#"{"verdict":"unknown","why":"not-in-copy"}"#
        );
        assert_eq!(
            c(&format!(
                r#"{{"verb":"eden:walk","this":"{id}","has":true,"seated":true}}"#
            )),
            r#"{"verdict":"no","reason":"resource-held"}"#
        );
        assert_eq!(
            c(&format!(
                r#"{{"verb":"eden:sit","this":"{id}","has":true,"seated":false}}"#
            )),
            r#"{"verdict":"unknown","why":"holds-not-in-copy"}"#
        );
        assert_eq!(
            c(&format!(
                r#"{{"verb":"eden:lie","this":"{id}","has":true,"seated":true}}"#
            )),
            r#"{"verdict":"no","reason":"place-already-held"}"#
        );
        assert_eq!(
            c(r#"{"verb":"eden:rise","seated":false}"#),
            r#"{"verdict":"no","reason":"not-seated"}"#
        );
        assert_eq!(
            c(r#"{"verb":"eden:rise","seated":true}"#),
            r#"{"verdict":"yes"}"#
        );
        assert_eq!(
            c(r#"{"verb":"souls:walk"}"#),
            r#"{"verdict":"unknown","why":"not-a-move"}"#
        );
    }
}
