//! The words path (Engine v2 V1b, #3361): each `aN_` test is one acceptance box. A3 and the page's half of A4 are
//! `v2/web/src/source/words.test.ts`, against `worldd gateway-link --www`. A turn into an activity is E26a's (#3504).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use replica::audience::{REFERENCE, references};
use replica::effects::{Actor, Body, Change, Part, Refusal, read_id};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, Minter, Scope, Version};
use replica::intents::{Intent, Target};
use replica::pose::{Frame, Pose, Quat, Support, Vec3};
use replica::speech::{SAID, Said};
use replica::stream::StreamPart;
use replica::views::{Key, Level, Redactions};
use replica::world_model::{Audience, End, show};
use sim::log::{Mem, recover};
use sim::text::{Grade, Store};
use worldd::answers::{self, Config};
use worldd::checkers::toggles;
use worldd::view_out::{Writer, follow};
use worldd::views::Tier;
use worldd::words::{self, DESCRIPTION, NAME};

const LINEAGE: Scope = Scope([0x3b; 16]);

fn n(s: &str) -> Name {
    Name::new(s).unwrap()
}

fn words(w: &str) -> Value {
    Value::Map([(words::WORDS, Value::Bytes(w.as_bytes().to_vec()))].into())
}

fn intent(
    body: Id,
    verb: &str,
    target: Option<Id>,
    sequence: u64,
    params: &[(u64, Value)],
) -> Intent {
    Intent {
        actor: Actor::Soul(body),
        verb: n(verb),
        target: target.map(Target::Node),
        parameters: params.iter().cloned().collect(),
        sequence,
        basis: Version {
            lineage: LINEAGE,
            zone: Id::new(LINEAGE, 0).unwrap(),
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        expiry: answers::now() + 60_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    }
}

fn send(w: &answers::World, i: &Intent) -> Receiver<Vec<u8>> {
    let (reply, rx) = channel();
    assert!(w.door().arrive(encode(&i.to_value()).unwrap(), reply));
    rx
}

/// The answer's kind: 1 a receipt, 2 a refusal (with its reason).
fn kind(rx: &Receiver<Vec<u8>>) -> (u64, String) {
    let f = rx.recv_timeout(Duration::from_secs(30)).expect("an answer");
    let Value::Map(m) = decode(&f).unwrap().value else {
        panic!("a frame")
    };
    let Some(Value::Map(a)) = m.get(&2) else {
        panic!("an answer")
    };
    let Some(Value::Uint(k)) = a.get(&3) else {
        panic!("a kind")
    };
    (*k, format!("{a:?}"))
}

fn has(hay: &[u8], needle: &str) -> bool {
    hay.windows(needle.len()).any(|w| w == needle.as_bytes())
}

type Following = Arc<Mutex<Option<JoinHandle<Result<Writer, Refusal>>>>>;

struct Run {
    log: Mem,
    store: Arc<Store>,
    stop: Arc<AtomicBool>,
    writer: Following,
    pairs: Vec<(Id, Id)>,
    world: answers::World,
}

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("worldd-words-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A toggles world with a text store, followed by the view tier and a public stream writer with its text files.
fn run(name: &str) -> Run {
    run_with(name, |_| {})
}

/// [`run`], the world changed by `prep` before it starts.
fn run_with(name: &str, prep: impl FnOnce(&mut toggles::World)) -> Run {
    let d = dir(name);
    let mut built = toggles::World::build(1, 3, 0);
    prep(&mut built);
    let pairs = built.pairs.clone();
    let header = built.replica.header().clone();
    let start = built.replica.tree().to_state();
    let key = Key {
        node: start.root,
        level: Level::Full,
        audience: Audience::Everyone,
    };
    let store = Arc::new(
        Store::open_dir(&d.join("text"), Minter::new(words::scope(LINEAGE))).expect("a store"),
    );
    let www = d.join("www");
    let stop = Arc::new(AtomicBool::new(false));
    let writer: Following = Arc::default();
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.tick = Duration::from_millis(10);
    cfg.measures = false;
    cfg.text = Some(store.clone());
    let (s, wr, root, st) = (stop.clone(), writer.clone(), www.clone(), store.clone());
    cfg.follow = Some(Box::new(move |durable| {
        let tier = Tier::start(
            header.clone(),
            start.clone(),
            Redactions::default(),
            durable,
        )
        .unwrap();
        let sub = tier.subscribe(vec![key], 1 << 16);
        let w = Writer::fork_with_text(&root, &header, &key, (0, 0), &start, Some(st)).unwrap();
        *wr.lock().unwrap() = Some(follow(w, sub, s, answers::now));
        Box::new(move |n, b| tier.offer(n, b))
    }));
    let log = Mem::default();
    let world = answers::start(built.replica, toggles::rules(), log.clone(), cfg).expect("starts");
    Run {
        log,
        store,
        stop,
        writer,
        pairs,
        world,
    }
}

impl Run {
    /// Stops the world, then the writer once it has read every tick: its stream's directory.
    fn end(self, before_flush: impl FnOnce(&Store, &[Said])) -> (Vec<u8>, PathBuf) {
        self.world.stop();
        let log = self.log.0.lock().unwrap().bytes.clone();
        before_flush(&self.store, &said(&log));
        self.stop.store(true, Ordering::Relaxed);
        let w = self
            .writer
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .join()
            .unwrap()
            .unwrap();
        (log, w.dir().to_path_buf())
    }
}

/// Every utterance in the log, in order.
fn said(log: &[u8]) -> Vec<Said> {
    let mut out = Vec::new();
    // The recorder's input records (K12) are what the world was handed, not parts: passed by.
    for r in recover(log).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        for e in Part::read(&r).unwrap().effects {
            for ev in e
                .events
                .iter()
                .flatten()
                .filter(|ev| ev.name.as_str() == SAID)
            {
                let v = Value::Map(BTreeMap::from([
                    (1, Value::Text(ev.name.clone())),
                    (2, Value::Map(ev.fields.clone())),
                ]));
                out.push(Said::read(&v, e.envelope.audience).unwrap());
            }
        }
    }
    out
}

/// The `[reference, words]` rows of every text file, and every part's unpacked T6 bytes.
fn stream_files(dir: &Path) -> (Vec<(Id, String)>, Vec<Vec<u8>>, usize) {
    let (mut text, mut parts, mut files) = (Vec::new(), Vec::new(), 0);
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let name = e.file_name().into_string().unwrap();
        let bytes = std::fs::read(e.path()).unwrap();
        if let Some(n) = name.strip_suffix(".text") {
            assert!(dir.join(n).exists(), "a text file beside part {n}");
            files += 1;
            let Value::Array(rows) = decode(&bytes).unwrap().value else {
                panic!("a text file is a list")
            };
            for r in rows {
                let Value::Array(p) = r else { panic!("a row") };
                let Value::Bytes(w) = &p[1] else {
                    panic!("words")
                };
                text.push((
                    read_id(&p[0]).unwrap(),
                    String::from_utf8(w.clone()).unwrap(),
                ));
            }
        } else if name.parse::<u64>().is_ok() {
            parts.push(StreamPart::read(&bytes).unwrap().part);
        }
    }
    assert_eq!(files, parts.len(), "one text file beside each part");
    (text, parts, files)
}

