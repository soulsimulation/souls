//! Engine v2 E10 (#2781): how to move. A manner is a word on the body, kept until changed, applied to every later walk
//! and recorded as a fact (`replica::walk`); a walk passes up to eight places on its way without stopping, goes along a
//! named path or shore, round a place or to and fro, laps stated (`sim::routes::way`, `Town::plan_way`). Every walk
//! here runs through the host (`skills::route`), the controller as the body's one mover.
//!
//! The first three tests run on N2's test world. `a4_eden_six` needs N1's exported facts file
//! (`node v2/tools/import-eden/export/export.ts` from the repository root) and runs with
//! `cargo test -p sim --release --test way -- --ignored --nocapture`; it writes the canal route as a picture to
//! `.local/e10/canal-route.svg`.

use std::collections::BTreeMap;

use replica::effects::Change;
use replica::encode::{Name, Value, encode};
use replica::ids::Id;
use replica::pose::Vec3;
use replica::time::Micros;
use replica::walk::{
    F_MANNER, LAPS_MOST, P_LAPS, P_VIA, Shape, Stop, VIA_MOST, Way, manner, set_manner,
};
use sim::gaits::{JOG, WALK, speed_of};
use sim::host::Runner;
use sim::walk::town::Town;
use skills::route::AT_GOAL;

mod common;

const TICK: Micros = 50_000;
/// A slow tick this near a way's point is a stop at it, µm.
const NEAR: i64 = 2_000_000;

fn id(n: u64) -> Id {
    common::id(n)
}

fn name(t: &str) -> Name {
    Name::new(t).unwrap()
}

fn test_town() -> (Town, Id) {
    let (t, nodes) = common::town(b"souls/way-test/1");
    (t, nodes["ground"])
}

/// One walk, as it went.
#[derive(Debug)]
struct Walked {
    ended: String,
    legs: usize,
    searches: u32,
    dropped: u32,
    /// Where the body stood at the end of each tick, x and z µm.
    track: Vec<[i64; 2]>,
    /// The speed it was sent at, µm a second, and the speed it made good (its track's length over the time).
    speed: i64,
    made_good: i64,
    /// Ticks between its first step and its end in which it moved under a tenth of its speed within [`NEAR`] of one
    /// of the way's points: a stop on its way.
    stops: u32,
    /// Every such slow tick, anywhere (a step cut at a square's seam or an edge, N6 and N7's), leaving out the ticks
    /// of a link's crossing.
    slow: u32,
    /// The way's points.
    points: Vec<[i64; 2]>,
}

/// A world of one walker, its walks run a tick at a time through the host by T9c's runner.
struct World1 {
    town: Town,
    ground: Id,
    runner: Runner,
    /// Every entry applied by an act: the facts, in order.
    facts: Vec<Change>,
}

impl World1 {
    fn new(town: Town, ground: Id) -> World1 {
        World1 {
            town,
            ground,
            runner: Runner::new(TICK),
            facts: Vec::new(),
        }
    }

    fn put(&mut self, who: Id, at: [i64; 2]) {
        let body = common::stand(&self.town, who, self.ground, Vec3::new(at[0], 0, at[1]));
        self.runner.add_body(common::humanoid(), body).unwrap();
    }

    /// A body's own fields, as its entries set them (its manner among them).
    fn fields(&self, who: Id) -> &BTreeMap<u64, Value> {
        &self.runner.fields[&who]
    }

    /// A `souls:manner` act: its change is an entry of the body's own node.
    fn manner(&mut self, who: Id, word: &str) {
        let p = BTreeMap::from([(replica::walk::P_MANNER, Value::Text(name(word)))]);
        let word = replica::walk::manner_word(&p).unwrap();
        let c = set_manner(who, word);
        if let Change::Set {
            node, field, to, ..
        } = &c
        {
            self.runner
                .fields
                .entry(*node)
                .or_default()
                .insert(*field, to.clone());
        }
        self.facts.push(c);
    }

