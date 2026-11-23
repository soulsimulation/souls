//! F4's checks (#2769): ten thousand random pours, takes, puts, makes and removes, with resends and kills, on a real
//! tree that commits each tick's entries as one part (A1, A2); a made thing appears where its form names, and a make
//! into a place that is not free is refused (A3). The kind is data, written here; no engine code names it.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use replica::bodies::{Class, Family};
use replica::effects::{Actor, Body, Change, Effect, Header, Part, fixture_bytes, schema_hash};
use replica::encode::{Value, decode, encode};
use replica::host::{Answer, Ask, Seen};
use replica::ids::{FIXTURE_SCOPE_A, Hash, Id, Minter, Purpose, Scope};
use replica::kinds::Kinds;
use replica::kinds::entry::entry_to_kind;
use replica::moves::{Effector, Move};
use replica::pose::{Frame, Quat, Vec3};
use replica::rules::json::{self, parse};
use replica::time::Micros;
use replica::tree::{Rules, Tree};
use replica::world_model::{parse_kinds, parse_world};
use skills::form_runner::{Arg, Args, Limits, bind, bind_effects_args, bind_effects_with};

use super::amounts::View;
use super::{Asked, Forms, Intent, World};
use crate::controller::Controller;
use crate::ground::Piece;
use crate::host::Geometry;
use crate::mover::Surface;
use crate::moves::{Moves, Reach, load};
use crate::timers::DueList;

const FAMILIES: &str = include_str!("../../../replica/fixtures/bodies/families.diag");
const TICK: Micros = 50_000;
/// The capacity of the amount, in its unit.
const MAX: i64 = 1_000;
const AMOUNT: u64 = 1;

/// The one kind of thing: an amount (whole grams, 0 to 1,000), one slot that holds a thing, and a form for each
/// effect. `KIND` stands for its full name, filled in once K3 has named it.
const ENTRY: &str = r#"{
  "format": "souls-entry/1",
  "kind": "f4:vessel",
  "owner": "thing",
  "state": {
    "amount": { "n": 1, "type": "int", "unit": "g", "default": 0, "min": 0, "max": 1000, "audience": { "rule": "everyone" } },
    "mood": { "n": 2, "type": "enum", "values": ["calm", "sad"], "default": "calm", "audience": { "rule": "everyone" } },
    "words": { "n": 3, "type": "text", "default": "", "audience": { "rule": "everyone" } }
  },
  "links": { "user": { "n": 1, "from": "body", "most": 1, "audience": { "rule": "everyone" } } },
  "points": { "grip": { "role": "grip", "at_mm": [0, 100, 0] } },
  "slots": { "rest": { "admits": "thing" } },
  "forms": {
    "pour": { "who": "anyone", "steps": [{ "step": "move", "move": "press", "at": "grip" }],
      "effects": [{ "change": "transfer", "field": "amount", "from": "this", "into": { "arg": "other" }, "amount": 250, "event": "poured" }] },
    "pour_some": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "transfer", "field": "amount", "from": "this", "into": { "arg": "other" }, "amount": 70, "event": "poured" }] },
    "fill": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "transfer", "field": "amount", "from": { "arg": "other" }, "into": "this", "amount": "room", "event": "filled" }] },
    "take": { "who": "anyone", "steps": [{ "step": "take", "move": "press", "at": "grip" }] },
    "put": { "who": "anyone", "steps": [{ "step": "put", "move": "press", "at": "grip", "what": { "arg": "other" }, "slot": "rest" }] },
    "make_held": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "create", "kind": "KIND", "into": "actor_hand", "event": "made" }] },
    "make_set": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "create", "kind": "KIND", "into": "rest", "event": "made" }] },
    "remove": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "remove", "what": { "arg": "other" }, "event": "used_up" }] },
    "begin": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "link", "link": "user", "from": "actor", "event": "begun" },
        { "change": "set", "field": "mood", "to": "sad", "event": "saddened" },
        { "change": "timer", "form": "calm_down", "after_us": 1000000, "event": "will_calm" }] },
    "end": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "unlink", "link": "user", "from": "actor", "event": "ended" },
        { "change": "set", "field": "mood", "to": "calm", "event": "calmed" }] },
    "free_all": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "unlink", "link": "user", "from": "all", "event": "freed" }] },
    "calm_down": { "who": "world", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "set", "field": "mood", "to": "calm", "event": "calmed" }] },
    "write": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }], "takes": { "words": { "type": "text" } },
      "effects": [{ "change": "set", "field": "words", "to": { "arg": "words" }, "event": "written" }] },
    "wipe": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "set", "field": "words", "to": null, "event": "wiped" }] },
    "hold_long": { "who": "anyone", "steps": [{ "step": "wait", "us": 5000000 }],
      "effects": [{ "change": "link", "link": "user", "from": "actor", "event": "begun" }] },
    "lift_other": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "reparent", "what": { "arg": "other" }, "into": "actor_hand", "event": "lifted" }] },
    "stay": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "reparent", "what": "actor", "into": "here", "event": "stayed" }] },
    "sit_in": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "reparent", "what": "actor", "into": "rest", "event": "sat" }] },
    "grieve": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "set", "field": "mood", "to": "angry", "event": "angered" }] },
    "overfill": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "set", "field": "amount", "to": 5000, "event": "overfilled" }] }
  }
}"#;

