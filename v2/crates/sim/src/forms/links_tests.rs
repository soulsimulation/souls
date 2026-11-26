//! F15's checks (#3385): `link` and `unlink` effects commit as K5 links on a real tree, between the actor (its body or
//! its Soul, as the kind's link is from) and the thing, and a form that fails before its effect's instant, or whose
//! other effect is refused, links nothing (A1). The kind is data, written here; no engine code names it.

use std::collections::BTreeMap;
use std::path::Path;

use replica::bodies::{Class, Family};
use replica::effects::{Actor, Change, Effect, Header, Part, fixture_bytes, schema_hash};
use replica::encode::{Value, decode, encode};
use replica::host::{Answer, Ask, Seen};
use replica::ids::{FIXTURE_SCOPE_A, Hash, Id, Minter, Purpose, Scope};
use replica::moves::{Effector, Move};
use replica::pose::{Frame, Quat, Vec3};
use replica::rules::json::{self, parse};
use replica::time::Micros;
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, End, FIXTURE_SCOPE_SOULS, parse_kinds, parse_world};
use skills::form_runner::{Limits, bind, bind_effects_with};

use super::{Forms, Intent, World};
use crate::controller::Controller;
use crate::ground::Piece;
use crate::host::Geometry;
use crate::mover::Surface;
use crate::moves::{Moves, Reach, load};
use crate::timers::DueList;

const FAMILIES: &str = include_str!("../../../replica/fixtures/bodies/families.diag");
const TICK: Micros = 50_000;

/// A made-up kind with two public links, one from a body and one from a Soul, and a form for each effect.
const ENTRY: &str = r#"{
  "format": "souls-entry/1",
  "kind": "f15:rack",
  "owner": "thing",
  "state": {},
  "links": {
    "user": { "n": 1, "from": "body", "most": 4, "audience": { "rule": "everyone" } },
    "member": { "n": 2, "from": "soul", "most": 4, "audience": { "rule": "everyone" } }
  },
  "points": { "grip": { "role": "grip", "at_mm": [0, 100, 0] } },
  "forms": {
    "join": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "link", "link": "user", "from": "actor", "event": "joined" }] },
    "join_soul": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "link", "link": "member", "from": "actor", "event": "joined" }] },
    "leave": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "unlink", "link": "user", "from": "actor", "event": "left" }] },
    "clear": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "unlink", "link": "user", "from": "all", "event": "cleared" }] },
    "join_by_hand": { "who": "anyone", "steps": [{ "step": "move", "move": "press", "at": "grip" }],
      "effects": [{ "change": "link", "link": "user", "from": "actor", "event": "joined" }] },
    "join_and_remove": { "who": "anyone", "steps": [{ "step": "wait", "us": 50000 }],
      "effects": [{ "change": "link", "link": "user", "from": "actor", "event": "joined" },
                  { "change": "remove", "what": { "arg": "other" }, "event": "used_up" }] }
  }
}"#;

const USER: &str = "f15:user";
const MEMBER: &str = "f15:member";

fn id(n: u64) -> Id {
    Id::new(FIXTURE_SCOPE_A, n).expect("an id")
}

