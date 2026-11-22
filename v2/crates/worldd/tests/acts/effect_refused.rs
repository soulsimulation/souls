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

/// The rack's plank count on the replayed log.
fn planks(run: &Run) -> usize {
    let r = run.replay();
    let t = r.tree();
    t.children(t.handle(rack()).unwrap()).map_or(0, <[_]>::len)
}

/// #3697 review: one Soul's form whose effects the world refuses is refused alone; another Soul's act sent with it
/// (the same tick, or the next) lands.
#[test]
fn a_refused_form_sinks_no_other_souls_act_beside_it() {
    let (run, mut a, mut b) = serve("refused-beside");
    a.send("test:overstock", Some(rack()), BTreeMap::new());
    b.send("test:stock", Some(rack()), BTreeMap::new());
    let (over, stocked) = (a.answer(), b.answer());
    println!("overstock: {over:?}; stock beside it: {stocked:?}");
    assert_eq!(
        over,
        Err("kind-not-in-header".to_owned()),
        "refused alone, by name"
    );
    assert!(!stocked.expect("the other Soul's stock lands").is_empty());
    assert_eq!(planks(&run), 1, "the plank, and no ghost");
    run.stop();
}

/// #3697 review: a timer the world starts (no Soul's act) whose form's effects are refused, re-arming itself every
/// µs, writes nothing and stalls nothing: a Soul's act after it lands, and the log replays.
#[test]
fn a_refused_timer_ring_stalls_nothing() {
    let (run, mut a, mut b) = serve("refused-ring");
    let haunt = a.act("test:haunt", Some(rack()), BTreeMap::new());
    println!("haunt: {haunt:?}");
    assert!(!haunt.expect("the timer is set").is_empty());
    std::thread::sleep(Duration::from_millis(300));
    let stocked = b.act("test:stock", Some(rack()), BTreeMap::new());
    println!("stock after the ring: {stocked:?}");
    assert!(!stocked.expect("the stock lands").is_empty());
    assert_eq!(planks(&run), 1, "the plank, and no ghost");
    run.stop();
}
