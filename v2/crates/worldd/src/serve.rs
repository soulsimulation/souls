//! One process runs a real world (Engine v2 C1, #3365): `worldd seed` makes a world folder from a loader's facts
//! file, and `worldd serve` runs it behind the gateway, as `supervisor launch` starts it.
//!
//! **The world folder** (`seed` writes it; everything after is the world's own):
//!
//! - `world.json`: `{"format": "souls/world/1", "name", "souls": [[counter, x mm, z mm], ...], "souls_scope"}`. The
//!   name is the world's instance name, `<lineage hex>-<zone scope hex>-<zone counter>` (`worldd@<name>`).
//! - `facts.json`: the facts file N1's exporter wrote (`v2/tools/import-eden`, or X6's `v2/tools/import-world` for a
//!   live world). The world as built is read from it at each start: its header and the walkers' town.
//! - `entries/`: the Soul Actions entries (`souls-entry/1`), one file each, read into the checkers' rules by kind.
//!   `moves.json`, when there, is each move's reach (`{<move>: {reach_mm}}`).
//! - `log`: K4's log. Its first record is the import's part, every node and link the loader committed, so the log
//!   holds the world from empty and a stream written from it draws the whole world.
//! - `checkpoints/`: K5's, taken by K18c's rule; a start resumes from the newest that verifies.
//! - `tokens`: the gateway's tokens file, `<grant> <sha-256 hex>` per Soul, never a token. `souls.tokens` (mode 0600)
//!   holds the Souls' tokens themselves, for a local client; it is never copied off the machine.
//! - `views/`: V1's stream of the zone's root (full, everyone), written by a view tier of the process's own, and
//!   `views/world.json`, `{"stream": "views/<its folder>/", "history": "history/"}`, both relative to the world's
//!   folder (history is V3's, not written here yet), which the page reads for `?world=`.
//! - `gateway.sock`: the gateway's local socket (I1's framing, `answers::serve`), unless `--socket` or
//!   `$WORLDD_SOCKET` names another (a placed world's: a socket's path is at most 108 bytes, and a world folder's
//!   name is 67). `health.json`: O4's.
//!
//! **A start** reads the log through once (its records feed the stream from record 0), then hands it to K18's loop
//! (`answers::start`), which restores the newest checkpoint and replays the records after it. It prints `worldd:
//! started at tick <n> state <hash>`: after a SIGKILL that hash is the last logged tick's (K18's A3), bodies included.
//! Each record the loop syncs comes back on [`answers::Config::synced`] and goes to the stream's tier, off the clock
//! thread. The Souls in `world.json` stand on the open ground at their places on a first start, where the log last had
//! them after it.
//!
//! **Off the machine** (O3b, #3458), when `--store <folder>` or `$WORLDD_STORE` names a store (O9's folder store; a
//! fleet's real store is not wired here): the world is claimed under `--machine <name>` (`$WORLDD_MACHINE`, default
//! `local`), its build pinned on a first claim. Each record on the disk and each checkpoint is shipped by O3's
//! shipper under that claim. A restart claims again ([`shipping::take_over`], as the ops tool's restart): the claim
//! starts at the directory's mark plus one, and the shipper takes the log's records from there, so the history read
//! from the store has every record once, in order. V3's archiver packs each tick's part (not the recorder's inputs,
//! numbered from 0 among the parts) under `h/<world name>/<lineage hex>/`, with the T6 header as `header`: the
//! bundles the page's history plays (`#w=<world name>&l=<lineage hex>&t=<µs>`, its files served under `s/`). The
//! day's bundle index is written again each time a bundle closes. A restart archives again from record 0: what was
//! stored is passed over when the same and written over when made from more records ([`Again`]).
//!
//! Not here: a G9 fork as a seed (a fork's checkpoint has no facts file for the walkers' town), joins and leaves
//! (C3), generic acts (C2).

// The process reads the wall clock once for the stream's anchor (V1 rule 5); the engine never does.
#![allow(clippy::disallowed_methods)]

use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};

