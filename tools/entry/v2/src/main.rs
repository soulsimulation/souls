//! The run gate's world on Engine v2 (#3314): `tools/entry/run.mjs --transport tools/entry/v2.mjs` drives this program
//! the way the `today` transport drives a local world, one JSON request a line on stdin and one answer a line on stdout.
//!
//! One body on open ground and the things the gate places, each beside the body, kept in a real T2 tree (0.135 E3):
//! every thing is a node of its kind (K3's, as content defines it) with its fields, the body is a node whose hands
//! are slots, linked to its Soul. A case's scene is set in that tree the first time the case acts on its things: a
//! thing in a hand is in the body's hand slot, a thing in a slot is in its holder's slot, a thing's links are links
//! to the bodies and Souls the case names (the actor's Soul is the case's `soul` link of the actor, else `s1` for
//! `b1`, as the cases write it). After that the tree is the world as it stands: R2's rules decide an act on the case's
//! state with its things' fields, hands, slots and links read from the tree (as I3's checkers decide it, the world
//! seeing all), then the form is committed to the form runner (F1: bound into steps, F2: its effects bound, F6: who
//! may, which reads the tree), and the world ticks until the run ends with its name. What the forms write is
//! committed to the tree (T2's checks) and to the log, from which the effects are read back. Leaving, removing the
//! thing and restarting are the forms' own (F3): a restart drops the controller, the due list and the moves, and
//! recovers the forms from the log alone, as a new process does; the tree is the store and stays.
//!
//! Seats (0.135 E9): each placed thing's body slots are registered in B3's places table as the served world registers
//! them (C17, #3453): every slot its entry declares that admits a body (`import_eden::body_slots_of`, as `worldd`'s
//! start and a god edit's placed thing read them), its point and facing carried up the tree onto the ground. A form's
//! `sit`, `lie`, `rise` and standing-slot steps take them through the forms' own path (`World::places`). A case's body
//! is stood back up on the ground at its seat's stand point when the case is cleared, and a restart seats it again as
//! a served world's restart does (`Slots::restore`).
//!
//! Not here: a geometry beyond open ground (every point is reached in a straight line and every thing is within
//! reach of a move, as in F3's stop table; no seat's stand point is blocked, so none is moved), and the gateway (F7). The moves
//! are content's, every `content/moves` entry loaded at world start by hash (F13, #3383). No kind, form or move is
//! named.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, Write};
use std::path::Path;

use body_script::{TICK, ground, ground_id, humanoid, place};
use replica::activity::{ActivityKind, Role, RoleLink};
use replica::bodies::{Class, Want};
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Refusal, Rest,
    TransferRec, schema_hash,
};
use replica::encode::{Name, Value as Cbor, encode};
use replica::host::{Answer, Ask, Seen};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::kinds::Kinds;
use replica::moves::{Effector, Move};
use replica::pose::{Frame, Pose, Quat, Support, Vec3, fixture};
use replica::rules::decide_parts;
use replica::rules::json::{Value as J, parse};
use replica::time::Micros;
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, End, parse_kinds, plain};
use sim::activity::{Activities, Ask as Asking};
use sim::controller::Controller;
use sim::forms::{Asked, Forms, Intent, Places, World};
use sim::host::Geometry;
use sim::mover::Surface;
use sim::moves::{Moves, Reach, library, load};
use sim::slots::hands::transfer;
use sim::slots::{PlaceAt, Slots};
use sim::timers::DueList;
use skills::form_runner::{Arg, Args, Limits, check};

/// How far from the body a thing is placed, µm: the body walks to it as the form asks.
const AWAY: i64 = 3_000_000;
/// The longest a run is followed, µs of world time.
const LONGEST: Micros = 180_000_000;
/// The fixtures' place and body kinds: the ground admits bodies and things, a body's slots 1 and 2 are its hands.
const PLACE: &str = "souls:place";
const BODY: &str = "souls:body";
/// The link from a body to its Soul (T2).
const BODY_OF: &str = "souls:body-of";
/// A body's hands by the case's names, in the humanoid's slot order.
const HANDS: [(&str, u64); 2] = [("left", 1), ("right", 2)];

fn name(s: &str) -> Name {
    Name::new(s).unwrap_or_else(|| unreachable!("a literal name"))
}

/// Bodies where the controller has them, things where they were placed (for reach); every thing is within reach.
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
    /// A body where the controller has it. A thing is the tree's to answer (where it is, who holds it).
    fn read(&self, node: Id) -> Option<Seen> {
        let position = *self.nodes.get(&node)?;
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
    /// Where the run's entries start in the log.
    from: usize,
    /// The body that does it.
    body: Id,
}

/// A case's names for what the world holds: its things, its bodies and its Souls.
#[derive(Default)]
struct Names {
    to_id: BTreeMap<String, Id>,
    of: BTreeMap<Id, String>,
}

impl Names {
    fn add(&mut self, n: &str, id: Id) {
        self.to_id.insert(n.to_owned(), id);
        self.of.entry(id).or_insert_with(|| n.to_owned());
    }
}

struct Stage {
    kinds: J,
    /// The kinds as K3 loaded them (forms left out), and each plain name's full `namespace:name@hash`.
    k3: Kinds,
    full: BTreeMap<String, String>,
    tree: Tree,
    rules: Rules,
    header: Header,
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
    /// The body's Soul.
    soul: Id,
    things: BTreeMap<String, Thing>,
    placed: u64,
    runs: BTreeMap<String, Run>,
    /// Kinds refused at import, by name (F14).
    refused: BTreeMap<String, Refusal>,
    /// Words kept for text arguments and fields, by reference number (a stand-in for K16).
    words: BTreeMap<Id, String>,
    /// Things whose case scene is set in the tree: from then on the tree is the world as it stands.
    arranged: BTreeSet<Id>,
    /// The other bodies and Souls the current case names, by its names.
    others: BTreeMap<String, Id>,
    /// Each body's Soul.
    souls_of: BTreeMap<Id, Id>,
    /// The case's names for what the world holds, as last set: a run's changes are read back by them.
    called: BTreeMap<Id, String>,
    /// Entries the tree refused (T2's checks), kept in the log alone, as this runner kept every entry before.
    unapplied: u64,
    /// What the tree refused of each run's entries, by intent: an act's answer carries it, so a pass means the tree
    /// took the run.
    refused_by: BTreeMap<Id, Vec<String>>,
    /// What of the current case's scene the tree would not hold, until the case is cleared.
    scene_refused: Vec<String>,
    /// The activities the entries' roles make (B10, #4239), by their entry's kind, and the engine's writer of them
    /// with its own due list: a case's role links are its members', taken by offer and accept as a world takes them.
    roles: BTreeMap<String, ActivityKind>,
    acts: Activities,
    acts_due: DueList,
    /// The seats the placed things' entries declare (B3's places table, C17), and who holds each.
    slots: Slots,
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

fn strs(v: Option<&J>) -> Vec<String> {
    v.and_then(J::arr)
        .unwrap_or(&[])
        .iter()
        .filter_map(|e| e.str().map(str::to_owned))
        .collect()
}

/// Slot `slot` of an entry by number, as the form runner numbers them: 1 up, in the entry's order.
fn slot_n(entry: &J, slot: &str) -> Option<u64> {
    (1u64..)
        .zip(entry.get("slots").and_then(J::obj).unwrap_or(&[]))
        .find(|(_, (k, _))| k == slot)
        .map(|(n, _)| n)
}

/// An enum value's bare name.
fn plain_value(v: &str) -> &str {
    v.split_once(':').map_or(v, |(_, b)| b)
}

fn pose_in(frame: Frame, at: Vec3) -> Pose {
    Pose {
        frame,
        position: if frame.slot.is_some() { Vec3::ZERO } else { at },
        orientation: Quat::IDENTITY,
        support: match frame.slot {
            Some(_) => Support::Slot,
            None => Support::Surface {
                surface: frame.node,
                height: 0,
            },
        },
    }
}

fn changes(cs: Vec<Change>) -> Body {
    Body::Changes(
        cs.into_iter()
            .map(|change| ChangeRec {
                change,
                rest: Rest::new(),
            })
            .collect(),
    )
}

/// The zone's header: its root is the ground, and it pins every kind the world defines.
fn header(kinds: &[String]) -> Header {
    let zone = ground_id();
    let v = Cbor::Map(BTreeMap::from([
        (
            1,
            Cbor::Bytes(Hash::of(Purpose::Fixture, b"souls/entry-v2/1").to_bytes()),
        ),
        (2, Cbor::Bytes(schema_hash().to_bytes())),
        (3, Cbor::Bytes(zone.scope().0.to_vec())),
        (4, zone.to_value()),
        (5, Cbor::Uint(0)),
        (
            6,
            Cbor::Array(
                kinds
                    .iter()
                    .filter_map(|k| Name::new(k))
                    .map(Cbor::Text)
                    .collect(),
            ),
        ),
        (7, Cbor::Array(Vec::new())),
    ]));
    Header::read(&encode(&v).expect("a header's bytes")).expect("a header")
}

/// The tree's role name of entry `kind`'s link `t`: `<namespace>:t`, as worldd names an entry's roles.
fn role_of(kind: &str, t: &str) -> String {
    format!("{}:{t}", kind.split_once(':').map_or("world", |(n, _)| n))
}

/// The activity kinds the entries' roles make (B10), as worldd serves them (`worldd::serve::activity_kinds`): one
/// for each entry with two roles (an offer takes two), each role holding its entry's link of its name on the entry's
/// own thing. Its pin here is the gate's own, not the served one.
fn role_kinds(kinds: &J) -> BTreeMap<String, ActivityKind> {
    let mut out = BTreeMap::new();
    for (kind, entry) in kinds.obj().unwrap_or(&[]) {
        let roles: Vec<&String> = entry
            .get("roles")
            .and_then(J::obj)
            .unwrap_or(&[])
            .iter()
            .filter(|(n, v)| n != "now" && v.obj().is_some())
            .map(|(n, _)| n)
            .collect();
        // An offer takes two roles: a kind of more (a frisbee's three) keeps the case's links as written.
        if roles.len() != 2 {
            continue;
        }
        let mut most = 0usize;
        let mut rs = Vec::new();
        for role in roles {
            let link = entry.get("links").and_then(|l| l.get(role));
            most += match link.and_then(|l| l.get("most")) {
                Some(J::Int(n)) => usize::try_from(*n).unwrap_or(1),
                _ => 1,
            };
            let from = link.and_then(|l| l.get("from")).and_then(J::str);
            rs.push(Role {
                name: name(&role_of(kind, role)),
                place: name("souls:here"),
                claims: vec![Want::One(Class::Manipulator)],
                mv: None,
                stands: Vec::new(),
                within: None,
                link: matches!(from, Some("body" | "soul")).then(|| RoleLink {
                    ty: name(&replica::audience::link_type(kind, role)),
                    soul: from == Some("soul"),
                    on: kind.clone(),
                    most: match link.and_then(|l| l.get("most")) {
                        Some(J::Int(n)) => u64::try_from(*n).ok(),
                        _ => None,
                    },
                }),
            });
        }
        let pin: String = Hash::of(
            Purpose::Fixture,
            format!("souls/entry-v2/activity/{kind}").as_bytes(),
        )
        .to_bytes()
        .iter()
        .skip(2)
        .map(|b| format!("{b:02x}"))
        .collect();
        out.insert(
            kind.clone(),
            ActivityKind {
                name: name(&format!("{kind}_activity@1220{pin}")),
                revision: 1,
                roles: rs,
                proposal_lasts: 60_000_000,
                leave_within: 400_000,
                most: most.max(2),
                beat: false,
                follows: None,
            },
        );
    }
    out
}

impl Stage {
    fn new() -> Stage {
        let g = ground();
        let mut c = Controller::new();
        let mut mint = Minter::new(Scope([0xe2; 16]));
        let body = mint.mint().expect("an id");
        let soul = Id::new(Scope([0xe5; 16]), 1).expect("an id");
        place(&mut c, &g, body, humanoid(), 0, 0).expect("placed");
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/moves");
        let (library, refused) = library(&dir).expect("content/moves");
        for r in refused {
            eprintln!("a move refused: {r}");
        }
        // The body's own moves into and out of a place, which content does not declare (B3's fixtures: sit, lie and
        // rise), as the served world adds them (`worldd::moves`): each fixture move whose name content has not.
        let mut moves = library.current();
        let own =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../v2/crates/replica/fixtures/moves");
        for m in load(&own).expect("B3's moves") {
            if !moves.iter().any(|c| c.name == m.name) {
                moves.push(m);
            }
        }
        let mut s = Stage {
            kinds: J::Obj(Vec::new()),
            k3: Kinds::default(),
            full: BTreeMap::new(),
            tree: Tree::start(ground_id(), name(PLACE)),
            rules: Rules::default(),
            header: header(&[]),
            surfaces: BTreeMap::from([(ground_id(), g)]),
            c,
            due: DueList::new(),
            mint,
            moves: Moves::new(),
            library: moves,
            snap: Snap::default(),
            forms: Forms::new(),
            now: 0,
            log: Vec::new(),
            body,
            soul,
            things: BTreeMap::new(),
            placed: 0,
            runs: BTreeMap::new(),
            refused: BTreeMap::new(),
            words: BTreeMap::new(),
            arranged: BTreeSet::new(),
            others: BTreeMap::new(),
            souls_of: BTreeMap::from([(body, soul)]),
            called: BTreeMap::new(),
            unapplied: 0,
            refused_by: BTreeMap::new(),
            scene_refused: Vec::new(),
            roles: BTreeMap::new(),
            acts: Activities::new(header(&[]), Rules::default(), 0, Vec::new()),
            acts_due: DueList::new(),
            slots: Slots::new(),
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
                places: Some(Places {
                    slots: &mut self.slots,
                    floors: &self.surfaces,
                }),
            },
            &mut self.forms,
        )
    }

