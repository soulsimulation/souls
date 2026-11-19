//! Engine v2 E2 (#2709): the thirty described spots of `replica/src/select/thirty.txt`, resolved in Eden 2026 by the
//! client (a copy built from the import's log) and by the server (the world's tree), and bound: a slot as I5
//! binds it, a point by N9's table. It needs N1's exported facts: `node v2/tools/import-eden/export/export.ts` from the
//! repository root, then `cargo test -p sim --release --test select -- --ignored --nocapture` from `v2/`.

mod common;

use common::{id, town_of};
use replica::effects::{Header, Part};
use replica::encode::Name;
use replica::hash::state_hash;
use replica::ids::Id;
use replica::pose::Vec3;
use replica::select::{
    Among, Anchor, Answer, Order, Rank, Resolved, Spot, position, resolve, standing,
};
use replica::tree::Tree;
use sim::commit::bind::Bound;
use sim::commit::spot::{self, bind_slot};
use sim::spots::Entry;
use sim::walk::{Mark, World};
use std::collections::BTreeMap;

const THIRTY: &str = include_str!("../../replica/src/select/thirty.txt");

struct Line {
    n: String,
    words: String,
    spot: Spot,
    me: Id,
}

fn parse(nodes: &BTreeMap<String, Id>, kinds: &BTreeMap<String, String>, line: &str) -> Line {
    let f: Vec<&str> = line.split('|').map(str::trim).collect();
    let node = |k: &str| *nodes.get(k).unwrap_or_else(|| panic!("no node {k}"));
    let anchor = |k: &str| {
        if k == "me" {
            Anchor::Me
        } else {
            Anchor::Node(node(k))
        }
    };
    let order = |k: &str| match k {
        "nearest" => Order::Nearest,
        "furthest" => Order::Furthest,
        _ => panic!("order {k}"),
    };
    let w: Vec<&str> = f[3].split_whitespace().collect();
    let spot = match w[0] {
        "pick" => Spot::Pick {
            among: if w[1] == "slots" {
                Among::Slots
            } else {
                Among::Things
            },
            kind: Name::new(replica::world_model::plain(&kinds[w[2]])).unwrap(),
            node: node(w[4]),
            order: order(w[5]),
            anchor: anchor(w[6]),
            rank: match w[7] {
                "first" => Rank::First,
                "last" => Rank::Last,
                n => Rank::Nth(n.parse().unwrap()),
            },
        },
        "middle" => Spot::Middle(node(w[1])),
        "corner" => Spot::Corner {
            node: node(w[1]),
            order: order(w[2]),
            anchor: anchor(w[3]),
        },
        "end" => Spot::End {
            node: node(w[1]),
            order: order(w[2]),
            anchor: anchor(w[3]),
        },
        "along" => Spot::Along {
            node: node(w[1]),
            permille: w[2].parse().unwrap(),
            from: anchor(w[4]),
        },
        "edge" => Spot::Edge {
            node: node(w[1]),
            toward: node(w[3]),
        },
        "by" => Spot::By {
            node: node(w[1]),
            toward: anchor(w[3]),
        },
        "front" => Spot::Front(node(w[1])),
        "behind" => Spot::Behind(node(w[1])),
        "between" => Spot::Between(node(w[1]), node(w[2])),
        r => panic!("relation {r}"),
    };
    Line {
        n: f[0].to_owned(),
        words: f[1].to_owned(),
        spot,
        me: node(f[4].trim_start_matches("me=")),
    }
}

/// A point a body may stand at (`Map::spot`, exact) nearest `at` on `node`: on rings of 250 mm out to 10 m.
fn ground_near(town: &sim::walk::town::Town, node: Id, at: Vec3) -> Option<Vec3> {
    for r in 0..=40i64 {
        let n = if r == 0 { 1 } else { 6 * r };
        for k in 0..n {
            let off = replica::pose::Quat::from_yaw_mdeg(k * 360_000 / n)
                .and_then(|q| q.rotate(Vec3::new(0, 0, r * 250_000)))
                .ok()?;
            let p = Vec3::new(at.x + off.x, 0, at.z + off.z);
            if let Some(s) = town.map.spot(node, p) {
                return Some(Vec3::new(s.at[0] * 1000, s.at[1] * 1000, s.at[2] * 1000));
            }
        }
    }
    None
}

fn eden() -> import_eden::Import {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    let text =
        std::fs::read_to_string(path).expect("run v2/tools/import-eden/export/export.ts first");
    import_eden::load(&text).expect("Eden loads")
}

fn m(v: i64) -> String {
    format!("{:.1}", v as f64 / 1e6)
}

fn answer(r: &Result<Resolved, replica::effects::Refusal>, keys: &BTreeMap<Id, String>) -> String {
    match r {
        Err(e) => format!("refused {}", e.name),
        Ok(r) => match &r.answer {
            Answer::Slot { thing, slot, at } => {
                format!(
                    "slot {} of {} at ({}, {})",
                    slot,
                    keys[thing],
                    m(at[0]),
                    m(at[1])
                )
            }
            Answer::Thing { thing, at } => {
                format!("{} at ({}, {})", keys[thing], m(at[0]), m(at[1]))
            }
            Answer::Point { at } => format!("({}, {})", m(at[0]), m(at[1])),
        },
    }
}

