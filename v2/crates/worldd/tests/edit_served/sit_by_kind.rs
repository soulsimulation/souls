//! #3178: a chair a creator places is found by a sit by kind with no restart: the edit files its seat in the rooms a
//! sit by kind looks up (`Bodies::file_seats`), as a seat registered at start-up is filed.
use super::*;
use replica::selector::{Rule, Selector};

#[tokio::test(flavor = "multi_thread")]
async fn i3178_a_chair_a_creator_places_is_taken_by_a_sit_by_kind() {
    let (text, chair) = seat_world();
    let im = import_eden::load(&text).unwrap();
    let source = im
        .tree
        .node(im.tree.handle(im.nodes[chair]).unwrap())
        .unwrap();
    let kind = source.kind().clone();
    let fields = source.fields().clone();
    // The kind a sit by kind names: the entry the chair goes by.
    let by = import_eden::entry_name(kind.as_str(), &fields);
    let by = by.split('@').next().unwrap_or(by).to_owned();
    let (x, z) = clear_row(&text);
    let d = scratch("i3178-placed");
    let entries = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let w = seed_entries(&d, &text, 1, (x, z), Some(&entries));
    let (c, actor) = creator(0xd3);
    static_creator(&w, c);
    let socket = d.join("s");
    let served = serve_with(&w, &socket, None);
    served.line("listening ", 120);
    let (url, tokens) = gateway(&socket, &[actor, Actor::Soul(w.souls[0])]).await;
    let mut creator = sign_in(&url, &tokens[0]).await;
    let mut soul = sign_in(&url, &tokens[1]).await;
    let op = Op::Place {
        name: 1,
        kind,
        parent: Ref::Node(w.ground),
        at: Spot {
            slot: None,
            position: Vec3::new((x + 1) * M, 0, z * M - 509_000),
            orientation: Quat::IDENTITY,
            support: Support::Surface {
                surface: w.ground,
                height: 0,
            },
        },
        audience: Audience::Everyone,
        fields,
    };
    let (placed, _) = send(&mut creator, edit_intent(&w, actor, 1, 0, op)).await;
    assert_eq!(placed.kind, 1, "the new chair commits: {placed:?}");
    let chair = placed.names[&1];
    let sit = Intent {
        actor: Actor::Soul(w.souls[0]),
        verb: Name::new("eden:sit").unwrap(),
        target: Some(
            Selector::FreeSlot {
                kind: Name::new(&by).unwrap(),
                node: w.ground,
                rule: Rule::Nearest,
            }
            .target(),
        ),
        parameters: BTreeMap::new(),
        sequence: 1,
        basis: basis(w.root.scope(), placed.version),
        expiry: i64::MAX,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    let sat = send_ended(&mut soul, encode(&sit.to_value()).unwrap()).await;
    println!("#3178 placed chair, sit by kind {by}: {sat:?}");
    assert_eq!(sat.kind, 1, "the placed chair is found by kind: {sat:?}");
    let log = std::fs::read(w.dir.join("log")).unwrap();
    let seated = sim::log::recover(&log)
        .unwrap()
        .records
        .iter()
        .filter_map(|r| {
            let Value::Map(m) = decode(r).ok()?.value else {
                return None;
            };
            let Value::Array(rows) = m.get(&answers::BODIES)? else {
                return None;
            };
            rows.iter()
                .filter_map(worldd::bodies::read_row)
                .find(|(_, p, _)| p.frame.node == chair && p.frame.slot == Some(1))
        })
        .next_back();
    assert!(seated.is_some(), "the Soul sits in the placed chair");
}
