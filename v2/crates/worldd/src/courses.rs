//! The facts as a start uses them (S5): the punts on the water, the rides' and boats' courses and a kind for each
//! entry kind ([`facts`]). Every world built from facts runs it (`worldd seed`, `worldd serve`, `worldd fork --template`'s
//! check), and so does a template published from facts (`templates`, `publish-template`), so a world forked from the
//! template starts with the same punts and courses as one seeded from the same facts and entries.

use std::collections::BTreeMap;

use replica::encode::{Name, to_hex};
use replica::ids::sha256;
use replica::pose::Vec3;
use replica::rules::json::{self, Value as Json};
use sim::links::Doors;
use sim::walk::town::Town;

type R<T> = Result<T, String>;

/// The facts with their punts' moorings, their rides' courses and the entries' own kinds: [`with_punts`] (which loads
/// the facts and cuts a town only to find where planks and exits stand), [`with_rides`], [`with_entry_kinds`].
/// `stamp` is told each step as it ends (`worldd serve`'s start-up times).
pub fn facts(facts: &str, entries: &[(String, Json)], stamp: impl Fn(&str)) -> R<String> {
    let (punts, waters) = with_punts(facts)?;
    stamp("facts: punts");
    let rides = with_rides(&punts, entries, waters)?;
    stamp("facts: rides");
    with_entry_kinds(&rides, entries)
}

/// The facts with today's rowing punts added (#3603): one moored on each standing water that has room
/// (`sim::courses::punts`), a thing of kind `core:rowing_punt` at its home, turned with its plank toward the bank, on its
/// own loop (its course). The same facts give the same punts, so a seed and every serve of the world agree.
///
/// With the facts' waters and terrain when it read them (S12): the punts change no ground, so [`with_rides`] reads them
/// from here rather than loading the facts again.
fn with_punts(facts: &str) -> R<(String, Option<Waters>)> {
    let im = import_eden::load(facts)?;
    let Some(&ground) = im.nodes.get("ground") else {
        return Ok((facts.to_owned(), None));
    };
    // Planks and exits only where a body can stand on the ground as the walk cuts it (C15's `stand_near`).
    let (waters, terrain) = sim::courses::punts::waters_of(&im.tree, ground)?;
    let root = *im.nodes.get("world").ok_or("the facts have no world")?;
    let header = import_eden::header(root, &im.rules)?;
    let next = im.tree.to_state().next;
    // On the start's threads (S12): the same town as on one.
    let mut town = Town::new_on(
        im.tree,
        ground,
        Doors::new(header, im.rules, next),
        sim::ground::START_THREADS,
    )
    .map_err(|e| format!("the town: {e:?}"))?;
    let view = town.view();
    let moorings = sim::courses::punts::moorings(&waters, terrain.as_ref(), |p| {
        view.stand_near(ground, p, 0, None).is_some()
    });
    if moorings.is_empty() {
        return Ok((facts.to_owned(), Some((waters, terrain))));
    }
    let mut f = json::parse(facts).map_err(|e| format!("the facts: {e:?}"))?;
    let Json::Obj(top) = &mut f else {
        return Err("the facts are not an object".into());
    };
    let int = |n: i64| Json::Int(i128::from(n));
    let obj =
        |kv: Vec<(&str, Json)>| Json::Obj(kv.into_iter().map(|(k, v)| (k.to_owned(), v)).collect());
    let kind = obj(vec![
        ("ref", Json::s(PUNT_REF)),
        ("hash", Json::s(&to_hex(&sha256(b"souls/rowing-punt/1")))),
        ("name", Json::s("core:rowing_punt")),
        ("form", Json::s("point")),
        ("layer", Json::s("solid")),
        ("door", Json::Bool(false)),
        ("mesh", Json::Bool(false)),
        ("slots", int(2)),
    ]);
    let things: Vec<Json> = moorings
        .iter()
        .enumerate()
        .map(|(k, m)| {
            // The plank (the kind's +x) toward the bank, `-out`: a yaw turns +x to (cos, -sin). Whole degrees, so no
            // platform's last bit changes it.
            let (ox, oz) = (m.out[0] as f64, m.out[1] as f64);
            let yaw = (oz.atan2(-ox).to_degrees().round() as i64).rem_euclid(360) * 1000;
            println!(
                "punt: rowing-punt-{} on {} at {:.3},{:.3} m, plank at {:.3},{:.3} m, loop {} us from {} us",
                k + 1,
                replica::world_model::show(m.water),
                m.home.x as f64 / 1e6,
                m.home.z as f64 / 1e6,
                m.door.x as f64 / 1e6,
                m.door.z as f64 / 1e6,
                m.course.load().map_or(0, |t| t.period),
                m.course.t0
            );
            let mm = |v: i64| int(v / 1000);
            let pose = Json::Arr(vec![mm(m.home.x), mm(m.home.y), mm(m.home.z), int(yaw)]);
            let stations = m
                .course
                .stations
                .iter()
                .map(|s| Json::Arr(vec![int(s.at.x), int(s.at.y), int(s.at.z), int(s.dwell)]))
                .collect();
            let shape = match m.course.shape {
                sim::courses::Shape::Loop => 1,
                sim::courses::Shape::ThereAndBack => 2,
                sim::courses::Shape::Once => 3,
            };
            // A rider's place: what the import reads of a slot (its number, point, yaw and capacity). What a body does
            // there comes from the punt's entry, not from here.
            let place = |n: i64, id: &str, x: i64| {
                obj(vec![
                    ("n", int(n)),
                    ("id", Json::s(id)),
                    ("at", Json::Arr(vec![int(x), int(360), int(0)])),
                    ("yaw", int(180_000)),
                    ("capacity", int(1)),
                ])
            };
            obj(vec![
                ("id", Json::Str(format!("e_punt{k}"))),
                ("def", Json::s(PUNT_REF)),
                ("ref", Json::s(PUNT_REF)),
                ("parent", Json::Null),
                ("pose", pose.clone()),
                ("world", pose),
                ("scale_ppm", int(1_000_000)),
                ("name", Json::Str(format!("rowing-punt-{}", k + 1))),
                (
                    "slots",
                    Json::Arr(vec![place(1, "rider_a", -650), place(2, "rider_b", 650)]),
                ),
                (
                    "course",
                    obj(vec![
                        ("stations", Json::Arr(stations)),
                        ("shape", int(shape)),
                        ("speed", int(m.course.speed)),
                        ("t0", int(m.course.t0)),
                        ("within", int(m.course.within)),
                    ]),
                ),
            ])
        })
        .collect();
    for (key, add) in [("kinds", vec![kind]), ("things", things)] {
        match top.iter_mut().find(|(k, _)| k == key) {
            Some((_, Json::Arr(a))) => a.extend(add),
            _ => return Err(format!("the facts have no '{key}' list")),
        }
    }
    Ok((f.to_json(), Some((waters, terrain))))
}

