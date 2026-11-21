//! Engine v2 B16 (#2751): on N2's test world with short clocks, a Soul whose agent is silent wanders, becomes a
//! zombie, walks out by N7's walk to open ground outside the built area, lies down there and stays asleep, its body
//! on no due list; every move is the world's record. Its agent's next act wakes it on that tick and a walk it then asks
//! for runs. `cargo test --release -p worldd --test wind_down`.

use replica::effects::{Actor, Cause};
use replica::pose::{Support, Vec3};
use sim::controller::Stance;
use skills::wind_down::{self, Knobs, Word};
use worldd::bodies::{Ask, Asked, Bodies};
use worldd::testbodies;

const S: i64 = 1_000_000;
const TICK: i64 = 50_000;

const SHORT: Knobs = Knobs {
    wander: 10 * S,
    zombie: 20 * S,
    leg_min: 4 * S,
    leg_max: 6 * S,
    bound: 90 * S,
    ..wind_down::KNOBS
};

fn ground_xz(b: &Bodies) -> [i64; 2] {
    let (_, p) = b.pose(testbodies::body()).unwrap();
    [p.x, p.z]
}

/// Steps body time from `from` to `to`, a tick at a time: the record names written, in order.
fn run(b: &mut Bodies, from: i64, to: i64) -> Vec<String> {
    let mut names = Vec::new();
    let mut now = from;
    while now <= to {
        b.step(now);
        for e in std::mem::take(&mut b.wind_log) {
            assert_eq!(
                (e.envelope.actor, e.envelope.cause),
                (Actor::World, Cause::World),
                "A3"
            );
            assert!(wind_down::read(&e).is_some());
            // It is a record the log takes: a part holding it reads back (every text in it a name).
            let part = replica::encode::Value::Map(std::collections::BTreeMap::from([
                (
                    1,
                    replica::encode::Value::Bytes(
                        replica::ids::Hash::of(replica::ids::Purpose::Fixture, b"b16").to_bytes(),
                    ),
                ),
                (2, replica::encode::Value::Array(vec![e.to_value()])),
            ]));
            let bytes = replica::encode::encode(&part).unwrap();
            assert!(
                replica::effects::Part::read(&bytes).is_ok(),
                "{:?}",
                replica::effects::Part::read(&bytes).err()
            );
            names.extend(
                e.events
                    .unwrap()
                    .into_iter()
                    .map(|v| v.name.as_str().to_owned()),
            );
        }
        now += TICK;
    }
    names
}

#[test]
fn b16_a_silent_soul_walks_out_sleeps_and_wakes_on_its_agents_act() {
    let mut b = testbodies::bodies().unwrap();
    let soul = testbodies::body();
    b.wind.set_knobs(SHORT, 0);
    let from = ground_xz(&b);

    // A1, A3: idle (and its legs), zombie, asleep, each the world's record, in that order.
    let names = run(&mut b, 0, 120 * S);
    let mut words = names.clone();
    words.dedup();
    assert_eq!(
        words,
        ["souls:idle", "souls:zombie", "souls:asleep"],
        "{names:?}"
    );
    assert!(
        names.iter().filter(|n| *n == "souls:idle").count() > 1,
        "legs: {names:?}"
    );
    assert_eq!(b.wind.word(soul), Some(Word::Asleep));
    // It lies where it walked to: its spot, out of the square and farther out than it began.
    let at = ground_xz(&b);
    let s = *b.wind.state(soul).unwrap();
    let spot = s.spot.unwrap();
    let apart = |a: [i64; 2], c: [i64; 2]| ((a[0] - c[0]) as f64).hypot((a[1] - c[1]) as f64);
    assert!(
        apart(at, spot) < 1_000_000.0,
        "lies at its spot: {at:?} {spot:?}"
    );
    assert!(
        apart(at, from) > 5_000_000.0,
        "walked out: {from:?} -> {at:?}"
    );
    let placed = b.placed();
    let (pose, stance) = placed[&soul];
    assert!(
        matches!(pose.support, Support::Surface { .. }),
        "on the open ground"
    );
    assert_eq!(stance, Some(Stance::Lie), "lying");

    // A5: BUILDSAFE judges the sleeping body as it judges any body standing on the open ground (the edit checker's
    // hand-off, `buildsafe::moving`): an edit that would cover its spot is refused `edit.would-bury`, never left over it.
    let judged: Vec<_> = worldd::buildsafe::moving(&b)
        .into_iter()
        .filter(|w| w.body == soul)
        .collect();
    assert_eq!(judged.len(), 1, "judged once, not walking");
    assert_eq!(judged[0].pose, pose);
    assert!(matches!(
        judged[0].pose.support,
        Support::Surface { height: 0, .. }
    ));

    // A4: asleep, it is on no due list, and a long while issues nothing.
    assert_eq!(b.wind.next(), None);
    assert!(run(&mut b, 120 * S + TICK, 400 * S).is_empty());
    assert_eq!(ground_xz(&b), at);

    // A2: its agent's act wakes it on that tick; a walk it asks for then runs.
    let now = 400 * S + TICK;
    b.agent_acted(soul, now);
    assert_eq!(b.wind.word(soul), Some(Word::Awake));
    let woke: Vec<String> = std::mem::take(&mut b.wind_log)
        .into_iter()
        .flat_map(|e| e.events.unwrap())
        .map(|v| v.name.as_str().to_owned())
        .collect();
    assert_eq!(woke, ["souls:awake"]);
    assert_eq!(b.placed()[&soul].1, None, "standing again");
    let walk = Asked {
        body: soul,
        actor: Actor::Soul(soul),
        ask: Ask::Walk {
            node: pose.frame.node,
            point: Some(Vec3::new(at[0] + 3_000_000, 0, at[1])),
        },
        fallbacks: Vec::new(),
    };
    let intent = replica::ids::Id::new(replica::ids::Scope([0x77; 16]), 1).unwrap();
    let started = b.start(vec![(intent, walk)]);
    assert!(started.iter().all(|(_, r)| r.is_ok()), "{started:?}");
    let mut done = None;
    let mut t = now;
    while done.is_none() && t < now + 30 * S {
        t += TICK;
        done = b
            .step(t)
            .into_iter()
            .find(|(id, _)| *id == intent)
            .map(|(_, r)| r);
    }
    assert_eq!(done, Some(Ok(())), "the agent's walk ran");
    assert!(apart(ground_xz(&b), [at[0] + 3_000_000, at[1]]) < 500_000.0);
}

