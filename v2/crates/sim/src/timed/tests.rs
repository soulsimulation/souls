//! F5's values in the world (#2770): a world advanced 24 hours in one jump equals the same world stepped, field for
//! field (A2), and a kettle crossing its boiling level fires its form once, with the world as actor and no Soul (A3).
//! `cargo test -p sim --lib f5_ -- --nocapture`. A1 is the `timed` bench (`v2/tools/bench/src/timed.rs`).

use replica::effects::{Actor, Body, Cause, Change, Effect};
use replica::encode::Value;
use replica::host::{Answer, Ask};
use replica::ids::{Id, Minter, Scope};
use replica::moves::Effector;
use replica::rules::json::parse;
use replica::time::Micros;
use replica::timed::{Bounds, Level, Timed};
use replica::tree::Tree;
use replica::world_model::{parse_kinds, parse_world};
use skills::form_runner::Limits;

use super::{Crossed, Field, Values, field_of, start_form};
use crate::controller::Controller;
use crate::forms::{Asked, Forms, World};
use crate::host::Geometry;
use crate::moves::{Moves, Reach};
use crate::timers::{DueList, Timer};

const KIND: &str = include_str!("kettle.json");
const KINDS: &str = include_str!("../../../replica/fixtures/world-model/kinds.diag");
const HOUR: Micros = 3_600_000_000;
const TICK: Micros = 50_000;

