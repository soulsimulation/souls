//! E4's checks (#2772) in Eden 2026, from N1's exported facts: the seven set-downs of the 240 requests (a flower pot on
//! a windowsill, a pie on a doorstep, crates stacked, two armchairs swapped, a flag planted on the beach, a tent
//! pitched, a hopscotch chalked), one refusal by G2's rule, the one-place check over the log, and the ground's rebuild
//! times. Run `node v2/tools/import-eden/export/export.ts` from the repository root, then
//! `cargo test -p sim --release setdown -- --ignored --nocapture` from `v2/`.
//!
//! The bodies are stand-ins (a thing with two hand slots, a Soul's each) placed where the case needs them; walking to
//! the spot and taking the thing up are N9's and B4's, so the things are put in the hands by B4's transfer.

use std::collections::BTreeMap;
use std::time::Instant;

use import_eden::Import;
use replica::effects::{Body, Cause, Change, Header, Part, Refusal, TransferRec, schema_hash};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::kinds::Kinds;
use replica::kinds::place::{Facing, Outlines, Word};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::rules::json::parse;
use replica::time::Micros;
use replica::tree::Tree;
use replica::world_model::{Audience, parse_kinds, plain, show};

use super::{Ask, Chosen, SetDown, What, World, judge, judge_on, part, plan, root_of};
use crate::edit::safety::{Known, Who};
use crate::ground::scene::Scene;
use crate::ground::{HUMAN_RADIUS, OpenGround};
use crate::ground::{Turn, cut_floor};
use crate::links::Doors;
use crate::routes::HANDS;
use crate::slots::hands::{Entry, transfer};
use crate::spots::flat;
use crate::walk::town::Town;
use replica::select::Spot;

const FACTS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../.local/import-eden/eden-2026.facts.json"
);
const HOLDER: &str = "{1: \"test:holder\", 2: \"thing\", 6: {1: [\"thing\"], 2: [\"thing\"]}}";
/// A hopscotch court chalked on the ground: 1 m by 3 m, flat.
const HOPSCOTCH: &str = "{1: \"test:hopscotch\", 2: \"thing\", 7: {1: [1000, 0, 3000]}}";

fn content(path: &str) -> String {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../content/kinds/");
    std::fs::read_to_string(format!("{p}{path}")).expect("a content kind")
}

/// A content entry's `geometry.bounds_mm`, as diagnostic notation.
fn bounds(path: &str) -> [i64; 3] {
    let j = parse(&content(path)).expect("json");
    let b = j
        .get("geometry")
        .and_then(|g| g.get("bounds_mm"))
        .expect("bounds");
    let v: Vec<i64> = b
        .arr()
        .expect("a list")
        .iter()
        .map(|n| match n {
            replica::rules::json::Value::Int(i) => *i as i64,
            _ => panic!("a whole number"),
        })
        .collect();
    [v[0], v[1], v[2]]
}

struct Eden {
    town: Town,
    kinds: Kinds,
    /// Outlines of imported kinds that give none of their own and have no boxes, from Soul Actions' entries.
    by_plain: BTreeMap<String, Outlines>,
    nodes: BTreeMap<String, Id>,
    ground: Id,
    holder: Name,
    /// The test kinds' full names: the holder, the hopscotch, the tent.
    names: Vec<Name>,
    /// Today's def ref to its kind's full name.
    kinds_by_ref: BTreeMap<String, String>,
    mint: Minter,
    /// Each stand-in body's Soul, and the Souls not yet given a body.
    souls: BTreeMap<Id, Id>,
    spare: Vec<Id>,
    /// The tree as imported, and every part committed since.
    start: Tree,
    log: Vec<Part>,
    at: Micros,
}

fn header(root: Id, kinds: &[Name]) -> Header {
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/e4-setdown/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(root.scope().0.to_vec())),
        (4, root.to_value()),
        (5, Value::Uint(0)),
        (
            6,
            Value::Array(kinds.iter().map(|k| Value::Text(k.clone())).collect()),
        ),
        (7, Value::Array(Vec::new())),
    ]));
    Header::read(&encode(&v).unwrap()).unwrap()
}

