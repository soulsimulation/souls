//! Soul Actions acts in a running world (Engine v2 C2, #3366): a form intent on a world with bodies is carried out
//! by F1/F2's form runner (`sim::forms`), over the world's loaded entries, on the clock thread. No code here names a
//! kind, a form or a move.
//!
//! - **Committed at the next tick.** [`crate::answers`] takes a form's act like a move: an id, a deadline and a place
//!   in the next tick. There [`Acts::commit`] finds the node's kind in the replica's tree and its entry in the world's
//!   entries (`souls-entry/1`), and hands the form to [`Forms::commit`], which binds its steps and effects (F1, F2),
//!   checks who may (F6) and starts the run. Its candidates are tried in rank order; the first refusal is the answer
//!   when none starts.
//! - **The world the runner reaches** is the bodies' own: their controller (B1), their town for a walk's corners (N7),
//!   and a due list, moves (B2) and a minter of the forms' own. A move's reach is measured from the body's feet to
//!   the node's place in the tree, across x and z.
//! - **Written once.** What the runner writes ([`Forms::out`]) is numbered at the replica's version, applied as one
//!   part with the tick's other entries and handed back to [`Forms::logged`] (F2's log hook, #3257, as its issue
//!   describes it). A run's end is its intent's answer: `done` a receipt naming every entry the intent caused, else
//!   the run's ending by name.
//!
//! Not here: R2's needs checked again at commit (the checkers read bodies from the tree, which does not hold them
//! yet); a form's reservation (F3's link needs both ends in the tree, so a form reserves nothing until bodies are
//! nodes); resuming a run after a restart.

use std::collections::{BTreeMap, BTreeSet};

use replica::effects::{Actor, Effect, Refusal, fixture_bytes};
use replica::encode::{Name, decode};
use replica::host::{Answer, Ask, Seen};
use replica::ids::{Id, Minter, Scope};
use replica::moves::{Effector, Move};
use replica::pose::Vec3;
use replica::rules::json::Value as Json;
use replica::time::Micros;
use replica::tree::Tree;
use sim::controller::Controller;
use sim::forms::{Asked, Forms, Intent, RunId, World};
use sim::host::Geometry;
use sim::mover::Body as Moved;
use sim::moves::{Moves, Reach};
use sim::timers::DueList;
use sim::walk::town::View;
use skills::form_runner::Limits;

use crate::bodies::Bodies;

type R<T> = Result<T, Refusal>;

const MOVES: [&str; 5] = [
    include_str!("../../replica/fixtures/moves/lie.diag"),
    include_str!("../../replica/fixtures/moves/pour.diag"),
    include_str!("../../replica/fixtures/moves/press.diag"),
    include_str!("../../replica/fixtures/moves/rise.diag"),
    include_str!("../../replica/fixtures/moves/sit.diag"),
];

fn refusal(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

/// What the runner sees: the bodies as the controller had them at the call, the town's corners and the tree.
struct Sight<'a> {
    bodies: BTreeMap<Id, Moved>,
    view: Option<View<'a>>,
    tree: &'a Tree,
    kind: Name,
}

impl Sight<'_> {
    /// A node's place in the tree, its parents' positions added (their turns are not: things stand upright).
    fn place(&self, node: Id) -> Option<Vec3> {
        let mut at = Vec3::ZERO;
        let mut id = node;
        for _ in 0..64 {
            let n = self.tree.node(self.tree.handle(id)?)?;
            if let Some(p) = n.place() {
                at = Vec3::new(
                    at.x + p.position.x,
                    at.y + p.position.y,
                    at.z + p.position.z,
                );
            }
            match n.parent() {
                Some(p) => id = p,
                None => return Some(at),
            }
        }
        None
    }
}

