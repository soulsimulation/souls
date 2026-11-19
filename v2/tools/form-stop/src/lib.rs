//! The stop table (Engine v2 F3, #2768): one body runs the first form of the first kind in the form runner's `kinds/`
//! folder whose effect binds (walk to its point, a move, a pause) on the controller, the due list and B2's moves, with every entry the
//! forms write appended to a log file. The undisturbed run gives the points: each step's first tick (its boundary) and
//! the tick in its middle. At each point the run is stopped three ways:
//!
//! - **leave**: the Soul leaves ([`sim::forms::Forms::leave`]), and the world runs on until the run has ended;
//! - **remove**: a creator removes the thing (a logged `remove`, then [`sim::forms::Forms::gone`]);
//! - **kill**: this program, run as a child, aborts its own process after the point's tick (no destructor, no
//!   flush); a second child restarts from the log file alone ([`sim::forms::Forms::recover`]) and reports.
//!
//! After each stop it reports how the run ended, whether its effect is in the log, whether anything is still held (a
//! run, a driver, a timer, a move) or reserved (a `souls:reserves` link the log leaves standing), whether the body is
//! in a legal posture (standing still on the ground, its input neutral) and what [`sim::forms::holders`] finds. No kind,
//! form or move is named here: they come from the folder and the fixtures.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::process::Command;

use body_script::{TICK, ground, ground_id, humanoid, place};
use replica::effects::{Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Part, Rest};
use replica::encode::{Name, Value, encode};
use replica::host::{Answer, Ask, Seen};
use replica::ids::{Id, Minter, SHA2_256, Scope};
use replica::moves::{Effector, Move};
use replica::pose::{Support, Vec3};
use replica::rules::json::{self, parse};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::{Audience, parse_kinds, parse_world};
use sim::controller::{Controller, Stance};
use sim::forms::{Forms, Intent, World, holders, reservations};
use sim::host::Geometry;
use sim::mover::Surface;
use sim::moves::{Moves, Reach, load};
use sim::timers::DueList;
use skills::form_runner::{self, Limits, Step, bind, bind_effects};

/// How far the body stands from the thing, mm: its walk takes a few seconds.
const AWAY: i64 = 3_000;
/// How long a stopped run is given to end, µs.
const SETTLE: Micros = 30_000_000;

fn name(s: &str) -> Name {
    Name::new(s).unwrap_or_else(|| unreachable!("a literal name"))
}

/// Bodies where the controller has them, the thing where it stands; every thing present is within reach.
#[derive(Default)]
struct Snap {
    nodes: BTreeMap<Id, Vec3>,
    thing: Option<(Id, Vec3)>,
}

impl Geometry for Snap {
    fn ask(&self, _: Id, q: &Ask) -> Option<Answer> {
        match q {
            Ask::Toward { to, .. } => Some(Answer::Point(*to)),
            Ask::Near { .. } => Some(Answer::Near(Vec::new())),
            Ask::Distance { .. } => None,
        }
    }
    fn read(&self, node: Id) -> Option<Seen> {
        let position = match self.thing {
            Some((t, p)) if t == node => p,
            _ => *self.nodes.get(&node)?,
        };
        Some(Seen {
            id: node,
            kind: name("form-stop:node"),
            parent: Some(ground_id()),
            position,
            fields: BTreeMap::new(),
        })
    }
}

impl Reach for Snap {
    fn distance(&self, _: Id, _: &Effector, _: Option<&Name>, t: Id, _: &Name) -> Option<i64> {
        self.thing.filter(|(id, _)| *id == t).map(|_| 0)
    }
}

/// The first kind in the runner's folder whose first form has an effect that binds (F2), with that form.
fn kind() -> (json::Value, String) {
    let dir =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/skills/src/form_runner/kinds");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .expect("the kinds folder")
        .map(|e| e.expect("an entry").path())
        .collect();
    files.sort();
    files
        .iter()
        .map(|f| {
            let v = parse(&std::fs::read_to_string(f).expect("read")).expect("JSON");
            let form = v
                .get("forms")
                .and_then(json::Value::obj)
                .and_then(|o| o.first())
                .map(|(k, _)| k.clone())
                .expect("a form");
            (v, form)
        })
        // Plain sets only: a `set ... by` (bound since C22) needs the kinds' amount fields, which this stage loads none of.
        .find(|(v, f)| {
            bind_effects(v, f).is_ok_and(|e| {
                !e.is_empty()
                    && e.iter()
                        .all(|x| matches!(x, form_runner::Effect::Set { .. }))
            })
        })
        .expect("a kind whose effects bind")
}