/// #3791 A1: the walk out goes at today's shuffle, half the walking pace, by the same walk as any (no jump): its
/// fastest tick while it walks is the shuffle's step, never the walk's.
#[test]
fn b16_the_walk_out_is_todays_shuffle() {
    let mut b = testbodies::bodies().unwrap();
    b.wind.set_knobs(SHORT, 0);
    let shuffle = wind_down::shuffle(worldd::bodies::WALK);
    assert_eq!(shuffle, worldd::bodies::WALK / 2);
    let step = shuffle * TICK / S;
    let mut now = 0;
    let mut out = false;
    let mut moved = Vec::new();
    while now <= 120 * S && moved.len() < 60 {
        let before = ground_xz(&b);
        b.step(now);
        out |= std::mem::take(&mut b.wind_log).iter().any(|e| {
            e.events
                .as_ref()
                .is_some_and(|v| v.iter().any(|v| v.name.as_str() == "souls:zombie"))
        });
        if out {
            let after = ground_xz(&b);
            moved.push(((after[0] - before[0]) as f64).hypot((after[1] - before[1]) as f64));
        }
        now += TICK;
    }
    assert_eq!(moved.len(), 60, "it walked out");
    let fastest = moved.iter().copied().fold(0.0, f64::max);
    assert!(
        fastest <= step as f64 * 1.05,
        "never faster than the shuffle: {fastest} > {step}"
    );
    assert!(
        fastest >= step as f64 * 0.8,
        "it shuffles, not stands: {fastest} vs {step}"
    );
}

// --- Served on Eden ------------------------------------------------------------------------------------------------

// A served run waits on the real clock for the world it serves (as `tests/serve.rs`).
#[allow(clippy::disallowed_methods)]
mod served {
    use std::collections::BTreeMap;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::UnixStream;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    use replica::effects::{Actor, Cause, Part};
    use replica::encode::{Name, Value, decode, encode};
    use replica::ids::{Id, Scope, Version};
    use replica::intents::{Intent, Target};
    use worldd::answers::{self, JOIN};

    /// The world's end of the gateway's socket, as one Soul (as `tests/eden.rs`).
    struct Client(UnixStream, Id, u64, Scope);

    impl Client {
        fn act(
            &mut self,
            verb: &str,
            target: Option<Id>,
            parameters: BTreeMap<u64, Value>,
        ) -> Result<Vec<u64>, String> {
            self.send(verb, target, parameters, false)
        }