#[test]
fn a1_words_are_kept_and_only_their_reference_logged() {
    let r = run("a1");
    let (b0, b1, lamp) = (r.pairs[0].0, r.pairs[1].0, r.pairs[0].1);
    let lines = [
        "the bread is still warm",
        "meet me by the well at noon",
        "Oriel",
        "keeps the lamps of the east room",
        "a note on the lamp",
    ];
    let w = &r.world;
    let asks = [
        intent(b0, "eden:say", None, 1, &[(1, words(lines[0]))]),
        intent(b0, "eden:whisper", Some(b1), 2, &[(1, words(lines[1]))]),
        intent(
            b0,
            "eden:describe",
            None,
            3,
            &[(1, words(lines[2])), (2, words(lines[3]))],
        ),
        intent(b0, "r2:switch_on", Some(lamp), 4, &[(1, words(lines[4]))]),
    ];
    for i in &asks {
        let (k, a) = kind(&send(w, i));
        assert_eq!(k, 1, "{}: a receipt, not {a}", i.verb.as_str());
    }
    let (log, _) = r.end(|store, said| {
        assert_eq!(said.len(), 2, "a say and a whisper");
        assert_eq!(store.read(said[0].words, &[]).unwrap(), lines[0].as_bytes());
        assert_eq!(said[0].audience, Audience::Everyone);
        assert_eq!(
            said[1].audience,
            Audience::Of(b1),
            "a whisper is its listener's"
        );
        assert_eq!(
            store.read(said[1].words, &[]).unwrap_err().name,
            "not-entitled"
        );
        assert_eq!(
            store.read(said[1].words, &[b1]).unwrap(),
            lines[1].as_bytes()
        );
    });
    for l in lines {
        assert!(!has(&log, l), "{l:?} is not in the log");
    }
    // The describe set the body's name and description as references; the toggle's words are its sender's.
    let mut fields = BTreeMap::new();
    let mut logged_refs = Vec::new();
    for rec in recover(&log).unwrap().records {
        if sim::recorder::is_input(&rec) {
            continue;
        }
        let p = Part::read(&rec).unwrap();
        logged_refs.extend(references(&Value::Map(p.rest.clone())));
        for e in p.effects {
            if let Body::Changes(cs) = e.body {
                for c in cs {
                    if let Change::Set {
                        node, field, to, ..
                    } = c.change
                        && node == b0
                    {
                        fields.insert(field, to);
                    }
                }
            }
        }
    }
    let refd = |f| match fields.get(&f) {
        Some(Value::Map(m)) => read_id(&m[&REFERENCE]).unwrap(),
        other => panic!("field {f}: {other:?}"),
    };
    assert!(logged_refs.contains(&refd(NAME)) && logged_refs.contains(&refd(DESCRIPTION)));
    assert_eq!(
        logged_refs.len(),
        5,
        "every intent logged with its references"
    );
    assert!(!has(&log, "intent.text-not-stored"));
}