fn soul(n: u64) -> Id {
    Id::new(FIXTURE_SCOPE_SOULS, n).expect("an id")
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

fn header(zone: Id, kinds: &[&str]) -> Header {
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/f15-links/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(zone.scope().0.to_vec())),
        (4, zone.to_value()),
        (5, Value::Uint(0)),
        (
            6,
            Value::Array(
                kinds
                    .iter()
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
            kind: replica::encode::Name::new("f15:node").expect("a name"),
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

/// Bodies 2 and 3 (Souls 51 and 52) on the ground, racks 100 and 101, and a loose thing 200 under the ground.
struct Bench {
    tree: Tree,
    rules: Rules,
    header: Header,
    next: u64,
    log: Vec<Effect>,
    entry: json::Value,
    library: Vec<Move>,
    mint: Minter,
    c: Controller,
    due: DueList,
    moves: Moves,
    forms: Forms,
    ground: BTreeMap<Id, Surface>,
    now: Micros,
    asked: u64,
    /// The places a form's sit takes, when the bench has any (E7).
    slots: Option<crate::slots::Slots>,
}

impl Bench {
    fn new() -> Bench {
        let kinds = parse_kinds(
            "{1: \"f15:ground\", 2: \"place\", 11: [\"body\", \"thing\"]}\n\
             {1: \"f15:walker\", 2: \"family\", 6: {1: [\"thing\"], 2: [\"thing\"]}}\n\
             {1: \"f15:rack\", 2: \"thing\"}\n\
             {1: \"f15:pebble\", 2: \"thing\"}",
        )
        .expect("kinds");
        let world = "{1: [51, 52], 2: {}, 3: [{1: 1, 2: \"f15:ground\"}, {1: 2, 2: \"f15:walker\", 3: 1}, \
                     {1: 3, 2: \"f15:walker\", 3: 1}, {1: 100, 2: \"f15:rack\", 3: 1}, \
                     {1: 101, 2: \"f15:rack\", 3: 1}, {1: 200, 2: \"f15:pebble\", 3: 1}], 4: []}";
        let (tree, rules) =
            Tree::load(&parse_world(&kinds, world).expect("a world")).expect("loads");
        let pinned: Vec<&str> = rules.kinds.keys().map(String::as_str).collect();
        let header = header(id(1), &pinned);
        let next = tree.to_state().next;
        let corners = vec![
            [-5_000_000, 0, -5_000_000],
            [5_000_000, 0, -5_000_000],
            [5_000_000, 0, 5_000_000],
            [-5_000_000, 0, 5_000_000],
        ];
        let surface = Surface::new(
            id(1),
            vec![Piece {
                outline: vec![corners.clone()],
                vertices: corners,
                triangles: vec![[0, 2, 1], [0, 3, 2]],
                ground: crate::gaits::Ground::Dry,
            }],
        );
        let frame = Frame {
            node: id(1),
            slot: None,
        };
        let mut c = Controller::new();
        for (i, b) in [id(2), id(3)].into_iter().enumerate() {
            let x = i64::try_from(i).expect("few") * 500_000;
            let placed = surface
                .place(b, frame, Vec3::new(x, 0, 0), Quat::IDENTITY)
                .expect("placed");
            c.add(family(), placed).expect("added");
        }
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../replica/fixtures/moves");
        Bench {
            tree,
            rules,
            header,
            next,
            log: Vec::new(),
            entry: parse(ENTRY).expect("JSON"),
            library: load(&dir).expect("the fixture moves"),
            mint: Minter::new(Scope([0xf1; 16])),
            c,
            due: DueList::new(),
            moves: Moves::new(),
            forms: Forms::new(),
            ground: BTreeMap::from([(id(1), surface)]),
            now: 0,
            asked: 0,
            slots: None,
        }
    }

    fn world(&mut self) -> (World<'_, Near, Near>, &mut Forms) {
        (
            World {
                tree: &self.tree,
                geometry: &Near,
                reach: &Near,
                controller: &mut self.c,
                due: &mut self.due,
                mint: &mut self.mint,
                moves: &mut self.moves,
                library: &self.library,
                seed: 1,
                places: self.slots.as_mut().map(|slots| super::Places {
                    slots,
                    floors: &self.ground,
                }),
            },
            &mut self.forms,
        )
    }

    /// The forms' entries reach the tree as one part (its checks), and each is handed back as logged.
    fn flush(&mut self) {
        let mut out = std::mem::take(&mut self.forms.out);
        if out.is_empty() {
            return;
        }
        for (e, s) in out.iter_mut().zip(self.next..) {
            e.envelope.sequence = s;
        }
        let bytes = encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (2, Value::Array(out.iter().map(Effect::to_value).collect())),
        ])))
        .expect("bytes");
        let part = Part::read(&bytes).expect("a part");
        self.tree
            .commit(&self.header, &part, &self.rules)
            .unwrap_or_else(|r| panic!("the part commits: {r:?}"));
        self.next += out.len() as u64;
        for e in &out {
            self.forms.logged(e);
        }
        self.log.extend(out);
    }

    fn tick(&mut self) {
        let (now, at) = (self.now, self.now + TICK);
        {
            let (mut w, forms) = self.world();
            forms.tick(&mut w, now);
        }
        let stepped = self.c.step(&self.ground, TICK, at);
        assert!(stepped.refused.is_empty(), "{:?}", stepped.refused);
        while let Some(t) = self.due.fire(at) {
            let (mut w, forms) = self.world();
            forms.fire(&mut w, &t);
        }
        self.now = at;
        self.flush();
    }

    /// Soul `s` on body `body` starts form `form` at `node` (with `other` as its thing argument); returns the run's
    /// first log entry's index.
    fn start(&mut self, s: Id, body: Id, node: Id, form: &str, other: Option<Id>) -> usize {
        self.asked += 1;
        let mut digest = [0; 32];
        digest[..8].copy_from_slice(&self.asked.to_le_bytes());
        let intent = Intent {
            id: Id::new(Scope([0xf6; 16]), self.asked).expect("an id"),
            expiry: Micros::MAX / 2,
            actor: Actor::Soul(s),
            digest,
        };
        let args = other
            .map(|o| BTreeMap::from([("other".to_owned(), o)]))
            .unwrap_or_default();
        let steps = bind(&self.entry, form).expect("steps bind");
        let effects = bind_effects_with(&self.entry, form, &args).expect("effects bind");
        let now = self.now;
        let from = self.log.len();
        let (mut w, forms) = self.world();
        forms
            .start(
                &mut w,
                body,
                node,
                intent,
                steps,
                effects,
                Limits::default(),
                now,
            )
            .expect("started");
        self.flush();
        from
    }

    /// Runs every run to its end; the name the last one ended with.
    fn run(&mut self) -> String {
        while !self.forms.is_empty() {
            assert!(self.now < 60_000_000, "the runs end");
            self.tick();
        }
        let ended = self.forms.ended.pop().expect("a run ended");
        self.forms.ended.clear();
        ended.how.as_str().to_owned()
    }

    /// One form, run to its end: its ending's name.
    fn act(&mut self, s: Id, body: Id, node: Id, form: &str) -> String {
        self.start(s, body, node, form, None);
        self.run()
    }

    /// The links of type `ty` at `node` on the tree: (other end, owning end, audience), sorted.
    fn links(&self, node: Id, ty: &str) -> Vec<(Id, Id, Audience)> {
        let mut out: Vec<_> = self
            .tree
            .links_at(node)
            .iter()
            .filter(|e| self.tree.ty(e).as_str() == ty)
            .map(|e| {
                let (_, ends, owner, audience) = self.tree.link(e.link).expect("the link");
                let owning = match owner {
                    End::First => ends[0],
                    End::Second => ends[1],
                };
                (e.other, owning, audience)
            })
            .collect();
        out.sort();
        out
    }

    /// Whether the log from entry `from` on writes a link or an unlink other than the forms' reservations.
    fn linked_since(&self, from: usize) -> bool {
        self.log[from..]
            .iter()
            .flat_map(Effect::changes)
            .any(|c| match &c.change {
                Change::Link { ty, .. } => ty.as_str() != super::RESERVES,
                _ => false,
            })
    }
}