/// The open ground's standing and running waters and its terrain (`sim::courses::punts::waters_of`).
type Waters = (Vec<sim::ground::Water>, Option<sim::ground::Terrain>);

/// The water speed of a boat's entry, µm a second: its `vehicle` on `deep_water` (`content/kinds/vehicles`: a rowing
/// boat, a canoe), read from the entry's data, never its kind's name. `None` for anything else.
fn boat_speed(entry: &Json) -> Option<i64> {
    let v = entry.get("vehicle")?;
    if v.get("ground").and_then(Json::str) != Some("deep_water") {
        return None;
    }
    match v.get("speed_mm_s")? {
        Json::Int(n) => i64::try_from(*n).ok()?.checked_mul(1000).filter(|s| *s > 0),
        _ => None,
    }
}

/// The facts with a kind for each entry kind the facts do not already name, so a creator can place a thing of any
/// kind the world has an entry for, not only of the kinds its seeded things use (#1960). A thing's kind must be pinned
/// in the world's header to be placed or made, and a seeded world pins only the kinds of its things. Each added kind
/// is a point thing with no mesh (as #3703's made notice is, by the same ref and hash), so the same entries give the
/// same kinds and every start of the world builds the same header.
fn with_entry_kinds(facts: &str, entries: &[(String, Json)]) -> R<String> {
    let mut f = json::parse(facts).map_err(|e| format!("the facts: {e:?}"))?;
    let named: std::collections::BTreeSet<String> = f
        .get("kinds")
        .and_then(Json::arr)
        .unwrap_or(&[])
        .iter()
        .filter_map(|k| {
            k.get("name")
                .and_then(Json::str)
                .map(import_eden::kind_name)
        })
        .collect();
    let add: Vec<Json> = entries
        .iter()
        .map(|(k, _)| k.as_str())
        .filter(|k| !named.contains(*k) && Name::new(k).is_some())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .map(|k| {
            Json::Obj(
                [
                    ("ref", Json::s(&format!("made-{}@1", k.replace(':', "-")))),
                    (
                        "hash",
                        Json::s(&to_hex(&sha256(format!("souls/made/{k}").as_bytes()))),
                    ),
                    ("name", Json::s(k)),
                    ("form", Json::s("point")),
                    ("layer", Json::s("decor")),
                    ("door", Json::Bool(false)),
                    ("mesh", Json::Bool(false)),
                    ("slots", Json::Int(0)),
                ]
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v))
                .collect(),
            )
        })
        .collect();
    if add.is_empty() {
        return Ok(facts.to_owned());
    }
    let Json::Obj(top) = &mut f else {
        return Err("the facts are not an object".into());
    };
    match top.iter_mut().find(|(k, _)| k == "kinds") {
        Some((_, Json::Arr(a))) => a.extend(add),
        _ => return Err("the facts have no 'kinds' list".into()),
    }
    Ok(f.to_json())
}

