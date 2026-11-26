//! A running world's library entries brought up to a release's (`worldd entries plan|stage`).
//!
//! `worldd seed` copies the entries it is given into the world's folder (`<world>/entries/`, one `<kind>.json` each,
//! after C13's stand-point repair) and every start reads them from there ([`crate::serve`]'s module notes). Nothing
//! after the seed wrote them again, so a release's content fix never reached a world that was not reseeded. This is
//! that step, for the release's move (`v2/tools/ops/release/release.sh`):
//!
//! `worldd entries plan|stage --dir <world folder> --kinds <the release's content/kinds>`
//!
//! - An entry of the world whose kind the release has, repaired as the seed repairs it against the world's own facts,
//!   is changed when its text differs. One the release lacks is the world's own and is kept. One only the release has
//!   is added (#4954), as `<namespace>.<name>.json` as a seed writes it: the release's library is every world's, so a
//!   new Soul Action reaches a running world with the release, no reseed. The world's header is fixed for its life, so
//!   its next start defines the added kinds in its history, as a creator's kinds are (`serve::added_kinds`, the
//!   engine's first tick), and its log before them replays unchanged. The library's names are the shared names (its
//!   namespace, `eden:` today, is in every pin, role and link of every world, so it is not renamed; a Soul is offered
//!   an action by its plain name): a world's own entry of the same name in its own namespace overrides one, which is
//!   then not added. A fork keeps its entries: its `boot` pins them (`served-fork-support-mismatch` otherwise).
//! - A change is refused, by name, where the world's state may no longer fit it: a state field gone
//!   (`entries.state-removed`), given another number or type (`entries.state-retyped`), an enum value gone
//!   (`entries.state-value-removed`), an int's range narrowed (`entries.state-narrowed`), a slot gone, renumbered or
//!   admitting less (`entries.slot-removed`, `entries.slot-renumbered`, `entries.slot-narrowed`), a role gone
//!   (`entries.role-removed`) or another owner (`entries.owner-changed`); and where the world, built from its facts
//!   with the new entries under its own header (as a start builds it, [`crate::serve`]'s `adopt`), would not build
//!   (`entries.build-refused`) or would leave a revision it pins of a changed or added kind with no definition
//!   (`entries.kind-unpaired`). A world that keeps no header (seeded before K16) is refused `entries.header-missing`:
//!   its start would rebuild the header and refuse the log.
//! - One refusal and nothing of that world is staged. `plan` changes nothing. `stage` writes the world's whole
//!   entries with the changes as `<world>/entries.next` (built beside it, then renamed in; owned as `entries/` is),
//!   and never touches `entries/` itself: the release's `deploy` rehearses the new build on `entries.next` and swaps it
//!   in between the pin and the restart (`supervisor::deploy::swap_entries`), so the build that reads the new entries
//!   is the one that was checked with them. With nothing to change it removes a stale `entries.next`. Every line
//!   printed is the log: `entries: <world>: change <kind> <old>..<new>`, with the entry's SHA-256 (first 12 hex)
//!   before and after, `entries: <world>: add <kind> <new>`, or `refused: entries.<name>: <world>: <kind>: <why>`.
//!
//! Exits 0 when the world has changes (staged) or nothing to change, 3 when refused, 1 on an error.

use std::collections::BTreeMap;
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};

use replica::encode::to_hex;
use replica::ids::sha256;
use replica::rules::json::{self, Value as Json};
use replica::world_model::plain;

use supervisor::deploy::ENTRIES_NEXT;

use crate::serve;

type R<T> = Result<T, String>;

/// One entry the release changes: its file in the world's folder, the world's entry and the release's.
pub(crate) struct Change {
    pub kind: String,
    pub path: PathBuf,
    pub old: Json,
    pub new: Json,
}

/// What `plan` found for one world.
#[derive(Default)]
pub(crate) struct Plan {
    pub changes: Vec<Change>,
    pub unchanged: usize,
    /// The world's own entries, which the release has no entry of.
    pub own: Vec<String>,
    /// The release's entries of kinds the world has none of, each with the release's entry: added.
    pub added: Vec<(String, Json)>,
    /// The release's entries a world's own entry of the same name (in its own namespace) overrides: not added.
    pub overridden: Vec<String>,
    /// `entries.<name>: <kind>: <why>` each.
    pub refused: Vec<String>,
    /// Why nothing was looked at: a fork, or no entries.
    pub kept: Option<&'static str>,
}

