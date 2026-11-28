//! A floor made by a seating while the world runs (racks T9). A sheet is a thing that holds a floor of its own (its
//! top, 18 mm up, in its own frame), a flight one that holds a stair's row and a landing too small to stand on, as
//! Eden's roof stairs do. Both lie loose on the open ground. The sheet is taken up (carried), seated in a site's slot
//! 2 m up, and the flight set in the slot beside it, each by the transfer a seating writes, the town's ground rebuilt
//! and installed with each commit (G3). A body then walks from the open ground up the flight onto the sheet and
//! across it. `cargo test -p sim --test deck_floor -- --nocapture` prints each step.

mod common;

use common::{arrived, dist, id, stand, walk};
use replica::effects::{
    Actor, Body as EffectBody, Cause, Effect, Envelope, Part, Rest, TransferRec,
};
use replica::encode::{Value, encode};
use replica::ids::Id;
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::time::Micros;
use replica::world_model::{Audience, show};
use sim::host::Runner;
use sim::links::Kind;
use sim::walk::World;
use sim::walk::town::Town;
use std::collections::{BTreeMap, BTreeSet};

const SPEED: i64 = 1_400_000; // µm a second
const TICK: Micros = 50_000; // µs: 20 ticks a second
const M: i64 = 1_000_000;

/// A site at (20, 0, 0) m with a slot 2 m up at its middle (the sheet's) and one on the ground 3 m south (the
/// flight's). A sheet 3 m by 2 m lying 8 m east, its floor its top. A flight lying beside it: 5 m of run rising
/// 2.018 m, its landing 1.1 m by 0.5 m beyond its top. Set in their slots, the flight's top is at the sheet's south
/// edge, at the sheet's height. Another site of the same kind has a slot 9, so the kind admits a thing in a slot 9
/// that the first site gives no point for: a thing put there is carried, as on a crew's carry.
const YARD: &str = r#"{
  "format": "souls/import-eden/1",
  "kinds": [{"ref": "core-site@1", "hash": "aa", "name": "core:site", "form": "point"},
            {"ref": "core-sheet@1", "hash": "bb", "name": "core:sheet", "form": "point"},
            {"ref": "core-flight@1", "hash": "cc", "name": "core:flight", "form": "point"}],
  "things": [
    {"id": "e_site", "def": "core-site@1", "ref": "core-site@1", "parent": null, "pose": [20000, 0, 0, 0],
     "world": [20000, 0, 0, 0], "scale_ppm": 1000000, "name": "test-site",
     "slots": [{"n": 1, "at": [0, 2000, 0], "yaw": 0, "capacity": 1},
               {"n": 2, "at": [0, 0, 3000], "yaw": 0, "capacity": 1}]},
    {"id": "e_other", "def": "core-site@1", "ref": "core-site@1", "parent": null, "pose": [12000, 0, -8000, 0],
     "world": [12000, 0, -8000, 0], "scale_ppm": 1000000, "name": "test-other-site",
     "slots": [{"n": 9, "at": [0, 0, 0], "yaw": 0, "capacity": 1}]},
    {"id": "e_sheet", "def": "core-sheet@1", "ref": "core-sheet@1", "parent": null, "pose": [28000, 0, 0, 0],
     "world": [28000, 0, 0, 0], "scale_ppm": 1000000, "name": "test-sheet",
     "floors": [{"level": 1, "y": 18, "polygon": [[-1500, -1000], [1500, -1000], [1500, 1000], [-1500, 1000]]}]},
    {"id": "e_flight", "def": "core-flight@1", "ref": "core-flight@1", "parent": null, "pose": [28000, 0, 8000, 0],
     "world": [28000, 0, 8000, 0], "scale_ppm": 1000000, "name": "test-flight",
     "floors": [{"level": 1, "y": 2018, "polygon": [[-550, -2500], [550, -2500], [550, -2000], [-550, -2000]]}],
     "stairs": [{"id": "flight", "kind": "stairs", "from": 0, "to": 1, "path": [[0, 3000], [0, -2000]], "width": 1100, "y0": 0, "y1": 2018}]}
  ],
  "doors": [],
  "places": [{"id": "p_yard", "name": "yard", "kind": "zone", "of": "area",
              "polygon": [[8000, -12000], [36000, -12000], [36000, 16000], [8000, 16000]]}],
  "ground": {"tileM": 2, "tiles": [{"tx": 0, "tz": 0, "heights": "AAAAAOgDAADQBwAAAAAAAOgDAADQBwAADP7///QBAADcBQAA", "classes": "AAECAw=="}]},
  "bake": {"things": 4, "doors": 0, "rooms": 0, "floors": 3, "floor surfaces": 2, "solids": 0, "slots": 3, "windows": 0, "doorways": 0, "stairs:stairs": 1},
  "byRef": {"core-site@1": 2, "core-sheet@1": 1, "core-flight@1": 1}
}"#;

