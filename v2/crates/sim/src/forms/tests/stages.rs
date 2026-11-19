//! F11 (#2774): a long form commits in stages. A three-stage form is stopped in its third stage each of three ways
//! (the Soul leaves, the thing is removed, the process is killed): each keeps exactly the first two stages' effects
//! and holds nobody, and a second Soul finishes it from the thing's own state.

use super::*;
use crate::forms::{Stages, bind_stages, holders, reservations};
use replica::effects::{ChangeRec, Envelope, Rest};
use replica::world_model::{Audience, Draft, Node, plain};

/// A thing whose form `make` has three stages: walk up and pause, press and pause, then a long pause. Each stage sets
/// its own field; `stage` counts the stages done.
const LONG: &str = r#"{
  "format": "souls-entry/1",
  "kind": "f11:press",
  "owner": "thing",
  "state": {
    "stage": { "n": 1, "type": "int", "unit": "count", "default": 0, "audience": { "rule": "everyone" } },
    "first": { "n": 2, "type": "int", "unit": "count", "default": 0, "audience": { "rule": "everyone" } },
    "second": { "n": 3, "type": "int", "unit": "count", "default": 0, "audience": { "rule": "everyone" } },
    "third": { "n": 4, "type": "int", "unit": "count", "default": 0, "audience": { "rule": "everyone" } }
  },
  "points": {
    "stand": { "role": "stand", "at_mm": [0, 0, -350], "yaw_mdeg": 0 },
    "button": { "role": "contact", "at_mm": [0, 1050, -90] }
  },
  "forms": {
    "make": {
      "who": "anyone",
      "stage": "stage",
      "stages": [
        { "steps": [{ "step": "walk_to", "point": "stand" }, { "step": "wait", "us": 1000000 }],
          "effects": [{ "change": "set", "field": "first", "to": 1 }] },
        { "steps": [{ "step": "move", "move": "press", "at": "button" }, { "step": "wait", "us": 1000000 }],
          "effects": [{ "change": "set", "field": "second", "to": 1 }] },
        { "steps": [{ "step": "wait", "us": 3000000 }],
          "effects": [{ "change": "set", "field": "third", "to": 1 }] }
      ]
    }
  }
}"#;

const STAGE: u64 = 1;
const FIRST: u64 = 2;
const SECOND: u64 = 3;
const THIRD: u64 = 4;

fn long() -> (json::Value, Stages) {
    let entry = parse(LONG).expect("JSON");
    let stages = bind_stages(&entry, "make")
        .expect("binds")
        .expect("a long form");
    (entry, stages)
}

/// The thing's fields as the log leaves them: every set of `node`, in order.
fn state(log: &[Effect], node: Id) -> BTreeMap<u64, Value> {
    let mut fields = BTreeMap::new();
    for e in log {
        for c in e.changes() {
            if let Change::Set {
                node: n, field, to, ..
            } = &c.change
                && *n == node
            {
                fields.insert(*field, to.clone());
            }
        }
    }
    fields
}

/// Each stage entry in the log: its cause and its stage number.
fn stage_keys(log: &[Effect]) -> Vec<(Cause, u64)> {
    effect_entries(log)
        .into_iter()
        .map(|e| {
            let ev = e
                .events
                .iter()
                .flatten()
                .find(|v| v.name.as_str() == "souls:effect")
                .expect("a key");
            let Some(Value::Uint(n)) = ev.fields.get(&1) else {
                panic!("a stage number")
            };
            (e.envelope.cause, *n)
        })
        .collect()
}