fn io(path: &Path) -> impl Fn(std::io::Error) -> String + '_ {
    move |e| format!("{}: {e}", path.display())
}

fn arg<'a>(args: &'a [String], name: &str) -> Option<&'a String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|k| args.get(k + 1))
}

/// An entry's revision as the log names it: the first 12 hex of its text's SHA-256.
fn rev(v: &Json) -> String {
    to_hex(&sha256(v.to_json().as_bytes()))[..12].to_owned()
}

/// The world's `souls-entry/1` files, by kind, each with its path (as [`serve::entries`] reads them).
fn world_entries(dir: &Path, out: &mut BTreeMap<String, (PathBuf, Json)>) -> R<()> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(io(dir))?
        .filter_map(|e| Some(e.ok()?.path()))
        .collect();
    paths.sort();
    for p in paths {
        if p.is_dir() {
            world_entries(&p, out)?;
        } else if p.extension().is_some_and(|x| x == "json") {
            let text = std::fs::read_to_string(&p).map_err(io(&p))?;
            let Ok(v) = json::parse(&text) else { continue };
            if v.get("format").and_then(Json::str) != Some("souls-entry/1") {
                continue;
            }
            if let Some(kind) = v.get("kind").and_then(Json::str) {
                out.insert(kind.to_owned(), (p.clone(), v.clone()));
            }
        }
    }
    Ok(())
}

fn obj<'a>(v: &'a Json, key: &str) -> &'a [(String, Json)] {
    v.get(key).and_then(Json::obj).unwrap_or(&[])
}

fn int(v: &Json, key: &str) -> Option<i128> {
    match v.get(key) {
        Some(Json::Int(n)) => Some(*n),
        _ => None,
    }
}

/// Why the world's state may no longer fit `new` where it fitted `old`, each `entries.<name>: <kind>: <why>`.
pub(crate) fn unfit(kind: &str, old: &Json, new: &Json) -> Vec<String> {
    let mut out = Vec::new();
    let (oo, no) = (
        old.get("owner").and_then(Json::str),
        new.get("owner").and_then(Json::str),
    );
    if oo != no {
        out.push(format!(
            "entries.owner-changed: {kind}: owner {} is now {}",
            oo.unwrap_or("none"),
            no.unwrap_or("none")
        ));
    }
    let new_state = obj(new, "state");
    for (field, was) in obj(old, "state") {
        let Some((_, now)) = new_state.iter().find(|(f, _)| f == field) else {
            out.push(format!(
                "entries.state-removed: {kind}: state field {field} is gone, and things may hold it"
            ));
            continue;
        };
        let ty = |v: &Json| v.get("type").and_then(Json::str).map(str::to_owned);
        if int(was, "n") != int(now, "n") || ty(was) != ty(now) {
            out.push(format!(
                "entries.state-retyped: {kind}: state field {field} was n {} {}, now n {} {}",
                int(was, "n").map_or("none".into(), |n| n.to_string()),
                ty(was).unwrap_or_default(),
                int(now, "n").map_or("none".into(), |n| n.to_string()),
                ty(now).unwrap_or_default()
            ));
            continue;
        }
        let values = |v: &Json| -> Vec<String> {
            v.get("values")
                .and_then(Json::arr)
                .unwrap_or(&[])
                .iter()
                .filter_map(|x| x.str().map(str::to_owned))
                .collect()
        };
        let kept = values(now);
        for v in values(was).iter().filter(|v| !kept.contains(v)) {
            out.push(format!(
                "entries.state-value-removed: {kind}: state field {field} no longer has value {v}"
            ));
        }
        let narrowed = |key: &str, lower: bool| match (int(was, key), int(now, key)) {
            (_, None) => false,
            (None, Some(_)) => true,
            (Some(a), Some(b)) => (lower && b > a) || (!lower && b < a),
        };
        if narrowed("min", true) || narrowed("max", false) {
            out.push(format!(
                "entries.state-narrowed: {kind}: state field {field}'s range narrowed, and things may hold a value \
                 outside it"
            ));
        }
    }
    // Slots are numbered in the entry's order (1, 2, ...): one gone or moved renumbers what a body or a thing holds.
    let new_slots = obj(new, "slots");
    for (k, (slot, was)) in obj(old, "slots").iter().enumerate() {
        match new_slots.iter().position(|(s, _)| s == slot) {
            None => out.push(format!(
                "entries.slot-removed: {kind}: slot {slot} is gone, and a body or thing may hold it"
            )),
            Some(at) if at != k => out.push(format!(
                "entries.slot-renumbered: {kind}: slot {slot} was number {}, now {}",
                k + 1,
                at + 1
            )),
            Some(at) => {
                if let Some(why) = slot_narrowed(was, &new_slots[at].1) {
                    out.push(format!(
                        "entries.slot-narrowed: {kind}: slot {slot} {why}, and a body or thing may hold it"
                    ));
                }
            }
        }
    }
    // An activity's members each hold a role: one gone leaves them holding nothing.
    let new_roles = obj(new, "roles");
    for (role, _) in obj(old, "roles") {
        if !new_roles.iter().any(|(r, _)| r == role) {
            out.push(format!(
                "entries.role-removed: {kind}: role {role} is gone, and an open activity's member may hold it"
            ));
        }
    }
    out
}