/// `node` moved to `to` at `at`, as a seating writes it: one transfer, its leave by the node and its arrive by where
/// it goes, numbered from the zone's next sequence.
fn moved(t: &Town, node: Id, to: Frame, at: Vec3, transfer: Id) -> Part {
    let h = &t.doors.header;
    let pose = Pose {
        frame: to,
        position: at,
        orientation: Quat::IDENTITY,
        support: match to.slot {
            Some(_) => Support::Slot,
            None => Support::Surface {
                surface: to.node,
                height: 0,
            },
        },
    };
    let effect = |k: u64, node: Id, body: EffectBody| Effect {
        envelope: Envelope {
            sequence: t.tree.next() + k,
            at: 0,
            cause: Cause::World,
            actor: Actor::World,
            audience: Audience::Everyone,
            node,
        },
        body,
        events: None,
        rest: Rest::new(),
    };
    let effects = [
        effect(
            0,
            node,
            EffectBody::Transfer(TransferRec::Leave {
                transfer,
                node,
                lineage: h.lineage,
                zone: h.zone,
                pose,
            }),
        ),
        effect(
            1,
            to.node,
            EffectBody::Transfer(TransferRec::Arrive {
                transfer,
                carried: Vec::new(),
            }),
        ),
    ];
    let bytes = encode(&Value::Map(BTreeMap::from([
        (1, Value::Bytes(h.hash().to_bytes())),
        (
            2,
            Value::Array(effects.iter().map(Effect::to_value).collect()),
        ),
    ])))
    .unwrap();
    Part::read(&bytes).unwrap()
}

/// The part committed with its ground: rebuilt from the tree as the part leaves it, installed in the same call (G3).
/// Returns the nodes whose ground it touched.
fn commit(t: &mut Town, part: &Part, what: &str) -> BTreeSet<Id> {
    let (base, header, versions, basis) = (
        t.tree.frozen(),
        t.doors.header.clone(),
        t.versions.clone(),
        t.basis(),
    );
    let ground = t.ground;
    let r = Town::rebuild(base, &header, ground, &versions, &basis, part)
        .unwrap_or_else(|e| panic!("{what}: the rebuild: {e}"));
    let touched = r.touched.clone();
    t.install(r, part)
        .unwrap_or_else(|e| panic!("{what}: install refused: {}: {}", e.name, e.detail));
    t.doors.next = t.tree.next();
    let names: Vec<String> = touched.iter().map(|n| show(*n)).collect();
    println!("{what}: committed; ground touched {names:?}");
    touched
}

/// The flight's stair as the town holds it: whether it is blocked, and the floor its top lands on.
fn stair(t: &Town, flight: Id) -> Option<(Option<&'static str>, Option<Id>)> {
    let b = t.buildings.iter().find(|b| b.thing == flight)?;
    let l = b.links.iter().find(|l| l.kind == Kind::Stairs)?;
    Some((l.blocked, l.ends[1].map(|e| e.floor)))
}