use archive::{Archiver, Shared};
use directoryd::directory::Directory;
use directoryd::directory::store::{Object, Store, When};
use replica::apply::Replica;
use replica::bodies::{Class, Family, Resource};
use replica::effects::{Effect, Refusal};
use replica::encode::{Name, Value, encode, from_hex, to_hex};
use replica::ids::{Id, Scope, sha256};
use replica::pose::{Frame, Quat, Vec3};
use replica::rules::json::{self, Value as Json};
use replica::stream;
use replica::views::{Key, Level, Redactions};
use replica::world_model::{Audience, parse_kinds};
use sim::links::Doors;
use sim::log::{FileStore, Log};
use sim::recorder;
use sim::walk::town::Town;
use supervisor::folder::Folder;
use worldd::answers::{self, Config};
use worldd::bodies::{Bodies, Placed};
use worldd::checkers::Rules;
use worldd::shipping::{self, Item, Shipper, Wall};
use worldd::view_out::{self, Writer};
use worldd::views::Tier;

type R<T> = Result<T, String>;

/// The log's epoch.
const EPOCH: u64 = 1;
/// K5's checkpoint interval: one each 8 MiB of log (the bench constant, as `worldd fork`).
const EVERY: u64 = 8 << 20;
/// The stream writer's queue in the tier: deliveries it may fall behind by before it is handed a snapshot.
const BOUND: usize = 1 << 16;
/// Eden's zone, America/New_York (today's default, `apps/server/src/god/real-clock.ts`): standard time is UTC−5, and
/// from 2 AM on March's second Sunday to 2 AM on November's first it is UTC−4. Offsets are written to 2100.
const EST_US: i64 = -5 * HOUR_US;
const HOUR_US: i64 = 3_600_000_000;
const SKY_UNTIL_YEAR: i64 = 2100;

/// Today's sky on Eden's calendar: world time is the machine's clock (µs from the Unix epoch, [`answers::now`]), so the
/// civil origin is 0 and a day is 86,400 s; the weather is seeded from the world's lineage.
fn eden_sky(lineage: Scope) -> sim::daylight::Config {
    use replica::sky::{Calendar, DAY_US, days_from_civil};
    // The day number of the `n`th Sunday on or after day `d` (1970-01-01, day 0, was a Thursday).
    let sunday = |d: i64, n: i64| d + (7 - (d + 4).rem_euclid(7)) % 7 + 7 * (n - 1);
    let mut offsets = vec![(0, EST_US)];
    for y in 1970..=SKY_UNTIL_YEAR {
        let spring = sunday(days_from_civil(y, 3, 1), 2) * DAY_US + 2 * HOUR_US - EST_US;
        let autumn =
            sunday(days_from_civil(y, 11, 1), 1) * DAY_US + 2 * HOUR_US - (EST_US + HOUR_US);
        offsets.push((spring, EST_US + HOUR_US));
        offsets.push((autumn, EST_US));
    }
    let cal = Calendar {
        day_s: 86_400,
        origin: 0,
        offsets,
    };
    let mut seed = [0; 8];
    seed.copy_from_slice(&lineage.0[..8]);
    sim::daylight::Config::today(cal, u64::from_le_bytes(seed))
}

/// Souls stand this far apart along x on a first start, mm.
const APART_MM: i64 = 2_000;

fn refusal(e: Refusal) -> String {
    format!("{}: {}", e.name, e.detail)
}

fn arg<'a>(args: &'a [String], name: &str) -> Option<&'a String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|k| args.get(k + 1))
}

fn io(path: &Path) -> impl Fn(std::io::Error) -> String + '_ {
    move |e| format!("{}: {e}", path.display())
}

/// What a loader's facts file gives a world: its header, its import part, its walkers' town and ground.
struct Built {
    header: replica::effects::Header,
    part: Vec<u8>,
    town: Town,
    ground: Id,
    root: Id,
    /// The world's rules (T2), for the engine's own acts (C2).
    rules: replica::tree::Rules,
}