/// How slot `now` admits less than `was` did, if it does: what it admits, which kinds, how many, how large.
fn slot_narrowed(was: &Json, now: &Json) -> Option<String> {
    let text = |v: &Json, key: &str| v.get(key).map(Json::to_json);
    if text(was, "admits") != text(now, "admits") {
        return Some(format!(
            "admits {}, now {}",
            text(was, "admits").unwrap_or_default(),
            text(now, "admits").unwrap_or_default()
        ));
    }
    let list = |v: &Json, key: &str| -> Option<Vec<String>> {
        Some(v.get(key)?.arr()?.iter().map(Json::to_json).collect())
    };
    match (list(was, "kinds"), list(now, "kinds")) {
        (None, Some(_)) => return Some("now admits only some kinds".into()),
        (Some(a), Some(b)) if a.iter().any(|k| !b.contains(k)) => {
            return Some("admits fewer kinds".into());
        }
        _ => {}
    }
    match (int(was, "most"), int(now, "most")) {
        (None, Some(_)) => return Some("now holds a most".into()),
        (Some(a), Some(b)) if b < a => return Some(format!("holds at most {b}, was {a}")),
        _ => {}
    }
    let size = |v: &Json| -> Option<Vec<i128>> {
        v.get("fits_mm")?
            .arr()?
            .iter()
            .map(|x| match x {
                Json::Int(n) => Some(*n),
                _ => None,
            })
            .collect()
    };
    match (size(was), size(now)) {
        (None, Some(_)) => Some("now fits only a size".into()),
        (Some(a), Some(b)) if a.len() != b.len() || a.iter().zip(&b).any(|(x, y)| y < x) => {
            Some("fits a smaller size".into())
        }
        _ => None,
    }
}

