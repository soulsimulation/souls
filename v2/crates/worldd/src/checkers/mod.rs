//! Checkers (Engine v2 I3, #2686): threads that check acts off the clock. Each takes the newest frozen copy (K8,
//! `sim::frozen`), runs R2's form rules (`replica::rules`) on it for every candidate of an act's ranked list, prepares
//! the yes candidates' changes, and hands the clock thread [`Checks`]: verdicts, changes and read sets. The clock
//! thread only confirms and applies (`sim::commit`).
//!
//! **The read set is collected inside the read interface** ([`Recording`]): every node a check reads through
//! [`Read`] is recorded with its version stamp, so a read cannot be left out of it by the rule that made it. The
//! check reads the candidate's thing and the actor's body; a stamp is per node, so the read set covers every field,
//! slot and link of each.
//!
//! What the rules get from the copy: the thing as `{kind, fields}`, its fields named by its kind's `state` numbers;
//! the body as `{effector_mm}`, the body's position less the thing's, both in their parent's frame (the effector is
//! the body's origin until bodies have hands, T4); the moves' reach from [`Rules::moves`]; and an asker who sees all
//! (the world). A yes candidate's effects are bound by F2's binder, the form runner's own (`skills::form_runner`),
//! and become its changes; an effect the binder does not bind is refused by the binder's name. In a world with bodies
//! a form's act goes to the form runner instead (C2, `crate::acts`).

use replica::effects::{Actor, Cause, Change, Refusal};
use replica::encode::Value as Cbor;
use replica::ids::Id;
use replica::query::LinkAt;
use replica::read::Read;
use replica::rules::decide_parts;
use replica::rules::json::Value;
use replica::select::{Resolved, Spot};
use replica::world_model::show;
use sim::commit::{Checked, Checks, Verdict, off_clock};
use sim::frozen::Publisher;
use skills::form_runner;
use std::cell::RefCell;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

pub mod budget;
pub mod places;
#[cfg(test)]
mod tests;
pub mod toggles;

/// The rules' data: the kinds by plain name (`souls-entry/1` entries) and each move's reach.
pub struct Rules {
    pub kinds: Value,
    /// `{<move>: {reach_mm}}`.
    pub moves: Value,
}

/// One candidate: a form of a thing.
#[derive(Clone, Debug)]
pub struct Candidate {
    pub this: Id,
    pub form: String,
}

/// An act as the checkers take it: who acts, through which body, and the candidates in rank order.
#[derive(Clone, Debug)]
pub struct Act {
    pub id: u64,
    pub cause: Cause,
    pub actor: Actor,
    pub body: Id,
    pub candidates: Vec<Candidate>,
    /// Set for the one re-check: the version the copy must stand at, or later.
    pub recheck: Option<u64>,
    /// A move aimed at a described spot (selector 2, E2 #2709), resolved by the checker that takes the act.
    pub spot: Option<Box<SpotAct>>,
}

/// A walk or a sit aimed at a described spot, and the checker's answer on its copy once resolved.
#[derive(Clone, Debug)]
pub struct SpotAct {
    pub sit: bool,
    pub spot: Spot,
    pub resolved: Option<Result<Resolved, Refusal>>,
}

/// A reader that records each node it reads and the node's stamp.
pub struct Recording<'a, R: Read> {
    inner: &'a R,
    reads: RefCell<Vec<(Id, u64)>>,
}

impl<'a, R: Read> Recording<'a, R> {
    pub fn new(inner: &'a R) -> Self {
        Recording {
            inner,
            reads: RefCell::new(Vec::new()),
        }
    }

    fn saw(&self, id: Id) {
        let mut r = self.reads.borrow_mut();
        if !r.iter().any(|(i, _)| *i == id) {
            r.push((id, self.inner.stamp(id)));
        }
    }

    /// The read set: each node read once, with its stamp.
    pub fn reads(self) -> Vec<(Id, u64)> {
        self.reads.into_inner()
    }
}

