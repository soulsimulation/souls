//! W14 (#4090): a thing whose map row borrows an entry passes that entry's kind checks and selectors, served. A Mars
//! can (borrowing `test:can`) in hand waters a planter that needs a `test:can` held; a kettle's `fill` finds a Mars
//! sink (borrowing `test:tap`) by its selector of kind `test:tap`; a thing that borrows nothing (the vessel) in hand
//! is still refused `not_holding_kind`.
use super::*;

fn water(r: &Replica, n: Id) -> Option<Value> {
    let t = r.tree();
    t.node(t.handle(n)?)?.fields().get(&28).cloned()
}

#[test]
fn w14_a_borrowed_can_waters_and_a_borrowed_sink_fills() {
    let (run, mut a, _) = serve("w14");
    // The vessel borrows nothing: held, it is not a can.
    a.act("test:take", Some(vessel()), BTreeMap::new())
        .expect("the vessel is taken");
    let refused = a.act("test:water", Some(planter()), BTreeMap::new());
    println!("W14 water holding the vessel: {refused:?}");
    let refused = refused.expect_err("refused");
    assert!(
        refused.contains("not_holding_kind"),
        "refused by name: {refused}"
    );
    assert_eq!(water(&run.replay(), planter()), None, "nothing written");
    // The Mars can borrows `test:can`: taken by that entry's form, and in hand it waters the planter.
    a.act("test:take", Some(mars_can()), BTreeMap::new())
        .expect("the Mars can is taken");
    let watered = a.act("test:water", Some(planter()), BTreeMap::new());
    println!("W14 water holding the Mars can: {watered:?}");
    assert!(!watered.expect("the water lands").is_empty(), "one receipt");
    assert_eq!(water(&run.replay(), planter()), Some(Value::Uint(1)));
    // The kettle's fill selects the nearest `test:tap` on its ground: the Mars sink that borrows it.
    let filled = a.act("test:fill", Some(kettle()), BTreeMap::new());
    println!("W14 fill from the Mars sink: {filled:?}");
    assert!(!filled.expect("the fill lands").is_empty(), "one receipt");
    let r = run.replay();
    assert_eq!(
        water(&r, kettle()),
        Some(Value::Uint(1700)),
        "filled to its room"
    );
    assert_eq!(
        water(&r, mars_sink()),
        Some(Value::Uint(3300)),
        "taken from the sink"
    );
    run.stop();
}