    fn walk(&mut self, who: Id, way: &Way, goal: Option<[i64; 2]>, most: u64) -> Walked {
        let body = *self.runner.controller.body(who).unwrap();
        let goal = goal.map(|g| Vec3::new(g[0], 0, g[1]));
        let (legs, pts) = self
            .town
            .plan_way(&body, way, goal)
            .unwrap_or_else(|e| panic!("the way: {e:?}"));
        let n = legs.len();
        // The manner on the body, read when the walk starts: a gait's speed, else a walk.
        let word = self
            .runner
            .fields
            .get(&who)
            .and_then(manner)
            .map(|w| w.as_str().to_owned());
        let speed = speed_of(word.as_deref());
        self.runner
            .start(who, common::route(&legs, speed, TICK))
            .unwrap();
        let (mut track, mut ended, mut moving) = (Vec::new(), None, false);
        // Per tick: whether it moved under a tenth of its speed, and whether the controller carried it across a link
        // (a door, a stair, a bridge deck's step: it stands at the near end, then is carried).
        let (mut slowly, mut carried) = (Vec::new(), Vec::new());
        let mut last = [body.pose.position.x, body.pose.position.z];
        let slow = speed * TICK / 1_000_000 / 10;
        let start = self.runner.now;
        for _ in 0..most {
            self.runner
                .tick(&mut self.town)
                .unwrap_or_else(|e| panic!("refused: {}: {}", e.name, e.detail));
            assert!(self.runner.refused.is_empty(), "{:?}", self.runner.refused);
            ended = self.runner.ended.get(&who).map(|(_, p)| format!("{p:?}"));
            let b = self.runner.controller.body(who).unwrap();
            let p = [b.pose.position.x, b.pose.position.z];
            let d = (i128::from(p[0] - last[0]).pow(2) + i128::from(p[1] - last[1]).pow(2)).isqrt()
                as i64;
            track.push(p);
            carried.push(self.runner.controller.carrying(who).is_some());
            slowly.push(moving && d < slow && ended.is_none());
            if ended.is_some() {
                break;
            }
            moving |= d > 0;
            last = p;
        }
        let length: i64 = track
            .windows(2)
            .map(|w| {
                (i128::from(w[1][0] - w[0][0]).pow(2) + i128::from(w[1][1] - w[0][1]).pow(2))
                    .isqrt() as i64
            })
            .sum();
        let time = (self.runner.now - start).max(1);
        let points: Vec<[i64; 2]> = pts.points.iter().map(|p| [p.x, p.z]).collect();
        // A slow tick next to a crossing is the crossing's: it stands at the near end, is carried, and its walk sees the
        // crossing end a tick later (T1) and steps off the tick after.
        let crossing =
            |k: usize| (k.saturating_sub(2)..=(k + 1).min(carried.len() - 1)).any(|j| carried[j]);
        let slowed: Vec<[i64; 2]> = (0..track.len())
            .filter(|&k| slowly[k] && !crossing(k))
            .map(|k| track[k])
            .collect();
        let stops = slowed
            .iter()
            .filter(|q| points.iter().any(|p| passed(&[**q], *p) <= NEAR))
            .count() as u32;
        Walked {
            ended: ended.unwrap_or_else(|| "still going".into()),
            legs: n,
            searches: pts.searches,
            dropped: pts.dropped,
            track,
            speed,
            made_good: i64::try_from(i128::from(length) * 1_000_000 / i128::from(time)).unwrap(),
            stops,
            slow: slowed.len() as u32,
            points,
        }
    }
}

/// The least distance from the track to `p`, µm.
fn passed(track: &[[i64; 2]], p: [i64; 2]) -> i64 {
    track
        .iter()
        .map(|q| (i128::from(q[0] - p[0]).pow(2) + i128::from(q[1] - p[1]).pow(2)).isqrt() as i64)
        .min()
        .unwrap_or(i64::MAX)
}

