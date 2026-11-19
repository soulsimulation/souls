//! E11's checks (#2782): any gesture can be said and remembered. The six requests from E17's list, run live through
//! B2's moves and replayed from their encoded records; a mood held through a walk; the fact never carries words.

use std::collections::BTreeMap;
use std::path::Path;

use replica::bodies::{Class, Family, SkillShape, Want};
use replica::effects::fixture_bytes;
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, Minter, Scope};
use replica::moves::Effector;
use replica::pose::{Frame, Quat, Vec3, fixture};
use replica::time::Micros;
use sim::controller::Controller;
use sim::gesture::{Gesture, GestureRecord, Gestures, Mood, Moods, StandIns};
use sim::ground::Piece;
use sim::mover::Surface;
use sim::moves::{Moves, Reach};
use sim::timers::DueList;

const FAMILIES: &str = include_str!("../../replica/fixtures/bodies/families.diag");

fn name(s: &str) -> Name {
    Name::new(s).expect("a name")
}

fn table() -> StandIns {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/stand-ins");
    StandIns::load(&dir, name("Idle")).expect("the stand-ins")
}

fn humanoid() -> Family {
    let v = decode(&fixture_bytes(FAMILIES).expect("bytes"))
        .expect("decodes")
        .value;
    let Value::Array(fs) = v else {
        panic!("a list")
    };
    fs.iter()
        .map(|f| Family::from_value(f).expect("a family"))
        .find(|f| f.name.as_str() == "souls:humanoid")
        .expect("the humanoid")
}

/// The world answers no distance: a gesture asks none of it.
struct Nowhere;

impl Reach for Nowhere {
    fn distance(&self, _: Id, _: &Effector, _: Option<&Name>, _: Id, _: &Name) -> Option<i64> {
        None
    }
}

struct World {
    c: Controller,
    due: DueList,
    mint: Minter,
    moves: Moves,
    gestures: Gestures,
    moods: Moods,
    body: Id,
    other: Id,
    /// T8's text store, as the test holds it: words by id.
    text: BTreeMap<Id, &'static str>,
}

fn world() -> World {
    let ground_id = fixture(1);
    let corners = vec![
        [-5_000, 0, -5_000],
        [5_000, 0, -5_000],
        [5_000, 0, 5_000],
        [-5_000, 0, 5_000],
    ];
    let ground = Surface::new(
        ground_id,
        vec![Piece {
            outline: vec![corners.clone()],
            vertices: corners,
            triangles: vec![[0, 2, 1], [0, 3, 2]],
            ground: sim::gaits::Ground::Dry,
        }],
    );
    let mut mint = Minter::new(Scope([0xe1; 16]));
    let body = mint.mint().expect("id");
    let other = mint.mint().expect("id");
    let frame = Frame {
        node: ground_id,
        slot: None,
    };
    let mut c = Controller::new();
    for b in [body, other] {
        let placed = ground
            .place(b, frame, Vec3::ZERO, Quat::IDENTITY)
            .expect("placed");
        c.add(humanoid(), placed).expect("added");
    }
    World {
        c,
        due: DueList::new(),
        mint,
        moves: Moves::new(),
        gestures: Gestures::new(),
        moods: Moods::new(),
        body,
        other,
        text: BTreeMap::new(),
    }
}

impl World {
    fn say(&mut self, words: &'static str) -> Id {
        let id = self.mint.mint().expect("id");
        self.text.insert(id, words);
        id
    }

    fn gesture(&mut self, g: &Gesture, now: Micros) -> Result<u64, replica::effects::Refusal> {
        let t = table();
        self.gestures.start(
            &mut self.moves,
            &mut self.c,
            &mut self.due,
            &mut self.mint,
            &Nowhere,
            &t,
            self.body,
            g,
            now,
        )
    }

    /// Fires every timer due by `until`; the gesture records that ended.
    fn run(&mut self, until: Micros) -> Vec<GestureRecord> {
        let mut out = Vec::new();
        while let Some(t) = self.due.fire(until) {
            let fired = self.gestures.fire(
                &mut self.moves,
                &mut self.c,
                &mut self.due,
                &mut self.mint,
                &Nowhere,
                &t,
            );
            out.extend(fired.and_then(|(_, r)| r));
        }
        out
    }
}

/// The words in `v`'s bytes, if any of `words` is there.
fn carries(v: &Value, words: &[&str]) -> Option<String> {
    let bytes = encode(v).expect("encodes");
    words
        .iter()
        .flat_map(|w| w.split(' '))
        .filter(|w| w.len() > 2)
        .find(|w| bytes.windows(w.len()).any(|x| x == w.as_bytes()))
        .map(str::to_owned)
}

const SIX: [(&str, Option<&str>, bool); 6] = [
    ("look bored", Some("Idle_Tired_Loop"), true),
    ("be shy", Some("Idle_FoldArms_Loop"), true),
    ("cry", None, false),
    ("do a cartwheel", Some("Celebration"), false),
    ("shrug", Some("Idle_No_Loop"), false),
    ("faint", Some("Idle_Tired_Loop"), false),
];