fn id(n: u64) -> Id {
    Id::new(FIXTURE_SCOPE_A, n).expect("an id")
}

/// The fixtures' two-handed family.
fn family() -> Family {
    let v = decode(&fixture_bytes(FAMILIES).expect("bytes"))
        .expect("decodes")
        .value;
    let Value::Array(fs) = v else {
        panic!("a list")
    };
    fs.iter()
        .map(|f| Family::from_value(f).expect("a family"))
        .find(|f| f.resources.iter().any(|r| r.class == Class::Manipulator))
        .expect("a family with hands")
}

/// The kind loaded by K3 (its forms set aside: K3 reads forms in its own numbered form), with its capacity, and its
/// `namespace:name`.
fn kind() -> (Kinds, String) {
    let mut v = parse(ENTRY).expect("JSON");
    if let json::Value::Obj(o) = &mut v {
        o.retain(|(k, _)| k != "forms");
    }
    let text = entry_to_kind(&v.to_json()).expect("numbered");
    let mut kinds = Kinds::default();
    let names = kinds.load(&[("vessel", text.as_str())]);
    assert!(kinds.refused().is_empty(), "{:?}", kinds.refused());
    let def = kinds.get(names[0].as_str()).expect("loaded");
    assert_eq!(
        def.state[&AMOUNT].max,
        Some(MAX),
        "the capacity is kind data"
    );
    let plain = replica::world_model::plain(names[0].as_str()).to_owned();
    (kinds, plain)
}

fn header(zone: Id, kinds: &[&str]) -> Header {
    let sorted: BTreeSet<&str> = kinds.iter().copied().collect();
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/f4-amounts/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(zone.scope().0.to_vec())),
        (4, zone.to_value()),
        (5, Value::Uint(0)),
        (
            6,
            Value::Array(
                sorted
                    .into_iter()
                    .map(|k| Value::Text(replica::encode::Name::new(k).expect("a name")))
                    .collect(),
            ),
        ),
        (7, Value::Array(Vec::new())),
    ]));
    Header::read(&encode(&v).expect("bytes")).expect("a header")
}

/// Every distance is in reach; every node stands at the origin.
struct Near;

impl Geometry for Near {
    fn ask(&self, _: Id, q: &Ask) -> Option<Answer> {
        match q {
            Ask::Toward { to, .. } => Some(Answer::Point(*to)),
            Ask::Near { .. } => Some(Answer::Near(Vec::new())),
            Ask::Distance { .. } => None,
        }
    }
    fn read(&self, node: Id) -> Option<Seen> {
        Some(Seen {
            id: node,
            kind: replica::encode::Name::new("f4:node").expect("a name"),
            parent: None,
            position: Vec3::ZERO,
            fields: BTreeMap::new(),
        })
    }
}

impl Reach for Near {
    fn distance(
        &self,
        _: Id,
        _: &Effector,
        _: Option<&replica::encode::Name>,
        _: Id,
        _: &replica::encode::Name,
    ) -> Option<i64> {
        Some(0)
    }
}

/// The process: what a kill loses. The tree and the log are what it keeps.
struct Process {
    c: Controller,
    due: DueList,
    moves: Moves,
    forms: Forms,
}

struct Bench {
    tree: Tree,
    rules: Rules,
    header: Header,
    next: u64,
    log: Vec<Effect>,
    kinds: Kinds,
    /// The kind's full name in the tree, and its entry with that name filled in.
    full: String,
    entry: json::Value,
    library: Vec<Move>,
    mint: Minter,
    p: Process,
    bodies: Vec<Id>,
    ground: BTreeMap<Id, Surface>,
    now: Micros,
    /// Each committed part's length, in order (C24's replay).
    parts: Vec<usize>,
}

fn surface() -> Surface {
    let corners = vec![
        [-5_000_000, 0, -5_000_000],
        [5_000_000, 0, -5_000_000],
        [5_000_000, 0, 5_000_000],
        [-5_000_000, 0, 5_000_000],
    ];
    Surface::new(
        id(1),
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
            ground: crate::gaits::Ground::Dry,
        }],
    )
}

