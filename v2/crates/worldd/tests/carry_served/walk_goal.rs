//! #5254, walks that stop short of their goal, on a served world by Souls' own intents through a real gateway: a goal
//! in a doorway is moved off only as far as clears the doorway itself (the body's radius and margin, not the 0.7 m a
//! walker is kept from a passage) and the walk's end says how far and which passage (`walk.goal-moved`); two crews
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
        (1, Value::Bytes(Hash::of(Purpose::Fixture, b"souls/5254-walk-goal/1").to_bytes())),
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
            .filter(|ev| {
                ev.name.as_str() == "souls:move-ended" && ev.fields.get(&1) == Some(&body.to_value())
            })
            .last()
            .map(|ev| ev.fields.clone());
        if let Some(f) = found {
            return f;
        }
        assert!(Instant::now() < end, "no souls:move-ended of {body:?} in the log");
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
/// walk is done where it stands clear of the doorway itself, nearer than the 0.7 m a walker is kept from a passage, and
/// its end says `walk.goal-moved`, how far (field 7, the gap it stands from the point it was sent to) and the doorway
/// it cleared (field 10).
#[tokio::test(flavor = "multi_thread")]
async fn walk_goal_a_goal_in_a_doorway_is_moved_off_only_as_far_as_clears_it() {
    let d = scratch("wgdoor");
    let facts = world(&d);
    let socket = d.join("s");
    let (dir, ids, served) = seed_and_serve(&d, &facts, (0, 36), &socket, 1);
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
    println!("to the doorway: {got:?}, {} mm off; its end {f:?}", off / 1000);
    assert!(got.is_ok(), "the walk is done: {got:?}");
    assert_eq!(text(f.get(&2)).as_deref(), Some("walk.goal-moved"), "its end's word");
    let Some(Value::Uint(mm)) = f.get(&7) else {
        panic!("how far, field 7: {f:?}")
    };
    let mm = i64::try_from(*mm).unwrap();
    assert!((mm - off / 1000).abs() <= 2, "field 7 ({mm} mm) is how far it stands from its goal ({off} µm)");
    // Clear of the doorway itself (at least the body's radius and margin, 0.34 m, off the goal in it), yet still within
    // the 0.7 m a walker is kept from it: moved only as far as needed, never the full clearance.
    assert!(mm >= 340, "moved clear of the doorway itself: {mm} mm");
    let end = stood(&dir)[&body];
    let town = town_of(&facts);
    assert!(
        town.passage_at(ground, end).is_some(),
        "it stands within the 0.7 m a walker is kept from the doorway, not moved the full clearance: {end:?}"
    );
    assert!(town.passage_at(ground, goal).is_some(), "the goal was in the doorway");
    assert_eq!(text(f.get(&10)).as_deref(), Some("doorway"), "the passage it cleared");
    assert!(f.contains_key(&9), "the thing the doorway belongs to: {f:?}");
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
    let carry_a = gather(&mut a0[0], &mut a1[0], &dir, ground, beam_a, &entry, a_at, true).await;
    let carry_b = gather(&mut b0[0], &mut b1[0], &dir, ground, beam_b, &entry, b_at, true).await;
    let bodies: Vec<Id> = ids.iter().map(|s| body_of(&dir, *s)).collect();
    for (s, carry, beam) in [(&mut a0[0], carry_a, beam_a), (&mut b0[0], carry_b, beam_b)] {
        s.act("carry:lift", carry, BTreeMap::from([(1, beam.to_value())]))
            .await
            .expect("lifted");
    }
    let north = |p: Vec3, by: i64| Vec3::new(p.x, 0, p.z + by);
    let lane = 7 * M;
    // Crew A first carries its beam 7 m north, out of the yard's row.
    a0[0].send("eden:walk", ground, point(north(spot(a_at, front, true), lane))).await;
    a1[0].send("eden:walk", ground, point(north(spot(a_at, back, true), lane))).await;
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
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../../.local/import-eden/mars-camp.facts.json").to_owned()
    });
    let facts = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{path}: export the Mars camp first"));
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
    std::fs::copy(root.join("body/humanoid.json"), entries.join("humanoid.json")).unwrap();
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
        println!("crew walker {k}: {g:?}, {} mm off its goal; its end {:?}", off / 1000, move_ended(&dir, bodies[k]));
        assert!(g.is_ok(), "crew walker {k} arrives: {g:?}");
        assert!(off <= 400_000, "crew walker {k} within 0.4 m: {off} µm");
    }
    drop(served);
}
