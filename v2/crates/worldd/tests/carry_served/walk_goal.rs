//! #5254, walks that stop short of their goal, on a served world by Souls' own intents through a real gateway: a goal
//! in a doorway is moved out to the 0.7 m a walker is kept from a passage (A3: no standing place narrows a doorway for
//! others) and the walk's end says how far and which passage (`walk.goal-moved`); two crews
//! carrying past each other both arrive within 0.4 m of their goals; on the Mars camp, a crew walks from the rack pile
//! to beside the deck bay and arrives within 0.4 m.

use super::*;
use replica::effects::{Header, schema_hash};
use replica::ids::{Hash, Purpose};
use sim::links::Doors;
use sim::walk::town::Town;

/// `facts` as a town ([`Town::new`]), to ask what counts as a passage where a body stood.
fn town_of(facts: &str) -> Town {
    let im = import_eden::load(facts).expect("the facts load");
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/5254-walk-goal/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(im.nodes["world"].scope().0.to_vec())),
        (4, im.nodes["world"].to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(Vec::new())),
        (7, Value::Array(Vec::new())),
    ]));
    let header = Header::read(&encode(&v).unwrap()).unwrap();
    let next = im.tree.to_state().next;
    let ground = im.nodes["ground"];
    Town::new(im.tree, ground, Doors::new(header, im.rules, next)).expect("the town")
}

