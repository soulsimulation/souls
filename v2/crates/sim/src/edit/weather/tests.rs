//! G5's A4 (#2762): the creator's weather is E6's one effect, seen in every view of the world, ended by its timer, and
//! no second weather field exists. `cargo test -p sim --lib weather -- --nocapture`.

use super::{ENDED, LEVEL, set};
use crate::daylight::{Config, Daylight, Write};
use crate::timers::DueList;
use replica::effects::{
    Actor, Body, Cause, ChangeRec, Effect, Envelope, Header, Part, Rest, TimerRec, schema_hash,
};
use replica::encode::{Name, Value, encode};
use replica::ids::{Hash, Id, Minter, Purpose, Scope};
use replica::sky::{self, Calendar, DAY_US, Sky, days_from_civil};
use replica::time::Micros;
use replica::tree::Tree;
use replica::views::{Key, Level, Redactions, View};
use replica::world_model::Audience;
use std::collections::BTreeMap;

const HOUR: Micros = 3_600_000_000;

fn name(s: &str) -> Name {
    Name::new(s).expect("a name")
}

fn header(zone: Id) -> Header {
    let v = Value::Map(BTreeMap::from([
        (
            1,
            Value::Bytes(Hash::of(Purpose::Fixture, b"souls/g5-weather/1").to_bytes()),
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

/// A world node with E6's sky, the entries written, and the timer each name holds.
struct W {
    tree: Tree,
    header: Header,
    root: Id,
    mint: Minter,
    sky: Daylight,
    timer: BTreeMap<Name, Id>,
    written: Vec<Effect>,
}

impl W {
    fn new() -> W {
        let mut mint = Minter::new(Scope([0x65; 16]));
        let root = mint.mint().expect("an id");
        let cal = Calendar {
            day_s: 86_400,
            origin: days_from_civil(2026, 11, 19) * DAY_US,
            offsets: vec![(0, 0)],
        };
        let cfg = Config::today(cal, 2762);
        let mut w = W {
            tree: Tree::start(root, name("souls:world")),
            header: header(root),
            root,
            mint,
            sky: Daylight::new(cfg.clone(), root),
            timer: BTreeMap::new(),
            written: Vec::new(),
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
        let world = (Cause::World, Actor::World);
        w.commit(vec![w.entry(0, world, Body::Changes(recs(sets)), None)]);
        for write in w.sky.start(0).expect("the first sky") {
            w.put(0, world, write);
        }
        w
    }

    fn entry(
        &self,
        at: Micros,
        (cause, actor): (Cause, Actor),
        body: Body,
        events: Option<Vec<replica::effects::Event>>,
    ) -> Effect {
        Effect {
            envelope: Envelope {
                sequence: self.tree.to_state().next,
                at,
                cause,
                actor,
                audience: Audience::Everyone,
                node: self.root,
            },
            body,
            events,
            rest: Rest::new(),
        }
    }

    /// One write's two entries, each committed: the change with its event, then its timer cleared and set again.
    fn put(&mut self, at: Micros, by: (Cause, Actor), w: Write) {
        let e = self.entry(
            at,
            by,
            Body::Changes(recs(w.changes)),
            w.event.map(|e| vec![e]),
        );
        self.commit(vec![e]);
        let id = self.mint.mint().expect("an id");
        let mut timers = Vec::new();
        if let Some(old) = self.timer.insert(w.timer.clone(), id) {
            timers.push(TimerRec::Clear { timer: old });
        }
        timers.push(TimerRec::Set {
            timer: id,
            due: w.next,
            name: w.timer,
        });
        let e = self.entry(at, by, Body::Timers(timers), None);
        self.commit(vec![e]);
    }

    fn commit(&mut self, effects: Vec<Effect>) {
        let v = Value::Map(BTreeMap::from([
            (1, Value::Bytes(self.header.hash().to_bytes())),
            (
                2,
                Value::Array(effects.iter().map(Effect::to_value).collect()),
            ),
        ]));
        let part = Part::read(&encode(&v).expect("bytes")).expect("a part");
        self.tree.apply(&self.header, &part).expect("applies");
        self.written.extend(effects);
    }

    fn sky(&self) -> Sky {
        Sky::read(self.tree.node(self.tree.root()).expect("root").fields()).expect("the sky")
    }

    /// The timers the tree's state holds, as a checkpoint gives them.
    fn due(&self) -> Vec<(String, Micros)> {
        let mut list = DueList::from_state(&self.tree.to_state().timers);
        std::iter::from_fn(|| list.fire(i64::MAX))
            .map(|t| (t.name.as_str().to_owned(), t.due))
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

#[test]
fn a4_the_creators_weather_is_e6s_one_effect_seen_in_every_view_and_ended_by_its_timer() {
    let mut w = W::new();
    let creator = Id::new(Scope([0xc0; 16]), 1).expect("an id");
    let intent = Id::new(Scope([0x11; 16]), 1).expect("an id");
    let by = (Cause::Intent(intent), Actor::Creator(creator));
    let (at, until) = (HOUR, 3 * HOUR);
    let snow = name("souls:snow");

    // Refused, changing nothing: a level outside 0 to 100, an end not after now.
    let before = w.sky();
    let bad = set(&mut w.sky, snow.clone(), [50, 101, 0], at, until).expect_err("a level of 101");
    assert_eq!(bad.name, LEVEL);
    let bad = set(&mut w.sky, snow.clone(), [50, 50, 0], at, at).expect_err("an end at now");
    assert_eq!(bad.name, ENDED);
    assert_eq!(w.sky.cfg.until, None);

    // Set: one effect on the world node with E6's named event, for everyone.
    let state0 = w.tree.to_state();
    let write = set(&mut w.sky, snow.clone(), [95, 80, 40], at, until).expect("set");
    w.put(at, by, write);
    let effect = w.written[w.written.len() - 2].clone();
    let events = effect.events.clone().expect("the named event");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].name.as_str(), sky::EV_WEATHER, "E6's one event");
    assert_eq!(effect.envelope.node, w.root);
    assert_eq!(effect.envelope.audience, Audience::Everyone);
    assert_eq!(effect.envelope.actor, Actor::Creator(creator));
    let now = w.sky();
    assert_eq!(now.weather, snow);
    assert_eq!(now.levels, [95, 80, 40]);
    assert_eq!(now.weather_next, until);
    assert_ne!(now.weather, before.weather);
    println!(
        "A4: the creator's weather {} {:?} until {until} µs, one effect at sequence {} with {}",
        now.weather.as_str(),
        now.levels,
        effect.envelope.sequence,
        sky::EV_WEATHER
    );

    // Every view of the world: the public view at each level that keeps fields and events holds the effect (a viewer
    // in any audience is sent the public view, views rule 5; outline and counts keep no fields by their definition).
    let state1 = {
        let mut t = Tree::start(w.root, name("souls:world"));
        let v = Value::Map(BTreeMap::from([
            (1, Value::Bytes(w.header.hash().to_bytes())),
            (
                2,
                Value::Array(
                    w.written[..w.written.len() - 1]
                        .iter()
                        .map(Effect::to_value)
                        .collect(),
                ),
            ),
        ]));
        t.apply(&w.header, &Part::read(&encode(&v).unwrap()).unwrap())
            .expect("a copy applies the same bytes");
        assert_eq!(
            Sky::read(t.node(t.root()).unwrap().fields()),
            Some(now.clone()),
            "a copy reads the same weather"
        );
        t.to_state()
    };
    let none = Redactions::new([]);
    for level in [Level::Full, Level::Sampled] {
        let key = Key {
            node: w.root,
            level,
            audience: Audience::Everyone,
        };
        let mut view = View::new(key, &w.header, &none);
        view.step(&state0, &effect, &state1, &none).expect("a step");
        let held = view
            .output()
            .records
            .iter()
            .any(|(_, r)| *r == effect.to_value());
        assert!(held, "A4: the {} view holds it", level.name());
    }

    // The end is on the timer list: one weather timer, due at the end.
    let due = w.due();
    let weather: Vec<_> = due.iter().filter(|t| t.0 == sky::T_WEATHER).collect();
    assert_eq!(
        weather,
        [&(sky::T_WEATHER.to_owned(), until)],
        "A4: ended by a timer"
    );

    // Its fire at the end: E6's table resumes.
    let table = w.sky.cfg.weather(w.sky.cfg.cal.local(until).unwrap());
    let fire = w
        .sky
        .fire(&name(sky::T_WEATHER), until, &now)
        .expect("the fire");
    let ev = fire.event.clone().expect("the weather changes back");
    w.put(until, (Cause::World, Actor::World), fire);
    let after = w.sky();
    assert_ne!(after.weather, snow, "A4: the creator's weather ends");
    assert_eq!(ev.name.as_str(), sky::EV_WEATHER);
    assert!(after.weather_next > until);
    println!(
        "A4: at {until} µs the timer fired and the table's weather {} (slot kind {table}) resumed, next change at {} µs",
        after.weather.as_str(),
        after.weather_next
    );
}

/// A4's check: the weather is E6's fields alone. No Rust source of the workspace's crates outside `replica`'s sky
/// defines another field for weather, rain, cloud, wind or snow.
#[test]
fn a4_no_second_weather_field() {
    let crates = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut found = Vec::new();
    let mut stack = vec![crates];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).expect("a folder") {
            let p = e.expect("an entry").path();
            if p.is_dir() {
                if !p.ends_with("target") {
                    stack.push(p);
                }
                continue;
            }
            if p.extension().is_none_or(|x| x != "rs") || p.ends_with("replica/src/sky.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&p).expect("a source");
            for line in text.lines() {
                let l = line.trim_start();
                let field = l.starts_with("pub const F_") || l.starts_with("const F_");
                let up = l.to_uppercase();
                if field
                    && ["WEATHER", "RAIN", "CLOUD", "WIND", "SNOW"]
                        .iter()
                        .any(|w| up.split(':').next().unwrap_or("").contains(w))
                {
                    found.push(format!("{}: {l}", p.display()));
                }
            }
        }
    }
    assert!(found.is_empty(), "A4: a second weather field: {found:#?}");
    println!("A4: no weather field outside replica::sky");
}
