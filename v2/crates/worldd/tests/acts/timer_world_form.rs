//! #3991: a timer a Soul's form declares runs its form with no steps, the world's, on a served world, and that form's
//! state change lands. The rack is a bell here: its `ring` sets `ringing` and a one-second timer whose world form
//! `fade` clears it.
use super::*;

/// The rack's `ringing` field as the log replayed has it (a flag: 1 set, 0 or none clear).
fn ringing(run: &Run) -> u64 {
    let r = run.replay();
    let t = r.tree();
    match t.node(t.handle(rack()).unwrap()).unwrap().fields().get(&28) {
        Some(Value::Uint(n)) => *n,
        _ => 0,
    }
}

/// Every event the log holds, by name, in order.
fn events(run: &Run) -> Vec<String> {
    let log = run.store.0.lock().unwrap().bytes.clone();
    let mut out = Vec::new();
    for rec in recover(&log).unwrap().records {
        if sim::recorder::is_input(&rec) {
            continue;
        }
        for e in Part::read(&rec).unwrap().effects {
            if let Body::Timers(t) = &e.body {
                out.push(format!("timers {t:?}"));
            }
            for ev in e.events.iter().flatten() {
                out.push(ev.name.as_str().to_owned());
            }
        }
    }
    out
}

/// Rings with form `verb`, then waits up to five seconds of real time for the world form to clear the flag.
fn rings_then_fades(tag: &str, verb: &str) {
    let (run, mut a, _) = serve(tag);
    let rung = a.act(verb, Some(rack()), BTreeMap::new());
    println!("#3991 {verb}: {rung:?}");
    assert!(!rung.expect("the ring lands").is_empty(), "one receipt");
    assert_eq!(ringing(&run), 1, "ringing once the act is answered");
    let t0 = std::time::Instant::now();
    while ringing(&run) == 1 && t0.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(100));
    }
    println!("#3991 {verb}: after {:?}, events {:?}", t0.elapsed(), events(&run));
    assert_eq!(
        ringing(&run),
        0,
        "the timer's world form cleared the flag within 5 s of a 1 s timer"
    );
    run.stop();
}

#[test]
fn i3991_a_forms_timer_runs_its_world_form_with_no_steps_on_a_served_world() {
    rings_then_fades("i3991", "test:ring");
}

#[test]
fn i3991_a_timer_set_at_a_runs_end_runs_its_world_form_on_a_served_world() {
    rings_then_fades("i3991-late", "test:ring_late");
}