/// One walk of `who` to `goal` on `node`, ticked to its end: every sample's frame and place, in order.
fn walked(
    r: &mut Runner,
    t: &mut Town,
    who: Id,
    node: Id,
    goal: Vec3,
    what: &str,
) -> Vec<(Id, Vec3)> {
    let body = match r.controller.body(who) {
        Some(b) => *b,
        None => panic!("{what}: no such body"),
    };
    let legs = walk(r, t, body, SPEED, node, goal)
        .unwrap_or_else(|e| panic!("{what}: no plan: {}: {}", e.name, e.detail));
    println!("{what}: {} legs", legs.len());
    let mut samples = Vec::new();
    let mut tick = 0;
    while !r.runs.is_empty() {
        tick += 1;
        assert!(
            tick < 1_200,
            "{what}: ends within 60 s; ended {:?}",
            r.ended.get(&who)
        );
        t.doors.next = t.tree.next();
        r.tick(t)
            .unwrap_or_else(|e| panic!("{what}: tick {tick}: {}: {}", e.name, e.detail));
        let b = r.controller.body(who).expect("the walker");
        samples.push((b.pose.frame.node, b.pose.position));
    }
    assert!(
        arrived(r, who).is_some(),
        "{what}: arrived; ended {:?}",
        r.ended.get(&who)
    );
    samples
}