fn eden() -> Eden {
    let text =
        std::fs::read_to_string(FACTS).expect("run v2/tools/import-eden/export/export.ts first");
    let Import {
        tree,
        mut rules,
        nodes,
        kinds: kinds_by_ref,
        ..
    } = import_eden::load(&text).expect("Eden loads");
    let [w, h, d] = bounds("containers/tent.json");
    let tent = format!("{{1: \"test:tent\", 2: \"thing\", 7: {{1: [{w}, {h}, {d}]}}}}");
    let texts = [HOLDER, HOPSCOTCH, tent.as_str()];
    let mut kinds = Kinds::default();
    let names = kinds.load(&[
        ("holder", HOLDER),
        ("hopscotch", HOPSCOTCH),
        ("tent", &tent),
    ]);
    assert_eq!(names.len(), 3, "{:?}", kinds.refused());
    rules
        .kinds
        .extend(parse_kinds(&texts.join("\n")).expect("the test kinds"));
    let mut spare = Vec::new();
    let mut mint = Minter::new(Scope([0xe4; 16]));
    for _ in 0..12 {
        let s = mint.mint().unwrap();
        rules.souls.insert(s);
        spare.push(s);
    }
    let root = nodes["world"];
    let ground = nodes["ground"];
    let hd = header(root, &names);
    let next = tree.to_state().next;
    let start = tree.frozen();
    let town = Town::new(tree, ground, Doors::new(hd, rules, next)).expect("the town");
    let o = |p: &str| {
        let [w, h, d] = bounds(p);
        replica::kinds::place::Geometry {
            bounds_mm: [w, h, d],
            front: true,
        }
        .outlines()
    };
    let by_plain = BTreeMap::from([
        ("core:flower_pot".to_owned(), o("garden/nursery_pot.json")),
        ("core:pie_pack".to_owned(), o("kitchen/pie.json")),
    ]);
    Eden {
        town,
        holder: names[0].clone(),
        names: names.clone(),
        kinds_by_ref,
        kinds,
        by_plain,
        nodes,
        ground,
        mint: Minter::new(Scope([0xe5; 16])),
        souls: BTreeMap::new(),
        spare,
        start,
        log: Vec::new(),
        at: 1_000_000,
    }
}

/// The things of an imported kind (plain name), in id order.
fn of_kind(tree: &Tree, kind: &str) -> Vec<Id> {
    let mut out = Vec::new();
    let mut stack = vec![tree.root()];
    while let Some(h) = stack.pop() {
        let Some(n) = tree.node(h) else { continue };
        if plain(n.kind().as_str()) == kind {
            out.push(n.id());
        }
        stack.extend(tree.children(h).unwrap_or(&[]).iter().copied());
    }
    out.sort();
    out
}

fn m(v: i64) -> String {
    format!("{:.2}", v as f64 / 1e6)
}

/// A kind's outlines: its section 7, else Soul Actions' entry for an imported kind with none.
fn outline(kinds: &Kinds, by_plain: &BTreeMap<String, Outlines>, k: &Name) -> Option<Outlines> {
    kinds
        .get(k.as_str())
        .and_then(|d| d.geometry)
        .map(|g| g.outlines())
        .or_else(|| by_plain.get(plain(k.as_str())).copied())
}

impl Eden {
    fn header(&self) -> Header {
        self.town.doors.header.clone()
    }