impl Bench {
    /// `bodies` two-handed bodies and `things` things on the ground, the things holding `amounts` in turn.
    fn new(bodies: u64, things: u64, amounts: &[i64]) -> Bench {
        let (kinds, full) = kind();
        let kinds_diag = format!(
            "{{1: \"f4:ground\", 2: \"place\", 11: [\"body\", \"thing\"]}}\n\
             {{1: \"f4:walker\", 2: \"family\", 6: {{1: [\"thing\"], 2: [\"thing\"]}}}}\n\
             {{1: \"{full}\", 2: \"thing\", 6: {{1: [\"thing\"]}}, 18: {{1: \"one_hand\"}}}}"
        );
        let mut nodes = vec!["{1: 1, 2: \"f4:ground\"}".to_owned()];
        for b in 0..bodies {
            nodes.push(format!("{{1: {}, 2: \"f4:walker\", 3: 1}}", 2 + b));
        }
        for t in 0..things {
            nodes.push(format!("{{1: {}, 2: \"{full}\", 3: 1}}", 100 + t));
        }
        let world = format!("{{1: [], 2: {{}}, 3: [{}], 4: []}}", nodes.join(", "));
        let (tree, rules) = Tree::load(
            &parse_world(&parse_kinds(&kinds_diag).expect("kinds"), &world).expect("a world"),
        )
        .expect("loads");
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../replica/fixtures/moves");
        let next = tree.to_state().next;
        let pinned: Vec<&str> = rules.kinds.keys().map(String::as_str).collect();
        let header = header(id(1), &pinned);
        let full = rules
            .kinds
            .keys()
            .find(|k| replica::world_model::plain(k) == full)
            .expect("the kind in the tree")
            .clone();
        let entry = parse(&ENTRY.replace("KIND", &full)).expect("JSON");
        let mut b = Bench {
            tree,
            rules,
            header,
            next,
            log: Vec::new(),
            kinds,
            full,
            entry,
            library: load(&dir).expect("the fixture moves"),
            mint: Minter::new(Scope([0xf4; 16])),
            p: Process {
                c: Controller::new(),
                due: DueList::new(),
                moves: Moves::new(),
                forms: Forms::new(),
            },
            bodies: (0..bodies).map(|b| id(2 + b)).collect(),
            ground: BTreeMap::from([(id(1), surface())]),
            now: 0,
            parts: Vec::new(),
        };
        b.restart(Forms::new());
        // The starting amounts, written by the world.
        let sets: Vec<Effect> = (0..things)
            .map(|t| {
                let n = id(100 + t);
                let a = amounts[t as usize % amounts.len()];
                world_set(n, a)
            })
            .collect();
        b.commit(sets);
        b
    }

    /// A new process over the same tree: the bodies stand again, nothing runs.
    fn restart(&mut self, mut forms: Forms) {
        let ground = &self.ground[&id(1)];
        let frame = Frame {
            node: id(1),
            slot: None,
        };
        let mut c = Controller::new();
        for (i, body) in self.bodies.iter().enumerate() {
            let x = i64::try_from(i).expect("few") * 500_000;
            let placed = ground
                .place(*body, frame, Vec3::new(x, 0, 0), Quat::IDENTITY)
                .expect("placed");
            c.add(family(), placed).expect("added");
        }
        forms.kinds(&self.kinds);
        forms.zone(self.header.clone());
        self.p = Process {
            c,
            due: DueList::new(),
            moves: Moves::new(),
            forms,
        };
    }

    fn world(&mut self) -> (World<'_, Near, Near>, &mut Forms) {
        (
            World {
                tree: &self.tree,
                geometry: &Near,
                reach: &Near,
                controller: &mut self.p.c,
                due: &mut self.p.due,
                mint: &mut self.mint,
                moves: &mut self.p.moves,
                library: &self.library,
                places: None,
                seed: 1,
            },
            &mut self.p.forms,
        )
    }