#[test]
fn a2_a4_public_words_beside_each_part_and_no_whisper() {
    let r = run("a2");
    let (b0, b1) = (r.pairs[0].0, r.pairs[1].0);
    let (public, whisper, hidden) = (
        "see you at the dance tonight",
        "the key is under the third stone",
        "a sentence someone removed",
    );
    let w = &r.world;
    for (s, i) in [
        intent(b0, "eden:say", None, 1, &[(1, words(public))]),
        intent(b1, "eden:whisper", Some(b0), 1, &[(1, words(whisper))]),
        intent(b1, "eden:say", None, 2, &[(1, words(hidden))]),
        intent(
            b1,
            "eden:describe",
            None,
            3,
            &[(1, words("Wren")), (2, words("tends the well"))],
        ),
    ]
    .iter()
    .enumerate()
    {
        assert_eq!(kind(&send(w, i)).0, 1, "intent {s} answered with a receipt");
        // The hidden sentence is removed as soon as its say is answered (its record is on the disk by then), before
        // the next intent: the writer cuts a stretch when a record of a later 500 ms period arrives, so a removal left
        // until the end raced the describe's record, which could close the say's stretch first and write its text
        // file before the removal (seen once under CI load, #3443). Removed here, every text file is written after
        // it, and the writer reads the store when it writes the file.
        if s == 2 {
            let log = r.log.0.lock().unwrap().bytes.clone();
            let said = said(&log);
            assert_eq!(
                said.len(),
                3,
                "the public say, the whisper and the hidden say"
            );
            r.store.remove(said[2].words, b1, 0, Grade::Hidden).unwrap();
        }
    }
    let mut whisper_ref = None;
    let (_, dir) = r.end(|_, said| {
        whisper_ref = Some(said[1].words);
    });
    let (text, parts, files) = stream_files(&dir);
    assert!(files >= 1);
    let all: Vec<&str> = text.iter().map(|(_, w)| w.as_str()).collect();
    assert!(all.contains(&public), "{all:?}");
    assert!(
        all.contains(&"Wren") && all.contains(&"tends the well"),
        "A4: name and description: {all:?}"
    );
    assert!(!all.contains(&whisper), "a whisper is in no public file");
    assert!(!all.contains(&hidden), "a removed sentence is in no file");
    let wr = encode(&whisper_ref.unwrap().to_value()).unwrap();
    for p in &parts {
        assert!(
            !p.windows(wr.len()).any(|x| x == wr),
            "the whisper's reference is in no public part"
        );
        for l in [public, whisper, hidden] {
            assert!(!has(p, l), "no words in a part");
        }
    }
}