/// The facts with the courses of the rides `entries` declare (#3691): each thing on the ground whose kind's entry has a
/// `ride` that flies a loop from its stop (`sim::courses::rides`, read from the ride's data, never its kind's name) gets
/// its course, over the terrain beneath it. The `k`th such thing in the facts' order starts its lap `k` minutes in, so
/// rides that stand together do not fly together. The same facts and entries give the same courses at every serve.
///
/// Boats too: each thing on the ground whose entry has a `vehicle` on `deep_water` ([`boat_speed`]: a rowing boat, a
/// canoe) and that floats where it stands (`sim::courses::punts::floating`) gets a course that stands at its mooring for
/// good, run at its entry's speed. That makes it a carrier a seated rider steers over the water (`carrier:steer`,
/// `worldd::carrier`) and lands back at that mooring, its landing, where riders board and get off. A boat on dry
/// ground gets none. `waters` are the facts' ground's waters and terrain when [`with_punts`] read them, else they are
/// read here.
fn with_rides(facts: &str, entries: &[(String, Json)], waters: Option<Waters>) -> R<String> {
    let rides: BTreeMap<&str, sim::courses::rides::Ride> = entries
        .iter()
        .filter_map(|(k, e)| Some((k.as_str(), sim::courses::rides::Ride::of(e)?)))
        .filter(|(_, r)| r.loops_aloft())
        .collect();
    let boats: BTreeMap<&str, i64> = entries
        .iter()
        .filter_map(|(k, e)| Some((k.as_str(), boat_speed(e)?)))
        .collect();
    if rides.is_empty() && boats.is_empty() {
        return Ok(facts.to_owned());
    }
    let (waters, terrain) = match waters {
        Some(w) => w,
        None => {
            let im = import_eden::load(facts)?;
            let Some(&ground) = im.nodes.get("ground") else {
                return Ok(facts.to_owned());
            };
            sim::courses::punts::waters_of(&im.tree, ground)?
        }
    };
    let mut f = json::parse(facts).map_err(|e| format!("the facts: {e:?}"))?;
    let Json::Obj(top) = &mut f else {
        return Err("the facts are not an object".into());
    };
    // A kind's name as the entries name it, by its def's ref.
    let names: BTreeMap<String, String> = top
        .iter()
        .find(|(k, _)| k == "kinds")
        .and_then(|(_, v)| v.arr())
        .unwrap_or(&[])
        .iter()
        .filter_map(|k| {
            Some((
                k.get("ref")?.str()?.to_owned(),
                import_eden::kind_name(k.get("name")?.str()?),
            ))
        })
        .collect();
    let int = |n: i64| Json::Int(i128::from(n));
    let num = |v: Option<&Json>| match v {
        Some(Json::Int(n)) => i64::try_from(*n).ok(),
        _ => None,
    };
    let Some((_, Json::Arr(things))) = top.iter_mut().find(|(k, _)| k == "things") else {
        return Err("the facts have no 'things' list".into());
    };
    let mut k = 0;
    for t in things.iter_mut() {
        let on_ground = matches!(t.get("parent"), None | Some(Json::Null));
        // The entry a thing names of its own (its world's map: Eden's launch balloon is an `eden:balloon`), else its
        // kind's, as `import_eden::entry_name` reads the thing.
        let own = t
            .get("entry")
            .and_then(Json::str)
            .map(|e| replica::world_model::plain(e).to_owned());
        let Some(entry) = own.or_else(|| {
            t.get("def")
                .and_then(Json::str)
                .and_then(|d| names.get(d))
                .cloned()
        }) else {
            continue;
        };
        let (ride, boat) = (rides.get(entry.as_str()), boats.get(entry.as_str()));
        if ride.is_none() && boat.is_none() {
            continue;
        }
        let Some([x, y, z]) = t
            .get("world")
            .and_then(Json::arr)
            .and_then(|w| Some([num(w.first())?, num(w.get(1))?, num(w.get(2))?]))
        else {
            continue;
        };
        if !on_ground || t.get("course").is_some() {
            continue;
        }
        let home = Vec3::new(x * 1000, y * 1000, z * 1000);
        let c = if let Some(ride) = ride {
            let t0 = k * 60_000_000;
            let Some(c) = sim::courses::rides::course(
                ride,
                home,
                |x, z| terrain.as_ref().and_then(|g| g.height_at(x, z)),
                t0,
            ) else {
                continue;
            };
            k += 1;
            println!(
                "ride: {} at {:.3},{:.3} m, loop {} us from {} us",
                t.get("name").and_then(Json::str).unwrap_or("?"),
                home.x as f64 / 1e6,
                home.z as f64 / 1e6,
                c.load().map_or(0, |t| t.period),
                c.t0
            );
            c
        } else {
            let speed = boat.copied().unwrap_or(sim::courses::punts::ROWING);
            if !sim::courses::punts::floating(&waters, terrain.as_ref(), home.x, home.z) {
                continue;
            }
            let Ok(c) = sim::courses::punts::once_through(home, &[], 0, speed) else {
                continue;
            };
            println!(
                "boat: {} moored at {:.3},{:.3} m",
                t.get("name").and_then(Json::str).unwrap_or("?"),
                home.x as f64 / 1e6,
                home.z as f64 / 1e6
            );
            c
        };
        let shape = match c.shape {
            sim::courses::Shape::Loop => 1,
            sim::courses::Shape::ThereAndBack => 2,
            sim::courses::Shape::Once => 3,
        };
        let stations = c
            .stations
            .iter()
            .map(|s| Json::Arr(vec![int(s.at.x), int(s.at.y), int(s.at.z), int(s.dwell)]))
            .collect();
        let Json::Obj(kv) = t else { continue };
        kv.push((
            "course".to_owned(),
            Json::Obj(vec![
                ("stations".to_owned(), Json::Arr(stations)),
                ("shape".to_owned(), int(shape)),
                ("speed".to_owned(), int(c.speed)),
                ("t0".to_owned(), int(c.t0)),
                ("within".to_owned(), int(c.within)),
            ]),
        ));
    }
    Ok(f.to_json())
}

/// The rowing punt's def (#3603): today's `rowing-punt`, a kind the world adds.
const PUNT_REF: &str = "core-rowing-punt@1";

#[cfg(test)]
mod tests {
    use super::*;

    /// A boat is read from its entry's data: a `vehicle` on `deep_water` (a rowing boat at 1.5 m/s, a canoe), never a
    /// bicycle on level ground or a punt, whose course is its mooring's.
    #[test]
    fn a_boat_is_a_vehicle_on_deep_water_by_its_entry() {
        let read = |t: &str| json::parse(t).unwrap();
        let row = read(include_str!(
            "../../../../content/kinds/vehicles/rowing_boat.json"
        ));
        let canoe = read(include_str!(
            "../../../../content/kinds/vehicles/canoe.json"
        ));
        let bike = read(include_str!(
            "../../../../content/kinds/vehicles/bicycle.json"
        ));
        let punt = read(include_str!(
            "../../../../content/kinds/vehicles/rowing_punt.json"
        ));
        assert_eq!(boat_speed(&row), Some(1_500_000));
        assert!(boat_speed(&canoe).is_some());
        assert_eq!(boat_speed(&bike), None);
        assert_eq!(boat_speed(&punt), None);
    }
}
