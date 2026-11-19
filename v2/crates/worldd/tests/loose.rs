//! Engine v2 F10b (#3476): loose things end in a served world. F10's `sim::expiry::Loose`, wired into the tick by
//! `worldd::loose`, on N2's test world through N1's loader (as `worldd serve` loads Eden).
//!
//! - `a1_`: what the tick does after a Soul's commits. A thing set down loose gets one end, at set-down plus its
//!   kind's lifetime; things owned or in a slot get none; an owner's unlink makes its thing loose from then. Each ends
//!   by one `souls:thing_expired` effect at its due time; kept things remain.
//! - `a1_a2_a3_`: a real `worldd serve`. A Soul's set-down, with the timer its commit writes, is in the log; the
//!   process is killed before the end and served again: the end fires once, on time, rebuilt from the tree's timers
//!   (the checkpoint's and the log's after it); the log replayed gives a tree without the thing and with no end
//!   pending, and a third start writes no second end.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use replica::activity::ActivityKind;
use replica::apply::Replica;
use replica::audience::OWNS;
use replica::effects::{
    Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Header, Part, Rest, fixture_bytes,
};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, Minter, Scope};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::time::Micros;
use replica::tree::{Rules, Tree};
use replica::world_model::{Audience, End, Kind, parse_kinds, plain};
use sim::expiry::{ENDS, EXPIRED};
use sim::log::{FileStore, Log};
use worldd::answers::{self, STATE};
use worldd::loose::{Ends, lives};

const SECOND: Micros = 1_000_000;
/// The test entry's kind and its lifetime loose.
const KIND: &str = "testworld:box";
const LIFE: Micros = 10 * SECOND;

fn name(s: &str) -> Name {
    Name::new(s).expect("a name")
}

fn facts() -> String {
    testworld::generate(1, 0).expect("the test world").text
}

/// The entries: the box lasts [`LIFE`] loose.
fn entries_json() -> String {
    format!(
        "{{\"format\": \"souls-entry/1\", \"kind\": \"{KIND}\", \"owner\": \"thing\", \"loose\": {{\"us\": {LIFE}}}}}"
    )
}

fn soul() -> Id {
    Id::new(Scope([0x5a; 16]), 1).expect("a Soul")
}

fn env(node: Id, sequence: u64, at: Micros, actor: Actor) -> Envelope {
    Envelope {
        sequence,
        at,
        cause: Cause::World,
        actor,
        audience: Audience::Everyone,
        node,
    }
}

fn changes(node: Id, sequence: u64, at: Micros, cs: Vec<Change>) -> Effect {
    Effect {
        envelope: env(node, sequence, at, Actor::Soul(soul())),
        body: Body::Changes(
            cs.into_iter()
                .map(|change| ChangeRec {
                    change,
                    rest: Rest::new(),
                })
                .collect(),
        ),
        events: None,
        rest: Rest::new(),
    }
}

/// A thing of the box's kind made by a Soul at a spot: on the ground at (x m, 0), or in `slot` of `parent`.
fn make(node: Id, kind: &Name, parent: Id, slot: Option<u64>, x_m: i64, ground: Id) -> Change {
    Change::Create {
        node,
        kind: kind.clone(),
        pose: Pose {
            frame: Frame { node: parent, slot },
            position: Vec3::new(if slot.is_some() { 0 } else { x_m * 1_000_000 }, 0, 0),
            orientation: Quat::IDENTITY,
            support: if slot.is_some() {
                Support::Slot
            } else {
                Support::Surface {
                    surface: ground,
                    height: 0,
                }
            },
        },
        audience: Audience::Everyone,
        fields: BTreeMap::new(),
    }
}

fn part(header: &Header, effects: &[Effect]) -> (Vec<u8>, Part) {
    let bytes = encode(&Value::Map(BTreeMap::from([
        (1, Value::Bytes(header.hash().to_bytes())),
        (
            2,
            Value::Array(effects.iter().map(Effect::to_value).collect()),
        ),
    ])))
    .expect("encodes");
    let p = Part::read(&bytes).expect("a part");
    (bytes, p)
}

/// The world as a served world loads it: the tree, its rules, its ground, the box's full kind and a node with plain
/// slots (the hall, its seats).
struct Built {
    tree: Tree,
    rules: Rules,
    header: Header,
    ground: Id,
    root: Id,
    kind: Name,
    hall: Id,
}