fn report(what: &str, w: &Walked) {
    println!(
        "{what}: {} after {} ticks; {} legs, {} points ({} dropped), {} route searches; sent at {} mm/s, made good {} mm/s; {} stops at its points ({} slow ticks in all)",
        w.ended,
        w.track.len(),
        w.legs,
        w.points.len(),
        w.dropped,
        w.searches,
        w.speed / 1000,
        w.made_good / 1000,
        w.stops,
        w.slow
    );
}

/// A1: a manner is set by an act, kept on the body until changed, read by every later walk, and recorded as a fact.
#[test]
fn a1_a_manner_is_kept_applied_and_recorded() {
    let (t, ground) = test_town();
    let mut w = World1::new(t, ground);
    let me = id(1);
    w.put(me, [-40_000_000, 30_000_000]);
    w.manner(me, "tiptoe");
    let a = w.walk(
        me,
        &Way {
            shape: Shape::Direct,
        },
        Some([-30_000_000, 30_000_000]),
        400,
    );
    report("tiptoe, east", &a);
    let b = w.walk(
        me,
        &Way {
            shape: Shape::Direct,
        },
        Some([-40_000_000, 30_000_000]),
        400,
    );
    report("tiptoe, back west", &b);
    assert_eq!((a.ended.as_str(), b.ended.as_str()), ("Done", "Done"));
    assert_eq!(
        manner(w.fields(me)).map(Name::as_str),
        Some("tiptoe"),
        "kept until changed"
    );
    // Tiptoe is no gait: the word is kept and the body walks; it goes where any walker goes.
    assert_eq!((a.speed, b.speed), (WALK.speed, WALK.speed));
    w.manner(me, "jog");
    let c = w.walk(
        me,
        &Way {
            shape: Shape::Direct,
        },
        Some([-30_000_000, 30_000_000]),
        400,
    );
    report("jog, east", &c);
    assert_eq!(c.ended, "Done");
    assert_eq!(c.speed, JOG.speed, "a gait of that name gives the speed");
    assert!(
        c.made_good > JOG.speed * 9 / 10,
        "made good {} µm/s",
        c.made_good
    );
    // Recorded as facts: two entries of the body's own node, each a change record of the log.
    let set: Vec<&Change> = w
        .facts
        .iter()
        .filter(|c| matches!(c, Change::Set { field, .. } if *field == F_MANNER))
        .collect();
    assert_eq!(set.len(), 2);
    for c in set {
        let rec = replica::effects::ChangeRec {
            change: c.clone(),
            rest: Default::default(),
        };
        println!(
            "fact: {}",
            replica::encode::to_hex(&encode(&rec.to_value()).unwrap())
        );
    }
}

/// A2: a walk passes eight places on its way without stopping, by one intent; a ninth is refused.
#[test]
fn a2_eight_via_places_without_stopping() {
    let (t, ground) = test_town();
    let mut w = World1::new(t, ground);
    let me = id(1);
    w.put(me, [-40_000_000, 30_000_000]);
    let via: Vec<[i64; 2]> = (0..8)
        .map(|k| {
            let x = -38_000_000 + (k % 4) * 2_500_000;
            let z = if (k / 4) % 2 == 0 {
                27_000_000
            } else {
                33_000_000
            };
            [x, z]
        })
        .collect();
    let way = Way {
        shape: Shape::Via(via.iter().map(|p| Stop::Point(*p)).collect()),
    };
    assert_eq!(
        Way::read(&way.to_params()).unwrap(),
        way,
        "the intent's fields read back"
    );
    let r = w.walk(me, &way, Some([-40_000_000, 30_000_000]), 2_000);
    report("eight via", &r);
    assert_eq!(r.ended, "Done");
    assert_eq!(r.points.len(), 8);
    assert_eq!(r.searches, 9, "one route search per place and the goal");
    for p in &r.points {
        assert!(
            passed(&r.track, *p) <= AT_GOAL,
            "passed ({}, {})",
            p[0],
            p[1]
        );
    }
    assert_eq!(r.stops, 0, "it never stops on its way");
    let mut nine = way.to_params();
    let mut list = match nine[&P_VIA].clone() {
        Value::Array(a) => a,
        _ => unreachable!(),
    };
    list.push(Stop::Point([0, 0]).to_value());
    nine.insert(P_VIA, Value::Array(list));
    let e = Way::read(&nine).unwrap_err();
    println!("nine via: {} ({})", e.name, e.detail);
    assert_eq!(e.name, "way-too-many-via");
    assert_eq!(VIA_MOST, 8);
}

