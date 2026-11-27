//! #3991: a timer a Soul's form declares runs its world form, which has no steps, on a served world, and that form's
//! state change lands: while the world runs, and when the world stops with the timer pending and starts again from its
//! log (a deploy, a sleeping world woken). The rack is a bell here: `ring_by_hand` walks to it and presses it, as a
//! thaumatrope's disc is released, and `ring` rings it at once; each sets `ringing` and a timer whose world form
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

/// The due time of the last timer the log sets.
fn timer_due(run: &Run) -> Option<i64> {
    let log = run.store.0.lock().unwrap().bytes.clone();
    let mut due = None;
    for rec in recover(&log).unwrap().records {
        if sim::recorder::is_input(&rec) {
            continue;
        }
        for e in Part::read(&rec).unwrap().effects {
            if let Body::Timers(ts) = &e.body {
                for t in ts {
                    if let replica::effects::TimerRec::Set { due: d, .. } = t {
                        due = Some(*d);
                    }
                }
            }
        }
    }
    due
}

/// The log's entries on the rack that carry the event `name`: each one's world time and its event's text fields.
fn rack_events(run: &Run, name: &str) -> Vec<(i64, BTreeMap<u64, String>)> {
    let log = run.store.0.lock().unwrap().bytes.clone();
    let mut out = Vec::new();
    for rec in recover(&log).unwrap().records {
        if sim::recorder::is_input(&rec) {
            continue;
        }
        for e in Part::read(&rec).unwrap().effects {
            for ev in e.events.iter().flatten() {
                if e.envelope.node != rack() || ev.name.as_str() != name {
                    continue;
                }
                let text = ev
                    .fields
                    .iter()
                    .filter_map(|(k, v)| match v {
                        Value::Bytes(b) => Some((*k, String::from_utf8_lossy(b).into_owned())),
                        Value::Text(t) => Some((*k, t.as_str().to_owned())),
                        _ => None,
                    })
                    .collect();
                out.push((e.envelope.at, text));
            }
        }
    }
    out
}

/// The world time the log cleared the last timer it set.
fn timer_cleared_at(run: &Run) -> Option<i64> {
    let log = run.store.0.lock().unwrap().bytes.clone();
    let mut at = None;
    for rec in recover(&log).unwrap().records {
        if sim::recorder::is_input(&rec) {
            continue;
        }
        for e in Part::read(&rec).unwrap().effects {
            if let Body::Timers(ts) = &e.body
                && ts
                    .iter()
                    .any(|t| matches!(t, replica::effects::TimerRec::Clear { .. }))
            {
                at = Some(e.envelope.at);
            }
        }
    }
    at
}

/// Waits up to `within` of real time for the flag to clear; how long it took.
// A real world on the real clock: an answer's time is real time.
#[allow(clippy::disallowed_methods)]
fn faded(run: &Run, within: Duration) -> Duration {
    let t0 = std::time::Instant::now();
    while ringing(run) == 1 && t0.elapsed() < within {
        std::thread::sleep(Duration::from_millis(100));
    }
    t0.elapsed()
}

/// The issue's shape on a running world: a walk and a press, the flag and a 2 s timer set at the press's contact,
/// then the timer's world form with no steps clears it.
#[test]
fn i3991_a_timer_set_at_a_moves_contact_runs_its_world_form_on_a_served_world() {
    let (run, mut a, _) = serve("i3991-hand");
    let rung = a.act("test:ring_by_hand", Some(rack()), BTreeMap::new());
    println!("#3991 ring by hand: {rung:?}");
    assert!(!rung.expect("the ring lands").is_empty(), "one receipt");
    assert_eq!(ringing(&run), 1, "ringing once the act is answered");
    let took = faded(&run, Duration::from_secs(6));
    println!("#3991 ring by hand: cleared after {took:?}");
    assert_eq!(ringing(&run), 0, "the timer's world form cleared the flag");
    run.stop();
}

