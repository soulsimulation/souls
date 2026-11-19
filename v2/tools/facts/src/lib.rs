//! `facts` (Engine v2 V10, #2720): one recorded world read two ways, as V1's live parts and as V3's history bundles,
//! each into a fact sheet (`replica::facts`), and the two compared.
//!
//! - [`record`] runs V3's scripted world (`archive::script`: rooms of ten bodies, each holding a cup, with cups on the
//!   floor) with every body taking a step each 50 ms tick and one of them speaking, by reference, every ten seconds.
//!   Each tick's part is handed, as the world commits it, to the root's public view at `full` (T7's reference view,
//!   which R3's tier matches byte for byte) and on to V1's stream writer, which writes the numbered parts under
//!   `www/`; and to V3's bundler, which writes the bundles (`sampled`, five minutes each) under `bundles/`. Its
//!   effects also go to V4's indexer, which writes the public event index and counts under `history/` as a world's
//!   history holds them (R16b, #3480), so R16's `history` answers can be checked against the sheet.
//! - [`sheet`] reads either back into a sheet, one file at a time.
//! - [`fault`] copies the bundles with one body moved 30 cm in one motion sample, and says the second the sheets
//!   must first differ at.
//! - [`scan`] lists a sheet's text items (names only) and references, and finds no words.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use archive::Bundler;
use archive::script::{self, SAID};
use replica::audience::references;
use replica::effects::{Body, Change, Effect, Part, Refusal, State, texts};
use replica::encode::{Value, encode};
use replica::facts::{self, SECOND, Sheet};
use replica::history::Bundle;
use replica::history::events::Indexer;
use replica::ids::Id;
use replica::stream;
use replica::views::{Key, Level, Redactions, View};
use replica::world_model::Audience;
use worldd::view_out::Writer;

pub type R<T> = Result<T, Refusal>;

fn enc(v: &Value) -> R<Vec<u8>> {
    encode(v).or_else(|e| refuse("encoding", e.to_string()))
}

pub fn refuse<T>(name: &'static str, detail: impl Into<String>) -> R<T> {
    Err(Refusal {
        name,
        detail: detail.into(),
    })
}

fn io<T>(r: std::io::Result<T>) -> R<T> {
    r.or_else(|e| refuse("io", e.to_string()))
}

/// Rooms of ten bodies: 100 bodies, every one acting each tick.
pub const ROOMS: usize = 10;
/// Cups on each room's floor, beside the one each body holds.
pub const THINGS: usize = 5;
/// Bodies that take a step each tick.
pub const MOVERS: usize = 100;
/// Ticks between two utterances (ten seconds).
pub const SAY_EVERY: u64 = 200;

/// The header file a recording keeps beside its parts and bundles.
pub const HEADER: &str = "header";

/// Records `seconds` of world time under `dir`: the header, the live parts under `www/`, the bundles under
/// `bundles/` and V4's event index from the same effects under `history/`. Returns the bodies.
pub fn record(dir: &Path, seconds: u64) -> R<Vec<Id>> {
    let _ = fs::remove_dir_all(dir);
    io(fs::create_dir_all(dir.join("bundles")))?;
    let queue: Rc<RefCell<Vec<Vec<u8>>>> = Rc::default();
    let q = queue.clone();
    let mut w = script::world(
        ROOMS,
        THINGS,
        Some(Box::new(move |b: &[u8]| q.borrow_mut().push(b.to_vec()))),
    );
    let header = w.header.clone();
    io(fs::write(dir.join(HEADER), header.stored()))?;
    let root = w.tree.node(w.tree.root()).expect("the root");
    let (root, kind) = (root.id(), root.kind().clone());
    let key = Key {
        node: root,
        level: Level::Full,
        audience: Audience::Everyone,
    };
    let redactions = Redactions::default();
    let mut view = View::new(key, &header, &redactions);
    let (mut before, mut after) = (
        State::start(root, kind.clone()),
        State::start(root, kind.clone()),
    );
    let mut writer = Writer::create(&dir.join("www"), &header, &key, (0, 0))?;
    let mut bundler = Bundler::new(root, kind);
    let mut indexer = Indexer::new(redactions.clone());
    let index = |objects: Vec<(String, Vec<u8>)>| -> R<()> {
        for (k, v) in objects {
            let path = dir.join(k);
            io(fs::create_dir_all(path.parent().expect("a key's folder")))?;
            io(fs::write(path, v))?;
        }
        Ok(())
    };
    let put = |b: &Bundle| {
        io(fs::write(
            dir.join(format!("bundles/{:020}", b.start)),
            b.bytes(),
        ))
    };
    let mut feed = |queue: &Rc<RefCell<Vec<Vec<u8>>>>| -> R<()> {
        let parts: Vec<Vec<u8>> = queue.borrow_mut().drain(..).collect();
        for bytes in parts {
            let part = Part::read(&bytes)?;
            for e in &part.effects {
                index(indexer.feed(e)?)?;
                after.apply_entry(&header, e)?;
                view.step(&before, e, &after, &redactions)?;
                before.apply_entry(&header, e)?;
            }
            let records: Vec<Value> = view.take().into_iter().map(|(_, r)| r).collect();
            if !records.is_empty() {
                let frame = Value::Map(BTreeMap::from([(8, Value::Array(records))]));
                writer.frame(&enc(&frame)?)?;
            }
            for b in bundler.feed(&header, &bytes)? {
                put(&b)?;
            }
        }
        Ok(())
    };
    feed(&queue)?;
    for t in 0..seconds * 20 {
        script::tick(&mut w, t, MOVERS, SAY_EVERY);
        feed(&queue)?;
    }
    writer.flush()?;
    if let Some(b) = bundler.finish()? {
        put(&b)?;
    }
    index(indexer.finish()?)?;
    Ok(w.bodies.clone())
}

