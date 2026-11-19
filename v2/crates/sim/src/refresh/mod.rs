//! Things already placed move to a newer revision of their kind (Engine v2 F9, #2776), keeping their state and never
//! holding the clock. No code here names a kind.
//!
//! - **A revision is a new kind hash** of the same `namespace:name`. Both are loaded side by side by K3's loader
//!   ([`plan`]), so old records naming the old hash stay readable.
//! - **What is refused before anything moves**, by name: a revision that changes the thing's shape (its geometry,
//!   section 7: `refresh-shape-changed`) or where a body stands at it (its `stand` points: `refresh-stand-moved`).
//!   Either moves walkable ground and can bury a Soul; that is lane G's (G2, G3). A field number kept with another
//!   type is `refresh-field-reused`: a number is never reused for another meaning.
//! - **State is matched by field number, never by name.** A thing keeps every field it holds; each field the revision
//!   adds is set to its default; each field the old revision declared and the new one does not is dropped and listed
//!   on the job node (`F_DROPPED`).
//! - **A refresh is one part per thing**, all of it or none: the thing removed and created again with the same id,
//!   parent, slot, pose and audience, under the new kind, with its fields; each link it had written again with the
//!   same id; and the job's count of things left. The schema's generic changes have no "set kind" (T6 lists seven), so
//!   the two are written as a remove and a create in one part, with a `souls:refreshed` event naming both kinds.
//! - **A thing in use is deferred, never broken:** reserved (a form's `souls:reserves` link), held (its parent is a
//!   body), occupied (a body is its child) or moving. It is tried again each slice and refreshed once its user has
//!   left. A thing with things in it that are not bodies is refused (`refresh-holds-things`), since a remove would take
//!   them; so is a thing already holding a field number the revision adds (`refresh-field-taken`).
//! - **The run is a job whose progress is in the tree:** a node of kind [`JOB_KIND`] naming both revisions, written
//!   when it starts and removed when it ends. What is left is read from the tree: the things still on the old kind.
//!   After a restart, [`Job::recover`] finds the job nodes and carries on; a part is whole or absent, so no thing is
//!   ever half refreshed.
//! - **Done in slices:** at most `limit` things a tick ([`Job::slice`]). The engine reads no wall time, so the slice
//!   is a count, stated from a measured refresh (the `refresh` bench, `v2/tools/bench`).
//!
//! Not here: shape changes (G2, G3), a dry run, settling a timed value (F5) before its kind changes.

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, VecDeque};

use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Event, Header, Part, Refusal, Rest,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Id, KindSource};
use replica::kinds::{Kinds, Role};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::time::Micros;
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, End, plain};

use crate::forms::RESERVES;

/// The job node's kind. Callers load it with the two revisions ([`Plan::kinds`]) and admit it where the job is put.
pub const JOB_KIND: &str = "{1: \"souls:refresh\", 2: \"thing\"}";
const JOB: &str = "souls:refresh";

/// The job node's fields: the two revisions' full names, the fields added (number to default), the numbers dropped,
/// and how many things are left.
pub const F_FROM: u64 = 1;
pub const F_TO: u64 = 2;
pub const F_ADDED: u64 = 3;
pub const F_DROPPED: u64 = 4;
pub const F_LEFT: u64 = 5;

/// The events: a job started, a thing refreshed, a job ended.
pub const STARTED: &str = "souls:refresh-started";
pub const REFRESHED: &str = "souls:refreshed";
pub const ENDED: &str = "souls:refresh-ended";

const SECTION_GEOMETRY: u64 = 7;