/// A3: to and fro is one intent with a stated number of laps; laps out of range, or on a walk with no loop, are
/// refused by name.
#[test]
fn a3_to_and_fro_is_one_intent_with_laps() {
    let (t, ground) = test_town();
    let mut w = World1::new(t, ground);
    let me = id(1);
    w.put(me, [-40_000_000, 30_000_000]);
    let (a, b) = ([-39_000_000, 30_000_000], [-33_000_000, 30_000_000]);
    let way = Way {
        shape: Shape::Between {
            ends: [Stop::Point(a), Stop::Point(b)],
            laps: 3,
        },
    };
    let p = way.to_params();
    assert_eq!(Way::read(&p).unwrap(), way);
    let r = w.walk(me, &way, None, 2_000);
    report("to and fro, three laps", &r);
    assert_eq!(r.ended, "Done");
    assert_eq!(r.points.len(), 7, "a, then b and a for each lap");
    // Turns: the track's x changes direction once at each end.
    let turns = r
        .track
        .windows(3)
        .filter(|w| (w[1][0] - w[0][0]).signum() * (w[2][0] - w[1][0]).signum() < 0)
        .count();
    println!("turned {turns} times");
    assert_eq!(
        turns, 5,
        "at b three times and at a twice between: it ends at a"
    );
    assert_eq!(r.stops, 0);
    for (laps, why) in [(0, "way-laps"), (u64::from(LAPS_MOST) + 1, "way-laps")] {
        let mut q = p.clone();
        q.insert(P_LAPS, Value::Uint(laps));
        assert_eq!(Way::read(&q).unwrap_err().name, why);
    }
    let mut q = Way {
        shape: Shape::Via(vec![Stop::Point(a)]),
    }
    .to_params();
    q.insert(P_LAPS, Value::Uint(2));
    assert_eq!(Way::read(&q).unwrap_err().name, "way-laps-without-loop");
}

fn eden() -> (Town, BTreeMap<String, Id>) {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    let text = std::fs::read_to_string(path).expect("run the exporter first");
    common::town_of(
        import_eden::load(&text).expect("Eden loads"),
        b"souls/way-test/1",
    )
}

/// A place's outline or line as N1 stored it, µm.
fn shape(t: &Town, place: Id) -> Vec<[i64; 2]> {
    let h = t.tree.handle(place).unwrap();
    let node = t.tree.node(h).unwrap();
    let f = node.fields();
    let v = f
        .get(&sim::ground::scene::F_OUTLINE)
        .or_else(|| f.get(&sim::ground::scene::F_LINE))
        .unwrap();
    let Value::Array(a) = v else { panic!() };
    a.iter()
        .map(|p| {
            let Value::Array(q) = p else { panic!() };
            let n = |v: &Value| match v {
                Value::Uint(u) => *u as i64 * 1000,
                Value::Nint(n) => (-1 - *n as i64) * 1000,
                _ => panic!(),
            };
            [n(&q[0]), n(&q[1])]
        })
        .collect()
}