    /// Commits `entries` as one part (the tree's checks, the amounts' balance), numbered from the zone's next.
    fn commit(&mut self, mut entries: Vec<Effect>) {
        if entries.is_empty() {
            return;
        }
        for (e, s) in entries.iter_mut().zip(self.next..) {
            e.envelope.sequence = s;
        }
        let bytes = encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (
                2,
                Value::Array(entries.iter().map(Effect::to_value).collect()),
            ),
        ])))
        .expect("bytes");
        let part = Part::read(&bytes).expect("a part");
        self.tree
            .commit(&self.header, &part, &self.rules)
            .unwrap_or_else(|r| {
                panic!(
                    "the part commits: {r:?}\n{}",
                    entries
                        .iter()
                        .map(|e| format!(
                            "{} {:?} {:?}",
                            replica::world_model::show(e.envelope.node),
                            e.body,
                            e.events.as_ref().map(|v| v
                                .iter()
                                .map(|x| x.name.as_str().to_owned())
                                .collect::<Vec<_>>())
                        ))
                        .collect::<Vec<_>>()
                        .join("\n")
                )
            });
        self.next += entries.len() as u64;
        self.parts.push(entries.len());
        self.log.extend(entries);
    }

    /// The tick's entries reach the log as one part, and each is handed back; a thing removed ends what reserved it.
    /// Returns the entries and what the part's removes take: each removed node and what is under it at that entry
    /// (T2), with the amount each holds there, worked out before the part commits.
    fn flush(&mut self) -> (Vec<Effect>, BTreeMap<Id, i64>) {
        let out = std::mem::take(&mut self.p.forms.out);
        let mut things: BTreeSet<Id> = self.subtree(id(1)).into_iter().collect();
        things.extend(
            out.iter()
                .flat_map(Effect::changes)
                .filter_map(|c| match c.change {
                    Change::Create { node, .. } => Some(node),
                    _ => None,
                }),
        );
        let mut removed = BTreeMap::new();
        for (i, e) in out.iter().enumerate() {
            for c in e.changes() {
                if let Change::Remove { node } = c.change {
                    let view = View {
                        tree: &self.tree,
                        out: &out[..i],
                    };
                    for t in things.iter().filter(|t| view.within(**t, node)) {
                        removed.insert(*t, view.amount(*t, AMOUNT).unwrap_or(0));
                    }
                }
            }
        }
        self.commit(out.clone());
        for e in &self.log[self.log.len() - out.len()..] {
            self.p.forms.logged(e);
        }
        let now = self.now;
        for n in removed.keys() {
            let (mut w, forms) = self.world();
            forms.gone(&mut w, *n, now);
        }
        (out, removed)
    }

    /// `node` and every node under it.
    fn subtree(&self, node: Id) -> Vec<Id> {
        let mut all = vec![node];
        let mut i = 0;
        while i < all.len() {
            if let Some(h) = self.tree.handle(all[i]) {
                for c in self.tree.children(h).unwrap_or(&[]) {
                    if let Some(n) = self.tree.node(*c) {
                        all.push(n.id());
                    }
                }
            }
            i += 1;
        }
        all
    }

    /// One tick: the walks, the controller's step, then every timer due before the next tick.
    fn tick(&mut self) {
        let now = self.now;
        let at = now + TICK;
        {
            let (mut w, forms) = self.world();
            forms.tick(&mut w, now);
        }
        let stepped = self.p.c.step(&self.ground, TICK, at);
        assert!(stepped.refused.is_empty(), "{:?}", stepped.refused);
        while let Some(t) = self.p.due.fire(at) {
            let (mut w, forms) = self.world();
            assert!(
                forms.fire(&mut w, &t),
                "every timer is a form's or a move's"
            );
        }
        self.now = at;
    }

    fn ask(
        &mut self,
        entry: &json::Value,
        body: Id,
        node: Id,
        form: &str,
        other: Option<Id>,
        intent: Intent,
    ) -> Result<Asked, replica::effects::Refusal> {
        let args = other
            .map(|o| BTreeMap::from([("other".to_owned(), o)]))
            .unwrap_or_default();
        let steps = bind(entry, form)?;
        let effects = bind_effects_with(entry, form, &args)?;
        let now = self.now;
        let (mut w, forms) = self.world();
        forms.start(
            &mut w,
            body,
            node,
            intent,
            steps,
            effects,
            Limits::default(),
            now,
        )
    }

    /// Every thing of the kind and its amount (its kind's default when it has none written).
    fn things(&self) -> BTreeMap<Id, i64> {
        let mut all = BTreeMap::new();
        let mut stack = vec![self.tree.root()];
        while let Some(h) = stack.pop() {
            let Some(n) = self.tree.node(h) else { continue };
            if n.kind().as_str() == self.full {
                let a = match n.fields().get(&AMOUNT) {
                    Some(Value::Uint(u)) => i64::try_from(*u).expect("small"),
                    Some(Value::Nint(m)) => -1 - i64::try_from(*m).expect("small"),
                    _ => 0,
                };
                all.insert(n.id(), a);
            }
            stack.extend(self.tree.children(h).unwrap_or(&[]).iter().copied());
        }
        all
    }
}

fn world_set(node: Id, amount: i64) -> Effect {
    Effect {
        envelope: replica::effects::Envelope {
            sequence: 0,
            at: 0,
            cause: replica::effects::Cause::World,
            actor: Actor::World,
            audience: replica::world_model::Audience::Everyone,
            node,
        },
        body: Body::Changes(vec![replica::effects::ChangeRec {
            change: Change::Set {
                node,
                field: AMOUNT,
                to: Value::Uint(u64::try_from(amount).expect("whole")),
                by: None,
            },
            rest: replica::effects::Rest::new(),
        }]),
        events: None,
        rest: replica::effects::Rest::new(),
    }
}