fn refusal(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

/// A checked move from one revision to the next, and the kinds loaded for it (both revisions and the job's).
pub struct Plan {
    pub from: Name,
    pub to: Name,
    pub job: Name,
    pub added: BTreeMap<u64, Value>,
    pub dropped: Vec<u64>,
    pub kinds: Kinds,
}

/// Checks a move from the kind in source `from` to the kind in source `to`, loading both side by side with K3's
/// loader. Refused by name: either kind not loaded (`refresh-kind-refused`), another name (`refresh-not-a-revision`),
/// the same hash (`refresh-same-revision`), a changed shape, a moved stand point, a field number reused.
pub fn plan(from: &str, to: &str) -> Result<Plan, Refusal> {
    let mut kinds = Kinds::default();
    let mut one = |text: &str, label: &str| {
        let got = kinds.load(&[(label, text)]);
        got.into_iter().next().ok_or_else(|| {
            let why = kinds.refused().last().map(ToString::to_string);
            refusal("refresh-kind-refused", why.unwrap_or_default())
        })
    };
    let (f, t, job) = (one(from, "from")?, one(to, "to")?, one(JOB_KIND, "job")?);
    let parse = |text: &str| {
        KindSource::parse(text).map_err(|r| refusal("refresh-kind-refused", r.to_string()))
    };
    let (fs, ts) = (parse(from)?, parse(to)?);
    if plain(f.as_str()) != plain(t.as_str()) {
        return Err(refusal(
            "refresh-not-a-revision",
            format!("{} -> {}", f.as_str(), t.as_str()),
        ));
    }
    if f == t {
        return Err(refusal("refresh-same-revision", f.as_str()));
    }
    if fs.sections().get(&SECTION_GEOMETRY) != ts.sections().get(&SECTION_GEOMETRY) {
        return Err(refusal(
            "refresh-shape-changed",
            format!("{} -> {}", f.as_str(), t.as_str()),
        ));
    }
    let (fk, tk) = (
        kinds.get(f.as_str()).expect("loaded"),
        kinds.get(t.as_str()).expect("loaded"),
    );
    let stands = |k: &replica::kinds::KindDef| -> Vec<(u64, [i64; 3])> {
        k.points
            .iter()
            .filter(|(_, p)| p.role == Some(Role::Stand))
            .map(|(n, p)| (*n, p.at_mm))
            .collect()
    };
    if stands(fk) != stands(tk) {
        return Err(refusal(
            "refresh-stand-moved",
            format!("{} -> {}", f.as_str(), t.as_str()),
        ));
    }
    let mut added = BTreeMap::new();
    for (n, field) in &tk.state {
        match fk.state.get(n) {
            Some(old) if old.ty != field.ty => {
                return Err(refusal(
                    "refresh-field-reused",
                    format!("field {n} of {}", t.as_str()),
                ));
            }
            Some(_) => {}
            None => {
                added.insert(*n, field.default.clone());
            }
        }
    }
    let dropped = fk
        .state
        .keys()
        .filter(|n| !tk.state.contains_key(n))
        .copied()
        .collect();
    Ok(Plan {
        from: f,
        to: t,
        job,
        added,
        dropped,
        kinds,
    })
}

/// Where a job writes: the tree, the bundle's header (naming both revisions and the job's kind), the rules commits are
/// checked under, the zone's next sequence (shared with every other writer), the world time, and each part written,
/// as stored bytes, in order.
pub struct Writer<'a> {
    pub tree: &'a mut Tree,
    pub header: &'a Header,
    pub rules: &'a Rules,
    pub next: &'a mut u64,
    pub at: Micros,
    pub parts: &'a mut Vec<Vec<u8>>,
}

impl Writer<'_> {
    /// Commits `effects` as one part, all of it or none.
    fn write(&mut self, mut effects: Vec<Effect>) -> Result<(), Refusal> {
        for (i, e) in effects.iter_mut().enumerate() {
            e.envelope.sequence = *self.next + i as u64;
            e.envelope.at = self.at;
        }
        let bytes = encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (
                2,
                Value::Array(effects.iter().map(Effect::to_value).collect()),
            ),
        ])))
        .map_err(|e| refusal("encoding", e.to_string()))?;
        self.tree
            .commit(self.header, &Part::read(&bytes)?, self.rules)?;
        *self.next += effects.len() as u64;
        self.parts.push(bytes);
        Ok(())
    }
}

