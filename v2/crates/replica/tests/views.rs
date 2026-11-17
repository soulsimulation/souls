//! Views (Engine v2 T7, #2661; `v2/docs/views.md`): every view of the fixture log built in one pass equals the same
//! view built effect by effect, a subscription over its budget is lowered and told, and counts meets every budget
//! from the least one up.

use replica::effects::{FIXTURE_HEADER, FIXTURES, Header, Part, State, fixture_bytes};
use replica::encode::{Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope as IdScope};
use replica::views::{
    COUNTS_RECORD_MOST, Key, Level, MIN_BUDGET, ORDER, Output, Redactions, Scope, Subscription,
    View, build, entry_part, grant,
};
use replica::world_model::Audience;

const DAY: &str = include_str!("../fixtures/views/1-day.diag");

fn id(scope: u8, counter: u64) -> Id {
    Id::new(IdScope([scope; 16]), counter).expect("an id")
}

/// T6's header, the zone's start, and the log: T6's base, then the day.
fn log() -> (Header, State, Vec<Part>) {
    let header = Header::read(&fixture_bytes(FIXTURE_HEADER).expect("bytes")).expect("a header");
    let root = header
        .kinds
        .iter()
        .find(|k| k.as_str().starts_with("souls:place@"))
        .expect("the root's kind")
        .clone();
    let start = State::start(header.zone, root);
    let base = FIXTURES[0].1;
    let parts = [base, DAY]
        .iter()
        .map(|t| Part::read(&fixture_bytes(t).expect("bytes")).expect("a part"))
        .collect();
    (header, start, parts)
}

fn private() -> Audience {
    Audience::Of(id(0xaa, 1))
}

/// Every level for two audiences, on the world's root and on the room.
fn keys() -> Vec<Key> {
    let mut keys = Vec::new();
    for node in [id(0xee, 0), id(0xee, 1)] {
        for level in ORDER {
            for audience in [Audience::Everyone, private()] {
                keys.push(Key {
                    node,
                    level,
                    audience,
                });
            }
        }
    }
    keys
}

fn records(o: &Output) -> Vec<Vec<u8>> {
    o.records
        .iter()
        .map(|(_, r)| encode(r).expect("bytes"))
        .collect()
}

#[test]
fn a1_one_pass_equals_effect_by_effect_at_every_level_for_two_audiences() {
    let (header, start, parts) = log();
    let none = Redactions::default();
    let keys = keys();
    let one_pass = build(&start, &header, &parts, &keys, &none).expect("one pass");
    for (key, whole) in keys.iter().zip(&one_pass) {
        // Effect by effect: this key alone, each entry arriving as its own part's bytes.
        let mut view = View::new(*key, &header, &none);
        let mut state = start.clone();
        let mut sent: Vec<Vec<u8>> = Vec::new();
        for entry in parts.iter().flat_map(|p| &p.effects) {
            let alone = entry_part(&header, entry).expect("its own part");
            let mut after = state.clone();
            after.apply(&header, &alone).expect("applies");
            view.step(&state, &alone.effects[0], &after, &none)
                .expect("a step");
            state = after;
            let now = records(&view.output());
            // A stream only appends: what was sent is never rewritten (a counts view's open second is its last).
            let fixed = if key.level == Level::Counts {
                sent.len().saturating_sub(1)
            } else {
                sent.len()
            };
            assert_eq!(now[..fixed], sent[..fixed], "{key:?} rewrote what it sent");
            sent = now;
        }
        let stepped = view.output();
        let (a, b) = (
            whole.bytes().expect("bytes"),
            stepped.bytes().expect("bytes"),
        );
        println!(
            "{:<6} {:<8} {:<9} records {:>2} bytes {:>5} one-pass {} effect-by-effect {}",
            replica::world_model::show(key.node),
            key.level.name(),
            if key.audience == Audience::Everyone {
                "everyone"
            } else {
                "aa:1"
            },
            whole.records.len(),
            a.len(),
            Hash::of(Purpose::Fixture, &a),
            if a == b { "equal" } else { "DIFFERENT" }
        );
        assert_eq!(a, b, "{key:?}");
    }
    // The private view of the room is the note's two entries, and the public one never shows them.
    let room = |level, audience| {
        let i = keys
            .iter()
            .position(|k| k.node == id(0xee, 1) && k.level == level && k.audience == audience)
            .expect("a key");
        one_pass[i].records.len()
    };
    assert_eq!(room(Level::Full, private()), 2);
    assert_eq!(room(Level::Full, Audience::Everyone), 7);
    assert_eq!(room(Level::Sampled, Audience::Everyone), 5);
    assert_eq!(room(Level::Outline, Audience::Everyone), 1);
}

/// Each level's busiest second, for everyone, of the view of `scope`'s node.
fn peaks(scope: &Scope) -> Vec<(Level, u64)> {
    let (header, start, parts) = log();
    let mut state = start.clone();
    state.apply(&header, &parts[0]).expect("the base");
    let node = scope.nodes(&state)[0];
    let keys: Vec<Key> = ORDER
        .iter()
        .map(|l| Key {
            node,
            level: *l,
            audience: Audience::Everyone,
        })
        .collect();
    let out = build(&start, &header, &parts, &keys, &Redactions::default()).expect("built");
    ORDER
        .iter()
        .zip(&out)
        .map(|(l, o)| (*l, o.peak().expect("a peak")))
        .collect()
}