    fn entry(&self, kind: &str) -> Option<&J> {
        self.kinds.get(kind)
    }

    /// The tree for the kinds just defined: the ground, the body on it (its hands its slots 1 and 2) and the body's
    /// link to its Soul. Every kind K3 loaded is pinned in the header and admitted as T2 reads it.
    fn build(&mut self) {
        let base = parse_kinds(include_str!(
            "../../../../v2/crates/replica/fixtures/world-model/kinds.diag"
        ))
        .expect("the fixtures' kinds");
        let mut admits = self.k3.admits();
        self.full = admits
            .keys()
            .chain(base.keys())
            .map(|k| (plain(k).to_owned(), k.clone()))
            .collect();
        admits.extend(base);
        let every: Vec<String> = admits.keys().map(|k| plain(k).to_owned()).collect();
        if let Some(root) = self.full.get(PLACE).and_then(|p| admits.get_mut(p)) {
            root.children.extend(every);
        }
        // B10: each entry's activity is pinned, and its own thing takes it as a child, as worldd serves it.
        self.roles = role_kinds(&self.kinds);
        for (kind, a) in &self.roles {
            admits.insert(
                a.name.as_str().to_owned(),
                replica::world_model::Kind {
                    owner: "activity".into(),
                    children: Default::default(),
                    slots: Default::default(),
                    hands: None,
                    fields: Default::default(),
                },
            );
            if let Some(t) = self.full.get(kind).and_then(|f| admits.get_mut(f)) {
                t.children.insert(plain(a.name.as_str()).to_owned());
            }
        }
        let pinned: Vec<String> = admits.keys().cloned().collect();
        self.header = header(&pinned);
        self.rules = Rules {
            kinds: admits,
            souls: BTreeSet::from([self.soul]),
            audiences: BTreeMap::new(),
        };
        self.acts = Activities::new(
            self.header.clone(),
            self.rules.clone(),
            0,
            self.roles.values().cloned().collect(),
        );
        let place = self.full[PLACE].clone();
        self.tree = Tree::start(ground_id(), name(&place));
        self.slots = Slots::new();
        self.forms.zone(self.header.clone());
        let at = self.body_at();
        let body = self.full[BODY].clone();
        let link = self.mint.mint().expect("an id");
        let made = self.write(vec![
            Change::Create {
                node: self.body,
                kind: name(&body),
                pose: pose_in(
                    Frame {
                        node: ground_id(),
                        slot: None,
                    },
                    at,
                ),
                audience: Audience::Everyone,
                fields: BTreeMap::new(),
            },
            Change::Link {
                link,
                ty: name(BODY_OF),
                ends: [self.body, self.soul],
                owner: End::First,
                audience: Audience::Everyone,
            },
        ]);
        if let Err(r) = made {
            eprintln!("the body could not be made: {}: {}", r.name, r.detail);
        }
    }

    /// Entries committed to the tree as one part (T2's checks), numbered as the tree's sequence runs.
    fn apply_to_tree(&mut self, es: &[Effect]) -> Result<(), Refusal> {
        if es.is_empty() {
            return Ok(());
        }
        let numbered: Vec<Cbor> = es
            .iter()
            .zip(self.tree.next()..)
            .map(|(e, s)| {
                let mut e = e.clone();
                e.envelope.sequence = s;
                e.to_value()
            })
            .collect();
        let bytes = encode(&Cbor::Map(BTreeMap::from([
            (1, Cbor::Bytes(self.header.hash().to_bytes())),
            (2, Cbor::Array(numbered)),
        ])))
        .map_err(|e| Refusal {
            name: "encoding",
            detail: e.to_string(),
        })?;
        let part = Part::read(&bytes)?;
        self.tree.commit(&self.header, &part, &self.rules)
    }

    /// The world's own entries (a creator's: placing, setting, removing, the case's scene) at node `node`: to the
    /// tree, then the log. Refused whole when the tree refuses them.
    /// Each change is an entry of the node it changes (a create its parent's, a link its owning end's), as the
    /// tree checks it.
    fn write(&mut self, cs: Vec<Change>) -> Result<(), Refusal> {
        let at = |c: &Change| match c {
            Change::Create { pose, .. } => pose.frame.node,
            Change::Remove { node } | Change::Set { node, .. } | Change::Reparent { node, .. } => {
                *node
            }
            Change::Link { ends, owner, .. } => match owner {
                End::First => ends[0],
                End::Second => ends[1],
            },
            Change::Unlink { link } => {
                self.tree
                    .link(*link)
                    .map_or(ground_id(), |(_, ends, owner, _)| match owner {
                        End::First => ends[0],
                        End::Second => ends[1],
                    })
            }
            Change::Motion(_) => ground_id(),
        };
        let bodies = cs
            .into_iter()
            .map(|c| (at(&c), Audience::Everyone, changes(vec![c])))
            .collect();
        self.write_bodies(bodies)
    }

    fn write_bodies(&mut self, bodies: Vec<(Id, Audience, Body)>) -> Result<(), Refusal> {
        let now = self.now;
        let es: Vec<Effect> = bodies
            .into_iter()
            .map(|(node, audience, body)| Effect {
                envelope: Envelope {
                    sequence: 0,
                    at: now,
                    cause: Cause::World,
                    actor: Actor::Creator(fixture(9)),
                    audience,
                    node,
                },
                body,
                events: None,
                rest: Rest::new(),
            })
            .collect();
        self.apply_to_tree(&es)?;
        for e in es {
            self.commit(e);
        }
        Ok(())
    }

    /// The commit point: an entry numbered, handed back to the forms as logged, its sets read into the things' fields.
    fn commit(&mut self, mut e: Effect) {
        e.envelope.sequence = self.log.len() as u64 + 1;
        self.forms.logged(&e);
        for rec in e.changes() {
            match &rec.change {
                Change::Set {
                    node, field, to, ..
                } => self.read_set(*node, *field, to),
                // A thing a form made, and the tree took, is kept by a name of its own, so the case's state can name
                // it and its fields are read back from the tree. A create the tree refused is only in the log.
                Change::Create { node, kind, .. }
                    if plain(kind.as_str()) != BODY && self.tree.handle(*node).is_some() =>
                {
                    let kind = plain(kind.as_str()).to_owned();
                    let fields = self.defaults(&kind);
                    self.placed += 1;
                    self.things.insert(
                        format!("m{}", self.placed),
                        Thing {
                            id: *node,
                            kind,
                            fields,
                        },
                    );
                }
                _ => {}
            }
        }
        self.log.push(e);
    }