fn effect(
    node: Id,
    audience: Audience,
    actor: Actor,
    changes: Vec<Change>,
    event: Option<Event>,
) -> Effect {
    Effect {
        envelope: Envelope {
            sequence: 0,
            at: 0,
            cause: Cause::World,
            actor,
            audience,
            node,
        },
        body: Body::Changes(
            changes
                .into_iter()
                .map(|change| ChangeRec {
                    change,
                    rest: Rest::new(),
                })
                .collect(),
        ),
        events: event.map(|e| vec![e]),
        rest: Rest::new(),
    }
}

fn event(name: &str, fields: BTreeMap<u64, Value>) -> Event {
    Event {
        name: Name::new(name).expect("a name"),
        fields,
        changes: vec![0],
        rest: Rest::new(),
    }
}

/// Every node of kind `kind` (a full name), in tree order: a walk of the whole tree, done when a job starts or
/// recovers, never per tick.
fn of_kind(tree: &Tree, kind: impl Fn(&str) -> bool) -> Vec<Id> {
    let mut out = Vec::new();
    let mut stack = vec![tree.root()];
    while let Some(h) = stack.pop() {
        let Some(n) = tree.node(h) else { continue };
        if kind(n.kind().as_str()) {
            out.push(n.id());
        }
        if let Some(kids) = tree.children(h) {
            stack.extend(kids.iter().rev().copied());
        }
    }
    out
}