#[test]
fn a1_link_and_unlink_commit_as_k5_links_between_the_actor_and_the_thing() {
    let mut b = Bench::new();
    let (rack, other_rack) = (id(100), id(101));
    // A link from the body: two bodies join one rack, each one link owned by the rack, seen by everyone.
    assert_eq!(b.act(soul(51), id(2), rack, "join"), "done");
    assert_eq!(b.act(soul(52), id(3), rack, "join"), "done");
    let everyone = Audience::Everyone;
    assert_eq!(
        b.links(rack, USER),
        vec![(id(2), rack, everyone), (id(3), rack, everyone)]
    );
    assert_eq!(b.links(id(2), USER), vec![(rack, rack, everyone)]);
    // A link from the Soul ends at the actor's Soul, not its body.
    assert_eq!(b.act(soul(51), id(2), rack, "join_soul"), "done");
    assert_eq!(b.links(rack, MEMBER), vec![(soul(51), rack, everyone)]);
    // Unlink from the actor takes down its own link alone. With none to take down it changes nothing, and its entry,
    // carrying the effect's key alone, commits.
    assert_eq!(b.act(soul(51), id(2), rack, "leave"), "done");
    assert_eq!(b.links(rack, USER), vec![(id(3), rack, everyone)]);
    assert_eq!(b.act(soul(51), id(2), rack, "leave"), "done");
    assert_eq!(b.act(soul(51), id(2), other_rack, "clear"), "done");
    assert_eq!(b.links(rack, USER), vec![(id(3), rack, everyone)]);
    assert_eq!(b.links(other_rack, USER), vec![]);
    // Unlink from all takes down every link of the type the rack owns, and no other type.
    assert_eq!(b.act(soul(51), id(2), rack, "join"), "done");
    assert_eq!(b.links(rack, USER).len(), 2);
    let from = b.log.len();
    assert_eq!(b.act(soul(51), id(2), rack, "clear"), "done");
    assert_eq!(b.links(rack, USER), vec![]);
    assert_eq!(b.links(rack, MEMBER), vec![(soul(51), rack, everyone)]);
    let unlinks = b.log[from..]
        .iter()
        .flat_map(Effect::changes)
        .filter(|c| matches!(c.change, Change::Unlink { .. }))
        .count();
    assert_eq!(unlinks, 3, "two links and the run's reservation");
}

