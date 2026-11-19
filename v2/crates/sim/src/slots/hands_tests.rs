//! B4's checks (#2739): a thing goes shelf to hand to table as two transfers, with one parent at every position of
//! the log (A1, A2); a held pole reaches what the bare hand cannot (A3); a handless body is refused by name (A4); a
//! body that retires puts down what it holds first (A5). The kinds, the world and the moves are data, read here.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::Path;

use replica::bodies::{Class, Family};
use replica::effects::{
    Body, Change, ChangeRec, Effect, Header, Part, Rest, TransferRec, fixture_bytes, schema_hash,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{FIXTURE_SCOPE_A, Hash, Id, Minter, Purpose, Scope};
use replica::moves::{Effector, Move};
use replica::pose::{Frame, Quat, Vec3};
use replica::time::Micros;
use replica::tree::{Rules, Tree};
use replica::world_model::Audience;
use replica::world_model::{parse_kinds, parse_world};

use super::{Cx, Holding, Log, Slots, hands, in_slot};
use crate::controller::Controller;
use crate::ground::Piece;
use crate::mover::Surface;
use crate::moves::{Fired, Moves, Reach, load};
use crate::timers::DueList;

const FAMILIES: &str = include_str!("../../../replica/fixtures/bodies/families.diag");

/// The kinds: one place, a two-handed walker, a handless family, two things held in one hand, a stand with one slot,
/// a table with two, and a thing with a point to press. Section 18 says how a thing moves.
const KINDS: &str = r#"
{1: "test:ground", 2: "place", 11: ["body", "thing"]}
{1: "test:walker", 2: "family", 6: {1: ["thing"], 2: ["thing"]}}
{1: "test:hound", 2: "family"}
{1: "test:mug", 2: "thing", 18: {1: "one_hand"}}
{1: "test:pole", 2: "thing", 18: {1: "one_hand"}}
{1: "test:stand", 2: "thing", 6: {1: ["thing"]}}
{1: "test:table", 2: "thing", 6: {1: ["thing"], 2: ["thing"]}}
{1: "test:switch", 2: "thing", 18: {1: "fixed"}}
"#;

/// The world: the walker (2), the hound (3), the stand (4) with the mug (6) in its slot, the table (5), the pole (7) on
/// the ground and the switch (8).
const WORLD: &str = r#"
{
  1: [],
  2: {},
  3: [
    {1: 1, 2: "test:ground"},
    {1: 2, 2: "test:walker", 3: 1},
    {1: 3, 2: "test:hound", 3: 1},
    {1: 4, 2: "test:stand", 3: 1},
    {1: 5, 2: "test:table", 3: 1},
    {1: 6, 2: "test:mug", 3: 4, 4: 1},
    {1: 7, 2: "test:pole", 3: 1},
    {1: 8, 2: "test:switch", 3: 1}
  ],
  4: []
}
"#;

/// Take and put, as data: one hand reaches the thing's grip, or the place it is put; contact ends start-up.
const TAKE: &str = r#"{1: "souls:take", 2: 1, 3: [{1: 2, 2: 2}], 4: [2], 5: [2],
  6: [{1: "souls:start-up", 2: 400000}, {1: "souls:recovery", 2: 300000}], 7: {1: 2}, 8: 600000, 9: "souls:grip"}"#;
const PUT: &str = r#"{1: "souls:put", 2: 1, 3: [{1: 2, 2: 2}], 4: [2], 5: [2],
  6: [{1: "souls:start-up", 2: 500000}, {1: "souls:recovery", 2: 300000}], 7: {1: 2}, 8: 600000, 9: "souls:rest"}"#;

fn id(n: u64) -> Id {
    Id::new(FIXTURE_SCOPE_A, n).expect("an id")
}

fn read_move(text: &str) -> Move {
    let v = decode(&fixture_bytes(text).expect("bytes"))
        .expect("decodes")
        .value;
    Move::from_value(&v).expect("a move")
}

/// B2's press, from its fixture file.
fn press() -> Move {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../replica/fixtures/moves");
    load(&dir)
        .expect("the fixture moves")
        .into_iter()
        .find(|m| m.name.as_str() == "souls:press")
        .expect("the press")
}

fn families() -> (Family, Family) {
    let v = decode(&fixture_bytes(FAMILIES).expect("bytes"))
        .expect("decodes")
        .value;
    let Value::Array(fs) = v else {
        panic!("a list")
    };
    let fs: Vec<Family> = fs
        .iter()
        .map(|f| Family::from_value(f).expect("a family"))
        .collect();
    let has = |f: &&Family| f.resources.iter().any(|r| r.class == Class::Manipulator);
    let with = fs.iter().find(has).expect("hands").clone();
    let without = fs.iter().find(|f| !has(f)).expect("no hands").clone();
    (with, without)
}