/// One world with one body and one thing, and the log of what the forms wrote.
pub struct Stage {
    tree: Tree,
    surfaces: BTreeMap<Id, Surface>,
    c: Controller,
    due: DueList,
    mint: Minter,
    moves: Moves,
    library: Vec<Move>,
    snap: Snap,
    forms: Forms,
    now: Micros,
    log: Vec<Effect>,
    sink: Option<File>,
    body: Id,
    thing: Id,
    intent: Intent,
    steps: Vec<Step>,
    effects: Vec<form_runner::Effect>,
}

impl Stage {
    /// The body standing [`AWAY`] from the thing, nothing started; entries are appended to `sink` when given.
    pub fn new(sink: Option<&Path>) -> Stage {
        let kinds = parse_kinds(include_str!(
            "../../../crates/replica/fixtures/world-model/kinds.diag"
        ))
        .expect("kinds");
        let draft = parse_world(
            &kinds,
            "{1: [], 2: {}, 3: [{1: 1, 2: \"souls:place\"}], 4: []}",
        )
        .expect("a world");
        let g = ground();
        let mut c = Controller::new();
        let mut mint = Minter::new(Scope([0xf3; 16]));
        let body = mint.mint().expect("an id");
        let thing = mint.mint().expect("an id");
        place(&mut c, &g, body, humanoid(), 0, AWAY).expect("placed");
        let (entry, form) = kind();
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crates/replica/fixtures/moves");
        let sink = sink.map(|p| {
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(p)
                .expect("the log file")
        });
        let mut s = Stage {
            tree: Tree::load(&draft).expect("loads").0,
            surfaces: BTreeMap::from([(ground_id(), g)]),
            c,
            due: DueList::new(),
            mint,
            moves: Moves::new(),
            library: load(&dir).expect("the fixture moves"),
            snap: Snap {
                thing: Some((thing, Vec3::ZERO)),
                ..Snap::default()
            },
            forms: Forms::new(),
            now: 0,
            log: Vec::new(),
            sink,
            body,
            thing,
            intent: Intent {
                id: Id::new(Scope([0xf3; 16]), 1 << 40).expect("an id"),
                expiry: i64::MAX,
                actor: Actor::Soul(body),
                digest: [0; 32],
            },
            steps: bind(&entry, &form).expect("binds"),
            effects: bind_effects(&entry, &form).unwrap_or_default(),
        };
        s.look();
        s
    }

    fn look(&mut self) {
        self.snap.nodes = self.c.bodies().map(|b| (b.id, b.pose.position)).collect();
    }

    fn world(&mut self) -> (World<'_, Snap, Snap>, &mut Forms) {
        (
            World {
                tree: &self.tree,
                geometry: &self.snap,
                reach: &self.snap,
                controller: &mut self.c,
                due: &mut self.due,
                mint: &mut self.mint,
                moves: &mut self.moves,
                library: &self.library,
                places: None,
                seed: 1,
            },
            &mut self.forms,
        )
    }

    /// The commit point: the forms' entries numbered, appended to the log (and its file) and handed back as logged.
    fn commit(&mut self, mut e: Effect) {
        e.envelope.sequence = self.log.len() as u64 + 1;
        self.forms.logged(&e);
        if let Some(f) = &mut self.sink {
            let part = Value::Map(BTreeMap::from([
                (1, Value::Bytes([vec![SHA2_256, 32], vec![0; 32]].concat())),
                (2, Value::Array(vec![e.to_value()])),
            ]));
            let bytes = encode(&part).expect("encodes");
            let len = u32::try_from(bytes.len()).expect("small");
            f.write_all(&[&len.to_le_bytes()[..], &bytes].concat())
                .expect("written");
        }
        self.log.push(e);
    }

    fn flush(&mut self) {
        for e in std::mem::take(&mut self.forms.out) {
            self.commit(e);
        }
    }

    /// Starts the form.
    pub fn start(&mut self) {
        let (steps, effects, intent) = (self.steps.clone(), self.effects.clone(), self.intent);
        let (body, thing, now) = (self.body, self.thing, self.now);
        let (mut w, forms) = self.world();
        forms
            .start(
                &mut w,
                body,
                thing,
                intent,
                steps,
                effects,
                Limits::default(),
                now,
            )
            .expect("started");
        self.flush();
    }

    /// One tick: the forms' walks, the controller's step, every timer due before the next tick, then the commit.
    pub fn tick(&mut self) {
        let (now, at) = (self.now, self.now + TICK);
        self.look();
        {
            let (mut w, forms) = self.world();
            forms.tick(&mut w, now);
        }
        let stepped = self.c.step(&self.surfaces, TICK, at);
        assert!(stepped.refused.is_empty(), "{:?}", stepped.refused);
        self.look();
        while let Some(t) = self.due.fire(at) {
            let (mut w, forms) = self.world();
            assert!(
                forms.fire(&mut w, &t),
                "every timer is a form's or a move's"
            );
        }
        self.now = at;
        self.flush();
    }