/// An SVG of the places and the walks, one metre a unit, x to the right and z down; the title is the file's own.
fn draw(
    file: &str,
    title: &str,
    view: [i64; 4],
    places: &[(Vec<[i64; 2]>, bool, &str)],
    walks: &[(&Walked, &str)],
) {
    let m = |v: i64| v as f64 / 1e6;
    let pts = |ps: &[[i64; 2]]| {
        ps.iter()
            .map(|p| format!("{:.2},{:.2}", m(p[0]), m(p[1])))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let [x0, z0, x1, z1] = view.map(|v| v / 1_000_000);
    let (w, h) = (x1 - x0, z1 - z0);
    let mut s = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"{x0} {z0} {w} {h}\" width=\"{}\" height=\"{}\">\n<title>{title}</title>\n<rect x=\"{x0}\" y=\"{z0}\" width=\"{w}\" height=\"{h}\" fill=\"#f4f1ea\"/>\n",
        w * 8,
        h * 8,
    );
    for (p, closed, colour) in places {
        let tag = if *closed { "polygon" } else { "polyline" };
        let fill = if *closed { colour } else { "none" };
        s += &format!(
            "<{tag} points=\"{}\" fill=\"{fill}\" fill-opacity=\"0.5\" stroke=\"{colour}\" stroke-width=\"0.4\"/>\n",
            pts(p)
        );
    }
    for (walked, colour) in walks {
        s += &format!(
            "<polyline points=\"{}\" fill=\"none\" stroke=\"{colour}\" stroke-width=\"0.25\"/>\n",
            pts(&walked.track)
        );
        for p in &walked.points {
            s += &format!(
                "<circle cx=\"{:.2}\" cy=\"{:.2}\" r=\"0.6\" fill=\"none\" stroke=\"{colour}\" stroke-width=\"0.15\"/>\n",
                m(p[0]),
                m(p[1])
            );
        }
    }
    s += "</svg>\n";
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../.local/e10");
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(format!("{dir}/{file}"), s).unwrap();
    println!("drew .local/e10/{file}");
}

