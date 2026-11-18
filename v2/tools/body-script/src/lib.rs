//! The script driver (Engine v2 B1, #2680): drives bodies through `sim`'s controller from a text script, with no
//! skill code. Each body is claimed by a script driver (T9's claim on its locomotion), and every move it makes is the
//! controller stepping the mover. The script's format is at the top of `square.script`.
//!
//! A run's log is the controller's input records and the mover's motion samples, tick by tick, in T0's encoding; its
//! hash is SHA-256 over those bytes, so two runs of one script give one hash.

use std::collections::BTreeMap;

use replica::bodies::{Class, Family, Resource, SkillShape, Want};
use replica::encode::{Name, encode};
use replica::ids::{Id, sha256};
use replica::pose::{Frame, Mode, Quat, Vec3, fixture};
use replica::time::Micros;
use sim::controller::{Controller, Driver, Part};
use sim::ground::Piece;
use sim::mover::Surface;

/// The world's tick, µs.
pub const TICK: Micros = 50_000;
/// The open ground's node.
pub fn ground_id() -> Id {
    fixture(1)
}

fn name(s: &str) -> Name {
    Name::new(s).unwrap_or_else(|| unreachable!("a literal name"))
}

fn family(n: &str, rs: &[(&str, Class, Option<u64>)]) -> Family {
    Family {
        name: name(n),
        resources: rs
            .iter()
            .map(|&(r, class, slot)| Resource {
                name: name(r),
                class,
                slot,
            })
            .collect(),
    }
}

/// Two legs, two hands, eyes, a voice (T9's fixture `souls:humanoid`).
pub fn humanoid() -> Family {
    use Class::*;
    family(
        "souls:humanoid",
        &[
            ("souls:leg-left", Locomotion, None),
            ("souls:leg-right", Locomotion, None),
            ("souls:hand-left", Manipulator, Some(1)),
            ("souls:hand-right", Manipulator, Some(2)),
            ("souls:eyes", Gaze, None),
            ("souls:voice", Voice, None),
        ],
    )
}

/// Four legs, no hands, a head, a bark (T9's fixture `souls:quadruped`).
pub fn quadruped() -> Family {
    use Class::*;
    family(
        "souls:quadruped",
        &[
            ("souls:leg-front-left", Locomotion, None),
            ("souls:leg-front-right", Locomotion, None),
            ("souls:leg-back-left", Locomotion, None),
            ("souls:leg-back-right", Locomotion, None),
            ("souls:head", Gaze, None),
            ("souls:bark", Voice, None),
        ],
    )
}

/// A script driver's claim: all the body's locomotion; nothing cancels it.
pub fn script_shape() -> SkillShape {
    SkillShape {
        name: name("souls:script"),
        claims: vec![Want::All(Class::Locomotion)],
        blocks: vec![],
        cancelled_by: vec![],
    }
}

/// Flat open ground, 40 m square, centred on the origin, at height 0.
pub fn ground() -> Surface {
    let (a, b) = (-20_000, 20_000);
    let corners = vec![[a, 0, a], [b, 0, a], [b, 0, b], [a, 0, b]];
    Surface::new(
        ground_id(),
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
        }],
    )
}

/// A controller holding a body of `family` standing at (`x`, `z`) mm on [`ground`], with id `id`.
pub fn place(
    c: &mut Controller,
    ground: &Surface,
    id: Id,
    family: Family,
    x: i64,
    z: i64,
) -> Result<(), String> {
    let frame = Frame {
        node: ground_id(),
        slot: None,
    };
    let b = ground
        .place(id, frame, Vec3::new(x * 1000, 0, z * 1000), Quat::IDENTITY)
        .map_err(|r| format!("{}: {}", r.name, r.detail))?;
    c.add(family, b)
        .map_err(|r| format!("{}: {}", r.name, r.detail))
}

#[derive(Clone, Debug)]
enum Verb {
    Claim,
    Walk(i64, i64),
    Face(i64),
    Stop,
    Release,
}

/// A parsed script: its bodies (name, family, x mm, z mm), its events in order, and when it ends (ms).
pub struct Script {
    bodies: Vec<(String, Family, i64, i64)>,
    events: Vec<(i64, usize, Verb)>,
    end: i64,
}

/// Reads a script (format: `square.script`).
pub fn parse(text: &str) -> Result<Script, String> {
    let mut s = Script {
        bodies: Vec::new(),
        events: Vec::new(),
        end: 0,
    };
    for (i, line) in text.lines().enumerate() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let w: Vec<&str> = line.split_whitespace().collect();
        let bad = || format!("line {}: {line}", i + 1);
        let num = |k: usize| -> Result<i64, String> {
            w.get(k).and_then(|x| x.parse().ok()).ok_or_else(bad)
        };
        if w[0] == "body" {
            let fam = match w.get(2).copied() {
                Some("humanoid") => humanoid(),
                Some("quadruped") => quadruped(),
                _ => return Err(bad()),
            };
            s.bodies
                .push((w.get(1).ok_or_else(bad)?.to_string(), fam, num(3)?, num(4)?));
            continue;
        }
        let at = num(0)?;
        if w.get(1) == Some(&"end") {
            s.end = at;
            continue;
        }
        let who = s
            .bodies
            .iter()
            .position(|b| Some(&b.0.as_str()) == w.get(1))
            .ok_or_else(bad)?;
        let verb = match w.get(2).copied() {
            Some("claim") => Verb::Claim,
            Some("walk") => Verb::Walk(num(3)?, num(4)?),
            Some("face") => Verb::Face(num(3)?),
            Some("stop") => Verb::Stop,
            Some("release") => Verb::Release,
            _ => return Err(bad()),
        };
        s.events.push((at, who, verb));
    }
    Ok(s)
}