fn peak_of(peaks: &[(Level, u64)]) -> impl Fn(Level) -> u64 + '_ {
    |l| {
        peaks
            .iter()
            .find(|(k, _)| *k == l)
            .map(|(_, p)| *p)
            .unwrap_or(0)
    }
}

#[test]
fn a2_over_budget_is_lowered_and_told_never_dropped() {
    // Soul 100's body walks: three samples in its busiest second, of which `sampled` keeps one.
    let soul = Scope::Soul(id(0xdd, 100));
    let soul_peaks = peaks(&soul);
    for (l, p) in &soul_peaks {
        println!(
            "Soul 100, everyone, {:<13} busiest second {p} bytes",
            l.name()
        );
    }
    let peak = peak_of(&soul_peaks);
    let budget = peak(Level::Sampled);
    assert!(
        budget < peak(Level::Full),
        "the fixture's full view is busier than its sampled view"
    );
    let sub = Subscription {
        scope: soul,
        level: Level::Full,
        budget,
    };
    let g = grant(&sub, &peak).expect("granted");
    let told = encode(&g.to_value()).expect("bytes");
    println!(
        "asked full at {budget} bytes a second: given {} and told {}",
        g.level.name(),
        replica::encode::to_hex(&told)
    );
    assert_eq!((g.level, g.asked), (Level::Sampled, Level::Full));
    let Value::Map(m) = g.to_value() else {
        panic!("a map")
    };
    assert_eq!(m.get(&2), Some(&Value::Uint(Level::Full.number())));
    // The whole world squeezed to the least budget walks down to counts, and is still served.
    let world = peaks(&Scope::World);
    let sub = Subscription {
        scope: Scope::World,
        level: Level::Full,
        budget: MIN_BUDGET,
    };
    let g = grant(&sub, peak_of(&world)).expect("granted");
    println!(
        "the world asked full at {MIN_BUDGET} bytes a second: given {}",
        g.level.name()
    );
    assert_eq!((g.level, g.asked), (Level::Counts, Level::Full));
    // A Soul's scope is its body; the world's is the root.
    let (header, start, parts) = log();
    let mut state = start;
    state.apply(&header, &parts[0]).expect("the base");
    assert_eq!(Scope::Soul(id(0xdd, 100)).nodes(&state), vec![id(0xee, 2)]);
    assert_eq!(Scope::World.nodes(&state), vec![id(0xee, 0)]);
}

#[test]
fn a3_counts_meets_every_budget_from_the_least() {
    let peaks = peaks(&Scope::World);
    let peak = peak_of(&peaks);
    assert!(peak(Level::Counts) <= COUNTS_RECORD_MOST);
    let widest = Value::Map(
        [
            (1, Value::Nint(u64::MAX)),
            (2, Value::Uint(u64::MAX)),
            (3, Value::Uint(u64::MAX)),
        ]
        .into(),
    );
    let most = u64::try_from(encode(&widest).expect("bytes").len()).unwrap();
    println!(
        "the widest counts record is {most} bytes; the least budget is {MIN_BUDGET} bytes a second"
    );
    assert!(most <= COUNTS_RECORD_MOST);
    let top = peak(Level::Full) + 1;
    for budget in MIN_BUDGET..=top {
        let g = grant(
            &Subscription {
                scope: Scope::World,
                level: Level::Full,
                budget,
            },
            &peak,
        )
        .expect("granted");
        assert!(
            peak(g.level) <= budget,
            "{budget}: {:?} needs {}",
            g.level,
            peak(g.level)
        );
    }
    println!("every budget from {MIN_BUDGET} to {top} bytes a second is met");
    let low = grant(
        &Subscription {
            scope: Scope::World,
            level: Level::Counts,
            budget: MIN_BUDGET - 1,
        },
        &peak,
    );
    println!(
        "{} asked: {:?}",
        MIN_BUDGET - 1,
        low.as_ref().map_err(|r| r.name)
    );
    assert_eq!(low.map_err(|r| r.name), Err("budget-below-minimum"));
}

#[test]
fn a4_each_output_names_its_log_position_redaction_list_and_version() {
    let (header, start, parts) = log();
    let key = Key {
        node: id(0xee, 0),
        level: Level::Full,
        audience: Audience::Everyone,
    };
    let lists = [Redactions::default(), Redactions::new([id(0x33, 1)])];
    for list in &lists {
        let out = &build(&start, &header, &parts, &[key], list).expect("built")[0];
        let Value::Map(m) = out.to_value() else {
            panic!("a map")
        };
        println!(
            "header {} last sequence {:?} redactions {} version {}",
            out.position.header,
            m.get(&5),
            out.redactions,
            out.version
        );
        assert_eq!(m.get(&4), Some(&header.hash().to_value()));
        assert_eq!(m.get(&5), Some(&Value::Uint(10)));
        assert_eq!(m.get(&6), Some(&list.hash().to_value()));
        assert_eq!(m.get(&7), Some(&Level::Full.version().to_value()));
    }
    assert_ne!(lists[0].hash(), lists[1].hash());
    let versions: std::collections::BTreeSet<_> = ORDER.iter().map(|l| l.version()).collect();
    assert_eq!(versions.len(), ORDER.len());
    assert_eq!(
        Level::from_number(5).map_err(|r| r.name),
        Err("level-unknown")
    );
}
