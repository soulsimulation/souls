//! Removing one person's words from what is served (Engine v2 W7, #2826): `worldd remove-words`, an operator's command
//! on a stopped world's folder. A production use needs the site owner's yes each time.
//!
//! 1. **Whose.** A person is named by their Souls' bodies (`--author`, repeated): the principal each record of K16's
//!    text store keeps as its author (a creator's id for a creator's words). Their references are listed from the
//!    store alone ([`sim::text::Store::written_by`]). With `--from` and `--to` (world time, µs, `from` included), only
//!    those an entry of the log carries in that time ([`in_range`]): a said event, a name or description set, or an
//!    intent logged in a part with an entry then. The log is read from its cut, so words logged before a compaction
//!    are found without a range only.
//! 2. **How.** `--hide` (the default) puts each on the store's redaction list, reversibly; `--erase` also deletes the
//!    stored bytes (K16 rule 6); `--restore` shows hidden ones again. Erased words stay erased. Each change is one
//!    entry of the list, synced before anything else: the reference, who asked (`--by`, a principal id), when (wall
//!    time, µs) and the grade, never the words. That list is the record of every removal (O20 ships it within 1 s).
//! 3. **What is served after.** The store reads each as `removed` (every delivery and every view built with the list).
//!    The stream's text files under `views/` (V1 rule 10: `<n>.text`, `baseline.text`) are written again whole without
//!    their rows ([`purge`]); the origin lets a cache keep a text file 60 s at most (`v2/docs/viewer-cache.md`). A
//!    start writes the text files it recovers from the stream's recovery chain without them too (V1 rule 10), and
//!    re-derives history's bundles and indices with the list (`archive::Archiver::open_based_with_redactions`), each
//!    removed reference marked `{21: id, 22: 1}`. The log, the stream's parts and baselines, and the archive's objects
//!    hold references only and are never changed: the rest replays exactly as before. A restore adds no row back to a
//!    text file; a start writes the current generation's again from the chain, with the restored words.
//! 4. **A dry run** (`--dry-run`) removes nothing and rewrites no file: it counts the references, those already as
//!    asked, and the text files and rows that would go. Opening the store is a start's own recovery (a torn tail cut).
//! 5. **Only on a stopped world.** A running world holds its store's files locked, so the command is refused
//!    (`world-running`) and touches nothing.
//!
//! Not here: a running world's removal, who may remove whose words (W7's directory half), the copies the recovery
//! chain and O20's backups keep until they are deleted (#2826's plan).

use std::collections::BTreeSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use replica::audience::references;
use replica::effects::{Header, Part, Refusal};
use replica::encode::{Value, decode, from_hex};
use replica::ids::{Id, Minter, Scope};
use replica::time::Micros;
use replica::views::Redactions;
use sim::text::{Grade, Store, Written};

type R<T> = Result<T, Refusal>;

fn fault(name: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal {
        name,
        detail: detail.into(),
    }
}

fn io(e: std::io::Error) -> Refusal {
    fault("removal-io", e.to_string())
}

/// What an operator asked: whose words, from when to when (world µs), how, by whom and when (wall µs).
#[derive(Clone, Debug)]
pub struct Ask {
    pub authors: BTreeSet<Id>,
    pub range: Option<(Micros, Micros)>,
    pub grade: Grade,
    pub by: Id,
    pub when_us: u64,
    pub dry_run: bool,
}

/// What a removal found and did (or, for a dry run, would do).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Tally {
    /// The references the authors wrote (in the range), and how many of them are uploads.
    pub found: usize,
    pub uploads: usize,
    /// Of them, those already as asked (erased ones for any grade).
    pub already: usize,
    /// Of them, those changed now.
    pub changed: usize,
    /// The stream's text files written again without removed rows, and the rows they lost.
    pub files: usize,
    pub rows: usize,
}

/// The references an entry of `records` (a log's, in order) carries in world time `[from, to)`, with those of the
/// intents logged in a part that has such an entry.
pub fn in_range(records: &[Vec<u8>], from: Micros, to: Micros) -> R<BTreeSet<Id>> {
    let mut out = BTreeSet::new();
    for raw in records {
        if sim::recorder::is_input(raw) {
            continue;
        }
        let part = Part::read(raw)?;
        let mut any = false;
        for e in part
            .effects
            .iter()
            .filter(|e| (from..to).contains(&e.envelope.at))
        {
            any = true;
            out.extend(references(&e.to_value()));
        }
        if any {
            out.extend(references(&Value::Map(part.rest.clone())));
        }
    }
    Ok(out)
}

