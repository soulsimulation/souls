//! World time against its fixtures (Engine v2 T5, #2643; rules in `v2/docs/time.md`). Each test is Step 0 or one
//! acceptance box, and prints what it saw. The WASM build gives the same goldens in Node (the `time-goldens` step of
//! `v2/tools/ci.sh`).

use replica::encode::{Value, parse_diagnostic};
use replica::time::{
    Mapping, Micros, TickRate, TimeEffect, Timeline, beat_a_million_two_ways, time_goldens,
};

fn fixture(name: &str) -> String {
    let path = format!("{}/fixtures/time/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// A fixture's value, its `#` comments left out.
fn read(name: &str) -> Value {
    let text = fixture(name);
    let bare: Vec<&str> = text
        .lines()
        .map(|l| l.split('#').next().unwrap_or(""))
        .collect();
    parse_diagnostic(&bare.join("\n")).unwrap()
}

fn field(v: &Value, k: u64) -> &[Value] {
    match v {
        Value::Map(m) => match m.get(&k) {
            Some(Value::Array(a)) => a,
            other => panic!("field {k} is an array, found {other:?}"),
        },
        other => panic!("a map, found {other:?}"),
    }
}

fn uint(v: &Value) -> i64 {
    match v {
        Value::Uint(u) => i64::try_from(*u).unwrap(),
        other => panic!("an unsigned integer, found {other:?}"),
    }
}

fn effects(vs: &[Value]) -> Vec<TimeEffect> {
    vs.iter()
        .map(|v| TimeEffect::from_value(v).unwrap())
        .collect()
}

fn start(fx: &Value) -> Timeline {
    match effects(field(fx, 1)).as_slice() {
        [
            TimeEffect::Mapping(m),
            TimeEffect::TickRate(t),
            TimeEffect::Tempo(p),
        ] => Timeline::start(*m, *t, *p).unwrap(),
        other => panic!("a start of mapping, tick rate, tempo; found {other:?}"),
    }
}

/// Runs ticks 0, 1, ... until world time `until`, and in each tick fires the events whose microsecond lies in the
/// tick's span `[tick_start(n), tick_start(n + 1))`. Each event carries its own time. Returns `(tick, microsecond,
/// what)` in the order they fired, and the number of ticks run.
fn run(
    line: &Timeline,
    events: &[(Micros, String)],
    until: Micros,
) -> (Vec<(i64, Micros, String)>, i64) {
    let mut fired = Vec::new();
    let mut n = 0;
    loop {
        let (from, to) = (line.tick_start(n).unwrap(), line.tick_start(n + 1).unwrap());
        if from >= until {
            return (fired, n);
        }
        let mut here: Vec<_> = events
            .iter()
            .filter(|(t, _)| from <= *t && *t < to)
            .collect();
        here.sort();
        for (t, what) in here {
            assert_eq!(
                line.tick_of(*t).unwrap(),
                n,
                "{what}: tick_of agrees with the span"
            );
            fired.push((n, *t, what.clone()));
        }
        n += 1;
    }
}

#[test]
fn step0_beat_a_million_two_ways() {
    let (added, line) = beat_a_million_two_ways().unwrap();
    let apart = line - added;
    println!(
        "Step 0: beat 1,000,000 at 130 a minute: adding 461,538 us a million times gives {added} us;"
    );
    println!(
        "        multiplying then dividing gives {line} us (exact 461,538,461,538.46, rounded up); {apart} us apart"
    );
    assert_eq!(line, 461_538_461_539);
    assert!((400_000..500_000).contains(&apart), "about 0.46 s apart");
    // The largest product the lines form: a difference of two i64 times a 32-bit part.
    let widest = (u128::from(u64::MAX)) * u128::from(u32::MAX);
    assert!(widest < 1u128 << 96);
    println!(
        "        widest product (2^64 - 1)(2^32 - 1) < 2^96, inside 128 bits at every 64-bit world time"
    );
}

#[test]
fn a1_tick_rate_changes_move_no_microsecond() {
    let fx = read("rates.diag");
    let one = start(&fx);
    let mut three = start(&fx);
    for e in effects(field(&fx, 2)) {
        three.apply(e).unwrap();
    }
    // A change that does not start on a tick of the rate before is refused, and changes nothing.
    let off = TickRate::new(2_500_001, 80, 60).unwrap();
    let before = three.clone();
    assert_eq!(
        three.apply(TimeEffect::TickRate(off)).unwrap_err().name(),
        "tick-rate-not-on-a-tick"
    );
    assert_eq!(three, before);

    let mut events = Vec::new();
    for t in field(&fx, 3) {
        let Value::Array(pair) = t else {
            panic!("a timer is [set, duration]")
        };
        let (set, duration) = (uint(&pair[0]), uint(&pair[1]));
        events.push((set + duration, format!("timer {set}+{duration}")));
    }
    for k in field(&fx, 4) {
        let k = uint(k);
        let (b1, b3) = (one.beat_time(k).unwrap(), three.beat_time(k).unwrap());
        assert_eq!(b1, b3, "beat {k}");
        events.push((b1, format!("beat {k}")));
    }
    let until = 4_000_000;
    let (at_one, ticks_one) = run(&one, &events, until);
    let (at_three, ticks_three) = run(&three, &events, until);
    assert_eq!(
        at_one.len(),
        events.len(),
        "every event fires once at one rate"
    );
    assert_eq!(
        at_three.len(),
        events.len(),
        "every event fires once at three rates"
    );
    println!(
        "A1: {} ticks at 20/s; {} ticks at 20, 30 (from 1 s), 60 (from 2 s)",
        ticks_one, ticks_three
    );
    for ((n1, t1, w1), (n3, t3, w3)) in at_one.iter().zip(&at_three) {
        assert_eq!((t1, w1), (t3, w3));
        println!("    {w1:<20} at {t1:>7} us: tick {n1:>2} at 20/s, tick {n3:>3} at 20/30/60");
    }
    println!(
        "A1: all {} timers, durations and beats on the same microsecond",
        events.len()
    );
}

#[test]
fn a2_beat_a_million_same_in_two_runs_and_both_builds() {
    let first = time_goldens();
    let second = time_goldens();
    assert_eq!(first, second, "two runs");
    assert_eq!(
        first,
        fixture("goldens.txt"),
        "native goldens equal fixtures/time/goldens.txt"
    );
    let beat = first
        .lines()
        .find_map(|l| l.strip_prefix("beat-1000000-at-130 "))
        .unwrap();
    println!(
        "A2: beat 1,000,000 at 130 a minute = {beat} us in two runs; native goldens equal the committed file"
    );
}

#[test]
fn a3_mapping_rate_zero_or_below_is_refused_by_name() {
    for (num, den) in [(0, 1), (-1, 1), (1, 0), (1, -1), (-60, 1)] {
        let got = Mapping::new(0, 0, num, den).unwrap_err().name();
        assert_eq!(got, "mapping-rate-not-positive");
        println!("A3: Mapping::new(rate {num}/{den}) -> {got}");
    }
    // The same refusal when the effect comes from a log: a negative rate is a negative integer in the record.
    let logged = parse_diagnostic("{1: 1, 2: 0, 3: 0, 4: [-1, 1]}").unwrap();
    let got = TimeEffect::from_value(&logged).unwrap_err().name();
    assert_eq!(got, "mapping-rate-not-positive");
    println!("A3: logged mapping {{4: [-1, 1]}} -> {got}");
}