/// The last `souls:move-ended` of `body` in the log: its fields.
fn move_ended(dir: &Path, body: Id) -> BTreeMap<u64, Value> {
    let end = Instant::now() + Duration::from_secs(20);
    loop {
        let found = effects(dir)
            .iter()
            .flat_map(|e| e.events.iter().flatten())
            .rfind(|ev| {
                ev.name.as_str() == "souls:move-ended"
                    && ev.fields.get(&1) == Some(&body.to_value())
            })
            .map(|ev| ev.fields.clone());
        if let Some(f) = found {
            return f;
        }
        assert!(
            Instant::now() < end,
            "no souls:move-ended of {body:?} in the log"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn text(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::Bytes(b)) => String::from_utf8(b.clone()).ok(),
        Some(Value::Text(t)) => Some(t.as_str().to_owned()),
        _ => None,
    }
}

fn gap(a: Vec3, b: Vec3) -> i64 {
    (i128::from(a.x - b.x).pow(2) + i128::from(a.z - b.z).pow(2)).isqrt() as i64
}

/// A Soul sent to the middle of the hall's front doorway, on the open ground's side of its wall (N2's test world): the
/// walk is done where it stands at or beyond the 0.7 m a walker is kept from a passage, and its end says `walk.goal-moved`, how far (field 7, the gap it stands from the point it was sent to) and the doorway
/// it cleared (field 10).
#[tokio::test(flavor = "multi_thread")]
async fn walk_goal_a_goal_in_a_doorway_is_moved_out_to_a_walkers_clearance() {
    let d = scratch("wgdoor");
    let facts = world(&d);
    let socket = d.join("s");
    let (dir, ids, served) = seed_and_serve(&d, &facts, (0, 36), &socket, 3);
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let ground = im.nodes["ground"];
    let lineage = im.nodes["world"].scope();
    let (url, tokens) = gateway(&socket, &ids).await;
    let mut s = Soul::connect(&url, ids[0], lineage, &tokens[0]).await;
    // The front door's wall centre (`testworld`: the hall's half depth and half a wall south of its centre), x 0.
    let hz = testworld::HALL_DEPTH / 2 + testworld::WALL / 2;
    let goal = Vec3::new(0, 0, (testworld::HALL_Z - hz) * 1000);
    let got = s.act("eden:walk", ground, point(goal)).await;
    let body = body_of(&dir, ids[0]);
    let f = move_ended(&dir, body);
    let off = gap(stood(&dir)[&body], goal);
    println!(
        "to the doorway: {got:?}, {} mm off; its end {f:?}",
        off / 1000
    );
    assert!(got.is_ok(), "the walk is done: {got:?}");
    assert_eq!(
        text(f.get(&2)).as_deref(),
        Some("walk.goal-moved"),
        "its end's word"
    );
    let Some(Value::Uint(mm)) = f.get(&7) else {
        panic!("how far, field 7: {f:?}")
    };
    let mm = i64::try_from(*mm).unwrap();
    assert!(
        (mm - off / 1000).abs() <= 2,
        "field 7 ({mm} mm) is how far it stands from its goal ({off} µm)"
    );
    // At or beyond the 0.7 m a walker is kept from the doorway (A3).
    assert!(mm >= 700, "moved out to a walker's clearance: {mm} mm");
    let end = stood(&dir)[&body];
    let town = town_of(&facts);
    assert!(
        town.passage_at(ground, end).is_none(),
        "it stands clear of the doorway's 0.7 m: {end:?}"
    );
    assert!(
        town.passage_at(ground, goal).is_some(),
        "the goal was in the doorway"
    );
    assert_eq!(
        text(f.get(&10)).as_deref(),
        Some("doorway"),
        "the passage it cleared"
    );
    assert!(
        f.contains_key(&9),
        "the thing the doorway belongs to: {f:?}"
    );
    // Two more sent to the same goal at once, its nearest place held: each is moved off the doorway, says how far it
    // truly stands from the goal, at or beyond a walker's clearance, a body's room from the others; never stuck.
    let mut more = Vec::new();
    for k in 1..3 {
        more.push(Soul::connect(&url, ids[k], lineage, &tokens[k]).await);
    }
    for m in more.iter_mut() {
        m.send("eden:walk", ground, point(goal)).await;
    }
    for (k, m) in more.iter_mut().enumerate() {
        let got = m.answer().await;
        let body = body_of(&dir, ids[k + 1]);
        let f = move_ended(&dir, body);
        let end = stood(&dir)[&body];
        let off = gap(end, goal);
        let word = text(f.get(&2));
        println!(
            "another to the doorway: {got:?}, {} mm off; its end {f:?}",
            off / 1000
        );
        assert_eq!(
            word.as_deref(),
            Some("walk.goal-moved"),
            "its end's word: {f:?}"
        );
        assert!(got.is_ok(), "done: {got:?}");
        let Some(Value::Uint(mm)) = f.get(&7) else {
            panic!("how far, field 7: {f:?}")
        };
        let mm = i64::try_from(*mm).unwrap();
        assert!((mm - off / 1000).abs() <= 2, "field 7 is how far it stands");
        assert!(mm >= 700, "moved out to a walker's clearance: {mm} mm");
        assert!(
            town.passage_at(ground, end).is_none(),
            "it stands clear of the doorway's 0.7 m: {end:?}"
        );
    }
    // No two bodies stand within a body's room of each other (0.56 m: two radii).
    let at = stood(&dir);
    let all: Vec<Vec3> = ids.iter().map(|s| at[&body_of(&dir, *s)]).collect();
    for a in 0..all.len() {
        for b in a + 1..all.len() {
            assert!(
                gap(all[a], all[b]) >= 560_000,
                "bodies {a} and {b} stand apart: {:?} {:?}",
                all[a],
                all[b]
            );
        }
    }
    drop(served);
}

/// Two crews of two, each carrying a yard beam (`yard-beam-1` and `yard-beam-4`, 0.9 m apart), carry them past each
/// other on lanes 0.9 m apart, 7 m each way: every carrier's walk is done within 0.4 m of its goal.
#[tokio::test(flavor = "multi_thread")]
async fn walk_goal_two_crews_carrying_past_each_other_both_arrive() {
    let d = scratch("wgcrews");
    let facts = world(&d);
    let socket = d.join("s");
    let (dir, ids, served) = seed_and_serve(&d, &facts, (44, -18), &socket, 4);
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let ground = im.nodes["ground"];
    let lineage = im.nodes["world"].scope();
    let (url, tokens) = gateway(&socket, &ids).await;
    let mut souls = Vec::new();
    for (s, t) in ids.iter().zip(&tokens) {
        souls.push(Soul::connect(&url, *s, lineage, t).await);
    }
    let entry = construction("rack_beam.json");
    let [back, front] = Load::of(&entry).unwrap().places();
    let at = |k: i64| {
        Vec3::new(
            (testworld::YARD_X + 2_000 + k * testworld::BEAM_PITCH) * 1000,
            0,
            testworld::YARD_Z * 1000,
        )
    };
    let (a_at, b_at) = (at(3), at(0));
    let (beam_a, beam_b) = (im.nodes["yard-beam-4"], im.nodes["yard-beam-1"]);
    let (crew_a, crew_b) = souls.split_at_mut(2);
    let (a0, a1) = crew_a.split_at_mut(1);
    let (b0, b1) = crew_b.split_at_mut(1);
    let carry_a = gather(
        &mut a0[0], &mut a1[0], &dir, ground, beam_a, &entry, a_at, true,
    )
    .await;
    let carry_b = gather(
        &mut b0[0], &mut b1[0], &dir, ground, beam_b, &entry, b_at, true,
    )
    .await;
    let bodies: Vec<Id> = ids.iter().map(|s| body_of(&dir, *s)).collect();
    for (s, carry, beam) in [(&mut a0[0], carry_a, beam_a), (&mut b0[0], carry_b, beam_b)] {
        s.act("carry:lift", carry, BTreeMap::from([(1, beam.to_value())]))
            .await
            .expect("lifted");
    }
    let north = |p: Vec3, by: i64| Vec3::new(p.x, 0, p.z + by);
    let lane = 7 * M;
    // Crew A first carries its beam 7 m north, out of the yard's row.
    a0[0]
        .send(
            "eden:walk",
            ground,
            point(north(spot(a_at, front, true), lane)),
        )
        .await;
    a1[0]
        .send(
            "eden:walk",
            ground,
            point(north(spot(a_at, back, true), lane)),
        )
        .await;
    a0[0].answer().await.expect("crew A's front north");
    a1[0].answer().await.expect("crew A's back north");
    // Then both at once: crew A south again, crew B north, past each other on lanes 0.9 m apart. A crew carried south
    // keeps its front north: its back leads.
    let goals = [
        spot(a_at, front, true),
        spot(a_at, back, true),
        north(spot(b_at, front, true), lane),
        north(spot(b_at, back, true), lane),
    ];
    a0[0].send("eden:walk", ground, point(goals[0])).await;
    a1[0].send("eden:walk", ground, point(goals[1])).await;
    b0[0].send("eden:walk", ground, point(goals[2])).await;
    b1[0].send("eden:walk", ground, point(goals[3])).await;
    let mut got = Vec::new();
    for s in [&mut a0[0], &mut a1[0], &mut b0[0], &mut b1[0]] {
        got.push(s.answer().await);
    }
    let at_end = stood(&dir);
    for (k, g) in got.iter().enumerate() {
        let off = gap(at_end[&bodies[k]], goals[k]);
        println!("carrier {k}: {g:?}, {} mm off its goal", off / 1000);
        assert!(g.is_ok(), "carrier {k} arrives: {g:?}");
        assert!(off <= 400_000, "carrier {k} within 0.4 m: {off} µm");
    }
    drop(served);
}

/// The Mars camp (`worlds/templates/mars-camp.json`, exported with its map: `MARS_CAMP_FACTS`, default
/// `.local/import-eden/mars-camp.facts.json`, as `sim`'s `loading_yard` test notes): a crew of two born at the deck
/// yard's rack pile walks to beside the deck bay, where a frame is set down at its `upright_a` slot (the bay's
/// south side, 0.35 m beyond its bounds, a carrier each side of the frame's place): both walks are done within 0.4 m.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the Mars camp's exported facts (MARS_CAMP_FACTS)"]
async fn walk_goal_on_the_mars_camp_a_crew_walks_from_the_rack_pile_to_beside_the_deck_bay() {
    let path = std::env::var("MARS_CAMP_FACTS").unwrap_or_else(|_| {
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../.local/import-eden/mars-camp.facts.json"
        )
        .to_owned()
    });
    let facts = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("{path}: export the Mars camp first"));
    let d = scratch("wgcamp");
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let entries = d.join("entries");
    std::fs::create_dir_all(&entries).unwrap();
    for f in std::fs::read_dir(root.join("construction")).unwrap() {
        let p = f.unwrap().path();
        if p.extension().is_some_and(|x| x == "json") {
            std::fs::copy(&p, entries.join(p.file_name().unwrap())).unwrap();
        }
    }
    std::fs::copy(
        root.join("body/humanoid.json"),
        entries.join("humanoid.json"),
    )
    .unwrap();
    let socket = d.join("s");
    // Born at the rack pile: the two 12 ft frames lie at (-30, 19) and (-30, 21.5).
    let (dir, ids, served) = seed_and_serve(&d, &facts, (-31, 20), &socket, 2);
    served.line("listening ", 300);
    let im = import_eden::load(&facts).unwrap();
    let ground = im.nodes["ground"];
    let lineage = im.nodes["world"].scope();
    let (url, tokens) = gateway(&socket, &ids).await;
    let mut souls = Vec::new();
    for (s, t) in ids.iter().zip(&tokens) {
        souls.push(Soul::connect(&url, *s, lineage, t).await);
    }
    // The deck bay (`deck_bay.json`: 4.328 m by 2.972 m, `upright_a` 1.448 m south of its middle) as the template places
    // it, and a 12 ft frame's half width (0.61 m).
    let (bx, bz) = (-24_000_000, 23_372_000);
    let z = bz - 2_972_000 / 2 - 350_000;
    let goals = [
        Vec3::new(bx - 610_000 - 350_000, 0, z),
        Vec3::new(bx + 610_000 + 350_000, 0, z),
    ];
    for (s, g) in souls.iter_mut().zip(goals) {
        s.send("eden:walk", ground, point(g)).await;
    }
    let mut got = Vec::new();
    for s in souls.iter_mut() {
        got.push(s.answer().await);
    }
    let bodies: Vec<Id> = ids.iter().map(|s| body_of(&dir, *s)).collect();
    let at_end = stood(&dir);
    for (k, g) in got.iter().enumerate() {
        let off = gap(at_end[&bodies[k]], goals[k]);
        println!(
            "crew walker {k}: {g:?}, {} mm off its goal; its end {:?}",
            off / 1000,
            move_ended(&dir, bodies[k])
        );
        assert!(g.is_ok(), "crew walker {k} arrives: {g:?}");
        assert!(off <= 400_000, "crew walker {k} within 0.4 m: {off} µm");
    }
    drop(served);
}