/// The world stops a moment after the ring, its 2 s timer pending, and starts again from its log: the timer fires at
/// its due time and its world form clears the flag. Before #3991's fix the started world never fired it, so the bell
/// rang for good. The world counts the timer in its next due time too, so a still world never sleeps past it.
#[test]
// A real world on the real clock: an answer's time is real time.
#[allow(clippy::disallowed_methods)]
fn i3991_a_forms_timer_pending_at_a_restart_runs_its_world_form() {
    let store = Mem::with(Vec::new());
    let (run, mut a, _) = serve_on("i3991-ra", store.clone());
    let rung = a.act("test:ring", Some(rack()), BTreeMap::new());
    assert!(!rung.expect("the ring lands").is_empty(), "one receipt");
    assert_eq!(ringing(&run), 1, "ringing once the act is answered");
    let due = timer_due(&run).expect("the ring set its timer");
    let t0 = std::time::Instant::now();
    let mut next = run.world.quiet.read().1;
    while next.is_none_or(|n| n > due) && t0.elapsed() < Duration::from_millis(500) {
        std::thread::sleep(Duration::from_millis(20));
        next = run.world.quiet.read().1;
    }
    println!("#3991 the world's next due {next:?}, the fade's {due}");
    assert!(
        next.is_some_and(|n| n <= due),
        "the world's next due time counts the form's timer"
    );
    assert_eq!(timer_cleared_at(&run), None, "not fired before the stop");
    run.world.stop();
    let (run, _, _) = serve_on("i3991-rb", store);
    let took = faded(&run, Duration::from_secs(6));
    println!("#3991 restart: cleared after {took:?}");
    assert_eq!(ringing(&run), 0, "the timer fired after the restart");
    run.stop();
}

/// Every content kind's timer names a form of its own kind that binds, steps and effects, as the timer's run binds it
/// when it fires (#3991's check of the kinds whose timers run a world form with no steps).
#[test]
fn i3991_every_content_timer_names_a_form_that_binds() {
    fn files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                files(&p, out);
            } else if p.extension().is_some_and(|x| x == "json") {
                out.push(p);
            }
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let mut all = Vec::new();
    files(&root, &mut all);
    let mut checked = BTreeSet::new();
    for p in all {
        let Ok(entry) = parse(&std::fs::read_to_string(&p).unwrap()) else {
            continue;
        };
        let kind = entry
            .get("kind")
            .and_then(Json::str)
            .unwrap_or("?")
            .to_owned();
        for (_, f) in entry.get("forms").and_then(Json::obj).unwrap_or(&[]) {
            for e in f.get("effects").and_then(Json::arr).unwrap_or(&[]) {
                if e.get("change").and_then(Json::str) != Some("timer") {
                    continue;
                }
                let form = e
                    .get("form")
                    .and_then(Json::str)
                    .expect("a timer names its form");
                let steps = skills::form_runner::bind(&entry, form);
                let effects = skills::form_runner::bind_effects(&entry, form);
                assert!(steps.is_ok(), "{kind} {form}: {steps:?}");
                assert!(effects.is_ok(), "{kind} {form}: {effects:?}");
                checked.insert(format!("{kind} {form}"));
            }
        }
    }
    println!("#3991 timer forms that bind: {checked:?}");
    assert!(checked.len() >= 10, "the content's timer forms were found");
}

/// #3991 (1, 2): the bell is rung, then hushed by a Soul before its fade is due. The fade needs `ringing`, which no
/// longer holds when its timer fires, so the world refuses it by the need's reason, at its due time, and writes the
/// refusal on the bell where Souls and the page read entries: before, the timer's form ran unchecked, and a refusal
/// was kept only in a list nothing read.
#[test]
// A real world on the real clock: an answer's time is real time.
#[allow(clippy::disallowed_methods)]
fn i3991_a_timer_whose_needs_no_longer_hold_is_refused_by_name_at_its_due_time() {
    let (run, mut a, _) = serve("i3991-needs");
    let rung = a.act("test:ring", Some(rack()), BTreeMap::new());
    assert!(!rung.expect("the ring lands").is_empty(), "one receipt");
    let due = timer_due(&run).expect("the ring set its timer");
    let hushed = a.act("test:hush", Some(rack()), BTreeMap::new());
    assert!(!hushed.expect("the hush lands").is_empty(), "one receipt");
    assert_eq!(ringing(&run), 0, "hushed before the fade is due");
    let t0 = std::time::Instant::now();
    while timer_cleared_at(&run).is_none() && t0.elapsed() < Duration::from_secs(6) {
        std::thread::sleep(Duration::from_millis(100));
    }
    let refused = rack_events(&run, worldd::acts::TIMER_REFUSED);
    let faded = rack_events(&run, "faded");
    println!("#3991 needs at fire: refused {refused:?}, faded {faded:?}, due {due}");
    assert_eq!(
        timer_cleared_at(&run),
        Some(due),
        "the timer fired at its due time"
    );
    assert_eq!(refused.len(), 1, "the refusal is written once, on the bell");
    let (at, fields) = &refused[0];
    assert_eq!(*at, due, "refused at the timer's due time");
    assert_eq!(
        fields.get(&2).map(String::as_str),
        Some("field_differs"),
        "by the need's reason"
    );
    assert_eq!(
        fields.get(&3).map(String::as_str),
        Some("fade"),
        "naming the form"
    );
    assert!(faded.is_empty(), "the fade's effects were not written");
    run.stop();
}