    /// Commits a part. A part that touches no node's ground is committed with no rebuild; one that does goes through
    /// G3's path (rebuilt off the clock thread, installed on the tick it commits), and the touched ground is also cut
    /// alone: N3's cut of each touched floor, or of each open-ground square under the thing.
    #[allow(clippy::disallowed_methods)] // times the rebuild: the wall-clock rule binds the engine, not this test
    fn commit(&mut self, p: Part) -> Rebuild {
        let hd = self.header();
        let before = self.town.tree.frozen();
        let mut after = before.frozen();
        after.apply(&hd, &p).expect("the part applies");
        let touched = crate::ground::touched(&before, &after, &p);
        let mut out = Rebuild::default();
        if touched.is_empty() {
            self.town
                .tree
                .commit(&hd, &p, &self.town.doors.rules)
                .expect("the part commits");
            self.town.doors.next += p.effects.len() as u64;
        } else {
            let (versions, basis) = (self.town.versions.clone(), self.town.basis());
            let t0 = Instant::now();
            let r = Town::rebuild(before, &hd, self.ground, &versions, &basis, &p)
                .expect("the rebuild");
            out.g3_ns = t0.elapsed().as_nanos();
            out.whole = r.whole();
            out.touched = touched.len();
            self.town.install(r, &p).expect("the part commits");
            for n in &touched {
                if *n == self.ground {
                    let og =
                        OpenGround::of(&after, self.ground, HUMAN_RADIUS).expect("open ground");
                    for (i, j) in squares(&after, &p) {
                        let t0 = Instant::now();
                        let patch = og.cut_square(i, j);
                        out.cut_ns.push(t0.elapsed().as_nanos());
                        assert!(!patch.pieces.is_empty());
                    }
                } else {
                    let t0 = Instant::now();
                    let s = Scene::of(&after, *n).expect("a floor");
                    cut_floor(&s, HUMAN_RADIUS, Turn::NONE).expect("its cut");
                    out.cut_ns.push(t0.elapsed().as_nanos());
                }
            }
        }
        self.log.push(p);
        self.at += 1_000_000;
        out
    }

    fn world_part(&self, entries: Vec<Entry>) -> Part {
        let mut p = part(
            &self.header(),
            self.town.doors.next,
            self.at,
            self.spare[0],
            Cause::World,
            entries,
        )
        .unwrap();
        for e in &mut p.effects {
            e.envelope.actor = replica::effects::Actor::World;
        }
        let bytes = encode(&p.to_value()).unwrap();
        Part::read(&bytes).unwrap()
    }

    /// A stand-in body for a new Soul, standing at `position` in `parent`'s frame on `surface`.
    fn body(&mut self, parent: Id, position: Vec3, surface: Id) -> Id {
        let soul = self.spare.remove(0);
        let body = self.mint.mint().unwrap();
        let e = (
            parent,
            Audience::Everyone,
            replica::effects::Body::Changes(vec![replica::effects::ChangeRec {
                change: replica::effects::Change::Create {
                    node: body,
                    kind: self.holder.clone(),
                    pose: Pose {
                        frame: Frame {
                            node: parent,
                            slot: None,
                        },
                        position,
                        orientation: Quat::IDENTITY,
                        support: Support::Surface { surface, height: 0 },
                    },
                    audience: Audience::Everyone,
                    fields: BTreeMap::new(),
                },
                rest: replica::effects::Rest::new(),
            }]),
        );
        let p = self.world_part(vec![e]);
        self.commit(p);
        self.souls.insert(body, soul);
        body
    }

    /// B4's transfer of `thing` into `body`'s first free hand.
    fn take(&mut self, body: Id, thing: Id) {
        let t = &self.town.tree;
        let slot = if crate::slots::in_slot(t, body, 1).is_none() {
            1
        } else {
            2
        };
        let id = self.mint.mint().unwrap();
        let hd = self.header();
        let to = Frame {
            node: body,
            slot: Some(slot),
        };
        let e = transfer(&hd, thing, Audience::Everyone, to, id);
        let p = self.world_part(e.to_vec());
        self.commit(p);
    }