/// Why a thing was not refreshed in a slice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Check {
    /// Removed, or no longer on the old kind: nothing to do.
    Gone,
    /// In use: tried again next slice.
    Busy(&'static str),
    /// Never refreshed by this job.
    Refuse(&'static str),
    Ready,
}

/// What one slice did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Slice {
    pub refreshed: usize,
    /// Things in use, each with why, to be tried again.
    pub deferred: Vec<(Id, &'static str)>,
    /// The job has ended and its node is removed.
    pub done: bool,
}

/// One revision move in progress.
pub struct Job {
    pub node: Id,
    pub from: Name,
    pub to: Name,
    added: BTreeMap<u64, Value>,
    dropped: Vec<u64>,
    actor: Actor,
    queue: VecDeque<Id>,
    waiting: Vec<Id>,
    /// Things this job will never refresh, each with why.
    pub refused: Vec<(Id, &'static str)>,
}

impl Job {
    /// Starts moving every thing of `plan.from` to `plan.to`: writes the job node `node` under `parent`, with a
    /// `souls:refresh-started` event. The things are found by one walk of the tree.
    pub fn start(
        w: &mut Writer<'_>,
        plan: &Plan,
        node: Id,
        parent: Id,
        actor: Actor,
    ) -> Result<Job, Refusal> {
        let queue: VecDeque<Id> = of_kind(w.tree, |k| k == plan.from.as_str()).into();
        let mut fields = BTreeMap::from([
            (F_FROM, Value::Text(plan.from.clone())),
            (F_TO, Value::Text(plan.to.clone())),
            (F_LEFT, Value::Uint(queue.len() as u64)),
        ]);
        if !plan.added.is_empty() {
            fields.insert(F_ADDED, Value::Map(plan.added.clone()));
        }
        if !plan.dropped.is_empty() {
            let d = plan.dropped.iter().map(|n| Value::Uint(*n)).collect();
            fields.insert(F_DROPPED, Value::Array(d));
        }
        let parent_frame = Frame {
            node: parent,
            slot: None,
        };
        let create = Change::Create {
            node,
            kind: plan.job.clone(),
            pose: Pose {
                frame: parent_frame,
                position: Vec3::ZERO,
                orientation: Quat::IDENTITY,
                support: Support::Surface {
                    surface: parent,
                    height: 0,
                },
            },
            audience: Audience::Everyone,
            fields,
        };
        let started = event(
            STARTED,
            BTreeMap::from([
                (1, Value::Text(plan.from.clone())),
                (2, Value::Text(plan.to.clone())),
            ]),
        );
        w.write(vec![effect(
            parent,
            Audience::Everyone,
            actor,
            vec![create],
            Some(started),
        )])?;
        Ok(Job {
            node,
            from: plan.from.clone(),
            to: plan.to.clone(),
            added: plan.added.clone(),
            dropped: plan.dropped.clone(),
            actor,
            queue,
            waiting: Vec::new(),
            refused: Vec::new(),
        })
    }

    /// Every job the tree holds, after a restart: each carries on from the things still on its old kind. The world is
    /// the actor of what a recovered job writes.
    pub fn recover(tree: &Tree) -> Vec<Job> {
        let mut jobs = Vec::new();
        for id in of_kind(tree, |k| plain(k) == JOB) {
            let Some(n) = tree.handle(id).and_then(|h| tree.node(h)) else {
                continue;
            };
            let f = n.fields();
            let (Some(Value::Text(from)), Some(Value::Text(to))) = (f.get(&F_FROM), f.get(&F_TO))
            else {
                continue;
            };
            let added = match f.get(&F_ADDED) {
                Some(Value::Map(m)) => m.clone(),
                _ => BTreeMap::new(),
            };
            let dropped = match f.get(&F_DROPPED) {
                Some(Value::Array(a)) => a
                    .iter()
                    .filter_map(|v| {
                        if let Value::Uint(u) = v {
                            Some(*u)
                        } else {
                            None
                        }
                    })
                    .collect(),
                _ => Vec::new(),
            };
            jobs.push(Job {
                node: id,
                from: from.clone(),
                to: to.clone(),
                added,
                dropped,
                actor: Actor::World,
                queue: VecDeque::new(),
                waiting: Vec::new(),
                refused: Vec::new(),
            });
        }
        for j in &mut jobs {
            j.queue = of_kind(tree, |k| k == j.from.as_str()).into();
        }
        jobs
    }

    /// Things not yet refreshed: queued and waiting on their users.
    pub fn left(&self) -> usize {
        self.queue.len() + self.waiting.len()
    }

    fn check(&self, tree: &Tree, rules: &Rules, id: Id) -> Check {
        let Some(h) = tree.handle(id) else {
            return Check::Gone;
        };
        let Some(n) = tree.node(h) else {
            return Check::Gone;
        };
        if n.kind().as_str() != self.from.as_str() {
            return Check::Gone;
        }
        let owner = |k: &Name| rules.kinds.get(k.as_str()).map(|k| k.owner.as_str());
        let body = |id: Id| {
            tree.handle(id)
                .and_then(|h| tree.node(h))
                .is_some_and(|n| owner(n.kind()) == Some("family"))
        };
        if n.moved().is_some() {
            return Check::Busy("moving");
        }
        if tree
            .links_at(id)
            .iter()
            .any(|e| tree.ty(e).as_str() == RESERVES)
        {
            return Check::Busy("reserved");
        }
        if n.parent().is_some_and(body) {
            return Check::Busy("held");
        }
        let kids: Vec<Id> = tree
            .children(h)
            .unwrap_or_default()
            .iter()
            .filter_map(|c| tree.node(*c).map(|n| n.id()))
            .collect();
        if kids.iter().any(|c| body(*c)) {
            return Check::Busy("occupied");
        }
        if !kids.is_empty() {
            return Check::Refuse("refresh-holds-things");
        }
        if self.added.keys().any(|k| n.fields().contains_key(k)) {
            return Check::Refuse("refresh-field-taken");
        }
        Check::Ready
    }

    /// One part: the thing removed and created again under the new kind with its state, its links written again, and
    /// the job's count of things left.
    fn refresh(&self, w: &mut Writer<'_>, id: Id, left: usize) -> Result<(), Refusal> {
        let tree = &*w.tree;
        let n = tree
            .handle(id)
            .and_then(|h| tree.node(h))
            .ok_or_else(|| refusal("node-missing", ""))?;
        let (Some(parent), Some(place)) = (n.parent(), n.place()) else {
            return Err(refusal(
                "refresh-root",
                "the zone's root has no kind to refresh",
            ));
        };
        let audience = n.audience();
        let mut fields = n.fields().clone();
        for d in &self.dropped {
            fields.remove(d);
        }
        fields.extend(self.added.iter().map(|(k, v)| (*k, v.clone())));
        let pose = Pose {
            frame: Frame {
                node: parent,
                slot: n.slot(),
            },
            position: place.position,
            orientation: place.orientation,
            support: place.support,
        };
        let mut effects = vec![effect(
            id,
            audience,
            self.actor,
            vec![Change::Remove { node: id }],
            None,
        )];
        let create = Change::Create {
            node: id,
            kind: self.to.clone(),
            pose,
            audience,
            fields,
        };
        let refreshed = event(
            REFRESHED,
            BTreeMap::from([
                (1, Value::Text(self.from.clone())),
                (2, Value::Text(self.to.clone())),
            ]),
        );
        effects.push(effect(
            parent,
            audience,
            self.actor,
            vec![create],
            Some(refreshed),
        ));
        for e in tree.links_at(id) {
            let Some((ty, ends, owner, audience)) = tree.link(e.link) else {
                continue;
            };
            let owning = ends[usize::from(owner == End::Second)];
            let link = Change::Link {
                link: e.link,
                ty: ty.clone(),
                ends,
                owner,
                audience,
            };
            effects.push(effect(owning, audience, self.actor, vec![link], None));
        }
        let count = Change::Set {
            node: self.node,
            field: F_LEFT,
            to: Value::Uint(left as u64),
            by: None,
        };
        effects.push(effect(
            self.node,
            Audience::Everyone,
            self.actor,
            vec![count],
            None,
        ));
        w.write(effects)
    }

    /// Refreshes at most `limit` things, first those that were in use, then the queue. A thing still in use waits; a
    /// thing whose part is refused is listed and the job goes on. When nothing is left the job node is removed with a
    /// `souls:refresh-ended` event.
    pub fn slice(&mut self, w: &mut Writer<'_>, limit: usize) -> Result<Slice, Refusal> {
        let mut out = Slice::default();
        let mut tried = std::mem::take(&mut self.waiting)
            .into_iter()
            .collect::<VecDeque<_>>();
        let mut again = Vec::new();
        while out.refreshed < limit {
            let Some(id) = tried.pop_front().or_else(|| self.queue.pop_front()) else {
                break;
            };
            match self.check(w.tree, w.rules, id) {
                Check::Gone => {}
                Check::Busy(why) => {
                    again.push(id);
                    out.deferred.push((id, why));
                }
                Check::Refuse(why) => self.refused.push((id, why)),
                Check::Ready => {
                    let left = tried.len() + self.queue.len() + again.len();
                    match self.refresh(w, id, left) {
                        Ok(()) => out.refreshed += 1,
                        Err(e) => self.refused.push((id, e.name)),
                    }
                }
            }
        }
        again.extend(tried);
        self.waiting = again;
        if self.left() == 0 {
            let ended = event(
                ENDED,
                BTreeMap::from([
                    (1, Value::Text(self.to.clone())),
                    (2, Value::Uint(self.refused.len() as u64)),
                ]),
            );
            let remove = Change::Remove { node: self.node };
            w.write(vec![effect(
                self.node,
                Audience::Everyone,
                self.actor,
                vec![remove],
                Some(ended),
            )])?;
            out.done = true;
        }
        Ok(out)
    }
}