/// What `apply` would change in the world at `dir`, from the release's entries under `kinds`.
pub(crate) fn plan(dir: &Path, kinds: &Path) -> R<Plan> {
    let mut p = Plan::default();
    let meta_path = dir.join("world.json");
    let meta = json::parse(&std::fs::read_to_string(&meta_path).map_err(io(&meta_path))?)?;
    if meta.get("fork") == Some(&Json::Bool(true)) {
        p.kept = Some("a fork: its boot pins its entries");
        return Ok(p);
    }
    let mut world = BTreeMap::new();
    if dir.join("entries").is_dir() {
        world_entries(&dir.join("entries"), &mut world)?;
    }
    if world.is_empty() {
        p.kept = Some("no entries");
        return Ok(p);
    }
    let facts =
        std::fs::read_to_string(dir.join("facts.json")).map_err(io(&dir.join("facts.json")))?;
    // The release's entries as the seed would have written them for this world: C13's stand-point repair on its facts.
    let mut release = Vec::new();
    serve::entries(kinds, &mut release)?;
    if release.is_empty() {
        return Err(format!(
            "no souls-entry/1 entries under {}",
            kinds.display()
        ));
    }
    let _ = import_eden::clear_stand_points(&import_eden::load(&facts)?, &mut release);
    let release: BTreeMap<String, Json> = release.into_iter().collect();
    for (kind, (path, old)) in &world {
        match release.get(kind) {
            None => p.own.push(kind.clone()),
            Some(new) if new.to_json() == old.to_json() => p.unchanged += 1,
            Some(new) => {
                p.refused.extend(unfit(kind, old, new));
                p.changes.push(Change {
                    kind: kind.clone(),
                    path: path.clone(),
                    old: old.clone(),
                    new: new.clone(),
                });
            }
        }
    }
    // A name without its namespace: a world's own entry of one overrides the library's.
    let bare = |k: &str| k.split_once(':').map_or(k, |(_, n)| n).to_owned();
    let own: Vec<String> = p.own.iter().map(|k| bare(k)).collect();
    for (kind, entry) in release.iter().filter(|(k, _)| !world.contains_key(*k)) {
        if own.contains(&bare(kind)) {
            p.overridden.push(kind.clone());
        } else {
            p.added.push((kind.clone(), entry.clone()));
        }
    }
    if (p.changes.is_empty() && p.added.is_empty()) || !p.refused.is_empty() {
        return Ok(p);
    }
    // The engine's own word: the world built from its facts with the new entries, as its next start builds it, under
    // the header it keeps.
    let header = match std::fs::read(dir.join("header")) {
        Ok(bytes) => replica::effects::Header::read(&bytes)
            .map_err(|e| format!("{}: {}: {}", dir.join("header").display(), e.name, e.detail))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            p.refused.push(
                "entries.header-missing: the world: it keeps no header (seeded before K16), so a start with other \
                 entries would rebuild its header and refuse its log"
                    .into(),
            );
            return Ok(p);
        }
        Err(e) => return Err(io(&dir.join("header"))(e)),
    };
    let mut candidate: Vec<(String, Json)> = Vec::new();
    serve::entries(&dir.join("entries"), &mut candidate)?;
    for (kind, entry) in candidate.iter_mut() {
        if let Some(c) = p.changes.iter().find(|c| &c.kind == kind) {
            *entry = c.new.clone();
        }
    }
    candidate.extend(p.added.iter().cloned());
    let mut built = match serve::build_with(None, &facts, &candidate) {
        Ok(b) => b,
        Err(e) => {
            p.refused.push(format!(
                "entries.build-refused: the world: with the new entries it would not start: {e}"
            ));
            return Ok(p);
        }
    };
    let unknown = serve::adopt(&mut built, header, &serve::owners(dir));
    for pin in unknown {
        let name = plain(&pin);
        if let Some(kind) = p
            .changes
            .iter()
            .map(|c| &c.kind)
            .chain(p.added.iter().map(|(k, _)| k))
            .find(|k| name == k.as_str() || name == format!("{k}_activity"))
        {
            p.refused.push(format!(
                "entries.kind-unpaired: {kind}: the world's {pin} would have no definition"
            ));
        }
    }
    Ok(p)
}

/// An added entry's file in the world's entries, as a seed names it: `<namespace>.<name>.json`.
fn added_file(kind: &str) -> String {
    format!("{}.json", kind.replace(':', "."))
}

/// Copies the folder `from` to `to`, each folder and file with its mode and owned by `uid`:`gid` (as root, the
/// release, the world's account keeps its files; as that account, they already are its).
fn copy_owned(from: &Path, to: &Path, uid: u32, gid: u32) -> R<()> {
    std::fs::create_dir_all(to).map_err(io(to))?;
    let mode = std::fs::metadata(from).map_err(io(from))?.permissions();
    std::fs::set_permissions(to, mode).map_err(io(to))?;
    let _ = std::os::unix::fs::chown(to, Some(uid), Some(gid));
    for e in std::fs::read_dir(from).map_err(io(from))? {
        let e = e.map_err(io(from))?;
        let (p, t) = (e.path(), to.join(e.file_name()));
        if p.is_dir() {
            copy_owned(&p, &t, uid, gid)?;
        } else {
            std::fs::copy(&p, &t).map_err(io(&t))?;
            let _ = std::os::unix::fs::chown(&t, Some(uid), Some(gid));
        }
    }
    Ok(())
}

