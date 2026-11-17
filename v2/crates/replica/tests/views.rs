//! Views (Engine v2 T7, #2661; `v2/docs/views.md`): every view of the fixture log built in one pass equals the same
//! view built effect by effect, a subscription over its budget is lowered and told, and counts meets every budget
//! from the least one up.

use replica::effects::{FIXTURE_HEADER, FIXTURES, Header, Part, State, fixture_bytes};
use replica::encode::{Value, encode};
use replica::ids::{Hash, Id, Purpose, Scope as IdScope};
use replica::views::{
    COUNTS_RECORD_MOST, Key, Level, MIN_BUDGET, ORDER, Output, Redactions, Scope, Subscription,
    View, build, entry_part, grant, least, peak,
};
use replica::world_model::Audience;

const DAY: &str = include_str!("../fixtures/views/1-day.diag");
const GOLDENS: &str = include_str!("../fixtures/views/goldens.txt");

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

/// Every level for two audiences, on the world's root, the room, the body and the crate.
fn keys() -> Vec<Key> {
    let mut keys = Vec::new();
    for node in [id(0xee, 0), id(0xee, 1), id(0xee, 2), id(0xee, 7)] {
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
    let mut whole_state = start.clone();
    for p in &parts {
        whole_state.apply(&header, p).expect("the parts as stored");
    }
    let mut lines = Vec::new();
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
        // Entry by entry ends where the stored parts, applied whole, end.
        assert_eq!(
            state.hash().expect("a hash"),
            whole_state.hash().expect("a hash")
        );
        let stepped = view.output();
        let (a, b) = (
            whole.bytes().expect("bytes"),
            stepped.bytes().expect("bytes"),
        );
        let line = format!(
            "{} {} {} records {} bytes {} {}",
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
        );
        println!(
            "{line} effect-by-effect {}",
            if a == b { "equal" } else { "DIFFERENT" }
        );
        assert_eq!(a, b, "{key:?}");
        lines.push(line);
    }
    let got = lines.join("\n") + "\n";
    if std::env::var_os("VIEWS_WRITE_GOLDENS").is_some() {
        std::fs::write("fixtures/views/goldens.txt", &got).expect("written");
    }
    assert_eq!(
        got, GOLDENS,
        "the views differ from fixtures/views/goldens.txt"
    );
    println!(
        "all {} views equal to fixtures/views/goldens.txt",
        lines.len()
    );
    // The private view of the room is the note's two entries, and the public one never shows them.
    let room = |level, audience| {
        let i = keys
            .iter()
            .position(|k| k.node == id(0xee, 1) && k.level == level && k.audience == audience)
            .expect("a key");
        one_pass[i].records.len()
    };
    assert_eq!(room(Level::Full, private()), 2);
    // The room's public view holds the base entry that furnished it, though that entry's node is the root.
    assert_eq!(room(Level::Full, Audience::Everyone), 10);
    // Its outline: the room itself, the body, the cup, the key and the crate created, the cup removed, the key left
    // and arrived.
    assert_eq!(room(Level::Outline, Audience::Everyone), 8);
    let crate_outline = &one_pass[keys
        .iter()
        .position(|k| {
            k.node == id(0xee, 7) && k.level == Level::Outline && k.audience == Audience::Everyone
        })
        .expect("a key")];
    let arrived = crate_outline.records.last().expect("a record").1.clone();
    println!("the crate's outline ends {arrived:?}");
    let Value::Map(m) = arrived else {
        panic!("a map")
    };
    assert_eq!(m.get(&2), Some(&Value::Uint(4)));
    assert_eq!(m.get(&3), Some(&id(0xee, 6).to_value()));
    assert_eq!(m.get(&5), Some(&id(0xee, 7).to_value()));
}

