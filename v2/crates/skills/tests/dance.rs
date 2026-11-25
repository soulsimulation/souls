//! A Soul dances for as long as it is asked (0.135 fix): the humanoid's `dance` form, as content declares it, is one
//! dance move repeated back to back for its `for` seconds, with no pause between moves, then a clean end; with no
//! `for`, its default. A leave (the Soul's `stop`) ends it at the next phase boundary. Run on a fake host whose moves
//! last the dance move's own phases (`content/moves/dance.json`).

use std::collections::BTreeMap;
use std::path::Path;

use replica::effects::{Change, Event, Refusal};
use replica::encode::Name;
use replica::host::{Answer, Ask, Host, Seen};
use replica::ids::Id;
use replica::pose::{ControllerInput, Vec3, fixture};
use replica::rules::json::{Value, parse};
use replica::time::Micros;

use skills::form_runner::{Arg, Args, Limits, Next, Runner, Woke, bind_with};

fn content(path: &str) -> Value {
    let f = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content").join(path);
    parse(&std::fs::read_to_string(f).expect("read")).expect("JSON")
}

/// The dance move's length, µs: its phases' sum.
fn dance_us() -> Micros {
    let m = content("moves/dance.json");
    m.get("phases")
        .and_then(Value::obj)
        .expect("phases")
        .iter()
        .map(|(_, v)| match v {
            Value::Int(n) => i64::try_from(*n).expect("µs"),
            _ => panic!("a phase is µs"),
        })
        .sum()
}

fn me() -> Id {
    fixture(1)
}

#[derive(Default)]
struct Fake {
    now: Micros,
    next: u8,
    timers: BTreeMap<Id, (Micros, Name)>,
}

impl Host for Fake {
    fn now(&self) -> Micros {
        self.now
    }
    fn body(&self) -> Id {
        me()
    }
    fn read(&self, n: Id) -> Option<Seen> {
        (n == me()).then(|| Seen {
            id: me(),
            kind: Name::new("eden:humanoid").expect("a name"),
            parent: None,
            position: Vec3::ZERO,
            fields: BTreeMap::new(),
        })
    }
    fn ask(&self, _: &Ask) -> Option<Answer> {
        None
    }
    fn set_timer(&mut self, after: Micros, name: Name) -> Id {
        self.next = self.next.wrapping_add(1);
        let id = fixture(100 + u64::from(self.next));
        self.timers.insert(id, (self.now + after, name));
        id
    }
    fn clear_timer(&mut self, timer: Id) {
        self.timers.remove(&timer);
    }
    fn draw(&mut self) -> u64 {
        0
    }
    fn control(&mut self, _: ControllerInput) {}
    fn cross(&mut self, _: Id, _: i64) {}
    fn emit(&mut self, _: Vec<Change>, _: Option<Event>) -> Result<(), Refusal> {
        Ok(())
    }
}

/// What a run of the humanoid's `dance` with `args` did: each move's start and end, µs, how it ended and when. A
/// leave is sent at `leave_at` when given. Moves last [`dance_us`]; their contact is the end of their start-up.
fn dance(args: &Args, leave_at: Option<Micros>) -> (Vec<(Micros, Micros)>, String, Micros) {
    let steps = bind_with(&content("kinds/body/humanoid.json"), "dance", args).expect("binds");
    let mut h = Fake::default();
    let mut r = Runner::new(steps, me(), Limits::default());
    let mut next = r.wake(&mut h, Woke::Start);
    let (len, up) = (dance_us(), 400_000);
    let mut moves = Vec::new();
    let mut left = leave_at;
    for _ in 0..10_000 {
        match next {
            Next::End(how) => return (moves, how.as_str().to_owned(), h.now),
            Next::Move { ref name, .. } => {
                assert_eq!(name.as_str(), "souls:dance");
                let start = h.now;
                moves.push((start, start + len));
                // A leave during the move is taken at its next phase boundary: its contact, or its end.
                if let Some(at) = left.filter(|&at| at < start + len) {
                    left = None;
                    h.now = at.max(start);
                    assert!(matches!(r.wake(&mut h, Woke::Leave), Next::Sleep));
                    if h.now < start + up {
                        h.now = start + up;
                        next = r.wake(&mut h, Woke::Contact);
                        if matches!(next, Next::End(_)) {
                            moves.last_mut().expect("a move").1 = h.now;
                            continue;
                        }
                    }
                }
                h.now = start + up;
                let _ = r.wake(&mut h, Woke::Contact);
                h.now = start + len;
                next = r.wake(&mut h, Woke::Moved(Name::new("done").expect("n")));
            }
            Next::Sleep => {
                // A pause: its timer fires.
                let (&id, &(due, _)) = h
                    .timers
                    .iter()
                    .min_by_key(|(_, (due, _))| *due)
                    .expect("a timer");
                h.now = due;
                h.timers.remove(&id);
                next = r.wake(&mut h, Woke::Timer(id));
            }
            _ => panic!("a dance asked for something other than a move or a pause"),
        }
    }
    panic!("the run did not end")
}

/// The longest stretch between one move's end and the next one's start, µs.
fn widest_gap(moves: &[(Micros, Micros)]) -> Micros {
    moves.windows(2).map(|w| w[1].0 - w[0].1).max().unwrap_or(0)
}

fn secs(n: &str) -> Args {
    Args::from([("for".to_owned(), Arg::Name(n.to_owned()))])
}

#[test]
fn a_dance_for_a_minute_is_one_unbroken_dance_of_a_minute_then_done() {
    let (moves, how, end) = dance(&secs("60"), None);
    assert_eq!(how, "done");
    assert_eq!(moves.first().map(|m| m.0), Some(0));
    assert_eq!(widest_gap(&moves), 0, "no pause between moves: {moves:?}");
    let last = moves.last().expect("moves").1;
    assert!(
        (60_000_000..60_000_000 + dance_us()).contains(&last),
        "it dances a minute, to its last whole move: {last}"
    );
    assert_eq!(end, last, "and ends with that move");
}

#[test]
fn the_same_minute_given_as_a_whole_number_and_a_dance_with_no_for_dances_its_default() {
    let int = Args::from([("for".to_owned(), Arg::Int(60))]);
    assert_eq!(dance(&int, None), dance(&secs("60"), None));
    let (moves, how, _) = dance(&Args::new(), None);
    assert_eq!(how, "done");
    assert_eq!(widest_gap(&moves), 0, "{moves:?}");
    let last = moves.last().expect("moves").1;
    assert!((10_000_000..10_000_000 + dance_us()).contains(&last), "{last}");
}

#[test]
fn a_stop_during_a_long_dance_ends_it_at_the_next_phase_boundary() {
    // Until told to stop: the most, an hour, and a leave after 20.1 s ends the run then, by its name.
    let (moves, how, end) = dance(&secs("3600"), Some(20_100_000));
    assert_eq!(how, "left");
    assert_eq!(widest_gap(&moves), 0);
    assert!(end >= 20_100_000 && end - 20_100_000 <= 400_000, "{end}");
}

#[test]
fn a_dance_for_no_time_or_past_the_most_is_refused_by_name() {
    let e = content("kinds/body/humanoid.json");
    for (n, why) in [("0", "out-of-range"), ("3601", "out-of-range"), ("soon", "arg-not-a-number")] {
        let r = bind_with(&e, "dance", &secs(n));
        assert_eq!(r.map_err(|e| e.name), Err(why), "for={n}");
    }
}