/// Loads a facts file (N1's or X6's) as the world as built.
fn build(facts: &str) -> R<Built> {
    let mut im = import_eden::load(facts)?;
    // R1's replica starts a zone's root as the header's `souls:place` kind (as stream-check's Eden): one here,
    // admitting what the loader's world admits, so the log replays onto an empty replica.
    im.rules.kinds.extend(
        parse_kinds(&format!(
            "{{1: \"souls:place\", 2: \"place\", 11: [\"{}\"]}}",
            import_eden::GROUND
        ))
        .map_err(|e| format!("the root's kind: {e:?}"))?,
    );
    let (root, ground) = match (im.nodes.get("world"), im.nodes.get("ground")) {
        (Some(r), Some(g)) => (*r, *g),
        _ => return Err("the facts have no world or no ground".into()),
    };
    let header = import_eden::header(root, &im.rules)?;
    let part = encode(&Value::Map(
        [
            (1, Value::Bytes(header.hash().to_bytes())),
            (
                2,
                Value::Array(im.effects.iter().map(Effect::to_value).collect()),
            ),
        ]
        .into(),
    ))
    .map_err(|e| e.to_string())?;
    let next = im.tree.to_state().next;
    let rules = im.rules.clone();
    let doors = Doors::new(header.clone(), im.rules, next);
    let town = Town::new(im.tree, ground, doors).map_err(|e| format!("the town: {e:?}"))?;
    Ok(Built {
        header,
        part,
        town,
        ground,
        root,
        rules,
    })
}

/// The world's instance name: `<lineage hex>-<zone scope hex>-<zone counter>`, the zone being the root.
fn instance(root: Id) -> String {
    let scope = to_hex(&root.scope().0);
    format!("{scope}-{scope}-{}", root.counter())
}

/// Every `souls-entry/1` file under `dir`, by kind.
fn entries(dir: &Path, out: &mut Vec<(String, Json)>) -> R<()> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(io(dir))?
        .filter_map(|e| Some(e.ok()?.path()))
        .collect();
    paths.sort();
    for p in paths {
        if p.is_dir() {
            entries(&p, out)?;
        } else if p.extension().is_some_and(|x| x == "json") {
            let text = std::fs::read_to_string(&p).map_err(io(&p))?;
            let Ok(v) = json::parse(&text) else { continue };
            if v.get("format").and_then(Json::str) != Some("souls-entry/1") {
                continue;
            }
            if let Some(kind) = v.get("kind").and_then(Json::str) {
                out.push((kind.to_owned(), v.clone()));
            }
        }
    }
    Ok(())
}

fn humanoid() -> R<Family> {
    let n = |s: &str| Name::new(s).ok_or_else(|| format!("a name: {s}"));
    let leg = |s: &str| -> R<Resource> {
        Ok(Resource {
            name: n(s)?,
            class: Class::Locomotion,
            slot: None,
        })
    };
    // Two hands, each holding in its slot of the body (B4): a form's press, take or put claims one (C2).
    let hand = |s: &str, slot: u64| -> R<Resource> {
        Ok(Resource {
            name: n(s)?,
            class: Class::Manipulator,
            slot: Some(slot),
        })
    };
    Ok(Family {
        name: n("souls:humanoid")?,
        resources: vec![
            leg("souls:leg-left")?,
            leg("souls:leg-right")?,
            hand("souls:hand-left", 1)?,
            hand("souls:hand-right", 2)?,
        ],
    })
}

/// `worldd seed --facts <facts.json> --dir <new folder> [--entries <dir>] [--souls <n>] [--at <x m>,<z m>]`: a world
/// folder from a loader's facts file, with `n` Souls (default 1) on the open ground from (x, z) (default 0,0).
pub fn seed(args: &[String]) -> i32 {
    match seed_in(args) {
        Ok(name) => {
            println!("seeded {name}");
            0
        }
        Err(e) => {
            eprintln!("worldd seed: {e}");
            1
        }
    }
}