    /// The step in progress.
    pub fn at(&self) -> Option<usize> {
        self.forms.at(self.body)
    }

    /// The Soul leaves.
    pub fn leave(&mut self) {
        let (body, now) = (self.body, self.now);
        let (mut w, forms) = self.world();
        forms.leave(&mut w, body, now).expect("taken");
        self.flush();
    }

    /// A creator removes the thing: the removal is logged (with every link that ends in it), then the forms hear of it.
    pub fn remove(&mut self) {
        let (thing, now) = (self.thing, self.now);
        self.commit(Effect {
            envelope: Envelope {
                sequence: 0,
                at: now,
                cause: Cause::World,
                actor: Actor::Creator(replica::pose::fixture(9)),
                audience: Audience::Everyone,
                node: thing,
            },
            body: Body::Changes(vec![ChangeRec {
                change: Change::Remove { node: thing },
                rest: Rest::new(),
            }]),
            events: None,
            rest: Rest::new(),
        });
        self.snap.thing = None;
        let (mut w, forms) = self.world();
        forms.gone(&mut w, thing, now);
        self.flush();
    }

    /// The world runs on until no run is in progress, at most [`SETTLE`].
    pub fn settle(&mut self) {
        let end = self.now + SETTLE;
        while !self.forms.is_empty() && self.now < end {
            self.tick();
        }
    }

    /// A new process's world at `now`, from the log file alone: the same body and thing, and every run the log shows
    /// in progress ended `restart`, its ending appended to the file.
    pub fn restart(path: &Path, now: Micros) -> Stage {
        let log = read_log(path);
        let mut s = Stage::new(Some(path));
        s.now = now;
        s.forms = Forms::recover(&log, now);
        s.log = log;
        s.flush();
        s
    }

    /// What the stop left.
    pub fn report(&self) -> Report {
        let events = |n: &str| -> Vec<&replica::effects::Event> {
            self.log
                .iter()
                .flat_map(|e| e.events.iter().flatten())
                .filter(|v| v.name.as_str() == n)
                .collect()
        };
        let endings: Vec<String> = events("souls:form-ended")
            .iter()
            .map(|v| match v.fields.get(&3) {
                Some(Value::Bytes(n)) => String::from_utf8_lossy(n).into_owned(),
                _ => "(unnamed)".into(),
            })
            .collect();
        let started = events("souls:form-started").len();
        let mut held = Vec::new();
        if !self.forms.is_empty() {
            held.push(format!("{} run", self.forms.len()));
        }
        for b in self.c.bodies() {
            let n = self.c.claims(b.id).map_or(0, |c| c.running().len());
            if n > 0 {
                held.push(format!("{n} driver"));
            }
        }
        if !self.due.is_empty() {
            held.push(format!("{} timer", self.due.len()));
        }
        if !self.moves.is_empty() {
            held.push(format!("{} move", self.moves.len()));
        }
        let reserved =
            reservations(&self.log).len() + usize::from(self.forms.holder(self.thing).is_some());
        let posture = match (self.c.body(self.body), self.c.input(self.body)) {
            (Some(b), Some(i)) => {
                let still = i.velocity == Vec3::ZERO && i.moves.is_empty();
                let standing = i.stance == Stance::Stand
                    && matches!(b.pose.support, Support::Surface { height: 0, .. })
                    && b.pose.check().is_ok();
                match (still, standing) {
                    (true, true) => Ok(()),
                    _ => Err(format!("{:?} {:?}", i.stance, b.pose.support)),
                }
            }
            _ => Err("no body".into()),
        };
        Report {
            ending: match (started, endings.as_slice()) {
                (1, [one]) => Ok(one.clone()),
                _ => Err(format!("{started} started, ended {endings:?}")),
            },
            effect: events("souls:effect").len(),
            held,
            reserved,
            posture,
            orphans: holders(&self.forms, &self.c, &self.moves, &self.log).len(),
        }
    }
}

/// The entries of a log file, in order. A torn last frame (a write the kill cut) is not an entry.
pub fn read_log(path: &Path) -> Vec<Effect> {
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|mut f| f.read_to_end(&mut bytes))
        .expect("the log file");
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(len) = bytes.get(at..at + 4) {
        let len = u32::from_le_bytes(len.try_into().expect("four")) as usize;
        let Some(frame) = bytes.get(at + 4..at + 4 + len) else {
            break;
        };
        out.extend(Part::read(frame).expect("an entry").effects);
        at += 4 + len;
    }
    out
}