/// The ids a running world's text store holds words of, by reading its files: whether `words` is on its disk.
fn in_store(dir: &Path, words: &str) -> bool {
    std::fs::read_dir(dir.join("text"))
        .unwrap()
        .flatten()
        .any(|e| has(&std::fs::read(e.path()).unwrap_or_default(), words))
}

/// E26a (#3504): a `say` into an activity (its target) is written in an entry of the activity's audience, heard by
/// its members' bodies and its words kept for its members alone (A1); one by a Soul that is not a member is refused
/// `not-a-member` and writes nothing, in the log or the store (A3); neither is in the public stream a viewer replays
/// (A2).
#[test]
fn e26a_a_turn_into_an_activity_is_its_members_alone() {
    let act = Id::new(Scope([0x5a; 16]), 1).unwrap();
    let r = run_with("e26a", |built| {
        let (b0, b1, lamp) = (built.pairs[0].0, built.pairs[1].0, built.pairs[0].1);
        let tree = built.replica.tree();
        let node = |id| tree.node(tree.handle(id).unwrap()).unwrap();
        // A node standing for an activity (its kind is not read; the lamp's is in the header), and two members.
        let (kind, room) = (node(lamp).kind().clone(), node(b0).parent().unwrap());
        let create = Change::Create {
            node: act,
            kind,
            pose: Pose {
                frame: Frame {
                    node: room,
                    slot: None,
                },
                position: Vec3::new(0, 0, 0),
                orientation: Quat::IDENTITY,
                support: Support::Surface {
                    surface: room,
                    height: 0,
                },
            },
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        };
        let member = |k, body| Change::Link {
            link: Id::new(Scope([0x5a; 16]), k).unwrap(),
            ty: n("souls:member"),
            ends: [body, act],
            owner: End::Second,
            audience: Audience::Everyone,
        };
        let part = built.part(vec![
            (room, create),
            (act, member(2, b0)),
            (act, member(3, b1)),
        ]);
        built.replica.apply(&part).expect("the activity applies");
    });
    let (b0, b1, b2) = (r.pairs[0].0, r.pairs[1].0, r.pairs[2].0);
    let (turn, refused, public) = (
        "let us keep this between us",
        "may I listen in",
        "good morning all",
    );
    let w = &r.world;
    let (k, a) = kind(&send(
        w,
        &intent(b0, "eden:say", Some(act), 1, &[(1, words(turn))]),
    ));
    assert_eq!(k, 1, "a member's turn: a receipt, not {a}");
    let (k, a) = kind(&send(
        w,
        &intent(b2, "eden:say", Some(act), 1, &[(1, words(refused))]),
    ));
    assert_eq!(k, 2, "a non-member's turn is refused: {a}");
    assert!(a.contains("not-a-member"), "by name: {a}");
    let (k, a) = kind(&send(
        w,
        &intent(b0, "eden:say", None, 2, &[(1, words(public))]),
    ));
    assert_eq!(k, 1, "a public say: a receipt, not {a}");
    let store_dir = std::env::temp_dir().join(format!("worldd-words-{}-e26a", std::process::id()));
    let mut turn_ref = None;
    let (log, www) = r.end(|store, said| {
        println!(
            "E26a: the log holds {} utterances; the turn's audience {}'s (the activity), heard by {} bodies (both \
             members); the public say's {:?}",
            said.len(),
            show(act),
            said[0].hearers.len(),
            said[1].audience
        );
        assert_eq!(said.len(), 2, "the turn and the public say: the refused turn wrote nothing");
        assert_eq!(said[0].audience, Audience::Of(act), "A1: the activity's audience");
        assert_eq!(said[0].hearers, [b0, b1].into(), "A1: its members' bodies");
        assert_eq!(said[1].audience, Audience::Everyone);
        assert_eq!(store.read(said[0].words, &[]).unwrap_err().name, "not-entitled");
        assert_eq!(store.read(said[0].words, &[b2]).unwrap_err().name, "not-entitled");
        assert_eq!(store.read(said[0].words, &[act]).unwrap(), turn.as_bytes());
        turn_ref = Some(said[0].words);
    });
    assert!(
        in_store(&store_dir, turn),
        "the store holds the member's turn"
    );
    assert!(
        !in_store(&store_dir, refused),
        "A3: no word of the refused turn is kept"
    );
    for l in [turn, refused] {
        assert!(!has(&log, l), "{l:?} is not in the log");
    }
    // The public stream a viewer reads and replays: the public say, never the turn or its reference.
    let (text, parts, _) = stream_files(&www);
    let all: Vec<&str> = text.iter().map(|(_, w)| w.as_str()).collect();
    assert!(all.contains(&public), "{all:?}");
    assert!(!all.contains(&turn) && !all.contains(&refused), "{all:?}");
    let tr = encode(&turn_ref.unwrap().to_value()).unwrap();
    for p in &parts {
        assert!(
            !p.windows(tr.len()).any(|x| x == tr),
            "the turn's reference is in no public part"
        );
        assert!(!has(p, turn) && !has(p, refused));
    }
    println!(
        "E26a: the public stream ({} parts) holds {all:?}: neither the turn nor the refused one",
        parts.len()
    );
}