        /// An intent; `reflex`: marked as its client's reflex (#3764), not its agent's.
        fn send(
            &mut self,
            verb: &str,
            target: Option<Id>,
            parameters: BTreeMap<u64, Value>,
            reflex: bool,
        ) -> Result<Vec<u64>, String> {
            self.2 += 1;
            let i = Intent {
                actor: Actor::Soul(self.1),
                verb: Name::new(verb).unwrap(),
                target: target.map(Target::Node),
                parameters,
                sequence: self.2,
                basis: Version {
                    lineage: self.3,
                    zone: Id::new(self.3, 0).unwrap(),
                    epoch: 1,
                    sequence: 0,
                }
                .to_value(),
                expiry: answers::now() + 120_000_000,
                resources: Vec::new(),
                fallbacks: Vec::new(),
                replaces: None,
                body: None,
                reflex,
            };
            let bytes = encode(&i.to_value()).unwrap();
            self.0
                .write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
                .unwrap();
            self.0.write_all(&bytes).unwrap();
            let a = loop {
                let mut len = [0u8; 4];
                self.0.read_exact(&mut len).expect("an answer");
                let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
                self.0.read_exact(&mut frame).unwrap();
                let Value::Map(mut m) = decode(&frame).unwrap().value else {
                    panic!("a frame")
                };
                let Some(Value::Map(a)) = m.remove(&2) else {
                    panic!("an answer")
                };
                if !matches!(
                    (a.get(&3), a.get(&answers::LEFT)),
                    (Some(Value::Uint(3)), Some(_))
                ) {
                    break a;
                }
            };
            match (a.get(&3), a.get(&5), a.get(&4)) {
                (Some(Value::Uint(1)), Some(Value::Array(e)), _) => Ok(e
                    .iter()
                    .map(|v| if let Value::Uint(n) = v { *n } else { 0 })
                    .collect()),
                (Some(Value::Uint(2)), _, Some(Value::Text(t))) => Err(t.as_str().to_owned()),
                other => panic!("an answer: {other:?}"),
            }
        }
    }

    struct Served(Child);