fn splitmix(x: &mut u64) -> u64 {
    *x = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut z = *x;
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

fn intent(body: Id, n: u64) -> Intent {
    let mut digest = [0; 32];
    digest[..8].copy_from_slice(&n.to_le_bytes());
    Intent {
        id: Id::new(Scope([0xf5; 16]), n + 1).expect("an id"),
        expiry: Micros::MAX / 2,
        actor: Actor::Soul(body),
        digest,
    }
}

/// The key `(intent, effect number)` of an entry that carries one.
fn key(e: &Effect) -> Option<(Id, u64)> {
    let replica::effects::Cause::Intent(i) = e.envelope.cause else {
        return None;
    };
    let ev = e
        .events
        .as_ref()?
        .iter()
        .find(|v| v.name.as_str() == "souls:effect")?;
    match ev.fields.get(&1) {
        Some(Value::Uint(n)) => Some((i, *n)),
        _ => None,
    }
}

const FORMS: [&str; 11] = [
    "pour",
    "pour_some",
    "fill",
    "pour",
    "pour_some",
    "fill",
    "take",
    "put",
    "make_held",
    "make_set",
    "remove",
];

#[test]
fn a1_a2_ten_thousand_random_pours_takes_puts_makes_and_removes_keep_every_total() {
    const OPS: u64 = 10_000;
    let mut b = Bench::new(8, 32, &[0, 1_000, 400, 250, 999, 30]);
    let entry = b.entry.clone();
    let mut rng = 0xf4u64;
    let (mut asked, mut resends, mut kills, mut lost) = (0u64, 0u64, 0u64, 0u64);
    let mut asks: Vec<(Id, Id, &str, Option<Id>, Intent)> = Vec::new();
    let mut by_form: BTreeMap<&str, (u64, u64)> = BTreeMap::new();
    let mut refused: BTreeMap<String, u64> = BTreeMap::new();
    let (mut made, mut removed, mut empty, mut full, mut positions) =
        (0u64, 0u64, 0u64, 0u64, 0u64);
    let start = b.things();
    let (mut total, mut count) = (start.values().sum::<i64>(), start.len() as i64);
    println!("start: {count} things holding {total} g");
    while asked < OPS || !b.p.forms.is_empty() {
        // Each idle body asks for one random form at a random thing, with a random other thing.
        let things: Vec<Id> = b.things().into_keys().collect();
        for &body in &b.bodies.clone() {
            if asked >= OPS || b.p.forms.at(body).is_some() || things.is_empty() {
                continue;
            }
            let pick = |r: u64| things[(r % things.len() as u64) as usize];
            let form = FORMS[(splitmix(&mut rng) % FORMS.len() as u64) as usize];
            let node = pick(splitmix(&mut rng));
            // Half the puts and removes name something the body holds or the thing contains.
            let near: Vec<Id> = [body, node]
                .iter()
                .flat_map(|p| b.subtree(*p).into_iter().skip(1))
                .filter(|t| things.contains(t))
                .collect();
            let other = match (form, near.is_empty(), splitmix(&mut rng) % 2) {
                ("put" | "remove", false, 0) => {
                    near[(splitmix(&mut rng) % near.len() as u64) as usize]
                }
                _ => pick(splitmix(&mut rng)),
            };
            let it = intent(body, asked);
            asked += 1;
            by_form.entry(form).or_default().0 += 1;
            match b.ask(&entry, body, node, form, Some(other), it) {
                Ok(Asked::Started(_)) => asks.push((body, node, form, Some(other), it)),
                Ok(a) => panic!("a new intent: {a:?}"),
                Err(r) => *refused.entry(r.name.to_owned()).or_default() += 1,
            }
        }
        b.tick();
        // A resend of an earlier intent, now and then: never a second effect.
        let r = splitmix(&mut rng) % 100;
        if r < 3 && !asks.is_empty() {
            let (body, node, form, other, it) =
                asks[(splitmix(&mut rng) % asks.len() as u64) as usize];
            // The accept path (I4) refuses a thing that is gone before a run starts; the agent sees it gone too.
            if b.tree.handle(node).is_some() && other.is_none_or(|o| b.tree.handle(o).is_some()) {
                resends += 1;
                let _ = b.ask(&entry, body, node, form, other, it);
            }
        }
        // A kill, now and then: before the tick's entries reach the log (they are lost), or after (below).
        let kill = |b: &mut Bench| {
            let forms = Forms::recover(&b.log, b.now);
            b.restart(forms);
        };
        if r == 99 {
            kills += 1;
            lost += b.p.forms.out.len() as u64;
            b.p.forms.out.clear();
            kill(&mut b);
        }
        let (out, gone) = b.flush();
        if r == 98 {
            kills += 1;
            kill(&mut b);
        }
        // A1: the totals change only by what the part makes (with what each is made holding) and removes (with what
        // each holds as it goes); A2: no amount out of bounds.
        let new: Vec<i64> = out
            .iter()
            .flat_map(Effect::changes)
            .filter_map(|c| match &c.change {
                Change::Create { fields, .. } => Some(match fields.get(&AMOUNT) {
                    Some(Value::Uint(u)) => i64::try_from(*u).expect("small"),
                    _ => 0,
                }),
                _ => None,
            })
            .collect();
        let after = b.things();
        total = total - gone.values().sum::<i64>() + new.iter().sum::<i64>();
        count = count - gone.len() as i64 + new.len() as i64;
        made += new.len() as u64;
        removed += gone.len() as u64;
        assert_eq!(
            after.values().sum::<i64>(),
            total,
            "at {} µs: the total moved",
            b.now
        );
        assert_eq!(
            after.len() as i64,
            count,
            "at {} µs: a thing came or went unlisted",
            b.now
        );
        for (t, a) in &after {
            assert!(
                (0..=MAX).contains(a),
                "at {} µs: {} holds {a}",
                b.now,
                replica::world_model::show(*t)
            );
        }
        empty += after.values().filter(|a| **a == 0).count() as u64;
        full += after.values().filter(|a| **a == MAX).count() as u64;
        positions += 1;
        for e in b.p.forms.ended.drain(..) {
            if e.how.as_str() != "done" {
                *refused.entry(e.how.as_str().to_owned()).or_default() += 1;
            } else {
                if let Some(f) = asks.iter().rev().find(|a| a.0 == e.body).map(|a| a.2) {
                    by_form.entry(f).or_default().1 += 1;
                }
            }
        }
        assert!(b.now < 3_600_000_000, "the run ends");
    }
    // Each effect is in the log once.
    let mut keys = BTreeSet::new();
    for e in &b.log {
        if let Some(k) = key(e) {
            assert!(keys.insert(k), "an effect written twice: {k:?}");
        }
    }
    let end = b.things();
    println!(
        "{asked} asked ({resends} resends, {kills} kills, {lost} entries lost before the log) over {} s of world time; \
         {} effects in the log, each once",
        b.now / 1_000_000,
        keys.len()
    );
    println!("by form (asked, ran to done): {by_form:?}");
    println!("ended other than done, or refused at the start: {refused:?}");
    println!(
        "{positions} positions of the log checked: no amount below 0 or over {MAX}; {empty} times a thing stood \
         empty and {full} times full"
    );
    println!(
        "end: {} things holding {} g = {} g at the start less what {removed} removes took, and {made} made",
        end.len(),
        end.values().sum::<i64>(),
        start.values().sum::<i64>()
    );
    assert!(
        kills > 0 && lost > 0 && resends > 0 && made > 0 && removed > 0 && empty > 0 && full > 0
    );
    for f in FORMS {
        assert!(
            by_form.get(f).is_some_and(|x| x.1 > 0),
            "{f} ran to done at least once"
        );
    }
}

#[test]
fn a3_a_made_thing_appears_where_its_form_names_and_a_place_not_free_is_refused() {
    let mut b = Bench::new(1, 1, &[0]);
    let (full, entry) = (b.full.clone(), b.entry.clone());
    let (body, thing) = (id(2), id(100));
    let mut n = 0;
    let mut run = |b: &mut Bench, form: &str| {
        n += 1;
        assert!(matches!(
            b.ask(&entry, body, thing, form, None, intent(body, n)),
            Ok(Asked::Started(_))
        ));
        let mut made = Vec::new();
        while !b.p.forms.is_empty() {
            b.tick();
            made.extend(b.flush().0.iter().flat_map(Effect::changes).filter_map(
                |c| match &c.change {
                    Change::Create {
                        node, kind, pose, ..
                    } => Some((*node, kind.clone(), pose.frame)),
                    _ => None,
                },
            ));
        }
        let e = b.p.forms.ended.pop().expect("ended");
        (e.how.as_str().to_owned(), made)
    };
    let at = |b: &Bench, t: Id| {
        let n = b
            .tree
            .node(b.tree.handle(t).expect("in the tree"))
            .expect("a node");
        (n.parent(), n.slot())
    };
    // Into the hand: the first free hand's slot of the body; then the second hand; then no hand is free.
    for slot in [1, 2] {
        let (how, made) = run(&mut b, "make_held");
        let [(node, ref kind, frame)] = made[..] else {
            panic!("{made:?}")
        };
        println!(
            "make into the hand: {how}; {} made in slot {slot} of the body",
            kind.as_str()
        );
        assert_eq!((how.as_str(), kind.as_str()), ("done", full.as_str()));
        assert_eq!(
            frame,
            Frame {
                node: body,
                slot: Some(slot)
            }
        );
        assert_eq!(at(&b, node), (Some(body), Some(slot)));
    }
    let (how, made) = run(&mut b, "make_held");
    println!("make into a full pair of hands: {how}");
    assert_eq!((how.as_str(), made.len()), ("hands-full", 0));
    // Into the thing's slot: there, then refused while it is taken.
    let (how, made) = run(&mut b, "make_set");
    let [(node, _, frame)] = made[..] else {
        panic!("{made:?}")
    };
    println!("make into the slot: {how}");
    assert_eq!(
        frame,
        Frame {
            node: thing,
            slot: Some(1)
        }
    );
    assert_eq!(at(&b, node), (Some(thing), Some(1)));
    let (how, made) = run(&mut b, "make_set");
    println!("make into the taken slot: {how}");
    assert_eq!((how.as_str(), made.len()), ("slot-occupied", 0));
}

/// Starts `form` of `entry` by `body` at `node` with thing argument `other` and value arguments `vals` (C24).
#[allow(clippy::too_many_arguments)]
fn start(
    b: &mut Bench,
    entry: &json::Value,
    body: Id,
    node: Id,
    form: &str,
    other: Id,
    vals: &[(&str, Arg)],
    n: u64,
) -> Result<(), String> {
    let mut args: Args = vals
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.clone()))
        .collect();
    args.insert("other".to_owned(), Arg::Node(other));
    let effects = bind_effects_args(entry, form, &args).map_err(|r| r.name.to_owned())?;
    let steps = bind(entry, form).map_err(|r| r.name.to_owned())?;
    let now = b.now;
    let (mut w, forms) = b.world();
    let started = forms.start(
        &mut w,
        body,
        node,
        intent(body, n),
        steps,
        effects,
        Limits::default(),
        now,
    );
    assert!(matches!(started, Ok(Asked::Started(_))), "{started:?}");
    Ok(())
}