/// C26 (#3689, A1): a shout is a say at a raised voice's reach: answered with a receipt, written in the public
/// audience at [`words::SHOUT_REACH_MM`], its words kept and only their reference logged.
#[test]
fn c26_a_shout_is_public_at_a_raised_voice() {
    let r = run("c26");
    let b0 = r.pairs[0].0;
    let lines = ["the bridge is out", "anyone for bread"];
    let asks = [
        intent(b0, "eden:shout", None, 1, &[(1, words(lines[0]))]),
        intent(b0, "eden:say", None, 2, &[(1, words(lines[1]))]),
    ];
    for i in &asks {
        let (k, a) = kind(&send(&r.world, i));
        assert_eq!(k, 1, "{}: a receipt, not {a}", i.verb.as_str());
    }
    let (log, _) = r.end(|store, said| {
        assert_eq!(said.len(), 2, "a shout and a say");
        assert_eq!(said[0].audience, Audience::Everyone, "a shout is public");
        assert_eq!(said[0].reach_mm, words::SHOUT_REACH_MM);
        assert_eq!(said[1].reach_mm, words::SAY_REACH_MM);
        assert!(
            said[0].reach_mm > said[1].reach_mm,
            "a shout carries farther"
        );
        assert_eq!(store.read(said[0].words, &[]).unwrap(), lines[0].as_bytes());
    });
    for l in lines {
        assert!(!has(&log, l), "{l:?} is not in the log");
    }
}

/// Every file of a stream's folder but its text files, by name: what a removal never changes.
fn not_text(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| (e.file_name().into_string().unwrap(), e.path()))
        .filter(|(n, _)| !n.ends_with(".text"))
        .map(|(n, p)| (n, std::fs::read(p).unwrap()))
        .collect()
}

