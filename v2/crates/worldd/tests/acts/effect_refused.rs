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
    assert!(
        endings(&run).is_empty(),
        "a run whose start was refused with its effects writes no end"
    );
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
    b.send("test:play_at_end_a", Some(court()), BTreeMap::new());
    let (over, played) = (a.answer(), b.answer());
    println!("overstock: {over:?}; another Soul's act beside it: {played:?}");
    assert_eq!(
        over,
        Err("kind-not-in-header".to_owned()),
        "refused alone, by name"
    );
    assert!(!played.expect("the other Soul's act lands").is_empty());
    assert_eq!(planks(&run), 0, "no ghost");
    // And the world goes on for the first Soul too.
    let stocked = a.act("test:stock", Some(rack()), BTreeMap::new());
    assert!(!stocked.expect("the stock lands").is_empty());
    assert_eq!(planks(&run), 1, "the plank");
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

/// The `souls:reserves` links `run`'s log leaves standing, link to `[body, thing]`, and how many it ever wrote.
fn reserves(run: &Run) -> (BTreeMap<Id, [Id; 2]>, usize) {
    let log = run.store.0.lock().unwrap().bytes.clone();
    let effects: Vec<Effect> = recover(&log)
        .unwrap()
        .records
        .iter()
        .filter(|rec| !sim::recorder::is_input(rec))
        .flat_map(|rec| Part::read(rec).unwrap().effects)
        .collect();
    let written = effects
        .iter()
        .flat_map(Effect::changes)
        .filter(|c| matches!(&c.change, Change::Link { ty, .. } if ty.as_str() == "souls:reserves"))
        .count();
    (sim::forms::reservations(&effects), written)
}

/// Whether the replayed tree holds a `souls:reserves` link at `thing`: what keeps a kind refresh from it
/// (`Busy("reserved")`).
fn reserved(run: &Run, thing: Id) -> bool {
    let r = run.replay();
    let t = r.tree();
    t.links_at(thing)
        .iter()
        .any(|e| t.ty(e).as_str() == "souls:reserves")
}

/// 0.133 F1b: a form whose effect the world refuses at its last step, after its start and its reservation were
/// written in an earlier tick. The act is refused by name, and the run's end still lands, naming the refusal, with
/// its reservation's unlink: no `souls:reserves` link stands, so a kind refresh is not held off, and a restart finds
/// no open run to end.
#[test]
fn a_refused_last_step_still_ends_its_run_and_frees_its_thing() {
    let store = Mem::with(Vec::new());
    let (run, mut a, _) = serve_on("refused-end-a", store.clone());
    let over = a.act("test:overstock_late", Some(rack()), BTreeMap::new());
    println!("overstock_late: {over:?}");
    assert_eq!(
        over,
        Err("kind-not-in-header".to_owned()),
        "refused by name"
    );
    let (standing, written) = reserves(&run);
    assert_eq!(
        written, 1,
        "the run's start reserved the rack in its own tick"
    );
    assert!(standing.is_empty(), "no reservation left: {standing:?}");
    assert!(!reserved(&run, rack()), "a kind refresh is not held off");
    assert_eq!(
        endings(&run),
        ["souls:kind-not-in-header"],
        "the run's end names the refusal"
    );
    assert_eq!(planks(&run), 0, "nothing created");
    run.stop();

    let (run, _, _) = serve_on("refused-end-b", store);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        endings(&run),
        ["souls:kind-not-in-header"],
        "a restart ends nothing more"
    );
    assert!(reserves(&run).0.is_empty() && !reserved(&run, rack()));
    run.stop();
}

/// 0.133 F1b review: a held thing whose own run consumes it, beside an effect the world refuses at the last step. The
/// run's end has no unlink of its own (the removal would have taken the link), and the removal is refused with the
/// rest, so the end written alone unlinks the reservation the tree still holds: none stands, live or after a restart.
#[test]
fn a_refused_consume_still_frees_the_thing_it_held() {
    let store = Mem::with(Vec::new());
    let (run, mut a, _) = serve_on("refused-consume-a", store.clone());
    a.act("test:take", Some(vessel()), BTreeMap::new())
        .expect("the take lands");
    let eat = a.act("test:consume_late", Some(vessel()), BTreeMap::new());
    println!("consume_late: {eat:?}");
    assert_eq!(eat, Err("kind-not-in-header".to_owned()), "refused by name");
    let (standing, written) = reserves(&run);
    assert_eq!(
        written, 2,
        "the take and the consume each reserved the vessel"
    );
    assert!(standing.is_empty(), "no reservation left: {standing:?}");
    assert!(!reserved(&run, vessel()), "a kind refresh is not held off");
    assert_eq!(
        parent(&run.replay(), vessel()).0,
        Some(w1()),
        "still held: not consumed"
    );
    assert_eq!(endings(&run), ["souls:done", "souls:kind-not-in-header"]);
    run.stop();

    let (run, _, _) = serve_on("refused-consume-b", store);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(
        endings(&run),
        ["souls:done", "souls:kind-not-in-header"],
        "a restart ends nothing more"
    );
    assert!(reserves(&run).0.is_empty() && !reserved(&run, vessel()));
    run.stop();
}
