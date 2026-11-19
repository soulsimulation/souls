//! Day, night, weather and the date on the world node (Engine v2 E6, #2755): over one fast day each change of light,
//! weather and date is one named effect that reaches a copy (A1); nothing runs between changes (A2); a 48-hour jump
//! writes what stepping writes (A3); a day of 23 or 25 hours gives one new day (A4). `cargo test -p sim --test
//! daylight`.

use std::collections::BTreeMap;

use replica::effects::{
    Actor, Body, Cause, ChangeRec, Effect, Envelope, Header, Part, Rest, TimerRec, schema_hash,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::sky::{self, Calendar, DAY_US, Sky, days_from_civil};
use replica::time::{Mapping, Micros, Tempo, TickRate, Timeline};
use replica::tree::Tree;
use replica::world_model::Audience;
use sim::daylight::{Config, Daylight, Write};
use sim::timers::{DueList, Timer};

const HOUR: Micros = 3_600_000_000;

fn name(s: &str) -> Name {
    Name::new(s).expect("a name")
}

fn header(zone: Id) -> Header {
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/e6-daylight/1").to_bytes()),
        ),
        (2, Value::Bytes(schema_hash().to_bytes())),
        (3, Value::Bytes(zone.scope().0.to_vec())),
        (4, zone.to_value()),
        (5, Value::Uint(0)),
        (6, Value::Array(Vec::new())),
        (7, Value::Array(Vec::new())),
    ]));
    Header::read(&encode(&v).expect("bytes")).expect("a header")
}

/// A world whose root holds the sky, its due list, the entries it wrote, and a copy that applies the same bytes.
struct World {
    tree: Tree,
    copy: Tree,
    header: Header,
    line: Timeline,
    due: DueList,
    mint: Minter,
    root: Id,
    next: u64,
    sky: Daylight,
    timer: BTreeMap<Name, Id>,
    written: Vec<Effect>,
    pending: Vec<Effect>,
    ticks: u64,
}

impl World {
    /// A world at 20 ticks a second whose start writes `cfg`'s settings, then its first light, date and weather.
    fn new(cfg: Config) -> World {
        let mut mint = Minter::new(Scope([0xe6; 16]));
        let root = mint.mint().expect("an id");
        let tree = Tree::start(root, name("souls:world"));
        let line = Timeline::start(
            Mapping::new(0, 0, 1, 1).expect("a mapping"),
            TickRate::new(0, 0, 20).expect("20 a second"),
            Tempo::per_minute(0, 0, 120).expect("a tempo"),
        )
        .expect("a timeline");
        let mut w = World {
            next: tree.to_state().next,
            copy: Tree::start(root, name("souls:world")),
            header: header(root),
            tree,
            line,
            due: DueList::new(),
            mint,
            root,
            sky: Daylight::new(cfg.clone(), root),
            timer: BTreeMap::new(),
            written: Vec::new(),
            pending: Vec::new(),
            ticks: 0,
        };
        let sets = cfg
            .fields()
            .into_iter()
            .map(|(field, to)| replica::effects::Change::Set {
                node: root,
                field,
                to,
                by: None,
            })
            .collect();
        w.entry(0, Body::Changes(recs(sets)), None);
        w.commit();
        assert_eq!(
            Config::read(w.tree.node(w.tree.root()).expect("root").fields()),
            Some(cfg),
            "the settings are fields on the world node"
        );
        for write in w.sky.start(0).expect("the first sky") {
            w.put(0, write);
        }
        w.commit();
        w
    }

    fn entry(&mut self, at: Micros, body: Body, events: Option<Vec<replica::effects::Event>>) {
        self.pending.push(Effect {
            envelope: Envelope {
                sequence: self.next,
                at,
                cause: Cause::World,
                actor: Actor::World,
                audience: Audience::Everyone,
                node: self.root,
            },
            body,
            events,
            rest: Rest::new(),
        });
        self.next += 1;
    }

    /// One fire's two entries: the change with its event, then its timer cleared and the next set.
    fn put(&mut self, at: Micros, w: Write) {
        self.entry(at, Body::Changes(recs(w.changes)), w.event.map(|e| vec![e]));
        let id = self.mint.mint().expect("an id");
        self.due
            .set(Timer {
                node: self.root,
                id,
                due: w.next,
                name: w.timer.clone(),
            })
            .expect("set");
        let mut recs = Vec::new();
        if let Some(old) = self.timer.insert(w.timer.clone(), id) {
            recs.push(TimerRec::Clear { timer: old });
        }
        recs.push(TimerRec::Set {
            timer: id,
            due: w.next,
            name: w.timer,
        });
        self.entry(at, Body::Timers(recs), None);
    }

    fn sky(tree: &Tree) -> Option<Sky> {
        Sky::read(tree.node(tree.root()).expect("root").fields())
    }