    fn read_set(&mut self, node: Id, field: u64, to: &Cbor) {
        let Some(t) = self.things.values().find(|t| t.id == node) else {
            return;
        };
        let Some(state) = self
            .kinds
            .get(&t.kind)
            .and_then(|e| e.get("state"))
            .and_then(J::obj)
        else {
            return;
        };
        let Some((fname, def)) = state
            .iter()
            .find(|(_, d)| matches!(d.get("n"), Some(J::Int(n)) if *n == i128::from(field)))
        else {
            return;
        };
        let v = self.json_of(def, to);
        let fname = fname.clone();
        let key = self
            .things
            .iter()
            .find(|(_, t)| t.id == node)
            .map(|(k, _)| k.clone());
        if let Some(t) = key.and_then(|k| self.things.get_mut(&k)) {
            set_key(&mut t.fields, &fname, v);
        }
    }

    /// A field's value as the case writes it, from the tree's: a bool by 0 or 1, an enum by its bare name, words by
    /// their reference.
    fn json_of(&self, def: &J, to: &Cbor) -> J {
        match (def.get("type").and_then(J::str), to) {
            (Some("bool"), Cbor::Uint(u)) => J::Bool(*u != 0),
            (_, Cbor::Uint(u)) => J::Int(i128::from(*u)),
            (_, Cbor::Nint(n)) => J::Int(-1 - i128::from(*n)),
            // An enum's value by name (F14), and words by their reference, as the case gave them.
            // An enum's value is logged in the kind's namespace (C24, `eden:level1`); the case names it bare.
            (Some("enum"), Cbor::Text(n)) => J::Str(
                n.as_str()
                    .split_once(':')
                    .map_or(n.as_str(), |(_, b)| b)
                    .to_owned(),
            ),
            (_, Cbor::Text(n)) => J::Str(n.as_str().to_owned()),
            (Some("text"), r) => replica::audience::reference(r)
                .and_then(|id| self.words.get(&id))
                .map_or(J::Null, |w| J::Str(w.clone())),
            // A list's records, each by the record's field names in the order of `of`.
            (Some("list"), Cbor::Array(records)) => {
                let of = def.get("of").and_then(J::obj).unwrap_or(&[]);
                J::Arr(
                    records
                        .iter()
                        .map(|r| {
                            let Cbor::Map(m) = r else { return J::Null };
                            J::Obj(
                                (1u64..)
                                    .zip(of)
                                    .filter_map(|(i, (k, d))| {
                                        Some((k.clone(), self.json_of(d, m.get(&i)?)))
                                    })
                                    .collect(),
                            )
                        })
                        .collect(),
                )
            }
            _ => J::Null,
        }
    }

    /// A thing's fields as the tree holds them. A field the tree does not hold (a timed or schedule field, or one K3
    /// refused) is read from what the case set, since the tree cannot show it. None once it is gone.
    fn tree_fields(&self, t: &Thing) -> Option<Vec<(String, J)>> {
        let node = self.tree.node(self.tree.handle(t.id)?)?;
        let state = self
            .entry(&t.kind)
            .and_then(|e| e.get("state"))
            .and_then(J::obj)
            .unwrap_or(&[]);
        Some(
            state
                .iter()
                .map(|(k, def)| {
                    let n = match def.get("n") {
                        Some(J::Int(n)) => u64::try_from(*n).ok(),
                        _ => None,
                    };
                    let held = n.and_then(|n| node.fields().get(&n));
                    let own = || {
                        t.fields
                            .iter()
                            .find(|(f, _)| f == k)
                            .map_or(J::Null, |(_, v)| v.clone())
                    };
                    let v = held.map_or_else(own, |v| self.json_of(def, v));
                    (k.clone(), v)
                })
                .collect(),
        )
    }