    impl Drop for Served {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn connect(dir: &Path, seq: u64, lineage: Scope) -> Client {
        let s = UnixStream::connect(dir.join("gateway.sock")).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(90))).unwrap();
        Client(s, Id::new(Scope([0xc1; 16]), 1).unwrap(), seq, lineage)
    }

    /// One logged thing: world time µs and what. Bodies' rows: `(at, body, frame node, x, z, lying)`.
    #[derive(Debug)]
    enum Seen {
        Row(i64, Id, Id, i64, i64, bool),
        Record(i64, Id, String, Actor, Cause),
    }

    fn read_log(dir: &Path) -> Vec<Seen> {
        let bytes = std::fs::read(dir.join("log")).unwrap();
        let mut out = Vec::new();
        for r in sim::log::recover(&bytes).unwrap().records {
            if sim::recorder::is_input(&r) {
                continue;
            }
            let Ok(p) = Part::read(&r) else { continue };
            // The tick's number (50 ms ticks): its body rows' time.
            let at = match p.rest.get(&answers::TICK) {
                Some(Value::Uint(t)) => i64::try_from(*t).unwrap_or(0) * 50_000,
                _ => p.effects.first().map_or(0, |e| e.envelope.at),
            };
            for e in &p.effects {
                for ev in e.events.iter().flatten() {
                    let n = ev.name.as_str();
                    if skills::wind_down::EVENTS.contains(&n) {
                        out.push(Seen::Record(
                            e.envelope.at,
                            e.envelope.node,
                            n.to_owned(),
                            e.envelope.actor,
                            e.envelope.cause,
                        ));
                    }
                }
            }
            if let Some(Value::Array(rows)) = p.rest.get(&answers::BODIES) {
                for (id, pose, st) in rows.iter().filter_map(worldd::bodies::read_row) {
                    let lying = st == Some(sim::controller::Stance::Lie);
                    out.push(Seen::Row(
                        at,
                        id,
                        pose.frame.node,
                        pose.position.x,
                        pose.position.z,
                        lying,
                    ));
                }
            }
        }
        out
    }

    /// B16 on a served Eden (`worldd seed` from Eden's facts, `worldd serve` with the wind-down's clocks shortened to
    /// wander 20 s, zombie 30 s later, legs every 4 to 8 s, asleep at the latest 150 s after wander began): a Soul joins
    /// and walks, then its agent goes (the socket is closed). The world winds it down: idle, zombie, a walk out to open
    /// ground, asleep, each the world's record. Its agent comes back and walks: the world writes it awake, and the walk
    /// runs. `EDEN_FACTS=<facts> cargo test --release -p worldd --test wind_down -- --ignored --nocapture`.
    #[test]
    #[ignore = "needs the generated Eden 2026 facts file and a built worldd"]
    fn b16_served_eden_winds_down_a_soul_whose_agent_went_and_wakes_it_on_return() {
        let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
        let dir: PathBuf = std::env::temp_dir().join(format!("b16-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // `B16_TESTWORLD=1`: N2's test world instead of Eden, its Soul born west of the square.
        let test_world = std::env::var("B16_TESTWORLD").is_ok();
        let (facts, entries, at) = if test_world {
            let f = std::env::temp_dir().join(format!("b16-facts-{}.json", std::process::id()));
            std::fs::write(&f, testworld::generate(1, 0).expect("the test world").text).unwrap();
            (
                f.display().to_string(),
                format!("{root}/content/kinds/doors"),
                "-40,30".to_owned(),
            )
        } else {
            (
                std::env::var("EDEN_FACTS")
                    .unwrap_or_else(|_| format!("{root}/.local/import-eden/eden-2026.facts.json")),
                format!("{root}/content/kinds"),
                std::env::var("B16_AT").unwrap_or_else(|_| "67.5,-12".to_owned()),
            )
        };
        let worldd = env!("CARGO_BIN_EXE_worldd");
        let seeded = Command::new(worldd)
            .args(["seed", "--facts", &facts, "--dir"])
            .arg(&dir)
            .args(["--entries", &entries, "--souls", "0", "--at", &at])
            .output()
            .unwrap();
        assert!(
            seeded.status.success(),
            "{}",
            String::from_utf8_lossy(&seeded.stderr)
        );
        let mut child = Command::new(worldd)
            .args(["serve", "--dir"])
            .arg(&dir)
            .env("WORLDD_WIND_DOWN", "20,30,4,8,150")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut out = BufReader::new(child.stdout.take().unwrap());
        let _served = Served(child);
        let mut line = String::new();
        while out.read_line(&mut line).unwrap() > 0 && !line.contains("listening ") {
            line.clear();
        }
        let lineage = Scope([0xd1; 16]);
        let t0 = Instant::now();
        let say = |what: &str| eprintln!("[{:6.1} s] {what}", t0.elapsed().as_secs_f64());

        // The agent: joins, walks 3 m east, then goes.
        say("serving");
        let mut soul = connect(&dir, 0, lineage);
        soul.act(JOIN, None, BTreeMap::new()).expect("born");
        std::thread::sleep(Duration::from_millis(500));
        let (body, ground, x0, z0) = read_log(&dir)
            .into_iter()
            .find_map(|s| match s {
                Seen::Row(_, b, g, x, z, _) => Some((b, g, x, z)),
                _ => None,
            })
            .expect("a body row");
        let point = |x: i64, z: i64| {
            BTreeMap::from([(1, Value::Array(vec![int(x), Value::Uint(0), int(z)]))])
        };
        soul.act("eden:walk", Some(ground), point(x0 + 3_000_000, z0))
            .expect("the agent's walk");
        say(&format!(
            "agent walked 3 m from ({:.1}, {:.1}) m; the agent goes",
            x0 as f64 / 1e6,
            z0 as f64 / 1e6
        ));
        let seq = soul.2;
        drop(soul);

        // The world winds it down.
        let deadline = Instant::now() + Duration::from_secs(260);
        let mut shown = 0;
        loop {
            let log = read_log(&dir);
            let recs: Vec<&Seen> = log
                .iter()
                .filter(|s| matches!(s, Seen::Record(..)))
                .collect();
            for s in &recs[shown..] {
                if let Seen::Record(t, _, n, a, c) = s {
                    say(&format!(
                        "record {n} at world {:.1} s, actor {a:?}, cause {c:?}",
                        *t as f64 / 1e6
                    ));
                }
            }
            shown = recs.len();
            if recs
                .iter()
                .any(|s| matches!(s, Seen::Record(_, _, n, ..) if n == "souls:asleep"))
            {
                break;
            }
            assert!(Instant::now() < deadline, "not asleep in time");
            std::thread::sleep(Duration::from_secs(2));
        }
        std::thread::sleep(Duration::from_secs(3));
        let log = read_log(&dir);
        let rows: Vec<(i64, i64, i64, Id, bool)> = log
            .iter()
            .filter_map(|s| match s {
                Seen::Row(t, b, g, x, z, l) if *b == body => Some((*t, *x, *z, *g, *l)),
                _ => None,
            })
            .collect();
        let words: Vec<&str> = log
            .iter()
            .filter_map(|s| match s {
                Seen::Record(_, b, n, a, c) if *b == body => {
                    assert_eq!((*a, *c), (Actor::World, Cause::World), "A3");
                    Some(n.as_str())
                }
                _ => None,
            })
            .collect();
        let mut seq_words = words.clone();
        seq_words.dedup();
        assert_eq!(seq_words, ["souls:idle", "souls:zombie", "souls:asleep"]);
        let first = rows.first().unwrap();
        let last = *rows.last().unwrap();
        say(&format!(
            "track: {} rows; ({:.1}, {:.1}) m -> ({:.1}, {:.1}) m on {}, lying {}",
            rows.len(),
            first.1 as f64 / 1e6,
            first.2 as f64 / 1e6,
            last.1 as f64 / 1e6,
            last.2 as f64 / 1e6,
            if last.3 == ground {
                "the open ground"
            } else {
                "another node"
            },
            last.4
        ));
        for r in rows.iter().step_by((rows.len() / 25).max(1)) {
            say(&format!(
                "  world {:7.1} s  ({:7.2}, {:7.2}) m  lying {}",
                r.0 as f64 / 1e6,
                r.1 as f64 / 1e6,
                r.2 as f64 / 1e6,
                r.4
            ));
        }
        assert_eq!(last.3, ground, "asleep on the open ground");
        assert!(last.4, "lying");
        // Every step of the way was a walk's: no row jumps more than a walk could go between ticks (no teleport).
        for w in rows.windows(2) {
            let (dt, d) = (
                w[1].0 - w[0].0,
                ((w[1].1 - w[0].1) as f64).hypot((w[1].2 - w[0].2) as f64),
            );
            assert!(
                d <= 2.0 * 1.4 * dt.max(50_000) as f64 + 50_000.0,
                "a jump of {d} µm in {dt} µs"
            );
        }
        // A4: asleep, it writes no row and no record for 10 s.
        let before = read_log(&dir).len();
        std::thread::sleep(Duration::from_secs(10));
        assert_eq!(read_log(&dir).len(), before, "asleep: nothing written");
        say("asleep 10 s: nothing written");

        // A reflex its client sends (#3764) runs, and leaves it asleep.
        let mut soul = connect(&dir, seq, lineage);
        let said = soul.send(
            "eden:say",
            None,
            BTreeMap::from([(
                1,
                Value::Map([(worldd::words::WORDS, Value::Bytes(b"zzz".to_vec()))].into()),
            )]),
            true,
        );
        say(&format!("a reflex says a line: {said:?}"));
        std::thread::sleep(Duration::from_secs(2));
        let log = read_log(&dir);
        let awake = |log: &[Seen]| {
            log.iter()
                .any(|s| matches!(s, Seen::Record(_, b, n, ..) if *b == body && n == "souls:awake"))
        };
        assert!(!awake(&log), "a reflex does not wake it");
        let still = log.iter().rev().find_map(|s| match s {
            Seen::Row(_, b, _, x, z, l) if *b == body => Some((*x, *z, *l)),
            _ => None,
        });
        assert_eq!(
            still,
            Some((last.1, last.2, true)),
            "still lying where it slept"
        );
        say("after the reflex: still asleep, not written awake");

        // A2: the agent comes back and walks: the world writes it awake, then the walk runs.
        let walked = soul.act("eden:walk", Some(ground), point(last.1 - 2_000_000, last.2));
        say(&format!("agent back, walks 2 m: {walked:?}"));
        walked.expect("the agent's walk runs");
        let log = read_log(&dir);
        assert!(awake(&log), "written awake");
        let after = log
            .iter()
            .rev()
            .find_map(|s| match s {
                Seen::Row(_, b, _, x, z, l) if *b == body => Some((*x, *z, *l)),
                _ => None,
            })
            .unwrap();
        say(&format!(
            "now at ({:.2}, {:.2}) m, lying {}",
            after.0 as f64 / 1e6,
            after.1 as f64 / 1e6,
            after.2
        ));
        assert!(!after.2);
        assert!(
            ((after.0 - (last.1 - 2_000_000)) as f64).hypot((after.1 - last.2) as f64) < 600_000.0
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn int(n: i64) -> Value {
        match u64::try_from(n) {
            Ok(u) => Value::Uint(u),
            Err(_) => Value::Nint(n.unsigned_abs() - 1),
        }
    }
}