    /// Every stand-in body, as G2 judges it, and where each stands (root µm), which a set-down avoids.
    fn bodies(&self) -> (Vec<Who>, Vec<Vec3>) {
        let t = &self.town.tree;
        let mut whos = Vec::new();
        let mut at = Vec::new();
        for (&body, &soul) in &self.souls {
            let Some(n) = t.handle(body).and_then(|h| t.node(h)) else {
                continue;
            };
            let place = n.place().unwrap();
            whos.push(Who {
                soul,
                body,
                pose: Pose {
                    frame: Frame {
                        node: n.parent().unwrap(),
                        slot: None,
                    },
                    position: place.position,
                    orientation: place.orientation,
                    support: place.support,
                },
                has: HANDS,
                crossing: None,
            });
            at.push(root_of(t, body).unwrap().pos);
        }
        (whos, at)
    }

    /// Plans a set-down by `body`'s Soul, as one part.
    fn plan(
        &mut self,
        body: Id,
        what: What,
        word: Word,
        anchor: Option<Id>,
        facing: Facing,
    ) -> Result<(SetDown, Part), Refusal> {
        let (_, at) = self.bodies();
        let soul = self.souls[&body];
        let hd = self.header();
        let ask = Ask {
            soul,
            body,
            what,
            word,
            anchor,
            facing,
            bodies: &at,
        };
        let (kinds, by_plain) = (&self.kinds, &self.by_plain);
        let outline = |k: &Name| outline(kinds, by_plain, k);
        let mint = &mut self.mint;
        let rules = self.town.doors.rules.clone();
        let at_now = self.at;
        let sd = self.town.with_ground(|tree, g| {
            let mut w = World {
                tree,
                rules: &rules,
                ground: g,
                outlines: &outline,
                header: &hd,
                mint,
            };
            plan(&mut w, &ask, at_now)
        })?;
        let p = part(
            &hd,
            self.town.doors.next,
            self.at,
            soul,
            Cause::World,
            sd.entries.clone(),
        )?;
        Ok((sd, p))
    }

    /// Plans a set-down, judges it by G2's rule for the bodies as they stand, and commits it.
    fn set_down(
        &mut self,
        body: Id,
        what: What,
        word: Word,
        anchor: Option<Id>,
        facing: Facing,
    ) -> Result<(Chosen, Rebuild), Refusal> {
        let (sd, p) = self.plan(body, what, word, anchor, facing)?;
        let (whos, _) = self.bodies();
        let whole = judge(
            &self.town.tree,
            &self.header(),
            Some(self.ground),
            &p,
            &whos,
        );
        // G2b (#3488): the guard on the town judges as the whole world's.
        let known = Known::of(&self.town);
        let on = judge_on(&self.town.tree, &self.header(), &p, &whos, &known);
        assert_eq!(format!("{on:?}"), format!("{whole:?}"), "G2b: same verdict");
        whole?;
        Ok((sd.chosen, self.commit(p)))
    }

    fn pos(&self, id: Id) -> Vec3 {
        root_of(&self.town.tree, id).unwrap().pos
    }

    /// A stand-in body beside `thing` (in its parent's frame, `dx` µm along x), on the ground it stands on.
    fn beside(&mut self, thing: Id, dx: i64) -> Id {
        let t = &self.town.tree;
        let n = t.node(t.handle(thing).unwrap()).unwrap();
        let (parent, place) = (n.parent().unwrap(), n.place().unwrap());
        let (surface, _) = replica::select::standing(t, thing).unwrap();
        let at = Vec3::new(place.position.x + dx, place.position.y, place.position.z);
        self.body(parent, at, surface)
    }

    /// A stand-in body on the open ground at root point `p`.
    fn on_ground(&mut self, p: Vec3) -> Id {
        let g = self.ground;
        self.body(g, Vec3::new(p.x, 0, p.z), g)
    }

    fn kind_of(&self, id: Id) -> String {
        let t = &self.town.tree;
        t.handle(id)
            .and_then(|h| t.node(h))
            .map_or(String::new(), |n| plain(n.kind().as_str()).to_owned())
    }