fn built(serve_header: bool) -> Built {
    let mut im = import_eden::load(&facts()).expect("loads");
    if serve_header {
        // C30's served header always pins the conversation kind and admits it on open ground.
        let bytes = fixture_bytes(include_str!(
            "../../replica/fixtures/activities/conversation.diag"
        ))
        .expect("the conversation fixture encodes");
        let activity = ActivityKind::from_value(&decode(&bytes).expect("a kind").value)
            .expect("the conversation kind");
        im.rules.kinds.insert(
            activity.name.as_str().to_owned(),
            Kind {
                owner: "activity".into(),
                children: Default::default(),
                slots: Default::default(),
                hands: None,
            },
        );
        // `worldd serve`'s header: the root's kind admitted as R1's replica starts it (serve.rs `build`).
        im.rules.kinds.extend(
            parse_kinds(&format!(
                "{{1: \"souls:place\", 2: \"place\", 11: [\"{}\"]}}",
                import_eden::GROUND
            ))
            .expect("the root's kind"),
        );
        // And a Soul's body kind, admitted on the open ground (C3, serve.rs `build`).
        im.rules.kinds.extend(
            parse_kinds("{1: \"souls:body\", 2: \"family\", 6: {1: [\"thing\"], 2: [\"thing\"]}}")
                .expect("the body's kind"),
        );
        for (k, kind) in im.rules.kinds.iter_mut() {
            if plain(k) == import_eden::GROUND {
                kind.children.insert("body".into());
                kind.children.insert(plain(activity.name.as_str()).into());
            }
        }
    }
    let (root, ground) = (im.nodes["world"], im.nodes["ground"]);
    let header = import_eden::header(root, &im.rules).expect("a header");
    let kind = name(
        im.rules
            .kinds
            .keys()
            .find(|k| plain(k) == KIND)
            .expect("the box's kind"),
    );
    let tree = im.tree;
    let hall = tree
        .children(tree.handle(ground).expect("the ground"))
        .expect("children")
        .iter()
        .filter_map(|h| tree.node(*h))
        .find(|n| plain(n.kind().as_str()) == "testworld:hall")
        .expect("the hall")
        .id();
    Built {
        tree,
        rules: im.rules,
        header,
        ground,
        root,
        kind,
        hall,
    }
}

fn lives_of() -> BTreeMap<String, Micros> {
    let entry = replica::rules::json::parse(&entries_json()).expect("json");
    lives(&replica::rules::json::Value::Obj(vec![(
        KIND.to_owned(),
        entry,
    )]))
}

/// The clock's two calls, on a tree committed to as the world commits: what a tick's commits made loose or kept
/// (step 4), and the ends due (step 1).
struct Tick {
    b: Built,
    ends: Ends,
    next: u64,
    /// Every effect written, in order.
    log: Vec<Effect>,
}

impl Tick {
    fn write(&mut self, mut effects: Vec<Effect>) {
        for e in &mut effects {
            e.envelope.sequence = self.next;
            self.next += 1;
        }
        let (_, p) = part(&self.b.header, &effects);
        self.b
            .tree
            .commit(&self.b.header, &p, &self.b.rules)
            .expect("commits");
        self.log.extend(effects);
    }

    /// A Soul's commit at `now`, then step 4's timers. `unlinking`: read before the commit, as the clock does.
    fn act(&mut self, effects: Vec<Effect>, now: Micros) {
        let unlinked = Ends::unlinking(
            &self.b.tree,
            effects.iter().flat_map(|e| match &e.body {
                Body::Changes(cs) => cs.iter().map(|c| &c.change).collect::<Vec<_>>(),
                _ => Vec::new(),
            }),
        );
        self.write(effects.clone());
        let mut nodes = Ends::touched(&effects);
        nodes.extend(unlinked);
        let timers = self.ends.after(&self.b.tree, nodes, now);
        if !timers.is_empty() {
            self.write(timers);
        }
    }

    /// Ticks of 50 ms from `from` to `to`, each firing the ends due before the next.
    fn run(&mut self, from: Micros, to: Micros) {
        let mut now = from;
        while now < to {
            while let Some(e) = self.ends.next(&self.b.tree, now + 50_000) {
                self.write(vec![e]);
            }
            now += 50_000;
        }
    }

    fn live(&self, n: Id) -> bool {
        self.b.tree.handle(n).is_some()
    }

    fn expired(&self) -> Vec<(Id, Micros)> {
        self.log
            .iter()
            .filter(|e| {
                e.events
                    .iter()
                    .flatten()
                    .any(|ev| ev.name.as_str() == EXPIRED)
            })
            .map(|e| (e.envelope.node, e.envelope.at))
            .collect()
    }
}