impl Geometry for Sight<'_> {
    fn ask(&self, body: Id, q: &Ask) -> Option<Answer> {
        match q {
            Ask::Toward { to, .. } => {
                let me = self.bodies.get(&body)?;
                let [x, z] = match &self.view {
                    Some(v) => v.corner(me, *to).ok()?,
                    None => [to.x, to.z],
                };
                let y = if [x, z] == [to.x, to.z] { to.y } else { 0 };
                Some(Answer::Point(Vec3::new(x, y, z)))
            }
            Ask::Near { .. } => Some(Answer::Near(Vec::new())),
            Ask::Distance { .. } => None,
        }
    }

    fn read(&self, node: Id) -> Option<Seen> {
        let b = self.bodies.get(&node)?;
        Some(Seen {
            id: node,
            kind: self.kind.clone(),
            parent: Some(sim::index::place_of(b).0),
            position: b.pose.position,
            fields: BTreeMap::new(),
        })
    }
}

impl Reach for Sight<'_> {
    fn distance(
        &self,
        body: Id,
        _: &Effector,
        _: Option<&Name>,
        target: Id,
        _: &Name,
    ) -> Option<i64> {
        let a = self.bodies.get(&body)?.pose.position;
        let b = match self.bodies.get(&target) {
            Some(t) => t.pose.position,
            None => self.place(target)?,
        };
        let d = |u: i64, v: i64| i128::from(u - v) * i128::from(u - v);
        i64::try_from((d(a.x, b.x) + d(a.z, b.z)).isqrt()).ok()
    }
}

/// The forms in progress, and what they reach that the bodies do not hold.
pub struct Acts {
    pub forms: Forms,
    /// The world's entries by kind (`souls-entry/1`).
    kinds: Json,
    due: DueList,
    mint: Minter,
    moves: Moves,
    library: Vec<Move>,
    /// A controller for a world with no bodies: a form there may only have no steps.
    own: Controller,
    /// Each run's intent.
    runs: BTreeMap<RunId, Id>,
}

/// The moves a form's step may name: the fixture moves.
pub fn library() -> R<Vec<Move>> {
    MOVES
        .iter()
        .map(|t| {
            let v = decode(&fixture_bytes(t)?)
                .map_err(|e| refusal("move-unread", e.to_string()))?
                .value;
            Move::from_value(&v)
        })
        .collect()
}

/// The plain name (`namespace:name`) of a node's kind.
fn plain(kind: &Name) -> &str {
    let k = kind.as_str();
    k.split_once('@').map_or(k, |(p, _)| p)
}

impl Acts {
    /// No forms yet, over the world's entries by kind and the moves' library ([`library`]), in the zone `header`
    /// names, minting ids of `scope`: F4's amounts read the entries' fields (`Forms::kinds`), and a take or a put writes under the zone.
    pub fn new(
        kinds: Json,
        library: Vec<Move>,
        header: replica::effects::Header,
        scope: Scope,
    ) -> Acts {
        let mut forms = Forms::new();
        let mut loaded = replica::kinds::Kinds::default();
        for (_, entry) in kinds.obj().unwrap_or(&[]) {
            let mut e = entry.clone();
            if let Json::Obj(o) = &mut e {
                o.retain(|(k, _)| k != "forms");
            }
            if let Ok(text) = replica::kinds::entry::entry_to_kind(&e.to_json()) {
                loaded.load(&[("entry", text.as_str())]);
            }
        }
        forms.kinds(&loaded);
        forms.zone(header);
        Acts {
            forms,
            kinds,
            due: DueList::new(),
            mint: Minter::new(scope),
            moves: Moves::new(),
            library,
            own: Controller::new(),
            runs: BTreeMap::new(),
        }
    }