/// #3991 (3): a world goes away with its form's timer pending (asleep, its alarm at the timer's due time) and is
/// started again from its log, with no bodies, after the due time has passed. It catches up exactly: the timer fires
/// at its own due time, not at the wake, and then nothing is due, so the world may sleep again. Before, a world with
/// no bodies never ticked its forms: the timer the tree held was never put back on a due list, so the world slept
/// with no alarm for it and the bell rang for good.
#[test]
// A real world on the real clock: an answer's time is real time.
#[allow(clippy::disallowed_methods)]
fn i3991_a_world_with_no_bodies_woken_late_fires_its_forms_timer_at_its_due_time() {
    let store = Mem::with(Vec::new());
    let (run, mut a, _) = serve_on("i3991-sa", store.clone());
    let rung = a.act("test:ring", Some(rack()), BTreeMap::new());
    assert!(!rung.expect("the ring lands").is_empty(), "one receipt");
    let due = timer_due(&run).expect("the ring set its timer");
    let t0 = std::time::Instant::now();
    let mut next = run.world.quiet.read().1;
    while next.is_none_or(|n| n > due) && t0.elapsed() < Duration::from_millis(500) {
        std::thread::sleep(Duration::from_millis(20));
        next = run.world.quiet.read().1;
    }
    assert!(
        next.is_some_and(|n| n <= due),
        "the alarm a sleep would set is no later than the timer's due time"
    );
    assert_eq!(timer_cleared_at(&run), None, "not fired before the stop");
    run.world.stop();
    std::thread::sleep(Duration::from_secs(3));
    let (run, _, _) = serve_as("i3991-sb", store, false);
    let took = faded(&run, Duration::from_secs(6));
    println!("#3991 no bodies, woken late: cleared after {took:?}, due {due}");
    assert_eq!(ringing(&run), 0, "the timer fired after the wake");
    assert_eq!(
        timer_cleared_at(&run),
        Some(due),
        "at its own due time, not the wake's"
    );
    let t0 = std::time::Instant::now();
    let mut quiet = run.world.quiet.read();
    while !(quiet.0 && quiet.1.is_none()) && t0.elapsed() < Duration::from_secs(1) {
        std::thread::sleep(Duration::from_millis(20));
        quiet = run.world.quiet.read();
    }
    println!("#3991 no bodies, after the fade: quiet {quiet:?}");
    assert!(quiet.0, "the world is still");
    assert_eq!(quiet.1, None, "nothing due: the world may sleep");
    run.stop();
}

/// #3991 review: the bell is rung and then scrapped before its fade is due. The removal takes the bell's timer from
/// the tree, so when the forms' due list reaches it the world writes nothing on the bell that is gone: before, its
/// clear was written on a missing node, refused, and sank that tick's other world entries with it.
#[test]
// A real world on the real clock: an answer's time is real time.
#[allow(clippy::disallowed_methods)]
fn i3991_a_timer_whose_thing_was_removed_writes_nothing() {
    let (run, mut a, _) = serve("i3991-scrap");
    let rung = a.act("test:ring", Some(rack()), BTreeMap::new());
    assert!(!rung.expect("the ring lands").is_empty(), "one receipt");
    let due = timer_due(&run).expect("the ring set its timer");
    let scrapped = a.act("test:scrap", Some(rack()), BTreeMap::new());
    assert!(
        !scrapped.expect("the scrap lands").is_empty(),
        "one receipt"
    );
    assert!(
        run.replay().tree().handle(rack()).is_none(),
        "the bell is gone"
    );
    std::thread::sleep(Duration::from_secs(3));
    let refused = rack_events(&run, worldd::acts::TIMER_REFUSED);
    let quiet = run.world.quiet.read();
    println!(
        "#3991 scrapped: cleared {:?}, refused {refused:?}, quiet {quiet:?}, due {due}",
        timer_cleared_at(&run)
    );
    assert_eq!(timer_cleared_at(&run), None, "no clear on a thing gone");
    assert!(refused.is_empty(), "no refusal on a thing gone");
    assert!(
        quiet.1.is_none_or(|n| n > due),
        "the timer is off the due list"
    );
    run.stop();
}
