//! The Mars camp's loading yard (`worlds/templates/mars-camp.json`, its `loading` batch, PR #4995): every load the
//! loading spot's bays take is reachable at each of its grips. A carrier sent to its place at a grip (the client's
//! `carry grip <load> front|back|side <n>`, `v2/client/src/carry/carry.mjs` `gripSpot`) is granted a place the lift
//! takes: within [`GRIP_REACH`] of its grip (`Load::check_lift`), or of its grip's edge for a side carrier
//! (`Load::check_sides`), from anywhere on the open ground round the yard.
//!
//! The Mars Lab films (0.142): pallet 1's back was refused `carry-grip-out-of-reach` 1637 mm from its grip in three
//! takes, each with its carrier come from the shade yard (on the 16 m square west of the one the grip is on).
//!
//! Needs the Mars camp exported with its map (default `.local/import-eden/mars-camp.facts.json`, or `LOADING_FACTS`):
//! `node v2/tools/import-eden/export/export.ts --template worlds/templates/mars-camp.json --map
//! content/worlds/mars/map.json --out .local/import-eden/mars-camp.facts.json`, then
//! `cargo test -p sim --release --test loading_yard -- --ignored --nocapture`.

mod common;

use common::{id, send};
use replica::host::Progress;
use replica::pose::{Frame, Quat, Vec3};
use replica::rules::json::{Value as Json, parse};
use sim::activity::carry::{GRIP_REACH, Load};
use sim::host::Runner;
use sim::spots::Target;
use sim::walk::town::Town;

const SPEED: i64 = 1_400_000; // µm a second: today's walking pace
const TICK: i64 = 50_000; // µs: 20 ticks a second
const M: i64 = 1_000_000;

fn facts() -> String {
    let path = std::env::var("LOADING_FACTS").unwrap_or_else(|_| {
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../.local/import-eden/mars-camp.facts.json"
        )
        .to_owned()
    });
    std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("{path}: export the Mars camp first (this file's notes)"))
}

/// A construction kind's entry (`content/kinds/construction/<name>.json`), by its kind name (`mars:<name>`).
fn entry(kind: &str) -> Json {
    let name = kind.split(':').next_back().unwrap();
    let path = format!(
        "{}/../../../content/kinds/construction/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    parse(&std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{path}"))).unwrap()
}

fn flat(a: [i64; 2], b: [i64; 2]) -> i64 {
    (i128::from(a[0] - b[0]).pow(2) + i128::from(a[1] - b[1]).pow(2)).isqrt() as i64
}

/// One place a carrier is sent to at a load: its name, where it stands and the point the lift measures it from (its
/// grip, or for a side carrier its grip's edge on its side), µm on the plan.
struct Place {
    name: String,
    at: [i64; 2],
    grip: [i64; 2],
}

/// The places at a load whose middle is at `mid` and whose grips lie along `line` (a unit on the plan, µm per metre,
/// from the back toward the front): its back, its front and each side carrier's, as the client sends them and the
/// world's lift measures them.
fn places(load: &Load, mid: [i64; 2], line: [i64; 2]) -> Vec<Place> {
    let on = |along: i64, across: i64| {
        [
            mid[0] + (line[0] * along - line[1] * across) / M,
            mid[1] + (line[1] * along + line[0] * across) / M,
        ]
    };
    let [back, front] = load.places();
    let mut out = vec![
        Place {
            name: "back".into(),
            at: on(back, 0),
            grip: on(load.grips[0], 0),
        },
        Place {
            name: "front".into(),
            at: on(front, 0),
            grip: on(load.grips[1], 0),
        },
    ];
    for (k, [along, across]) in load.side_places().into_iter().enumerate() {
        out.push(Place {
            name: format!("side {}", k + 1),
            at: on(along, across),
            grip: on(along, across.signum() * load.half_width),
        });
    }
    out
}

/// Walker `who` standing at `from` on the ground, sent to `to`: where it is granted to stand, after one tick, or the
/// refusal's name; none when no body may stand at `from`.
fn granted(
    t: &mut Town,
    who: u64,
    from: [i64; 2],
    to: [i64; 2],
) -> Option<Result<[i64; 2], String>> {
    let ground = t.ground;
    let body = t.surfaces[&ground]
        .place(
            id(who),
            Frame {
                node: ground,
                slot: None,
            },
            Vec3::new(from[0], 0, from[1]),
            Quat::IDENTITY,
        )
        .ok()?;
    let mut c = Runner::new(TICK);
    send(
        &mut c,
        body,
        SPEED,
        Target::new(ground, Vec3::new(to[0], 0, to[1])),
        id(5000 + who),
    )
    .unwrap();
    c.tick(t).unwrap();
    Some(match (c.granted.get(&id(who)), c.ended.get(&id(who))) {
        (Some(p), _) => Ok([p.x, p.z]),
        (None, Some((_, Progress::Failed(name)))) => Err(name.as_str().to_owned()),
        _ => panic!("no answer after a tick"),
    })
}