impl<R: Read> Read for Recording<'_, R> {
    fn version(&self) -> u64 {
        self.inner.version()
    }

    fn stamp(&self, id: Id) -> u64 {
        self.saw(id);
        self.inner.stamp(id)
    }

    fn node(&self, id: Id) -> Option<Cbor> {
        self.saw(id);
        self.inner.node(id)
    }

    fn children(&self, id: Id, kind: Option<&str>) -> Option<Vec<Id>> {
        self.saw(id);
        let c = self.inner.children(id, kind)?;
        c.iter().for_each(|i| self.saw(*i));
        Some(c)
    }

    fn links(&self, end: Id) -> Vec<LinkAt> {
        self.saw(end);
        self.inner.links(end)
    }

    fn path(&self, id: Id) -> Option<Vec<Id>> {
        let p = self.inner.path(id)?;
        p.iter().for_each(|i| self.saw(*i));
        Some(p)
    }
}

fn field(record: &Cbor, k: u64) -> Option<&Cbor> {
    match record {
        Cbor::Map(m) => m.get(&k),
        _ => None,
    }
}

fn int(v: &Cbor) -> Option<i128> {
    match v {
        Cbor::Uint(n) => Some(i128::from(*n)),
        Cbor::Nint(n) => Some(-1 - i128::from(*n)),
        _ => None,
    }
}

/// A node's position in its parent's frame, in micrometres.
fn position(record: &Cbor) -> Option<[i128; 3]> {
    let Cbor::Array(xyz) = field(field(record, 7)?, 2)? else {
        return None;
    };
    let v: Vec<i128> = xyz.iter().map(int).collect::<Option<_>>()?;
    v.try_into().ok()
}

/// The kind's plain name (`namespace:name`) of a node record.
fn plain_kind(record: &Cbor) -> Option<&str> {
    let Cbor::Text(k) = field(record, 2)? else {
        return None;
    };
    Some(k.as_str().split_once('@').map_or(k.as_str(), |(p, _)| p))
}

/// The thing as the rules read it: `{kind, fields}`, fields named by the kind's state numbers.
fn thing(record: &Cbor, entry: &Value) -> Value {
    let kind = plain_kind(record).unwrap_or("");
    let mut fields = Vec::new();
    for (name, def) in entry.get("state").and_then(Value::obj).unwrap_or(&[]) {
        let n = def.get("n").and_then(|n| match n {
            Value::Int(n) => u64::try_from(*n).ok(),
            _ => None,
        });
        if let Some(v) = n.and_then(|n| field(field(record, 6)?, n)).and_then(int) {
            fields.push((name.clone(), Value::Int(v)));
        }
    }
    Value::Obj(vec![
        ("kind".into(), Value::s(kind)),
        ("fields".into(), Value::Obj(fields)),
    ])
}

/// The changes a yes candidate's form makes: its effects as the form runner's binder binds them
/// (`skills::form_runner`, F2 and F4), or the binder's refusal by name. A world with no bodies has no hands or runner
/// to work out an amount, a take, a make or a remove against: those are the runner's, `effect-needs-the-runner`.
fn prepare(this: Id, entry: &Value, form: &str) -> Result<Vec<Change>, &'static str> {
    let effects = form_runner::bind_effects(entry, form).map_err(|r| r.name)?;
    effects
        .into_iter()
        .map(|e| match e {
            form_runner::Effect::Set { field, to } => Ok(Change::Set {
                node: this,
                field,
                to,
                by: None,
            }),
            _ => Err("effect-needs-the-runner"),
        })
        .collect()
}