/// The tree as the log leaves the thing: a place, and the thing with its fields.
fn tree_with(node: Id, fields: BTreeMap<u64, Value>) -> Tree {
    let kinds =
        parse_kinds(&format!("{KINDS}\n{{1: \"f11:press\", 2: \"thing\"}}")).expect("kinds");
    let full = |p: &str| {
        kinds
            .keys()
            .find(|k| plain(k) == p)
            .expect("a kind")
            .clone()
    };
    let root = Id::new(Scope([0xf0; 16]), 1).expect("an id");
    let place = |id, kind: String, parent, fields| Node {
        id,
        kind,
        parent,
        slot: None,
        audience: Audience::Everyone,
        fields,
    };
    let draft = Draft {
        kinds: kinds.clone(),
        souls: Default::default(),
        audiences: BTreeMap::new(),
        nodes: vec![
            place(root, full("souls:place"), None, BTreeMap::new()),
            place(node, full("f11:press"), Some(root), fields),
        ],
        links: Vec::new(),
    };
    Tree::load(&draft).expect("loads").0
}

impl Bench {
    fn start_long(&mut self, body: Id, node: Id, stages: &Stages, it: Intent) -> Asked {
        self.look();
        let now = self.now;
        let (mut w, forms) = self.world();
        forms
            .start_stages(
                &mut w,
                body,
                node,
                it,
                stages.clone(),
                Limits::default(),
                now,
            )
            .expect("started")
    }

    fn step(&mut self, log: &mut Vec<Effect>) {
        self.tick();
        self.flush(log);
    }
}

/// How a run is stopped in its third stage.
#[derive(Clone, Copy, Debug)]
enum Way {
    Leaves,
    Removed,
    Killed,
}

#[test]
fn a1_a2_stopped_in_stage_three_each_of_three_ways_keeps_two_stages_holds_nobody_and_a_second_soul_finishes()
 {
    let (entry, stages) = long();
    let near = Vec3::new(0, 0, 3_000_000);
    println!(
        "| stopped in stage 3 | ended | stage entries | stage field | first, second, third | holds | finished by a second Soul |"
    );
    for way in [Way::Leaves, Way::Removed, Way::Killed] {
        let mut b = Bench::new();
        let (body, node) = b.add(&entry, near, Vec3::ZERO);
        let it = intent(body, 0);
        assert!(matches!(
            b.start_long(body, node, &stages, it),
            Asked::Started(_)
        ));
        let mut log = Vec::new();
        while b.forms.stage(body) != Some(2) {
            assert!(!b.forms.is_empty(), "{way:?}: the run ended before stage 3");
            b.step(&mut log);
        }
        // Half a second into stage three's pause.
        for _ in 0..10 {
            b.step(&mut log);
        }
        assert_eq!(b.forms.stage(body), Some(2));
        let now = b.now;
        match way {
            Way::Leaves => {
                let (mut w, forms) = b.world();
                forms.leave(&mut w, body, now).expect("left");
            }
            Way::Removed => {
                let mut removal = log.last().expect("an entry").clone();
                removal.envelope = Envelope {
                    sequence: 0,
                    at: now,
                    cause: Cause::World,
                    actor: Actor::World,
                    audience: Audience::Everyone,
                    node,
                };
                removal.body = Body::Changes(vec![ChangeRec {
                    change: Change::Remove { node },
                    rest: Rest::new(),
                }]);
                removal.events = None;
                b.forms.out.push(removal);
                let (mut w, forms) = b.world();
                forms.gone(&mut w, node, now);
            }
            Way::Killed => {
                // The tick's entries reached the log; the process dies and the world reopens from the log alone.
                b = Bench::new();
                b.add(&entry, near, Vec3::ZERO);
                b.forms = Forms::recover(&log, now);
                b.now = now;
            }
        }
        b.flush(&mut log);
        let Ok([ended]) = <[_; 1]>::try_from(std::mem::take(&mut b.forms.ended)) else {
            panic!("{way:?}: one end")
        };
        let keys = stage_keys(&log);
        let fields = state(&log, node);
        let read = |f| fields.get(&f).cloned();
        // Exactly the first two stages' effects, and the stage field says two are done.
        assert_eq!(
            keys,
            [(Cause::Intent(it.id), 0), (Cause::Intent(it.id), 1)],
            "{way:?}"
        );
        assert_eq!(read(STAGE), Some(Value::Uint(2)), "{way:?}");
        assert_eq!(
            (read(FIRST), read(SECOND), read(THIRD)),
            (Some(Value::Uint(1)), Some(Value::Uint(1)), None),
            "{way:?}"
        );
        // Nobody is held: no reservation stands, no hold lacks a holder, no driver, timer or move is left.
        assert!(b.forms.is_empty(), "{way:?}");
        assert!(reservations(&log).is_empty(), "{way:?}");
        assert!(
            holders(&b.forms, &b.c, &b.moves, &log).is_empty(),
            "{way:?}"
        );
        b.clean();

        // A second Soul finishes it from the thing's own state, but not once the thing is gone.
        let finished = match way {
            Way::Removed => "no (the thing is gone)".to_owned(),
            Way::Leaves | Way::Killed => {
                b.tree = tree_with(node, fields.clone());
                let (second, _) = b.add(&entry, Vec3::new(2_000_000, 0, 3_000_000), Vec3::ZERO);
                let again = intent(second, 0);
                let from = b.now;
                assert!(matches!(
                    b.start_long(second, node, &stages, again),
                    Asked::Started(_)
                ));
                assert_eq!(b.forms.stage(second), Some(2), "{way:?}: starts at stage 3");
                while !b.forms.is_empty() {
                    b.step(&mut log);
                }
                let Ok([done]) = <[_; 1]>::try_from(std::mem::take(&mut b.forms.ended)) else {
                    panic!("{way:?}: one end")
                };
                assert_eq!(done.how.as_str(), "done", "{way:?}");
                let after = state(&log, node);
                let keys = stage_keys(&log);
                assert_eq!(
                    keys[2..],
                    [(Cause::Intent(again.id), 2)],
                    "{way:?}: only stage 3 is written again"
                );
                assert_eq!(after.get(&THIRD), Some(&Value::Uint(1)));
                assert_eq!(
                    after.get(&STAGE),
                    Some(&Value::Uint(0)),
                    "the form is whole"
                );
                assert!(reservations(&log).is_empty());
                b.clean();
                format!(
                    "yes: stage 3 only, {} µs, by another intent",
                    done.at - from
                )
            }
        };
        println!(
            "| {way:?} | {} | {} | {:?} | {:?}, {:?}, {:?} | none | {finished} |",
            ended.how.as_str(),
            keys.len(),
            read(STAGE),
            read(FIRST),
            read(SECOND),
            read(THIRD)
        );
    }
}