/// Each part of the log, in order: its tick, its body rows of `body` (where it stood) and whether it ended a move of
/// `body` (`souls:move-ended`).
fn ticks_of(dir: &Path, body: Id) -> Vec<(u64, Option<Vec3>, bool)> {
    let bytes = std::fs::read(dir.join("log")).unwrap_or_default();
    let Ok(r) = sim::log::recover(&bytes) else {
        return Vec::new();
    };
    r.records
        .into_iter()
        .filter(|r| !sim::recorder::is_input(r))
        .filter_map(|r| Part::read(&r).ok())
        .filter_map(|p| {
            let Some(Value::Uint(t)) = p.rest.get(&answers::TICK) else {
                return None;
            };
            let at = match p.rest.get(&answers::BODIES) {
                Some(Value::Array(rows)) => rows
                    .iter()
                    .filter_map(worldd::bodies::read_row)
                    .filter(|(b, ..)| *b == body)
                    .map(|(_, pose, _)| pose.position)
                    .next_back(),
                _ => None,
            };
            let ended = p
                .effects
                .iter()
                .flat_map(|e| e.events.iter().flatten())
                .any(|ev| {
                    ev.name.as_str() == "souls:move-ended"
                        && ev.fields.get(&1) == Some(&body.to_value())
                });
            Some((*t, at, ended))
        })
        .collect()
}