/// What a sheet is read from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Live,
    History,
}

/// The files of a recording's view, in order: the parts by number, or the bundles by start.
pub fn files(dir: &Path, from: Side) -> R<Vec<PathBuf>> {
    match from {
        Side::Live => {
            let header = replica::effects::Header::read(&io(fs::read(dir.join(HEADER)))?)?;
            let key = Key {
                node: header.zone,
                level: Level::Full,
                audience: Audience::Everyone,
            };
            let d = dir.join("www").join(stream::dir(&header, &key));
            let mut n = 0u64;
            let mut out = Vec::new();
            while d.join(n.to_string()).exists() {
                out.push(d.join(n.to_string()));
                n += 1;
            }
            Ok(out)
        }
        Side::History => {
            let mut out: Vec<PathBuf> = io(fs::read_dir(dir.join("bundles")))?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_none())
                .collect();
            out.sort();
            Ok(out)
        }
    }
}

/// The sheet of world seconds `t0..t1` of a recording, read from its parts or its bundles, one file at a time. With
/// `at`, also the whole record at that world time (µs) over the state once every file is applied (`factsAt`).
pub fn sheet(dir: &Path, from: Side, t0: i64, t1: i64, at: Option<i64>) -> R<(Vec<u8>, Vec<u8>)> {
    let mut s = Sheet::new(&io(fs::read(dir.join(HEADER)))?, t0, t1)?;
    for f in files(dir, from)? {
        let bytes = io(fs::read(&f))?;
        match from {
            Side::Live => s.part(&bytes)?,
            Side::History => s.bundle(&bytes)?,
        }
    }
    let one = match (at, s.state()) {
        (Some(t), Some(st)) => facts::facts_at(st, t)?,
        _ => Vec::new(),
    };
    Ok((s.finish()?, one))
}

/// The moved sample (A2): the body, the sample's world time and the second the sheets must first differ at.
#[derive(Debug)]
pub struct Fault {
    pub body: Id,
    pub at: i64,
    pub second: i64,
}

/// How far the fault moves the body, µm (30 cm).
pub const FAULT_UM: i64 = 300_000;

/// Copies `dir`'s header and bundles to `out`, with one body moved [`FAULT_UM`] along x in the first motion sample at or
/// after world time `after` µs. Every other byte is as recorded.
pub fn fault(dir: &Path, out: &Path, after: i64) -> R<Fault> {
    io(fs::create_dir_all(out.join("bundles")))?;
    io(fs::copy(dir.join(HEADER), out.join(HEADER)))?;
    let mut found = None;
    for f in files(dir, Side::History)? {
        let bytes = io(fs::read(&f))?;
        let name = f.file_name().expect("a bundle's name").to_owned();
        let b = Bundle::read(&bytes)?;
        let bytes = match (&found, &b.view) {
            (None, Value::Map(m)) if b.start + b.length > after => {
                let Some(Value::Array(records)) = m.get(&8) else {
                    return refuse("facts-bad", "a bundle without records");
                };
                let part = Part::read(&enc(&Value::Map(BTreeMap::from([
                    (1, Value::Bytes(b.header.clone())),
                    (2, Value::Array(records.clone())),
                ])))?)?;
                let mut effects: Vec<Effect> = part.effects.clone();
                for e in effects.iter_mut().filter(|e| e.envelope.at >= after) {
                    if let Body::Changes(cs) = &mut e.body
                        && let Some(Change::Motion(h)) = cs.first_mut().map(|c| &mut c.change)
                    {
                        h.pose.position.x += FAULT_UM;
                        let at = e.envelope.at;
                        let second = at.div_euclid(SECOND) + i64::from(at.rem_euclid(SECOND) != 0);
                        found = Some(Fault {
                            body: h.node,
                            at,
                            second,
                        });
                        break;
                    }
                }
                let mut view = m.clone();
                view.insert(
                    8,
                    Value::Array(effects.iter().map(Effect::to_value).collect()),
                );
                Bundle::new(
                    b.header.clone(),
                    b.start,
                    b.length,
                    b.snapshot.clone(),
                    Value::Map(view),
                )?
                .bytes()
                .to_vec()
            }
            _ => bytes,
        };
        io(fs::write(out.join("bundles").join(name), bytes))?;
    }
    found.map_or_else(|| refuse("facts-fault", "no motion sample to move"), Ok)
}

/// A sheet's scan (A4): its distinct text items (T0 text is a name, so never words), how many references it holds,
/// and which of the words the scripted Souls said appear anywhere in its bytes.
pub struct Scan {
    pub texts: BTreeSet<String>,
    pub references: usize,
    pub speech_acts: usize,
    pub words_found: Vec<String>,
}

pub fn scan(sheet: &[u8]) -> R<Scan> {
    let mut s = Scan {
        texts: BTreeSet::new(),
        references: 0,
        speech_acts: 0,
        words_found: Vec::new(),
    };
    for r in facts::records(sheet) {
        let v = Value::Map(r?);
        s.texts.extend(texts(&v));
        s.references += references(&v).len();
        if let Value::Map(m) = &v
            && let Some(Value::Array(acts)) = m.get(&6)
        {
            s.speech_acts += acts.iter().filter(|a| !references(a).is_empty()).count();
        }
    }
    let raw = String::from_utf8_lossy(sheet);
    for said in SAID {
        for w in said.split(' ').filter(|w| w.len() > 3) {
            if raw.contains(w) {
                s.words_found.push(w.to_owned());
            }
        }
    }
    Ok(s)
}