/// W7 (#2826): one person's words go from the store and every text file of the stream, by time and then all of them;
/// the other person's words, the log and the parts stay as they were; a dry run counts and changes nothing; each
/// removal is on the list with who asked and when, never the words.
#[test]
fn w7_one_persons_words_go_from_the_store_and_the_stream_and_the_rest_stays() {
    use std::collections::BTreeSet;
    use worldd::removal::{self, Ask};
    let r = run("w7");
    let folder = std::env::temp_dir().join(format!("worldd-words-{}-w7", std::process::id()));
    let (a, b) = (r.pairs[0].0, r.pairs[1].0);
    let lines = [
        "the bread is still warm",
        "the well is dry at noon",
        "meet me at the mill",
    ];
    for (body, seq, line) in [(a, 1, lines[0]), (b, 1, lines[1]), (a, 2, lines[2])] {
        let i = intent(body, "eden:say", None, seq, &[(1, words(line))]);
        let (k, answer) = kind(&send(&r.world, &i));
        assert_eq!(k, 1, "a receipt, not {answer}");
    }
    let store = r.store.clone();
    let (log, dir) = r.end(|_, _| {});
    let said = said(&log);
    let refs: Vec<Id> = said.iter().map(|s| s.words).collect();
    assert_eq!(refs.len(), 3);
    let mut at = BTreeMap::new();
    let records: Vec<Vec<u8>> = recover(&log).unwrap().records;
    for rec in records.iter().filter(|r| !sim::recorder::is_input(r)) {
        for e in Part::read(rec).unwrap().effects {
            for ev in e
                .events
                .iter()
                .flatten()
                .filter(|ev| ev.name.as_str() == SAID)
            {
                let v = Value::Map(BTreeMap::from([
                    (1, Value::Text(ev.name.clone())),
                    (2, Value::Map(ev.fields.clone())),
                ]));
                at.insert(
                    Said::read(&v, e.envelope.audience).unwrap().words,
                    e.envelope.at,
                );
            }
        }
    }
    let words_now =
        |dir: &Path| -> Vec<String> { stream_files(dir).0.into_iter().map(|(_, w)| w).collect() };
    assert_eq!(
        words_now(&dir)
            .iter()
            .filter(|w| lines.contains(&w.as_str()))
            .count(),
        3
    );
    let (parts, text_before) = (not_text(&dir), words_now(&dir));
    let asker = Id::new(Scope([0x77; 16]), 1).unwrap();
    let ask = |grade, range, dry_run| Ask {
        authors: BTreeSet::from([a]),
        range,
        grade,
        by: asker,
        when_us: 1_000,
        dry_run,
    };

    // By time: the first sentence's moment holds A's first say, not their second.
    let (from, to) = (at[&refs[0]], at[&refs[0]] + 1);
    let first = removal::in_range(&records, from, to).unwrap();
    assert!(first.contains(&refs[0]) && !first.contains(&refs[2]) && !first.contains(&refs[1]));
    let dry = removal::remove(
        &store,
        &dir,
        &ask(Grade::Hidden, Some((from, to)), true),
        Some(&first),
    )
    .unwrap();
    assert_eq!((dry.found, dry.already, dry.changed), (1, 0, 1));
    assert!(dry.files >= 1 && dry.rows >= 1, "{dry:?}");
    assert_eq!(words_now(&dir), text_before, "a dry run writes nothing");
    assert_eq!(store.read(refs[0], &[]).unwrap(), lines[0].as_bytes());
    assert!(store.removals().is_empty());
    let done = removal::remove(
        &store,
        &dir,
        &ask(Grade::Hidden, Some((from, to)), false),
        Some(&first),
    )
    .unwrap();
    assert_eq!(done, dry, "the dry run counted what went");
    assert_eq!(store.read(refs[0], &[]).unwrap_err().name, "removed");
    assert_eq!(store.read(refs[2], &[]).unwrap(), lines[2].as_bytes());
    let now = words_now(&dir);
    assert!(!now.contains(&lines[0].to_owned()), "{now:?}");
    assert!(now.contains(&lines[1].to_owned()) && now.contains(&lines[2].to_owned()));

    // All of A's words, erased: gone from the store's disk too; B's words, the parts and the log as they were.
    let all = removal::remove(&store, &dir, &ask(Grade::Erased, None, false), None).unwrap();
    assert_eq!((all.found, all.already, all.changed), (2, 0, 2));
    for r in [refs[0], refs[2]] {
        assert_eq!(store.read(r, &[]).unwrap_err().name, "removed");
    }
    assert_eq!(store.read(refs[1], &[]).unwrap(), lines[1].as_bytes());
    let now = words_now(&dir);
    assert!(
        !now.contains(&lines[0].to_owned()) && !now.contains(&lines[2].to_owned()),
        "{now:?}"
    );
    assert!(now.contains(&lines[1].to_owned()));
    assert!(
        !in_store(&folder, lines[0]) && !in_store(&folder, lines[2]),
        "erased bytes are deleted"
    );
    assert!(in_store(&folder, lines[1]));
    assert_eq!(not_text(&dir), parts, "no part changes");
    assert_eq!(said(&log).len(), 3, "the log is untouched");
    for l in lines {
        assert!(!has(&log, l));
    }
    // The record: each change, who asked and when, never the words.
    let list = store.removals();
    assert_eq!(
        list.iter()
            .map(|x| (x.reference, x.by, x.when_us, x.grade))
            .collect::<Vec<_>>(),
        vec![
            (refs[0], asker, 1_000, Grade::Hidden),
            (refs[0], asker, 1_000, Grade::Erased),
            (refs[2], asker, 1_000, Grade::Erased),
        ]
    );
    let removed_file = std::fs::read(folder.join("text").join("removed")).unwrap();
    assert!(lines.iter().all(|l| !has(&removed_file, l)));
    // Erased words stay erased: a restore changes nothing.
    let back = removal::remove(&store, &dir, &ask(Grade::Restored, None, false), None).unwrap();
    assert_eq!((back.found, back.already, back.changed), (2, 2, 0));
}

