//! #5068: a served world says what its default body is made of, on its root node, and only the world writes it.

use super::*;
use replica::bodies::{
    Class, DEFAULT_FAMILY_REFUSED, F_DEFAULT_FAMILY, default_family, read_default_family,
};

/// The root's default-family field of the served world as its log has it now, once it holds one.
fn published(w: &Seeded) -> Value {
    let until = Instant::now() + Duration::from_secs(30);
    loop {
        let (copy, _) = served_copy(w);
        let t = copy.tree();
        let held = t
            .node(t.root())
            .and_then(|n| n.fields().get(&F_DEFAULT_FAMILY).cloned());
        if let Some(v) = held {
            return v;
        }
        assert!(
            Instant::now() < until,
            "the served world never wrote its default body's family"
        );
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// How many times the served world's log sets the field.
fn writes(w: &Seeded) -> usize {
    sim::log::recover(&std::fs::read(w.dir.join("log")).unwrap())
        .unwrap()
        .records
        .iter()
        .filter(|record| !sim::recorder::is_input(record))
        .filter_map(|record| replica::effects::Part::read(record).ok())
        .flat_map(|part| part.effects)
        .map(|e| match e.body {
            replica::effects::Body::Changes(cs) => cs
                .iter()
                .filter(|c| {
                    matches!(&c.change, replica::effects::Change::Set { field, .. } if *field == F_DEFAULT_FAMILY)
                })
                .count(),
            _ => 0,
        })
        .sum()
}

/// The world writes the family it gives joining bodies at its first tick: the default body's exact pinned kind, two
/// hands each with its slot, and the rest with none. A creator's set of the field, whole or in rows, is refused
/// `edit.body-family` with nothing written, and a restart leaves the same value.
#[tokio::test(flavor = "multi_thread")]
async fn the_world_says_what_its_default_body_is_made_of_and_no_edit_changes_it() {
    let text = testworld::generate(1, 0).unwrap().text;
    let d = scratch("body-family");
    let w = seed(&d, &text, 1, (-40, 30));
    let bucket = d.join("bucket");
    let (c, creator) = creator(0xc5);
    record(&bucket, &w, c);
    let socket = d.join("s");
    let s = serve(&w, &socket, &bucket);
    s.line("listening ", 60);
    let (url, tokens) = gateway(&socket, &[creator]).await;
    let mut ws = sign_in(&url, &tokens[0]).await;

    let forged = Value::Map(BTreeMap::from([
        (1, Value::Text(Name::new("souls:body").unwrap())),
        (2, Value::Array(Vec::new())),
    ]));
    let (got, _) = send(
        &mut ws,
        edit_intent(
            &w,
            creator,
            1,
            0,
            Op::Set {
                node: Ref::Node(w.root),
                field: F_DEFAULT_FAMILY,
                to: forged.clone(),
            },
        ),
    )
    .await;
    assert_eq!(
        (got.kind, got.reason.as_str()),
        (2, DEFAULT_FAMILY_REFUSED),
        "a creator's set is refused: {got:?}"
    );
    let (got, _) = send(
        &mut ws,
        edit_intent(
            &w,
            creator,
            2,
            got.version,
            Op::Rows {
                node: Ref::Node(w.root),
                field: F_DEFAULT_FAMILY,
                rows: vec![Value::Array(vec![Value::Uint(1), Value::Uint(2)])],
            },
        ),
    )
    .await;
    assert_eq!(
        (got.kind, got.reason.as_str()),
        (2, DEFAULT_FAMILY_REFUSED),
        "a creator's rows are refused: {got:?}"
    );

    let held = published(&w);
    assert_ne!(held, forged);
    let (kind, resources) = read_default_family(&held).expect("a family");
    let (copy, _) = served_copy(&w);
    assert!(
        copy.header().kinds.contains(&kind),
        "the kind is one the world's header pins: {}",
        kind.as_str()
    );
    assert_eq!(replica::world_model::plain(kind.as_str()), "souls:body");
    let hands: Vec<(&str, Option<u64>)> = resources
        .iter()
        .filter(|r| r.class == Class::Manipulator)
        .map(|r| (r.name.as_str(), r.slot))
        .collect();
    assert_eq!(
        hands,
        [("souls:hand-left", Some(1)), ("souls:hand-right", Some(2))]
    );
    assert!(
        resources
            .iter()
            .filter(|r| r.class != Class::Manipulator)
            .all(|r| r.slot.is_none())
    );
    // The value is the writer's own, byte for byte, so a reader may compare it whole.
    let family = replica::bodies::Family {
        name: kind.clone(),
        resources,
    };
    assert_eq!(default_family(&kind, &family), held);

    assert_eq!(writes(&w), 1, "written once");
    // A view is given it: the public projection of the world, as the stream's snapshots are made, holds the value.
    let seen = replica::stream::public::project(copy.header(), &copy.tree().to_state()).unwrap();
    let (seen, value) = (encode(&seen).unwrap(), encode(&held).unwrap());
    assert!(
        seen.windows(value.len()).any(|w| w == value.as_slice()),
        "the public projection carries the root's field"
    );
    // A placed thing's first fields may not name the field either.
    let (got, _) = send(
        &mut ws,
        edit_intent(&w, creator, 3, got.version, {
            let mut place = wall(&w, -30, 30);
            if let Op::Place { fields, .. } = &mut place {
                fields.insert(F_DEFAULT_FAMILY, forged.clone());
            }
            place
        }),
    )
    .await;
    assert_eq!(
        (got.kind, got.reason.as_str()),
        (2, DEFAULT_FAMILY_REFUSED),
        "a placed thing's first fields are refused: {got:?}"
    );

    // A restart of the unchanged world leaves it as it was, and writes nothing.
    drop(ws);
    drop(s);
    let s = serve(&w, &socket, &bucket);
    s.line("listening ", 60);
    let (url, tokens) = gateway(&socket, &[creator]).await;
    let mut ws = sign_in(&url, &tokens[0]).await;
    let (got, _) = send(
        &mut ws,
        edit_intent(
            &w,
            creator,
            4,
            0,
            Op::Set {
                node: Ref::Node(w.root),
                field: F_DEFAULT_FAMILY,
                to: forged,
            },
        ),
    )
    .await;
    assert_eq!((got.kind, got.reason.as_str()), (2, DEFAULT_FAMILY_REFUSED));
    assert_eq!(published(&w), held);
    assert_eq!(
        writes(&w),
        1,
        "a restart of the unchanged world writes nothing"
    );
}