#[test]
fn a1_a4_the_six_run_live_and_replay_and_no_fact_carries_their_words() {
    let mut w = world();
    let all: Vec<&str> = SIX.iter().map(|s| s.0).collect();
    let mut now = 0;
    let mut records = Vec::new();
    let mut moods = Vec::new();
    for (words, like, mood) in SIX {
        let id = w.say(words);
        let like = like.map(name);
        if mood {
            let m = Mood {
                words: id,
                like: like.clone(),
                since: now,
            };
            w.moods.set(&table(), w.body, Some(m.clone())).expect("set");
            assert_eq!(w.moods.get(w.body), Some(&m));
            moods.push(m);
            now += 1_000_000;
            continue;
        }
        // The shrug looks at the other body, which it changes nothing on.
        let gaze = (words == "shrug").then_some(w.other);
        let g = Gesture {
            words: id,
            like: like.clone(),
            gaze,
        };
        let n = w
            .gesture(&g, now)
            .expect("accepted, though no clip is drawn for it");
        let live = w.gestures.record(&w.moves, n).expect("in progress");
        let stand_in = like.clone().unwrap_or_else(|| name("Idle"));
        assert_eq!(live.mv.name, stand_in, "{words}: the stand-in it named");
        assert_eq!(live.mv.target, w.body, "{words}: a move on the body itself");
        let want = table().pick(like.as_ref()).expect("in the table").clone();
        assert_eq!(
            live.mv.ends.last().copied(),
            Some(now + want.length()),
            "{words}: lasts as long as its stand-in"
        );
        assert!(
            w.c.claims(w.other).expect("a body").running().is_empty(),
            "{words}: nothing claimed on the one it looks at"
        );
        let ended = w.run(Micros::MAX);
        assert_eq!(ended.len(), 1, "{words}: ended once");
        let r = &ended[0];
        assert_eq!(r.mv.ended.as_ref().map(|e| e.how.as_str()), Some("done"));
        assert_eq!((r.words, r.like.clone(), r.gaze), (id, like, gaze));
        records.push(r.clone());
        now = r.mv.ends.last().copied().expect("ends") + 500_000;
    }
    // Replayed: each record from its bytes is the same record, its words the same reference.
    for r in &records {
        let bytes = encode(&r.to_value()).expect("encodes");
        let back =
            GestureRecord::from_value(&decode(&bytes).expect("decodes").value).expect("reads");
        assert_eq!(&back, r);
        assert!(w.text.contains_key(&back.words), "the words by reference");
        assert_eq!(
            carries(&r.to_value(), &all),
            None,
            "the record holds no words"
        );
        let fact = r.fact();
        assert_eq!(carries(&fact, &all), None, "the fact carries no words");
        let Value::Map(f) = &fact else {
            panic!("a map")
        };
        assert_eq!(f.get(&2), Some(&Value::Text(name("souls:gestured"))));
        assert_eq!(replica::audience::reference(&f[&4]), Some(r.words));
        println!(
            "{:>16}: drawn as {:<18} {} to {} µs, record {} bytes",
            w.text[&r.words],
            r.mv.name.as_str(),
            r.mv.start,
            r.mv.ends.last().unwrap(),
            bytes.len()
        );
    }
    for m in &moods {
        let back =
            Mood::from_value(&decode(&encode(&m.to_value()).unwrap()).unwrap().value).unwrap();
        assert_eq!(&back, m);
        assert_eq!(carries(&m.to_value(), &all), None, "a mood holds no words");
    }
    assert_eq!(records.len(), 4);
    assert_eq!(moods.len(), 2);
}

#[test]
fn a_stand_in_not_in_the_table_is_refused_and_nothing_changes() {
    let mut w = world();
    let id = w.say("juggle");
    let g = Gesture {
        words: id,
        like: Some(name("Juggle_Loop")),
        gaze: None,
    };
    let r = w.gesture(&g, 0).expect_err("refused");
    assert_eq!(r.name, "stand-in-unknown");
    assert!(w.moves.is_empty() && w.due.is_empty());
    let m = Mood {
        words: id,
        like: Some(name("Juggle_Loop")),
        since: 0,
    };
    assert_eq!(
        w.moods
            .set(&table(), w.body, Some(m))
            .expect_err("refused")
            .name,
        "stand-in-unknown"
    );
    assert_eq!(w.moods.get(w.body), None);
}

#[test]
fn a3_a_mood_is_held_until_changed_and_survives_a_walk() {
    let mut w = world();
    let bored = w.say("look bored");
    let m = Mood {
        words: bored,
        like: Some(name("Idle_Tired_Loop")),
        since: 0,
    };
    w.moods.set(&table(), w.body, Some(m.clone())).expect("set");
    // A walk: its driver claims every leg, runs, and is released.
    let walk = SkillShape {
        name: name("test:walk"),
        claims: vec![Want::All(Class::Locomotion)],
        blocks: vec![],
        cancelled_by: vec![Class::Locomotion],
    };
    let d = w.c.claim(w.body, &walk).expect("walking");
    assert_eq!(w.moods.get(w.body), Some(&m), "held while walking");
    // A gesture during the walk takes the legs (the cartwheel) and ends; the mood is still there.
    let flip = w.say("do a cartwheel");
    w.gesture(
        &Gesture {
            words: flip,
            like: Some(name("Celebration")),
            gaze: None,
        },
        1_000_000,
    )
    .expect("the cartwheel");
    assert_eq!(w.run(Micros::MAX).len(), 1);
    let _ = w.c.release(w.body, d);
    assert_eq!(w.moods.get(w.body), Some(&m), "held after the walk");
    // Changed, then cleared, by intent alone.
    let shy = w.say("be shy");
    let m2 = Mood {
        words: shy,
        like: None,
        since: 9_000_000,
    };
    w.moods
        .set(&table(), w.body, Some(m2.clone()))
        .expect("changed");
    assert_eq!(w.moods.get(w.body), Some(&m2));
    w.moods.set(&table(), w.body, None).expect("cleared");
    assert_eq!(w.moods.get(w.body), None);
}