fn seed_in(args: &[String]) -> R<String> {
    let (Some(facts), Some(dir)) = (arg(args, "--facts"), arg(args, "--dir")) else {
        return Err("usage: worldd seed --facts <facts.json> --dir <new folder> [--entries <dir>] [--souls <n>] \
                    [--at <x m>,<z m>]"
            .into());
    };
    let dir = PathBuf::from(dir);
    if dir.join("log").exists() {
        return Err(format!("world-exists: {} has a log", dir.display()));
    }
    let souls: u64 = arg(args, "--souls").map_or(Ok(1), |n| n.parse().map_err(|_| "--souls"))?;
    let (x, z) = match arg(args, "--at") {
        Some(at) => at
            .split_once(',')
            .and_then(|(x, z)| Some((x.trim().parse::<f64>().ok()?, z.trim().parse::<f64>().ok()?)))
            .ok_or("--at <x m>,<z m>")?,
        None => (0.0, 0.0),
    };
    let text = std::fs::read_to_string(facts).map_err(io(Path::new(facts)))?;
    let built = build(&text)?;
    std::fs::create_dir_all(dir.join("entries")).map_err(io(&dir))?;
    std::fs::write(dir.join("facts.json"), &text).map_err(io(&dir))?;
    if let Some(e) = arg(args, "--entries") {
        let mut found = Vec::new();
        entries(Path::new(e), &mut found)?;
        for (kind, v) in &found {
            let p = dir
                .join("entries")
                .join(format!("{}.json", kind.replace(':', ".")));
            std::fs::write(&p, v.to_json()).map_err(io(&p))?;
        }
        println!("entries: {}", found.len());
    }
    // The Souls: ids of a scope of their own (not the tree's minter's), a token each.
    let name = instance(built.root);
    let mut scope = [0u8; 16];
    scope.copy_from_slice(&sha256(format!("souls/worldd-seed/souls/{name}").as_bytes())[..16]);
    let (mut rows, mut hashes, mut secrets) = (Vec::new(), String::new(), String::new());
    let mut urandom = std::fs::File::open("/dev/urandom").map_err(|e| e.to_string())?;
    for k in 0..souls {
        let counter = k + 1;
        let (xm, zm) = (
            (x * 1000.0) as i64 + k as i64 * APART_MM,
            (z * 1000.0) as i64,
        );
        rows.push(format!("[{counter}, {xm}, {zm}]"));
        let mut secret = [0u8; 32];
        std::io::Read::read_exact(&mut urandom, &mut secret).map_err(|e| e.to_string())?;
        let grant = format!("soul-{}-{counter}", to_hex(&scope));
        let token = format!("{grant}.{}", to_hex(&secret));
        hashes.push_str(&format!("{grant} {}\n", to_hex(&sha256(token.as_bytes()))));
        secrets.push_str(&token);
        secrets.push('\n');
    }
    std::fs::write(dir.join("tokens"), hashes).map_err(io(&dir))?;
    let secret_path = dir.join("souls.tokens");
    std::fs::write(&secret_path, secrets).map_err(io(&secret_path))?;
    std::fs::set_permissions(&secret_path, std::fs::Permissions::from_mode(0o600))
        .map_err(io(&secret_path))?;
    // The log, its first record the import's part: the world from empty.
    let (mut log, _) =
        Log::open(FileStore::open(&dir.join("log")).map_err(refusal)?, EPOCH).map_err(refusal)?;
    let n = log.append(built.part).map_err(refusal)?;
    log.wait_durable(n + 1).map_err(refusal)?;
    drop(log.close());
    let meta = format!(
        "{{\"format\": \"souls/world/1\", \"name\": \"{name}\", \"souls_scope\": \"{}\", \"souls\": [{}]}}\n",
        to_hex(&scope),
        rows.join(", ")
    );
    std::fs::write(dir.join("world.json"), meta).map_err(io(&dir))?;
    Ok(name)
}

/// The Souls `world.json` names: (body, x mm, z mm).
fn souls(meta: &Json) -> R<Vec<(Id, i64, i64)>> {
    let scope: [u8; 16] = meta
        .get("souls_scope")
        .and_then(Json::str)
        .and_then(|h| from_hex(h).ok()?.try_into().ok())
        .ok_or("world.json: souls_scope")?;
    let int = |v: &Json| match v {
        Json::Int(n) => i64::try_from(*n).ok(),
        _ => None,
    };
    meta.get("souls")
        .and_then(Json::arr)
        .unwrap_or(&[])
        .iter()
        .map(|row| {
            let r = row.arr().unwrap_or(&[]);
            match (
                r.first().and_then(int),
                r.get(1).and_then(int),
                r.get(2).and_then(int),
            ) {
                (Some(c), Some(x), Some(z)) => Ok((
                    Id::new(Scope(scope), c as u64).ok_or("world.json: a soul's counter")?,
                    x,
                    z,
                )),
                _ => Err("world.json: a soul is [counter, x mm, z mm]".to_owned()),
            }
        })
        .collect()
}

/// The world's bodies: each Soul on the open ground, where the log last had it on a restart.
fn bodies(
    town: Town,
    ground: Id,
    souls: &[(Id, i64, i64)],
    placed: &Placed,
) -> Result<Bodies, Refusal> {
    let family = humanoid().map_err(|e| Refusal {
        name: "family",
        detail: e,
    })?;
    let frame = Frame {
        node: ground,
        slot: None,
    };
    let mut at = Vec::new();
    for (id, x, z) in souls {
        at.push(town.surfaces[&ground].place(
            *id,
            frame,
            Vec3::new(x * 1000, 0, z * 1000),
            Quat::IDENTITY,
        )?);
    }
    let mut b = Bodies::new(town, 50_000)?;
    for a in at {
        b.add_body_at(family.clone(), a, placed)?;
    }
    Ok(b)
}

