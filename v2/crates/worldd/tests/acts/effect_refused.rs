//! A form's effects the world refuses to write refuse its act by name, and nothing of them is applied: the rack's
//! `overstock` creates a thing of a kind the world's header does not pin (`kind-not-in-header`).
use super::*;

#[test]
fn a_forms_effects_the_world_refuses_refuse_its_act_and_write_nothing() {
    let (run, mut a, _) = serve("refused");
    let over = a.act("test:overstock", Some(rack()), BTreeMap::new());
    println!("overstock: {over:?}");
    assert_eq!(
        over,
        Err("kind-not-in-header".to_owned()),
        "refused by name"
    );
    let r = run.replay();
    let t = r.tree();
    let made = t.children(t.handle(rack()).unwrap()).map_or(0, <[_]>::len);
    assert_eq!(made, 0, "nothing created");
    // The world goes on: the next act of the same body lands.
    let stocked = a.act("test:stock", Some(rack()), BTreeMap::new());
    println!("stock after: {stocked:?}");
    assert!(!stocked.expect("the stock lands").is_empty(), "one receipt");
    let r = run.replay();
    let t = r.tree();
    let made = t.children(t.handle(rack()).unwrap()).map_or(0, <[_]>::len);
    assert_eq!(made, 1, "one plank in the rack's slot");
    run.stop();
}