/// N4 item 4, the walk's six sends (#5254, `WALK_AGAIN`): a Soul sent to a point in the hall's floor's frame 1 m
/// outside its front wall (no floor there; 5 m from the doorway) walks in through the front door and stops at the
/// nearest place on the floor, about 1.3 m short of the point. Its walk is sent again six times, each half a second
/// after it stopped (nothing in its way moves), and only then ends `walk.stopped-short`: at least six half seconds after
/// the body last moved, not before.
#[tokio::test(flavor = "multi_thread")]
async fn walk_goal_a_walk_stopped_short_is_sent_again_six_times_before_it_ends_stopped_short() {
    let d = scratch("wgsix");
    let facts = world(&d);
    let socket = d.join("s");
    let (dir, ids, served) = seed_and_serve(&d, &facts, (0, 36), &socket, 1);
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let (ground, floor) = (im.nodes["ground"], im.nodes["hall/floor-0"]);
    let lineage = im.nodes["world"].scope();
    let (url, tokens) = gateway(&socket, &ids).await;
    let mut s = Soul::connect(&url, ids[0], lineage, &tokens[0]).await;
    s.act("eden:walk", ground, point(Vec3::new(0, 0, 36 * M)))
        .await
        .expect("born");
    let body = body_of(&dir, ids[0]);
    let goal = Vec3::new(5 * M, 0, -(testworld::HALL_DEPTH / 2 + 1_000) * 1000);
    let got = s.act("eden:walk", floor, point(goal)).await;
    println!("to 1 m outside the hall's front wall, in its floor's frame: {got:?}");
    assert_eq!(
        got.map(|_| ()),
        Err("walk.stopped-short".to_owned()),
        "its end"
    );
    let rows = ticks_of(&dir, body);
    let moved = rows
        .iter()
        .filter(|(_, at, _)| at.is_some())
        .map(|(t, ..)| *t)
        .max()
        .expect("the body's rows");
    let ended = rows
        .iter()
        .filter(|(.., e)| *e)
        .map(|(t, ..)| *t)
        .max()
        .expect("the walk's end");
    let again = u64::from(worldd::bodies::WALK_AGAIN);
    let wait = u64::try_from(worldd::bodies::WALK_AGAIN_AFTER / 50_000).unwrap();
    println!(
        "last moved at tick {moved}, ended at tick {ended}: {} ticks ({again} sends again, {wait} ticks apart at least)",
        ended - moved
    );
    assert!(
        ended - moved >= again * wait,
        "sent again {again} times before it ends: {} ticks",
        ended - moved
    );
    assert!(
        ended - moved <= again * (wait + 5) + 20,
        "and then ended, not sent on: {} ticks",
        ended - moved
    );
    drop(served);
}
