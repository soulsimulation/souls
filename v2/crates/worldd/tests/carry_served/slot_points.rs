//! #5134: a carry's node says where it holds its load, in the stream a page reads. On a served world, by two Souls'
//! own intents through a real gateway, the public stream `worldd serve` writes under `views/` is played by the normal
//! public reader: the carry's node carries its riders' points ([`F_RIDES`]) from the part that makes it, in the part
//! whose lift puts the beam in its slot, and in every part after it while the beam is held; and it never carries a
//! thing's slot points (field 13), so the ground still reads the held beam as carried.

use super::*;
use replica::activity::F_RIDES;
use replica::effects::{NodeState, read_id};

/// The public copy of each of `ids` after each part of the served world's public stream, read by the normal public
/// reader from the files under `views/` (the stream `views/world.json` names): `(part, the nodes it holds)`.
fn public_copies(dir: &Path, ids: &[Id]) -> Vec<(u64, BTreeMap<Id, NodeState>)> {
    use replica::stream::{Pointer, public::PublicPlayer};
    let world =
        json::parse(&std::fs::read_to_string(dir.join("views/world.json")).unwrap()).unwrap();
    let stream = dir.join(world.get("stream").and_then(json::Value::str).unwrap());
    let pointer_bytes = std::fs::read(stream.join("pointer")).unwrap();
    let pointer = Pointer::read(&pointer_bytes).unwrap();
    let headers = stream.ancestors().nth(3).unwrap().join("headers");
    let header = std::fs::read(headers.join(replica::encode::to_hex(&pointer.header))).unwrap();
    let Value::Map(fields) = decode(&pointer_bytes).unwrap().value else {
        panic!("the pointer is a map")
    };
    let Some(Value::Bytes(generation)) = fields.get(&8) else {
        panic!("a public stream's pointer names its baseline")
    };
    let parts = stream.join("g").join(replica::encode::to_hex(generation));
    let baseline = std::fs::read(parts.join("baseline")).unwrap();
    let mut player = PublicPlayer::start(&header, &baseline).expect("the public reader");
    let mut out = Vec::new();
    for n in player.next()..=pointer.newest.expect("a published part") {
        let bytes = std::fs::read(parts.join(n.to_string())).expect("a published part");
        player
            .play(&bytes)
            .expect("the public reader plays the part");
        let Value::Map(state) = player.state() else {
            panic!("the public state is a map")
        };
        let Some(Value::Array(rows)) = state.get(&2) else {
            panic!("the public state's nodes")
        };
        let mut nodes = BTreeMap::new();
        for row in rows {
            let Value::Array(row) = row else {
                panic!("a node's row")
            };
            let id = read_id(&row[0]).expect("a node's id");
            if ids.contains(&id) {
                nodes.insert(id, NodeState::read(&row[1]).expect("a public node"));
            }
        }
        out.push((n, nodes));
    }
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn slots_a_synced_public_copy_of_a_carry_holds_its_riders_points_through_the_lift() {
    let d = scratch("cslots");
    let facts = world(&d);
    let socket = d.join("s");
    let (dir, souls, served) = seed_and_serve(&d, &facts, (44, -18), &socket, 2);
    served.line("listening ", 180);
    let im = import_eden::load(&facts).unwrap();
    let (ground, beam) = (im.nodes["ground"], im.nodes["yard-beam-4"]);
    let lineage = im.nodes["world"].scope();
    let (url, tokens) = gateway(&socket, &souls).await;
    let mut a = Soul::connect(&url, souls[0], lineage, &tokens[0]).await;
    let mut b = Soul::connect(&url, souls[1], lineage, &tokens[1]).await;
    let entry = construction("rack_beam.json");
    let carry = gather(&mut a, &mut b, &dir, ground, beam, &entry, beam_at(), true).await;
    a.act("carry:lift", carry, BTreeMap::from([(1, beam.to_value())]))
        .await
        .expect("lifted");

    // The stream is cut every half second of world time: wait (at most 60 s) for the part whose lift puts the beam in
    // the carry's slot, and two parts after it (the lift's track ends within 1.2 s).
    let held = |nodes: &BTreeMap<Id, NodeState>| {
        nodes
            .get(&beam)
            .is_some_and(|n| n.parent == Some(carry) && n.slot == Some(sim::activity::carry::SLOT))
    };
    let end = Instant::now() + Duration::from_secs(60);
    let copies = loop {
        let copies = public_copies(&dir, &[carry, beam]);
        let lift = copies.iter().position(|(_, nodes)| held(nodes));
        if lift.is_some_and(|k| copies.len() >= k + 3) {
            break copies;
        }
        assert!(Instant::now() < end, "the lift is not in the public stream");
        tokio::time::sleep(Duration::from_millis(500)).await;
    };

    let points = Value::Array(vec![Value::Array(vec![
        Value::Uint(sim::activity::carry::SLOT),
        Value::Uint(0),
        Value::Uint(0),
        Value::Uint(0),
    ])]);
    let made = copies
        .iter()
        .position(|(_, nodes)| nodes.contains_key(&carry))
        .expect("the carry is public");
    let lift = copies
        .iter()
        .position(|(_, nodes)| held(nodes))
        .expect("the beam is held");
    assert!(made < lift, "the carry is made in a part before its lift");
    assert!(
        !held(&copies[lift - 1].1),
        "the lift's own part is read: the beam lay on the ground in the part before"
    );
    for (part, nodes) in &copies[made..] {
        let crew = nodes.get(&carry).expect("the carry stays public");
        assert_eq!(
            crew.fields.get(&F_RIDES),
            Some(&points),
            "part {part}: the carry's node says where it holds its slot's rider"
        );
        assert!(
            !crew.fields.contains_key(&sim::ground::scene::F_SLOTS),
            "part {part}: never a thing's slot points, which would make its rider fixed geometry"
        );
    }
    assert!(
        copies[lift..].iter().all(|(_, nodes)| held(nodes)),
        "the beam rides the carry's slot from the lift's part on"
    );
    println!(
        "#5134: parts {}..{}: the carry is made in part {}, the beam is in its slot from part {} (the lift), and the \
         carry's public copy holds its rider's point {:?} in every one",
        copies[made].0,
        copies.last().unwrap().0,
        copies[made].0,
        copies[lift].0,
        points
    );

    b.act("carry:set-down", carry, BTreeMap::new())
        .await
        .expect("set down");
    for s in [&mut a, &mut b] {
        s.act("activity:leave", carry, BTreeMap::new())
            .await
            .expect("a leave is always accepted");
    }
    drop(served);
}
