//! The run gate's world on Engine v2 (#3314): `tools/entry/run.mjs --transport tools/entry/v2.mjs` drives this program
//! the way the `today` transport drives a local world, one JSON request a line on stdin and one answer a line on stdout.
//!
//! One body on open ground and the things the gate places, each beside the body. An act is what the new engine does
//! with a Soul's act: R2's rules decide it on the case's state with the things' fields as they stand (as I3's checkers
//! decide it, the world seeing all), then the form is committed to the form runner (F1: bound into steps, F2: its
//! effects bound, F6: who may), and the world ticks until the run ends with its name. Its effects are read back from
//! what the forms wrote to the log. Leaving, removing the thing and restarting are the forms' own (F3): a restart drops
//! the controller, the due list and the moves, and recovers the forms from the log alone, as a new process does.
//!
//! Not here: a world's tree (who may reads none, so only a form anyone may do is let through), a geometry beyond open
//! ground (every point is reached in a straight line and every thing is within reach of a move, as in F3's stop
//! table), and the gateway (F7). The moves are content's, every `content/moves` entry loaded at world start by hash
//! (F13, #3383). No kind, form or move is named.

use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::Path;

use body_script::{TICK, ground, ground_id, humanoid, place};
use replica::effects::{Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Rest};
use replica::encode::{Name, Value as Cbor};
use replica::host::{Answer, Ask, Seen};
use replica::ids::{Id, Minter, Scope};
use replica::moves::{Effector, Move};
use replica::pose::{Vec3, fixture};
use replica::rules::decide_parts;
use replica::rules::json::{Value as J, parse};
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::{Audience, parse_kinds, parse_world};
use sim::controller::Controller;
use sim::forms::{Asked, Forms, Intent, World};
use sim::host::Geometry;
use sim::mover::Surface;
use sim::moves::{Moves, Reach, library};
use sim::timers::DueList;
use skills::form_runner::Limits;

/// How far from the body a thing is placed, µm: the body walks to it as the form asks.
const AWAY: i64 = 3_000_000;
/// The longest a run is followed, µs of world time.
const LONGEST: Micros = 180_000_000;

fn name(s: &str) -> Name {
    Name::new(s).unwrap_or_else(|| unreachable!("a literal name"))
}

/// Bodies where the controller has them, things where they were placed; every thing is within reach.
#[derive(Default)]
struct Snap {
    nodes: BTreeMap<Id, Vec3>,
    things: BTreeMap<Id, Vec3>,
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
        let position = *self.things.get(&node).or_else(|| self.nodes.get(&node))?;
        Some(Seen {
            id: node,
            kind: name("entry:node"),
            parent: Some(ground_id()),
            position,
            fields: BTreeMap::new(),
        })
    }
}

impl Reach for Snap {
    fn distance(&self, _: Id, _: &Effector, _: Option<&Name>, t: Id, _: &Name) -> Option<i64> {
        self.things.contains_key(&t).then_some(0)
    }
}

struct Thing {
    id: Id,
    kind: String,
    fields: Vec<(String, J)>,
}

struct Run {
    intent: Id,
    last: Option<usize>,
}

struct Stage {
    kinds: J,
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
    body: Id,
    things: BTreeMap<String, Thing>,
    placed: u64,
    runs: BTreeMap<String, Run>,
}

