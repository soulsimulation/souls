//! A building placed live (god mode audit #5006, row 20): the floors, rooms, windows, doors, doorways and stairs a
//! template's building has, for one placed by a creator's edit, mapped as [`crate::load_with`] maps a template's.
//!
//! A building kind's entry keeps them as its `building` section (`v2/tools/import-eden/export/buildings.ts` writes it
//! from today's generator at the def's defaults): the exporter's own record of one thing (its `solids`, `slots`,
//! `floors`, `rooms`, `openings` and `stairs`, in its frame, mm and millidegrees) and its `doors`, each a door thing
//! in one opening (`pose` in the building's frame, `solids`, `params`, `open`). [`ops`] gives the batch's operations
//! for one place of such a kind, all in the same edit, so the building and all it holds are one recorded edit, judged
//! whole by the world's checks (the safety rule among them) and taken back whole by one undo:
//!
//! - the building's own fields: its walls as its solids (field 12), its slots (13) and today's def (2), as the import
//!   writes a seeded thing's;
//! - one floor per level its rooms, floors or stairs name, at its origin, with its surfaces (14);
//! - each room on its floor, at its pose, with its name (by reference, as the import keeps words), level, height and
//!   outline; each window in its room; each door thing a child of the building, at its pose, open as the plan says;
//! - each doorway a link from the room it opens from to the room, the floor (a balcony) or the building's parent (the
//!   outside) it leads to, its row in the owning room's field 22 and its door naming it; each stair a link between
//!   two floors, its row in the lower floor's field 21.
//!
//! Every place has no support of its own (as a creator's place without one), and each floor's, room's and window's
//! origin (field 1) is `<def>/<key>`, the import's `<thing id>/<key>` with the def for the thing, so a room's kind reads
//! as a template room's (`furnish`). A door has none, so the page draws it as a thing placed live. A window with no room, a doorway to itself or to nothing there, and a flight within one storey
//! are left out, as the import leaves them (it has no such building at a def's defaults).

use super::json::{self, Json};
use super::{
    F_DEF, F_DOORWAYS, F_HEIGHT, F_LEVEL, F_NAME, F_OPEN, F_ORIGIN, F_OUTLINE, F_PARAMS, F_SILL,
    F_SLOTS, F_SOLIDS, F_STAIRS, F_SURFACES, F_WIDTH, R, i, int, label, name, need, points, pose4,
    s,
};
use replica::edit::{Op, Ref, Spot};
use replica::encode::{Name, Value};
use replica::ids::sha256;
use replica::pose::{Quat, Support, Vec3};
use replica::world_model::{Audience, End};
use std::collections::BTreeMap;

/// The pinned kinds a building's parts are placed as (full names): its floors and rooms, and its windows and doors
/// when the world pins them (without, a building has no windows, and its doorways no doors).
pub struct Parts<'a> {
    pub floor: &'a str,
    pub room: &'a str,
    pub window: Option<&'a str>,
    pub door: Option<&'a str>,
}

/// A spot at `[x, y, z, yaw mdeg]` (mm) in its parent's frame, with no support of its own.
fn spot(p: [i64; 4]) -> R<Spot> {
    let um = |v: i64| v.checked_mul(1000).ok_or("a position out of range");
    Ok(Spot {
        slot: None,
        position: Vec3::new(um(p[0])?, um(p[1])?, um(p[2])?),
        orientation: Quat::from_yaw_mdeg(p[3].rem_euclid(360_000)).map_err(|e| format!("{e:?}"))?,
        support: Support::None,
    })
}

fn need_section(entry: &replica::rules::json::Value) -> R<&replica::rules::json::Value> {
    entry
        .get("building")
        .ok_or_else(|| "the entry keeps no building section".to_owned())
}

/// The most new ids a place of a kind of this entry can mint with its parts ([`ops`]: each floor, room, window and door
/// placed, each doorway and stair linked), or none for an entry with no building section. The world reserves them
/// when it takes the edit in, before the edit checker expands it, so no later intent or edit is given one of them.
pub fn ids_most(entry: &replica::rules::json::Value) -> Option<u64> {
    let t = entry.get("building")?;
    let n = |k: &str| {
        t.get(k)
            .and_then(replica::rules::json::Value::arr)
            .map_or(0, |a| a.len() as u64)
    };
    // A floor per level its rooms, floors and stairs name: at most one each, and two for a stair.
    let floors = n("rooms") + n("floors") + 2 * n("stairs");
    // Each opening is a window placed or a doorway linked; each door is placed; each stair linked.
    Some(floors + n("rooms") + n("openings") + n("doors") + n("stairs"))
}

fn kind(full: &str) -> R<Name> {
    name(full)
}