#[test]
#[ignore = "needs the exported Eden facts"]
fn the_thirty_resolve_alike_in_client_and_server_and_bind_to_legal_spots() {
    let im = eden();
    let lines: Vec<Line> = THIRTY
        .lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .map(|l| parse(&im.nodes, &im.kinds, l))
        .collect();
    assert_eq!(lines.iter().filter(|l| l.n != "A4").count(), 30);
    let keys: BTreeMap<Id, String> = im.nodes.iter().map(|(k, v)| (*v, k.clone())).collect();

    // The client: a copy built from the import's log by the replica's apply (no rules), as a client's copy is.
    let (header, part) = &im.log;
    let root = im.tree.node(im.tree.root()).unwrap();
    let mut copy = Tree::start(root.id(), root.kind().clone());
    copy.apply(
        &Header::read(header).expect("the header"),
        &Part::read(part).expect("the part"),
    )
    .expect("the log applies");
    let (town, _) = town_of(eden(), b"e2-select");
    let server = &town.tree;
    assert_eq!(
        state_hash(&copy),
        state_hash(server),
        "client and server stand at the same version"
    );
    let free = |_: Id, _: u64| false;

    let mut town = town;
    let mut rows = Vec::new();
    let mut granted: BTreeMap<usize, (u16, u16, [i64; 3], usize)> = BTreeMap::new();
    let mut tick = 0;
    for (i, l) in lines.iter().enumerate() {
        let me = position(&town.tree, l.me).ok();
        let c = resolve(&copy, &l.spot, me, &free);
        let s = resolve(&town.tree, &l.spot, me, &free);
        assert_eq!(c, s, "{}: client and server differ", l.n);
        if l.n == "A4" {
            assert_eq!(s.as_ref().unwrap_err().name, "spot.no-front", "A4");
        } else {
            assert!(s.is_ok(), "{}: refused {:?}", l.n, s);
        }
        if let Ok(r) = &s
            && let spot::Spot::Stand(target) = spot::once(r)
        {
            // The asker stands on the ground where the line says; if N9 finds no place it can walk to from there,
            // it asks again from the ground nearest the target. N9 grants from where it stands.
            let me_at = standing(&town.tree, l.me).expect("the asker's place");
            for (k, (n, at)) in [me_at, (target.node, target.point())].iter().enumerate() {
                let Some(on) = ground_near(&town, *n, *at) else {
                    continue;
                };
                let who = id(1_000 + 10 * i as u64 + k as u64);
                tick += 1_000_000;
                let mark = Mark {
                    who,
                    node: *n,
                    at: on,
                    waiting: None,
                    crossing: None,
                    staying: false,
                    spot: Some((target, id(2_000 + i as u64))),
                };
                town.spots(&[mark], tick).expect("the tables write");
                if let Some(Ok(_)) = town.spot(who, &target) {
                    let g = town.spots.record.iter().rev().find_map(|e| match e {
                        Entry::Grant {
                            who: w,
                            place,
                            to,
                            actor,
                            ..
                        } if *w == who => Some((*place, *to, *actor)),
                        _ => None,
                    });
                    let (place, to, actor) = g.expect("a grant is recorded");
                    assert_eq!(actor, replica::effects::Actor::World, "the engine's choice");
                    granted.insert(i, (place.0, place.1, [to.x, to.y, to.z], k));
                    break;
                }
            }
        }
        rows.push((l, c, s));
    }
    println!("| # | words | relation | client | server | bound |");
    println!("|---|---|---|---|---|---|");
    let mut bound_all = true;
    for (i, (l, c, s)) in rows.iter().enumerate() {
        let bound = match s {
            Err(e) => format!("refused {}", e.name),
            Ok(r) => match spot::once(r) {
                spot::Spot::Slot { thing, slot } => match bind_slot(thing, |_| true, 1, false) {
                    Bound::Slot { thing, .. } => format!("slot {} of {}", slot, keys[&thing]),
                    b => {
                        bound_all = false;
                        format!("not bound: {b:?}")
                    }
                },
                spot::Spot::Stand(t) => match granted.get(&i) {
                    Some((ring, k, to, from)) => format!(
                        "stand ({}, {}) on {} ring {ring} place {k}{}",
                        m(to[0]),
                        m(to[2]),
                        keys.get(&t.node).map_or("?", String::as_str),
                        if *from == 0 {
                            ""
                        } else {
                            ", asked from beside it"
                        }
                    ),
                    None => {
                        bound_all = false;
                        "not granted".to_owned()
                    }
                },
            },
        };
        println!(
            "| {} | {} | {} | {} | {} | {} |",
            l.n,
            l.words,
            l.spot.relation(),
            answer(c, &keys),
            answer(s, &keys),
            bound
        );
    }
    assert!(
        bound_all,
        "every spot binds to a legal slot or standing spot"
    );
}