/// A geometry on a line: each node's x in µm, the hand at its body's x. A tool held lengthens the hand to its tip.
struct Line {
    x: BTreeMap<Id, i64>,
    tools: BTreeMap<Id, (Name, i64)>,
    held: RefCell<BTreeMap<Name, Id>>,
}

impl Reach for Line {
    fn distance(
        &self,
        body: Id,
        e: &Effector,
        limb: Option<&Name>,
        target: Id,
        _: &Name,
    ) -> Option<i64> {
        let mut from = *self.x.get(&body)?;
        if let Effector::HeldPoint(p) = e {
            let held = *self.held.borrow().get(limb?)?;
            let (tip, length) = self.tools.get(&held)?;
            assert_eq!(tip, p, "reached from the tool's tip");
            from += length;
        }
        Some((self.x.get(&target)? - from).abs())
    }

    fn tip(&self, _: Id, limb: &Name) -> Option<Name> {
        let held = *self.held.borrow().get(limb)?;
        self.tools.get(&held).map(|t| t.0.clone())
    }
}

struct World {
    tree: Tree,
    log: Log,
    c: Controller,
    due: DueList,
    mint: Minter,
    moves: Moves,
    holding: Holding,
    slots: Slots,
    geo: Line,
    family: Family,
}

fn load_world() -> (Tree, Rules) {
    let kinds = parse_kinds(KINDS).expect("the kinds");
    Tree::load(&parse_world(&kinds, WORLD).expect("the world")).expect("loads")
}

fn header(zone: Id) -> Header {
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/b4-hands/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(zone.scope().0.to_vec())),
        (4, zone.to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(Vec::new())),
        (7, Value::Array(Vec::new())),
    ]));
    Header::read(&encode(&v).expect("bytes")).expect("a header")
}

fn world() -> World {
    let (tree, rules) = load_world();
    let next = tree.to_state().next;
    let ground_id = id(1);
    let corners = vec![
        [-5_000_000, 0, -5_000_000],
        [5_000_000, 0, -5_000_000],
        [5_000_000, 0, 5_000_000],
        [-5_000_000, 0, 5_000_000],
    ];
    let ground = Surface::new(
        ground_id,
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
            ground: crate::gaits::Ground::Dry,
        }],
    );
    let frame = Frame {
        node: ground_id,
        slot: None,
    };
    let (with, without) = families();
    let mut c = Controller::new();
    for (body, family) in [(id(2), with.clone()), (id(3), without)] {
        let placed = ground
            .place(body, frame, Vec3::ZERO, Quat::IDENTITY)
            .expect("placed");
        c.add(family, placed).expect("added");
    }
    // The walker and the hound stand at 0; the stand at 0.3 m, the table at 0.4 m, the pole at 0.2 m, the switch at
    // 1.2 m: beyond the press's 0.6 m from the hand, within it from the tip of the 1 m pole.
    let x = BTreeMap::from([
        (id(2), 0),
        (id(3), 0),
        (id(4), 300_000),
        (id(5), 400_000),
        (id(6), 300_000),
        (id(7), 200_000),
        (id(8), 1_200_000),
    ]);
    let tip = Name::new("souls:tip").expect("a name");
    World {
        log: Log::new(header(ground_id), rules, next),
        tree,
        c,
        due: DueList::new(),
        mint: Minter::new(Scope([0xb4; 16])),
        moves: Moves::new(),
        holding: Holding::new(),
        slots: Slots::new(),
        geo: Line {
            x,
            tools: BTreeMap::from([(id(7), (tip, 1_000_000))]),
            held: RefCell::new(BTreeMap::new()),
        },
        family: with,
    }
}

/// What holding works on, borrowed from the world's fields (not its holding).
macro_rules! cx {
    ($w:expr) => {
        Cx {
            tree: &mut $w.tree,
            log: &mut $w.log,
            slots: &$w.slots,
            c: &mut $w.c,
            due: &mut $w.due,
            mint: &mut $w.mint,
            moves: &mut $w.moves,
            geo: &$w.geo,
        }
    };
}

impl World {
    /// Runs every timer to the end, answering each contact; returns the contacts' results and the moves' ends.
    fn run(&mut self) -> (Vec<Result<(), &'static str>>, Vec<String>) {
        let (mut contacts, mut ends) = (Vec::new(), Vec::new());
        while let Some(t) = self.due.fire(Micros::MAX) {
            let Some(f) =
                self.moves
                    .fire(&mut self.c, &mut self.due, &mut self.mint, &self.geo, &t)
            else {
                continue;
            };
            if let Some(r) = self.holding.fired(&mut cx!(self), &f) {
                contacts.push(r.map_err(|e| e.name));
            }
            match f {
                Fired::Done(r) | Fired::Cancelled(r) => {
                    ends.push(r.ended.expect("ended").how.as_str().to_owned());
                }
                Fired::Phase { .. } => {}
            }
            self.sync();
        }
        (contacts, ends)
    }