#[test]
fn a1_set_down_loose_ends_once_on_time_kept_things_remain() {
    let b = built(false);
    let next = b.tree.to_state().next;
    let ends = Ends::start(&b.tree, lives_of(), b.root, next).expect("ends");
    assert!(!ends.idle(), "the box has a lifetime");
    let (ground, hall, kind) = (b.ground, b.hall, b.kind.clone());
    let mut t = Tick {
        b,
        ends,
        next,
        log: Vec::new(),
    };
    let mut ids = Minter::new(Scope([0x7e; 16]));
    let mut id = || ids.mint().expect("an id");
    let (loose, owned, slotted, link) = (id(), id(), id(), id());
    let at = 1_000 * SECOND;

    // A Soul sets a box down on the ground, makes one it owns, and puts one in a seat's slot: one end, the first's.
    t.act(
        vec![
            changes(
                ground,
                0,
                at,
                vec![make(loose, &kind, ground, None, 3, ground)],
            ),
            changes(
                ground,
                0,
                at,
                vec![make(owned, &kind, ground, None, 5, ground)],
            ),
            changes(
                owned,
                0,
                at,
                vec![Change::Link {
                    link,
                    ty: name(OWNS),
                    ends: [hall, owned],
                    owner: End::Second,
                    audience: Audience::Everyone,
                }],
            ),
            changes(
                hall,
                0,
                at,
                vec![make(slotted, &kind, hall, Some(1), 0, ground)],
            ),
        ],
        at,
    );
    assert_eq!(t.ends.pending(), 1, "only the loose box has an end");
    assert_eq!(t.ends.due(loose), Some(at + LIFE));
    let timers = t
        .log
        .iter()
        .filter(|e| matches!(&e.body, Body::Timers(_)))
        .count();
    assert_eq!(timers, 1, "one timer entry, in the set-down's tick");

    // The owner lets the second go 2 s later (an unlink): it is loose from then.
    let unlink_at = at + 2 * SECOND;
    t.act(
        vec![changes(owned, 0, unlink_at, vec![Change::Unlink { link }])],
        unlink_at,
    );
    assert_eq!(t.ends.due(owned), Some(unlink_at + LIFE));

    // Ten lifetimes, ticked: each loose box ends once at its due time; the slotted one remains.
    t.run(at, at + 10 * LIFE);
    let got = t.expired();
    println!("A1: ends {got:?}");
    assert_eq!(got, vec![(loose, at + LIFE), (owned, unlink_at + LIFE)]);
    assert!(!t.live(loose) && !t.live(owned), "both loose boxes gone");
    assert!(t.live(slotted), "the box in a slot remains");
    assert_eq!(t.ends.pending(), 0);
    assert!(
        t.b.tree.timers().values().all(|x| x.name.as_str() != ENDS),
        "no end left in the state"
    );
}

// --- A real `worldd serve` ------------------------------------------------------------------------------------------

fn worldd() -> Command {
    Command::new(env!("CARGO_BIN_EXE_worldd"))
}

struct Served {
    child: Child,
    lines: Receiver<String>,
}

fn serve(dir: &Path, socket: &Path) -> Served {
    let mut child = worldd()
        .args(["serve", "--dir"])
        .arg(dir)
        .arg("--socket")
        .arg(socket)
        .args(["--checkpoint-every", "2048"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("worldd serve starts");
    let (tx, lines) = channel();
    let out = child.stdout.take().expect("stdout");
    let err = child.stderr.take().expect("stderr");
    for pipe in [Box::new(out) as Box<dyn Read + Send>, Box::new(err)] {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for l in BufReader::new(pipe).lines().map_while(Result::ok) {
                let _ = tx.send(l);
            }
        });
    }
    Served { child, lines }
}

