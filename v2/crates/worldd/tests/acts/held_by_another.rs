//! #5275: a Soul never takes a thing out of another Soul's hand. Soul a holds the vessel; Soul b, beside a, asks to
//! take it and is refused `held-by-another`, naming a's body, with nothing changed; a gives it (an offer that names
//! the vessel, E24's give) and b accepts: the vessel is in b's hand.
use super::*;

/// The offer a give made, by the `souls:offer` event its receipt names (field 1, the offer; field 6, the thing).
fn offered(run: &Run, entries: &[u64], thing: Id) -> Id {
    let log = run.store.0.lock().unwrap().bytes.clone();
    for rec in recover(&log).unwrap().records {
        if sim::recorder::is_input(&rec) {
            continue;
        }
        for e in Part::read(&rec).unwrap().effects {
            if !entries.contains(&e.envelope.sequence) {
                continue;
            }
            for ev in e.events.iter().flatten() {
                if ev.name.as_str() == "souls:offer"
                    && ev.fields.get(&6) == Some(&thing.to_value())
                    && let Some(v) = ev.fields.get(&1)
                {
                    return replica::effects::read_id(v).expect("the offer's id");
                }
            }
        }
    }
    panic!("no give of {thing:?} in {entries:?}")
}

#[test]
fn i5275_a_take_of_a_thing_in_another_souls_hand_is_refused_by_name_until_it_is_given() {
    let (run, mut a, mut b) = serve("i5275");
    a.act("test:take", Some(vessel()), BTreeMap::new())
        .expect("a takes the vessel");
    assert_eq!(parent(&run.replay(), vessel()).0, Some(w1()), "in a's hand");
    // b comes beside a, within reach of the vessel and of a give.
    b.act(
        "test:walk",
        Some(ground()),
        point(Vec3::new(-40_500_000, 0, 30_000_000)),
    )
    .expect("b walks beside a");
    let before = run.replay();
    let at_b = before
        .tree()
        .node(before.tree().handle(w2()).unwrap())
        .and_then(|n| n.place())
        .map(|p| p.position);
    let took = b.act("test:take", Some(vessel()), BTreeMap::new());
    let detail = b.detail();
    println!("#5275 b's take: {took:?} {detail:?}");
    assert_eq!(took, Err("held-by-another".to_owned()), "refused by name");
    assert!(
        detail
            .as_deref()
            .is_some_and(|d| d.contains(&replica::world_model::show(w1()))),
        "the refusal names the holder: {detail:?}"
    );
    let after = run.replay();
    assert_eq!(
        parent(&after, vessel()),
        parent(&before, vessel()),
        "still in a's hand"
    );
    assert_eq!(
        after
            .tree()
            .node(after.tree().handle(w2()).unwrap())
            .and_then(|n| n.place())
            .map(|p| p.position),
        at_b,
        "b did not move for it"
    );
    // a gives it; b accepts, and holds it.
    let give = a
        .act(
            "activity:offer",
            Some(ground()),
            p(&[
                (1, Value::Text(name(&fullname(PAIR)))),
                (2, Value::Text(name("test:first"))),
                (3, Value::Array(vec![w2().to_value()])),
                (4, vessel().to_value()),
            ]),
        )
        .expect("a offers the vessel");
    let offer = offered(&run, &give, vessel());
    let accepted = b.act("activity:accept", Some(offer), BTreeMap::new());
    println!("#5275 give: {give:?}, b accepts: {accepted:?}");
    accepted.expect("b's accept of the give lands");
    let held = parent(&run.replay(), vessel());
    assert_eq!(held.0, Some(w2()), "in b's hand");
    assert!(matches!(held.1, Some(1 | 2)), "in a hand's slot");
    run.stop();
}