/// C24 (#3495) A1, A2, A3: link (to its kind's most), unlink (the actor's and every end), a timer that replaces the
/// one pending, a set to an enum value and to text (and cleared), a reparent of a thing into the hand and
/// of the actor `here`, each applied through the forms' commit path onto a real tree whose every part is read back as
/// the log holds it; each refused by name where it cannot be (`link-full`, `not-allowed`, `out-of-range`,
/// `arg-missing`, `body-moves-by-step`, BUILDSAFE's `thing-reserved`); then the log, replayed part by part onto a fresh
/// tree, gives the same tree.
#[test]
fn c24_every_effect_content_uses_applies_and_a_replay_gives_the_same_tree() {
    let mut b = Bench::new(2, 2, &[0]);
    let entry = b.entry.clone();
    let (b0, b1, a, other) = (id(2), id(3), id(100), id(101));
    let ns = b.full.split(':').next().expect("a namespace").to_owned();
    let mut n = 100;
    let mut run = |b: &mut Bench, body: Id, form: &str, vals: &[(&str, Arg)]| {
        n += 1;
        start(b, &entry, body, a, form, other, vals, n)?;
        while !b.p.forms.is_empty() {
            b.tick();
            b.flush();
        }
        let e = b.p.forms.ended.pop().expect("ended");
        Ok::<String, String>(e.how.as_str().to_owned())
    };
    let field = |b: &Bench, f: u64| {
        b.tree
            .node(b.tree.handle(a).expect("a"))
            .expect("a node")
            .fields()
            .get(&f)
            .cloned()
    };
    let users = |b: &Bench| -> Vec<Id> {
        b.tree
            .links_at(a)
            .iter()
            .filter(|e| b.tree.ty(e).as_str() == format!("{ns}:user"))
            .map(|e| e.other)
            .collect()
    };
    let timers = |b: &Bench| -> Vec<(Micros, String)> {
        b.tree
            .timers()
            .values()
            .filter(|t| t.node == a)
            .map(|t| (t.due, t.name.as_str().to_owned()))
            .collect()
    };
    let text =
        |t: &str| Value::Text(replica::encode::Name::new(&format!("{ns}:{t}")).expect("a name"));

    // Bound with what the field allows, or refused by name.
    assert_eq!(run(&mut b, b0, "grieve", &[]), Err("not-allowed".into()));
    assert_eq!(run(&mut b, b0, "overfill", &[]), Err("out-of-range".into()));
    assert_eq!(
        run(&mut b, b0, "sit_in", &[]),
        Err("body-moves-by-step".into())
    );
    assert_eq!(run(&mut b, b0, "write", &[]), Err("arg-missing".into()));
    assert_eq!(
        run(&mut b, b0, "write", &[("words", Arg::Name("calm".into()))]),
        Err("not-allowed".into())
    );

    // A link, a set to a value and a timer, one effect each.
    let at = b.now;
    assert_eq!(run(&mut b, b0, "begin", &[]), Ok("done".into()));
    println!(
        "begin: users {:?}, mood {:?}, timers {:?}",
        users(&b),
        field(&b, 2),
        timers(&b)
    );
    assert_eq!(users(&b), vec![b0]);
    assert_eq!(field(&b, 2), Some(text("sad")));
    let first = timers(&b);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].1, format!("{ns}:calm_down"));
    assert!(first[0].0 > at + 1_000_000 && first[0].0 <= b.now + 1_000_000);
    // One past the type's most is refused by name.
    assert_eq!(run(&mut b, b1, "begin", &[]), Ok("link-full".into()));
    // The actor's unlink.
    assert_eq!(run(&mut b, b0, "end", &[]), Ok("done".into()));
    assert_eq!((users(&b), field(&b, 2)), (vec![], Some(text("calm"))));
    // A new link, whose timer replaces the one pending.
    assert_eq!(run(&mut b, b1, "begin", &[]), Ok("done".into()));
    let second = timers(&b);
    println!("a second begin: timers {second:?}");
    assert_eq!(second.len(), 1, "the pending timer is replaced");
    assert_ne!(second, first);
    assert_eq!(run(&mut b, b0, "free_all", &[]), Ok("done".into()));
    assert!(users(&b).is_empty());

    // Text: words by their reference, then cleared.
    let words = id(7000);
    assert_eq!(
        run(&mut b, b0, "write", &[("words", Arg::Text(words))]),
        Ok("done".into())
    );
    assert_eq!(
        field(&b, 3),
        Some(Value::Map(BTreeMap::from([(
            replica::audience::REFERENCE,
            words.to_value()
        )])))
    );
    assert_eq!(run(&mut b, b0, "wipe", &[]), Ok("done".into()));
    assert_eq!(field(&b, 3), Some(Value::Map(BTreeMap::new())));
    assert_eq!(run(&mut b, b0, "stay", &[]), Ok("done".into()));

    // BUILDSAFE: a thing another run holds is refused, not moved from under it; once free it moves into the hand.
    start(&mut b, &entry, b1, other, "hold_long", other, &[], 900).expect("started");
    start(&mut b, &entry, b0, a, "lift_other", other, &[], 901).expect("started");
    let mut lifted = None;
    while lifted.is_none() {
        b.tick();
        b.flush();
        lifted =
            b.p.forms
                .ended
                .iter()
                .find(|e| e.body == b0)
                .map(|e| e.how.as_str().to_owned());
    }
    println!("lift a thing another run holds: {lifted:?}");
    assert_eq!(lifted.as_deref(), Some("thing-reserved"));
    while !b.p.forms.is_empty() {
        b.tick();
        b.flush();
    }
    b.p.forms.ended.clear();
    assert_eq!(run(&mut b, b0, "lift_other", &[]), Ok("done".into()));
    let held = b
        .tree
        .node(b.tree.handle(other).expect("other"))
        .expect("a node");
    assert_eq!(held.parent(), Some(b0));

    // The log replayed part by part onto a fresh tree gives the same tree.
    let mut fresh = Bench::new(2, 2, &[0]);
    let mut from = b.parts[0];
    for &len in &b.parts[1..] {
        fresh.commit(b.log[from..from + len].to_vec());
        from += len;
    }
    println!(
        "replayed {} parts, {} entries",
        b.parts.len() - 1,
        b.log.len() - b.parts[0]
    );
    assert_eq!(fresh.tree.to_state(), b.tree.to_state());
}