impl Served {
    // A real process on the real clock: the wait for its line is real time.
    #[allow(clippy::disallowed_methods)]
    fn line(&self, prefix: &str) -> String {
        let end = Instant::now() + Duration::from_secs(60);
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match self.lines.recv_timeout(left) {
                Ok(l) if l.starts_with(prefix) => return l,
                Ok(l) => println!("  {l}"),
                Err(_) => break,
            }
        }
        panic!("no line {prefix:?}");
    }

    fn kill(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Sleeps until world time `t` (the machine's clock, as `worldd serve`'s).
fn until(t: Micros) {
    let left = t - answers::now();
    if left > 0 {
        std::thread::sleep(Duration::from_micros(left as u64));
    }
}

/// Every record of the log, and each world's end in it: (node, at).
fn logged(log: &Path) -> (Vec<Vec<u8>>, Vec<(Id, Micros)>) {
    let (l, found) = Log::open(FileStore::open(log).expect("the log"), 1).expect("opens");
    drop(l.close());
    let mut ends = Vec::new();
    for r in &found.records {
        let Ok(p) = Part::read(r) else { continue };
        for e in &p.effects {
            if e.events
                .iter()
                .flatten()
                .any(|ev| ev.name.as_str() == EXPIRED)
            {
                ends.push((e.envelope.node, e.envelope.at));
            }
        }
    }
    (found.records, ends)
}

fn last_state(records: &[Vec<u8>]) -> String {
    records
        .iter()
        .rev()
        .find_map(|r| match Part::read(r).ok()?.rest.get(&STATE) {
            Some(Value::Bytes(h)) => Some(replica::encode::to_hex(h)),
            _ => None,
        })
        .expect("a tick with a state hash")
}

fn scratch() -> PathBuf {
    let d = std::env::temp_dir().join(format!("f10b-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("a scratch folder");
    d
}

#[test]
fn a1_a2_a3_served_world_ends_a_set_down_thing_once_across_a_restart() {
    let d = scratch();
    let facts = d.join("facts.json");
    std::fs::write(&facts, self::facts()).expect("facts");
    let entries = d.join("entries");
    std::fs::create_dir_all(&entries).expect("entries");
    std::fs::write(entries.join("box.json"), entries_json()).expect("the entry");
    let dir = d.join("w");
    let out = worldd()
        .args(["seed", "--facts"])
        .arg(&facts)
        .arg("--dir")
        .arg(&dir)
        .arg("--entries")
        .arg(&entries)
        .args(["--souls", "1", "--at", "-40,30"])
        .output()
        .expect("seed runs");
    assert!(
        out.status.success(),
        "seed: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    // The world as `worldd serve` replays it, then a Soul's set-down and the timer its commit writes (step 4's call),
    // appended as the world logs a tick's part.
    let b = built(true);
    let mut world = Replica::start(b.header.stored()).expect("a replica");
    let (store_log, found) =
        Log::open(FileStore::open(&dir.join("log")).expect("the log"), 1).expect("opens");
    for r in &found.records {
        world
            .apply(&Part::read(r).expect("a part"))
            .expect("applies");
    }
    let thing = Minter::new(Scope([0x7e; 16])).mint().expect("an id");
    let at = answers::now();
    let set_down = changes(
        b.ground,
        world.version(),
        at,
        vec![make(thing, &b.kind, b.ground, None, 3, b.ground)],
    );
    let (bytes, p) = part(&b.header, std::slice::from_ref(&set_down));
    world.apply(&p).expect("the set-down applies");
    let mut ends = Ends::start(world.tree(), lives_of(), b.root, world.version()).expect("ends");
    let mut timers = ends.after(world.tree(), Ends::touched(&[set_down]), at);
    assert_eq!(timers.len(), 1, "the set-down's commit writes one timer");
    timers[0].envelope.sequence = world.version();
    let (timer_bytes, _) = part(&b.header, &timers);
    let mut store_log = store_log;
    store_log.append(bytes).expect("appended");
    let n = store_log.append(timer_bytes).expect("appended");
    store_log.wait_durable(n + 1).expect("durable");
    drop(store_log.close());
    let due = at + LIFE;

    // A2: served, then killed before the end.
    let socket = d.join("s");
    let w = serve(&dir, &socket);
    println!("{}", w.line("restart: "));
    println!("{}", w.line("worldd: started at tick"));
    until(at + 3 * SECOND);
    w.kill();
    let (_, before) = logged(&dir.join("log"));
    assert!(before.is_empty(), "not ended before its time: {before:?}");

    // Served again: the end is rebuilt from the tree's timers and fires once, at its due time.
    let w = serve(&dir, &socket);
    let restart = w.line("restart: ");
    println!("A2: {restart}");
    println!("{}", w.line("worldd: started at tick"));
    until(due + 2 * SECOND);
    w.kill();
    let (records, got) = logged(&dir.join("log"));
    println!("A1/A2: set down at {at}, due {due}; ends {got:?}");
    assert_eq!(got, vec![(thing, due)], "one end, at set-down + lifetime");

    // A3: the log replayed onto the world as built gives a tree without the thing and no end pending: the end is in
    // the log, not recomputed. A third start writes no second end, and starts at the last logged state.
    let mut replay = Replica::start(b.header.stored()).expect("a replica");
    for r in &records {
        if sim::recorder::is_input(r) {
            continue;
        }
        let p = Part::read(r).expect("a part");
        if !p.effects.is_empty() {
            replay.apply(&p).expect("replays");
        }
    }
    assert!(replay.tree().handle(thing).is_none(), "the thing is gone");
    assert!(
        replay
            .tree()
            .timers()
            .values()
            .all(|t| t.name.as_str() != ENDS),
        "no end pending"
    );
    let state = last_state(&records);
    let w = serve(&dir, &socket);
    println!("{}", w.line("restart: "));
    let started = w.line("worldd: started at tick");
    println!("A3: last logged state {state}; {started}");
    assert!(started.ends_with(&format!("state {state}")), "{started}");
    std::thread::sleep(Duration::from_secs(1));
    w.kill();
    let (_, after) = logged(&dir.join("log"));
    assert_eq!(after, vec![(thing, due)], "still one end");
    let _ = std::fs::remove_dir_all(&d);
}