/// Whether a reference removed as `now` changes when asked for `grade`.
fn due(grade: Grade, now: Option<Grade>) -> bool {
    !matches!(
        (grade, now),
        (_, Some(Grade::Erased)) | (Grade::Hidden, Some(Grade::Hidden)) | (Grade::Restored, None)
    )
}

/// Applies `ask` to `store`, then writes the text files under `views` again without the rows of every reference the
/// store's list names (rule 3). `ranged`: the references [`in_range`] found, when the ask has a range.
pub fn remove(store: &Store, views: &Path, ask: &Ask, ranged: Option<&BTreeSet<Id>>) -> R<Tally> {
    let written: Vec<Written> = store
        .written_by(&ask.authors)
        .into_iter()
        .filter(|w| ranged.is_none_or(|r| r.contains(&w.reference)))
        .collect();
    let changing: Vec<Id> = written
        .iter()
        .filter(|w| due(ask.grade, w.removed))
        .map(|w| w.reference)
        .collect();
    let mut t = Tally {
        found: written.len(),
        uploads: written.iter().filter(|w| w.upload).count(),
        already: written.len() - changing.len(),
        changed: changing.len(),
        ..Tally::default()
    };
    let list = if ask.dry_run {
        match ask.grade {
            Grade::Restored => store.redactions(),
            _ => Redactions::new(store.redactions().iter().chain(changing.iter().copied())),
        }
    } else {
        for r in &changing {
            store.remove(*r, ask.by, ask.when_us, ask.grade)?;
        }
        store.redactions()
    };
    if ask.grade != Grade::Restored {
        (t.files, t.rows) = purge(views, &list, ask.dry_run)?;
    }
    Ok(t)
}

fn rows(bytes: &[u8]) -> R<usize> {
    match decode(bytes)
        .map_err(|e| fault("stream-words", e.to_string()))?
        .value
    {
        Value::Array(rows) => Ok(rows.len()),
        _ => Err(fault("stream-words", "a text file is a list")),
    }
}

/// Writes each text file under `dir` (`*.text`, at any depth) again, whole, without the rows of the references `list`
/// names (`view_out::purge_text`). The files and rows that went, or with `dry`, would go.
pub fn purge(dir: &Path, list: &Redactions, dry: bool) -> R<(usize, usize)> {
    let (mut files, mut gone) = (0, 0);
    let mut dirs = vec![dir.to_path_buf()];
    while let Some(d) = dirs.pop() {
        let entries = match std::fs::read_dir(&d) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(io(e)),
        };
        for e in entries {
            let e = e.map_err(io)?;
            let (path, ty) = (e.path(), e.file_type().map_err(io)?);
            if ty.is_dir() {
                dirs.push(path);
                continue;
            }
            if !ty.is_file() || path.extension().is_none_or(|x| x != "text") {
                continue;
            }
            let bytes = std::fs::read(&path).map_err(io)?;
            let Some(purged) = crate::view_out::purge_text(&bytes, list)? else {
                continue;
            };
            files += 1;
            gone += rows(&bytes)? - rows(&purged)?;
            if !dry {
                crate::view_out::write_whole(&path, &purged)?;
            }
        }
    }
    Ok((files, gone))
}

/// A log's records from its cut (or its first), read only.
fn log_records(path: &Path) -> R<Vec<Vec<u8>>> {
    let Some(cut) = sim::log::compact::read_cut(path)? else {
        return Ok(sim::log::recover(&std::fs::read(path).map_err(io)?)?.records);
    };
    let mut f = std::fs::File::open(path).map_err(io)?;
    let mut header = vec![0; sim::log::HEADER_LEN];
    f.read_exact(&mut header).map_err(io)?;
    let mut tail = Vec::new();
    f.seek(SeekFrom::Start(cut.at.offset)).map_err(io)?;
    f.read_to_end(&mut tail).map_err(io)?;
    sim::log::recover_from(&header, &tail, cut.at)?
        .map(|r| r.records)
        .ok_or_else(|| fault("log-cut-bad", "the log does not continue at its cut"))
}