/// The operations giving the building placed as `building` (a place of this batch) the parts its `entry`'s `building`
/// section holds, its own fields set into `fields`; `outside` is the place it stands in (its parent), what an outside
/// doorway leads to; `next` is the batch's first free name, moved past each name used. A room's name is a key of the
/// entry's text table, its words kept by reference as the import keeps them. See the module notes.
pub fn ops(
    entry: &replica::rules::json::Value,
    building: Ref,
    outside: Ref,
    fields: &mut BTreeMap<u64, Value>,
    parts: &Parts,
    next: &mut u64,
) -> R<Vec<Op>> {
    let t = json::parse(&need_section(entry)?.to_json())?;
    let def = s(&t, "def")?;
    let said = |key: &str| {
        entry
            .get("text")
            .and_then(|x| x.get(key))
            .and_then(replica::rules::json::Value::str)
            .unwrap_or(key)
            .to_owned()
    };
    let mut fresh = || {
        let n = *next;
        *next += 1;
        n
    };
    let origin = |key: &str| Value::Bytes(format!("{def}/{key}").into_bytes());
    let words = |text: &str| Value::Bytes(sha256(text.as_bytes()).to_vec());
    let place =
        |name: u64, kind: Name, parent: Ref, at: Spot, fields: BTreeMap<u64, Value>| Op::Place {
            name,
            kind,
            parent,
            at,
            audience: Audience::Everyone,
            fields,
        };

    fields.insert(F_DEF, Value::Bytes(def.as_bytes().to_vec()));
    if let Some(sol) = t.get("solids") {
        fields.insert(F_SOLIDS, points(sol)?);
    }
    if let Some(sl) = t.get("slots") {
        let rows = sl
            .arr()
            .iter()
            .map(|x| {
                let at = need(x, "at")?.arr();
                let n = |k: usize| at.get(k).and_then(Json::int).ok_or("a slot's at");
                Ok(Value::Array(vec![
                    i(int(x, "n")?),
                    i(n(0)?),
                    i(n(1)?),
                    i(n(2)?),
                    i(int(x, "yaw")?),
                    i(x.get("capacity").and_then(Json::int).unwrap_or(1)),
                ]))
            })
            .collect::<R<_>>()?;
        fields.insert(F_SLOTS, Value::Array(rows));
    }

    let mut out = Vec::new();
    // Floors: one per level its rooms, floors or stairs name, at the building's origin.
    let rooms = t.get("rooms").map(Json::arr).unwrap_or(&[]);
    let floors = t.get("floors").map(Json::arr).unwrap_or(&[]);
    let stairs = t.get("stairs").map(Json::arr).unwrap_or(&[]);
    let mut levels: BTreeMap<i64, Vec<Value>> = BTreeMap::new();
    for r in rooms {
        levels.entry(int(r, "floor")?).or_default();
    }
    for fl in floors {
        levels
            .entry(int(fl, "level")?)
            .or_default()
            .push(Value::Array(vec![
                i(int(fl, "y")?),
                points(need(fl, "polygon")?)?,
            ]));
    }
    for st in stairs {
        levels.entry(int(st, "from")?).or_default();
        levels.entry(int(st, "to")?).or_default();
    }
    let mut floor_of: BTreeMap<i64, Ref> = BTreeMap::new();
    for (lv, surfaces) in levels {
        let n = fresh();
        let mut ff = BTreeMap::from([(F_ORIGIN, origin(&format!("floor-{lv}"))), (F_LEVEL, i(lv))]);
        if !surfaces.is_empty() {
            ff.insert(F_SURFACES, Value::Array(surfaces));
        }
        out.push(place(n, kind(parts.floor)?, building, spot([0; 4])?, ff));
        floor_of.insert(lv, Ref::New(n));
    }
    let mut room_of: BTreeMap<&str, Ref> = BTreeMap::new();
    for r in rooms {
        let rid = s(r, "id")?;
        let Some(floor) = floor_of.get(&int(r, "floor")?).copied() else {
            continue;
        };
        let n = fresh();
        let rf = BTreeMap::from([
            (F_ORIGIN, origin(rid)),
            (F_NAME, words(&said(s(r, "name")?))),
            (F_LEVEL, i(int(r, "floor")?)),
            (F_HEIGHT, i(int(r, "height")?)),
            (F_OUTLINE, points(need(r, "polygon")?)?),
        ]);
        out.push(place(
            n,
            kind(parts.room)?,
            floor,
            spot(pose4(need(r, "pose")?)?)?,
            rf,
        ));
        room_of.insert(rid, Ref::New(n));
    }
    let openings = t.get("openings").map(Json::arr).unwrap_or(&[]);
    if let Some(window) = parts.window {
        for o in openings
            .iter()
            .filter(|o| o.get("kind").and_then(Json::str) == Some("window"))
        {
            let (Some(room), Some(at)) = (
                o.get("from")
                    .and_then(Json::str)
                    .and_then(|r| room_of.get(r)),
                o.get("inRoom"),
            ) else {
                continue;
            };
            let wf = BTreeMap::from([
                (F_ORIGIN, origin(s(o, "id")?)),
                (F_WIDTH, i(int(o, "width")?)),
                (F_HEIGHT, i(int(o, "height")?)),
                (F_SILL, i(o.get("sill").and_then(Json::int).unwrap_or(0))),
                (F_LEVEL, i(int(o, "level")?)),
            ]);
            out.push(place(fresh(), kind(window)?, *room, spot(pose4(at)?)?, wf));
        }
    }
    // Door things, each a child of the building, by the opening it stands in.
    let mut door_of: BTreeMap<&str, Ref> = BTreeMap::new();
    if let Some(door) = parts.door {
        for d in t.get("doors").map(Json::arr).unwrap_or(&[]) {
            let n = fresh();
            let opening = s(d, "opening")?;
            // No origin: the page draws a thing placed live (one with no origin) as a thing of its kind, and leaves
            // a node with an origin to the world's own scene, which has none for this one.
            let mut df = BTreeMap::from([(
                F_OPEN,
                Value::Uint(u64::from(d.get("open").and_then(Json::bool) != Some(false))),
            )]);
            if let Some(dd) = d.get("def").and_then(Json::str) {
                df.insert(F_DEF, Value::Bytes(dd.as_bytes().to_vec()));
            }
            if let Some(sol) = d.get("solids") {
                df.insert(F_SOLIDS, points(sol)?);
            }
            if let Some(p) = d.get("params").and_then(Json::str) {
                df.insert(F_PARAMS, Value::Bytes(p.as_bytes().to_vec()));
            }
            out.push(place(
                n,
                kind(door)?,
                building,
                spot(pose4(need(d, "pose")?)?)?,
                df,
            ));
            door_of.insert(opening, Ref::New(n));
        }
    }
    // Doorways: from the room it opens from (else the building) to the room, the floor (a balcony) or the outside.
    for o in openings
        .iter()
        .filter(|o| o.get("kind").and_then(Json::str) != Some("window"))
    {
        let oid = s(o, "id")?;
        let okind = s(o, "kind")?;
        let a = match o.get("from").and_then(Json::str) {
            Some(r) => match room_of.get(r) {
                Some(a) => *a,
                None => continue,
            },
            None => building,
        };
        let z = match o.get("to").and_then(Json::str) {
            Some("outside") | None => outside,
            Some(r) => match room_of.get(r) {
                Some(z) => *z,
                None => match floors
                    .iter()
                    .find(|x| x.get("tag").and_then(Json::str) == Some(r))
                    .and_then(|fl| floor_of.get(&fl.get("level").and_then(Json::int)?))
                {
                    Some(z) => *z,
                    None => continue,
                },
            },
        };
        if a == z {
            continue;
        }
        let at = need(o, "at")?.arr();
        let xz = |k: usize| at.get(k).and_then(Json::int).ok_or("an opening's at");
        out.push(Op::Link {
            name: fresh(),
            ty: kind(super::DOORWAY)?,
            ends: [a, z],
            owner: End::First,
            field: F_DOORWAYS,
            row: vec![
                Value::Text(label(okind).ok_or("an opening's kind")?),
                i(xz(0)?),
                i(xz(1)?),
                i(int(o, "yaw")?),
                i(int(o, "width")?),
                i(int(o, "height")?),
            ],
            door: door_of.get(oid).copied(),
        });
    }
    // Stairs: a link from the lower floor to the upper, its row in the lower's field 21.
    for st in stairs {
        let (lo, hi) = (int(st, "from")?, int(st, "to")?);
        let (Some(a), Some(z)) = (floor_of.get(&lo).copied(), floor_of.get(&hi).copied()) else {
            continue;
        };
        if a == z {
            continue;
        }
        let ty = match s(st, "kind")? {
            "stairs" => "eden:stairs",
            "ramp" => "eden:ramp",
            "ladder" => "eden:ladder",
            _ => "eden:float",
        };
        out.push(Op::Link {
            name: fresh(),
            ty: kind(ty)?,
            ends: [a, z],
            owner: End::First,
            field: F_STAIRS,
            row: vec![
                Value::Text(kind(ty)?),
                i(hi),
                i(int(st, "width")?),
                i(int(st, "y0")?),
                i(int(st, "y1")?),
                points(need(st, "path")?)?,
            ],
            door: None,
        });
    }
    Ok(out)
}