fn obj(pairs: Vec<(&str, J)>) -> J {
    J::Obj(pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

fn err(why: impl Into<String>) -> J {
    obj(vec![("error", J::Str(why.into()))])
}

fn set_key(o: &mut Vec<(String, J)>, k: &str, v: J) {
    match o.iter_mut().find(|(x, _)| x == k) {
        Some((_, w)) => *w = v,
        None => o.push((k.to_owned(), v)),
    }
}

impl Stage {
    fn new() -> Stage {
        let kinds = parse_kinds(include_str!(
            "../../../../v2/crates/replica/fixtures/world-model/kinds.diag"
        ))
        .expect("kinds");
        let draft = parse_world(
            &kinds,
            "{1: [], 2: {}, 3: [{1: 1, 2: \"souls:place\"}], 4: []}",
        )
        .expect("a world");
        let g = ground();
        let mut c = Controller::new();
        let mut mint = Minter::new(Scope([0xe2; 16]));
        let body = mint.mint().expect("an id");
        place(&mut c, &g, body, humanoid(), 0, 0).expect("placed");
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/moves");
        let (library, refused) = library(&dir).expect("content/moves");
        for r in refused {
            eprintln!("a move refused: {r}");
        }
        let mut s = Stage {
            kinds: J::Obj(Vec::new()),
            tree: Tree::load(&draft).expect("loads").0,
            surfaces: BTreeMap::from([(ground_id(), g)]),
            c,
            due: DueList::new(),
            mint,
            moves: Moves::new(),
            library: library.current(),
            snap: Snap::default(),
            forms: Forms::new(),
            now: 0,
            log: Vec::new(),
            body,
            things: BTreeMap::new(),
            placed: 0,
            runs: BTreeMap::new(),
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
                seed: 1,
            },
            &mut self.forms,
        )
    }

    fn entry(&self, kind: &str) -> Option<&J> {
        self.kinds.get(kind)
    }

    /// The commit point: an entry numbered, handed back to the forms as logged, its sets read into the things' fields.
    fn commit(&mut self, mut e: Effect) {
        e.envelope.sequence = self.log.len() as u64 + 1;
        self.forms.logged(&e);
        for rec in e.changes() {
            let Change::Set {
                node, field, to, ..
            } = &rec.change
            else {
                continue;
            };
            let Some(t) = self.things.values().find(|t| t.id == *node) else {
                continue;
            };
            let Some(state) = self
                .kinds
                .get(&t.kind)
                .and_then(|e| e.get("state"))
                .and_then(J::obj)
            else {
                continue;
            };
            let Some((fname, def)) = state
                .iter()
                .find(|(_, d)| matches!(d.get("n"), Some(J::Int(n)) if *n == i128::from(*field)))
            else {
                continue;
            };
            let v = match (def.get("type").and_then(J::str), to) {
                (Some("bool"), Cbor::Uint(u)) => J::Bool(*u != 0),
                (_, Cbor::Uint(u)) => J::Int(i128::from(*u)),
                (_, Cbor::Nint(n)) => J::Int(-1 - i128::from(*n)),
                _ => J::Null,
            };
            let fname = fname.clone();
            let key = self
                .things
                .iter()
                .find(|(_, t)| t.id == *node)
                .map(|(k, _)| k.clone());
            if let Some(t) = key.and_then(|k| self.things.get_mut(&k)) {
                set_key(&mut t.fields, &fname, v);
            }
        }
        self.log.push(e);
    }

    fn flush(&mut self) {
        for e in std::mem::take(&mut self.forms.out) {
            self.commit(e);
        }
    }

    /// One tick: the forms' walks, the controller's step, every timer due before the next tick, then the commit.
    fn tick(&mut self) {
        let (now, at) = (self.now, self.now + TICK);
        self.look();
        {
            let (mut w, forms) = self.world();
            forms.tick(&mut w, now);
        }
        let _ = self.c.step(&self.surfaces, TICK, at);
        self.look();
        while let Some(t) = self.due.fire(at) {
            let (mut w, forms) = self.world();
            forms.fire(&mut w, &t);
        }
        self.now = at;
        self.flush();
    }

    /// The name intent `id`'s run ended with, from the log.
    fn ended(&self, id: Id) -> Option<String> {
        self.log
            .iter()
            .filter(|e| e.envelope.cause == Cause::Intent(id))
            .flat_map(|e| e.events.iter().flatten())
            .filter(|v| v.name.as_str() == "souls:form-ended")
            .map(|v| match v.fields.get(&3) {
                Some(Cbor::Text(n)) => n.as_str().to_owned(),
                _ => "(unnamed)".into(),
            })
            .next()
    }

    fn body_at(&self) -> Vec3 {
        self.c
            .body(self.body)
            .map_or(Vec3::ZERO, |b| b.pose.position)
    }

    fn place(&mut self, kind: &str) -> J {
        let Some(entry) = self.entry(kind) else {
            return err(format!("{kind} is not defined"));
        };
        let fields: Vec<(String, J)> = entry
            .get("state")
            .and_then(J::obj)
            .unwrap_or(&[])
            .iter()
            .map(|(k, d)| (k.clone(), d.get("default").cloned().unwrap_or(J::Null)))
            .collect();
        let b = self.body_at();
        // Beside the body, toward the middle of the ground on its farther axis, so a long run of cases never walks
        // off it.
        let toward = |v: i64| if v > 0 { -AWAY } else { AWAY };
        let at = if b.x.abs() >= b.z.abs() {
            Vec3::new(b.x + toward(b.x), 0, b.z)
        } else {
            Vec3::new(b.x, 0, b.z + toward(b.z))
        };
        let Ok(id) = self.mint.mint() else {
            return err("no id");
        };
        self.placed += 1;
        let key = format!("x{}", self.placed);
        self.snap.things.insert(id, at);
        self.things.insert(
            key.clone(),
            Thing {
                id,
                kind: kind.to_owned(),
                fields,
            },
        );
        obj(vec![("id", J::Str(key))])
    }

    fn remove(&mut self, key: &str) -> J {
        let Some(t) = self.things.remove(key) else {
            return err(format!("no thing {key}"));
        };
        let now = self.now;
        self.commit(Effect {
            envelope: Envelope {
                sequence: 0,
                at: now,
                cause: Cause::World,
                actor: Actor::Creator(fixture(9)),
                audience: Audience::Everyone,
                node: t.id,
            },
            body: Body::Changes(vec![ChangeRec {
                change: Change::Remove { node: t.id },
                rest: Rest::new(),
            }]),
            events: None,
            rest: Rest::new(),
        });
        self.snap.things.remove(&t.id);
        let (mut w, forms) = self.world();
        forms.gone(&mut w, t.id, now);
        self.flush();
        obj(vec![])
    }

    /// The rules' state for the case: its own nodes, the placed ones' fields as they stand now.
    fn state_of(&self, case: &J, ids: &J) -> J {
        let mut state = case.get("state").cloned().unwrap_or(J::Obj(Vec::new()));
        if let J::Obj(top) = &mut state
            && let Some((_, J::Obj(nodes))) = top.iter_mut().find(|(k, _)| k == "nodes")
        {
            for (nid, key) in ids.obj().unwrap_or(&[]) {
                let Some(t) = key.str().and_then(|k| self.things.get(k)) else {
                    continue;
                };
                if let Some((_, J::Obj(n))) = nodes.iter_mut().find(|(k, _)| k == nid) {
                    set_key(n, "kind", J::Str(t.kind.clone()));
                    set_key(n, "fields", J::Obj(t.fields.clone()));
                }
            }
        }
        state
    }

    fn begin(&mut self, key: &str, case: &J, ids: &J) -> J {
        let Some(t) = self.things.get(key) else {
            return err(format!("no thing {key}"));
        };
        let (node, kind) = (t.id, t.kind.clone());
        let Some(act) = case.get("act") else {
            return err("the case has no act");
        };
        let form = act
            .get("form")
            .and_then(J::str)
            .unwrap_or_default()
            .to_owned();
        // The world's check at commit: R2's rules on the case's state, the world seeing all (I3).
        let state = self.state_of(case, ids);
        let asker = obj(vec![("sees", J::s("all"))]);
        let v = decide_parts(Some(&self.kinds), Some(act), Some(&state), Some(&asker));
        match v.get("verdict").and_then(J::str) {
            Some("yes") => {}
            Some("no") => {
                let reason = v.get("reason").cloned().unwrap_or(J::Null);
                return obj(vec![
                    ("verdict", J::s("no")),
                    ("reason", reason.clone()),
                    ("code", reason),
                    ("fix", v.get("fix").cloned().unwrap_or(J::Null)),
                    ("detail", v.get("detail").cloned().unwrap_or(J::Null)),
                    ("receipt", J::s("refused")),
                    ("by", J::s("rules")),
                ]);
            }
            _ => {
                return obj(vec![
                    ("verdict", J::s("no")),
                    ("reason", J::s("unknown")),
                    ("code", J::s("unknown")),
                    ("receipt", J::s("refused")),
                    ("by", J::s("rules")),
                ]);
            }
        }
        let entry = self.entry(&kind).cloned().unwrap_or(J::Null);
        let n = self.runs.len() as u64 + 1;
        let Some(id) = Id::new(Scope([0xe3; 16]), (1 << 40) + n) else {
            return err("no intent id");
        };
        let mut digest = [0u8; 32];
        digest[..8].copy_from_slice(&n.to_le_bytes());
        let intent = Intent {
            id,
            expiry: i64::MAX,
            actor: Actor::Soul(self.body),
            digest,
        };
        let (body, now) = (self.body, self.now);
        let asked = {
            let (mut w, forms) = self.world();
            forms.commit(
                &mut w,
                &BTreeMap::new(),
                &|_| None,
                body,
                node,
                &entry,
                &form,
                intent,
                Limits::default(),
                now,
            )
        };
        self.flush();
        match asked {
            Ok(Asked::Started(_) | Asked::Running(_)) => {
                let rid = format!("r{n}");
                let last = self.forms.at(body);
                self.runs.insert(rid.clone(), Run { intent: id, last });
                obj(vec![
                    ("verdict", J::s("started")),
                    ("rid", J::Str(rid.clone())),
                    ("progress", self.progress_of(&rid, false)),
                ])
            }
            Ok(Asked::Applied(_)) => err("a new intent was answered as applied"),
            Err(r) => obj(vec![
                ("verdict", J::s("no")),
                ("reason", J::s(r.name)),
                ("code", J::s(r.name)),
                ("detail", J::Str(r.detail)),
                ("receipt", J::s("refused")),
                ("by", J::s("runner")),
            ]),
        }
    }

    fn progress_of(&self, rid: &str, moving: bool) -> J {
        let Some(r) = self.runs.get(rid) else {
            return err(format!("no run {rid}"));
        };
        let step = |s: Option<usize>| s.map_or(J::Null, |s| J::Int(s as i128));
        match self.ended(r.intent) {
            Some(n) => obj(vec![
                (
                    "phase",
                    J::s(if n == "done" { "completed" } else { "failed" }),
                ),
                ("step", step(r.last)),
                ("moving", J::Bool(false)),
                ("ended", J::Str(n)),
            ]),
            None => obj(vec![
                ("phase", J::s("started")),
                ("step", step(r.last)),
                ("moving", J::Bool(moving)),
                ("now_us", J::Int(i128::from(self.now))),
            ]),
        }
    }

    /// One tick, then where the run is: `moving` once the step under way has had a tick.
    fn progress(&mut self, rid: &str) -> J {
        let Some(intent) = self.runs.get(rid).map(|r| r.intent) else {
            return err(format!("no run {rid}"));
        };
        if self.ended(intent).is_none() {
            self.tick();
        }
        let at = self.forms.at(self.body);
        let r = self.runs.get_mut(rid).expect("the run");
        let moving = at.is_some() && at == r.last;
        if at.is_some() {
            r.last = at;
        }
        self.progress_of(rid, moving)
    }

    fn wait(&mut self, rid: &str) -> J {
        let Some(intent) = self.runs.get(rid).map(|r| r.intent) else {
            return err(format!("no run {rid}"));
        };
        let end = self.now + LONGEST;
        while self.ended(intent).is_none() && self.now < end {
            self.tick();
        }
        match self.ended(intent) {
            Some(n) if n == "done" => obj(vec![
                ("verdict", J::s("yes")),
                ("receipt", J::s("completed")),
                ("ended", J::Str(n)),
                ("now_us", J::Int(i128::from(self.now))),
            ]),
            Some(n) => obj(vec![
                ("verdict", J::s("no")),
                ("reason", J::Str(n.clone())),
                ("code", J::Str(n.clone())),
                ("receipt", J::s("failed")),
                ("ended", J::Str(n)),
            ]),
            None => obj(vec![
                ("verdict", J::s("running")),
                ("receipt", J::s("started")),
            ]),
        }
    }

    fn leave(&mut self) -> J {
        let (body, now) = (self.body, self.now);
        let r = {
            let (mut w, forms) = self.world();
            forms.leave(&mut w, body, now)
        };
        self.flush();
        match r {
            Ok(()) => obj(vec![]),
            Err(r) => obj(vec![("refused", J::s(r.name))]),
        }
    }

    /// A new process's world: the body where it stood, no driver, timer or move, and the forms from the log alone.
    fn restart(&mut self) -> J {
        let b = self.body_at();
        let g = ground();
        let mut c = Controller::new();
        if let Err(e) = place(&mut c, &g, self.body, humanoid(), b.x / 1000, b.z / 1000) {
            return err(e);
        }
        self.c = c;
        self.surfaces = BTreeMap::from([(ground_id(), g)]);
        self.due = DueList::new();
        self.moves = Moves::new();
        self.forms = Forms::recover(&self.log, self.now);
        self.look();
        self.flush();
        obj(vec![])
    }

    fn handle(&mut self, q: &J) -> J {
        let s = |k: &str| q.get(k).and_then(J::str).unwrap_or_default().to_owned();
        let none = J::Obj(Vec::new());
        match s("op").as_str() {
            "define" => {
                self.kinds = q.get("kinds").cloned().unwrap_or(none);
                obj(vec![])
            }
            "place" => self.place(&s("kind")),
            "set" => {
                let Some(t) = self.things.get_mut(&s("id")) else {
                    return err("no such thing");
                };
                for (k, v) in q.get("fields").and_then(J::obj).unwrap_or(&[]) {
                    set_key(&mut t.fields, k, v.clone());
                }
                obj(vec![])
            }
            "fields" => match self.things.get(&s("id")) {
                Some(t) => obj(vec![("fields", J::Obj(t.fields.clone()))]),
                None => obj(vec![("fields", J::Null)]),
            },
            "offers" => {
                let forms = self
                    .things
                    .get(&s("id"))
                    .and_then(|t| self.entry(&t.kind))
                    .and_then(|e| e.get("forms"))
                    .and_then(J::obj)
                    .unwrap_or(&[])
                    .iter()
                    .filter(|(_, f)| f.get("starts").and_then(J::str) == Some("act"))
                    .map(|(k, _)| J::Str(k.clone()))
                    .collect();
                obj(vec![("forms", J::Arr(forms))])
            }
            "remove" => self.remove(&s("id")),
            "begin" | "act" => {
                let b = self.begin(
                    &s("id"),
                    q.get("case").unwrap_or(&none),
                    q.get("ids").unwrap_or(&none),
                );
                if s("op") == "begin" || b.get("verdict").and_then(J::str) != Some("started") {
                    return b;
                }
                let rid = b.get("rid").and_then(J::str).unwrap_or_default().to_owned();
                self.wait(&rid)
            }
            "progress" => self.progress(&s("rid")),
            "wait" => self.wait(&s("rid")),
            "leave" => self.leave(),
            "body" => obj(vec![
                (
                    "posture",
                    J::s(if self.forms.at(self.body).is_some() {
                        "busy"
                    } else {
                        "standing"
                    }),
                ),
                ("holding", J::Arr(Vec::new())),
            ]),
            "restart" => self.restart(),
            op => err(format!("unknown op {op}")),
        }
    }
}

fn main() {
    let mut stage = Stage::new();
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let answer = match parse(&line) {
            Ok(q) => stage.handle(&q),
            Err(e) => err(format!("not JSON: {e}")),
        };
        if writeln!(out, "{}", answer.to_json())
            .and_then(|()| out.flush())
            .is_err()
        {
            break;
        }
    }
}