/// What a stop left.
pub struct Report {
    /// The run's one ending, by name.
    pub ending: Result<String, String>,
    /// The form's effects in the log.
    pub effect: usize,
    /// Runs, drivers, timers and moves still held.
    pub held: Vec<String>,
    /// Reservations still standing.
    pub reserved: usize,
    pub posture: Result<(), String>,
    /// What `holders` finds without a holder.
    pub orphans: usize,
}

impl Report {
    pub fn ok(&self) -> bool {
        self.ending.is_ok()
            && self.held.is_empty()
            && self.reserved == 0
            && self.posture.is_ok()
            && self.orphans == 0
    }

    /// The row's cells after the stop's own: ended, effect, held, reserved, posture, holders, verdict.
    pub fn cells(&self) -> Vec<String> {
        vec![
            match &self.ending {
                Ok(n) => format!("`{n}`"),
                Err(e) => e.clone(),
            },
            self.effect.to_string(),
            match self.held.as_slice() {
                [] => "nobody".into(),
                h => h.join(", "),
            },
            match self.reserved {
                0 => "nothing".into(),
                n => format!("{n} reservation"),
            },
            match &self.posture {
                Ok(()) => "standing, still".into(),
                Err(e) => e.clone(),
            },
            match self.orphans {
                0 => "every hold has a holder".into(),
                n => format!("{n} without a holder"),
            },
            if self.ok() { "pass" } else { "FAIL" }.into(),
        ]
    }
}

/// The stop points of the undisturbed run: (label, the tick after which it stops). Each step's first tick, and the
/// tick in its middle.
pub fn points() -> Vec<(String, u64)> {
    let mut s = Stage::new(None);
    s.start();
    let mut spans: BTreeMap<usize, (u64, u64)> = BTreeMap::new();
    let mut k = 0u64;
    while let Some(i) = s.at() {
        spans.entry(i).and_modify(|e| e.1 = k).or_insert((k, k));
        s.tick();
        k += 1;
    }
    let what = |i: usize| match s.steps[i] {
        Step::WalkTo { .. } => "walk",
        Step::Move { .. } | Step::Hand => "move",
        Step::Wait(_) => "pause",
        Step::Sit { .. } => "sit",
        Step::Rise => "rise",
        Step::Settle { .. } => "settle",
        Step::UseHeld => "use held",
    };
    spans
        .iter()
        .flat_map(|(&i, &(a, b))| {
            [
                (format!("step {i} ({}): its boundary", what(i)), a),
                (format!("step {i} ({}): its middle", what(i)), (a + b) / 2),
            ]
        })
        .collect()
}

/// Runs the form to tick `k` with entries in `path`, then stops it `way` (`leave` or `remove`) and lets the world run
/// on.
pub fn stop_in_process(way: &str, k: u64) -> Report {
    let mut s = Stage::new(None);
    s.start();
    for _ in 0..k {
        s.tick();
    }
    match way {
        "leave" => s.leave(),
        _ => s.remove(),
    }
    s.settle();
    s.report()
}

/// The child that is killed: runs the form to tick `k`, appending to `path`, then aborts its own process.
pub fn run_and_die(path: &Path, k: u64) -> ! {
    let mut s = Stage::new(Some(path));
    s.start();
    for _ in 0..k {
        s.tick();
    }
    std::process::abort()
}

/// The stop table, as Markdown, and whether every row passed. `exe` is this program, run as the killed child and as
/// the restarted one; `dir` holds the log files.
pub fn table(exe: &Path, dir: &Path) -> (String, bool) {
    std::fs::create_dir_all(dir).expect("the log folder");
    let mut out = String::from(
        "| way | stopped at | tick | ended | effects in log | held | reserved | posture | check | verdict |\n\
         |---|---|---|---|---|---|---|---|---|---|\n",
    );
    let mut all = true;
    for (label, k) in points() {
        for way in ["leave", "remove", "kill"] {
            let cells = if way == "kill" {
                let path = dir.join(format!("kill-{k}.log"));
                let _ = std::fs::remove_file(&path);
                let died = Command::new(exe)
                    .args(["die", &path.to_string_lossy(), &k.to_string()])
                    .status()
                    .expect("the child ran");
                assert!(!died.success(), "the child was killed, not finished");
                let now = (k as i64 + 1) * TICK;
                let restarted = Command::new(exe)
                    .args(["restart", &path.to_string_lossy(), &now.to_string()])
                    .output()
                    .expect("the restart ran");
                String::from_utf8_lossy(&restarted.stdout)
                    .trim()
                    .split('\t')
                    .map(str::to_owned)
                    .collect()
            } else {
                stop_in_process(way, k).cells()
            };
            all &= cells.last().is_some_and(|v| v == "pass");
            out += &format!("| {way} | {label} | {k} | {} |\n", cells.join(" | "));
        }
    }
    (out, all)
}