fn splitmix(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// A world of timed values only: each thing heats and cools between two levels, and each crossing turns it round
/// (the change its form's effect would make), so the values cross again and again for the whole span.
struct Swing {
    values: Values,
    due: DueList,
    mint: Minter,
    /// Every crossing and the three numbers it wrote, in order.
    log: Vec<(Crossed, Timed)>,
    fires: u64,
}

impl Swing {
    fn new(things: u64) -> Swing {
        let mut s = Swing {
            values: Values::new(),
            due: DueList::new(),
            mint: Minter::new(Scope([0xf5; 16])),
            log: Vec::new(),
            fires: 0,
        };
        for i in 0..things {
            let r = splitmix(i);
            let lo = 10_000 + (r % 5_000) as i64;
            let hi = lo + 20_000 + (splitmix(r) % 50_000) as i64;
            let field = Field {
                n: 1 + i % 3,
                bounds: Bounds {
                    min: Some(lo - 1_000),
                    max: Some(hi + 1_000),
                },
                levels: vec![
                    (Level::AtLeast(hi), "hot".into()),
                    (Level::AtMost(lo), "cold".into()),
                ],
            };
            let node = s.mint.mint().expect("an id");
            let per_s = 7 + (splitmix(r ^ 1) % 400) as i64;
            let set_us = (splitmix(r ^ 2) % 60_000_000) as i64;
            let to = Timed {
                value: lo + 1,
                per_s,
                set_us,
            };
            s.values
                .set(&mut s.due, &mut s.mint, node, &field, to, set_us)
                .expect("set");
        }
        s
    }

    fn run(&mut self, t: &Timer) {
        let crossed = self
            .values
            .fire(&mut self.due, &mut self.mint, t)
            .expect("every timer is a value's");
        self.fires += 1;
        for c in crossed {
            let now = self.values.get(c.node, c.field).expect("kept");
            let back = match c.level {
                Level::AtLeast(_) => -now.per_s.abs(),
                Level::AtMost(_) => now.per_s.abs(),
            };
            let to = self
                .values
                .change(&mut self.due, &mut self.mint, c.node, c.field, back, c.at)
                .expect("changes");
            self.log.push((c, to));
        }
    }

    /// Everything due before `end`, in one call.
    fn jump(&mut self, end: Micros) {
        while let Some(t) = self.due.fire(end) {
            self.run(&t);
        }
    }

    /// Tick by tick at 20 a second: each tick fires what is due before the next one starts.
    fn step(&mut self, end: Micros) -> u64 {
        let mut ticks = 0;
        let mut at = 0;
        while at < end {
            at += TICK;
            ticks += 1;
            while let Some(t) = self.due.fire(at) {
                self.run(&t);
            }
        }
        ticks
    }
}

#[test]
fn f5_a2_a_day_in_one_jump_equals_the_day_stepped() {
    let mut jumped = Swing::new(300);
    let mut stepped = Swing::new(300);
    assert_eq!(jumped.values, stepped.values);
    jumped.jump(24 * HOUR);
    let ticks = stepped.step(24 * HOUR);
    assert!(jumped.fires > 10_000, "{} fires", jumped.fires);
    assert_eq!(
        jumped.log, stepped.log,
        "the same crossings, at the same times"
    );
    assert_eq!(
        jumped.values, stepped.values,
        "the same three numbers, field for field"
    );
    assert_eq!(jumped.due, stepped.due, "the same entries pending");
    let mut fields = 0;
    for ((node, field), v) in jumped.values.all() {
        assert_eq!(Some(v), stepped.values.get(node, field));
        let b = Bounds::default();
        assert_eq!(
            v.at(b, 24 * HOUR),
            stepped
                .values
                .get(node, field)
                .expect("kept")
                .at(b, 24 * HOUR)
        );
        fields += 1;
    }
    println!(
        "A2: {fields} timed values, {} entries fired, {} crossings over 24 h; one jump equals {ticks} ticks stepped, field for field",
        jumped.fires,
        jumped.log.len()
    );
}

/// The geometry and reach of a world with nobody in it: the kettle's form only waits.
struct Empty;

impl Geometry for Empty {
    fn ask(&self, _: Id, _: &Ask) -> Option<Answer> {
        None
    }
}

impl Reach for Empty {
    fn distance(
        &self,
        _: Id,
        _: &Effector,
        _: Option<&replica::encode::Name>,
        _: Id,
        _: &replica::encode::Name,
    ) -> Option<i64> {
        None
    }
}

fn tree() -> Tree {
    let kinds = parse_kinds(KINDS).expect("kinds");
    let draft = parse_world(
        &kinds,
        "{1: [], 2: {}, 3: [{1: 1, 2: \"souls:place\"}], 4: []}",
    )
    .expect("a world");
    Tree::load(&draft).expect("loads").0
}

#[test]
fn f5_a3_a_kettle_boils_and_whistles_once_with_the_world_as_actor() {
    let entry = parse(KIND).expect("the kind");
    let heat = field_of(&entry, "heat").expect("a timed field");
    assert_eq!(
        heat.levels,
        vec![(Level::AtLeast(100_000), "whistle".to_owned())]
    );
    let tree = tree();
    let mut c = Controller::new();
    let mut due = DueList::new();
    let mut mint = Minter::new(Scope([0xf5; 16]));
    let mut moves = Moves::new();
    let mut forms = Forms::new();
    let mut values = Values::new();
    let kettle = mint.mint().expect("an id");
    let say = |at: Micros, what: &str| println!("  {:>12.6} s  {what}", at as f64 / 1e6);
    println!("the kettle's log:");

    // Switched on at 7 s: SA-F5a's case, boiling at 157,093,809 µs.
    let on = Timed {
        value: 20_000,
        per_s: 533,
        set_us: 7_000_000,
    };
    values
        .set(&mut due, &mut mint, kettle, &heat, on, 7_000_000)
        .expect("set");
    assert_eq!(due.next_due(), Some(157_093_809));
    say(
        7_000_000,
        "switched on: heat 20000 mC rising 533 mC/s; due list: boils at 157.093809 s",
    );

    // Switched off at 60 s: settled, the entry cancelled; the old entry, if it still came, fires nothing.
    let old = due.fire(Micros::MAX).expect("the entry");
    due.set(old.clone()).expect("put back");
    let off = values
        .change(&mut due, &mut mint, kettle, 1, 0, 60_000_000)
        .expect("off");
    assert_eq!(
        off,
        Timed {
            value: 48_249,
            per_s: 0,
            set_us: 60_000_000
        }
    );
    assert!(due.is_empty(), "no crossing while off");
    assert_eq!(
        values.fire(&mut due, &mut mint, &old),
        None,
        "a stale entry fires nothing"
    );
    say(
        60_000_000,
        "switched off: heat settled to 48249 mC; entry cancelled; the stale entry fired: nothing",
    );

    // On again at 90 s: the entry replaced.
    values
        .change(&mut due, &mut mint, kettle, 1, 533, 90_000_000)
        .expect("on");
    let boils = 90_000_000 + (51_751_000_000i64 + 532) / 533;
    assert_eq!(due.next_due(), Some(boils));
    say(
        90_000_000,
        &format!(
            "switched on again: entry replaced, boils at {:.6} s",
            boils as f64 / 1e6
        ),
    );

    // The world ticks at 20 a second, firing each timer twice (a doubled entry), until nothing is pending.
    let mut now = 90_000_000;
    let mut runs = 0;
    while !due.is_empty() {
        let end = now + TICK;
        while let Some(t) = due.fire(end) {
            let mut w = World {
                tree: &tree,
                geometry: &Empty,
                reach: &Empty,
                controller: &mut c,
                due: &mut due,
                mint: &mut mint,
                moves: &mut moves,
                library: &[],
                places: None,
                seed: 1,
            };
            if forms.fire(&mut w, &t) {
                say(t.due, "the whistle's wait ends: its effect is written");
                continue;
            }
            let crossed = values.fire(w.due, w.mint, &t).expect("the kettle's entry");
            assert!(
                values.fire(w.due, w.mint, &t).is_none(),
                "the same entry again fires nothing"
            );
            for x in &crossed {
                let v = values
                    .get(x.node, x.field)
                    .expect("kept")
                    .at(heat.bounds, x.at)
                    .expect("a value");
                say(
                    x.at,
                    &format!(
                        "heat {v} mC crosses at least 100000: starts 'whistle', the world acting"
                    ),
                );
                let first =
                    start_form(&mut forms, &mut w, x, &entry, Limits::default()).expect("starts");
                let again =
                    start_form(&mut forms, &mut w, x, &entry, Limits::default()).expect("joins");
                assert!(matches!(first, Asked::Started(_)));
                assert_eq!(
                    again,
                    Asked::Running(match first {
                        Asked::Started(r) => r,
                        _ => unreachable!(),
                    })
                );
                runs += 1;
            }
        }
        now = end;
    }
    assert_eq!(runs, 1, "one crossing");

    // The log's writer numbers the run's entries and hands each back. F3's lifecycle holds: one start entry (the
    // reserve), one effect, one end; only the effect counts as the form's effect.
    let mut out: Vec<Effect> = std::mem::take(&mut forms.out);
    let named = |e: &Effect, n: &str| {
        e.events
            .as_ref()
            .is_some_and(|v| v.iter().any(|ev| ev.name.as_str() == n))
    };
    for (seq, e) in (1u64..).zip(out.iter_mut()) {
        e.envelope.sequence = seq;
        forms.logged(e);
    }
    let count = |n: &str| out.iter().filter(|e| named(e, n)).count();
    assert_eq!(count("souls:form-started"), 1, "one reserve entry");
    assert_eq!(count("souls:effect"), 1, "the effect once");
    assert_eq!(count("souls:form-ended"), 1, "one end entry");
    for e in &out {
        assert_eq!(
            e.envelope.actor,
            Actor::World,
            "the world acts in every entry"
        );
        let what = ["souls:form-started", "souls:effect", "souls:form-ended"]
            .into_iter()
            .find(|n| named(e, n))
            .unwrap_or("other");
        say(
            e.envelope.at,
            &format!("entry {}: {what}, actor the world", e.envelope.sequence),
        );
    }
    let e = out
        .iter()
        .find(|e| named(e, "souls:effect"))
        .expect("the effect")
        .clone();
    assert_eq!(e.envelope.actor, Actor::World, "the world acts");
    assert!(matches!(e.envelope.cause, Cause::Intent(_)));
    assert_eq!(e.envelope.node, kettle);
    assert_eq!(e.envelope.at, boils + 2_000_000, "after the whistle's wait");
    let Body::Changes(ch) = &e.body else {
        panic!("changes")
    };
    assert!(
        matches!(&ch[0].change, Change::Set { node, field: 2, to: Value::Uint(1), .. } if *node == kettle)
    );
    assert_eq!(forms.ended.len(), 1);
    assert_eq!(forms.ended[0].how.as_str(), "done");
    assert!(c.bodies().next().is_none(), "no Soul in the world");
    assert_eq!(
        values
            .get(kettle, 1)
            .expect("kept")
            .at(heat.bounds, now)
            .expect("a value"),
        100_000
    );
    say(
        e.envelope.at,
        &format!(
            "entry {}: set whistled to 1, cause the crossing's entry; the run ended done",
            e.envelope.sequence
        ),
    );
    say(now, "heat held at 100000 mC (full): nothing pending");
}