type Bucket = Shared<Folder>;

/// The archive's store on a restart (O3b): V3's shelf starts from record 0 again and writes its bundles and indexes
/// as new. A create refused because the key exists is passed when the bytes are the same, and otherwise writes over
/// them (a day's index, or a window closed at a graceful stop, made again from more records).
#[derive(Clone)]
struct Again(Bucket);

impl Store for Again {
    fn get(&self, key: &str) -> Result<Option<Object>, Refusal> {
        self.0.get(key)
    }

    fn put(&self, key: &str, bytes: &[u8], when: When) -> Result<String, Refusal> {
        match self.0.put(key, bytes, when) {
            Err(e) if e.name == "precondition-failed" && when == When::Absent => {
                match self.0.get(key)? {
                    Some(o) if o.bytes == bytes => Ok(o.etag),
                    Some(o) => self.0.put(key, bytes, When::Is(&o.etag)),
                    None => self.0.put(key, bytes, When::Absent),
                }
            }
            r => r,
        }
    }
}

/// Where each record on the disk goes off the machine: the shipper, and the archiver (parts only, numbered among
/// the parts).
struct Off {
    ship: Sender<Item>,
    archive: Option<Sender<(u64, Vec<u8>)>>,
    parts: u64,
}

impl Off {
    fn take(&mut self, record: u64, bytes: &[u8], input: bool) {
        let acts = if input {
            0
        } else {
            replica::effects::Part::read(bytes).map_or(0, |p| p.effects.len() as u64)
        };
        let _ = self.ship.send(Item {
            record,
            bytes: bytes.to_vec(),
            acts,
            stakes: false,
        });
        if !input && let Some(a) = &self.archive {
            let _ = a.send((self.parts, bytes.to_vec()));
            self.parts += 1;
        }
    }
}

/// Reports a helper thread that stopped; the world goes on.
fn report<T: Send + 'static>(what: &'static str, h: std::thread::JoinHandle<Result<T, Refusal>>) {
    std::thread::spawn(move || match h.join() {
        Ok(Err(e)) => eprintln!("worldd: {what} stopped, the world goes on: {}", refusal(e)),
        Err(_) => eprintln!("worldd: {what} panicked, the world goes on"),
        Ok(Ok(_)) => {}
    });
}

/// V3's archiver on a thread of its own: each part as it comes, and the day's bundle index written again each time a
/// bundle closes, so a running world's bundles are found before its day ends.
fn archiving(
    mut a: Archiver<Again>,
    rx: Receiver<(u64, Vec<u8>)>,
) -> std::thread::JoinHandle<Result<(), Refusal>> {
    std::thread::spawn(move || {
        let mut indexed = a.shelf.writes.bundles;
        loop {
            match rx.recv_timeout(shipping::POLL * 20) {
                Ok((n, bytes)) => a.push(n, bytes)?,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return a.flush(),
            }
            if a.shelf.writes.bundles != indexed {
                a.shelf.flush()?;
                indexed = a.shelf.writes.bundles;
            }
        }
    })
}