    fn row(&self, case: &str, c: &Chosen, r: &Rebuild) -> String {
        let p = self.pos(c.thing);
        format!(
            "| {case} | {} | {}, on {} | ({}, {}, {}) | {}.{} | {} |",
            self.kind_of(c.thing),
            self.kind_of(c.parent),
            self.kind_of(c.surface),
            m(p.x),
            m(p.y),
            m(p.z),
            c.ring,
            c.k,
            r.show()
        )
    }
}

/// What a commit's ground cost: G3's rebuild (ns), whether it built the whole ground, how many nodes it touched, and
/// N3's cut of each touched node's ground alone (ns).
#[derive(Debug, Default)]
struct Rebuild {
    g3_ns: u128,
    whole: bool,
    touched: usize,
    cut_ns: Vec<u128>,
}

impl Rebuild {
    fn show(&self) -> String {
        if self.touched == 0 {
            return "none".into();
        }
        let ms = |ns: u128| format!("{:.2}", ns as f64 / 1e6);
        format!(
            "N3 cut {} ms; G3 {} ms ({})",
            self.cut_ns
                .iter()
                .map(|n| ms(*n))
                .collect::<Vec<_>>()
                .join(", "),
            ms(self.g3_ns),
            if self.whole {
                "whole ground"
            } else {
                "the building"
            }
        )
    }
}

/// The open ground's squares (`crate::ground::SQUARE`) under what the part sets down or makes there.
fn squares(after: &Tree, p: &Part) -> Vec<(i32, i32)> {
    let mut out = Vec::new();
    for e in &p.effects {
        let node = match &e.body {
            Body::Transfer(TransferRec::Leave { node, .. }) => *node,
            Body::Changes(cs) => match cs.first().map(|c| &c.change) {
                Some(Change::Create { node, .. }) => *node,
                _ => continue,
            },
            _ => continue,
        };
        let Ok(x) = root_of(after, node) else {
            continue;
        };
        let sq = crate::ground::SQUARE;
        let (i, j) = (
            (x.pos.x / 1000).div_euclid(sq),
            (x.pos.z / 1000).div_euclid(sq),
        );
        out.push((i as i32, j as i32));
    }
    out
}

/// How many nodes hold `thing` as a child in `tree`.
fn parents(tree: &Tree, thing: Id) -> usize {
    let Some(h) = tree.handle(thing) else {
        return 0;
    };
    let mut n = 0;
    let mut stack = vec![tree.root()];
    while let Some(at) = stack.pop() {
        let cs = tree.children(at).unwrap_or(&[]);
        n += cs.iter().filter(|c| **c == h).count();
        stack.extend(cs.iter().copied());
    }
    n
}