/// W14 (#4090): a thing whose map row borrows an entry reads that entry's amounts first, even when its own kind
/// carries the same field; a thing that borrows nothing reads its own.
#[test]
fn w14_a_borrowed_entrys_amounts_win_over_the_things_own_kind() {
    use super::amounts::{Limit, Limits, limits_of};
    let lim = |max| {
        BTreeMap::from([(
            28,
            Limit {
                default: 0,
                min: Some(0),
                max: Some(max),
            },
        )])
    };
    let limits: Limits = BTreeMap::from([
        ("mars:sink@1220aa".to_owned(), lim(10)),
        ("test:tap@1220bb".to_owned(), lim(99)),
    ]);
    let max = |kind, borrowed| {
        limits_of(&limits, kind, borrowed)
            .and_then(|f| f.get(&28))
            .and_then(|l| l.max)
    };
    assert_eq!(
        max(Some("mars:sink@1220aa"), Some("test:tap")),
        Some(99),
        "the borrowed entry wins"
    );
    assert_eq!(
        max(Some("mars:sink@1220aa"), None),
        Some(10),
        "borrowing nothing: its own"
    );
    assert_eq!(
        max(Some("mars:sink"), Some("eden:none")),
        Some(10),
        "an entry not loaded: its own, by plain name"
    );
}