    /// The forms' entries: to the tree as one part, then each to the log. An entry the tree refuses is still logged
    /// (the forms count on it), and counted.
    fn flush(&mut self) {
        let out = std::mem::take(&mut self.forms.out);
        if let Err(r) = self.apply_to_tree(&out) {
            self.unapplied += out.len() as u64;
            let intents: BTreeSet<Id> = out
                .iter()
                .filter_map(|e| match e.envelope.cause {
                    Cause::Intent(i) => Some(i),
                    _ => None,
                })
                .collect();
            for i in intents {
                self.refused_by
                    .entry(i)
                    .or_default()
                    .push(format!("{}: {}", r.name, r.detail));
            }
            eprintln!(
                "the tree refused a form's entries: {}: {}",
                r.name, r.detail
            );
        }
        for e in out {
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
        self.follow_seats();
    }

    /// Each body's place in the tree follows its seat, as a served world writes a body's new frame from its motion
    /// (`worldd`'s motion entries, #3799): a body a seat's hand-off put in a slot, or a rise set back on the ground, is
    /// transferred there, so the rules and the reads see it where it sits.
    fn follow_seats(&mut self) {
        let moved: Vec<(Id, Frame)> = self
            .souls_of
            .keys()
            .filter_map(|b| {
                let to = self.c.body(*b)?.pose.frame;
                let n = self.tree.node(self.tree.handle(*b)?)?;
                let at = Frame {
                    node: n.parent()?,
                    slot: n.slot(),
                };
                (at != to).then_some((*b, to))
            })
            .collect();
        for (b, to) in moved {
            let Ok(t) = self.mint.mint() else { return };
            let bodies = transfer(&self.header, b, Audience::Everyone, to, t)
                .into_iter()
                .collect();
            if let Err(r) = self.write_bodies(bodies) {
                eprintln!(
                    "a body's seat could not be followed: {}: {}",
                    r.name, r.detail
                );
            }
        }
    }

    /// The name intent `id`'s run ended with, from the log.
    fn ended(&self, id: Id) -> Option<String> {
        // From the run's first entry on: the log of a long gate run is long.
        let from = self
            .runs
            .values()
            .find(|r| r.intent == id)
            .map_or(0, |r| r.from)
            .min(self.log.len());
        self.log[from..]
            .iter()
            .filter(|e| e.envelope.cause == Cause::Intent(id))
            .flat_map(|e| e.events.iter().flatten())
            .filter(|v| v.name.as_str() == "souls:form-ended")
            .map(|v| match v.fields.get(&3) {
                // F4 (#2769) writes an ending in the `souls` namespace; the gate reads its plain name.
                Some(Cbor::Text(n)) => n.as_str().trim_start_matches("souls:").to_owned(),
                // The runner now writes the name as its bytes (#3646's durable text rule).
                Some(Cbor::Bytes(b)) => String::from_utf8_lossy(b)
                    .trim_start_matches("souls:")
                    .to_owned(),
                _ => "(unnamed)".into(),
            })
            .next()
    }

    fn body_at(&self) -> Vec3 {
        self.c
            .body(self.body)
            .map_or(Vec3::ZERO, |b| b.pose.position)
    }

    /// A kind's fields at their defaults, as the entry writes them.
    fn defaults(&self, kind: &str) -> Vec<(String, J)> {
        self.entry(kind)
            .and_then(|e| e.get("state"))
            .and_then(J::obj)
            .unwrap_or(&[])
            .iter()
            .map(|(k, d)| (k.clone(), d.get("default").cloned().unwrap_or(J::Null)))
            .collect()
    }

    fn place(&mut self, kind: &str) -> J {
        if self.entry(kind).is_none() {
            return err(format!("{kind} is not defined"));
        }
        let Some(full) = self.full.get(kind).cloned() else {
            return err(format!("{kind} was not loaded (K3 refused it)"));
        };
        let fields = self.defaults(kind);
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
        let start = self.start_fields(&full);
        let made = self.write(vec![Change::Create {
            node: id,
            kind: name(&full),
            pose: pose_in(
                Frame {
                    node: ground_id(),
                    slot: None,
                },
                at,
            ),
            audience: Audience::Everyone,
            fields: start,
        }]);
        if let Err(r) = made {
            return err(format!(
                "{kind} could not be placed: {}: {}",
                r.name, r.detail
            ));
        }
        self.placed += 1;
        let key = format!("x{}", self.placed);
        self.snap.things.insert(id, at);
        self.seat(id);
        // The create was read as a form's make: it is the gate's thing, by the gate's key.
        self.things.retain(|_, t| t.id != id);
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

    /// Thing `id`'s seats, where it stands now, registered as a served world registers them (C17, #3453; a god edit's
    /// placed thing, `worldd::edit_places`): each slot admitting a body that its entry declares
    /// ([`import_eden::body_slots_of`]: the entry it names, else its kind's), its point and facing carried up the tree
    /// onto the ground ([`sim::ground::scene::xform_to`]), its stand point in the slot's frame. Open ground has no
    /// solid, so no stand point is moved. A thing that is gone has none; one whose seat is held keeps its places.
    fn seat(&mut self, id: Id) {
        let tree = &self.tree;
        let found = tree
            .handle(id)
            .zip(tree.handle(ground_id()))
            .and_then(|(h, g)| {
                let n = tree.node(h)?;
                let entry = import_eden::entry_name(n.kind().as_str(), n.fields());
                let x = sim::ground::scene::xform_to(tree, h, g).ok()?;
                let slots = import_eden::body_slots_of(
                    id,
                    n.kind().as_str(),
                    n.fields(),
                    &[(entry.to_owned(), self.kinds.get(entry)?.clone())],
                );
                Some((slots, x))
            });
        let places = found.map_or_else(Vec::new, |(slots, x)| {
            slots
                .into_iter()
                .filter_map(|s| {
                    Some(PlaceAt {
                        thing: id,
                        place: replica::moves::Place {
                            slot: s.slot,
                            height: s.at.y.max(0),
                            stand: [s.stand.x - s.at.x, s.stand.z - s.at.z],
                        },
                        point: x.point(s.at).ok()?,
                        facing: x.rot,
                        floor: ground_id(),
                    })
                })
                .collect()
        });
        let _ = self.slots.replace(id, places);
    }

    /// `body` out of the seat it holds (or is taking or leaving) and standing on the ground at that seat's stand point,
    /// in the tree as on its feet: how a case leaves the body for the next, as a retirement releases a seat (K10).
    fn stand_up(&mut self, body: Id) {
        let stand = self.slots.held_place(body).and_then(|p| p.stand().ok());
        if let Some((_, under_way)) = self.slots.release_body(body) {
            if let Some(i) = under_way {
                let _ = self
                    .moves
                    .cancel(&mut self.c, &mut self.due, i, self.now, name("left"));
            }
            let at = stand.unwrap_or(Vec3::ZERO);
            self.c.remove(body);
            if let Err(e) = place(
                &mut self.c,
                &self.surfaces[&ground_id()],
                body,
                humanoid(),
                at.x / 1000,
                at.z / 1000,
            ) {
                eprintln!("a seated body could not stand: {e}");
            }
            self.look();
        }
        let on = self
            .tree
            .handle(body)
            .and_then(|h| self.tree.node(h))
            .and_then(|n| n.parent());
        if on.is_some_and(|p| p != ground_id())
            && let Ok(t) = self.mint.mint()
        {
            let ground = Frame {
                node: ground_id(),
                slot: None,
            };
            let bodies = transfer(&self.header, body, Audience::Everyone, ground, t)
                .into_iter()
                .collect();
            if let Err(r) = self.write_bodies(bodies) {
                eprintln!(
                    "a seated body could not be set down: {}: {}",
                    r.name, r.detail
                );
            }
        }
    }

    /// The fields a placed thing starts with in the tree: K3's defaults, an enum's value in the kind's namespace (as
    /// the forms write it, C24), and no text, whose words this runner keeps itself.
    fn start_fields(&self, full: &str) -> BTreeMap<u64, Cbor> {
        let Some(def) = self.k3.get(full) else {
            return BTreeMap::new();
        };
        let ns = plain(full).split(':').next().unwrap_or_default().to_owned();
        fn named(ns: &str, v: Cbor) -> Cbor {
            match v {
                Cbor::Text(t) if !t.as_str().contains(':') => {
                    Name::new(&format!("{ns}:{}", t.as_str())).map_or(Cbor::Text(t), Cbor::Text)
                }
                Cbor::Array(a) => Cbor::Array(a.into_iter().map(|x| named(ns, x)).collect()),
                Cbor::Map(m) => Cbor::Map(m.into_iter().map(|(k, x)| (k, named(ns, x))).collect()),
                v => v,
            }
        }
        def.state
            .iter()
            .filter(|(_, f)| !matches!(f.ty, replica::kinds::Type::Text { .. }))
            .map(|(n, f)| (*n, named(&ns, f.default.clone())))
            .collect()
    }

    /// A field's value as the tree holds it, from the case's JSON: a bool as 0 or 1, an enum by its namespaced name,
    /// words kept here by reference. A list or other field the case cannot write is left as it is.
    fn cbor_of(&mut self, kind: &str, field: &str, v: &J) -> Option<(u64, Cbor)> {
        let full = self.full.get(kind)?;
        let def = self.k3.get(full)?;
        let (n, f) = def.state.iter().find(|(_, f)| f.name.as_str() == field)?;
        use replica::kinds::Type;
        let value = match (&f.ty, v) {
            (Type::Bool, J::Bool(b)) => Cbor::Uint(u64::from(*b)),
            (Type::Bool | Type::Int | Type::Duration, J::Int(i)) if *i >= 0 => {
                Cbor::Uint(u64::try_from(*i).ok()?)
            }
            (Type::Int, J::Int(i)) => Cbor::Nint(u64::try_from(-1 - *i).ok()?),
            (Type::Enum(values), J::Str(s)) => {
                let bare = s.split_once(':').map_or(s.as_str(), |(_, b)| b);
                values.iter().find(|x| plain_value(x.as_str()) == bare)?;
                let ns = full.split(':').next().unwrap_or_default();
                Cbor::Text(Name::new(&format!("{ns}:{bare}"))?)
            }
            (Type::Text { .. }, J::Str(words)) => {
                let id = Id::new(Scope([0xe4; 16]), self.words.len() as u64 + 1)?;
                self.words.insert(id, words.clone());
                Cbor::Map(BTreeMap::from([(
                    replica::audience::REFERENCE,
                    id.to_value(),
                )]))
            }
            (Type::Text { .. }, J::Null) => Cbor::Map(BTreeMap::new()),
            // A list's records, each an object by the record's field names, as maps numbered 1, 2, ... in the order
            // of `of` (F11).
            (Type::List { of, .. }, J::Arr(records)) => {
                let ns = full.split(':').next().unwrap_or_default();
                let record = |r: &J| -> Option<Cbor> {
                    let mut m = BTreeMap::new();
                    for (i, (fname, ty)) in (1u64..).zip(of) {
                        let x = match (ty, r.get(fname.as_str())?) {
                            (Type::Bool, J::Bool(b)) => Cbor::Uint(u64::from(*b)),
                            (Type::Bool | Type::Int | Type::Duration, J::Int(i)) if *i >= 0 => {
                                Cbor::Uint(u64::try_from(*i).ok()?)
                            }
                            (Type::Int, J::Int(i)) => Cbor::Nint(u64::try_from(-1 - *i).ok()?),
                            (Type::Enum(_), J::Str(s)) => {
                                let bare = s.split_once(':').map_or(s.as_str(), |(_, b)| b);
                                Cbor::Text(Name::new(&format!("{ns}:{bare}"))?)
                            }
                            _ => return None,
                        };
                        m.insert(i, x);
                    }
                    Some(Cbor::Map(m))
                };
                Cbor::Array(records.iter().map(record).collect::<Option<_>>()?)
            }
            _ => return None,
        };
        Some((*n, value))
    }

    fn set(&mut self, key: &str, fields: &[(String, J)]) -> J {
        let Some(t) = self.things.get(key) else {
            return err("no such thing");
        };
        let (id, kind) = (t.id, t.kind.clone());
        let mut sets = Vec::new();
        for (k, v) in fields {
            if let Some((field, to)) = self.cbor_of(&kind, k, v) {
                sets.push(Change::Set {
                    node: id,
                    field,
                    to,
                    by: None,
                });
            }
        }
        if self.tree.handle(id).is_some()
            && let Err(r) = self.write(sets)
        {
            return err(format!(
                "the fields could not be set: {}: {}",
                r.name, r.detail
            ));
        }
        if let Some(t) = self.things.get_mut(key) {
            for (k, v) in fields {
                set_key(&mut t.fields, k, v.clone());
            }
        }
        obj(vec![])
    }

    fn remove(&mut self, key: &str) -> J {
        let Some(t) = self.things.remove(key) else {
            return err(format!("no thing {key}"));
        };
        let now = self.now;
        // Whoever sits on it stands first, so the body is not removed with it (T2 rule 3); its seats go with it.
        let on_it: Vec<Id> = self
            .souls_of
            .keys()
            .copied()
            .filter(|b| {
                self.slots.held_by(*b) == Some(t.id)
                    || self
                        .tree
                        .handle(*b)
                        .and_then(|h| self.tree.node(h))
                        .and_then(|n| n.parent())
                        == Some(t.id)
            })
            .collect();
        for b in on_it {
            self.stand_up(b);
        }
        let _ = self.slots.replace(t.id, Vec::new());
        // Gone already when a form took it (a removal, or under a thing removed): the log says so, the tree has it not.
        if self.tree.handle(t.id).is_some()
            && let Err(r) = self.write(vec![Change::Remove { node: t.id }])
        {
            return err(format!(
                "{key} could not be removed: {}: {}",
                r.name, r.detail
            ));
        }
        self.snap.things.remove(&t.id);
        self.arranged.remove(&t.id);
        // What was in it went with it (T2 rule 3).
        let tree = &self.tree;
        self.things.retain(|_, x| tree.handle(x.id).is_some());
        let (mut w, forms) = self.world();
        forms.gone(&mut w, t.id, now);
        self.flush();
        obj(vec![])
    }

    /// What a case leaves behind taken away, so the next starts as the first: what the body holds, the other
    /// bodies the case named (and what they hold), and the body's and its Soul's links but its own.
    fn reset(&mut self) -> J {
        if let Err(why) = self.leave_activities() {
            return err(format!("the case's activities could not be left: {why}"));
        }
        let bodies: Vec<Id> = std::mem::take(&mut self.others)
            .into_iter()
            .filter(|(k, id)| k.starts_with("body:") && *id != self.body)
            .map(|(_, id)| id)
            .collect();
        // The body stands up from any seat the case left it in; the other bodies give theirs up as they go.
        self.stand_up(self.body);
        for b in &bodies {
            if let Some((_, Some(i))) = self.slots.release_body(*b) {
                let _ = self
                    .moves
                    .cancel(&mut self.c, &mut self.due, i, self.now, name("left"));
            }
        }
        self.souls_of.retain(|b, _| *b == self.body);
        self.called.clear();
        self.scene_refused.clear();
        let mut gone: Vec<Id> = self.held(self.body).into_iter().map(|(_, t)| t).collect();
        for b in &bodies {
            gone.extend(self.held(*b).into_iter().map(|(_, t)| t));
            self.c.remove(*b);
        }
        gone.extend(bodies.iter().copied());
        gone.retain(|id| self.tree.handle(*id).is_some());
        let links: Vec<Id> = [self.body, self.soul]
            .iter()
            .flat_map(|e| self.tree.links_at(*e).iter())
            .filter(|e| self.tree.ty(e).as_str() != BODY_OF)
            .map(|e| e.link)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut cs: Vec<Change> = links
            .into_iter()
            .map(|link| Change::Unlink { link })
            .collect();
        cs.extend(gone.iter().map(|node| Change::Remove { node: *node }));
        if let Err(r) = self.write(cs) {
            return err(format!(
                "the case could not be cleared: {}: {}",
                r.name, r.detail
            ));
        }
        self.things.retain(|_, t| !gone.contains(&t.id));
        for id in gone {
            self.snap.things.remove(&id);
            self.arranged.remove(&id);
        }
        self.look();
        obj(vec![])
    }

    /// The engine's activities given the world as it stands, then their entries logged.
    fn with_acts<T>(
        &mut self,
        f: impl FnOnce(&mut Self) -> Result<T, Refusal>,
    ) -> Result<T, String> {
        self.acts.next = self.tree.next();
        self.acts.rules = self.rules.clone();
        let r = f(self);
        for e in std::mem::take(&mut self.acts.stream) {
            self.commit(e);
        }
        r.map_err(|r| format!("{}: {}", r.name, r.detail))
    }

    fn asking(&mut self, body: Id) -> Asking {
        Asking {
            soul: self.souls_of.get(&body).copied().unwrap_or(self.soul),
            intent: self.mint.mint().unwrap_or(self.soul),
            at: self.now,
        }
    }

    /// B10: the case's members of `thing`'s activity take their roles as a world's Souls do: the first role's first
    /// end offers it at the thing to the other role's ends, and each accepts. A side the case leaves empty is filled
    /// by a stand-in body that leaves once the others are in, so its link is gone again. The engine writes each
    /// member's role link (`sim::activity`); none is written here.
    fn take_roles(
        &mut self,
        thing: Id,
        kind: &str,
        seats: &[(String, Vec<Id>)],
    ) -> Result<(), String> {
        let Some(a) = self.roles.get(kind).cloned() else {
            return Ok(());
        };
        if seats.iter().all(|(_, e)| e.is_empty()) {
            return Ok(());
        }
        let [r1, r2] = &a.roles[..] else {
            return Err(format!(
                "{kind}: {} roles; an offer takes two",
                a.roles.len()
            ));
        };
        let ends = |r: &Role| {
            seats
                .iter()
                .find(|(n, _)| *n == r.name.as_str())
                .map_or_else(Vec::new, |(_, e)| e.clone())
        };
        let (first, second) = (ends(r1), ends(r2));
        if first.len() > 1 {
            return Err(format!(
                "{} has {} members; the one who offers takes it alone",
                r1.name.as_str(),
                first.len()
            ));
        }
        let mut stand_ins = Vec::new();
        let asker = match first.first() {
            Some(b) => *b,
            None => {
                let b = self.stand_in("stand-in-1");
                stand_ins.push(b);
                b
            }
        };
        let asked: Vec<Id> = match second.is_empty() {
            false => second,
            true => {
                let b = self.stand_in("stand-in-2");
                stand_ins.push(b);
                vec![b]
            }
        };
        let ask = self.asking(asker);
        let (kname, rname) = (a.name.clone(), r1.name.clone());
        let to: BTreeSet<Id> = asked.iter().copied().collect();
        let offer = self.with_acts(|s| {
            s.acts.offer(
                &mut s.tree,
                &mut s.mint,
                &mut s.acts_due,
                ask,
                asker,
                &kname,
                &rname,
                thing,
                to,
                None,
            )
        })?;
        for b in asked {
            let ask = self.asking(b);
            self.with_acts(|s| {
                s.acts.accept(
                    &mut s.tree,
                    &mut s.mint,
                    &mut s.c,
                    &mut s.acts_due,
                    ask,
                    b,
                    offer,
                )
            })?;
        }
        for b in stand_ins {
            let ask = self.asking(b);
            self.with_acts(|s| {
                s.acts.leave(
                    &mut s.tree,
                    &mut s.c,
                    &mut s.moves,
                    &mut s.acts_due,
                    &mut s.mint,
                    ask,
                    b,
                    offer,
                )
            })?;
        }
        Ok(())
    }

    /// A body of the gate's own standing beside this one, with its Soul: a role's stand-in (B10).
    fn stand_in(&mut self, n: &str) -> Id {
        let id = self.other(n, true);
        if !self.souls_of.contains_key(&id) {
            let sid = self.other(&format!("{n}'s soul"), false);
            if let Ok(link) = self.mint.mint() {
                let _ = self.write(vec![Change::Link {
                    link,
                    ty: name(BODY_OF),
                    ends: [id, sid],
                    owner: End::First,
                    audience: Audience::Everyone,
                }]);
            }
            self.souls_of.insert(id, sid);
        }
        id
    }

    /// Every member of every activity leaves it (B10): a case's roles end with the case.
    fn leave_activities(&mut self) -> Result<(), String> {
        for act in self.acts.ids() {
            let members: Vec<(Id, Id)> = self
                .acts
                .members(act)
                .unwrap_or(&[])
                .iter()
                .map(|m| (m.body, m.soul))
                .collect();
            for (body, soul) in members {
                let ask = Asking {
                    soul,
                    intent: self.mint.mint().unwrap_or(soul),
                    at: self.now,
                };
                self.with_acts(|s| {
                    s.acts.leave(
                        &mut s.tree,
                        &mut s.c,
                        &mut s.moves,
                        &mut s.acts_due,
                        &mut s.mint,
                        ask,
                        body,
                        act,
                    )
                })?;
            }
        }
        // A leave lets a body in a move go at the move's next phase end: let every one go now.
        while let Some(t) = self.acts_due.fire(Micros::MAX) {
            self.acts
                .fire(&mut self.c, &mut self.moves, &mut self.acts_due, &t);
        }
        Ok(())
    }

    /// The things in `body`'s hands, by hand.
    fn held(&self, body: Id) -> Vec<(&'static str, Id)> {
        HANDS
            .iter()
            .filter_map(|(h, s)| sim::slots::hands::in_slot(&self.tree, body, *s).map(|t| (*h, t)))
            .collect()
    }

    /// The case's names for the world: its things as placed (`ids`), its bodies (the first actor it names is this
    /// body; each other body is one of its own here, standing beside it, kept until the case is cleared) and their
    /// Souls, and every other Soul a link names.
    fn names(&mut self, case: &J, ids: &J) -> Names {
        let mut out = Names::default();
        let nodes = case
            .get("state")
            .and_then(|s| s.get("nodes"))
            .and_then(J::obj)
            .unwrap_or(&[]);
        let actor = case
            .get("state")
            .and_then(|s| s.get("actor"))
            .and_then(J::str)
            .unwrap_or("b1")
            .to_owned();
        for (nid, key) in ids.obj().unwrap_or(&[]) {
            if let Some(t) = key.str().and_then(|k| self.things.get(k)) {
                out.add(nid, t.id);
            }
        }
        // A node with neither kind nor hands (a room things stand loose in) is the ground.
        if let Some((room, _)) = nodes
            .iter()
            .find(|(_, n)| n.get("kind").is_none() && n.get("hands").is_none())
        {
            out.add(room, ground_id());
        }
        if !self.others.values().any(|id| *id == self.body) {
            self.others.insert(format!("body:{actor}"), self.body);
        }
        // A body's Soul: its `soul` link, else the cases' own naming (`s1` for `b1`, `sw` for `w`).
        let soul_of =
            |b: &str, n: &J| match strs(n.get("links").and_then(|l| l.get("soul"))).as_slice() {
                [s] => s.clone(),
                _ => {
                    let s = format!("s{}", b.strip_prefix('b').unwrap_or(b));
                    if nodes.iter().any(|(k, _)| *k == s) {
                        format!("{b}'s soul")
                    } else {
                        s
                    }
                }
            };
        let mut bodies: Vec<(String, String)> = nodes
            .iter()
            .filter(|(k, n)| *k == actor || (n.get("hands").is_some() && n.get("kind").is_none()))
            .map(|(k, n)| (k.clone(), soul_of(k, n)))
            .collect();
        // B10: an end of a role's link is a member's body: it takes its role by an accept, so it is a body here.
        for (_, n) in nodes {
            let kind = n.get("kind").and_then(J::str).unwrap_or_default();
            let Some(a) = self.roles.get(kind) else {
                continue;
            };
            for (t, ends) in n.get("links").and_then(J::obj).unwrap_or(&[]) {
                if !a.roles.iter().any(|r| role_of(kind, t) == r.name.as_str()) {
                    continue;
                }
                for e in strs(Some(ends)) {
                    if !nodes.iter().any(|(k, _)| *k == e) && !bodies.iter().any(|(b, _)| *b == e) {
                        let s = soul_of(&e, &J::Null);
                        bodies.push((e, s));
                    }
                }
            }
        }
        for (b, s) in bodies {
            let id = self.other(&b, true);
            out.add(&b, id);
            let sid = match self.souls_of.get(&id) {
                Some(sid) => *sid,
                None => {
                    let sid = self.other(&s, false);
                    if let Ok(link) = self.mint.mint() {
                        let linked = self.write(vec![Change::Link {
                            link,
                            ty: name(BODY_OF),
                            ends: [id, sid],
                            owner: End::First,
                            audience: Audience::Everyone,
                        }]);
                        if let Err(r) = linked {
                            eprintln!(
                                "a case's body could not be linked to its Soul: {}: {}",
                                r.name, r.detail
                            );
                        }
                    }
                    self.souls_of.insert(id, sid);
                    sid
                }
            };
            self.others.insert(format!("soul:{s}"), sid);
            out.add(&s, sid);
        }
        // Any other end a link names is a Soul.
        for (_, n) in nodes {
            for (_, ends) in n.get("links").and_then(J::obj).unwrap_or(&[]) {
                for e in strs(Some(ends)) {
                    if !out.to_id.contains_key(&e) && !nodes.iter().any(|(k, _)| *k == e) {
                        let sid = self.other(&e, false);
                        out.add(&e, sid);
                    }
                }
            }
        }
        out
    }

    /// The other body or Soul the case calls `n`: made the first time, kept until the case is cleared. A body
    /// stands a metre beside this one.
    fn other(&mut self, n: &str, body: bool) -> Id {
        let key = format!("{}{n}", if body { "body:" } else { "soul:" });
        if let Some(id) = self.others.get(&key) {
            return *id;
        }
        let Ok(id) = self.mint.mint() else {
            return self.soul;
        };
        if body {
            let kind = self.full[BODY].clone();
            let b = self.body_at();
            let at = Vec3::new(b.x, 0, b.z + if b.z > 0 { -1_000_000 } else { 1_000_000 });
            let g = ground();
            if let Err(e) = place(&mut self.c, &g, id, humanoid(), at.x / 1000, at.z / 1000) {
                eprintln!("a case's body could not stand: {e}");
            }
            let made = self.write(vec![Change::Create {
                node: id,
                kind: name(&kind),
                pose: pose_in(
                    Frame {
                        node: ground_id(),
                        slot: None,
                    },
                    at,
                ),
                audience: Audience::Everyone,
                fields: BTreeMap::new(),
            }]);
            if let Err(r) = made {
                eprintln!("a case's body could not be made: {}: {}", r.name, r.detail);
            }
            self.look();
        } else {
            self.rules.souls.insert(id);
        }
        self.others.insert(key, id);
        id
    }

    /// The case's scene set in the tree, for each of its things not set yet: where it is (in a body's hand, a
    /// holder's slot or as a holder's child, else on the ground), and its links, exactly the case's.
    fn arrange(&mut self, case: &J, ids: &J) -> Result<Names, String> {
        let names = self.names(case, ids);
        let nodes: Vec<(String, J)> = case
            .get("state")
            .and_then(|s| s.get("nodes"))
            .and_then(J::obj)
            .unwrap_or(&[])
            .to_vec();
        let fresh: Vec<(String, Id)> = names
            .to_id
            .iter()
            .filter(|(n, id)| {
                nodes
                    .iter()
                    .any(|(k, nd)| k == *n && nd.get("kind").is_some())
                    && self.things.values().any(|t| t.id == **id)
                    && !self.arranged.contains(id)
            })
            .map(|(n, id)| (n.clone(), *id))
            .collect();
        // A thing the tree will not hold where the case has it (a slot that does not admit it: what the case tests)
        // is left where it stands, and the rules decide on the case's own scene for it, as before the tree.
        let mut unset: BTreeSet<Id> = BTreeSet::new();
        for (n, id) in &fresh {
            // Where the case puts it.
            let mut frame = Frame {
                node: ground_id(),
                slot: None,
            };
            for (holder, h) in &nodes {
                let Some(hid) = names.to_id.get(holder).copied() else {
                    continue;
                };
                let body = self.souls_of.contains_key(&hid);
                let thing = hid == ground_id() || self.things.values().any(|t| t.id == hid);
                if body
                    && let Some((_, s)) = HANDS.iter().find(|(hand, _)| {
                        h.get("hands").and_then(|x| x.get(hand)).and_then(J::str) == Some(n)
                    })
                {
                    frame = Frame {
                        node: hid,
                        slot: Some(*s),
                    };
                }
                for (slot, list) in h
                    .get("slots")
                    .and_then(J::obj)
                    .unwrap_or(&[])
                    .iter()
                    .filter(|_| thing)
                {
                    let inside = strs(Some(list)).contains(n) || list.str() == Some(n);
                    let kind = h.get("kind").and_then(J::str).unwrap_or_default();
                    if let (true, Some(s)) =
                        (inside, self.entry(kind).and_then(|e| slot_n(e, slot)))
                    {
                        frame = Frame {
                            node: hid,
                            slot: Some(s),
                        };
                    }
                }
                if thing
                    && (strs(h.get("children")).contains(n) || strs(h.get("loose")).contains(n))
                {
                    frame = Frame {
                        node: hid,
                        slot: None,
                    };
                }
            }
            let now = self
                .tree
                .handle(*id)
                .and_then(|h| self.tree.node(h))
                .map(|x| Frame {
                    node: x.parent().unwrap_or(ground_id()),
                    slot: x.slot(),
                });
            if now != Some(frame) {
                let Ok(t) = self.mint.mint() else {
                    return Err("no id".into());
                };
                let bodies = transfer(&self.header, *id, Audience::Everyone, frame, t)
                    .into_iter()
                    .collect();
                if let Err(r) = self.write_bodies(bodies) {
                    self.scene_refused.push(format!(
                        "{n} where the case has it: {}: {}",
                        r.name, r.detail
                    ));
                    unset.insert(*id);
                    continue;
                }
            }
            // Its links: exactly the case's, of each type its kind declares.
            let kind = self
                .things
                .values()
                .find(|t| t.id == *id)
                .map(|t| t.kind.clone())
                .unwrap_or_default();
            let declared: Vec<String> = self
                .entry(&kind)
                .and_then(|e| e.get("links"))
                .and_then(J::obj)
                .unwrap_or(&[])
                .iter()
                .map(|(t, _)| t.clone())
                .collect();
            let node = nodes
                .iter()
                .find(|(k, _)| k == n)
                .map(|(_, v)| v.clone())
                .unwrap_or(J::Null);
            let mut cs = Vec::new();
            let mut seats: Vec<(String, Vec<Id>)> = Vec::new();
            for t in declared {
                let ty = replica::audience::link_type(&kind, &t);
                let want: Vec<Id> = strs(node.get("links").and_then(|l| l.get(&t)))
                    .iter()
                    .filter_map(|e| names.to_id.get(e).copied())
                    .collect();
                // B10: a role's link is never written here: its ends take the role (below).
                if self.roles.get(&kind).is_some_and(|a| {
                    a.roles
                        .iter()
                        .any(|r| r.name.as_str() == role_of(&kind, &t))
                }) {
                    seats.push((role_of(&kind, &t), want));
                    continue;
                }
                let have: Vec<(Id, Id)> = self
                    .tree
                    .links_at(*id)
                    .iter()
                    .filter(|e| self.tree.ty(e).as_str() == ty)
                    .map(|e| (e.link, e.other))
                    .collect();
                for (link, other) in &have {
                    if !want.contains(other) {
                        cs.push(Change::Unlink { link: *link });
                    }
                }
                for end in want {
                    if have.iter().any(|(_, o)| *o == end) {
                        continue;
                    }
                    let Ok(link) = self.mint.mint() else {
                        return Err("no id".into());
                    };
                    cs.push(Change::Link {
                        link,
                        ty: name(&ty),
                        ends: [end, *id],
                        owner: End::Second,
                        audience: Audience::Everyone,
                    });
                }
            }
            if !cs.is_empty()
                && let Err(r) = self.write(cs)
            {
                self.scene_refused
                    .push(format!("{n}'s links: {}: {}", r.name, r.detail));
                unset.insert(*id);
            }
            if let Err(why) = self.take_roles(*id, &kind, &seats) {
                self.scene_refused.push(format!("{n}'s roles: {why}"));
                unset.insert(*id);
            }
        }
        for (_, id) in fresh {
            if !unset.contains(&id) {
                self.arranged.insert(id);
            }
        }
        for (id, n) in &names.of {
            self.called.insert(*id, n.clone());
        }
        Ok(names)
    }

    /// The rules' state for the case: its own nodes, the placed ones' fields as they stand now, and where each of
    /// its things, bodies and links is in the tree as it stands.
    fn state_of(&self, case: &J, ids: &J, names: &Names) -> J {
        let mut state = case.get("state").cloned().unwrap_or(J::Obj(Vec::new()));
        let call = |id: Id| -> String {
            names.of.get(&id).cloned().unwrap_or_else(|| {
                self.things
                    .iter()
                    .find(|(_, t)| t.id == id)
                    .map_or_else(|| replica::world_model::show(id), |(k, _)| k.clone())
            })
        };
        let mut extra: Vec<(String, J)> = Vec::new();
        if let J::Obj(top) = &mut state
            && let Some((_, J::Obj(nodes))) = top.iter_mut().find(|(k, _)| k == "nodes")
        {
            for (nid, key) in ids.obj().unwrap_or(&[]) {
                let Some(t) = key.str().and_then(|k| self.things.get(k)) else {
                    continue;
                };
                let Some((_, J::Obj(n))) = nodes.iter_mut().find(|(k, _)| k == nid) else {
                    continue;
                };
                set_key(n, "kind", J::Str(t.kind.clone()));
                set_key(
                    n,
                    "fields",
                    J::Obj(self.tree_fields(t).unwrap_or_else(|| t.fields.clone())),
                );
                if !self.arranged.contains(&t.id) {
                    continue;
                }
                let entry = self.entry(&t.kind);
                let Some(h) = self.tree.handle(t.id) else {
                    continue;
                };
                let kids: Vec<(Option<u64>, Id)> = self
                    .tree
                    .children(h)
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(|c| self.tree.node(*c))
                    .map(|c| (c.slot(), c.id()))
                    .collect();
                let was = n
                    .iter()
                    .find(|(k, _)| k == "slots")
                    .map(|(_, v)| v.clone())
                    .unwrap_or(J::Null);
                let is_thing = |x: &str| {
                    names
                        .to_id
                        .get(x)
                        .is_some_and(|id| self.arranged.contains(id))
                };
                let slots: Vec<(String, J)> = (1u64..)
                    .zip(
                        entry
                            .and_then(|e| e.get("slots"))
                            .and_then(J::obj)
                            .unwrap_or(&[]),
                    )
                    .filter_map(|(s, (sname, _))| {
                        let mut inside: Vec<J> = kids
                            .iter()
                            .filter(|(k, _)| *k == Some(s))
                            .map(|(_, c)| J::Str(call(*c)))
                            .collect();
                        let listed = was.get(sname);
                        let kept = strs(listed)
                            .into_iter()
                            .chain(listed.and_then(J::str).map(str::to_owned));
                        inside.extend(kept.filter(|x| !is_thing(x)).map(J::Str));
                        (!inside.is_empty()).then(|| (sname.clone(), J::Arr(inside)))
                    })
                    .collect();
                set_key(n, "slots", J::Obj(slots));
                let links: Vec<(String, J)> = entry
                    .and_then(|e| e.get("links"))
                    .and_then(J::obj)
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(|(lt, _)| {
                        let ty = replica::audience::link_type(&t.kind, lt);
                        let ends: Vec<J> = self
                            .tree
                            .links_at(t.id)
                            .iter()
                            .filter(|e| self.tree.ty(e).as_str() == ty)
                            .map(|e| J::Str(call(e.other)))
                            .collect();
                        (!ends.is_empty()).then(|| (lt.clone(), J::Arr(ends)))
                    })
                    .collect();
                set_key(n, "links", J::Obj(links));
                for (_, c) in kids {
                    let named = names.of.contains_key(&c);
                    if let Some((k, x)) = self
                        .things
                        .iter()
                        .find(|(_, x)| x.id == c)
                        .filter(|_| !named)
                    {
                        extra.push((
                            k.clone(),
                            obj(vec![
                                ("kind", J::Str(x.kind.clone())),
                                ("fields", J::Obj(self.tree_fields(x).unwrap_or_default())),
                            ]),
                        ));
                    }
                }
            }
            // The bodies' hands as they stand.
            for (nid, n) in nodes.iter_mut() {
                let J::Obj(n) = n else { continue };
                if !n.iter().any(|(k, _)| k == "hands") {
                    continue;
                }
                let Some(b) = names.to_id.get(nid).copied() else {
                    continue;
                };
                // Its Soul, as the rules read an `end: "actor"` link (T2's `soul` link of a body).
                if let Some(soul) = self.souls_of.get(&b).and_then(|s| names.of.get(s)) {
                    let mut links = n
                        .iter()
                        .find(|(k, _)| k == "links")
                        .and_then(|(_, l)| l.obj())
                        .unwrap_or(&[])
                        .to_vec();
                    if !links.iter().any(|(k, _)| k == "soul") {
                        links.push(("soul".into(), J::Arr(vec![J::Str(soul.clone())])));
                        set_key(n, "links", J::Obj(links));
                    }
                }
                let held = self.held(b);
                // A hand the case holds a thing in that is not set in the tree yet is left as the case has it.
                let unset = n
                    .iter()
                    .find(|(k, _)| k == "hands")
                    .and_then(|(_, h)| h.obj())
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(|(_, v)| v.str())
                    .any(|t| {
                        names
                            .to_id
                            .get(t)
                            .is_some_and(|id| !self.arranged.contains(id))
                    });
                if unset {
                    continue;
                }
                let listed: Vec<String> = n
                    .iter()
                    .find(|(k, _)| k == "hands")
                    .and_then(|(_, h)| h.obj())
                    .unwrap_or(&[])
                    .iter()
                    .map(|(h, _)| h.clone())
                    .collect();
                let hands = HANDS
                    .iter()
                    .filter(|(h, _)| listed.iter().any(|l| l == h))
                    .map(|(h, _)| {
                        let t = held.iter().find(|(x, _)| x == h).map(|(_, t)| *t);
                        ((*h).to_owned(), t.map_or(J::Null, |t| J::Str(call(t))))
                    })
                    .collect();
                set_key(n, "hands", J::Obj(hands));
                for (_, t) in held {
                    if names.of.contains_key(&t) {
                        continue;
                    }
                    if let Some((k, x)) = self.things.iter().find(|(_, x)| x.id == t) {
                        extra.push((
                            k.clone(),
                            obj(vec![
                                ("kind", J::Str(x.kind.clone())),
                                ("fields", J::Obj(self.tree_fields(x).unwrap_or_default())),
                            ]),
                        ));
                    }
                }
            }
            for (k, v) in extra {
                if !nodes.iter().any(|(x, _)| *x == k) {
                    nodes.push((k, v));
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
        let names = match self.arrange(case, ids) {
            Ok(n) => n,
            Err(e) => return err(e),
        };
        // The seats where the case's scene put their things.
        let things: Vec<Id> = self.things.values().map(|t| t.id).collect();
        for t in things {
            self.seat(t);
        }
        // The world's check at commit: R2's rules on the case's state as it stands, the world seeing all (I3).
        let state = self.state_of(case, ids, &names);
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
        // A kind refused at import (F14: a form names a point its kind does not declare) is refused by name.
        if let Some(r) = self.refused.get(&kind) {
            return obj(vec![
                ("verdict", J::s("no")),
                ("reason", J::s(r.name)),
                ("code", J::s(r.name)),
                ("detail", J::Str(r.detail.clone())),
                ("receipt", J::s("refused")),
                ("by", J::s("import")),
            ]);
        }
        let entry = self.entry(&kind).cloned().unwrap_or(J::Null);
        // A thing argument the act leaves out goes to the form as the rules chose it, as worldd's `Acts` chooses it.
        let chosen = replica::rules::chosen_act(&self.kinds, act, &state, asker.get("sees"));
        let args = self.args_of(&entry, &form, chosen.as_ref().unwrap_or(act), ids, &names);
        let n = self.runs.len() as u64 + 1;
        let Some(id) = Id::new(Scope([0xe3; 16]), (1 << 40) + n) else {
            return err("no intent id");
        };
        let mut digest = [0u8; 32];
        digest[..8].copy_from_slice(&n.to_le_bytes());
        let actor = case
            .get("state")
            .and_then(|s| s.get("actor"))
            .and_then(J::str)
            .unwrap_or("b1");
        let body = names.to_id.get(actor).copied().unwrap_or(self.body);
        let intent = Intent {
            id,
            expiry: i64::MAX,
            actor: Actor::Soul(self.souls_of.get(&body).copied().unwrap_or(self.soul)),
            digest,
        };
        let (now, from) = (self.now, self.log.len());
        let asked = {
            let (mut w, forms) = self.world();
            forms.commit_with(
                &mut w,
                &BTreeMap::new(),
                &|_| None,
                body,
                node,
                &entry,
                &form,
                &args,
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
                self.runs.insert(
                    rid.clone(),
                    Run {
                        intent: id,
                        last,
                        from,
                        body,
                    },
                );
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

    /// The act's arguments as the world hands them to the forms (F14): a thing argument as the id its case node was
    /// placed as, words as a reference kept here (a stand-in for K16's store), a whole number as itself, any other as a
    /// name.
    /// The form's arguments from the case's act. A node argument is named as the case names it: a thing it placed
    /// (`ids`), else a body or Soul the case names (`names`), else a thing by the runner's own key.
    fn args_of(&mut self, entry: &J, form: &str, act: &J, ids: &J, names: &Names) -> Args {
        let takes = entry
            .get("forms")
            .and_then(|f| f.get(form))
            .and_then(|f| f.get("takes"));
        let thing = |v: &J| {
            let n = v.str()?;
            let placed = ids.get(n).and_then(J::str).and_then(|k| self.things.get(k));
            placed
                .map(|t| t.id)
                .or_else(|| names.to_id.get(n).copied())
                .or_else(|| self.things.get(n).map(|t| t.id))
        };
        let mut out = Args::new();
        for (k, v) in act.get("args").and_then(J::obj).unwrap_or(&[]) {
            let ty = takes
                .and_then(|t| t.get(k))
                .and_then(|t| t.get("type"))
                .and_then(J::str);
            let arg = match (ty, v) {
                (Some("text"), J::Str(words)) => {
                    let n = self.words.len() as u64 + 1;
                    let Some(id) = Id::new(Scope([0xe4; 16]), n) else {
                        continue;
                    };
                    self.words.insert(id, words.clone());
                    Arg::Text(id)
                }
                (_, J::Int(n)) => match i64::try_from(*n) {
                    Ok(n) => Arg::Int(n),
                    Err(_) => continue,
                },
                (_, J::Obj(_)) => match v.get("node").and_then(thing) {
                    Some(id) => Arg::Node(id),
                    None => continue,
                },
                (Some("thing"), _) => match thing(v) {
                    Some(id) => Arg::Node(id),
                    None => continue,
                },
                (_, J::Str(s)) => Arg::Name(s.clone()),
                _ => continue,
            };
            out.insert(k.clone(), arg);
        }
        out
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
        let body = self.runs.get(rid).map_or(self.body, |r| r.body);
        let at = self.forms.at(body);
        let r = self.runs.get_mut(rid).expect("the run");
        let moving = at.is_some() && at == r.last;
        if at.is_some() {
            r.last = at;
        }
        self.progress_of(rid, moving)
    }

    /// The changes run `rid` wrote that are not sets, in the case's terms: what it reparented (a transfer's arrive)
    /// and where to, what it made, removed, linked and unlinked.
    fn changes_of(&self, rid: &str) -> J {
        let Some(r) = self.runs.get(rid) else {
            return J::Arr(Vec::new());
        };
        // By the case's own names where it has one, else by the gate's key.
        let key = |id: Id| -> J {
            if let Some(n) = self.called.get(&id) {
                return J::Str(n.clone());
            }
            self.things.iter().find(|(_, t)| t.id == id).map_or_else(
                || J::Str(replica::world_model::show(id)),
                |(k, _)| J::Str(k.clone()),
            )
        };
        let bodies: BTreeSet<Id> = self.souls_of.keys().copied().collect();
        let place = |f: &Frame| -> J {
            let hand = bodies
                .contains(&f.node)
                .then(|| {
                    HANDS
                        .iter()
                        .find(|(_, s)| Some(*s) == f.slot)
                        .map(|(h, _)| *h)
                })
                .flatten();
            let slot = f.slot.and_then(|s| {
                let t = self.things.values().find(|t| t.id == f.node)?;
                let slots = self.entry(&t.kind)?.get("slots")?.obj()?;
                slots
                    .get(usize::try_from(s).ok()?.checked_sub(1)?)
                    .map(|(n, _)| n.clone())
            });
            match (hand, slot) {
                (Some(h), _) => obj(vec![("node", key(f.node)), ("hand", J::s(h))]),
                (_, Some(s)) => obj(vec![("node", key(f.node)), ("slot", J::Str(s))]),
                _ => obj(vec![("node", key(f.node))]),
            }
        };
        let bare = |ty: &Name| {
            ty.as_str()
                .split_once(':')
                .map_or(ty.as_str(), |(_, b)| b)
                .to_owned()
        };
        // A link by its id, as it was made (by a form or the case's scene).
        let made = |id: Id| {
            self.log
                .iter()
                .rev()
                .flat_map(|e| e.changes())
                .find_map(|c| match &c.change {
                    Change::Link { link, ty, ends, .. } if *link == id => Some((ty.clone(), *ends)),
                    _ => None,
                })
        };
        // An end that is a body's Soul is named as the case names it, by its body.
        let end = |id: Id| {
            let body = self
                .souls_of
                .iter()
                .find(|(_, s)| **s == id)
                .map(|(b, _)| *b);
            key(body.unwrap_or(id))
        };
        let link = |what: &str, ty: &Name, ends: [Id; 2]| {
            obj(vec![
                ("change", J::s(what)),
                ("node", key(ends[1])),
                ("link", J::Str(bare(ty))),
                ("end", end(ends[0])),
            ])
        };
        // The engine's own links (a run's hold on what it uses, BUILDSAFE) are not the kind's: not read back.
        let own = |ty: &Name| ty.as_str().starts_with("souls:") && ty.as_str() != "souls:owns";
        let mut out = Vec::new();
        // The run's own entries, and its body's seat followed into or out of a slot while it ran (`follow_seats`): the
        // form's `reparent` of the actor is its sit's or rise's hand-off.
        let seat = |e: &Effect| {
            e.envelope.cause == Cause::World
                && matches!(e.body, Body::Transfer(TransferRec::Leave { node, .. }) if node == r.body)
        };
        for e in self.log[r.from.min(self.log.len())..]
            .iter()
            .filter(|e| e.envelope.cause == Cause::Intent(r.intent) || seat(e))
        {
            match &e.body {
                Body::Transfer(TransferRec::Leave { node, pose, .. }) => out.push(obj(vec![
                    ("change", J::s("reparent")),
                    ("node", key(*node)),
                    ("to", place(&pose.frame)),
                ])),
                Body::Changes(cs) => {
                    for c in cs {
                        out.push(match &c.change {
                            Change::Create {
                                node, kind, pose, ..
                            } => obj(vec![
                                ("change", J::s("create")),
                                ("node", key(*node)),
                                ("kind", J::Str(plain(kind.as_str()).to_owned())),
                                ("to", place(&pose.frame)),
                            ]),
                            Change::Remove { node } => {
                                obj(vec![("change", J::s("remove")), ("node", key(*node))])
                            }
                            Change::Reparent { node, pose, .. } => obj(vec![
                                ("change", J::s("reparent")),
                                ("node", key(*node)),
                                ("to", place(&pose.frame)),
                            ]),
                            Change::Link { ty, .. } if own(ty) => continue,
                            Change::Link { ty, ends, .. } => link("link", ty, *ends),
                            Change::Unlink { link: id } => match made(*id) {
                                Some((ty, _)) if own(&ty) => continue,
                                Some((ty, ends)) => link("unlink", &ty, ends),
                                None => obj(vec![("change", J::s("unlink"))]),
                            },
                            _ => continue,
                        });
                    }
                }
                _ => {}
            }
        }
        J::Arr(out)
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
                ("changes", self.changes_of(rid)),
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
            forms.leave(&mut w, body, None, now)
        };
        self.flush();
        match r {
            Ok(()) => obj(vec![]),
            Err(r) => obj(vec![("refused", J::s(r.name))]),
        }
    }

    /// A new process's world: the body where it stood, no driver, timer or move, and the forms from the log alone.
    /// The tree is the store's, and stays.
    fn restart(&mut self) -> J {
        // A body in a seat, or taking or leaving one, stands at the seat's stand point; the seated are seated again
        // once the places are registered anew (K18c's restore, as a served world's restart seats them).
        let at_seat = |s: &Slots, body: Id| s.held_place(body).and_then(|p| p.stand().ok());
        let seated: Vec<(Id, Id, Option<u64>, sim::controller::Stance)> = self
            .slots
            .seated()
            .into_iter()
            .map(|(b, t, st)| (b, t, self.slots.held_place(b).map(|p| p.place.slot), st))
            .collect();
        let b = at_seat(&self.slots, self.body).unwrap_or_else(|| self.body_at());
        let g = ground();
        let mut c = Controller::new();
        if let Err(e) = place(&mut c, &g, self.body, humanoid(), b.x / 1000, b.z / 1000) {
            return err(e);
        }
        let others: Vec<Id> = self
            .souls_of
            .keys()
            .copied()
            .filter(|o| *o != self.body)
            .collect();
        for o in others {
            let p = at_seat(&self.slots, o)
                .or_else(|| self.c.body(o).map(|m| m.pose.position))
                .unwrap_or(b);
            if let Err(e) = place(&mut c, &g, o, humanoid(), p.x / 1000, p.z / 1000) {
                return err(e);
            }
        }
        self.c = c;
        // A new process's activities: read back from their nodes and membership links (E26).
        match Activities::restore(
            self.header.clone(),
            self.rules.clone(),
            self.roles.values().cloned().collect(),
            &self.tree,
            &mut self.c,
        ) {
            Ok(a) => self.acts = a,
            Err(r) => return err(format!("activities: {}: {}", r.name, r.detail)),
        }
        self.acts_due = DueList::new();
        self.slots = Slots::new();
        let things: Vec<Id> = self.things.values().map(|t| t.id).collect();
        for t in things {
            self.seat(t);
        }
        for (body, thing, slot, stance) in seated {
            if let Err(r) = self
                .slots
                .restore(&mut self.c, body, (thing, slot), stance, self.now)
            {
                eprintln!(
                    "a seated body could not be seated again: {}: {}",
                    r.name, r.detail
                );
            }
        }
        self.surfaces = BTreeMap::from([(ground_id(), g)]);
        self.due = DueList::new();
        self.moves = Moves::new();
        self.forms = Forms::recover(&self.log, self.now);
        self.forms.kinds(&self.k3);
        self.forms.zone(self.header.clone());
        self.look();
        self.flush();
        obj(vec![])
    }

    /// The kinds as K3 loads them (`Forms::kinds` reads their amount fields for F4's `by` sets, as worldd's
    /// `Acts::new` loads them; the tree admits and pins them).
    fn load_kinds(&mut self) {
        let mut loaded = Kinds::default();
        for (_, entry) in self.kinds.obj().unwrap_or(&[]) {
            let mut e = entry.clone();
            if let J::Obj(o) = &mut e {
                o.retain(|(k, _)| k != "forms" && k != "roles");
                // A timed field (a kettle's heat) or a schedule is not a field the kind format holds yet: left out,
                // as worldd's `Acts` leaves a timed one out (#3715).
                if let Some((_, J::Obj(state))) = o.iter_mut().find(|(k, _)| k == "state") {
                    state.retain(|(_, f)| {
                        !matches!(f.get("type").and_then(J::str), Some("timed" | "schedule"))
                    });
                }
            }
            // A section K3 does not read (areas, a vehicle's), or a field it refuses (an audience it does not know), is
            // left out, one at a time, so the rest loads.
            for _ in 0..8 {
                match replica::kinds::entry::entry_to_kind(&e.to_json()) {
                    Ok(text) => {
                        let before = loaded.refused().len();
                        loaded.load(&[("entry", text.as_str())]);
                        let field = loaded
                            .refused()
                            .get(before)
                            .and_then(|r| (r.section == Some(3)).then_some(r.field).flatten());
                        let Some(f) = field else { break };
                        let Some((_, J::Obj(state))) = (match &mut e {
                            J::Obj(o) => o.iter_mut().find(|(k, _)| k == "state"),
                            _ => None,
                        }) else {
                            break;
                        };
                        let had = state.len();
                        state.retain(
                            |(_, d)| !matches!(d.get("n"), Some(J::Int(n)) if *n == i128::from(f)),
                        );
                        if state.len() == had {
                            break;
                        }
                    }
                    Err(why) => match (why.strip_prefix("entry-section-not-read: "), &mut e) {
                        (Some(section), J::Obj(o)) => {
                            let section = section.trim().to_owned();
                            o.retain(|(k, _)| *k != section);
                        }
                        _ => {
                            eprintln!("not converted to a kind: {why}");
                            break;
                        }
                    },
                }
            }
        }
        for r in loaded.refused() {
            eprintln!("a kind refused (loaded again without it where it is one field): {r}");
        }
        self.forms.kinds(&loaded);
        self.k3 = loaded;
    }

    /// An answer with what the tree refused: of the case's scene (`scene_refused`) and of run `rid`'s entries
    /// (`tree_refused`), each when there is any.
    fn refusals(&self, mut answer: J, rid: Option<&str>) -> J {
        let words = |v: &[String]| J::Arr(v.iter().map(|w| J::Str(w.clone())).collect());
        let run = rid
            .and_then(|r| self.runs.get(r))
            .and_then(|r| self.refused_by.get(&r.intent))
            .filter(|v| !v.is_empty());
        if let J::Obj(o) = &mut answer {
            if !self.scene_refused.is_empty() {
                o.push(("scene_refused".into(), words(&self.scene_refused)));
            }
            if let Some(v) = run {
                o.push(("tree_refused".into(), words(v)));
            }
        }
        answer
    }

    /// What the body holds, by the gate's keys.
    fn holding(&self) -> J {
        J::Arr(
            self.held(self.body)
                .into_iter()
                .map(|(_, t)| {
                    self.things.iter().find(|(_, x)| x.id == t).map_or_else(
                        || J::Str(replica::world_model::show(t)),
                        |(k, _)| J::Str(k.clone()),
                    )
                })
                .collect(),
        )
    }

    fn handle(&mut self, q: &J) -> J {
        let s = |k: &str| q.get(k).and_then(J::str).unwrap_or_default().to_owned();
        let none = J::Obj(Vec::new());
        match s("op").as_str() {
            "define" => {
                self.kinds = q.get("kinds").cloned().unwrap_or(none);
                // The import check (F14): a kind whose form names a point it does not declare is refused here.
                self.refused = self
                    .kinds
                    .obj()
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(|(k, e)| check(e).err().map(|r| (k.clone(), r)))
                    .collect();
                for (k, r) in &self.refused {
                    eprintln!("refused at import: {k}: {} ({})", r.name, r.detail);
                }
                self.load_kinds();
                self.build();
                obj(vec![])
            }
            "place" => self.place(&s("kind")),
            "set" => {
                let fields = q.get("fields").and_then(J::obj).unwrap_or(&[]).to_vec();
                self.set(&s("id"), &fields)
            }
            "fields" => match self.things.get(&s("id")).and_then(|t| self.tree_fields(t)) {
                Some(f) => obj(vec![("fields", J::Obj(f))]),
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
            "reset" => self.reset(),
            "arrange" => match self.arrange(
                q.get("case").unwrap_or(&none),
                q.get("ids").unwrap_or(&none),
            ) {
                Ok(_) => self.refusals(obj(vec![]), None),
                Err(e) => err(e),
            },
            "begin" | "act" => {
                let b = self.begin(
                    &s("id"),
                    q.get("case").unwrap_or(&none),
                    q.get("ids").unwrap_or(&none),
                );
                let rid = b.get("rid").and_then(J::str).map(str::to_owned);
                if s("op") == "begin" || rid.is_none() {
                    return self.refusals(b, rid.as_deref());
                }
                let rid = rid.unwrap_or_default();
                let w = self.wait(&rid);
                self.refusals(w, Some(&rid))
            }
            "progress" => self.progress(&s("rid")),
            "wait" => {
                let w = self.wait(&s("rid"));
                self.refusals(w, Some(&s("rid")))
            }
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
                ("holding", self.holding()),
            ]),
            "restart" => self.restart(),
            "unapplied" => obj(vec![("entries", J::Int(i128::from(self.unapplied)))]),
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