    /// Applies what was written to the world and, from the same bytes, to the copy; both then read the same sky.
    fn commit(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let v = Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (
                2,
                Value::Array(self.pending.iter().map(Effect::to_value).collect()),
            ),
        ]));
        let part = Part::read(&encode(&v).expect("bytes")).expect("a part");
        self.tree.apply(&self.header, &part).expect("applies");
        self.copy
            .apply(&self.header, &part)
            .expect("the copy applies");
        assert_eq!(
            World::sky(&self.copy),
            World::sky(&self.tree),
            "the copy reads the same sky"
        );
        self.written.append(&mut self.pending);
    }

    /// Tick `n`: each timer due in its span runs at its due time.
    fn tick(&mut self, n: i64) {
        let end = self.line.tick_start(n + 1).expect("a tick");
        while let Some(t) = self.due.fire(end) {
            let now = World::sky(&self.tree).expect("the sky");
            let w = self.sky.fire(&t.name, t.due, &now).expect("a fire");
            self.put(t.due, w);
            self.commit();
        }
        self.ticks += 1;
    }

    fn step(&mut self, span: Micros) {
        let mut n = 0;
        while self.line.tick_start(n).expect("a tick") < span {
            self.tick(n);
            n += 1;
        }
    }

    fn jump(&mut self, span: Micros) {
        let mut n = 0;
        while let Some(m) = self.due.next_tick(&self.line, n).expect("a tick") {
            if self.line.tick_start(m).expect("a tick") >= span {
                break;
            }
            self.tick(m);
            n = m + 1;
        }
    }

    /// The named events written after the start, with their world times.
    fn events(&self) -> Vec<(Micros, String, BTreeMap<u64, Value>)> {
        self.written
            .iter()
            .filter(|e| e.envelope.at > 0)
            .flat_map(|e| {
                e.events
                    .iter()
                    .flatten()
                    .map(move |v| (e.envelope.at, v.name.as_str().to_owned(), v.fields.clone()))
            })
            .collect()
    }
}

fn recs(changes: Vec<replica::effects::Change>) -> Vec<ChangeRec> {
    changes
        .into_iter()
        .map(|change| ChangeRec {
            change,
            rest: Rest::new(),
        })
        .collect()
}

/// A calendar starting at local midnight of `date` in a zone at `offset` (hours), with `changes` (UTC instant as
/// [y, m, d, hour], new offset in hours).
fn calendar(day_s: i64, date: [i64; 3], offset: i64, changes: &[([i64; 4], i64)]) -> Calendar {
    let utc = |[y, m, d, h]: [i64; 4]| days_from_civil(y, m, d) * DAY_US + h * HOUR;
    let origin = utc([date[0], date[1], date[2], -offset]);
    let mut offsets = vec![(0, offset * HOUR)];
    offsets.extend(
        changes
            .iter()
            .map(|&(at, o)| (utc(at) - origin, o * HOUR))
            .filter(|c| c.0 > 0),
    );
    Calendar {
        day_s,
        origin,
        offsets,
    }
}