#[test]
#[ignore = "needs the exported Eden facts"]
fn the_seven_set_downs_in_eden() {
    let mut e = eden();
    let t = e.town.tree.frozen();
    let by_ref = e.kinds_by_ref.clone();
    let kind = |r: &str| plain(&by_ref[r]).to_owned();
    let free = |id: &Id| {
        t.handle(*id)
            .and_then(|h| t.node(h))
            .is_some_and(|n| n.slot().is_none())
    };
    let mut rows: Vec<String> = Vec::new();
    let mut moved: Vec<Id> = Vec::new();

    // 1. A flower pot on a windowsill.
    let pot = of_kind(&t, &kind("core-flower-pot@1"))[0];
    let window = of_kind(&t, import_eden::WINDOW)[0];
    let p = e.pos(window);
    let pb = e.on_ground(Vec3::new(p.x, 0, p.z + 3_000_000));
    e.take(pb, pot);
    let (c, r) = e
        .set_down(pb, What::Held(pot), Word::On, Some(window), Facing::AsItWas)
        .expect("the pot on the sill");
    assert_eq!(c.surface, window);
    rows.push(e.row("a flower pot on the windowsill (on)", &c, &r));
    moved.push(pot);

    // 2. A pie on a doorstep: in front of the first door whose front is the open ground.
    let pie = of_kind(&t, &kind("core-pie-pack@1"))[0];
    let door = of_kind(&t, &kind("core-door@2"))
        .into_iter()
        .find(|d| {
            replica::select::resolve(&t, &Spot::Front(*d), None, &|_, _| false)
                .is_ok_and(|r| r.frame == e.ground)
        })
        .expect("a door that opens outside");
    let d = e.pos(door);
    let pb = e.on_ground(Vec3::new(d.x + 2_500_000, 0, d.z + 2_500_000));
    e.take(pb, pie);
    let (c, r) = e
        .set_down(
            pb,
            What::Held(pie),
            Word::InFrontOf,
            Some(door),
            Facing::Toward(door),
        )
        .expect("the pie on the doorstep");
    assert_eq!(c.parent, e.ground);
    let gap = flat(e.pos(pie), d);
    assert!(gap < 2_000_000, "the pie is {} m from the door", m(gap));
    rows.push(e.row("a pie on a doorstep (in_front_of the door)", &c, &r));
    moved.push(pie);

    // 3. Crates stacked: one crate on another.
    let crates: Vec<Id> = of_kind(&t, &kind("core-crate@1"))
        .into_iter()
        .filter(free)
        .collect();
    let (a, b) = (crates[0], crates[1]);
    let cb = e.beside(b, 900_000);
    e.take(cb, a);
    let (c, r) = e
        .set_down(cb, What::Held(a), Word::On, Some(b), Facing::AsItWas)
        .expect("the crates stacked");
    assert_eq!((c.parent, c.surface), (b, b));
    assert!(e.pos(a).y > e.pos(b).y + 400_000);
    rows.push(e.row("crates stacked (on the crate)", &c, &r));
    moved.push(a);

    // 4. Two armchairs swapped: each Soul stands where the other's chair was and sets its own down there.
    let chairs: Vec<Id> = of_kind(&t, &kind("core-armchair@1"))
        .into_iter()
        .filter(free)
        .collect();
    let parent = |id: Id| t.node(t.handle(id).unwrap()).unwrap().parent();
    let (ca, cb2) = chairs
        .iter()
        .find_map(|a| {
            chairs
                .iter()
                .find(|b| *b != a && parent(**b) == parent(*a))
                .map(|b| (*a, *b))
        })
        .expect("two armchairs in one room");
    let (was_a, was_b) = (e.pos(ca), e.pos(cb2));
    let x = e.beside(cb2, 0);
    let y = e.beside(ca, 0);
    e.take(x, ca);
    e.take(y, cb2);
    let (c, r) = e
        .set_down(x, What::Held(ca), Word::Here, None, Facing::AsItWas)
        .expect("the first armchair where the second was");
    rows.push(e.row("two armchairs swapped: the first (here)", &c, &r));
    let (c, r) = e
        .set_down(y, What::Held(cb2), Word::Here, None, Facing::AsItWas)
        .expect("the second armchair where the first was");
    rows.push(e.row("two armchairs swapped: the second (here)", &c, &r));
    assert!(flat(e.pos(ca), was_b) < flat(e.pos(ca), was_a));
    assert!(flat(e.pos(cb2), was_a) < flat(e.pos(cb2), was_b));
    moved.extend([ca, cb2]);

    // 5. A flag planted on the beach: a Soul on the sea's shore sets a golf flag down where it stands.
    let flag = of_kind(&t, &kind("eden-golf-flag@1"))[0];
    let shore = e.nodes["e_d6506d17.shore"];
    let beach = (1..40)
        .map(|k| Vec3::new(61_381_000, 0, 147_337_000 + k * 1_000_000))
        .find(|p| e.town.map.spot(e.ground, *p).is_some())
        .expect("walkable sand on the shore");
    let fb = e.on_ground(beach);
    e.take(fb, flag);
    let (c, r) = e
        .set_down(fb, What::Held(flag), Word::Here, None, Facing::AsItWas)
        .expect("the flag on the beach");
    assert_eq!(c.parent, e.ground);
    assert!(r.touched > 0, "a flag is walked round");
    rows.push(e.row(
        &format!("a flag planted on the beach (here, {})", e.kind_of(shore)),
        &c,
        &r,
    ));
    moved.push(flag);

    // 6. A tent pitched: made where the Soul stands, beside the campsite.
    let camp = e.pos(of_kind(&t, &kind("core-tent@1"))[0]);
    let tb = e.on_ground(Vec3::new(camp.x + 6_000_000, 0, camp.z));
    let tent = e.names[2].clone();
    let (c, r) = e
        .set_down(tb, What::Make(tent), Word::Here, None, Facing::AsItWas)
        .expect("the tent pitched");
    assert!(r.touched > 0, "a tent is walked round");
    rows.push(e.row("a tent pitched (made here)", &c, &r));
    moved.push(c.thing);

    // 7. A hopscotch chalked: made flat where its Soul stands, so no ground is cut.
    let hb = e.on_ground(Vec3::new(camp.x + 6_000_000, 0, camp.z + 8_000_000));
    let hop = e.names[1].clone();
    let (c, r) = e
        .set_down(hb, What::Make(hop), Word::Here, None, Facing::AsItWas)
        .expect("the hopscotch chalked");
    assert_eq!(r.touched, 0, "a flat mark rebuilds no ground");
    rows.push(e.row("a hopscotch chalked (made here, flat)", &c, &r));
    moved.push(c.thing);

    // The refusal (A2): a crate set down where a Soul walks in after the check is refused by G2's rule before it
    // commits, naming that Soul; nothing is written.
    let c3 = crates[2];
    let qb = e.on_ground(Vec3::new(camp.x - 8_000_000, 0, camp.z));
    e.take(qb, c3);
    let (sd, _) = e
        .plan(qb, What::Held(c3), Word::Here, None, Facing::AsItWas)
        .expect("the plan");
    let to = e
        .pos(sd.chosen.parent)
        .plus(sd.chosen.pose.position)
        .unwrap();
    let z = e.on_ground(to);
    let zsoul = e.souls[&z];
    // On the commit tick the part is numbered from the zone's next sequence, as it would be written.
    let p = part(
        &e.header(),
        e.town.doors.next,
        e.at,
        e.souls[&qb],
        Cause::World,
        sd.entries.clone(),
    )
    .unwrap();
    let (whos, _) = e.bodies();
    let refused = judge(&e.town.tree, &e.header(), Some(e.ground), &p, &whos)
        .expect_err("refused before it commits");
    assert_eq!(refused.name, "edit.would-bury", "{}", refused.detail);
    assert!(refused.detail.contains(&show(zsoul)), "{}", refused.detail);
    let held = e.town.tree.node(e.town.tree.handle(c3).unwrap()).unwrap();
    assert_eq!(held.parent(), Some(qb), "nothing was written");
    println!(
        "refused: {} ({}): a Soul walked onto the chosen spot, {} m from the setter",
        refused.name,
        refused.detail,
        m(flat(e.pos(qb), to))
    );

    // The one-place check (A4): the log replayed from the import, each thing in exactly one place at every position.
    let mut tree = e.start.frozen();
    let hd = e.header();
    let mut positions = 0;
    for p in &e.log {
        tree.apply(&hd, p).expect("the log replays");
        positions += 1;
        for thing in &moved {
            let n = parents(&tree, *thing);
            assert!(
                n == 1 || (n == 0 && tree.handle(*thing).is_none()),
                "{} has {n} parents at position {positions}",
                show(*thing)
            );
        }
    }
    assert!(moved.iter().all(|t| parents(&tree, *t) == 1));
    println!(
        "one place: {} things in exactly one place at each of the {positions} positions of the log",
        moved.len()
    );

    println!("| case | thing | rests in, on | at (m, root) | ring.place | ground rebuilt |");
    println!("|---|---|---|---|---|---|");
    for r in &rows {
        println!("{r}");
    }
}