#[test]
fn a_sheet_seated_while_the_world_runs_is_a_floor_and_a_flight_set_beside_it_the_way_up() {
    let im = import_eden::load(YARD).expect("loads");
    let (site, sheet, flight) = (
        im.nodes["e_site"],
        im.nodes["e_sheet"],
        im.nodes["e_flight"],
    );
    let deck = im.nodes["e_sheet/floor-1"];
    let (mut t, _) = common::town_of(im, b"souls/deck-floor/1");
    let ground = t.ground;
    let who = id(1);
    let start = Vec3::new(20 * M, 0, 9 * M);
    let on_deck = Vec3::new(-800_000, 18_000, -300_000);
    let mut r = Runner::new(TICK);
    r.add_body(common::humanoid(), stand(&t, who, ground, start))
        .expect("a body");
    let plan = |t: &mut Town, r: &Runner| {
        let b = r.controller.body(who).expect("the walker");
        t.plan(b, deck, on_deck)
            .map(|l| l.len())
            .map_err(|e| e.name)
    };

    // 1. Lying on the ground the sheet is ground cover: walked as the open ground, no floor of its own.
    let lying = plan(&mut t, &r);
    println!("1. the sheet lying: a walk onto its floor: {lying:?}");
    assert!(lying.is_err(), "no floor of its own while it lies");
    let loose = stair(&t, flight);
    println!("1. the flight lying loose: its stair {loose:?}");
    assert!(
        loose.is_none_or(|s| s.0.is_some()),
        "a flight that lands on nothing is no way up"
    );

    // 2. Taken up by a crew (a slot its parent gives no point for): carried, so no floor anywhere, and the ground is
    //    still built.
    let part = moved(
        &t,
        sheet,
        Frame {
            node: site,
            slot: Some(9),
        },
        Vec3::ZERO,
        id(100),
    );
    let touched = commit(&mut t, &part, "2. the sheet taken up");
    assert!(touched.contains(&ground) && touched.contains(&deck));
    assert!(
        !t.surfaces.contains_key(&deck),
        "a carried sheet is no floor"
    );
    assert!(plan(&mut t, &r).is_err());

    // 3. Seated 2 m up: a floor there, with no way up yet; the open ground under it stays open.
    let part = moved(
        &t,
        sheet,
        Frame {
            node: site,
            slot: Some(1),
        },
        Vec3::ZERO,
        id(101),
    );
    let touched = commit(&mut t, &part, "3. the sheet seated");
    assert!(touched.contains(&ground) && touched.contains(&deck));
    assert!(
        t.surfaces.contains_key(&deck),
        "the seated sheet is a floor"
    );
    let no_way = plan(&mut t, &r);
    println!("3. a walk onto the deck with no way up: {no_way:?}");
    assert!(no_way.is_err(), "no way up before the flight is set");
    let f = |node| Frame { node, slot: None };
    assert!(
        t.surfaces[&ground]
            .place(id(2), f(ground), Vec3::new(20 * M, 0, 0), Quat::IDENTITY)
            .is_ok(),
        "a body stands on the open ground under the deck"
    );
    // Its edges are edges: a centre stands in the middle, not at the rim.
    let stands = |p: Vec3| {
        t.surfaces[&deck]
            .place(id(3), f(deck), p, Quat::IDENTITY)
            .is_ok()
    };
    assert!(stands(Vec3::new(0, 18_000, 0)), "the deck's middle");
    assert!(
        !stands(Vec3::new(1_450_000, 18_000, 0)),
        "50 mm from its edge"
    );
    assert!(!stands(Vec3::new(1_600_000, 18_000, 0)), "past its edge");

    // 4. The flight set beside it: its top lands on the sheet's floor.
    let part = moved(
        &t,
        flight,
        Frame {
            node: site,
            slot: Some(2),
        },
        Vec3::ZERO,
        id(102),
    );
    commit(&mut t, &part, "4. the flight set");
    assert_eq!(
        stair(&t, flight),
        Some((None, Some(deck))),
        "the flight lands on the deck"
    );

    // 5. The body walks up the flight onto the deck, then across it. No sample jumps: each step is at most the
    //    speed times the tick, and where the body's frame becomes the deck's it is the same place.
    let up = walked(&mut r, &mut t, who, deck, on_deck, "5. up onto the deck");
    let in_ground = |(node, p): (Id, Vec3)| {
        if node == deck {
            Vec3::new(p.x + 20 * M, p.y + 2 * M, p.z)
        } else {
            p
        }
    };
    let step = SPEED * TICK / M;
    let mut last = start;
    let mut high = 0;
    for (k, s) in up.iter().enumerate() {
        let p = in_ground(*s);
        let d = dist(last, p);
        assert!(
            d <= step * 3 / 2 + 300_000 * i64::from(s.0 == deck && up[k.max(1) - 1].0 != deck),
            "sample {k}: {d} µm from the last, a step is {step}: {last:?} to {p:?}"
        );
        if s.0 == ground {
            high = high.max(p.y);
        }
        last = p;
    }
    let (end_node, end) = *up.last().expect("samples");
    println!(
        "5. {} samples; highest on the flight {} mm; ends on {} at {:?}",
        up.len(),
        high / 1000,
        show(end_node),
        end
    );
    assert_eq!(end_node, deck, "the walk ends on the deck's floor");
    assert_eq!(end.y, 18_000, "at the sheet's top");
    assert!(dist(end, on_deck) < 300_000, "at its goal: {end:?}");
    assert!(high > 1_800_000, "it climbed the flight: {high}");
    let across = Vec3::new(900_000, 18_000, 400_000);
    let over = walked(&mut r, &mut t, who, deck, across, "6. across the deck");
    assert!(over.iter().all(|s| s.0 == deck && s.1.y == 18_000));
    assert!(dist(over.last().unwrap().1, across) < 300_000);

    // 7. The flight taken away: the deck is a floor still, the body on it, and nothing leads up or down.
    let part = moved(&t, flight, f(ground), Vec3::new(28 * M, 0, 8 * M), id(103));
    commit(&mut t, &part, "7. the flight taken away");
    assert!(t.surfaces.contains_key(&deck));
    let b = r.controller.body(who).expect("the walker");
    assert_eq!(b.pose.frame.node, deck);
    let down = t
        .plan(b, ground, start)
        .map(|l| l.len())
        .map_err(|e| e.name);
    println!("7. a walk down with the flight gone: {down:?}");
    assert!(down.is_err());
}