    /// Runs `f` on the world the runner reaches.
    fn with<T>(
        &mut self,
        tree: &Tree,
        bodies: Option<&mut Bodies>,
        seed: u64,
        f: impl FnOnce(&mut Forms, &mut World<'_, Sight<'_>, Sight<'_>>) -> T,
    ) -> T {
        let (controller, view) = match bodies {
            Some(b) => (&mut b.runner.controller, Some(b.town.view())),
            None => (&mut self.own, None),
        };
        let sight = Sight {
            bodies: controller.bodies().map(|b| (b.id, *b)).collect(),
            view,
            tree,
            kind: Name::new("souls:body").unwrap_or_else(|| unreachable!("a literal name")),
        };
        let mut w = World {
            tree,
            geometry: &sight,
            reach: &sight,
            controller,
            due: &mut self.due,
            mint: &mut self.mint,
            moves: &mut self.moves,
            library: &self.library,
            seed,
        };
        f(&mut self.forms, &mut w)
    }

    /// Starts the act's first candidate that starts (`(node, form)` in rank order) for intent `intent` on `body`, or
    /// the first refusal. A resend of an intent whose run is going joins it; one whose effects are logged gets them.
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &mut self,
        tree: &Tree,
        bodies: Option<&mut Bodies>,
        body: Id,
        candidates: &[(Id, String)],
        args: &BTreeMap<String, Id>,
        intent: Intent,
        tick: u64,
        now: Micros,
    ) -> R<Asked> {
        let mut bodies = bodies;
        let mut first = None;
        for (node, form) in candidates {
            let kind = tree
                .handle(*node)
                .and_then(|h| tree.node(h))
                .map(|n| plain(n.kind()).to_owned());
            // A thing already gone is refused by name here, never handed to the runner (F4's known gap).
            let Some(kind) = kind else {
                first.get_or_insert(refusal("thing-missing", replica::world_model::show(*node)));
                continue;
            };
            let Some(entry) = self.kinds.get(&kind).cloned() else {
                first.get_or_insert(refusal("no_such_kind", kind));
                continue;
            };
            // F3's reservation is a link from the body: until bodies are nodes of the tree, a form reserves nothing.
            if tree.handle(body).is_none() {
                self.forms.shared(*node);
            }
            let audiences = BTreeMap::<Id, BTreeSet<Id>>::new();
            let r = self.with(tree, bodies.as_deref_mut(), tick, |forms, w| {
                if args.is_empty() {
                    return forms.commit(
                        w,
                        &audiences,
                        &|_| None,
                        body,
                        *node,
                        &entry,
                        form,
                        intent,
                        Limits::default(),
                        now,
                    );
                }
                // Thing arguments (F4): bound here, as `Forms::commit` binds none yet.
                let steps = skills::form_runner::bind(&entry, form)?;
                let effects = skills::form_runner::bind_effects_with(&entry, form, args)?;
                sim::forms::may(w.tree, &audiences, &|_| None, body, *node, &entry, form)?;
                forms.start(
                    w,
                    body,
                    *node,
                    intent,
                    steps,
                    effects,
                    Limits::default(),
                    now,
                )
            });
            match r {
                Ok(a) => {
                    if let Asked::Started(run) | Asked::Running(run) = a {
                        self.runs.insert(run, intent.id);
                    }
                    return Ok(a);
                }
                Err(e) => {
                    first.get_or_insert(e);
                }
            }
        }
        Err(first.unwrap_or_else(|| refusal("no_candidate", "")))
    }

    /// The Soul's leave: the run on `body` ends `left` at its next stable moment.
    pub fn leave(&mut self, tree: &Tree, bodies: Option<&mut Bodies>, body: Id, now: Micros) {
        let _ = self.with(tree, bodies, 0, |forms, w| forms.leave(w, body, now));
    }

    /// The forms' part of a tick at world time `now`: their walks, then every timer of theirs due by `now`.
    pub fn tick(&mut self, tree: &Tree, mut bodies: Option<&mut Bodies>, tick: u64, now: Micros) {
        self.with(tree, bodies.as_deref_mut(), tick, |forms, w| {
            forms.tick(w, now);
            while let Some(t) = w.due.fire(now) {
                forms.fire(w, &t);
            }
        });
    }

    /// What the forms wrote, to be numbered and applied.
    pub fn out(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.forms.out)
    }

    /// Runs that ended since the last call: each one's intent and its ending's name.
    pub fn ended(&mut self) -> Vec<(Id, String)> {
        std::mem::take(&mut self.forms.ended)
            .into_iter()
            .filter_map(|e| Some((self.runs.remove(&e.run)?, e.how.as_str().to_owned())))
            .collect()
    }
}

/// F2's intent for a world intent: its id, its expiry, its actor and its bytes' digest.
pub fn intent(id: Id, expiry: Micros, actor: Actor, bytes: &[u8]) -> Intent {
    Intent {
        id,
        expiry,
        actor,
        digest: replica::ids::sha256(bytes),
    }
}