/// Checks one candidate on `copy`.
fn candidate(copy: &impl Read, rules: &Rules, body: Id, soul: Id, c: &Candidate) -> Checked {
    off_clock();
    let r = Recording::new(copy);
    let this = r.node(c.this);
    let actor = r.node(body);
    let no = |reason: &str, r: Recording<'_, _>| Checked {
        verdict: Verdict::No(reason.to_owned()),
        node: c.this,
        changes: Vec::new(),
        reads: r.reads(),
    };
    let (Some(this), Some(actor)) = (this, actor) else {
        return no("no_such_node", r);
    };
    let Some(entry) = plain_kind(&this).and_then(|k| rules.kinds.get(k)) else {
        return no("no_such_kind", r);
    };
    // #3700: a private thing (its own mark or its nearest marked ancestor's) is its owner's alone, read here so its
    // marks are in the read set.
    if replica::who_may::refusal_of(replica::who_may::ownership_read(&r, c.this), soul).is_some() {
        return no("object.private", r);
    }
    let (this_id, body_id) = (show(c.this), show(body));
    let mut nodes = vec![(this_id.clone(), thing(&this, entry))];
    if let (Some(a), Some(t)) = (position(&actor), position(&this)) {
        let mm = (0..3).map(|k| Value::Int((a[k] - t[k]) / 1000)).collect();
        nodes.push((
            body_id.clone(),
            Value::Obj(vec![("effector_mm".into(), Value::Arr(mm))]),
        ));
    } else {
        nodes.push((body_id.clone(), Value::Obj(Vec::new())));
    }
    let act = Value::Obj(vec![
        ("this".into(), Value::Str(this_id)),
        ("form".into(), Value::s(&c.form)),
    ]);
    let state = Value::Obj(vec![
        ("actor".into(), Value::Str(body_id)),
        ("nodes".into(), Value::Obj(nodes)),
        ("moves".into(), rules.moves.clone()),
    ]);
    let asker = Value::Obj(vec![("sees".into(), Value::s("all"))]);
    let verdict = decide_parts(Some(&rules.kinds), Some(&act), Some(&state), Some(&asker));
    match verdict.get("verdict").and_then(Value::str) {
        Some("yes") => match prepare(c.this, entry, &c.form) {
            Ok(changes) => Checked {
                verdict: Verdict::Yes,
                node: c.this,
                changes,
                reads: r.reads(),
            },
            Err(reason) => no(reason, r),
        },
        Some("no") => no(
            verdict.get("reason").and_then(Value::str).unwrap_or("no"),
            r,
        ),
        _ => no("unknown", r),
    }
}

/// Checks every candidate of `act` on `copy`, in rank order.
pub fn check(copy: &impl Read, rules: &Rules, act: &Act) -> Checks {
    Checks {
        act: act.id,
        cause: act.cause,
        actor: act.actor,
        version: copy.version(),
        rechecked: act.recheck.is_some(),
        candidates: act
            .candidates
            .iter()
            .map(|c| {
                let soul = match act.actor {
                    Actor::Soul(s) => s,
                    _ => act.body,
                };
                candidate(copy, rules, act.body, soul, c)
            })
            .collect(),
    }
}

/// How long a re-check waits for a copy at the version it needs before checking the newest there is.
const RECHECK_WAIT: Duration = Duration::from_millis(200);

/// Checker threads: acts in, `(act, checks)` out, each checked on the newest frozen copy (for a re-check, one at the
/// version it names or later). The threads end when the sender is dropped.
pub fn start(
    threads: usize,
    publisher: Arc<Publisher>,
    rules: Arc<Rules>,
) -> (Sender<Act>, Receiver<(Act, Checks)>) {
    let (acts, rx) = channel::<Act>();
    let (out, checked) = channel();
    let rx = Arc::new(Mutex::new(rx));
    for i in 0..threads {
        let (rx, out, publisher, rules) = (
            Arc::clone(&rx),
            out.clone(),
            Arc::clone(&publisher),
            Arc::clone(&rules),
        );
        thread::Builder::new()
            .name(format!("checker-{i}"))
            .spawn(move || {
                loop {
                    let next = rx.lock().unwrap_or_else(PoisonError::into_inner).recv();
                    let Ok(mut act) = next else { break };
                    let copy = match act.recheck {
                        Some(v) => publisher.wait_for(v, RECHECK_WAIT),
                        None => publisher.latest(),
                    };
                    if let Some(s) = act.spot.as_mut() {
                        s.resolve(copy.tree(), act.body);
                    }
                    let checks = check(&*copy, &rules, &act);
                    if out.send((act, checks)).is_err() {
                        break;
                    }
                }
            })
            .unwrap_or_else(|e| panic!("a checker thread starts: {e}"));
    }
    (acts, checked)
}