#[test]
fn a1_a2_one_fast_day_each_change_is_one_named_effect_that_reaches_a_copy() {
    // A calendar day per world hour, from local midnight; stepped through the next midnight.
    let cfg = Config::today(calendar(3_600, [2026, 11, 18], -5, &[]), 2755);
    let mut w = World::new(cfg.clone());
    let start_runs = w.sky.runs;
    w.step(HOUR + 1);
    assert_eq!(w.ticks, 72_001);

    let events = w.events();
    let light: Vec<_> = events
        .iter()
        .filter(|e| e.1 == sky::EV_LIGHT)
        .map(|e| (e.0, e.2[&1].clone()))
        .collect();
    // Local 05:30, 07:00, 18:00, 19:30 and 21:00, a world hour standing for a day: minutes × 2.5 s.
    let want: Vec<_> = [
        (330, "dawn"),
        (420, "day"),
        (1080, "evening"),
        (1170, "dusk"),
        (1260, "night"),
    ]
    .iter()
    .map(|&(m, n)| (m * 2_500_000, Value::Text(name(&format!("souls:{n}")))))
    .collect();
    assert_eq!(light, want, "A1: each change of light, at its boundary");

    let days: Vec<_> = events.iter().filter(|e| e.1 == sky::EV_DAY).collect();
    assert_eq!(days.len(), 1, "A1: one new day");
    assert_eq!(days[0].0, HOUR, "A1: at the next local midnight");
    assert_eq!(days[0].2[&2], Value::Uint(4), "A1: a Thursday");

    // The weather table, slot by slot (a slot is five world minutes here): each change is one effect at its slot.
    let slot = HOUR / 12;
    let kinds: Vec<_> = (0..=12)
        .map(|s| cfg.weather(cfg.cal.local(s * slot).expect("local")))
        .collect();
    let want: Vec<_> = (1..=12)
        .filter(|&s| kinds[s] != kinds[s - 1])
        .map(|s| s as i64 * slot)
        .collect();
    let got: Vec<_> = events
        .iter()
        .filter(|e| e.1 == sky::EV_WEATHER)
        .map(|e| e.0)
        .collect();
    assert_eq!(got, want, "A1: each change of weather, at its slot");
    assert!(!want.is_empty(), "the day has weather that changes");

    // A2: the sky ran once per change and at no other tick of the 72,001.
    let changes = events.len() as u64;
    assert_eq!(
        w.sky.runs - start_runs,
        changes,
        "A2: one run per change, none in between"
    );
    assert!(
        w.written
            .iter()
            .filter(|e| matches!(e.body, Body::Changes(_)) && e.envelope.at > 0)
            .all(|e| e.events.is_some())
    );
    let now = World::sky(&w.copy).expect("the copy's sky");
    let due: BTreeMap<_, _> = std::iter::from_fn(|| w.due.fire(i64::MAX))
        .map(|t| (t.name.as_str().to_owned(), t.due))
        .collect();
    assert_eq!(
        due,
        BTreeMap::from([
            (sky::T_LIGHT.to_owned(), now.light_next),
            (sky::T_DAY.to_owned(), now.day_next),
            (sky::T_WEATHER.to_owned(), now.weather_next),
        ]),
        "A2: each field's next change is its one pending timer"
    );
    eprintln!(
        "A1/A2: {} ticks, {} effects ({} light, {} day, {} weather), {} runs after the start",
        w.ticks,
        changes,
        light.len(),
        days.len(),
        got.len(),
        w.sky.runs - start_runs
    );
}

/// A New York-like zone: summer time from 8 March 2026 07:00 UTC, standard again from 1 November 2026 06:00 UTC.
fn new_york(date: [i64; 3], offset: i64) -> Calendar {
    calendar(
        86_400,
        date,
        offset,
        &[([2026, 3, 8, 7], -4), ([2026, 11, 1, 6], -5)],
    )
}

#[test]
fn a3_a_48_hour_jump_writes_what_stepping_writes() {
    let cfg = Config::today(new_york([2026, 3, 7], -5), 2755);
    let mut jumped = World::new(cfg.clone());
    jumped.jump(48 * HOUR);
    let mut stepped = World::new(cfg);
    stepped.step(48 * HOUR);
    assert_eq!(stepped.ticks, 48 * 3_600 * 20);
    assert_eq!(
        jumped.written.len(),
        stepped.written.len(),
        "A3: as many entries"
    );
    for (a, b) in jumped.written.iter().zip(&stepped.written) {
        assert_eq!(a, b, "A3: the same entry at the same world time");
    }
    assert_eq!(
        jumped.tree.to_state(),
        stepped.tree.to_state(),
        "A3: the same state"
    );
    assert_eq!(jumped.copy.to_state(), jumped.tree.to_state());
    assert!(
        jumped.ticks < 100,
        "the jump ran only the ticks something was due in"
    );
    eprintln!(
        "A3: 48 h, {} entries both ways; jumped {} ticks, stepped {}",
        jumped.written.len(),
        jumped.ticks,
        stepped.ticks
    );
}

#[test]
fn a4_a_day_of_23_or_25_hours_gives_one_new_day() {
    for (date, offset, short) in [([2026, 3, 7], -5, 23), ([2026, 10, 31], -4, 25)] {
        let mut w = World::new(Config::today(new_york(date, offset), 2755));
        w.jump(74 * HOUR);
        let days: Vec<_> = w
            .events()
            .into_iter()
            .filter(|e| e.1 == sky::EV_DAY)
            .map(|e| (e.0, e.2[&1].clone()))
            .collect();
        let d = |n: i64| {
            let ([y, m, d], _) =
                sky::civil_from_days(days_from_civil(date[0], date[1], date[2]) + n);
            Value::Array(vec![
                Value::Uint(y as u64),
                Value::Uint(m as u64),
                Value::Uint(d as u64),
            ])
        };
        assert_eq!(
            days.iter().map(|e| e.1.clone()).collect::<Vec<_>>(),
            [d(1), d(2), d(3)],
            "A4: each date once"
        );
        assert_eq!(days[0].0, 24 * HOUR);
        assert_eq!(
            days[1].0 - days[0].0,
            short * HOUR,
            "A4: the day with the change is {short} hours"
        );
        assert_eq!(days[2].0 - days[1].0, 24 * HOUR);
        eprintln!(
            "A4: a {short}-hour day: new days at {:?} h",
            days.iter().map(|e| e.0 / HOUR).collect::<Vec<_>>()
        );
    }
}