/// What one body did in a run.
#[derive(Debug)]
pub struct BodyReport {
    pub name: String,
    pub family: String,
    pub id: Id,
    /// When each of its input records was logged, µs.
    pub records: Vec<Micros>,
    pub record_bytes: usize,
    pub samples: usize,
    pub sample_bytes: usize,
    /// Time its input had a velocity, µs.
    pub walking: Micros,
    /// Where it stands at the end, µm.
    pub end: Vec3,
}

/// What a run came to.
#[derive(Debug)]
pub struct Report {
    /// SHA-256 of the log: each tick's new input records, then its motion samples.
    pub hash: [u8; 32],
    pub bodies: Vec<BodyReport>,
    /// Refusals, as `<ms> <body> <name>: <detail>`.
    pub refused: Vec<String>,
}

/// Runs a script: one tick every [`TICK`] from 0 until its end, each tick's events applied before the step.
pub fn run(script: &Script) -> Result<Report, String> {
    let ground = ground();
    let surfaces = BTreeMap::from([(ground_id(), ground)]);
    let ground = &surfaces[&ground_id()];
    let mut c = Controller::new();
    let mut reports = Vec::new();
    for (k, (n, fam, x, z)) in script.bodies.iter().enumerate() {
        let id = fixture(10 + k as u64);
        place(&mut c, ground, id, fam.clone(), *x, *z)?;
        reports.push(BodyReport {
            name: n.clone(),
            family: fam.name.as_str().to_string(),
            id,
            records: Vec::new(),
            record_bytes: 0,
            samples: 0,
            sample_bytes: 0,
            walking: 0,
            end: Vec3::ZERO,
        });
    }
    let mut drivers: BTreeMap<usize, Driver> = BTreeMap::new();
    let mut refused = Vec::new();
    let mut log = Vec::new();
    let mut next = 0;
    let mut logged = 0;
    let mut t: Micros = 0;
    while t <= script.end * 1000 {
        while let Some((at, who, verb)) = script.events.get(next).filter(|e| e.0 * 1000 <= t) {
            next += 1;
            let id = reports[*who].id;
            let d = drivers.get(who).copied().unwrap_or(0);
            let done = match *verb {
                Verb::Claim => c.claim(id, &script_shape()).map(|d| {
                    drivers.insert(*who, d);
                }),
                Verb::Walk(x, z) => c.set(
                    id,
                    d,
                    Part::Velocity(Vec3::new(x * 1000, 0, z * 1000), Mode::Surface),
                ),
                Verb::Face(m) => Quat::from_yaw_mdeg(m)
                    .map_err(|e| replica::effects::Refusal {
                        name: e.name(),
                        detail: format!("{m} mdeg"),
                    })
                    .and_then(|q| c.set(id, d, Part::Facing(q))),
                Verb::Stop => c.set(id, d, Part::Velocity(Vec3::ZERO, Mode::Surface)),
                Verb::Release => c.release(id, d),
            };
            if let Err(r) = done {
                refused.push(format!(
                    "{at} {} {}: {}",
                    reports[*who].name, r.name, r.detail
                ));
            }
        }
        for r in reports.iter_mut() {
            if c.input(r.id).is_some_and(|i| i.velocity != Vec3::ZERO) {
                r.walking += TICK;
            }
        }
        let stepped = c.step(&surfaces, TICK, t);
        for l in &c.log()[logged..] {
            log.extend_from_slice(&l.bytes);
            if let Some(r) = reports.iter_mut().find(|r| r.id == l.body) {
                r.records.push(l.at);
                r.record_bytes += l.bytes.len();
            }
        }
        logged = c.log().len();
        for h in &stepped.samples {
            let bytes = encode(&h.to_value()).map_err(|e| e.to_string())?;
            log.extend_from_slice(&bytes);
            if let Some(r) = reports.iter_mut().find(|r| r.id == h.node) {
                r.samples += 1;
                r.sample_bytes += bytes.len();
            }
        }
        for (id, r) in stepped.refused {
            refused.push(format!(
                "{} {}: {}: {}",
                t / 1000,
                replica::world_model::show(id),
                r.name,
                r.detail
            ));
        }
        t += TICK;
    }
    for r in reports.iter_mut() {
        r.end = c.body(r.id).map_or(Vec3::ZERO, |b| b.pose.position);
    }
    Ok(Report {
        hash: sha256(&log),
        bodies: reports,
        refused,
    })
}

/// A hash as hex.
pub fn hex(h: &[u8]) -> String {
    h.iter().map(|b| format!("{b:02x}")).collect()
}