/// Claims the world in the store at `root` and starts its shipper and archiver, handed the log's records read at the
/// start (numbered from `first`) from the claim's start on.
fn off_machine(
    root: &Path,
    machine: &str,
    built: &Built,
    name: &str,
    dir: &Path,
    first: u64,
    records: &[Vec<u8>],
) -> R<Off> {
    let store: Bucket = Shared(Arc::new(Folder::new(root.to_path_buf())));
    let machine = Name::new(machine).ok_or_else(|| format!("--machine {machine}: not a name"))?;
    let mut d = Directory::new(store, machine);
    let (lineage, zone) = (built.root.scope().0, built.header.zone);
    match d.world(&lineage, zone) {
        Err(e) if e.name == "record-missing" => {
            // The build pinned on a first claim: the launcher's hash (`$WORLDD_BUILD`), as a SHA-256 multihash.
            let pin = std::env::var("WORLDD_BUILD").unwrap_or_else(|_| "unpinned".to_owned());
            let mut build = vec![0x12, 0x20];
            build.extend_from_slice(&sha256(pin.as_bytes()));
            d.set_build(&lineage, zone, &build).map_err(refusal)?;
        }
        Err(e) => return Err(refusal(e)),
        Ok(_) => {}
    }
    let end = first + records.len() as u64;
    let claim = shipping::take_over(&mut d, &lineage, zone, first..end).map_err(refusal)?;
    let from = claim.takeover.from;
    println!(
        "shipping: epoch {} from record {from} of {end}",
        claim.takeover.epoch
    );
    let shipper = Shipper::open(
        d,
        claim,
        lineage,
        zone,
        built.header.stored(),
        from,
        Wall::start(),
    )
    .map_err(refusal)?
    .checkpoints(&dir.join("checkpoints"), shipping::CHECKPOINT_GAP_US);
    let (ship, _, h) = shipper.spawn();
    report("the shipper", h);
    let kind = built
        .header
        .kinds
        .iter()
        .find(|k| k.as_str().starts_with("souls:place@"))
        .cloned();
    let archive = match kind {
        Some(kind) => {
            // A store of its own at the history's folder: the day's index names each bundle by its key, which the
            // page reads relative to that folder.
            let at = root.join("h").join(name).join(to_hex(&lineage));
            let again = Again(Shared(Arc::new(Folder::new(at))));
            again
                .put("header", built.header.stored(), When::Absent)
                .map_err(refusal)?;
            let a = Archiver::open(again, "", &built.header, zone, kind).map_err(refusal)?;
            let (tx, rx) = channel();
            report("the archiver", archiving(a, rx));
            Some(tx)
        }
        None => {
            eprintln!("worldd: the header names no souls:place root; the history is not archived");
            None
        }
    };
    let mut off = Off {
        ship,
        archive,
        parts: 0,
    };
    for (k, bytes) in records.iter().enumerate() {
        let record = first + k as u64;
        let input = recorder::is_input(bytes);
        if record >= from {
            off.take(record, bytes, input);
        } else if !input {
            // Shipped before; archived again from 0 (the archiver passes over what it holds).
            if let Some(a) = &off.archive {
                let _ = a.send((off.parts, bytes.clone()));
            }
            off.parts += 1;
        }
    }
    Ok(off)
}

/// `worldd serve --dir <world folder> [--socket <path>] [--checkpoint-every <bytes>] [--store <folder>] [--machine
/// <name>]`: runs the world until killed. A checkpoint is taken each `--checkpoint-every` bytes of log (default 8 MiB).
pub fn run(args: &[String]) -> i32 {
    match serve(args) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("worldd serve: {e}");
            1
        }
    }
}