/// W7 (#2826): `worldd remove-words` on a world's folder: refused while the world holds its store, a dry run that
/// changes no byte, then the erase, its text file written again without the person's rows.
#[test]
fn w7_the_command_on_a_stopped_world_only() {
    let folder = dir("w7-command");
    let built = toggles::World::build(1, 3, 0);
    let header = built.replica.header().clone();
    std::fs::write(folder.join("header"), header.stored()).unwrap();
    let (a, b) = (built.pairs[0].0, built.pairs[1].0);
    let text = |a_line: &str| {
        Store::open_dir(
            &folder.join("log.text"),
            Minter::new(words::scope(header.lineage)),
        )
        .unwrap()
        .write(a_line.as_bytes(), Audience::Everyone, a)
        .unwrap()
    };
    let gone = text("a line to go");
    let store = Store::open_dir(
        &folder.join("log.text"),
        Minter::new(words::scope(header.lineage)),
    )
    .unwrap();
    let kept = store
        .write(b"a line to keep", Audience::Everyone, b)
        .unwrap();
    let stream = folder.join("views").join("s");
    std::fs::create_dir_all(&stream).unwrap();
    let row =
        |r: Id, w: &str| Value::Array(vec![r.to_value(), Value::Bytes(w.as_bytes().to_vec())]);
    let file = encode(&Value::Array(vec![
        row(gone, "a line to go"),
        row(kept, "a line to keep"),
    ]))
    .unwrap();
    std::fs::write(stream.join("0.text"), &file).unwrap();
    let id = |i: Id| format!("{}-{}", replica::encode::to_hex(&i.scope().0), i.counter());
    let args = |more: &[&str]| -> Vec<String> {
        [
            "worldd",
            "remove-words",
            folder.to_str().unwrap(),
            "--author",
            &id(a),
            "--by",
            &id(b),
        ]
        .iter()
        .chain(more)
        .map(|s| s.to_string())
        .collect()
    };
    let bytes = |p: &Path| std::fs::read(p).unwrap();
    let before = (
        bytes(&stream.join("0.text")),
        bytes(&folder.join("log.text/text")),
        bytes(&folder.join("log.text/removed")),
    );
    // The world holds the store: refused, nothing touched.
    assert_eq!(worldd::removal::run(&args(&["--erase"])), 2);
    store.close();
    let now = || {
        (
            bytes(&stream.join("0.text")),
            bytes(&folder.join("log.text/text")),
            bytes(&folder.join("log.text/removed")),
        )
    };
    assert_eq!(now(), before);
    assert_eq!(worldd::removal::run(&args(&["--erase", "--dry-run"])), 0);
    assert_eq!(now(), before, "a dry run changes no byte");
    assert_eq!(
        worldd::removal::run(&args(&["--from", "5"])),
        2,
        "--from needs --to"
    );
    assert_eq!(worldd::removal::run(&args(&["--erase"])), 0);
    let Value::Array(rows) = decode(&bytes(&stream.join("0.text"))).unwrap().value else {
        panic!("a text file is a list")
    };
    assert_eq!(rows, vec![row(kept, "a line to keep")]);
    assert!(!has(&bytes(&folder.join("log.text/text")), "a line to go"));
    let store = Store::open_dir(
        &folder.join("log.text"),
        Minter::new(words::scope(header.lineage)),
    )
    .unwrap();
    assert_eq!(store.read(gone, &[]).unwrap_err().name, "removed");
    assert_eq!(store.read(kept, &[]).unwrap(), b"a line to keep");
    assert_eq!(store.removals().len(), 1);
    assert_eq!(store.removals()[0].by, b);
}