#[test]
fn a_long_form_run_whole_commits_each_stage_once_in_its_own_entry() {
    let (entry, stages) = long();
    let mut b = Bench::new();
    let (body, node) = b.add(&entry, Vec3::new(0, 0, 3_000_000), Vec3::ZERO);
    let it = intent(body, 0);
    b.start_long(body, node, &stages, it);
    let mut log = Vec::new();
    while !b.forms.is_empty() {
        b.step(&mut log);
    }
    let keys = stage_keys(&log);
    assert_eq!(
        keys,
        [0, 1, 2].map(|n| (Cause::Intent(it.id), n)),
        "one entry per stage"
    );
    // A resend once the last stage is in the log gets the first receipt; the run is not made again.
    let again = b.start_long(body, node, &stages, it);
    assert!(
        matches!(again, Asked::Applied(ref r) if r.entries.len() == 3),
        "{again:?}"
    );
    assert!(b.forms.is_empty());
    let fields = state(&log, node);
    assert_eq!(fields.get(&STAGE), Some(&Value::Uint(0)));
    // A form with stages but no stage field of the kind is refused by name.
    let bad = parse(&LONG.replace(r#""stage": "stage","#, r#""stage": "first_","#)).expect("JSON");
    assert_eq!(
        bind_stages(&bad, "make").map_err(|r| r.name),
        Err("stage-field-unknown")
    );
}