/// Where carriers come from: every 4 m over the open ground round the yards (x -8 to 32 m, z 8 to 40 m), the shade
/// yard and the rack yard among them; a start no body may stand on is left out.
fn starts() -> Vec<[i64; 2]> {
    (0..=10)
        .flat_map(|i| (0..=8).map(move |k| [(-8 + 4 * i) * M, (8 + 4 * k) * M]))
        .collect()
}

/// Sends a walker from each start to each place; the places it is granted out of the lift's reach, as lines.
fn misses(t: &mut Town, what: &str, places: &[Place], starts: &[[i64; 2]]) -> (usize, Vec<String>) {
    let (mut sent, mut out) = (0, Vec::new());
    for p in places {
        for (k, s) in starts.iter().enumerate() {
            let got = match granted(t, 1 + k as u64, *s, p.at) {
                None => continue,
                Some(Ok(g)) => g,
                Some(Err(e)) => {
                    out.push(format!("{what} {}: from {s:?} refused {e}", p.name));
                    continue;
                }
            };
            sent += 1;
            let off = flat(got, p.grip);
            if off > GRIP_REACH {
                out.push(format!(
                    "{what} {}: from ({}, {}) m granted ({}, {}) mm, {} mm from its grip at ({}, {}) mm, {} mm from its place",
                    p.name,
                    s[0] / M,
                    s[1] / M,
                    got[0] / 1000,
                    got[1] / 1000,
                    off / 1000,
                    p.grip[0] / 1000,
                    p.grip[1] / 1000,
                    flat(got, p.at) / 1000
                ));
            }
        }
    }
    (sent, out)
}

#[test]
#[ignore = "needs the Mars camp's exported facts (this file's notes)"]
fn every_load_in_the_loading_yard_is_reachable_at_every_grip() {
    let text = facts();
    let f = parse(&text).unwrap();
    let (mut t, _) = common::town_of(
        import_eden::load(&text).expect("the Mars camp loads"),
        b"souls/loading-yard-test/1",
    );
    // The loads: each thing whose kind the loading spot's bays take.
    let spot = entry("mars:loading_spot");
    let takes: Vec<String> = spot
        .get("slots")
        .and_then(Json::obj)
        .unwrap()
        .iter()
        .flat_map(|(_, s)| s.get("kinds").and_then(Json::arr).unwrap_or(&[]))
        .filter_map(|k| k.str().map(str::to_owned))
        .collect();
    let kind_of = |r: &str| {
        f.get("kinds")
            .and_then(Json::arr)
            .unwrap()
            .iter()
            .find(|k| k.get("ref").and_then(Json::str) == Some(r))
            .and_then(|k| k.get("name").and_then(Json::str))
            .map(str::to_owned)
    };
    let int = |v: &Json| match v {
        Json::Int(n) => i64::try_from(*n).unwrap(),
        _ => panic!("an integer"),
    };
    let starts = starts();
    let (mut loads, mut sent, mut out) = (0, 0, Vec::new());
    for thing in f.get("things").and_then(Json::arr).unwrap() {
        let Some(kind) = thing.get("def").and_then(Json::str).and_then(kind_of) else {
            continue;
        };
        if !takes.contains(&kind) {
            continue;
        }
        let name = thing
            .get("name")
            .and_then(Json::str)
            .unwrap_or("?")
            .to_owned();
        let w: Vec<i64> = thing
            .get("world")
            .and_then(Json::arr)
            .unwrap()
            .iter()
            .map(int)
            .collect();
        let load = Load::of(&entry(&kind)).unwrap();
        let o = Quat::from_yaw_mdeg(w[3]).unwrap();
        let along = load
            .lies_along(o)
            .unwrap()
            .expect("a load in the yard lies");
        let l = flat(along, [0, 0]);
        let line = [along[0] * M / l, along[1] * M / l];
        let at = places(&load, [w[0] * 1000, w[2] * 1000], line);
        let (n, miss) = misses(&mut t, &format!("{name} ({kind})"), &at, &starts);
        println!(
            "{name} ({kind}) at ({}, {}) m: {} places, {n} walks sent, {} out of reach",
            w[0] / 1000,
            w[2] / 1000,
            at.len(),
            miss.len()
        );
        loads += 1;
        sent += n;
        out.extend(miss);
    }
    println!("{}", out.join("\n"));
    assert_eq!(loads, 4, "the yard's four loads");
    assert!(sent > 1000, "walks from most starts: {sent}");
    assert!(
        out.is_empty(),
        "{} places granted out of the lift's reach",
        out.len()
    );
}