fn serve(args: &[String]) -> R<()> {
    let dir = PathBuf::from(arg(args, "--dir").ok_or(
        "usage: worldd serve --dir <world folder> [--socket <path>] [--checkpoint-every <bytes>] [--store <folder>] \
         [--machine <name>]",
    )?);
    let socket = arg(args, "--socket")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("WORLDD_SOCKET").map(PathBuf::from))
        .unwrap_or_else(|| dir.join("gateway.sock"));
    let meta_path = dir.join("world.json");
    let meta = json::parse(&std::fs::read_to_string(&meta_path).map_err(io(&meta_path))?)?;
    if meta.get("format").and_then(Json::str) != Some("souls/world/1") {
        return Err("world.json is not souls/world/1".into());
    }
    let souls = souls(&meta)?;
    let facts = dir.join("facts.json");
    let built = build(&std::fs::read_to_string(&facts).map_err(io(&facts))?)?;
    let name = instance(built.root);
    let mut kinds = Vec::new();
    if dir.join("entries").is_dir() {
        entries(&dir.join("entries"), &mut kinds)?;
    }
    let moves = match std::fs::read_to_string(dir.join("moves.json")) {
        Ok(t) => json::parse(&t)?,
        Err(_) => Json::Obj(Vec::new()),
    };
    println!(
        "world {name}: {} entries, {} souls",
        kinds.len(),
        souls.len()
    );
    let rules = Rules {
        kinds: Json::Obj(kinds),
        moves,
    };
    // The log read through once: its records feed the stream from record 0; then the loop opens it.
    let log_path = dir.join("log");
    let (log, found) =
        Log::open(FileStore::open(&log_path).map_err(refusal)?, EPOCH).map_err(refusal)?;
    let store = log.close();
    let bucket = arg(args, "--store")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("WORLDD_STORE").map(PathBuf::from));
    let mut off = match bucket {
        Some(root) => {
            let machine = arg(args, "--machine")
                .cloned()
                .or_else(|| std::env::var("WORLDD_MACHINE").ok())
                .unwrap_or_else(|| "local".to_owned());
            Some(off_machine(
                &root,
                &machine,
                &built,
                &name,
                &dir,
                found.first,
                &found.records,
            )?)
        }
        None => None,
    };
    let (tx, synced) = channel();
    let mut cfg = Config::new(built.root.scope(), EPOCH);
    let every = arg(args, "--checkpoint-every").map_or(Ok(EVERY), |n| {
        n.parse::<u64>().map_err(|_| "--checkpoint-every <bytes>")
    })?;
    cfg.checkpoints = Some((dir.join("checkpoints"), every));
    cfg.health = Some(dir.join("health.json"));
    cfg.synced = Some(tx);
    // E6's day, night and weather on Eden's calendar, written at the first tick of a world whose node holds none (C5).
    cfg.sky = Some(eden_sky(built.root.scope()));
    // The engine's own acts (C2): the world's rules; no activity kinds are loaded from a world folder yet.
    cfg.engine = Some((built.rules.clone(), Vec::new()));
    let (town, ground) = (built.town, built.ground);
    cfg.bodies = Some(Box::new(move |placed: &Placed| {
        bodies(town, ground, &souls, placed)
    }));
    let empty = Replica::start(built.header.stored()).map_err(refusal)?;
    let world = answers::start(empty.frozen(), rules, store, cfg).map_err(refusal)?;
    println!(
        "restart: checkpoint {:?}, {} records read, {} applied",
        world.restart.checkpoint, world.restart.read, world.restart.applied
    );
    let door = world.door();
    crate::watchdog::watch(
        world.beat.clone(),
        crate::watchdog::Real::start(),
        crate::watchdog::LIMIT_MS,
    );
    // The stream: a tier of its own from the empty world, every record from 0, then each the loop syncs.
    let views = dir.join("views");
    let _ = std::fs::remove_dir_all(&views);
    let key = Key {
        node: built.header.zone,
        level: Level::Full,
        audience: Audience::Everyone,
    };
    let tier = Arc::new(
        Tier::start(
            built.header.clone(),
            empty.tree().to_state(),
            Redactions::new([]),
            world.durable,
        )
        .map_err(refusal)?,
    );
    let sub = tier.subscribe(vec![key], BOUND);
    let now = answers::now();
    let writer =
        Writer::create(&views, &built.header, &key, (now, (now / 1000) as u64)).map_err(refusal)?;
    let pointer = format!(
        "{{\"stream\": \"views/{}/\", \"history\": \"history/\"}}\n",
        stream::dir(&built.header, &key)
    );
    view_out::write_whole(&views.join("world.json"), pointer.as_bytes()).map_err(refusal)?;
    let writing = view_out::follow(writer, sub, Arc::new(AtomicBool::new(false)), answers::now);
    for (k, bytes) in found.records.into_iter().enumerate() {
        if !recorder::is_input(&bytes) {
            tier.offer(found.first + k as u64, bytes);
        }
    }
    let fed = Arc::clone(&tier);
    std::thread::Builder::new()
        .name("synced".into())
        .spawn(move || {
            for s in synced {
                if let Some(o) = &mut off {
                    o.take(s.record, &s.bytes, s.input);
                }
                if !s.input {
                    fed.offer(s.record, s.bytes);
                }
            }
        })
        .map_err(|e| e.to_string())?;
    std::thread::spawn(move || match writing.join() {
        Ok(Err(e)) => eprintln!(
            "worldd: the stream stopped, the world goes on: {}",
            refusal(e)
        ),
        Err(_) => eprintln!("worldd: the stream writer panicked, the world goes on"),
        Ok(Ok(_)) => {}
    });
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).map_err(io(&socket))?;
    println!("listening {}", socket.display());
    crate::ready();
    for stream in listener.incoming().flatten() {
        let door = door.clone();
        std::thread::spawn(move || answers::serve(door, stream));
    }
    Ok(())
}