    /// What the walker's hands hold, for the geometry.
    fn sync(&self) {
        let mut held = self.geo.held.borrow_mut();
        held.clear();
        for h in hands(&self.family) {
            if let Some(t) = in_slot(&self.tree, id(2), h.slot) {
                held.insert(h.resource, t);
            }
        }
    }

    fn parent(&self, n: Id) -> (Option<Id>, Option<u64>) {
        let node = self
            .tree
            .node(self.tree.handle(n).expect("live"))
            .expect("a node");
        (node.parent(), node.slot())
    }
}

/// Every node that lists `thing` as a child, after each part of the log, replayed from the start.
fn holders_over_log(w: &World, thing: Id) -> Vec<Vec<Id>> {
    let (mut tree, _) = load_world();
    let ids: Vec<Id> = (1..=8).map(id).collect();
    let holders = |tree: &Tree| {
        let Some(h) = tree.handle(thing) else {
            return Vec::new();
        };
        ids.iter()
            .copied()
            .filter(|p| {
                tree.handle(*p)
                    .and_then(|ph| tree.children(ph))
                    .is_some_and(|cs| cs.contains(&h))
            })
            .collect()
    };
    let mut out = vec![holders(&tree)];
    for effects in &w.log.parts {
        let bytes = encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(w.log.header.hash().to_bytes())),
            (
                2,
                Value::Array(effects.iter().map(Effect::to_value).collect()),
            ),
        ])))
        .expect("bytes");
        tree.apply(&w.log.header, &Part::read(&bytes).expect("a part"))
            .expect("the log replays");
        out.push(holders(&tree));
    }
    out
}

/// The transfer ids of a part: each a leave and an arrive under one id.
fn transfers(part: &[Effect]) -> Vec<(Id, &'static str)> {
    part.iter()
        .filter_map(|e| match &e.body {
            Body::Transfer(TransferRec::Leave { transfer, .. }) => Some((*transfer, "leave")),
            Body::Transfer(TransferRec::Arrive { transfer, .. }) => Some((*transfer, "arrive")),
            _ => None,
        })
        .collect()
}

#[test]
fn a_thing_goes_stand_to_hand_to_table_as_two_transfers_with_one_parent_throughout() {
    let mut w = world();
    let (walker, stand, table, mug) = (id(2), id(4), id(5), id(6));
    assert_eq!(w.parent(mug), (Some(stand), Some(1)));
    let take = read_move(TAKE);
    w.holding
        .take(&mut cx!(w), walker, &take, mug, 0)
        .expect("take started");
    assert_eq!(
        w.parent(mug),
        (Some(stand), Some(1)),
        "nothing moves before contact"
    );
    let (contacts, ends) = w.run();
    assert_eq!(contacts, vec![Ok(())]);
    assert_eq!(ends, vec!["done"]);
    // A2: while held, it is a child of the hand's slot.
    let hand = hands(&w.family)[0].clone();
    assert_eq!(w.parent(mug), (Some(walker), Some(hand.slot)));
    assert_eq!(in_slot(&w.tree, walker, hand.slot), Some(mug));
    let put = read_move(PUT);
    let onto = Frame {
        node: table,
        slot: Some(2),
    };
    w.holding
        .put(&mut cx!(w), walker, &put, mug, onto, 1_000_000)
        .expect("put started");
    let (contacts, ends) = w.run();
    assert_eq!((contacts, ends), (vec![Ok(())], vec!["done".to_owned()]));
    assert_eq!(w.parent(mug), (Some(table), Some(2)));
    // Two transfers, each a leave and an arrive under one id in one part.
    assert_eq!(w.log.parts.len(), 2);
    for part in &w.log.parts {
        let t = transfers(part);
        assert_eq!(t.len(), 2);
        assert_eq!((t[0].1, t[1].1), ("leave", "arrive"));
        assert_eq!(t[0].0, t[1].0, "one transfer id");
    }
    // A1: at every position of the log, exactly one parent.
    let over = holders_over_log(&w, mug);
    assert_eq!(over, vec![vec![stand], vec![walker], vec![table]]);
    let shown: Vec<Vec<String>> = over
        .iter()
        .map(|ps| ps.iter().map(|p| replica::world_model::show(*p)).collect())
        .collect();
    println!("parents of the thing over the log: {shown:?}");
}