/// A4: the six requests, one after another by one body in Eden, each one intent: skip instead of walking, tiptoe
/// everywhere, take the long way along the canal, go by both allotments on the way back, walk round the lake, pace
/// up and down the jetty. Each ends done, none stops on its way; the canal route and the lake's are drawn.
#[test]
#[ignore = "needs the exported Eden facts file"]
fn a4_eden_six() {
    let (t, nodes) = eden();
    let ground = nodes["ground"];
    let place = |k: &str| *nodes.get(k).unwrap_or_else(|| panic!("no place {k}"));
    let (quay, south, north) = (
        place("e_e74a3c98.footpath"),
        place("e_644ba178.bridge"),
        place("e_d3447286.bridge"),
    );
    let (beds_north, beds_south) = (place("e_220a2c6d.area"), place("e_f7567897.area"));
    let (canal, lake, jetty) = (
        place("e_46a89e0d.water"),
        place("e_f8e62e33.water"),
        place("e_7cfcac89.pier"),
    );
    let figures: Vec<(Vec<[i64; 2]>, bool, &str)> = vec![
        (shape(&t, canal), true, "#6fa8dc"),
        (shape(&t, quay), false, "#999999"),
        (shape(&t, south), false, "#8d6e63"),
        (shape(&t, north), false, "#8d6e63"),
        (shape(&t, beds_north), true, "#93c47d"),
        (shape(&t, beds_south), true, "#93c47d"),
    ];
    let lake_fig: Vec<(Vec<[i64; 2]>, bool, &str)> = vec![
        (shape(&t, lake), true, "#6fa8dc"),
        (shape(&t, jetty), false, "#8d6e63"),
    ];
    let jetty_line = shape(&t, jetty);
    let mut w = World1::new(t, ground);
    let me = id(1);
    let start = [126_000_000, -10_000_000];
    w.put(me, start);
    let direct = Way {
        shape: Shape::Direct,
    };
    let mut done = Vec::new();

    // 1. "Skip instead of walking today."
    w.manner(me, "skip");
    let r1 = w.walk(me, &direct, Some([126_000_000, 20_000_000]), 2_000);
    report("1 skip instead of walking", &r1);
    done.push(r1);
    // 2. "Tiptoe everywhere": the manner is kept for every walk after this one.
    w.manner(me, "tiptoe");
    let r2 = w.walk(me, &direct, Some([126_000_000, 26_000_000]), 2_000);
    report("2 tiptoe everywhere", &r2);
    done.push(r2);
    // 3. "Take the long way along the canal": along its west quay, from the end nearer to the other.
    let r3 = w.walk(
        me,
        &Way {
            shape: Shape::Along(quay),
        },
        None,
        4_000,
    );
    report("3 the long way along the canal", &r3);
    // 4. "Go by the allotments on the way back": via both beds by the canal, back to where it started.
    let r4 = w.walk(
        me,
        &Way {
            shape: Shape::Via(vec![Stop::Node(beds_north), Stop::Node(beds_south)]),
        },
        Some(start),
        4_000,
    );
    report("4 via both allotments, back", &r4);
    // And over both canal bridges and back: since #3226 a bridge's deck is walkable ground, so a via place on one
    // is on the bridge itself, and the walk crosses the canal.
    let bridges = w.walk(
        me,
        &Way {
            shape: Shape::Via(vec![Stop::Node(south), Stop::Node(north)]),
        },
        Some(start),
        4_000,
    );
    report("4b via both canal bridges, back", &bridges);
    let canal_x = (133_000_000, 140_000_000);
    for (k, p) in bridges.points.iter().enumerate() {
        println!(
            "  bridge point {}: ({}, {}) mm",
            k + 1,
            p[0] / 1000,
            p[1] / 1000
        );
        assert!(
            (canal_x.0..=canal_x.1).contains(&p[0]),
            "the via point is on the bridge, over the canal"
        );
        assert!(passed(&bridges.track, *p) <= AT_GOAL);
    }
    assert!(
        bridges.track.iter().any(|q| q[0] > canal_x.1),
        "it crosses to the canal's east side"
    );
    assert_eq!((bridges.ended.as_str(), bridges.stops), ("Done", 0));
    draw(
        "canal-route.svg",
        "E10: along the canal (blue), via both allotments and back (red), via both bridges and back (green)",
        [80_000_000, -45_000_000, 190_000_000, 65_000_000],
        &figures,
        &[(&r3, "#1c4587"), (&r4, "#cc0000"), (&bridges, "#38761d")],
    );
    done.push(r3);
    done.push(r4);
    // 5. "Walk round the lake": one lap, its outline moved outward onto dry ground.
    let r5 = w.walk(
        me,
        &Way {
            shape: Shape::Round {
                place: lake,
                laps: 1,
            },
        },
        None,
        12_000,
    );
    report("5 round the lake", &r5);
    // 6. "Pace up and down": the jetty, there and back three times.
    let (a, b) = (jetty_line[0], jetty_line[jetty_line.len() - 1]);
    let r6 = w.walk(
        me,
        &Way {
            shape: Shape::Between {
                ends: [
                    Stop::Point([a[0] - 1_000_000, a[1]]),
                    Stop::Point([b[0] + 1_000_000, b[1]]),
                ],
                laps: 3,
            },
        },
        None,
        4_000,
    );
    report("6 pace up and down the jetty", &r6);
    draw(
        "lake-round.svg",
        "E10: round the west lake (blue), pacing the jetty (red)",
        [-210_000_000, -70_000_000, -70_000_000, 70_000_000],
        &lake_fig,
        &[(&r5, "#1c4587"), (&r6, "#cc0000")],
    );
    done.push(r5);
    done.push(r6);
    for (k, r) in done.iter().enumerate() {
        assert_eq!(r.ended, "Done", "request {}", k + 1);
        assert_eq!(r.stops, 0, "request {} never stops on its way", k + 1);
        if k > 0 {
            assert_eq!(r.speed, WALK.speed, "tiptoe is kept: no gait, so a walk");
        }
    }
    assert_eq!(manner(w.fields(me)).map(Name::as_str), Some("tiptoe"));
    for p in &done[3].points {
        assert!(passed(&done[3].track, *p) <= AT_GOAL);
    }
    assert!(done[4].points.len() >= 8, "round the lake by its outline");
}