/// The world's whole entries with `p`'s changes, as `<dir>/entries.next`: built beside it, then renamed in.
fn stage(dir: &Path, p: &Plan) -> R<PathBuf> {
    let (live, next) = (dir.join("entries"), dir.join(ENTRIES_NEXT));
    let building = dir.join(format!(".{ENTRIES_NEXT}.new"));
    let meta = std::fs::metadata(&live).map_err(io(&live))?;
    let _ = std::fs::remove_dir_all(&building);
    copy_owned(&live, &building, meta.uid(), meta.gid())?;
    for c in &p.changes {
        let at = building.join(c.path.strip_prefix(&live).map_err(|e| e.to_string())?);
        // Over the copy: its mode and owner stay the world's file's.
        std::fs::write(&at, c.new.to_json()).map_err(io(&at))?;
        std::fs::File::open(&at)
            .and_then(|f| f.sync_all())
            .map_err(io(&at))?;
    }
    for (kind, entry) in &p.added {
        let at = building.join(added_file(kind));
        std::fs::write(&at, entry.to_json()).map_err(io(&at))?;
        let _ = std::os::unix::fs::chown(&at, Some(meta.uid()), Some(meta.gid()));
        std::fs::File::open(&at)
            .and_then(|f| f.sync_all())
            .map_err(io(&at))?;
    }
    let _ = std::fs::remove_dir_all(&next);
    std::fs::rename(&building, &next).map_err(io(&next))?;
    Ok(next)
}

/// `worldd entries plan|stage --dir <world> --kinds <dir>`.
pub fn run(args: &[String]) -> i32 {
    let usage = "usage: worldd entries plan|stage --dir <world folder> --kinds <content/kinds>";
    let (Some(act), Some(dir), Some(kinds)) = (
        args.get(2).map(String::as_str),
        arg(args, "--dir"),
        arg(args, "--kinds"),
    ) else {
        eprintln!("{usage}");
        return 2;
    };
    if act != "plan" && act != "stage" {
        eprintln!("{usage}");
        return 2;
    }
    let dir = Path::new(dir);
    let world = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("world")
        .to_owned();
    // A stage replaces what an earlier one left: only this release's entries go with this release's deploy.
    if act == "stage" {
        let _ = std::fs::remove_dir_all(dir.join(ENTRIES_NEXT));
    }
    let p = match plan(dir, Path::new(kinds)) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("worldd entries: {world}: {e}");
            return 1;
        }
    };
    if let Some(why) = p.kept {
        println!("entries: {world}: kept: {why}");
        return 0;
    }
    for c in &p.changes {
        println!(
            "entries: {world}: change {} {}..{} ({})",
            c.kind,
            rev(&c.old),
            rev(&c.new),
            c.path.file_name().and_then(|n| n.to_str()).unwrap_or("")
        );
    }
    if !p.own.is_empty() {
        println!(
            "entries: {world}: the world's own, not in the release, kept: {}",
            p.own.join(" ")
        );
    }
    for (kind, entry) in &p.added {
        println!(
            "entries: {world}: add {kind} {} ({})",
            rev(entry),
            added_file(kind)
        );
    }
    if !p.overridden.is_empty() {
        println!(
            "entries: {world}: the world's own entry of the same name overrides, not added: {}",
            p.overridden.join(" ")
        );
    }
    if !p.refused.is_empty() {
        for r in &p.refused {
            let (name, why) = r.split_once(": ").unwrap_or((r, ""));
            println!("refused: {name}: {world}: {why}");
        }
        println!(
            "entries: {world}: refused, nothing changed ({} would change, {} would be added, {} unchanged)",
            p.changes.len(),
            p.added.len(),
            p.unchanged
        );
        return 3;
    }
    if act == "plan" || (p.changes.is_empty() && p.added.is_empty()) {
        println!(
            "entries: {world}: {} would change, {} would be added, {} unchanged ({})",
            p.changes.len(),
            p.added.len(),
            p.unchanged,
            if act == "plan" {
                "plan: nothing changed"
            } else {
                "nothing to stage"
            }
        );
        return 0;
    }
    match stage(dir, &p) {
        Ok(next) => {
            println!(
                "entries: {world}: {} changed and {} added staged, {} unchanged, in {} (the deploy swaps them in at \
                 its restart)",
                p.changes.len(),
                p.added.len(),
                p.unchanged,
                next.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(ENTRIES_NEXT)
            );
            0
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(dir.join(ENTRIES_NEXT));
            eprintln!("worldd entries: {world}: not staged: {e}");
            1
        }
    }
}