#[test]
fn a1_a_form_that_fails_before_its_contact_links_nothing() {
    let mut b = Bench::new();
    let rack = id(100);
    // Left before the hand step's contact: the run ends `left` and writes no link.
    let from = b.start(soul(51), id(2), rack, "join_by_hand", None);
    let now = b.now;
    {
        let (mut w, forms) = b.world();
        forms.leave(&mut w, id(2), None, now).expect("left");
    }
    assert_eq!(b.run(), "left");
    assert!(
        !b.linked_since(from),
        "a run left before contact links nothing"
    );
    assert_eq!(b.links(rack, USER), vec![]);
    // Run to its contact, the same form links.
    assert_eq!(b.act(soul(51), id(2), rack, "join_by_hand"), "done");
    assert_eq!(b.links(rack, USER).len(), 1);
    // A link written with an effect that is refused is taken back with it: all of a run's effects or none.
    let from = b.start(soul(52), id(3), rack, "join_and_remove", Some(id(200)));
    assert_eq!(b.run(), "not-held");
    assert!(
        !b.linked_since(from),
        "a refused effect takes its link with it"
    );
    assert_eq!(b.links(rack, USER).len(), 1);
}

#[test]
fn a1_a_link_effect_binds_only_from_a_link_the_kind_declares_and_seen_by_everyone() {
    let refused = |effect: &str| {
        let text = ENTRY.replace(
            r#""effects": [{ "change": "link", "link": "user", "from": "actor", "event": "joined" }] },
    "join_soul""#,
            &format!(r#""effects": [{effect}] }},
    "join_soul""#),
        );
        assert_ne!(text, ENTRY);
        let entry = parse(&text).expect("JSON");
        bind_effects_with(&entry, "join", &BTreeMap::new())
            .expect_err("refused")
            .name
    };
    assert_eq!(
        refused(r#"{ "change": "link", "link": "nobody", "from": "actor" }"#),
        "link-unknown"
    );
    assert_eq!(
        refused(r#"{ "change": "link", "link": "user", "from": "all" }"#),
        "effect-malformed"
    );
    let private = ENTRY.replace(
        r#""from": "body", "most": 4, "audience": { "rule": "everyone" }"#,
        r#""from": "body", "most": 4, "audience": { "rule": "linked", "link": "user" }"#,
    );
    let entry = parse(&private).expect("JSON");
    assert_eq!(
        bind_effects_with(&entry, "join", &BTreeMap::new())
            .expect_err("refused")
            .name,
        "effect-not-built",
        "a link seen by its members needs its audience node (T8)"
    );
    assert!(bind_effects_with(&entry, "leave", &BTreeMap::new()).is_ok());
}

/// The rack given a seat and a swing's two forms, as content's swings write them: `swing` takes the seat then waits
/// 30 s, linking its swinger; `get_off` is the swinger's alone, a rise that unlinks it.
fn swing_entry() -> json::Value {
    let forms = r#""slots": { "place": { "admits": "body", "posture": "sit", "most": 1 } },
  "forms": {
    "swing": { "who": "anyone", "steps": [{ "step": "sit", "slot": "place" }, { "step": "wait", "us": 30000000 }],
      "effects": [{ "change": "link", "link": "user", "from": "actor", "event": "began" }] },
    "get_off": { "who": { "link": "user" }, "steps": [{ "step": "rise" }],
      "effects": [{ "change": "unlink", "link": "user", "from": "actor", "event": "got_off" }] },
    "kick": { "who": { "link": "user" }, "steps": [{ "step": "wait", "us": 1000000 }], "effects": [] },"#;
    let text = ENTRY.replacen(r#""forms": {"#, forms, 1);
    assert_ne!(text, ENTRY);
    parse(&text).expect("JSON")
}

impl Bench {
    /// The rack's seat (the chair fixture's place), its stand point where body 2 stands.
    fn sit_place(&mut self) {
        const CHAIR: &str = include_str!("../../../replica/fixtures/seats/chair.diag");
        let place = replica::moves::Place::from_value(
            &decode(&fixture_bytes(CHAIR).expect("bytes"))
                .expect("decodes")
                .value,
        )
        .expect("the chair's place");
        let at = |point| crate::slots::PlaceAt {
            thing: id(100),
            place: place.clone(),
            point,
            facing: Quat::IDENTITY,
            floor: id(1),
            more: Vec::new(),
        };
        let stand = at(Vec3::new(0, place.height, 0)).stand().expect("a stand");
        let mut slots = crate::slots::Slots::new();
        slots
            .add(at(Vec3::new(-stand.x, place.height, -stand.z)))
            .expect("a place");
        self.slots = Some(slots);
    }

    /// Soul 51 on body 2 asks for form `form` of the rack through who may ([`Forms::commit`]).
    fn commit(&mut self, form: &str) -> Result<super::Asked, replica::effects::Refusal> {
        self.asked += 1;
        let mut digest = [0; 32];
        digest[..8].copy_from_slice(&self.asked.to_le_bytes());
        let intent = Intent {
            id: Id::new(Scope([0xf6; 16]), self.asked).expect("an id"),
            expiry: Micros::MAX / 2,
            actor: Actor::Soul(soul(51)),
            digest,
        };
        let entry = self.entry.clone();
        let now = self.now;
        let (mut w, forms) = self.world();
        let asked = forms.commit(
            &mut w,
            &BTreeMap::new(),
            &|_| None,
            id(2),
            id(100),
            &entry,
            form,
            intent,
            Limits::default(),
            now,
        );
        self.flush();
        asked
    }

    fn until(&mut self, t: Micros) {
        while self.now < t {
            self.tick();
        }
    }
}

/// A swing's `get_off` asked before its seat is taken (on the way to it, or while sitting down) is the swinger-to-be's:
/// who may lets the body whose own swing run links it through, so the swing is not left running while its get_off is
/// refused `not-permitted` (Eden, 25 Nov). The get_off ends the swing and the body ends off it, unlinked.
#[test]
fn a_swings_get_off_before_its_seat_is_taken_ends_the_swing() {
    let mut b = Bench::new();
    b.entry = swing_entry();
    b.sit_place();
    assert!(matches!(b.commit("swing"), Ok(super::Asked::Started(_))));
    b.tick();
    assert_eq!(
        b.links(id(100), USER).len(),
        0,
        "not linked before the sit's contact"
    );
    // A form of the swinger's that is not its way off (a kick) is still theirs alone: refused, the swing goes on.
    let kick = b.commit("kick");
    assert_eq!(
        kick.map_err(|r| r.name),
        Err("not-permitted"),
        "only a way off"
    );
    assert!(b.forms.at(id(2)).is_some(), "the swing goes on");
    let off = b.commit("get_off");
    assert!(matches!(off, Ok(super::Asked::Started(_))), "{off:?}");
    assert_eq!(b.run(), "done", "got off");
    assert_eq!(b.links(id(100), USER), vec![], "unlinked");
    assert_eq!(b.forms.at(id(2)), None, "no swing left running");
}

/// E7 review: a seat taken and then only waited in (a swing) links its swinger at the seat's contact, not after the
/// wait, since the posture outlives the run. So 10 s into a 30 s swing the swinger may `get_off`; and a Soul whose
/// swing is left at 10 s stays linked, and may get off after.
#[test]
fn e7_a_swing_links_its_swinger_at_the_seat_so_get_off_works_mid_swing_or_after_a_leave() {
    for leave in [false, true] {
        let mut b = Bench::new();
        b.entry = swing_entry();
        b.sit_place();
        assert!(matches!(b.commit("swing"), Ok(super::Asked::Started(_))));
        b.until(10_000_000);
        assert_eq!(b.forms.at(id(2)), Some(1), "{leave}: in the swing's wait");
        assert_eq!(b.links(id(100), USER).len(), 1, "linked at the sit");
        if leave {
            let now = b.now;
            {
                let (mut w, forms) = b.world();
                forms.leave(&mut w, id(2), None, now).expect("left");
            }
            assert_eq!(b.run(), "left");
            assert_eq!(
                b.links(id(100), USER).len(),
                1,
                "a left swing keeps its link"
            );
        }
        let off = b.commit("get_off");
        println!("leave {leave}: get_off at {} µs: {off:?}", b.now);
        assert!(
            matches!(off, Ok(super::Asked::Started(_))),
            "{leave}: {off:?}"
        );
        assert_eq!(b.run(), "done", "{leave}: got off");
        assert_eq!(b.links(id(100), USER), vec![], "{leave}: unlinked");
    }
}
