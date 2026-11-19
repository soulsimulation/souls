//! The words path (Engine v2 V1b, #3361): each `aN_` test is one acceptance box. A3 and the page's half of A4 are
//! `v2/web/src/source/words.test.ts`, against `worldd gateway-link --www`.

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
use replica::speech::{SAID, Said};
use replica::stream::StreamPart;
use replica::views::{Key, Level, Redactions};
use replica::world_model::Audience;
use sim::log::{Mem, recover};
use sim::text::{Grade, Store};
use worldd::answers::{self, Config};
use worldd::checkers::toggles;
use worldd::view_out::{Writer, follow};
use worldd::views::Tier;
use worldd::words::{self, DESCRIPTION, NAME};

const LINEAGE: Scope = Scope([0x3b; 16]);
/// A fixed world time: every entry falls in one stretch, so the stream is written whole at the end.
const AT: i64 = 1_000_000_000;

/// World time from [`AT`], carried on by the monotonic clock, so the intents' expiries hold whenever the test runs.
struct FromAt(std::time::Instant);

impl FromAt {
    // The test's pace reads the machine's monotonic clock, as worldd's own `Real` does.
    #[allow(clippy::disallowed_methods)]
    fn start() -> FromAt {
        FromAt(std::time::Instant::now())
    }
}

impl sim::clock::Clock for FromAt {
    // The test paces real time from AT, as worldd's own `Real` paces it from the Unix epoch.
    #[allow(clippy::disallowed_methods)]
    fn now(&mut self) -> i64 {
        AT + self.0.elapsed().as_micros() as i64
    }

    fn sleep_until(&mut self, t: i64) {
        let wait = t - self.now();
        if wait > 0 {
            std::thread::sleep(Duration::from_micros(wait as u64));
        }
    }
}

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
        expiry: AT + 60_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
    }
}

fn send(w: &answers::World, i: &Intent) -> Receiver<Vec<u8>> {
    let (reply, rx) = channel();
    assert!(w.door().arrive(encode(&i.to_value()).unwrap(), reply));
    rx
}

/// The answer's kind: 1 a receipt, 2 a refusal (with its reason).
fn kind(rx: &Receiver<Vec<u8>>) -> (u64, String) {
    let f = rx.recv_timeout(Duration::from_secs(5)).expect("an answer");
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
    let d = dir(name);
    let built = toggles::World::build(1, 3, 0);
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
    cfg.clock = Some(Box::new(FromAt::start()));
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
        *wr.lock().unwrap() = Some(follow(w, sub, s));
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
    for r in recover(log)
        .unwrap()
        .records
        .into_iter()
        .filter(|r| !sim::recorder::is_input(r))
    {
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
    for rec in recover(&log)
        .unwrap()
        .records
        .into_iter()
        .filter(|r| !sim::recorder::is_input(r))
    {
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
    }
    let mut whisper_ref = None;
    let (_, dir) = r.end(|store, said| {
        // Removed before the part is written: the redaction list keeps it out of the file.
        store.remove(said[2].words, b1, 0, Grade::Hidden).unwrap();
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
