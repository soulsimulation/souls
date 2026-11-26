//! DIAGNOSTIC (removed before the PR): one walk on Eden, in stepped world time, traced each second.

use replica::effects::Actor;
use replica::encode::Name;
use replica::ids::{Id, Scope};
use replica::pose::{Frame, Quat, Vec3};

fn facts_id(text: &str, name: &str) -> String {
    let f = replica::rules::json::parse(text).unwrap();
    ["things", "places"]
        .iter()
        .filter_map(|list| f.get(list).and_then(|v| v.arr()))
        .flatten()
        .find(|t| t.get("name").and_then(|v| v.str()) == Some(name))
        .and_then(|t| t.get("id").and_then(|v| v.str()))
        .unwrap()
        .to_owned()
}

#[test]
#[ignore = "diagnostic"]
fn diag_walk_trace() {
    let at = std::env::var("LF_AT").unwrap_or_else(|_| "45.0,-78.0".into());
    let to = std::env::var("LF_TO").unwrap_or_else(|_| "place-region-northern-mountains".into());
    let text = std::fs::read_to_string(std::env::var("EDEN_FACTS").unwrap()).unwrap();
    let im = import_eden::load(&text).unwrap();
    let (world, ground) = (im.nodes["world"], im.nodes["ground"]);
    let place = im.nodes[&facts_id(&text, &to)];
    let header = import_eden::header(world, &im.rules).unwrap();
    let next = im.tree.to_state().next;
    let town = sim::walk::town::Town::new(
        im.tree,
        ground,
        sim::links::Doors::new(header, im.rules, next),
    )
    .unwrap();
    let (x, z) = at.split_once(',').unwrap();
    let p = Vec3::new(
        (x.parse::<f64>().unwrap() * 1e6) as i64,
        0,
        (z.parse::<f64>().unwrap() * 1e6) as i64,
    );
    let mut b = worldd::bodies::Bodies::new(town, 50_000).unwrap();
    let body = Id::new(Scope([0xc1; 16]), 1).unwrap();
    let p = b
        .town
        .view()
        .stand_near(ground, p, 4_000_000, None)
        .unwrap_or(p);
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let placed = b.town.surfaces[&ground]
        .place(body, frame, p, Quat::IDENTITY)
        .unwrap();
    let family = {
        use replica::bodies::{Class, Family, Resource};
        let r = |n: &str, class, slot| Resource {
            name: Name::new(n).unwrap(),
            class,
            slot,
        };
        Family {
            name: Name::new("souls:humanoid").unwrap(),
            resources: vec![
                r("souls:leg-left", Class::Locomotion, None),
                r("souls:leg-right", Class::Locomotion, None),
                r("souls:hand-left", Class::Manipulator, Some(1)),
                r("souls:hand-right", Class::Manipulator, Some(2)),
            ],
        }
    };
    b.add_body(family, placed).unwrap();
    b.begin(1_000_000_000);
    let id = Id::new(Scope([0xc3; 16]), 1).unwrap();
    let r = b.start(vec![(
        id,
        worldd::bodies::Asked {
            body,
            actor: Actor::Soul(body),
            ask: worldd::bodies::Ask::Walk {
                node: place,
                point: None,
                gait: None,
            },
            fallbacks: vec![],
        },
    )]);
    println!("start {at} -> {to}: {r:?}");
    for k in 0..(20 * 900) {
        let now = b.runner.now + b.runner.tick;
        let ended = b.step(now);
        for e in b.wind_log.drain(..) {
            let s = format!("{e:?}");
            println!(
                "  ladder at {:.2} s: {}",
                k as f64 / 20.0,
                &s[..s.len().min(700)]
            );
        }
        if k % 20 == 0 {
            let (n, q) = b.pose(body).unwrap();
            println!(
                "  t {:>4} s at ({:.2}, {:.2}, {:.2}) on {} corner {:?}",
                k / 20,
                q.x as f64 / 1e6,
                q.y as f64 / 1e6,
                q.z as f64 / 1e6,
                replica::world_model::show(n),
                b.town
                    .next_corner(body)
                    .map(|(_, c)| (c[0] as f64 / 1e6, c[1] as f64 / 1e6))
            );
        }
        if let Some((_, r)) = ended.iter().find(|(i, _)| *i == id) {
            let (_, q) = b.pose(body).unwrap();
            println!(
                "ended {r:?} at {:.2} s, at ({:.2}, {:.2})",
                k as f64 / 20.0,
                q.x as f64 / 1e6,
                q.z as f64 / 1e6
            );
            break;
        }
    }
}