/// An id as `<32 hex>-<n>` (or `<32 hex>:<n>`, a principal's text).
fn id(text: &str) -> Result<Id, String> {
    let bad = || format!("not an id (<32 hex>-<n>): {text:?}");
    let (scope, n) = text.split_once(['-', ':']).ok_or_else(bad)?;
    let scope: [u8; 16] = from_hex(scope)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(bad)?;
    Id::new(Scope(scope), n.parse().map_err(|_| bad())?).ok_or_else(bad)
}

fn said(e: Refusal) -> String {
    format!("{}: {}", e.name, e.detail)
}

/// `worldd remove-words <world folder> --author <id> [--author <id> ...] [--from <world µs> --to <world µs>]
/// [--hide | --erase | --restore] --by <id> [--dry-run]`: prints what it found and did; exits 0, or 2 when refused.
pub fn run(args: &[String]) -> i32 {
    match cli(args) {
        Ok(line) => {
            println!("{line}");
            0
        }
        Err(e) => {
            eprintln!("worldd remove-words: {e}");
            2
        }
    }
}

const USAGE: &str = "usage: worldd remove-words <world folder> --author <id> [--author <id> ...] \
                     [--from <world µs> --to <world µs>] [--hide | --erase | --restore] --by <id> [--dry-run]";

fn cli(args: &[String]) -> Result<String, String> {
    let world = args
        .get(2)
        .filter(|a| !a.starts_with("--"))
        .map(PathBuf::from)
        .ok_or(USAGE)?;
    let (mut authors, mut by, mut from, mut to) = (BTreeSet::new(), None, None, None);
    let (mut grade, mut dry_run) = (Grade::Hidden, false);
    let mut rest = args[3..].iter();
    while let Some(flag) = rest.next() {
        let mut value = || rest.next().cloned().ok_or(format!("{flag} needs a value"));
        match flag.as_str() {
            "--author" => {
                authors.insert(id(&value()?)?);
            }
            "--by" => by = Some(id(&value()?)?),
            "--from" => from = Some(value()?.parse::<Micros>().map_err(|e| e.to_string())?),
            "--to" => to = Some(value()?.parse::<Micros>().map_err(|e| e.to_string())?),
            "--hide" => grade = Grade::Hidden,
            "--erase" => grade = Grade::Erased,
            "--restore" => grade = Grade::Restored,
            "--dry-run" => dry_run = true,
            other => return Err(format!("unknown {other:?}\n{USAGE}")),
        }
    }
    let by = by.ok_or(format!("--by names who asked\n{USAGE}"))?;
    if authors.is_empty() {
        return Err(format!("--author names whose words\n{USAGE}"));
    }
    let range = match (from, to) {
        (None, None) => None,
        (Some(f), Some(t)) if f < t => Some((f, t)),
        _ => return Err("--from and --to go together, from before to".into()),
    };
    let text = world.join("log.text");
    if !text.is_dir() {
        return Err("the world has no text store (log.text): no words to remove".into());
    }
    let header = std::fs::read(world.join("header")).map_err(|e| format!("header: {e}"))?;
    let header = Header::read(&header).map_err(said)?;
    let store =
        Store::open_dir(&text, Minter::new(crate::words::scope(header.lineage))).map_err(|e| {
            match e.name {
                "log-locked" => {
                    "world-running: the world holds its text store; stop it first".into()
                }
                _ => said(e),
            }
        })?;
    let ranged = match range {
        Some((f, t)) => {
            Some(in_range(&log_records(&world.join("log")).map_err(said)?, f, t).map_err(said)?)
        }
        None => None,
    };
    let ask = Ask {
        authors,
        range,
        grade,
        by,
        when_us: u64::try_from(crate::answers::now()).unwrap_or(0),
        dry_run,
    };
    let t = remove(&store, &world.join("views"), &ask, ranged.as_ref()).map_err(said)?;
    store.close();
    let how = match grade {
        Grade::Hidden => "hidden",
        Grade::Erased => "erased",
        Grade::Restored => "restored",
    };
    Ok(format!(
        "{}: {} references by {} author(s) ({} uploads); {} already {how}; {} {}{how}; {} text files {}, {} rows",
        if dry_run { "dry run" } else { "done" },
        t.found,
        ask.authors.len(),
        t.uploads,
        t.already,
        t.changed,
        if dry_run { "to be " } else { "" },
        t.files,
        if dry_run {
            "to write again"
        } else {
            "written again"
        },
        t.rows,
    ))
}