#[test]
fn a_held_pole_presses_what_the_bare_hand_cannot() {
    let mut w = world();
    let (walker, pole, switch) = (id(2), id(7), id(8));
    let r = w
        .moves
        .start(
            &mut w.c,
            &mut w.due,
            &mut w.mint,
            &w.geo,
            walker,
            &press(),
            switch,
            0,
        )
        .expect_err("refused bare-handed");
    assert_eq!(r.name, "out-of-reach");
    println!("bare hand: {r}");
    w.holding
        .take(&mut cx!(w), walker, &read_move(TAKE), pole, 0)
        .expect("take the pole");
    assert_eq!(w.run().0, vec![Ok(())]);
    let hand = hands(&w.family)
        .into_iter()
        .find(|h| in_slot(&w.tree, walker, h.slot) == Some(pole))
        .expect("held");
    let mv = super::steer(&press(), &[hand.resource]);
    w.moves
        .start(
            &mut w.c,
            &mut w.due,
            &mut w.mint,
            &w.geo,
            walker,
            &mv,
            switch,
            1_000_000,
        )
        .expect("pressed with the pole");
    assert_eq!(w.run().1, vec!["done"], "contact within reach of the tip");
}

#[test]
fn a_handless_body_asking_to_take_is_refused_by_name() {
    let mut w = world();
    let r = w
        .holding
        .take(&mut cx!(w), id(3), &read_move(TAKE), id(6), 0)
        .expect_err("refused");
    assert_eq!(r.name, "take-needs-hands");
    assert!(w.moves.is_empty() && w.holding.is_empty() && w.log.parts.is_empty());
    assert!(
        w.c.claims(id(3)).expect("a body").running().is_empty(),
        "no claim"
    );
}

#[test]
fn a_body_that_retires_holding_a_thing_puts_it_down_first() {
    let mut w = world();
    let (walker, table, mug) = (id(2), id(5), id(6));
    w.holding
        .take(&mut cx!(w), walker, &read_move(TAKE), mug, 0)
        .expect("take");
    w.run();
    let down = [Frame {
        node: table,
        slot: Some(1),
    }];
    w.holding
        .put_down(&mut cx!(w), walker, &down, 2_000_000)
        .expect("put down");
    assert_eq!(transfers(w.log.parts.last().expect("a part")).len(), 2);
    // Then the body retires, as K10's `Life::retire` removes it from the tree: its subtree goes, the thing does not.
    let remove = Body::Changes(vec![ChangeRec {
        change: Change::Remove { node: walker },
        rest: Rest::new(),
    }]);
    w.log
        .write(
            &mut w.tree,
            2_000_000,
            vec![(walker, Audience::Everyone, remove)],
        )
        .expect("retired");
    assert!(w.tree.handle(walker).is_none(), "the body is gone");
    assert_eq!(
        w.parent(mug),
        (Some(table), Some(1)),
        "the thing is still in the world"
    );
}

#[test]
fn a_put_into_a_slot_filled_since_the_check_is_refused_and_the_thing_stays_held() {
    let mut w = world();
    let (walker, table, mug, pole) = (id(2), id(5), id(6), id(7));
    w.holding
        .take(&mut cx!(w), walker, &read_move(TAKE), mug, 0)
        .expect("take");
    w.run();
    let onto = Frame {
        node: table,
        slot: Some(1),
    };
    w.holding
        .put(&mut cx!(w), walker, &read_move(PUT), mug, onto, 1_000_000)
        .expect("put");
    // Before contact, the pole is set into that slot (by another writer).
    let id_ = w.mint.mint().expect("an id");
    let entries = super::transfer(
        &w.log.header,
        pole,
        replica::world_model::Audience::Everyone,
        onto,
        id_,
    );
    w.log
        .write(&mut w.tree, 1_100_000, entries.to_vec())
        .expect("filled");
    let (contacts, _) = w.run();
    assert_eq!(contacts, vec![Err("slot-occupied")]);
    assert!(w.moves.is_empty(), "the put is cancelled");
    assert_eq!(w.parent(mug).0, Some(walker), "still in the hand");
}

#[test]
fn a_move_cancelled_before_contact_transfers_nothing() {
    let mut w = world();
    let (walker, stand, mug) = (id(2), id(4), id(6));
    let n = w
        .holding
        .take(&mut cx!(w), walker, &read_move(TAKE), mug, 0)
        .expect("take");
    w.moves.cancel(
        &mut w.c,
        &mut w.due,
        n,
        100_000,
        Name::new("test:cancelled").expect("a name"),
    );
    let (contacts, _) = w.run();
    assert!(contacts.is_empty());
    let probe = Fired::Phase {
        instance: n,
        phase: 1,
    };
    assert!(
        w.holding.fired(&mut cx!(w), &probe).is_none(),
        "nothing pending"
    );
    assert_eq!(w.parent(mug), (Some(stand), Some(1)));
    assert!(w.log.parts.is_empty());
}