/// Each level's busiest second over every view a viewer in `audiences` is sent for `scope`, and how many views that
/// is (one per node of the scope and audience).
fn peaks(scope: &Scope, audiences: &[Audience]) -> (Vec<(Level, u64)>, u64) {
    let (header, start, parts) = log();
    let mut state = start.clone();
    state.apply(&header, &parts[0]).expect("the base");
    let nodes = scope.nodes(&state);
    let mut out = Vec::new();
    for level in ORDER {
        let keys: Vec<Key> = nodes
            .iter()
            .flat_map(|n| {
                audiences.iter().map(move |a| Key {
                    node: *n,
                    level,
                    audience: *a,
                })
            })
            .collect();
        let views = build(&start, &header, &parts, &keys, &Redactions::default()).expect("built");
        out.push((level, peak(&views).expect("a peak")));
    }
    let views = u64::try_from(nodes.len() * audiences.len()).expect("small");
    (out, views)
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
    // The world's busiest second is its furnishing, which `full` and `sampled` both keep whole.
    let (world, views) = peaks(&Scope::World, &[Audience::Everyone]);
    for (l, p) in &world {
        println!(
            "the world, everyone, {:<13} busiest second {p} bytes",
            l.name()
        );
    }
    let peak = peak_of(&world);
    let budget = peak(Level::Outline);
    let sub = Subscription {
        scope: Scope::World,
        level: Level::Full,
        budget,
    };
    let g = grant(&sub, views, &peak).expect("granted");
    let told = encode(&g.to_value()).expect("bytes");
    println!(
        "asked full at {budget} bytes a second: given {} and told {}",
        g.level.name(),
        replica::encode::to_hex(&told)
    );
    assert_eq!((g.level, g.asked), (Level::Outline, Level::Full));
    let Value::Map(m) = g.to_value() else {
        panic!("a map")
    };
    assert_eq!(m.get(&2), Some(&Value::Uint(Level::Full.number())));
    // Squeezed to the least budget, it walks down to counts, and is still served.
    let sub = Subscription {
        budget: least(views),
        ..sub
    };
    let g = grant(&sub, views, &peak).expect("granted");
    println!(
        "asked full at {} bytes a second: given {}",
        least(views),
        g.level.name()
    );
    assert_eq!((g.level, g.asked), (Level::Counts, Level::Full));
    // A walking body's busiest second of samples: `sampled` keeps one of the three.
    let (header, start, parts) = log();
    let day: Vec<_> = parts[1].effects.iter().take(3).collect();
    let mut state = start.clone();
    state.apply(&header, &parts[0]).expect("the base");
    let body = Key {
        node: id(0xee, 2),
        level: Level::Sampled,
        audience: Audience::Everyone,
    };
    let mut v = View::new(body, &header, &Redactions::default());
    for e in day {
        let mut after = state.clone();
        after
            .apply(&header, &entry_part(&header, e).expect("a part"))
            .expect("applies");
        v.step(&state, e, &after, &Redactions::default())
            .expect("a step");
        state = after;
    }
    println!(
        "three samples in one second: `sampled` keeps {}",
        v.output().records.len()
    );
    assert_eq!(v.output().records.len(), 1);
    // A Soul's scope is its body; the world's is the root; a node under another node of the scope is left out.
    let (header, start, parts) = log();
    let mut state = start;
    state.apply(&header, &parts[0]).expect("the base");
    assert_eq!(Scope::Soul(id(0xdd, 100)).nodes(&state), vec![id(0xee, 2)]);
    assert_eq!(Scope::World.nodes(&state), vec![id(0xee, 0)]);
    assert_eq!(
        Scope::Nodes(vec![id(0xee, 1), id(0xee, 7)]).nodes(&state),
        vec![id(0xee, 1)]
    );
}

#[test]
fn a3_counts_meets_every_budget_from_the_least() {
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
        "the widest counts record is {most} bytes; the least budget is {MIN_BUDGET} bytes a second a view"
    );
    assert!(most <= COUNTS_RECORD_MOST);
    // The world for everyone (one view), and two sibling nodes for a viewer in aa:1 (four views: each node, for
    // everyone and for aa:1).
    let cases = [
        (
            "the world, everyone",
            Scope::World,
            vec![Audience::Everyone],
        ),
        (
            "the body and the crate, a viewer in aa:1",
            Scope::Nodes(vec![id(0xee, 2), id(0xee, 7)]),
            vec![Audience::Everyone, private()],
        ),
    ];
    for (what, scope, audiences) in cases {
        let (peaks, views) = peaks(&scope, &audiences);
        let peak = peak_of(&peaks);
        assert!(peak(Level::Counts) <= least(views));
        let top = peak(Level::Full) + 1;
        for budget in least(views)..=top {
            let sub = Subscription {
                scope: scope.clone(),
                level: Level::Full,
                budget,
            };
            let g = grant(&sub, views, &peak).expect("granted");
            assert!(
                peak(g.level) <= budget,
                "{budget}: {:?} needs {}",
                g.level,
                peak(g.level)
            );
        }
        println!(
            "{what}: {views} views, every budget from {} to {top} bytes a second is met",
            least(views)
        );
        let low = grant(
            &Subscription {
                scope,
                level: Level::Counts,
                budget: least(views) - 1,
            },
            views,
            &peak,
        );
        println!(
            "  {} asked: {:?}",
            least(views) - 1,
            low.as_ref().map_err(|r| r.name)
        );
        assert_eq!(low.map_err(|r| r.name), Err("budget-below-minimum"));
    }
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
        assert_eq!(m.get(&5), Some(&Value::Uint(12)));
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
