//! One process runs a real world (Engine v2 C1, #3365): `worldd seed` makes a world folder from a loader's facts
//! file, and `worldd serve` runs it behind the gateway, as `supervisor launch` starts it.
//!
//! **The world folder** (`seed` writes it; everything after is the world's own):
//!
//! - `world.json`: `{"format": "souls/world/1", "name", "souls": [[counter, x mm, z mm], ...], "souls_scope",
//!   "entry": [x mm, z mm]}`. The name is the world's instance name, `<lineage hex>-<zone scope hex>-<zone counter>`
//!   (`worldd@<name>`); the entry is where Souls' bodies are born (C3), `seed`'s `--at`, unless `"arrival": "<place>"`
//!   (`seed --arrival`, `worldd arrival`) names a place of the facts: then they are born round the middle of its
//!   outline, facing it (Eden: `place-region-campus-quad`, round the quad's fountain). With
//!   `"creator": "<32 hex>-<n>"` (`seed --creator`, G7b #3477) the world takes that creator's edit intents (G1b),
//!   checked against its own kinds. `world.kinds` keeps the unchanged pinned kinds text and explicit
//!   `# souls-boot-body <full place kind>` and `# souls-boot-activity <full place kind> <full activity pin>`
//!   lines for the creator's local checks of the existing boot registrations and admissions. `activities.json`
//!   (written at each start, [`served_activities`]): the activities as this start serves them, which the gateway
//!   hands its clients with the entries.
//! - `facts.json`: the facts file N1's exporter wrote (`v2/tools/import-eden`, or X6's `v2/tools/import-world` for a
//!   live world). The world as built is read from it at each start: its rules and the walkers' town.
//! - `header`: the world's header (K16), as the seed built it: the one its log's parts name. Every start serves the
//!   world under it, never under one rebuilt from the build's code ([`own_header`], [`adopt`]). `header.kinds`: the
//!   owner of each kind it pins, `<full pin> <owner>` a line.
//! - `stock.json` and `library/<name>.json` (#4837, `seed --stock`): what the world's containers hold and the libraries
//!   their yields carry by reference (`worldd::stock`), read at each start: a take from a stocked shelf makes a book
//!   with its title and first page. A world with none takes as before.
//! - `entries/`: the Soul Actions entries (`souls-entry/1`), one file each, read into the checkers' rules by kind.
//!   An entry whose `roles` name two or more roles is also an activity kind (C30, [`activity_kinds`]).
//!   `moves.json`, when there, is each move's reach (`{<move>: {reach_mm}}`).
//! - `log`: K4's log. Its first record is the import's part, every node and link the loader committed, so the log
//!   holds the world from empty and a stream written from it draws the whole world. Once compacted (`compactor`,
//!   #3837), the bytes before `log.cut` are a hole and the log is read from the cut.
//! - `checkpoints/`: K5's, taken by K18c's rule; a start resumes from the newest that verifies.
//! - `facts.courses`: the facts as a start uses them (punts' moorings, rides' courses, entries' kinds), kept by the
//!   first start and keyed by the facts' and entries' SHA-256; a later start with the same reads it instead of cutting
//!   a town for them (S5, [`courses_cached`]). Deleting it only makes the next start slower.
//! - `tokens`: the gateway's tokens file, `<grant> <sha-256 hex>` per Soul, never a token. `souls.tokens` (mode 0600)
//!   holds the Souls' tokens themselves, for a local client; it is never copied off the machine.
//! - `log.text/`: K16's text store, every word said in the world (O20b, #3523).
//! - `views/`: V1's stream of the zone's root (full, everyone), written by its off-clock canonical public observer, and
//!   `views/world.json`, `{"stream": "views/<its folder>/", "history": "history/"}`, both relative to the world's
//!   folder, which the page reads for `?world=` and pairing for the Soul's `history` (R16b, #3480). With a store,
//!   only public archive bundles/indexes are mirrored into `history/`; private bases/source remain in the Store.
//!   `history/live` is mutable public navigation metadata binding the instance/lineage to that exact full public stream.
//! - `gateway.sock`: the gateway's local socket (I1's framing, `answers::serve`), unless `--socket` or
//!   `$WORLDD_SOCKET` names another (a placed world's: a socket's path is at most 108 bytes, and a world folder's
//!   name is 67). `health.json`: O4's.
//!
//! **A start** reads the log through once from its cut (its records feed the stream from its own cursor), restores
//! the newest checkpoint and builds the towns and the views' hub from it and the records after it (#3837), then hands
//! the log to K18's loop (`answers::start`), which restores the same checkpoint and replays the same records. With no
//! checkpoint the log is read and replayed from record 0; a compacted log with none that verifies is refused
//! (`log-compacted-past-checkpoint`). It prints `worldd:
//! started at tick <n> state <hash>`: after a SIGKILL that hash is the last logged tick's (K18's A3), bodies included.
//! Each record the loop syncs comes back on [`answers::Config::synced`] and goes to the public observer, off the clock
//! thread. No body stands on a first start; after it, each body the log has stands where the log last had it.
//! `world.json`'s Souls are their tokens' grants (`souls.tokens`), born as any Soul is. A start with no
//! `views/world.json` waits at most 10 s for its public stream's first flush; a stream still rebuilding a long history
//! then (a rehearsal's scratch copy) or held by a stalled store finishes after the world listens, its health
//! `stream` `recovering` until it serves: with no pointer while a stalled store holds it, and while a long history is
//! rebuilt with a pointer that names the stream still being written.
//!
//! **Joins and leaves** (C3, #3367): no Soul stands in the world until it acts. A Soul's first intent, sent with
//! its token through the gateway, births its body by K10 (`answers::Join`): a `souls:body` node on the open ground by
//! the world's entry (`world.json`'s `entry`), linked to its Soul. `life:join` names it
//! (words 1 and 2: its name and description); `life:leave` retires it. A restart stands each body where the log last
//! had it, and its Soul finds it again by its link. A token the directory pairs later is added to `tokens` and the
//! gateway reads the file again: no restart. An owner's retire, or a name or description saved on the Soul's page,
//! reaches the world by the directory's Souls file (W11b, `worldd::directory`), `tokens.souls` beside `tokens` unless
//! `--directory <file>` names another: read at the start and whenever it changes, it retires the body or names it.
//!
//! **Seats** (C17, #3453). A start registers the seats the world's entries declare on its things for the gateway's sit,
//! lie and rise and a form's sit ([`places`]): every slot admitting a body that a thing's kind's entry declares is a
//! seat (a sofa's three, a bed's two; C19, #3457), its point carried up the tree onto the floor a body stands on.
//! It prints `places to sit or lie: <n> registered on <things> things; <all> body slots declared; <left> with no floor;
//! <bare> on things with no slots of their own; <beyond> past a thing's own slots; <moved> stand points moved to clear
//! ground`: every declared slot is registered or counted under one reason (#4092). A thing that borrows another kind's
//! entry sits at its own slots of those numbers, so the entry's seats its def has no slot for are not offered (a Mars
//! toilet whose def bakes no slots, a one-seat tier naming the two-seat `eden:bench`); each such thing is printed
//! before the line, `body slot not on the thing: <thing> slot <n> of <entry>; its own slots: <n>|none`. A stand point a body cannot stand on is moved to the nearest clear ground
//! within a form's reach (C15's rule), so a rise sets the body down where it can stand. So is one in a doorway's
//! clearance, where the spot tables never stop a walker (a bed beside its room's door): moved to the nearest place out
//! of it, no nearer the seat, so a walk to the seat ends within the sit's or the lie's reach.
//!
//! **Off the machine** (O3b, #3458), when `--store <store>`, `$WORLDD_STORE` or the directory's `$DIRECTORY_STORE_URL`
//! names a store (O3c, #3529: the offsite bucket, `s3:https://<host>/<bucket>[/<prefix>]` with its keys in `AWS_*`, or
//! O9's folder store, `folder:<path>` or a path; `supervisor::bucket`): the world is claimed under `--machine <name>` (`$WORLDD_MACHINE`, default
//! `local`), its build pinned on a first claim. Each record on the disk and each checkpoint is shipped by O3's
//! shipper under that claim. A restart claims again ([`shipping::take_over`], as the ops tool's restart): the claim
//! starts at the directory's mark plus one, and the shipper takes the log's records from there. A fork's archive
//! binds its captured private K5 base and all physical records, validated inputs included; its immutable ranges
//! continue across restart and Store-only restore. Legacy archives retain part-only numbering. The validated
//! header, immutable public bundles and mutable public indices are mirrored under the existing `history/` export.
//! Private base/source/head/ranges never enter that export; an immutable key may be reused only for identical bytes
//! ([`Again`]).
//!
//! **Activities** (C30, #3556): the engine's acts (C2) run with the conversation's kind (E26,
//! `replica/fixtures/activities/conversation.diag`) and an activity kind for each entry whose `roles` name two or
//! more roles, `<entry kind>_activity`; each is pinned in the header and the open ground takes it as a child, so an
//! offer or a proposal on the ground (where bodies are born) makes its node there. The entry's own thing takes it as a
//! child too (B10, #4239): one offered or proposed at the thing is the thing's, and each member holds its role's link
//! (the entry's link of the role's name) on the thing while it is a member (`sim::activity`). Its entry's slots that admit a
//! thing are its slots, numbered as the entry numbers them, so a carry's load rides its first (0.135 C4,
//! `content/kinds/construction/carry.json`). A start prints `activities: <plain names>`.
//! **Its creator** (G1e, #3532): with a store, the world's one creator is the one its record in the directory names
//! (the list's row for its lineage and zone, then that name's record, `directoryd::worlds::list::creator_of`), read
//! at the start and again every 30 s. Only that creator's edits are taken, each judged by G2's rule on the town before
//! it commits (`answers`'s edit checker); every other actor's, and every edit while the record names none, is refused
//! `edit.not-the-creator`. Without a store, only an explicit `world.json` creator may edit a standalone seeded world.
//!
//! Not here: a G9 fork as a seed (a fork's checkpoint has no facts file for the walkers' town).

// The process reads the wall clock once for the stream's anchor (V1 rule 5); the engine never does.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::io::Write as _;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(test)]
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};

use archive::{Archiver, Base as ArchiveBase, Shared};
use directoryd::accounts::principal_text;
use directoryd::directory::Directory;
use directoryd::directory::store::{Object, Store, When};
use directoryd::worlds::list::creator_of as directory_creator_of;
use replica::activity::{ActivityKind, Role, RoleLink};
use replica::apply::Replica;
use replica::bodies::{Class, Family, Resource, Want};
use replica::edit::World as Editing;
use replica::effects::{Effect, Header, Refusal, fixture_bytes};
use replica::encode::{Name, Value, decode, encode, from_hex, to_hex};
use replica::ids::{Id, Scope, sha256};
use replica::moves::Move;
use replica::pose::{Frame, Vec3};
use replica::rules::json::{self, Value as Json};
use replica::stream;
use replica::time::{Mapping, TimeEffect};
#[cfg(test)]
use replica::views::Redactions;
use replica::views::{Key, Level};
use replica::world_model::{Audience, Kind, parse_kinds, plain};
use sim::links::Doors;
use sim::log::{FileStore, Log};
use sim::recorder;
use sim::slots::PlaceAt;
use sim::walk::town::Town;
use supervisor::bucket::{Patient, Under, patiently};
use worldd::answers::{self, Config, Join};
use worldd::bodies::{Bodies, Placed};
use worldd::buildsafe::Creator;
use worldd::checkers::Rules;
use worldd::measures;
use worldd::shipping::{self, Item, Shipper, Wall};
use worldd::view_out;
#[cfg(test)]
use worldd::view_out::Writer;
#[cfg(test)]
use worldd::views::Tier;

type R<T> = Result<T, String>;

/// The log's epoch.
const EPOCH: u64 = 1;

/// When `serve` began (#3672): its start-up stages print their elapsed time from here. Unset outside `serve`, so
/// `seed` and template checks print nothing.
static STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// One start-up stage's elapsed-time stamp (#3672), only while `serve` starts; each is progress (#4013).
fn stamp(stage: &str) {
    if let Some(t) = STARTED.get() {
        println!("start-up: {stage} at {} ms", t.elapsed().as_millis());
        crate::progress();
    }
}
/// K5's checkpoint interval: one each 8 MiB of log (the bench constant, as `worldd fork`).
const EVERY: u64 = 8 << 20;
/// How long a world with no public pointer waits for its stream's first flush before it listens with the stream still
/// recovering. A new world's first flush takes well under a second; a long history rebuilt from record 0 (Eden's
/// rehearsal copy, 77k records: over 600 s) or a stalled store never holds the world's start.
const STREAM_FIRST_WITHIN: std::time::Duration = std::time::Duration::from_secs(10);
/// R12: the waits after each refused recovery of the public stream, ms; the last repeats until it serves.
const STREAM_RETRY_MS: [u64; 7] = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];

/// R17: a start's claim or archive open refused for a reason other than a store that does not answer (R18: or the
/// shipper's refused push while the world runs). The process
/// ends with it by name (`worldd serve: <refusal>`, exit 1) as a refused start did before; the unit restarts it.
fn refused_at_start(e: Refusal) -> ! {
    // R18: start-up errors are written so that a closed stderr cannot panic the thread that says them.
    let _ = writeln!(std::io::stderr(), "worldd serve: {}", refusal(e));
    std::process::exit(1)
}

/// R18: the shipping thread (the claim, then the forwarding of records) or the shipper's own thread panicked. Before
/// the claim the world would serve unclaimed and its archive wait for ever (`held`); after it nothing would ship, the
/// marks would freeze, the log would grow for ever and acts with stakes would wait for ever. The process ends by name,
/// `worldd serve: shipping-panicked: <message>`, exit 1, and the unit restarts it.
fn shipping_panicked(panic: &(dyn std::any::Any + Send)) -> ! {
    let said = panic
        .downcast_ref::<&str>()
        .map(|s| (*s).to_owned())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_default();
    let _ = writeln!(std::io::stderr(), "worldd serve: shipping-panicked: {said}");
    std::process::exit(1)
}

/// R17: waits until the world's claim is held (`claimed`, set by the shipping thread), so the archive publishes
/// nothing for a world whose claim the store has not yet given.
fn held(claimed: &std::sync::atomic::AtomicBool) {
    while !claimed.load(std::sync::atomic::Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// R17: one of the start's reads of the store, tried until the store answers. While it answers `store-unreachable`
/// (no answer in time, or a 5xx), `gauge` says `degraded` with the fault and the next try, after each of
/// [`STREAM_RETRY_MS`] (the last repeats), and the start's progress is said meanwhile: never an exit on a slow store,
/// so never a crash loop. Any other answer is `f`'s at once; `gauge` then says `current`, or `stopped` with the fault.
fn until_answered<T>(
    what: &str,
    gauge: &'static measures::Stream,
    mut f: impl FnMut() -> Result<T, Refusal>,
) -> Result<T, Refusal> {
    let mut tries = 0u64;
    // R18: every unanswered try the gauge is told of, the patient read's and this loop's, counted once.
    let unanswered = std::rc::Rc::new(std::cell::Cell::new(0u64));
    loop {
        // R18: `degraded` from a patient read's first unanswered try, so a long run of them (a rate-limited store)
        // names its fault in health.json, not only `recovering`.
        let counted = std::rc::Rc::clone(&unanswered);
        let tried = supervisor::bucket::waiting_says(
            move |e, wait| {
                counted.set(counted.get() + 1);
                gauge.degraded(&refusal(e.clone()), counted.get(), wait.as_millis() as u64);
            },
            &mut f,
        );
        match tried {
            Err(e) if e.name == "store-unreachable" => {
                tries += 1;
                // R18: a rate-limited store's `Retry-After`, when longer, bounded.
                let after = directoryd::directory::store::retry_after(&e)
                    .map_or(0, |d| d.as_millis() as u64);
                let wait =
                    STREAM_RETRY_MS[(tries as usize - 1).min(STREAM_RETRY_MS.len() - 1)].max(after);
                let fault = refusal(e);
                unanswered.set(unanswered.get() + 1);
                gauge.degraded(&fault, unanswered.get(), wait);
                let _ = writeln!(
                    std::io::stderr(),
                    "worldd: {what} waits for the store: {fault}; try {tries} unanswered, the next in {wait} ms"
                );
                for _ in 0..wait / 100 {
                    crate::progress();
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
            Ok(v) => {
                gauge.current();
                if tries > 0 {
                    let _ = writeln!(
                        std::io::stderr(),
                        "worldd: {what}: the store answered after {tries} unanswered tries"
                    );
                }
                return Ok(v);
            }
            Err(e) => {
                gauge.stopped(&refusal(e.clone()));
                return Err(e);
            }
        }
    }
}
/// R15: how long a world going to sleep waits for its stream's backup, at most: under the sleep watch's 5 s wait for
/// the stream's answer (`sleep.rs` STREAM_WITHIN), with room for the sleeping pointer's own write.
const SLEEP_DRAIN: std::time::Duration = std::time::Duration::from_secs(3);
/// The stream writer's queue in the tier: deliveries it may fall behind by before it is handed a snapshot.
#[cfg(test)]
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

/// How often the world's record is read again for its creator (G1e).
const CREATOR_EVERY: std::time::Duration = std::time::Duration::from_secs(30);

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

/// What a loader's facts file gives a world: its header, its import part and its ground. Its walkers' town is built
/// by `serve` from the world as its log leaves it, once (#3672).
pub(crate) struct Built {
    header: replica::effects::Header,
    part: Vec<u8>,
    ground: Id,
    root: Id,
    /// The world's rules (T2), for the engine's own acts (C2).
    rules: replica::tree::Rules,
    /// The kind lines and boot body admissions the creator's client keeps (G7b, #3477).
    kinds_text: String,
    /// A Soul's body kind, its full name (C3).
    body_kind: String,
    /// The importer’s existing immutable name dictionary, shared once with the off-clock sync worker.
    public_names: Arc<worldd::views::names::PublicNames>,
    /// The activity kinds the engine runs (C30): the conversation's, then the entries'.
    activities: Vec<ActivityKind>,
    /// The world's stock (#4837): its stocked containers and its libraries' words, from its folder's `stock.json`.
    stock: worldd::stock::World,
}

/// The conversation's kind (E26, #3329), as its fixture writes it.
fn conversation() -> R<ActivityKind> {
    let bytes = fixture_bytes(include_str!(
        "../../replica/fixtures/activities/conversation.diag"
    ))
    .map_err(refusal)?;
    let v = decode(&bytes).map_err(|e| format!("the conversation's kind: {e:?}"))?;
    ActivityKind::from_value(&v.value).map_err(refusal)
}

/// The give's kind (0.133 R4), as its fixture writes it: an offer that hands a held thing over when accepted.
fn give() -> R<ActivityKind> {
    let bytes = fixture_bytes(include_str!("../../replica/fixtures/activities/give.diag"))
        .map_err(refusal)?;
    let v = decode(&bytes).map_err(|e| format!("the give's kind: {e:?}"))?;
    ActivityKind::from_value(&v.value).map_err(refusal)
}

/// The activity kinds a world's entries declare (C30, #3556): one for each entry whose `roles` (SA-G1a) name two or
/// more roles (B5 refuses a kind of one), `<entry kind>_activity`, pinned by the hash of its entry's roles. A role
/// is `<namespace>:<role>`, standing at its entry's first slot (`souls:here` when it has none) and claiming one hand,
/// so a member walks, sits and talks while it plays; an offer lapses after a minute and a leave takes at most 0.4 s,
/// as a conversation's. A role's `move` (0.134 T1) names a content move, `souls:<move>`, its member aims at the other
/// member when the activity starts. The `now` line (SA-G1b) is not a role.
pub fn activity_kinds(entries: &[(String, Json)]) -> R<Vec<ActivityKind>> {
    let mut by_kind = BTreeMap::new();
    for (kind, entry) in entries {
        let Some(roles) = entry.get("roles").and_then(Json::obj) else {
            continue;
        };
        let roles: Vec<_> = roles
            .iter()
            .filter(|(n, v)| n != "now" && v.obj().is_some())
            .collect();
        if roles.len() < 2 {
            continue;
        }
        let ns = kind.split_once(':').map_or("world", |(n, _)| n);
        let mut out = Vec::new();
        // 0.134 T3: a role's link's `most` is how many take it (a dance's offer, to several); `on_beat` puts its move
        // on the world's beat.
        let (mut most, mut beat, mut follows) = (0, false, None);
        for (role, v) in &roles {
            most += match entry
                .get("links")
                .and_then(|l| l.get(role))
                .and_then(|l| l.get("most"))
            {
                Some(Json::Int(n)) => usize::try_from(*n).map_err(|_| "a role's most")?,
                _ => 1,
            };
            beat |= v.get("on_beat") == Some(&Json::Bool(true));
            // 0.135 G2: the role that follows the other's member.
            if v.get("follows") == Some(&Json::Bool(true)) {
                follows = Some(Name::new(&format!("{ns}:{role}")).ok_or("a role's name")?);
            }
            // A role in the activity's own slots (`this`) is placed in its first; one near it (`here`) is not.
            let slot = v
                .get("places")
                .filter(|p| p.get("in").and_then(Json::str) == Some("this"))
                .and_then(|p| p.get("slots"))
                .and_then(Json::arr)
                .and_then(|s| s.first())
                .and_then(Json::str);
            let place = slot.map_or("souls:here".to_owned(), |s| format!("{ns}:{s}"));
            let mv = match v.get("move") {
                None => None,
                Some(m) => {
                    let m = m.str().ok_or("a role's move is a name")?;
                    Some(Name::new(&format!("souls:{m}")).ok_or("a role's move")?)
                }
            };
            // 0.135 G3: where its members stand, from its slots in the activity's own frame (a slot's stand point,
            // else the slot itself), mm to µm, in the order its places list them; and, for a role near the activity
            // (`here`), how near its middle a member is walked to its stand (`within_mm`).
            let mm = |v: Option<&Json>| match v {
                Some(Json::Int(n)) => i64::try_from(*n).ok().map(|n| n * 1000),
                _ => None,
            };
            let within = v.get("places").and_then(|p| mm(p.get("within_mm")));
            let stands = match v.get("places") {
                Some(p) => p
                    .get("slots")
                    .and_then(Json::arr)
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(Json::str)
                    .filter_map(|slot| {
                        let s = entry.get("slots")?.get(slot)?;
                        let at = s
                            .get("stand")
                            .and_then(Json::str)
                            .and_then(|n| entry.get("points")?.get(n))
                            .unwrap_or(s);
                        let a = at.get("at_mm")?.arr()?;
                        let yaw = match at.get("yaw_mdeg") {
                            Some(Json::Int(n)) => i64::try_from(*n).ok()?,
                            _ => 0,
                        };
                        Some((Vec3::new(mm(a.first())?, mm(a.get(1))?, mm(a.get(2))?), yaw))
                    })
                    .collect(),
                None => Vec::new(),
            };
            // B10 (#4239): a role is one of the entry's links (SA-G1a); a member holds it on the entry's own thing
            // while it is a member of an activity offered or proposed there.
            let link = match entry
                .get("links")
                .and_then(|l| l.get(role))
                .and_then(|l| l.get("from"))
                .and_then(Json::str)
            {
                Some(from @ ("body" | "soul")) => Some(RoleLink {
                    ty: Name::new(&replica::audience::link_type(kind, role))
                        .ok_or("a role's link")?,
                    soul: from == "soul",
                    on: kind.clone(),
                    most: match entry
                        .get("links")
                        .and_then(|l| l.get(role))
                        .and_then(|l| l.get("most"))
                    {
                        Some(Json::Int(n)) => u64::try_from(*n).ok(),
                        _ => None,
                    },
                }),
                _ => None,
            };
            out.push(Role {
                name: Name::new(&format!("{ns}:{role}")).ok_or("a role's name")?,
                place: Name::new(&place).ok_or("a role's place")?,
                claims: vec![Want::One(Class::Manipulator)],
                mv,
                stands,
                within,
                link,
            });
        }
        // 0.135 G3: the stands its roles resolve to (from the entry's slots and points) are part of what is pinned; a
        // kind whose roles name none keeps the pin of its roles alone.
        let stands = if out.iter().any(|r| !r.stands.is_empty()) {
            let role = |r: &Role| {
                r.stands
                    .iter()
                    .map(|(p, yaw)| format!("{},{},{},{yaw}", p.x, p.y, p.z))
                    .collect::<Vec<_>>()
                    .join(";")
            };
            format!(
                "/stands/{}",
                out.iter().map(role).collect::<Vec<_>>().join("|")
            )
        } else {
            String::new()
        };
        let pin = to_hex(&sha256(
            format!(
                "souls/activity/{kind}/{}{stands}",
                Json::Obj(roles.into_iter().cloned().collect()).to_json()
            )
            .as_bytes(),
        ));
        let name = Name::new(&format!("{kind}_activity@1220{pin}")).ok_or("an activity's name")?;
        by_kind.insert(
            kind.clone(),
            ActivityKind {
                name,
                revision: 1,
                roles: out,
                proposal_lasts: 60_000_000,
                leave_within: 400_000,
                most,
                beat,
                follows,
            },
        );
    }
    Ok(by_kind.into_values().collect())
}

/// Seats a thing's entry declares that its own shape has none of (#4092): a thing that borrows another kind's entry (a
/// Mars tier names `eden:bench`, a toilet `eden:toilet`) sits at its own slots of those numbers (field 13, its def's
/// geometry), so an entry seat it has no slot for is not offered (`import_eden::body_slots`).
#[derive(Debug, PartialEq, Eq)]
struct NotOnThing {
    thing: Id,
    /// The entry the thing names.
    entry: String,
    /// The entry's slots the thing does not offer, by number.
    slots: Vec<u64>,
    /// The thing's own slots, by number: none when its def has no slots at all.
    own: Vec<u64>,
}

/// Every [`NotOnThing`] in `tree`, by thing: the body slots `import_eden::body_slots` counts as declared and leaves
/// out, so `serve`'s seats line accounts for every declared slot.
fn not_on_things(tree: &replica::tree::Tree, kinds: &[(String, Json)]) -> Vec<NotOnThing> {
    let (found, _) = import_eden::body_slots(tree, kinds);
    let offered: std::collections::BTreeSet<(Id, u64)> =
        found.iter().map(|s| (s.thing, s.slot)).collect();
    // Each entry's body slots by number, read once: the entry read as its own kind's, so nothing is borrowed.
    let mut declared: BTreeMap<String, Vec<u64>> = BTreeMap::new();
    let mut out = Vec::new();
    let mut next = vec![tree.root()];
    while let Some(h) = next.pop() {
        next.extend(tree.children(h).unwrap_or(&[]));
        let Some(n) = tree.node(h) else { continue };
        let entry = import_eden::entry_name(n.kind().as_str(), n.fields());
        let all = declared.entry(entry.to_owned()).or_insert_with(|| {
            import_eden::body_slots_of(n.id(), entry, &BTreeMap::new(), kinds)
                .iter()
                .map(|s| s.slot)
                .collect()
        });
        let slots: Vec<u64> = all
            .iter()
            .copied()
            .filter(|s| !offered.contains(&(n.id(), *s)))
            .collect();
        if slots.is_empty() {
            continue;
        }
        let own = match n.fields().get(&import_eden::F_SLOTS) {
            Some(Value::Array(rows)) => rows
                .iter()
                .filter_map(|r| match r {
                    Value::Array(r) => match r.first() {
                        Some(Value::Uint(u)) => Some(*u),
                        _ => None,
                    },
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        out.push(NotOnThing {
            thing: n.id(),
            entry: entry.to_owned(),
            slots,
            own,
        });
    }
    out.sort_by_key(|t| t.thing);
    out
}

/// The served activities' file in a world's folder, beside `world.kinds`: `gatewayd --entries` serves it with the
/// entries (`v2/crates/gatewayd/src/entries.rs`).
pub const ACTIVITIES_FILE: &str = "activities.json";

/// The activities a start serves from its entries, as an agent decides from them (`souls-activities/1`): for each,
/// its entry's `kind`, the `name` it is served by (the engine's pin, the header's after [`adopt`]), its `word` (its
/// plain name with dashes), its `card` (the entry's card text), its `roles` and how many each takes, the role the
/// offerer plays (the first one member plays) and how many it asks; `near_m`, how close (m) two members stand for its
/// moves to reach, the shortest reach among its roles' moves (none: no distance is checked); and `at`, the kind of
/// thing it is played at when its entry plays it through forms (`crate::engine::at_its_thing`), else none: anywhere.
fn served_activities(entries: &[(String, Json)], kinds: &[ActivityKind], moves: &[Move]) -> Json {
    let by_kind: BTreeMap<&str, &Json> = entries.iter().map(|(k, e)| (k.as_str(), e)).collect();
    let entries_obj = Json::Obj(entries.to_vec());
    let mut out = Vec::new();
    for a in kinds {
        let Some(kind) = plain(a.name.as_str()).strip_suffix("_activity") else {
            continue;
        };
        let Some(entry) = by_kind.get(kind) else {
            continue;
        };
        let most = |r: &str| match entry
            .get("links")
            .and_then(|l| l.get(r))
            .and_then(|l| l.get("most"))
        {
            Some(Json::Int(n)) => *n,
            _ => 1,
        };
        let roles: Vec<(String, i128)> = a
            .roles
            .iter()
            .map(|r| {
                let n = r.name.as_str();
                (n.to_owned(), most(n.split_once(':').map_or(n, |(_, r)| r)))
            })
            .collect();
        let card = entry
            .get("card")
            .and_then(|c| c.get("text"))
            .and_then(Json::str)
            .and_then(|t| entry.get("text")?.get(t)?.str())
            .or_else(|| entry.get("text")?.get("card")?.str())
            .unwrap_or("");
        // A dance's moves are each at its own body (on the beat): the engine checks no distance at its accept.
        let reach = a
            .roles
            .iter()
            .filter(|_| !a.beat)
            .filter_map(|r| r.mv.as_ref())
            .filter_map(|mv| moves.iter().find(|m| m.name == *mv))
            .map(|m| m.reach)
            .min();
        // Offered (`activity:offer`) only as the engine takes an offer: a pair's kind, or a crew's three roles, the
        // third taken by several (`sim::activity::offer`); any other is proposed at its thing, and has no offerer.
        let crew = roles.len() == 3 && a.most > 3;
        let offerer = (roles.len() == 2 || crew)
            .then(|| {
                roles
                    .iter()
                    .take(2)
                    .find(|(_, m)| *m == 1)
                    .map(|(n, _)| n.clone())
            })
            .flatten();
        let asks: i128 = roles
            .iter()
            .filter(|(n, _)| Some(n) != offerer.as_ref())
            .map(|(_, m)| m)
            .sum();
        let mut o = vec![
            ("kind".to_owned(), Json::s(kind)),
            ("name".to_owned(), Json::s(a.name.as_str())),
            (
                "word".to_owned(),
                Json::s(&kind.rsplit(':').next().unwrap_or(kind).replace('_', "-")),
            ),
            ("card".to_owned(), Json::s(card)),
            (
                "roles".to_owned(),
                Json::Arr(
                    roles
                        .iter()
                        .map(|(n, m)| Json::object([("role", Json::s(n)), ("most", Json::Int(*m))]))
                        .collect(),
                ),
            ),
            ("asks".to_owned(), Json::Int(asks)),
        ];
        if let Some(r) = offerer {
            o.push(("offerer".to_owned(), Json::Str(r)));
        }
        if let Some(r) = reach {
            // µm to m, to the centimetre.
            o.push((
                "near_m".to_owned(),
                Json::Num(format!("{}.{:02}", r / 1_000_000, (r % 1_000_000) / 10_000)),
            ));
        }
        if let Some(at) = worldd::engine::at_its_thing(&entries_obj, &a.name) {
            o.push(("at".to_owned(), Json::s(at)));
        }
        out.push(Json::Obj(o));
    }
    Json::object([
        ("format", Json::s("souls-activities/1")),
        ("activities", Json::Arr(out)),
    ])
}

/// Loads a facts file (N1's or X6's) as the world as built, with the activity kinds of `entries` (C30).
/// The facts with today's rowing punts added (#3603): one moored on each standing water that has room
/// (`sim::courses::punts`), a thing of kind `core:rowing_punt` at its home, turned with its plank toward the bank, on its
/// own loop (its course). The same facts give the same punts, so a seed and every serve of the world agree.
///
/// With the facts' waters and terrain when it read them (S12): the punts change no ground, so [`with_rides`] reads them
/// from here rather than loading the facts again.
fn with_punts(facts: &str) -> R<(String, Option<Waters>)> {
    let im = import_eden::load(facts)?;
    let Some(&ground) = im.nodes.get("ground") else {
        return Ok((facts.to_owned(), None));
    };
    // Planks and exits only where a body can stand on the ground as the walk cuts it (C15's `stand_near`).
    let (waters, terrain) = sim::courses::punts::waters_of(&im.tree, ground)?;
    let root = *im.nodes.get("world").ok_or("the facts have no world")?;
    let header = import_eden::header(root, &im.rules)?;
    let next = im.tree.to_state().next;
    // On the start's threads (S12): the same town as on one.
    let mut town = Town::new_on(
        im.tree,
        ground,
        Doors::new(header, im.rules, next),
        sim::ground::START_THREADS,
    )
    .map_err(|e| format!("the town: {e:?}"))?;
    let view = town.view();
    let moorings = sim::courses::punts::moorings(&waters, terrain.as_ref(), |p| {
        view.stand_near(ground, p, 0, None).is_some()
    });
    if moorings.is_empty() {
        return Ok((facts.to_owned(), Some((waters, terrain))));
    }
    let mut f = json::parse(facts).map_err(|e| format!("the facts: {e:?}"))?;
    let Json::Obj(top) = &mut f else {
        return Err("the facts are not an object".into());
    };
    let int = |n: i64| Json::Int(i128::from(n));
    let obj =
        |kv: Vec<(&str, Json)>| Json::Obj(kv.into_iter().map(|(k, v)| (k.to_owned(), v)).collect());
    let kind = obj(vec![
        ("ref", Json::s(PUNT_REF)),
        ("hash", Json::s(&to_hex(&sha256(b"souls/rowing-punt/1")))),
        ("name", Json::s("core:rowing_punt")),
        ("form", Json::s("point")),
        ("layer", Json::s("solid")),
        ("door", Json::Bool(false)),
        ("mesh", Json::Bool(false)),
        ("slots", int(2)),
    ]);
    let things: Vec<Json> = moorings
        .iter()
        .enumerate()
        .map(|(k, m)| {
            // The plank (the kind's +x) toward the bank, `-out`: a yaw turns +x to (cos, -sin). Whole degrees, so no
            // platform's last bit changes it.
            let (ox, oz) = (m.out[0] as f64, m.out[1] as f64);
            let yaw = (oz.atan2(-ox).to_degrees().round() as i64).rem_euclid(360) * 1000;
            println!(
                "punt: rowing-punt-{} on {} at {:.3},{:.3} m, plank at {:.3},{:.3} m, loop {} us from {} us",
                k + 1,
                replica::world_model::show(m.water),
                m.home.x as f64 / 1e6,
                m.home.z as f64 / 1e6,
                m.door.x as f64 / 1e6,
                m.door.z as f64 / 1e6,
                m.course.load().map_or(0, |t| t.period),
                m.course.t0
            );
            let mm = |v: i64| int(v / 1000);
            let pose = Json::Arr(vec![mm(m.home.x), mm(m.home.y), mm(m.home.z), int(yaw)]);
            let stations = m
                .course
                .stations
                .iter()
                .map(|s| Json::Arr(vec![int(s.at.x), int(s.at.y), int(s.at.z), int(s.dwell)]))
                .collect();
            let shape = match m.course.shape {
                sim::courses::Shape::Loop => 1,
                sim::courses::Shape::ThereAndBack => 2,
                sim::courses::Shape::Once => 3,
            };
            // A rider's place: what the import reads of a slot (its number, point, yaw and capacity). What a body does
            // there comes from the punt's entry, not from here.
            let place = |n: i64, id: &str, x: i64| {
                obj(vec![
                    ("n", int(n)),
                    ("id", Json::s(id)),
                    ("at", Json::Arr(vec![int(x), int(360), int(0)])),
                    ("yaw", int(180_000)),
                    ("capacity", int(1)),
                ])
            };
            obj(vec![
                ("id", Json::Str(format!("e_punt{k}"))),
                ("def", Json::s(PUNT_REF)),
                ("ref", Json::s(PUNT_REF)),
                ("parent", Json::Null),
                ("pose", pose.clone()),
                ("world", pose),
                ("scale_ppm", int(1_000_000)),
                ("name", Json::Str(format!("rowing-punt-{}", k + 1))),
                (
                    "slots",
                    Json::Arr(vec![place(1, "rider_a", -650), place(2, "rider_b", 650)]),
                ),
                (
                    "course",
                    obj(vec![
                        ("stations", Json::Arr(stations)),
                        ("shape", int(shape)),
                        ("speed", int(m.course.speed)),
                        ("t0", int(m.course.t0)),
                        ("within", int(m.course.within)),
                    ]),
                ),
            ])
        })
        .collect();
    for (key, add) in [("kinds", vec![kind]), ("things", things)] {
        match top.iter_mut().find(|(k, _)| k == key) {
            Some((_, Json::Arr(a))) => a.extend(add),
            _ => return Err(format!("the facts have no '{key}' list")),
        }
    }
    Ok((f.to_json(), Some((waters, terrain))))
}

/// The open ground's standing and running waters and its terrain (`sim::courses::punts::waters_of`).
type Waters = (Vec<sim::ground::Water>, Option<sim::ground::Terrain>);

/// The water speed of a boat's entry, µm a second: its `vehicle` on `deep_water` (`content/kinds/vehicles`: a rowing
/// boat, a canoe), read from the entry's data, never its kind's name. `None` for anything else.
fn boat_speed(entry: &Json) -> Option<i64> {
    let v = entry.get("vehicle")?;
    if v.get("ground").and_then(Json::str) != Some("deep_water") {
        return None;
    }
    match v.get("speed_mm_s")? {
        Json::Int(n) => i64::try_from(*n).ok()?.checked_mul(1000).filter(|s| *s > 0),
        _ => None,
    }
}

/// The facts with a kind for each entry kind the facts do not already name, so a creator can place a thing of any
/// kind the world has an entry for, not only of the kinds its seeded things use (#1960). A thing's kind must be pinned
/// in the world's header to be placed or made, and a seeded world pins only the kinds of its things. Each added kind
/// is a point thing with no mesh (as #3703's made notice is, by the same ref and hash), so the same entries give the
/// same kinds and every start of the world builds the same header.
fn with_entry_kinds(facts: &str, entries: &[(String, Json)]) -> R<String> {
    let mut f = json::parse(facts).map_err(|e| format!("the facts: {e:?}"))?;
    let named: std::collections::BTreeSet<String> = f
        .get("kinds")
        .and_then(Json::arr)
        .unwrap_or(&[])
        .iter()
        .filter_map(|k| {
            k.get("name")
                .and_then(Json::str)
                .map(import_eden::kind_name)
        })
        .collect();
    let add: Vec<Json> = entries
        .iter()
        .map(|(k, _)| k.as_str())
        .filter(|k| !named.contains(*k) && Name::new(k).is_some())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .map(|k| {
            Json::Obj(
                [
                    ("ref", Json::s(&format!("made-{}@1", k.replace(':', "-")))),
                    (
                        "hash",
                        Json::s(&to_hex(&sha256(format!("souls/made/{k}").as_bytes()))),
                    ),
                    ("name", Json::s(k)),
                    ("form", Json::s("point")),
                    ("layer", Json::s("decor")),
                    ("door", Json::Bool(false)),
                    ("mesh", Json::Bool(false)),
                    ("slots", Json::Int(0)),
                ]
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v))
                .collect(),
            )
        })
        .collect();
    if add.is_empty() {
        return Ok(facts.to_owned());
    }
    let Json::Obj(top) = &mut f else {
        return Err("the facts are not an object".into());
    };
    match top.iter_mut().find(|(k, _)| k == "kinds") {
        Some((_, Json::Arr(a))) => a.extend(add),
        _ => return Err("the facts have no 'kinds' list".into()),
    }
    Ok(f.to_json())
}

/// The facts with the courses of the rides `entries` declare (#3691): each thing on the ground whose kind's entry has a
/// `ride` that flies a loop from its stop (`sim::courses::rides`, read from the ride's data, never its kind's name) gets
/// its course, over the terrain beneath it. The `k`th such thing in the facts' order starts its lap `k` minutes in, so
/// rides that stand together do not fly together. The same facts and entries give the same courses at every serve.
///
/// Boats too: each thing on the ground whose entry has a `vehicle` on `deep_water` ([`boat_speed`]: a rowing boat, a
/// canoe) and that floats where it stands (`sim::courses::punts::floating`) gets a course that stands at its mooring for
/// good, run at its entry's speed. That makes it a carrier a seated rider steers over the water (`carrier:steer`,
/// `worldd::carrier`) and lands back at that mooring, its landing, where riders board and get off. A boat on dry
/// ground gets none. `waters` are the facts' ground's waters and terrain when [`with_punts`] read them, else they are
/// read here.
fn with_rides(facts: &str, entries: &[(String, Json)], waters: Option<Waters>) -> R<String> {
    let rides: BTreeMap<&str, sim::courses::rides::Ride> = entries
        .iter()
        .filter_map(|(k, e)| Some((k.as_str(), sim::courses::rides::Ride::of(e)?)))
        .filter(|(_, r)| r.loops_aloft())
        .collect();
    let boats: BTreeMap<&str, i64> = entries
        .iter()
        .filter_map(|(k, e)| Some((k.as_str(), boat_speed(e)?)))
        .collect();
    if rides.is_empty() && boats.is_empty() {
        return Ok(facts.to_owned());
    }
    let (waters, terrain) = match waters {
        Some(w) => w,
        None => {
            let im = import_eden::load(facts)?;
            let Some(&ground) = im.nodes.get("ground") else {
                return Ok(facts.to_owned());
            };
            sim::courses::punts::waters_of(&im.tree, ground)?
        }
    };
    let mut f = json::parse(facts).map_err(|e| format!("the facts: {e:?}"))?;
    let Json::Obj(top) = &mut f else {
        return Err("the facts are not an object".into());
    };
    // A kind's name as the entries name it, by its def's ref.
    let names: BTreeMap<String, String> = top
        .iter()
        .find(|(k, _)| k == "kinds")
        .and_then(|(_, v)| v.arr())
        .unwrap_or(&[])
        .iter()
        .filter_map(|k| {
            Some((
                k.get("ref")?.str()?.to_owned(),
                import_eden::kind_name(k.get("name")?.str()?),
            ))
        })
        .collect();
    let int = |n: i64| Json::Int(i128::from(n));
    let num = |v: Option<&Json>| match v {
        Some(Json::Int(n)) => i64::try_from(*n).ok(),
        _ => None,
    };
    let Some((_, Json::Arr(things))) = top.iter_mut().find(|(k, _)| k == "things") else {
        return Err("the facts have no 'things' list".into());
    };
    let mut k = 0;
    for t in things.iter_mut() {
        let on_ground = matches!(t.get("parent"), None | Some(Json::Null));
        // The entry a thing names of its own (its world's map: Eden's launch balloon is an `eden:balloon`), else its
        // kind's, as `import_eden::entry_name` reads the thing.
        let own = t
            .get("entry")
            .and_then(Json::str)
            .map(|e| replica::world_model::plain(e).to_owned());
        let Some(entry) = own.or_else(|| {
            t.get("def")
                .and_then(Json::str)
                .and_then(|d| names.get(d))
                .cloned()
        }) else {
            continue;
        };
        let (ride, boat) = (rides.get(entry.as_str()), boats.get(entry.as_str()));
        if ride.is_none() && boat.is_none() {
            continue;
        }
        let Some([x, y, z]) = t
            .get("world")
            .and_then(Json::arr)
            .and_then(|w| Some([num(w.first())?, num(w.get(1))?, num(w.get(2))?]))
        else {
            continue;
        };
        if !on_ground || t.get("course").is_some() {
            continue;
        }
        let home = Vec3::new(x * 1000, y * 1000, z * 1000);
        let c = if let Some(ride) = ride {
            let t0 = k * 60_000_000;
            let Some(c) = sim::courses::rides::course(
                ride,
                home,
                |x, z| terrain.as_ref().and_then(|g| g.height_at(x, z)),
                t0,
            ) else {
                continue;
            };
            k += 1;
            println!(
                "ride: {} at {:.3},{:.3} m, loop {} us from {} us",
                t.get("name").and_then(Json::str).unwrap_or("?"),
                home.x as f64 / 1e6,
                home.z as f64 / 1e6,
                c.load().map_or(0, |t| t.period),
                c.t0
            );
            c
        } else {
            let speed = boat.copied().unwrap_or(sim::courses::punts::ROWING);
            if !sim::courses::punts::floating(&waters, terrain.as_ref(), home.x, home.z) {
                continue;
            }
            let Ok(c) = sim::courses::punts::once_through(home, &[], 0, speed) else {
                continue;
            };
            println!(
                "boat: {} moored at {:.3},{:.3} m",
                t.get("name").and_then(Json::str).unwrap_or("?"),
                home.x as f64 / 1e6,
                home.z as f64 / 1e6
            );
            c
        };
        let shape = match c.shape {
            sim::courses::Shape::Loop => 1,
            sim::courses::Shape::ThereAndBack => 2,
            sim::courses::Shape::Once => 3,
        };
        let stations = c
            .stations
            .iter()
            .map(|s| Json::Arr(vec![int(s.at.x), int(s.at.y), int(s.at.z), int(s.dwell)]))
            .collect();
        let Json::Obj(kv) = t else { continue };
        kv.push((
            "course".to_owned(),
            Json::Obj(vec![
                ("stations".to_owned(), Json::Arr(stations)),
                ("shape".to_owned(), int(shape)),
                ("speed".to_owned(), int(c.speed)),
                ("t0".to_owned(), int(c.t0)),
                ("within".to_owned(), int(c.within)),
            ]),
        ));
    }
    Ok(f.to_json())
}

/// The rowing punt's def (#3603): today's `rowing-punt`, a kind the world adds.
const PUNT_REF: &str = "core-rowing-punt@1";

/// Where `worldd serve` keeps [`courses`]' answer for its facts and entries (S5): `<world>/facts.courses`.
static COURSES_CACHE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// The cache's format and the meaning of what it holds: bump it whenever [`courses`], the punts' moorings or the
/// rides' courses (`sim::courses`), or [`import_eden::kind_name`] change what they give, so a cache from before is
/// never read as now's. The build's own hash is in the key too ([`build_id`]), so a deploy of a new build computes them
/// again.
const COURSES_FORMAT: &str = "souls/facts-courses/3";

/// The facts with their punts' moorings, their rides' courses and the entries' own kinds: [`with_punts`] (which loads
/// the facts and cuts a town only to find where planks and exits stand), [`with_rides`], [`with_entry_kinds`].
fn courses(facts: &str, entries: &[(String, Json)]) -> R<String> {
    let (punts, waters) = with_punts(facts)?;
    stamp("facts: punts");
    let rides = with_rides(&punts, entries, waters)?;
    stamp("facts: rides");
    with_entry_kinds(&rides, entries)
}

/// This build's id: the launcher's hash (`WORLDD_BUILD`), else the crate's version with this program's length and
/// modification time (S12), read from its metadata only, so `worldd seed` keeps [`courses`] under the key the
/// launched world reads and every start of the same binary agrees. Hashing the binary's bytes instead cost about 10 s
/// per start for a debug build.
fn build_id() -> String {
    static ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ID.get_or_init(|| {
        std::env::var("WORLDD_BUILD").unwrap_or_else(|_| {
            let version = env!("CARGO_PKG_VERSION");
            std::env::current_exe()
                .and_then(std::fs::metadata)
                .map(|m| {
                    let at = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map_or(0, |d| d.as_nanos());
                    format!("{version}-{}-{at}", m.len())
                })
                .unwrap_or_else(|_| version.to_owned())
        })
    })
    .clone()
}

/// The cache key of `facts` and `entries` for this build.
fn courses_key(facts: &str, entries: &[(String, Json)]) -> String {
    let build = build_id();
    let mut key = format!(
        "{COURSES_FORMAT}.{build}.{}",
        to_hex(&sha256(facts.as_bytes()))
    );
    for (k, e) in entries {
        key.push('.');
        key.push_str(&to_hex(&sha256(format!("{k}\0{}", e.to_json()).as_bytes())));
    }
    to_hex(&sha256(key.as_bytes()))
}

/// [`courses`] once per facts, entries and build (S5, 0.133): its answer is a function of them alone, so `worldd serve`
/// keeps it in `cache` (`<key> <SHA-256 of the text>`, then the text), and a start with the same reads it back. A
/// cache that is missing, of other facts, entries or build, or torn (its text not its hash) is computed again, and
/// rewritten synced (`view_out::write_whole`). Returns the text and whether it came from the cache.
fn courses_cached(
    cache: Option<&Path>,
    facts: &str,
    entries: &[(String, Json)],
) -> R<(String, bool)> {
    let Some(path) = cache else {
        return Ok((courses(facts, entries)?, false));
    };
    let key = courses_key(facts, entries);
    if let Ok(text) = std::fs::read_to_string(path)
        && let Some((head, out)) = text.split_once('\n')
        && let Some((k, hash)) = head.split_once(' ')
        && k == key
        && hash == to_hex(&sha256(out.as_bytes()))
    {
        return Ok((out.to_owned(), true));
    }
    let out = courses(facts, entries)?;
    let kept = format!("{key} {}\n{out}", to_hex(&sha256(out.as_bytes())));
    // Best effort: a world that cannot keep it computes it at its next start too.
    if let Err(e) = view_out::write_whole(path, kept.as_bytes()) {
        eprintln!("worldd: the facts' courses are not kept: {}", refusal(e));
    }
    Ok((out, false))
}

/// The slots of activity `name`'s entry that admit a thing, numbered as the entry numbers its slots (1, 2, ... in its
/// order): a carry's load rides its first (0.135 C4, `sim::activity::carry::SLOT`).
fn thing_slots(
    entries: &[(String, Json)],
    name: &str,
) -> BTreeMap<u64, std::collections::BTreeSet<String>> {
    let entry = entries
        .iter()
        .find(|(k, _)| format!("{k}_activity") == plain(name));
    let slots = entry.and_then(|(_, e)| e.get("slots")).and_then(Json::obj);
    (1..)
        .zip(slots.unwrap_or(&[]))
        .filter(|(_, (_, s))| s.get("admits").and_then(Json::str) == Some("thing"))
        .map(|(n, _)| (n, ["thing".to_owned()].into()))
        .collect()
}

fn build(facts: &str, entries: &[(String, Json)]) -> R<Built> {
    build_stocked(facts, entries, None)
}

/// [`build`] with the world's stock (#4837, `worldd::stock`): its containers' piles worked out from the facts, and
/// each placed copy of a yielded kind given its row's fields in the import.
fn build_stocked(
    facts: &str,
    entries: &[(String, Json)],
    stock: Option<&worldd::stock::Data>,
) -> R<Built> {
    build_from(
        COURSES_CACHE.get().map(PathBuf::as_path),
        facts,
        entries,
        stock,
    )
}

/// [`build`] with its facts' courses kept in `cache` (S5).
pub(crate) fn build_with(
    cache: Option<&Path>,
    facts: &str,
    entries: &[(String, Json)],
) -> R<Built> {
    build_from(cache, facts, entries, None)
}

fn build_from(
    cache: Option<&Path>,
    facts: &str,
    entries: &[(String, Json)],
    stock: Option<&worldd::stock::Data>,
) -> R<Built> {
    let (prepared, kept) = courses_cached(cache, facts, entries)?;
    stamp("facts: courses");
    // A kind whose entry joins parts (a rack bay, a beam, a frame stand) takes its slots from its entry (0.135).
    let texts: Vec<(String, String)> = entries
        .iter()
        .map(|(k, e)| (k.clone(), e.to_json()))
        .collect();
    // A kept text that does not load is never the start's end: it is computed again.
    let mut im = match import_eden::load_with(&prepared, &texts) {
        Err(e) if kept => {
            eprintln!("worldd: the kept facts' courses do not load ({e}); computing them again");
            import_eden::load_with(&courses(facts, entries)?, &texts)?
        }
        im => im?,
    };
    stamp("facts");
    let stock = match stock {
        Some(data) => {
            let w =
                worldd::stock::World::of(data, &json::parse(facts)?, &im.nodes, &im.tree, entries)?;
            // A placed copy of a yielded kind carries its row from the world's start: in its import's create.
            for e in &mut im.effects {
                if let replica::effects::Body::Changes(cs) = &mut e.body {
                    for c in cs {
                        if let replica::effects::Change::Create { node, fields, .. } = &mut c.change
                            && let Some(f) = w.placed.get(node)
                        {
                            fields.extend(f.clone());
                        }
                    }
                }
            }
            for note in &w.notes {
                println!("stock: left out: {note}");
            }
            stamp("stock");
            w
        }
        None => worldd::stock::World::default(),
    };
    for (k, id) in (0..).map_while(|k| Some((k, *im.nodes.get(&format!("e_punt{k}"))?))) {
        println!(
            "punt: rowing-punt-{} is {}",
            k + 1,
            replica::world_model::show(id)
        );
    }
    let mut activities = vec![conversation()?, give()?];
    activities.extend(activity_kinds(entries)?);
    stamp("activities");
    for a in &activities {
        im.rules.kinds.insert(
            a.name.as_str().to_owned(),
            Kind {
                owner: "activity".into(),
                children: Default::default(),
                slots: thing_slots(entries, a.name.as_str()),
                hands: None,
                fields: Default::default(),
            },
        );
    }
    // R1's replica starts a zone's root as the header's `souls:place` kind (as stream-check's Eden): one here,
    // admitting what the loader's world admits, so the log replays onto an empty replica.
    let root_kind = format!(
        "{{1: \"souls:place\", 2: \"place\", 11: [\"{}\"]}}",
        import_eden::GROUND
    );
    im.rules
        .kinds
        .extend(parse_kinds(&root_kind).map_err(|e| format!("the root's kind: {e:?}"))?);
    // Register and export the same generated body definition; pinned imported definitions keep their bytes.
    let body_kind_text = "{1: \"souls:body\", 2: \"family\", 6: {1: [\"thing\"], 2: [\"thing\"]}}";
    let body = parse_kinds(body_kind_text).map_err(|e| format!("the body's kind: {e:?}"))?;
    let body_kind = body.keys().next().cloned().ok_or("the body's kind")?;
    im.rules.kinds.extend(body);
    let mut boot_body = Vec::new();
    for (name, kind) in im.rules.kinds.iter_mut() {
        if plain(name) == import_eden::GROUND {
            kind.children.insert("body".into());
            boot_body.push(name.clone());
            for a in &activities {
                kind.children.insert(plain(a.name.as_str()).to_owned());
            }
        }
        // B10: an entry's own thing takes its activity too, so one offered or proposed at the thing is that thing's
        // (its roles' links are written on it).
        for a in &activities {
            if a.roles
                .iter()
                .any(|r| r.link.as_ref().is_some_and(|l| l.on == plain(name)))
            {
                kind.children.insert(plain(a.name.as_str()).to_owned());
            }
        }
    }
    let mut kinds_text = String::new();
    for line in im
        .kind_lines
        .iter()
        .map(String::as_str)
        .chain([root_kind.as_str(), body_kind_text])
    {
        kinds_text.push_str(line);
        kinds_text.push('\n');
    }
    for name in boot_body {
        kinds_text.push_str(&format!("# souls-boot-body {name}\n"));
        for a in &activities {
            kinds_text.push_str(&format!(
                "# souls-boot-activity {name} {}\n",
                a.name.as_str()
            ));
        }
    }
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
    let rules = im.rules;
    Ok(Built {
        header,
        part,
        ground,
        root,
        rules,
        kinds_text,
        body_kind,
        public_names: Arc::new(im.texts),
        activities,
        stock,
    })
}

/// The owner of each kind a header pins, `<full pin> <owner>` a line (K16): kept beside the world's header as
/// `header.kinds`, so a later build pairs a kind it changed with the world's revision only when both are owned alike.
fn owners_text(built: &Built) -> String {
    built
        .header
        .kinds
        .iter()
        .filter_map(|k| {
            Some(format!(
                "{} {}\n",
                k.as_str(),
                built.rules.kinds.get(k.as_str())?.owner
            ))
        })
        .collect()
}

/// [`owners_text`] read back. A missing or unreadable file gives none, and then no kind is paired.
pub(crate) fn owners(dir: &Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(dir.join("header.kinds"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once(' '))
        .map(|(k, o)| (k.to_owned(), o.to_owned()))
        .collect()
}

/// Keeps `built`'s header as the world's own (K16): `header.kinds`, then `header`, each written whole.
fn keep_header(dir: &Path, built: &Built) -> R<()> {
    view_out::write_whole(&dir.join("header.kinds"), owners_text(built).as_bytes())
        .map_err(refusal)?;
    view_out::write_whole(&dir.join("header"), built.header.stored()).map_err(refusal)
}

/// The world's own header (K16, 0.133): the one its log's parts name, kept in `<dir>/header` since the seed wrote it.
/// A build never rebuilds it, so a change to how code or entries become kinds no longer refuses an existing world
/// (`header-mismatch`, twice on Eden on 23 Nov). A world seeded before K16 keeps no header file: this build's is its
/// own only if its log names it, and is then kept (`header-missing` otherwise). What is still checked, and why:
///
/// - its hash is the one the log's parts name (`header-mismatch`; each part names its header, and replay refuses a
///   part naming another), from the newest part (the import's on a fresh world; a tick's is small, the import's may be
///   megabytes). A log compacted to a checkpoint with nothing written since holds no part: then this is not checked;
/// - its schema is one this build applies ([`Header::read`]'s `schema-unknown`): the effects are read by it;
/// - its lineage and zone are the world's, as the facts' root and `world.json`'s name give them
///   (`world-identity-mismatch`): not another world's.
///
/// Its kinds may differ from this build's: [`adopt`] reconciles them, with the owners `header.kinds` keeps.
fn own_header(
    dir: &Path,
    built: &Built,
    records: &[Vec<u8>],
) -> R<(Header, BTreeMap<String, String>)> {
    let named = match records.iter().rev().find(|b| !recorder::is_input(b)) {
        Some(bytes) => Some(replica::effects::Part::read(bytes).map_err(refusal)?.header),
        None => None,
    };
    let path = dir.join("header");
    let header = match std::fs::read(&path) {
        Ok(bytes) => Header::read(&bytes).map_err(refusal)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if named.as_ref() != Some(&built.header.hash().to_bytes()) {
                return Err(format!(
                    "header-missing: the log names header {}, the world keeps none, and this build's is {}: \
                     reseed the world",
                    named.as_deref().map_or("none".into(), to_hex),
                    to_hex(&built.header.hash().to_bytes())
                ));
            }
            keep_header(dir, built)?;
            println!("header: kept this build's, the one the log names");
            built.header.clone()
        }
        Err(e) => return Err(io(&path)(e)),
    };
    if let Some(named) = named
        && header.hash().to_bytes() != named
    {
        return Err(format!(
            "header-mismatch: {} is header {}, the log names {}",
            path.display(),
            to_hex(&header.hash().to_bytes()),
            to_hex(&named)
        ));
    }
    if header.zone != built.root || header.lineage != built.header.lineage {
        return Err("world-identity-mismatch: the header is another world's".into());
    }
    Ok((header, owners(dir)))
}

/// Serves the built world under its own `header` (K16). A kind this build pins by another revision than the header
/// (its definition changed in code or in an entry) is paired with the header's by plain name, when each side has
/// exactly one unmatched revision of that name and `owners` (the world's `header.kinds`) gives the world's revision
/// this build's owner: its rules are this build's definition under the header's pin, and the activity and body kinds
/// the engine makes and `world.kinds`' boot activity lines name the header's pin. `world.kinds`' kind lines and boot
/// targets keep this build's defined pins, so the creator's client still loads it. Any other unmatched revision is not
/// guessed: one only this build pins cannot be made in this world until it is reseeded (`kind-not-in-header`, per
/// act); one only the header pins has no rules (`kind-unknown`, per act). When the header is this build's, nothing
/// changes. Prints what differs, each paired pin in full, and returns the world's pins with no definition here (the
/// entries upgrade refuses a change that leaves one, `entries_upgrade`).
pub(crate) fn adopt(
    built: &mut Built,
    header: Header,
    owners: &BTreeMap<String, String>,
) -> Vec<String> {
    if header.stored() == built.header.stored() {
        return Vec::new();
    }
    let unmatched = |of: &Header, by: &Header| -> BTreeMap<String, Vec<String>> {
        let mut m: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for k in of.kinds.iter().filter(|k| !by.kinds.contains(k)) {
            m.entry(plain(k.as_str()).to_owned())
                .or_default()
                .push(k.as_str().to_owned());
        }
        m
    };
    let (mut world, mut build) = (
        unmatched(&header, &built.header),
        unmatched(&built.header, &header),
    );
    // This build's pin -> the world's, for each plain name with one unmatched revision on each side, owned alike.
    let mut renames = BTreeMap::new();
    for (name, ours) in &build {
        if let (Some(theirs), [ours]) = (world.get(name), ours.as_slice())
            && let [theirs] = theirs.as_slice()
            && let Some(kind) = built.rules.kinds.get(ours).cloned()
            && owners.get(theirs) == Some(&kind.owner)
        {
            built.rules.kinds.insert(theirs.clone(), kind);
            renames.insert(ours.clone(), theirs.clone());
        }
    }
    for (ours, theirs) in &renames {
        build.remove(plain(ours));
        world.remove(plain(theirs));
    }
    for a in &mut built.activities {
        if let Some(k) = renames.get(a.name.as_str()).and_then(|k| Name::new(k)) {
            a.name = k;
        }
    }
    if let Some(k) = renames.get(&built.body_kind) {
        built.body_kind = k.clone();
    }
    built.kinds_text = built
        .kinds_text
        .lines()
        .map(|l| {
            match l
                .strip_prefix("# souls-boot-activity ")
                .and_then(|p| p.split_once(' '))
            {
                Some((target, a)) => format!(
                    "# souls-boot-activity {target} {}\n",
                    renames.get(a).map_or(a, String::as_str)
                ),
                None => format!("{l}\n"),
            }
        })
        .collect();
    let list =
        |m: &BTreeMap<String, Vec<String>>| m.values().flatten().cloned().collect::<Vec<_>>();
    let (anew, unknown) = (list(&build), list(&world));
    let taken: Vec<String> = renames
        .iter()
        .map(|(ours, theirs)| format!("{theirs} as {ours}"))
        .collect();
    println!(
        "header: the world's own {}, not this build's {}; {} kinds taken at the world's revision [{}]; {} this build \
         pins that the world cannot make until it is reseeded [{}]; {} of the world's with no definition here [{}]",
        to_hex(&header.hash().to_bytes()),
        to_hex(&built.header.hash().to_bytes()),
        taken.len(),
        taken.join(", "),
        anew.len(),
        anew.join(", "),
        unknown.len(),
        unknown.join(", ")
    );
    built.header = header;
    unknown
}

/// The normal restart's movement geometry follows the same validated durable canonical parts as its writer.
/// The reader's initial replica, log mark, mapping and checkpoint selection remain unchanged.
/// `classes` are the body classes whose grounds are cut with them (S12).
fn recovered_towns(
    built: &Built,
    initial: &Replica,
    records: &[Vec<u8>],
    classes: &[replica::kinds::sizes::Size],
) -> R<(Town, Town)> {
    let mut live = initial.frozen();
    for bytes in records {
        crate::progress();
        if !recorder::is_input(bytes) {
            let part = replica::effects::Part::read(bytes).map_err(refusal)?;
            live.apply(&part).map_err(refusal)?;
        }
    }
    let doors = Doors::new(
        built.header.clone(),
        built.rules.clone(),
        live.tree().next(),
    );
    stamp("log applied");
    let towns = Town::with_planner_classes_on(
        live.tree().frozen(),
        built.ground,
        doors,
        sim::ground::START_THREADS,
        classes.iter().copied(),
    )
    .map_err(|e| format!("the recovered town: {e}"))?;
    stamp("town and planner");
    Ok(towns)
}

/// Public, data-only serving support. Only the seed's facts, flattened public entries and optional moves are
/// named; authority, creator metadata, logs and state are deliberately outside this manifest.
fn public_boot(dir: &Path, header: &replica::effects::Header) -> R<Vec<u8>> {
    let hash = |p: &Path| -> R<Value> {
        Ok(Value::Bytes(
            sha256(&std::fs::read(p).map_err(io(p))?).to_vec(),
        ))
    };
    let mut files = Vec::new();
    if dir.join("entries").is_dir() {
        let mut paths = std::fs::read_dir(dir.join("entries"))
            .map_err(io(dir))?
            .map(|e| e.map(|e| e.path()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(io(dir))?;
        paths.sort();
        for path in paths {
            let metadata = std::fs::symlink_metadata(&path).map_err(io(&path))?;
            if !metadata.is_file() || path.extension().is_none_or(|e| e != "json") {
                return Err("template-support-invalid: entries are regular JSON files".into());
            }
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or("template-support-invalid")?;
            files.push(Value::Array(vec![
                Value::Bytes(name.as_bytes().to_vec()),
                hash(&path)?,
            ]));
        }
    }
    let mut values = BTreeMap::from([
        (1, Value::Bytes(b"souls/public-boot/1".to_vec())),
        (2, hash(&dir.join("facts.json"))?),
        (
            3,
            Value::Array(header.kinds.iter().cloned().map(Value::Text).collect()),
        ),
        (4, Value::Array(files)),
    ]);
    if dir.join("moves.json").exists() {
        values.insert(5, hash(&dir.join("moves.json"))?);
    }
    if dir.join("entry.json").exists() {
        values.insert(6, hash(&dir.join("entry.json"))?);
    }
    let bodies = dir.join("bodies.json");
    match std::fs::symlink_metadata(&bodies) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err("template-bodies-invalid: catalogue is a regular file".into());
            }
            let bytes = std::fs::read(&bodies).map_err(io(&bodies))?;
            skills::wear::Catalogue::read(
                std::str::from_utf8(&bytes).map_err(|_| "template-bodies-invalid")?,
            )
            .map_err(|_| "template-bodies-invalid")?;
            values.insert(7, Value::Bytes(sha256(&bytes).to_vec()));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    encode(&Value::Map(values)).map_err(|e| e.to_string())
}

/// Checks a trusted public template's support against this build, including its authoritative sealed header.
pub(crate) fn template_pins(dir: &Path) -> R<Vec<Name>> {
    let facts = std::fs::read_to_string(dir.join("facts.json")).map_err(io(dir))?;
    let mut kinds = Vec::new();
    if dir.join("entries").is_dir() {
        entries(&dir.join("entries"), &mut kinds)?;
    }
    let built = build(&facts, &kinds)?;
    let manifest = std::fs::read(dir.join("boot")).map_err(io(dir))?;
    if manifest != public_boot(dir, &built.header)? {
        return Err(
            "template-support-mismatch: public support fingerprints or runtime pins differ".into(),
        );
    }
    let parent =
        replica::effects::Header::read(&std::fs::read(dir.join("header")).map_err(io(dir))?)
            .map_err(refusal)?;
    if parent.zone != built.header.zone || parent.kinds != built.header.kinds {
        return Err(
            "template-pins-mismatch: public boot pins differ from the sealed template".into(),
        );
    }
    Ok(parent.kinds)
}

/// A world creator's principal as `world.json` and `seed --creator` write it, `<32 hex>-<counter>` (its grant is
/// `creator-<32 hex>-<counter>`, G7b).
fn creator_of(text: &str) -> R<Id> {
    text.split_once('-')
        .and_then(|(scope, n)| {
            Id::new(
                Scope(from_hex(scope).ok()?.try_into().ok()?),
                n.parse().ok()?,
            )
        })
        .ok_or_else(|| format!("a creator is <32 hex>-<counter>, not {text}"))
}

/// The world's instance name: `<lineage hex>-<zone scope hex>-<zone counter>`, the zone being the root.
fn instance(root: Id) -> String {
    let scope = to_hex(&root.scope().0);
    format!("{scope}-{scope}-{}", root.counter())
}

/// Every `souls-entry/1` file under `dir`, by kind.
pub(crate) fn entries(dir: &Path, out: &mut Vec<(String, Json)>) -> R<()> {
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

/// The code hatches' modules a world ships (#3713): every `.wasm` file in `dir`, in name order, each checked as
/// `replica::hatch` loads a module (refused by name, so a bad module stops the boot, not an act).
fn hatches(dir: &Path) -> R<Vec<Vec<u8>>> {
    let mut out = Vec::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    let mut paths = Vec::new();
    wasm_files(dir, &mut paths)?;
    for p in paths {
        let bytes = std::fs::read(&p).map_err(io(&p))?;
        let mut named = vec![replica::ids::SHA2_256, 32];
        named.extend(sha256(&bytes));
        replica::hatch::Loaded::load(&bytes, &named)
            .map_err(|r| format!("{}: {}: {}", p.display(), r.name, r.detail))?;
        out.push(bytes);
    }
    println!("hatches: {} modules", out.len());
    Ok(out)
}

/// Every `.wasm` file under `dir`, sorted.
fn wasm_files(dir: &Path, out: &mut Vec<PathBuf>) -> R<()> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(io(dir))?
        .filter_map(|e| Some(e.ok()?.path()))
        .collect();
    paths.sort();
    for p in paths {
        if p.is_dir() {
            wasm_files(&p, out)?;
        } else if p.extension().is_some_and(|x| x == "wasm") {
            out.push(p);
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
            // The eyes and the voice B2's humanoid has (a look claims the gaze, a cheer the voice: C23).
            Resource {
                name: n("souls:eyes")?,
                class: Class::Gaze,
                slot: None,
            },
            Resource {
                name: n("souls:voice")?,
                class: Class::Voice,
                slot: None,
            },
        ],
    })
}

/// `worldd seed --facts <facts.json> --dir <new folder> [--entries <dir>] [--souls <n>] [--at <x m>,<z m>]`: a world
/// folder from a loader's facts file, with `n` Souls (default 1) on the open ground from (x, z) (default 0,0).
/// `--arrival <place>` names the place of the facts (by name or id) joining Souls arrive at ([`arrival`]).
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
                    [--at <x m>,<z m>] [--arrival <place>] [--creator <32 hex>-<n>] [--stock <stock.json>]"
            .into());
    };
    let dir = PathBuf::from(dir);
    if dir.join("log").exists() {
        return Err(format!("world-exists: {} has a log", dir.display()));
    }
    let souls: u64 = arg(args, "--souls").map_or(Ok(1), |n| n.parse().map_err(|_| "--souls"))?;
    let catalogue_text = arg(args, "--bodies")
        .map(|p| std::fs::read_to_string(p).map_err(io(Path::new(p))))
        .transpose()?;
    let catalogue = catalogue_text
        .as_ref()
        .map(|text| skills::wear::Catalogue::read(text))
        .transpose()?
        .unwrap_or_default();
    let body = arg(args, "--body")
        .map(|name| {
            catalogue
                .find(name)
                .map(|p| format!(r#", "{}""#, skills::wear::hex(&p.hash)))
                .ok_or("body-unknown")
        })
        .transpose()?
        .unwrap_or_default();
    let (x, z) = match arg(args, "--at") {
        Some(at) => at
            .split_once(',')
            .and_then(|(x, z)| Some((x.trim().parse::<f64>().ok()?, z.trim().parse::<f64>().ok()?)))
            .ok_or("--at <x m>,<z m>")?,
        None => (0.0, 0.0),
    };
    let text = std::fs::read_to_string(facts).map_err(io(Path::new(facts)))?;
    let mut found = Vec::new();
    if let Some(e) = arg(args, "--entries") {
        entries(Path::new(e), &mut found)?;
    }
    // C13's stand-point repair first: the header is built from the entries the folder keeps, the ones `serve` builds
    // its rules from at each start. Built before the repair, an activity's stands (G3) differed from its rules (0.132.1).
    if arg(args, "--entries").is_some() {
        for line in import_eden::clear_stand_points(&import_eden::load(&text)?, &mut found) {
            println!("stand point: {line}");
        }
    }
    // The world's stock and its libraries (#4837), kept in its folder: every start reads them.
    let stock = arg(args, "--stock")
        .map(|p| worldd::stock::Data::load(Path::new(p)))
        .transpose()?;
    let built = build_stocked(&text, &found, stock.as_ref())?;
    // The place Souls arrive at (`--arrival`), checked against the facts now: a seed never names one they lack.
    let arrival_field = match arg(args, "--arrival") {
        Some(place) => {
            arrival_of(&json::parse(&text)?, place)?;
            format!(", \"arrival\": {}", Json::Str(place.clone()).to_json())
        }
        None => String::new(),
    };
    std::fs::create_dir_all(dir.join("entries")).map_err(io(&dir))?;
    std::fs::write(dir.join("facts.json"), &text).map_err(io(&dir))?;
    if let Some(stock) = &stock {
        stock.keep(&dir)?;
        println!(
            "stock: {} containers stocked, {} placed copies carry a row",
            built.stock.stocks.len(),
            built.stock.placed.len()
        );
    }
    if let Some(text) = catalogue_text {
        std::fs::write(dir.join("bodies.json"), text).map_err(io(&dir))?;
    }
    if arg(args, "--entries").is_some() {
        for (kind, v) in &found {
            let p = dir
                .join("entries")
                .join(format!("{}.json", kind.replace(':', ".")));
            std::fs::write(&p, v.to_json()).map_err(io(&p))?;
        }
        println!("entries: {}", found.len());
        // The code hatches' modules shipped beside the entries (#3713), each kept under the hash it is named by.
        let mut modules = Vec::new();
        if let Some(e) = arg(args, "--entries") {
            wasm_files(Path::new(e), &mut modules)?;
        }
        if !modules.is_empty() {
            std::fs::create_dir_all(dir.join("hatches")).map_err(io(&dir))?;
        }
        for m in &modules {
            let bytes = std::fs::read(m).map_err(io(m))?;
            let p = dir
                .join("hatches")
                .join(format!("1220{}.wasm", to_hex(&sha256(&bytes))));
            std::fs::write(&p, &bytes).map_err(io(&p))?;
        }
        println!("hatches: {}", modules.len());
        // The facts' courses kept for this build (S12), from the entries as `serve` reads them back: its first start
        // reads them instead of cutting the punts' town again.
        let mut kept = Vec::new();
        entries(&dir.join("entries"), &mut kept)?;
        courses_cached(Some(&dir.join("facts.courses")), &text, &kept)?;
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
        rows.push(format!("[{counter}, {xm}, {zm}{body}]"));
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
    let n = log.append(built.part.clone()).map_err(refusal)?;
    log.wait_durable(n + 1).map_err(refusal)?;
    drop(log.close());
    // Its header, the one the part names (K16): every start serves the world under it.
    keep_header(&dir, &built)?;
    // The world's one creator (G7b), if named: `serve` takes its edits.
    let creator = match arg(args, "--creator") {
        Some(c) => format!(", \"creator\": \"{c}\"", c = creator_of(c).map(|_| c)?),
        None => String::new(),
    };
    let meta = format!(
        "{{\"format\": \"souls/world/1\", \"name\": \"{name}\", \"souls_scope\": \"{}\", \"souls\": [{}], \
         \"entry\": [{}, {}]{creator}{arrival_field}}}\n",
        to_hex(&scope),
        rows.join(", "),
        (x * 1000.0) as i64,
        (z * 1000.0) as i64
    );
    std::fs::write(dir.join("world.json"), meta).map_err(io(&dir))?;
    if souls == 0 {
        std::fs::write(
            dir.join("entry.json"),
            format!("[{}, {}]", (x * 1000.0) as i64, (z * 1000.0) as i64),
        )
        .map_err(io(&dir))?;
        std::fs::write(dir.join("boot"), public_boot(&dir, &built.header)?).map_err(io(&dir))?;
    }
    Ok(name)
}

/// The point Souls arrive at in a world whose `world.json` names an `arrival` place (a place of its facts, by its
/// `name` or its `id`): the middle of that place's outline (or line), mm. None when the world names none, and the
/// world's `entry` stands. A named place the facts do not hold is refused by name (`seed` and `worldd arrival` refuse
/// it; a start says so and births at the entry).
fn arrival(meta: &Json, facts: &str) -> R<Option<(i64, i64)>> {
    let Some(name) = meta.get("arrival") else {
        return Ok(None);
    };
    let name = name.str().ok_or("world.json: arrival is a place's name")?;
    arrival_of(&json::parse(facts)?, name).map(Some)
}

/// The middle of the outline (or line) of the place `name` (its `name` or `id`) in `facts`, mm.
fn arrival_of(facts: &Json, name: &str) -> R<(i64, i64)> {
    let place = facts
        .get("places")
        .and_then(Json::arr)
        .unwrap_or(&[])
        .iter()
        .find(|p| {
            p.get("name").and_then(Json::str) == Some(name)
                || p.get("id").and_then(Json::str) == Some(name)
        })
        .ok_or_else(|| format!("arrival-unknown: the facts name no place {name:?}"))?;
    let points: Vec<(i64, i64)> = place
        .get("polygon")
        .or_else(|| place.get("line"))
        .and_then(Json::arr)
        .unwrap_or(&[])
        .iter()
        .filter_map(|p| match p.arr()? {
            [Json::Int(x), Json::Int(z), ..] => {
                Some((i64::try_from(*x).ok()?, i64::try_from(*z).ok()?))
            }
            _ => None,
        })
        .collect();
    let (Some(x0), Some(x1), Some(z0), Some(z1)) = (
        points.iter().map(|p| p.0).min(),
        points.iter().map(|p| p.0).max(),
        points.iter().map(|p| p.1).min(),
        points.iter().map(|p| p.1).max(),
    ) else {
        return Err(format!("arrival-unknown: place {name:?} has no outline"));
    };
    Ok(((x0 + x1) / 2, (z0 + z1) / 2))
}

/// `worldd arrival --dir <world folder> --place <place>`: the world's Souls arrive at `<place>` (a place of its facts, by
/// name or id) from its next start: `world.json`'s `arrival` set, the place checked against its facts first. Prints
/// the point, metres. `--clear` removes it, and Souls arrive at the world's `entry` again.
pub fn set_arrival(args: &[String]) -> i32 {
    match set_arrival_in(args) {
        Ok(line) => {
            println!("{line}");
            0
        }
        Err(e) => {
            eprintln!("worldd arrival: {e}");
            1
        }
    }
}

fn set_arrival_in(args: &[String]) -> R<String> {
    let usage = "usage: worldd arrival --dir <world folder> (--place <place> | --clear)";
    let dir = PathBuf::from(arg(args, "--dir").ok_or(usage)?);
    let place = arg(args, "--place").cloned();
    let clear = args.iter().any(|a| a == "--clear");
    if place.is_some() == clear {
        return Err(usage.into());
    }
    let meta_path = dir.join("world.json");
    let parsed = json::parse(&std::fs::read_to_string(&meta_path).map_err(io(&meta_path))?)?;
    let Json::Obj(mut meta) = parsed else {
        return Err("world.json is not souls/world/1".into());
    };
    if !meta
        .iter()
        .any(|(k, v)| k == "format" && v.str() == Some("souls/world/1"))
    {
        return Err("world.json is not souls/world/1".into());
    }
    meta.retain(|(k, _)| k != "arrival");
    let line = match place {
        Some(place) => {
            let facts = dir.join("facts.json");
            let (x, z) = arrival_of(
                &json::parse(&std::fs::read_to_string(&facts).map_err(io(&facts))?)?,
                &place,
            )?;
            let line = format!(
                "arrival: {place} at {:.3},{:.3} m, from the next start",
                x as f64 / 1000.0,
                z as f64 / 1000.0
            );
            meta.push(("arrival".into(), Json::Str(place)));
            line
        }
        None => "arrival: cleared; Souls arrive at the entry from the next start".into(),
    };
    view_out::write_whole(
        &meta_path,
        format!("{}\n", Json::Obj(meta).to_json()).as_bytes(),
    )
    .map_err(refusal)?;
    Ok(line)
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

/// Original B15 birth choice reader: only admitted exact hashes enter the canonical body.
fn born(
    meta: &Json,
    catalogue: &skills::wear::Catalogue,
) -> R<std::collections::BTreeMap<Id, [u8; 32]>> {
    let ids = souls(meta)?;
    let rows = meta.get("souls").and_then(Json::arr).unwrap_or(&[]);
    let mut out = std::collections::BTreeMap::new();
    for ((id, _, _), row) in ids.iter().zip(rows) {
        if let Some(value) = row.arr().and_then(|r| r.get(3)) {
            let preset = value
                .str()
                .and_then(|s| catalogue.find(s))
                .ok_or("body-unknown")?;
            out.insert(*id, preset.hash);
        }
    }
    Ok(out)
}

/// Fixed private migration support. It can choose only an already admitted birth, never mutate a live body. A row
/// with no body may carry `look`, a humanoid look's params as JSON text (#3998's, at most `skills::wear::LOOK_MOST`
/// bytes, one object): the body is born wearing it, as if its Soul's first act had been `life:look` (old Eden's
/// residents, each made in today's editor).
fn imported_births(
    dir: &Path,
    header: &replica::effects::Header,
    catalogue: &skills::wear::Catalogue,
    born: &mut BTreeMap<Id, [u8; 32]>,
    looks: &mut BTreeMap<Id, Vec<u8>>,
) -> R<()> {
    let path = dir.join("births.json");
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("body-births-unavailable".into()),
    };
    let bad = "body-births-invalid";
    if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
        return Err(bad.into());
    }
    let bytes = std::fs::read(&path).map_err(|_| bad)?;
    let value = json::parse(std::str::from_utf8(&bytes).map_err(|_| bad)?)?;
    let fields = value.obj().ok_or(bad)?;
    if fields.len() != 6
        || fields.iter().any(|(k, _)| {
            ![
                "format",
                "world",
                "lineage",
                "zone",
                "catalogueHash",
                "births",
            ]
            .contains(&k.as_str())
        })
    {
        return Err(bad.into());
    }
    if value.get("format").and_then(Json::str) != Some("souls-births/1")
        || value
            .get("world")
            .and_then(Json::str)
            .is_none_or(str::is_empty)
        || value.get("lineage").and_then(Json::str) != Some(to_hex(&header.lineage.0).as_str())
        || value.get("zone").and_then(Json::str)
            != Some(directoryd::accounts::principal_text(header.zone).as_str())
    {
        return Err("body-births-world".into());
    }
    let source = dir.join("bodies.json");
    let metadata = std::fs::symlink_metadata(&source).map_err(|_| bad)?;
    if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
        return Err(bad.into());
    }
    let source = std::fs::read(&source).map_err(|_| bad)?;
    if value.get("catalogueHash").and_then(Json::str) != Some(to_hex(&sha256(&source)).as_str()) {
        return Err("body-births-catalogue".into());
    }
    let rows = value.get("births").and_then(Json::arr).ok_or(bad)?;
    if rows.len() > 65_536 {
        return Err(bad.into());
    }
    let mut seen = BTreeMap::new();
    let mut new_looks = BTreeMap::new();
    for row in rows {
        let fields = row.obj().ok_or(bad)?;
        if !(3..=4).contains(&fields.len())
            || fields
                .iter()
                .any(|(k, _)| !["soul", "entry", "asked", "body", "look"].contains(&k.as_str()))
        {
            return Err(bad.into());
        }
        let soul = row
            .get("soul")
            .and_then(Json::str)
            .and_then(directoryd::accounts::principal_from_text)
            .ok_or(bad)?;
        if row.get("entry").and_then(Json::str) != value.get("zone").and_then(Json::str)
            || row.get("asked") != Some(&Json::Int(0))
        {
            return Err(bad.into());
        }
        let choice = match row.get("body") {
            None => None,
            Some(Json::Str(text)) => Some(
                catalogue
                    .find(text)
                    .filter(|p| skills::wear::hex(&p.hash) == *text)
                    .ok_or("body-births-unknown")?
                    .hash,
            ),
            Some(_) => return Err("body-births-unknown".into()),
        };
        let look = match row.get("look") {
            None => None,
            Some(Json::Str(text))
                if choice.is_none()
                    && text.len() <= skills::wear::LOOK_MOST
                    && json::parse(text).is_ok_and(|v| v.obj().is_some()) =>
            {
                Some(text.as_bytes().to_vec())
            }
            Some(_) => return Err("body-births-look".into()),
        };
        if let Some(look) = look {
            new_looks.insert(soul, look);
        }
        if seen.insert(soul, choice).is_some() {
            return Err("body-births-duplicate".into());
        }
        if let Some(held) = born.get(&soul)
            && Some(*held) != choice
        {
            return Err("body-births-contradictory".into());
        }
    }
    for (soul, hash) in seen {
        if let Some(hash) = hash {
            born.insert(soul, hash);
        }
    }
    looks.extend(new_looks);
    Ok(())
}

/// The world's bodies: none on a first start (each Soul's is born when it first acts, C3); on a restart, each body
/// where the log last had it. The planner keeps its own town and all declared seats are registered. `entry` is where
/// the world's Souls are born on its ground: a restart's last resort for a body it cannot place on its own ground.
#[allow(clippy::too_many_arguments)]
fn bodies(
    town: Town,
    planner: Town,
    ground: Id,
    entry: Vec3,
    placed: &Placed,
    places: Vec<PlaceAt>,
    runs: Vec<(Id, sim::courses::rides::SeatRun)>,
    builds: &std::collections::BTreeMap<Id, replica::kinds::sizes::Build>,
) -> Result<Bodies, Refusal> {
    let family = humanoid().map_err(|e| Refusal {
        name: "family",
        detail: e,
    })?;
    // Each recorded body is placed on its own, so one never stops the others starting (a local failure never stops
    // unrelated actors), and always at a point it may stand on: where the log had it; off its floor, by the restart
    // rule (`Bodies::add_body_at_built`, E11d); a body that cannot be placed on its own ground at all (its floor or seat
    // gone) at the world's entry (`Bodies::add_body_at_entry`), named. Only a body with no recorded build is left out.
    let mut at = Vec::new();
    let mut lost = Vec::new();
    for (id, (pose, _)) in placed {
        match recorded_body(&town, &places, *id, pose, builds) {
            Ok(one) => at.push(one),
            Err(r) => {
                eprintln!(
                    "worldd: {} cannot be placed where the log had it: {}",
                    replica::world_model::show(*id),
                    refusal(r)
                );
                lost.push((*id, *pose));
            }
        }
    }
    // The things on a course (today's punts, #3603): their seats are boarded and left only at their home stop.
    let mut moving = Vec::new();
    if let Some(gh) = town.tree.handle(ground) {
        for &c in town.tree.children(gh).unwrap_or(&[]) {
            if let Some(n) = town.tree.node(c)
                && let Some(course) = n
                    .fields()
                    .get(&replica::schedule::F_COURSE)
                    .and_then(replica::schedule::course::Course::read)
            {
                moving.push((n.id(), course));
            }
        }
    }
    let owns: Vec<(Id, sim::slots::Footprint)> = places
        .iter()
        .map(|p| (p.thing, p.floor))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .map(|(thing, floor)| (thing, worldd::places::footprint(&town.tree, thing, floor)))
        .collect();
    let mut b = Bodies::with_planner(town, planner, 50_000)?;
    for s in places {
        b.add_place(s)?;
    }
    for (thing, own) in owns {
        b.slots.footprint(thing, own);
    }
    for (thing, course) in moving {
        let home = course.stations.first().map_or(Vec3::ZERO, |s| s.at);
        b.slots.moving(thing, &course, home)?;
    }
    // The seats that move with their cabins (N14): boarded and left only where they stand at a stop.
    for (thing, r) in runs {
        b.slots.trip_ends(thing, r.ends.clone());
        if let Err(e) = b.slots.run(thing, r.slot, &r.course, r.stops, &r.own) {
            eprintln!("worldd: a ride's slot run did not load: {}", refusal(e));
        }
    }

    for (a, build) in at {
        let id = a.id;
        if let Err(r) = b.add_body_at_built(family.clone(), a, placed, build) {
            eprintln!(
                "worldd: {} cannot be added where the log had it: {}",
                replica::world_model::show(id),
                refusal(r)
            );
            if let Some((pose, _)) = placed.get(&id) {
                lost.push((id, *pose));
            }
        }
    }
    for (id, pose) in lost {
        let placed_at = match builds.get(&id) {
            Some(&build) => b.add_body_at_entry(family.clone(), id, build, entry, &pose),
            None => Err(Refusal {
                name: "body-unknown",
                detail: "recorded build missing".into(),
            }),
        };
        match placed_at {
            Ok(()) => eprintln!(
                "worldd: {} placed at the world's entry (resume-entry)",
                replica::world_model::show(id)
            ),
            Err(r) => eprintln!(
                "worldd: {} was not placed again, left out: {}",
                replica::world_model::show(id),
                refusal(r)
            ),
        }
    }
    Ok(b)
}

/// One recorded body placed again for [`bodies`]: on its recorded ground, or by its seat's stand point when it sat,
/// with its build. A body killed off its floor (mid-climb out of a seat, E11d) is placed where it was
/// (`sim::slots::placed_off`); `Bodies::add_body_at_built` resumes it.
fn recorded_body(
    town: &Town,
    places: &[PlaceAt],
    id: Id,
    pose: &replica::pose::Pose,
    builds: &std::collections::BTreeMap<Id, replica::kinds::sizes::Build>,
) -> Result<(sim::mover::Body, replica::kinds::sizes::Build), Refusal> {
    let build = builds.get(&id).copied().ok_or_else(|| Refusal {
        name: "body-unknown",
        detail: "recorded build missing".into(),
    })?;
    let (node, point, facing) = match pose.support {
        replica::pose::Support::Surface { surface, .. } => {
            (surface, pose.position, pose.orientation)
        }
        replica::pose::Support::Slot => {
            let site = places
                .iter()
                .find(|p| {
                    p.thing == pose.frame.node && pose.frame.slot.is_none_or(|s| s == p.place.slot)
                })
                .ok_or_else(|| Refusal {
                    name: "place-unknown",
                    detail: "recorded support unavailable".into(),
                })?;
            (site.floor, site.stand()?, site.facing)
        }
        replica::pose::Support::Volume { .. }
        | replica::pose::Support::Track
        | replica::pose::Support::None => {
            return Err(Refusal {
                name: "recorded-body-support",
                detail: "unsupported native body support".into(),
            });
        }
    };
    let surfaces = town.surfaces_for(build.size).ok_or_else(|| Refusal {
        name: "body-class-unprepared",
        detail: "recorded body".into(),
    })?;
    let surface = surfaces.get(&node).ok_or_else(|| Refusal {
        name: "no-surface",
        detail: "recorded ground".into(),
    })?;
    let frame = Frame { node, slot: None };
    // A body that sat stands at its seat's stand point until its seat is held again, or for good when the seat is gone
    // or taken: at a point it may stand on.
    let moved = if pose.support == replica::pose::Support::Slot {
        worldd::bodies::legal_near(town, surface, id, frame, point, facing, build)?
    } else {
        sim::slots::placed_off(surface, id, frame, point, facing, build)?
    };
    Ok((moved, build))
}

/// The world's store; its reads at the start are made [`patiently`] (#1960).
type Bucket = Shared<Patient<supervisor::bucket::Bucket>>;

/// Public navigation only: the same restored header/root as the live writer, beside the history export.
fn public_history_live(dir: &Path, name: &str, header: &Header, key: &Key) -> R<()> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        || key.node != header.zone
        || key.level != Level::Full
        || key.audience != Audience::Everyone
    {
        return Err("history-live-invalid".into());
    }
    let history = dir.join("history");
    match std::fs::symlink_metadata(&history) {
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
        Ok(_) => return Err("history-live-export".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&history).map_err(|_| "history-live-export")?;
        }
        Err(_) => return Err("history-live-export".into()),
    }
    for path in [history.join("live"), history.join("live.tmp")] {
        match std::fs::symlink_metadata(path) {
            Ok(m) if m.is_file() && !m.file_type().is_symlink() => {}
            Ok(_) => return Err("history-live-export".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("history-live-export".into()),
        }
    }
    let bytes = format!(
        "{{\"format\":\"souls/history-live/1\",\"world\":\"{name}\",\"lineage\":\"{}\",\"stream\":\"../views/{}/\"}}\n",
        to_hex(&header.lineage.0),
        stream::dir(header, key)
    );
    view_out::write_whole(&history.join("live"), bytes.as_bytes())
        .map_err(|_| "history-live-export".to_owned())
}

/// How often a running world's open event index is written, at most (R16b): a question sees acts this old.
const VIEWS_EVERY: std::time::Duration = std::time::Duration::from_secs(5);

/// Exact public keys only: private archive/source/checkpoint objects never enter the export tree.
fn history_public_key(key: &str) -> bool {
    let number = |s: &str| {
        !s.is_empty()
            && s.strip_prefix('-')
                .unwrap_or(s)
                .bytes()
                .all(|c| c.is_ascii_digit())
            && s.parse::<i64>().is_ok()
    };
    let hash = |s: &str| {
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    };
    let p: Vec<_> = key.split('/').collect();
    match p.as_slice() {
        ["header"] => true,
        ["bundles", day, "index"] => number(day),
        ["bundles", day, name] => {
            number(day)
                && (number(name)
                    || name
                        .rsplit_once('-')
                        .is_some_and(|(start, digest)| number(start) && hash(digest)))
        }
        ["history", "everyone", "events", day] => number(day),
        ["history", "everyone", "events", day, hour] => {
            number(day) && hour.parse::<u8>().is_ok_and(|h| h < 24)
        }
        ["history", "everyone", "counts", "day" | "year", value] => number(value),
        _ => false,
    }
}
fn history_mutable_key(key: &str) -> bool {
    history_public_key(key)
        && key != "header"
        && (!key.starts_with("bundles/")
            || key.ends_with("/index")
            || key
                .rsplit('/')
                .next()
                .is_some_and(|n| n.parse::<i64>().is_ok()))
}
#[derive(Clone)]
struct Again {
    store: Under<Bucket>,
    public: PathBuf,
    header: Vec<u8>,
}
impl Again {
    /// The public copy of `key`: its bytes checked ([`Again::check`]), then placed ([`Again::place`]), either refusal
    /// returned (the tests' strict form of [`Again::mirrored`]).
    #[cfg(test)]
    fn mirror(&self, key: &str, bytes: &[u8]) -> Result<(), Refusal> {
        if !history_public_key(key) {
            return Ok(());
        }
        self.check(key, bytes)?;
        self.place(key, bytes)
    }
    /// A public key's bytes are what they say they are. A refusal here is a corrupt archive, and ends the start.
    fn check(&self, key: &str, bytes: &[u8]) -> Result<(), Refusal> {
        let fail = |detail: &str| Refusal {
            name: "history-export",
            detail: detail.into(),
        };
        let parts: Vec<_> = key.split('/').collect();
        match parts.as_slice() {
            ["header"] => {
                Header::read(bytes)?;
                if bytes != self.header {
                    return Err(fail("header differs"));
                }
            }
            ["bundles", day, "index"] => {
                let index = replica::history::DayIndex::read(bytes)?;
                if day.parse::<i64>() != Ok(index.day)
                    || index.bundles.iter().any(|(_, key, _)| {
                        !history_public_key(key)
                            || !key.starts_with("bundles/")
                            || key.ends_with("/index")
                    })
                {
                    return Err(fail("invalid public index"));
                }
            }
            ["bundles", day, name] => {
                let body = archive::bundle_body(bytes)?;
                let bundle = replica::history::Bundle::read(&body)?;
                if bundle.header != Header::read(&self.header)?.hash().to_bytes()
                    || day.parse::<i64>() != Ok(replica::history::day_of(bundle.start))
                {
                    return Err(fail("bundle day differs"));
                }
                if let Some((_, digest)) = name.rsplit_once('-')
                    && digest.len() == 64
                    && to_hex(&bundle.hash()) != digest
                {
                    return Err(fail("bundle hash differs"));
                }
            }
            ["history", "everyone", "events", ..] => {
                replica::history::events::EventIndex::read(bytes)?;
            }
            ["history", "everyone", "counts", ..] => {
                replica::history::events::Counts::read(bytes)?;
            }
            _ => return Err(fail("public key refused")),
        }
        Ok(())
    }
    /// Where the public copy of `key` sits in the export directory: at its key, except a day's event index once an
    /// hour of that day has an object of its own (V4, an hour of [`replica::history::events::SPLIT`] events or more).
    /// The day's key then names the directory of its hours, so its index sits in it as [`EVENTS_DAY_FILE`] (no hour's
    /// name), and the viewers' origin serves it at the day's URL (`v2/tools/origin/origin.mjs`).
    fn public_path(&self, key: &str) -> PathBuf {
        let path = self.public.join(key);
        if is_events_day(key) && std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
            path.join(EVENTS_DAY_FILE)
        } else {
            path
        }
    }
    /// Writes the checked `bytes` of `key` into the export directory: no symlink followed, an immutable copy never
    /// changed. A refusal here is the mirror's alone; the store holds the key.
    fn place(&self, key: &str, bytes: &[u8]) -> Result<(), Refusal> {
        let fail = |detail: &str| Refusal {
            name: "history-export",
            detail: detail.into(),
        };
        let parts: Vec<_> = key.split('/').collect();
        let mut path = self.public.clone();
        // The export directory itself, then each directory of the key.
        for at in 0..parts.len() {
            if at > 0 {
                path.push(parts[at - 1]);
            }
            match std::fs::symlink_metadata(&path) {
                Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
                // The first hour of a day split off after the day's index was placed: the index moves into the day's
                // directory, beside its hours.
                Ok(m)
                    if at > 0
                        && m.is_file()
                        && !m.file_type().is_symlink()
                        && is_events_day(&parts[..at].join("/")) =>
                {
                    let aside = path.with_extension("tmp");
                    std::fs::rename(&path, &aside)
                        .and_then(|()| std::fs::create_dir(&path))
                        .and_then(|()| std::fs::rename(&aside, path.join(EVENTS_DAY_FILE)))
                        .map_err(|_| fail("cannot move the day index beside its hours"))?;
                }
                Ok(_) => return Err(fail("directory symlink or type mismatch")),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => std::fs::create_dir(&path)
                    .map_err(|_| fail("cannot create export directory"))?,
                Err(_) => return Err(fail("cannot inspect export directory")),
            }
        }
        let path = self.public_path(key);
        if let Ok(metadata) = std::fs::symlink_metadata(&path) {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(fail("file symlink or type mismatch"));
            }
            if !history_mutable_key(key) {
                return if std::fs::read(&path)
                    .map_err(|_| fail("cannot inspect immutable export"))?
                    == bytes
                {
                    Ok(())
                } else {
                    Err(fail("immutable public bytes differ"))
                };
            }
        }
        view_out::write_whole(&path, bytes)
    }
    fn restore_public(&self) -> Result<(), Refusal> {
        for key in self.store.list("")? {
            if history_public_key(&key) {
                let object = self.store.get(&key)?.ok_or_else(|| Refusal {
                    name: "history-export",
                    detail: "public object disappeared".into(),
                })?;
                self.mirrored(&key, &object.bytes)?;
            }
        }
        Ok(())
    }
    /// [`Again::mirror`], whose placing ends nothing: the store holds the key, a public copy that cannot be placed is
    /// skipped, counted in `health.json` (`history_export`) and logged once per key. A local failure never stops the
    /// world. Bytes that fail their check are refused as before: a corrupt archive stops at the start.
    fn mirrored(&self, key: &str, bytes: &[u8]) -> Result<(), Refusal> {
        if !history_public_key(key) {
            return Ok(());
        }
        self.check(key, bytes)?;
        if let Err(e) = self.place(key, bytes) {
            let fault = refusal(e);
            if measures::HISTORY_EXPORT.fault(key, &fault) {
                let _ = writeln!(
                    std::io::stderr(),
                    "worldd: the public history skips {key}, the world goes on: {fault}"
                );
            }
        }
        Ok(())
    }
}

/// A day's event index in the export directory, once that day's key is the directory of its split hours.
const EVENTS_DAY_FILE: &str = "day";

/// Whether `key` is a day's object of the public event index (`history/everyone/events/<day>`).
fn is_events_day(key: &str) -> bool {
    key.strip_prefix("history/everyone/events/")
        .is_some_and(|day| !day.contains('/') && history_public_key(key))
}
std::thread_local! {
    /// The waits between a running archiver's tries of a call the store does not answer ([`persistently`]).
    static PERSIST: std::cell::Cell<Option<&'static [u64]>> = const { std::cell::Cell::new(None) };
}

/// Runs `f` with this thread's [`Again`] calls tried until the store answers them, after each of `waits` ms (the last
/// repeats): a running archiver's write is never given up on, so the archiver never stops on a store out of reach,
/// and the parts that come meanwhile wait in its queue, in order. The archive's open is not run so: it is tried whole
/// ([`until_answered`]).
fn persistently<T>(waits: &'static [u64], f: impl FnOnce() -> T) -> T {
    let before = PERSIST.with(|p| p.replace(Some(waits)));
    let out = f();
    PERSIST.with(|p| p.set(before));
    out
}

impl Again {
    /// `call`, tried again while it answers `store-unreachable` when this thread runs [`persistently`] (else once):
    /// `archive` in `health.json` says `behind` with the fault and the next try meanwhile, and `current` once answered.
    fn answered<T>(&self, mut call: impl FnMut() -> Result<T, Refusal>) -> Result<T, Refusal> {
        let Some(waits) = PERSIST.with(std::cell::Cell::get) else {
            return call();
        };
        let mut tries = 0u64;
        loop {
            match call() {
                Err(e) if e.name == "store-unreachable" && !waits.is_empty() => {
                    tries += 1;
                    // A rate-limited store's `Retry-After`, when longer, bounded (R18).
                    let after = directoryd::directory::store::retry_after(&e)
                        .map_or(0, |d| d.as_millis() as u64);
                    let wait = waits[(tries as usize - 1).min(waits.len() - 1)].max(after);
                    let fault = refusal(e);
                    measures::ARCHIVE.behind(&fault, tries, wait);
                    let _ = writeln!(
                        std::io::stderr(),
                        "worldd: the archive is behind, the world goes on: {fault}; try {tries} unanswered, the next in {wait} ms"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(wait));
                }
                answer => {
                    if tries > 0 && answer.is_ok() {
                        measures::ARCHIVE.current();
                        let _ = writeln!(
                            std::io::stderr(),
                            "worldd: the archive caught up: the store answered after {tries} unanswered tries"
                        );
                    }
                    return answer;
                }
            }
        }
    }
}

impl Store for Again {
    fn get(&self, key: &str) -> Result<Option<Object>, Refusal> {
        self.answered(|| self.store.get(key))
    }
    fn list(&self, prefix: &str) -> Result<Vec<String>, Refusal> {
        self.answered(|| self.store.list(prefix))
    }
    fn put(&self, key: &str, bytes: &[u8], when: When) -> Result<String, Refusal> {
        // A try the store did not answer may have been done: a later try refused on its condition is then read back,
        // and these bytes there are this write's.
        let mut unanswered = false;
        let result = self.answered(|| {
            let tried = match self.store.put(key, bytes, when) {
                Err(e)
                    if e.name == "precondition-failed" && (when == When::Absent || unanswered) =>
                {
                    match self.store.get(key)? {
                        Some(old) if old.bytes == bytes => Ok(old.etag),
                        Some(old) if when == When::Absent && history_mutable_key(key) => {
                            self.store.put(key, bytes, When::Is(&old.etag))
                        }
                        _ => Err(e),
                    }
                }
                other => other,
            };
            if tried.as_ref().is_err_and(|e| e.name == "store-unreachable") {
                unanswered = true;
            }
            tried
        })?;
        self.mirrored(key, bytes)?;
        Ok(result)
    }
}

/// Where each record on the disk goes off the machine: the shipper, and the archiver (parts only, numbered among
/// the parts).
/// The most bytes of parts that wait in the archiver's channel. Past it the parts stay in the log on the disk, which the
/// compactor keeps until they are archived, and the archiver reads them from there once it has taken those queued: a
/// store out of reach for hours costs this much memory at most, never the log's rate times the outage.
const ARCHIVE_WINDOW: u64 = 64 << 20;

/// What [`Off`] hands the archiver and what it leaves for it in the log, shared by the two.
struct Handover {
    window: u64,
    state: std::sync::Mutex<Handing>,
}

#[derive(Default)]
struct Handing {
    /// Parts in the channel, and their bytes: counted before each send, under the lock, so never off by a race.
    queued: u64,
    queued_bytes: u64,
    /// While parts are not sent: the first record left in the log, and its number in the archive.
    left: Option<(u64, u64)>,
    /// The record after the last one handed or left, and the archive's number after it.
    end: u64,
    next: u64,
}

impl Handover {
    fn new(window: u64) -> Arc<Handover> {
        Arc::new(Handover {
            window,
            state: std::sync::Mutex::default(),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Handing> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn gauge(h: &Handing) {
        let in_log = h.left.map_or(0, |(from, _)| h.end.saturating_sub(from));
        measures::ARCHIVE_QUEUE.set(h.queued, h.queued_bytes, in_log);
    }

    /// Record `record`, the archive's `number`: sent on `tx`, unless the channel holds the window already or parts
    /// are left in the log, when it is left there too.
    fn hand(&self, tx: &Sender<(u64, Vec<u8>)>, record: u64, number: u64, bytes: &[u8]) {
        let mut h = self.lock();
        let len = bytes.len() as u64;
        if h.left.is_none() && h.queued > 0 && h.queued_bytes + len > self.window {
            h.left = Some((record, number));
        }
        if h.left.is_none() {
            h.queued += 1;
            h.queued_bytes += len;
            if tx.send((number, bytes.to_vec())).is_err() {
                h.queued -= 1;
                h.queued_bytes -= len;
            }
        }
        (h.end, h.next) = (record + 1, number + 1);
        Handover::gauge(&h);
    }

    /// The archiver took a part of `len` bytes from the channel.
    fn took(&self, len: usize) {
        let mut h = self.lock();
        h.queued = h.queued.saturating_sub(1);
        h.queued_bytes = h.queued_bytes.saturating_sub(len as u64);
        Handover::gauge(&h);
    }

    /// What is left in the log for the archiver: its first record and number, and the record after the last.
    fn left(&self) -> Option<(u64, u64, u64)> {
        let h = self.lock();
        h.left.map(|(from, number)| (from, number, h.end))
    }

    /// The archiver read the log up to `reached` (its next number `number`): the rest is left, or, once it reached
    /// the last record taken, parts are sent again from the next.
    fn read_to(&self, reached: u64, number: u64) -> Result<(), Refusal> {
        let mut h = self.lock();
        if reached >= h.end {
            if number != h.next {
                return Err(Refusal {
                    name: "archive-handover",
                    detail: format!(
                        "read from the log to {number}, the world handed to {}",
                        h.next
                    ),
                });
            }
            h.left = None;
        } else {
            h.left = Some((reached, number));
        }
        Handover::gauge(&h);
        Ok(())
    }
}

/// A record of the log and its number.
type Numbered = (u64, Vec<u8>);

/// The world's log read forward from the disk a batch at a time, for the parts left there ([`Handover`]). Its place
/// is kept between batches; the first read starts at the log's cut, or its first record. Offsets and record numbers
/// never change when the log is compacted (`sim::log::compact`), and the compactor keeps every record the archive has
/// not closed, so what it reads is there.
struct LogReader {
    path: PathBuf,
    at: Option<sim::log::At>,
}

impl LogReader {
    /// The bytes one batch reads; a record longer than that is read whole.
    const BATCH: usize = 8 << 20;

    /// The records from `from` (at most up to `end`) in the next batch, each with its number, and the record after the
    /// last one read.
    fn batch(&mut self, from: u64, end: u64) -> Result<(Vec<Numbered>, u64), Refusal> {
        use sim::log::{At, HEAD_LEN, HEADER_LEN, MAX_RECORD};
        use std::io::{Read, Seek, SeekFrom};
        let fault = |detail: String| Refusal {
            name: "archive-log",
            detail,
        };
        let io = |e: std::io::Error| fault(format!("{}: {e}", self.path.display()));
        let mut file = std::fs::File::open(&self.path).map_err(io)?;
        let mut header = [0u8; HEADER_LEN];
        file.read_exact(&mut header).map_err(io)?;
        let at = match self.at {
            Some(at) if at.record <= from => at,
            _ => match sim::log::compact::read_cut(&self.path)? {
                Some(cut) => cut.at,
                None => At {
                    record: 0,
                    offset: HEADER_LEN as u64,
                    crc: sim::log::Header::new(u64::from_le_bytes(
                        header[16..24].try_into().expect("8 bytes"),
                    ))
                    .salt,
                },
            },
        };
        if at.record > from {
            return Err(fault(format!(
                "record {from} is before the log's cut at {}",
                at.record
            )));
        }
        let mut chunk = Self::BATCH;
        loop {
            file.seek(SeekFrom::Start(at.offset)).map_err(io)?;
            let mut tail = Vec::new();
            (&mut file)
                .take(chunk as u64)
                .read_to_end(&mut tail)
                .map_err(io)?;
            let found = sim::log::recover_from(&header, &tail, at)?.ok_or_else(|| {
                fault(format!("the log does not continue at record {}", at.record))
            })?;
            if found.records.is_empty() {
                if tail.len() < chunk || chunk > MAX_RECORD {
                    self.at = Some(at);
                    return Ok((Vec::new(), at.record));
                }
                chunk *= 2;
                continue;
            }
            let (mut out, mut next, mut offset) = (Vec::new(), at, 0usize);
            for (k, bytes) in found.records.into_iter().enumerate() {
                let record = at.record + k as u64;
                if record >= end {
                    break;
                }
                let crc =
                    u32::from_le_bytes(tail[offset + 8..offset + 12].try_into().expect("4 bytes"));
                offset += HEAD_LEN + bytes.len();
                next = At {
                    record: record + 1,
                    offset: at.offset + offset as u64,
                    crc,
                };
                if record >= from {
                    out.push((record, bytes));
                }
            }
            self.at = Some(next);
            return Ok((out, next.record));
        }
    }
}

struct Off {
    ship: Sender<Item>,
    archive: Option<Sender<(u64, Vec<u8>)>>,
    handover: Arc<Handover>,
    parts: u64,
    based: bool,
    archive_base: u64,
    /// The log compactor's floors from here (#3837): the shipper's marks, and how far the archive has closed.
    mark: shipping::Mark,
    floor: Option<crate::compactor::Archive>,
}

impl Off {
    /// A part for an archive that numbers parts (not a fork's): numbered, and its record kept for the compactor.
    fn part(&mut self, record: u64, bytes: &[u8]) {
        if let Some(a) = &self.archive {
            if let Some(crate::compactor::Archive::Parts(p)) = &self.floor {
                p.sent(record, self.parts);
            }
            self.handover.hand(a, record, self.parts, bytes);
            self.parts += 1;
        }
    }
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
        if let Some(a) = &self.archive {
            if self.based {
                if record >= self.archive_base {
                    self.handover.hand(a, record, record, bytes);
                }
            } else if !input {
                self.part(record, bytes);
            }
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
/// bundle closes, so a running world's bundles are found before its day ends. The open day's event index and counts
/// (V4) are written as they stand at most each [`VIEWS_EVERY`] while new parts come, so R16's `history` reads a
/// running world's day (R16b, #3480). `open` runs first, on the same thread: a fork's archive re-derives its public
/// history from its base, which takes a full-Eden world tens of seconds, and the world serves meanwhile; parts wait
/// in `feed` in order (#3746): at most [`ARCHIVE_WINDOW`] of them in memory, the rest read from the log ([`Handover`]). An open the store does not answer is tried again until it does (R17, `archive` in
/// `health.json`); once open, each call the store does not answer is tried again after each of `waits` ms until it
/// does ([`persistently`]), so a store out of reach never stops the archiver (`archive` says `behind` meanwhile).
fn archiving(
    mut open: impl FnMut() -> Result<Archiver<Again>, Refusal> + Send + 'static,
    mut feed: Feed,
    text: Arc<sim::text::Store>,
    closed: impl Fn(u64) + Send + 'static,
    waits: &'static [u64],
) -> std::thread::JoinHandle<Result<(), Refusal>> {
    measures::ARCHIVE.recovering();
    std::thread::spawn(move || {
        // The open is the world's start too: its reads are patient (#1960), and tried again until answered (R17).
        let a = until_answered("the archive", &measures::ARCHIVE, || patiently(&mut open))?;
        // Once open, each of its calls is tried until the store answers it: the archiver never stops on a store out
        // of reach, and parts wait in `rx` meanwhile, in order. Any other refusal still ends it, named in health.json.
        persistently(waits, || archive_parts(a, &mut feed, &text, &closed))
            .inspect_err(|e| measures::ARCHIVE.stopped(&refusal(e.clone())))
    })
}

/// The archiver's loop once open ([`archiving`]).
fn archive_parts(
    mut a: Archiver<Again>,
    feed: &mut Feed,
    text: &sim::text::Store,
    closed: &impl Fn(u64),
) -> Result<(), Refusal> {
    // How far its closed objects reach, for the log's compactor (#3837).
    let publish = |a: &Archiver<Again>| closed(a.durable_cursor());
    publish(&a);
    let mut indexed = a.shelf.writes.bundles;
    let (mut fresh, mut viewed) = (false, std::time::Instant::now());
    // Whether the last batch read from the log moved on: the next is read at once.
    let mut reading = false;
    loop {
        if a.is_based() && a.refresh_redactions(text.redactions())? {
            fresh = true;
        }
        let wait = if reading {
            std::time::Duration::ZERO
        } else {
            shipping::POLL * 20
        };
        match feed.rx.recv_timeout(wait) {
            Ok((n, bytes)) => {
                feed.handover.took(bytes.len());
                if a.is_based() {
                    a.refresh_redactions(text.redactions())?;
                }
                a.push(n, bytes)?;
                fresh = true;
            }
            // The channel is empty: what was sent before parts were left in the log is taken, so they come next.
            Err(RecvTimeoutError::Timeout) => {
                reading = from_log(&mut a, feed, text)?;
                fresh |= reading;
            }
            Err(RecvTimeoutError::Disconnected) => {
                while from_log(&mut a, feed, text)? {}
                if a.is_based() {
                    a.refresh_redactions(text.redactions())?;
                }
                return a.flush();
            }
        }
        if a.shelf.writes.bundles != indexed {
            a.shelf.flush()?;
            indexed = a.shelf.writes.bundles;
        }
        publish(&a);
        if fresh && viewed.elapsed() >= VIEWS_EVERY {
            a.publish_open()?;
            for (k, v) in a.open_views()? {
                a.shelf.put_view(&k, &v)?;
            }
            (fresh, viewed) = (false, std::time::Instant::now());
        }
    }
}

/// Where the archiver's parts come from: the channel, and the log for those left there ([`Handover`]). A fork's
/// archive (`based`) is handed records from `base` on, inputs too, by record; any other is handed parts (records that
/// are not inputs), numbered among the parts.
struct Feed {
    rx: Receiver<(u64, Vec<u8>)>,
    handover: Arc<Handover>,
    log: LogReader,
    based: bool,
    base: u64,
}

/// One batch of the parts left in the log, pushed in order; whether the read moved on.
fn from_log(
    a: &mut Archiver<Again>,
    feed: &mut Feed,
    text: &sim::text::Store,
) -> Result<bool, Refusal> {
    let Some((from, number, end)) = feed.handover.left() else {
        return Ok(false);
    };
    let before = feed.log.at.map(|at| at.record);
    let (records, reached) = feed.log.batch(from, end)?;
    let mut next = number;
    for (record, bytes) in records {
        if feed.based {
            if record < feed.base {
                continue;
            }
            a.refresh_redactions(text.redactions())?;
            a.push(record, bytes)?;
            next = record + 1;
        } else if !recorder::is_input(&bytes) {
            a.push(next, bytes)?;
            next += 1;
        }
    }
    feed.handover.read_to(reached.max(from), next)?;
    Ok(feed.log.at.map(|at| at.record) != before)
}

fn archive_bridge(
    store: &Bucket,
    archive: &mut Archiver<Again>,
    header: &Header,
    target: u64,
) -> Result<(), Refusal> {
    if archive.source_cursor() >= target {
        return Ok(());
    }
    let missing = || Refusal {
        name: "archive-source-missing",
        detail: "canonical source range is incomplete".into(),
    };
    let key = replica::directory::WorldRecord::key(&header.lineage.0, header.zone);
    let object = store.get(&key)?.ok_or_else(missing)?;
    let authority = replica::directory::WorldRecord::read(&object.bytes)?;
    let keys = store.list(&format!("part/{}/", key.trim_start_matches("world/")))?;
    while archive.source_cursor() < target {
        let cursor = archive.source_cursor();
        let mut found = None;
        for key in &keys {
            let object = store.get(key)?.ok_or_else(missing)?;
            let piece = shipping::Piece::read(&object.bytes)?;
            let Some(mut end) = piece.first.checked_add(piece.records.len() as u64) else {
                return Err(missing());
            };
            if piece.first <= cursor
                && cursor < end
                && let Some((_, actual, _)) = shipping::piece_at(store, &authority, piece.first)?
            {
                if piece != actual {
                    continue;
                }
                let mut superseded = false;
                for takeover in authority.takeovers.iter().filter(|t| t.from > piece.first) {
                    let key = replica::durability::part_key(
                        &authority.lineage,
                        authority.zone,
                        takeover,
                        takeover.from,
                    );
                    if store.get(&key)?.is_some() {
                        if takeover.from <= cursor {
                            superseded = true;
                            break;
                        }
                        end = end.min(takeover.from);
                    }
                }
                if !superseded {
                    found = Some((piece, end));
                    break;
                }
            }
        }
        let (piece, end) = found.ok_or_else(missing)?;
        if piece.header != header.stored() {
            return Err(Refusal {
                name: "archive-source-mismatch",
                detail: "canonical source header differs".into(),
            });
        }
        let start = usize::try_from(cursor - piece.first).map_err(|_| missing())?;
        for raw in &piece.records[start..] {
            if archive.source_cursor() >= end.min(target) {
                break;
            }
            archive.push(archive.source_cursor(), raw.clone())?;
        }
    }
    Ok(())
}

/// Existing immutable archive state wins; a first fork publication captures its original sealed source before
/// answers can start checkpoint pruning. Open-file identity checks refuse a symlink/replacement before reading it.
fn fork_archive_base<S: Store>(
    store: &S,
    prefix: &str,
    dir: &Path,
    header: &Header,
    newest: &[u8],
    found: &sim::log::Recovered,
) -> Result<ArchiveBase, Refusal> {
    let scoped = Under {
        store,
        prefix: prefix.to_owned(),
    };
    if scoped.get("archive/head")?.is_some() {
        let base = archive::fetch(&scoped, "")?.base.ok_or_else(|| Refusal {
            name: "archive-unbased-head",
            detail: "fork requires its durable based archive".into(),
        })?;
        if base.header != header.stored() {
            return Err(Refusal {
                name: "archive-base-mismatch",
                detail: "stored fork header differs".into(),
            });
        }
        return Ok(base);
    }
    use std::io::Read;
    use std::os::unix::fs::MetadataExt;
    let path = dir.join("checkpoints/ckpt-00000000000000000000");
    let io = |e: std::io::Error| Refusal {
        name: if e.kind() == std::io::ErrorKind::NotFound {
            "archive-source-missing"
        } else {
            "archive-source-io"
        },
        detail: format!("original fork checkpoint: {:?}", e.kind()),
    };
    let before = std::fs::symlink_metadata(&path).map_err(io)?;
    if !before.is_file() || before.file_type().is_symlink() {
        return Err(Refusal {
            name: "archive-source-invalid",
            detail: "original fork checkpoint must be regular".into(),
        });
    }
    let mut file = std::fs::File::open(&path).map_err(io)?;
    let opened = file.metadata().map_err(io)?;
    let after = std::fs::symlink_metadata(&path).map_err(io)?;
    if !opened.is_file()
        || !after.is_file()
        || after.file_type().is_symlink()
        || (before.dev(), before.ino()) != (opened.dev(), opened.ino())
        || (before.dev(), before.ino()) != (after.dev(), after.ino())
    {
        return Err(Refusal {
            name: "archive-source-changed",
            detail: "original fork checkpoint changed before capture".into(),
        });
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(io)?;
    ArchiveBase::initial_fork(header.stored(), &bytes, newest, found)
}

/// Already captured recovery source and the same authoritative text Store, kept together at startup.
struct SourceContext<'a> {
    recovered: &'a sim::log::Recovered,
    /// The archive's first part number after the log's cut (the cut file's note; 0 for a log never compacted).
    parts_from: u64,
    checkpoint: Option<&'a [u8]>,
    text: Arc<sim::text::Store>,
}

/// Claims the world in the store `spec` names ([`supervisor::bucket::Bucket`]) and starts its shipper and archiver,
/// handed the log's records read at the start (numbered from `first`) from the claim's start on.
fn off_machine(
    spec: &str,
    machine: &str,
    built: &Built,
    name: &str,
    dir: &Path,
    source: SourceContext<'_>,
) -> R<Off> {
    let SourceContext {
        recovered,
        parts_from,
        checkpoint,
        text,
    } = source;
    let (first, records) = (recovered.first, recovered.records.as_slice());
    let store: Bucket = Shared(Arc::new(Patient::new(
        supervisor::bucket::Bucket::from_spec(spec)
            .map_err(refusal)?
            .for_world(),
    )));
    println!("store: {}", store.0.store.what());
    let prefix = format!("h/{name}/{}/", to_hex(&built.header.lineage.0));
    // A fork's archive base decides how its records go to the archive, so it is read before the world listens: tried
    // until the store answers, never an exit on a slow one (R17). An unforked world reads nothing here.
    let fork_base = checkpoint
        .map(|newest| {
            until_answered("the fork's archive base", &measures::ARCHIVE, || {
                fork_archive_base(&store, &prefix, dir, &built.header, newest, recovered)
            })
        })
        .transpose()
        .map_err(refusal)?;
    let machine = Name::new(machine).ok_or_else(|| format!("--machine {machine}: not a name"))?;
    let (lineage, zone) = (built.header.lineage.0, built.header.zone);
    let end = first + records.len() as u64;
    // R17: the claim and the shipper's open read the store, so they are made on the shipper's own thread, tried until
    // the store answers, while the world listens and serves. Records wait in `ship` meanwhile, every one from the
    // log's first; the shipper passes over those its claim already holds. Until it opens, its marks hold the whole
    // log from the compactor.
    let (ship, items) = channel::<Item>();
    let mark = shipping::Mark::default();
    let shared = mark.clone();
    let (claim_store, header, checkpoints) = (
        store.clone(),
        built.header.stored().to_vec(),
        dir.join("checkpoints"),
    );
    let claim = move || -> Result<Shipper<Bucket, Wall>, Refusal> {
        let mut d = Directory::new(claim_store.clone(), machine.clone());
        match d.world(&lineage, zone) {
            Err(e) if e.name == "record-missing" => {
                // The build pinned on a first claim: the launcher's hash (`$WORLDD_BUILD`), as a SHA-256 multihash.
                let pin = std::env::var("WORLDD_BUILD").unwrap_or_else(|_| "unpinned".to_owned());
                let mut build = vec![0x12, 0x20];
                build.extend_from_slice(&sha256(pin.as_bytes()));
                d.set_build(&lineage, zone, &build)?;
            }
            Err(e) => return Err(e),
            Ok(_) => {}
        }
        let claim = shipping::take_over(&mut d, &lineage, zone, first..end)?;
        let from = claim.takeover.from;
        let _ = writeln!(
            std::io::stdout(),
            "shipping: epoch {} from record {from} of {end}",
            claim.takeover.epoch
        );
        Ok(
            Shipper::open(d, claim, lineage, zone, &header, from, Wall::start())?
                .checkpoints(&checkpoints, shipping::CHECKPOINT_GAP_US)
                .sharing(&shared),
        )
    };
    measures::SHIPPING.recovering();
    // Set once the claim is held; the archive writes nothing before it.
    let claimed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let claiming = Arc::clone(&claimed);
    let opening = std::thread::Builder::new()
        .name("shipping".into())
        .spawn(move || -> Result<(), Refusal> {
            // R18: a test's forced panic on this thread, before the claim (`tests/serve.rs`); a debug build's only.
            #[cfg(debug_assertions)]
            if std::env::var_os("WORLDD_TEST_PANIC_SHIPPING").is_some() {
                panic!("WORLDD_TEST_PANIC_SHIPPING");
            }
            // Only a store that does not answer is waited for. Any other refusal (`restart-gap`, another machine's
            // claim, a record that does not decode) ends the process by name, as before R17: serving on with no claim
            // would number new records over ones already off the machine.
            let shipper = until_answered("shipping", &measures::SHIPPING, || patiently(&claim))
                .unwrap_or_else(|e| refused_at_start(e));
            // The claim is held: the archive may write.
            claiming.store(true, std::sync::atomic::Ordering::SeqCst);
            let (to, _, h) = shipper.spawn();
            // R18: the shipper stopping while the world runs (a panic, or a refused push such as `ship-gap`) would
            // freeze its marks, so it ends the process by name. Only its last flush, once the records' sender is
            // dropped as the world ends, is said and passed over.
            let ending = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let ended = Arc::clone(&ending);
            std::thread::spawn(move || match h.join() {
                Err(panic) => shipping_panicked(panic.as_ref()),
                Ok(Err(e)) if !ended.load(std::sync::atomic::Ordering::SeqCst) => {
                    refused_at_start(e)
                }
                Ok(Err(e)) => {
                    let _ = writeln!(
                        std::io::stderr(),
                        "worldd: the shipper's last flush: {}",
                        refusal(e)
                    );
                }
                Ok(Ok(_)) => {}
            });
            let mut lost = false;
            for item in items {
                if to.send(item).is_err() {
                    lost = true;
                    break;
                }
            }
            if !lost {
                ending.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            drop(to);
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    // R18: a panic on the shipping thread ends the process by name; its refusals already do (`refused_at_start`).
    std::thread::spawn(move || {
        if let Err(panic) = opening.join() {
            shipping_panicked(panic.as_ref());
        }
    });
    let mut based = false;
    let mut archive_base = 0;
    let again = Again {
        store: Under {
            store: store.clone(),
            prefix,
        },
        public: dir.join("history"),
        header: built.header.stored().to_vec(),
    };
    let mut archive_floor = None;
    let handover = Handover::new(ARCHIVE_WINDOW);
    let feed = |rx, based, base| Feed {
        rx,
        handover: Arc::clone(&handover),
        log: LogReader {
            path: dir.join("log"),
            at: None,
        },
        based,
        base,
    };
    let archive = if let Some(base) = fork_base {
        // The opened archive's base is this one: `fork_archive_base` read the stored head's base, as the open does.
        based = true;
        archive_base = base.record;
        let (store, header, words) = (store.clone(), built.header.clone(), Arc::clone(&text));
        let claimed = Arc::clone(&claimed);
        let open = move || {
            held(&claimed);
            let mut a =
                Archiver::open_based_with_redactions(again.clone(), "", &base, words.redactions())?;
            archive_bridge(&store, &mut a, &header, first)?;
            if a.source_base() != base.record {
                return Err(Refusal {
                    name: "archive-base-mismatch",
                    detail: "opened archive base differs".into(),
                });
            }
            again.put("header", header.stored(), When::Absent)?;
            again.restore_public()?;
            Ok(a)
        };
        let (tx, rx) = channel();
        let closed = Arc::new(std::sync::atomic::AtomicU64::new(archive_base));
        archive_floor = Some(crate::compactor::Archive::Records(Arc::clone(&closed)));
        let publish = move |n| closed.store(n, std::sync::atomic::Ordering::Relaxed);
        report(
            "the archiver",
            archiving(
                open,
                feed(rx, true, archive_base),
                Arc::clone(&text),
                publish,
                &STREAM_RETRY_MS,
            ),
        );
        Some(tx)
    } else if let Some(kind) = built
        .header
        .kinds
        .iter()
        .find(|k| k.as_str().starts_with("souls:place@"))
        .cloned()
    {
        // R17: its open reads the store (the header, the bundle index, the public history), so it runs on the
        // archiver's thread as a fork's does; parts wait in `rx` meanwhile, in order.
        // It writes nothing before the world's claim is held. As with the claim, only a store that does not answer
        // is waited for; any other refusal ends the process by name, as before R17.
        let (header, claimed) = (built.header.clone(), Arc::clone(&claimed));
        let open = move || {
            held(&claimed);
            let opened = (|| -> Result<Archiver<Again>, Refusal> {
                again.put("header", header.stored(), When::Absent)?;
                let a = Archiver::open(again.clone(), "", &header, zone, kind.clone())?;
                again.restore_public()?;
                Ok(a)
            })();
            match opened {
                Err(e) if e.name != "store-unreachable" => refused_at_start(e),
                opened => opened,
            }
        };
        let (tx, rx) = channel();
        let parts = Arc::new(crate::compactor::Parts::new(parts_from));
        let reach = Arc::clone(&parts);
        let publish = move |n| reach.durable.store(n, std::sync::atomic::Ordering::Relaxed);
        archive_floor = Some(crate::compactor::Archive::Parts(parts));
        report(
            "the archiver",
            archiving(
                open,
                feed(rx, false, 0),
                Arc::clone(&text),
                publish,
                &STREAM_RETRY_MS,
            ),
        );
        Some(tx)
    } else {
        None
    };
    let mut off = Off {
        ship,
        archive,
        handover,
        parts: parts_from,
        based,
        archive_base,
        mark,
        floor: archive_floor,
    };
    // Every record to both: the shipper passes over those under its claim's start, which it learns on its own thread.
    for (k, bytes) in records.iter().enumerate() {
        off.take(first + k as u64, bytes, recorder::is_input(bytes));
    }
    Ok(off)
}

/// The world's one creator, read from its record in the directory `spec` names (G1e, #3532) at the start, and again
/// each [`CREATOR_EVERY`] on a thread of its own: a change replaces it (there is never more than one), and a failed
/// read keeps the last.
fn creator(spec: &str, built: &Built) -> R<Arc<Creator>> {
    let store = Patient::new(supervisor::bucket::Bucket::from_spec(spec).map_err(refusal)?);
    let (lineage, zone) = (built.header.lineage.0, built.header.zone);
    let read = Arc::new(move || directory_creator_of(&store, &lineage, zone));
    let admission = Arc::clone(&read);
    // R17: one try at the start: the list and the name record, two reads of up to the client's 5 s each, so about 10 s
    // at most before listening. A store that does not answer starts the world with no creator known (edits fail
    // closed), `degraded` in health.json, and the creator's thread tries again until the store answers.
    let (first, waiting) = match read() {
        Ok(c) => {
            measures::CREATOR.current();
            (c, false)
        }
        Err(e) if e.name == "store-unreachable" => {
            let fault = refusal(e);
            measures::CREATOR.degraded(&fault, 1, STREAM_RETRY_MS[0]);
            eprintln!(
                "worldd: the creator's record waits for the store: {fault}; the world starts without it"
            );
            (None, true)
        }
        Err(e) => return Err(refusal(e)),
    };
    let creator = Arc::new(Creator::with_reader(
        first,
        Arc::new(move || admission().ok().flatten()),
    ));
    let say = |c: Option<Id>| c.map_or_else(|| "none".to_owned(), principal_text);
    println!("creator: {}", say(first));
    let watched = Arc::clone(&creator);
    std::thread::Builder::new()
        .name("creator".into())
        .spawn(move || {
            if waiting
                && let Ok(c) = until_answered("the creator's record", &measures::CREATOR, || {
                    patiently(|| read())
                })
                && watched.set(c)
            {
                println!("creator: {}", say(c));
            }
            loop {
                std::thread::sleep(CREATOR_EVERY);
                match read() {
                    Ok(c) if watched.set(c) => println!("creator: {}", say(c)),
                    Ok(_) => {}
                    Err(e) => eprintln!("worldd: the creator's record: {}", refusal(e)),
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(creator)
}

/// `worldd serve --dir <world folder> [--socket <path>] [--checkpoint-every <bytes>] [--compact-after <bytes>]
/// [--store <store>] [--machine <name>] [--rate <num>/<den>]`: runs the world until killed. A checkpoint is taken each
/// `--checkpoint-every` bytes of log (default 8 MiB); the log is compacted once every reader has passed at least
/// `--compact-after` bytes of it (default 64 MiB, `compactor`). The clock's rate is world µs per real µs (default 1/1); a start whose rate differs from the
/// last logged applies a new mapping, and the mapping in force is on the zone root for every copy (E7b, #3516). With
/// `--sleep <alarm daemon's socket> [--world-name <name>]` (O2, the launcher's), a still world with nothing due for a
/// minute goes to sleep and exits 75 (`sleep.rs`); its name is its folder's unless given.
pub fn run(args: &[String]) -> i32 {
    crate::stopped::install(); // D6: a SIGTERM or SIGINT leaves one line naming it
    match serve(args) {
        Ok(()) => 0,
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "worldd serve: {e}");
            1
        }
    }
}

fn serve(args: &[String]) -> R<()> {
    let _ = STARTED.set(std::time::Instant::now());
    stamp("launch");
    // A test's long load (#4013's A2): `$WORLDD_HOLD_LOAD_S` seconds of progress first. Only in a build with the
    // `hold-load` feature (v2/tools/ops/x5-start-progress.sh); a release build has no hold.
    #[cfg(feature = "hold-load")]
    for _ in 0..std::env::var("WORLDD_HOLD_LOAD_S").map_or(0, |s| s.parse::<u64>().unwrap_or(0)) {
        std::thread::sleep(std::time::Duration::from_secs(1));
        stamp("held");
    }
    let dir = PathBuf::from(arg(args, "--dir").ok_or(
        "usage: worldd serve --dir <world folder> [--socket <path>] [--checkpoint-every <bytes>] \
         [--compact-after <bytes>] [--store <store>] [--machine <name>] [--directory <file>] [--rate <num>/<den>] \
         [--sleep <alarm socket> [--world-name <name>]]",
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
    let catalogue = match std::fs::read_to_string(dir.join("bodies.json")) {
        Ok(text) => skills::wear::Catalogue::read(&text)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => skills::wear::Catalogue::default(),
        Err(e) => return Err(format!("body-catalogue: {e}")),
    };
    let mut born = born(&meta, &catalogue)?;
    // The body classes its catalogue admits, their grounds cut with the towns (S12).
    let classes: Vec<_> = catalogue.classes().collect();
    let facts = dir.join("facts.json");
    let mut kinds = Vec::new();
    if dir.join("entries").is_dir() {
        entries(&dir.join("entries"), &mut kinds)?;
    }
    stamp("entries");
    let _ = COURSES_CACHE.set(dir.join("facts.courses"));
    // S5: a world's newest checkpoint is read while its facts are built (a fork reads its own below), once for the
    // towns and the stream and once for the engine, which takes its own copy.
    let read_newest = || {
        let d = dir.join("checkpoints");
        std::thread::spawn(move || match d.is_dir() {
            true => sim::checkpoint::restore(&d),
            false => Ok(None),
        })
    };
    let restoring = (meta.get("fork") != Some(&Json::Bool(true))).then(read_newest);
    let engine_restoring = Some(read_newest());
    // The world's stock (#4837): one that does not read is said, and the world serves with none.
    let stock = worldd::stock::Data::read(&dir).unwrap_or_else(|e| {
        eprintln!("worldd: stock not read ({e}); a take carries nothing");
        None
    });
    let built = build_stocked(
        &std::fs::read_to_string(&facts).map_err(io(&facts))?,
        &kinds,
        stock.as_ref(),
    )?;
    if stock.is_some() {
        println!(
            "stock: {} containers stocked, {} library words",
            built.stock.stocks.len(),
            built.stock.words.len()
        );
    }
    // A Soul's body runs its family's forms (E21, #2791): a wave or a bow on its own body.
    replica::kinds::entry::family_forms(&mut kinds, plain(&built.body_kind));
    let stored_header = if meta.get("fork") == Some(&Json::Bool(true)) {
        let header =
            replica::effects::Header::read(&std::fs::read(dir.join("header")).map_err(io(&dir))?)
                .map_err(refusal)?;
        if header.zone != built.root
            || header.kinds != built.header.kinds
            || std::fs::read(dir.join("boot")).map_err(io(&dir))?
                != public_boot(&dir, &built.header)?
        {
            return Err("served-fork-support-mismatch".into());
        }
        Some(header)
    } else {
        None
    };
    let name = stored_header.as_ref().map_or_else(
        || instance(built.root),
        |h| {
            format!(
                "{}-{}-{}",
                to_hex(&h.lineage.0),
                to_hex(&h.zone.scope().0),
                h.zone.counter()
            )
        },
    );
    if meta.get("name").and_then(Json::str) != Some(name.as_str()) {
        return Err("world-identity-mismatch".into());
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
    let names: Vec<&str> = built
        .activities
        .iter()
        .map(|a| plain(a.name.as_str()))
        .collect();
    println!("activities: {}", names.join(", "));
    let mut built = built;
    // The log read through once: its records feed the stream from record 0; then the loop opens it.
    let log_path = dir.join("log");
    let (log, found) =
        Log::open(FileStore::open(&log_path).map_err(refusal)?, EPOCH).map_err(refusal)?;
    // Shared with the public stream's thread, which reads it after the world has started (#3746).
    let found = Arc::new(found);
    let store = log.close();
    // K16: a world is served under its own header, the one its log names, never one rebuilt from this build's code.
    // A fork's is its `header`, checked above against this build's kinds.
    if stored_header.is_none() {
        let (header, owners) = own_header(&dir, &built, &found.records)?;
        let _ = adopt(&mut built, header, &owners);
    }
    // A fork's checkpoint is its authoritative base. Seed all readers with that base, then replay only later
    // records; imported facts contribute registered geometry/definitions, never replacement world state.
    let started = if let Some(header) = stored_header {
        let restored = sim::checkpoint::restore(&dir.join("checkpoints"))
            .map_err(refusal)?
            .ok_or("served-fork-checkpoint-missing")?;
        if restored.root.version.lineage != header.lineage
            || restored.root.version.zone != header.zone
        {
            return Err("served-fork-checkpoint-mismatch".into());
        }
        stamp("checkpoint restore");
        let record = restored.root.record;
        let checkpoint = view_out::capture_checkpoint(
            &dir.join("checkpoints").join(format!("ckpt-{record:020}")),
            &restored.root,
        )
        .map_err(refusal)?;
        let initial = Replica::restored(
            header.clone(),
            restored.tree,
            restored.root.version.sequence,
        );
        let mut live = initial.frozen();
        let needs_mapping = !initial
            .tree()
            .time()
            .iter()
            .any(|t| matches!(t, TimeEffect::Mapping(_)));
        let mut observer = None;
        let observed_real = answers::now();
        for (offset, bytes) in found.after(record).iter().enumerate() {
            crate::progress();
            if !recorder::is_input(bytes) {
                let part = replica::effects::Part::read(bytes).map_err(refusal)?;
                live.apply(&part).map_err(refusal)?;
                // Only a fully validated durable part may provide an observer before the checkpoint's first clock.
                if needs_mapping && observer.is_none() {
                    observer = first_stream_mapping(
                        &part,
                        &header,
                        record.max(found.first) + offset as u64,
                        observed_real,
                    );
                }
            }
        }
        stamp("log applied");
        built.header = header.clone();
        let doors = Doors::new(header, built.rules.clone(), live.tree().next());
        let towns = Town::with_planner_classes_on(
            live.tree().frozen(),
            built.ground,
            doors,
            sim::ground::START_THREADS,
            classes.iter().copied(),
        )
        .map_err(|e| format!("the fork's town: {e}"))?;
        stamp("town and planner");
        let resumed = initial.frozen();
        (
            initial,
            Some((resumed, record)),
            observer,
            Some(checkpoint),
            towns,
        )
    } else {
        let initial = Replica::start(built.header.stored()).map_err(refusal)?;
        // The newest checkpoint that verifies (K5) is where the engine resumes (`answers::start`), so the towns and
        // the views' hub start from it too, with only the log after it applied: a restart's work follows the log
        // since the last checkpoint, never the world's age (#3837). Without one, the log from record 0.
        let restored = restoring
            .ok_or("checkpoint-restore-missing")?
            .join()
            .map_err(|_| "checkpoint-restore-panicked")?
            .map_err(refusal)?;
        match restored {
            Some(r) => {
                if r.root.version.lineage != built.header.lineage
                    || r.root.version.zone != built.header.zone
                {
                    return Err("checkpoint-world-mismatch".into());
                }
                if found.first > r.root.record {
                    return Err(format!(
                        "log-compacted-past-checkpoint: the log is kept from record {}, the checkpoint is at {}",
                        found.first, r.root.record
                    ));
                }
                stamp("checkpoint restore");
                let record = r.root.record;
                let at =
                    Replica::restored(initial.header().clone(), r.tree, r.root.version.sequence);
                let towns = recovered_towns(&built, &at, found.after(record), &classes)?;
                (initial, Some((at, record)), None, None, towns)
            }
            None if found.first > 0 => {
                return Err(format!(
                    "log-compacted-past-checkpoint: the log is kept from record {} and no checkpoint verifies",
                    found.first
                ));
            }
            None => {
                let towns = recovered_towns(&built, &initial, &found.records, &classes)?;
                (initial, None, None, None, towns)
            }
        }
    };
    // `resumed` is the engine's starting point (a checkpoint's tree and record) when it differs from the stream's.
    let (initial, resumed, stream_mapping, checkpoint, (mut town, planner)) = started;
    let base_record = resumed.as_ref().map_or(0, |(_, r)| *r);
    // The body classes' grounds were cut with the towns (S12), each once, the planner given a copy.
    stamp("body classes");
    // The world's entry (C3): `world.json`'s `entry`, else the first place it lists for a Soul. The ground that holds
    // it is the main ground: a stand point or a restart is never put in ground no walk from there reaches.
    let int = |v: &Json| match v {
        Json::Int(n) => i64::try_from(*n).ok(),
        _ => None,
    };
    let entry = match meta.get("entry").and_then(Json::arr) {
        Some([x, z]) => int(x).zip(int(z)),
        _ => None,
    }
    .or_else(|| souls.first().map(|(_, x, z)| (*x, *z)))
    .map_or(Vec3::ZERO, |(x, z)| Vec3::new(x * 1000, 0, z * 1000));
    town.set_entry(entry);
    // Births by the world's arrival place (`world.json`'s `arrival`, the middle of a place its facts name), else the
    // entry. A named place the facts no longer hold never keeps the world from starting: its Souls arrive at the
    // entry, and the start says why.
    let arrived = match meta.get("arrival") {
        None => None,
        Some(_) => std::fs::read_to_string(&facts)
            .map_err(|e| e.to_string())
            .and_then(|text| arrival(&meta, &text))
            .unwrap_or_else(|e| {
                eprintln!("worldd: arrival-refused: {e}; Souls arrive at the entry");
                None
            }),
    };
    if let Some((x, z)) = arrived {
        println!(
            "worldd: Souls arrive at {} ({:.3},{:.3} m)",
            meta.get("arrival").and_then(Json::str).unwrap_or(""),
            x as f64 / 1000.0,
            z as f64 / 1000.0
        );
    }
    let birth = arrived.map_or(entry, |(x, z)| Vec3::new(x * 1000, 0, z * 1000));
    match town.main_ground() {
        Some((held, dry)) => println!(
            "main ground: the entry's part holds {held} of {dry} dry pieces; the rest is sealed off from it"
        ),
        None => println!("main ground: no dry ground at the entry; no ground is sealed"),
    }
    let (places, things, all, left, moved) = worldd::places::register(&mut town, &kinds);
    let runs = worldd::places::runs(&town, &kinds, &places);
    let mut trips = worldd::places::ride_trips(&town, &kinds, &places);
    // A ride that flies a loop from its stop and has no course in the tree (a world seeded before its rides flew: Eden's
    // launch balloon on soul.game) is given its course at the first tick, and its trips end at home as a seeded one's.
    let given = worldd::places::rides_given(&town, &kinds);
    for (thing, _) in &given {
        let node = town.tree.handle(*thing).and_then(|h| town.tree.node(h));
        let ends = node
            .and_then(|n| {
                let name = import_eden::entry_name(n.kind().as_str(), n.fields());
                kinds.iter().find(|(k, _)| k == name)
            })
            .map(|(_, e)| sim::courses::rides::trip_ends(e))
            .unwrap_or_default();
        if !ends.is_empty() && places.iter().any(|p| p.thing == *thing) {
            trips.push((*thing, ends));
        }
        println!(
            "ride given its course at the first tick: {}",
            replica::world_model::show(*thing)
        );
    }
    stamp("places to sit placed");
    for (thing, r) in &runs {
        // As a balloon's loop is printed (`with_rides`): where a client's own timetable can be checked.
        println!(
            "ride slot: {} slot {}, lap {} us from {} us, {} stops to get on and off at",
            replica::world_model::show(*thing),
            r.slot,
            r.course.load().map_or(0, |t| t.period),
            r.course.t0,
            r.stops.len()
        );
    }
    let closed_kinds = worldd::closed::Closed::of(&kinds);
    // The declared seats a thing's own shape has none of (#4092), each named, so the line accounts for every one.
    let not_on = not_on_things(&town.tree, &kinds);
    let count = |bare: bool| -> usize {
        not_on
            .iter()
            .filter(|t| t.own.is_empty() == bare)
            .map(|t| t.slots.len())
            .sum()
    };
    let (bare, beyond) = (count(true), count(false));
    for t in &not_on {
        let nums = |v: &[u64]| v.iter().map(u64::to_string).collect::<Vec<_>>().join(", ");
        println!(
            "body slot not on the thing: {} slot {} of {}; its own slots: {}",
            replica::world_model::show(t.thing),
            nums(&t.slots),
            t.entry,
            if t.own.is_empty() {
                "none".to_owned()
            } else {
                nums(&t.own)
            }
        );
    }
    println!(
        "places to sit or lie: {} registered on {} things; {all} body slots declared; {left} with no floor; {bare} on \
         things with no slots of their own; {beyond} past a thing's own slots; {moved} stand points moved to clear ground",
        places.len(),
        things
    );
    // The activities as served (after `adopt`, so by the header's pins), read before the entries become the rules.
    let served = served_activities(
        &kinds,
        &built.activities,
        &worldd::moves::library().map_err(refusal)?,
    );
    let rules = Rules {
        kinds: Json::Obj(kinds),
        moves,
    };
    // The joined-part rule the world checks every write on (B18, B20 #3356), read from its entries.
    let joined = sim::structure::Structure::from_entries(&rules.kinds);
    let (bays, standing, bearing) = joined.kinds();
    println!(
        "joined parts: bays [{}], standing [{}], bearing [{}]",
        bays.join(", "),
        standing.join(", "),
        bearing.join(", ")
    );
    let bucket = arg(args, "--store")
        .cloned()
        .or_else(|| std::env::var("WORLDD_STORE").ok())
        .or_else(|| std::env::var(directoryd::directory::s3::URL_ENV).ok())
        .filter(|s| !s.trim().is_empty());
    let creator = match &bucket {
        Some(spec) => Some(creator(spec, &built)?),
        None => None,
    };
    // K16's text store on the disk, `<dir>/log.text` beside the log as `gateway-link` keeps it (O20b, #3523): a
    // world's words outlive a restart, and O20's shipper has them to ship.
    let text = sim::text::Store::open_dir(
        &dir.join("log.text"),
        replica::ids::Minter::new(worldd::words::scope(built.header.lineage)),
    )
    .map_err(|e| format!("the text store: {}", refusal(e)))?;
    let text = Arc::new(text);
    let mut off = match &bucket {
        Some(spec) => {
            let machine = arg(args, "--machine")
                .cloned()
                .or_else(|| std::env::var("WORLDD_MACHINE").ok())
                .unwrap_or_else(|| "local".to_owned());
            let parts_from = sim::log::compact::read_cut(&log_path)
                .map_err(refusal)?
                .map_or(0, |c| c.note);
            // R17: no read of the store here ends the world. The claim, the shipper and the archive open on their own
            // threads, tried until the store answers (`shipping` and `archive` in health.json); only a fork's archive
            // base is read before listening, tried the same way.
            Some(off_machine(
                spec,
                &machine,
                &built,
                &name,
                &dir,
                SourceContext {
                    recovered: &found,
                    parts_from,
                    checkpoint: checkpoint.as_deref(),
                    text: Arc::clone(&text),
                },
            )?)
        }
        None => None,
    };
    let off_floors = off.as_ref().map(|o| (o.mark.clone(), o.floor.clone()));
    let (tx, synced) = channel();
    let mut looks = BTreeMap::new();
    imported_births(&dir, initial.header(), &catalogue, &mut born, &mut looks)?;
    let mut cfg = Config::new(built.header.lineage, EPOCH);
    cfg.public_names = Arc::clone(&built.public_names);
    cfg.stocks = Arc::clone(&built.stock.stocks);
    cfg.library_words = Arc::clone(&built.stock.words);
    cfg.closed = closed_kinds.clone();
    let every = arg(args, "--checkpoint-every").map_or(Ok(EVERY), |n| {
        n.parse::<u64>().map_err(|_| "--checkpoint-every <bytes>")
    })?;
    cfg.checkpoints = Some((dir.join("checkpoints"), every));
    cfg.restoring = engine_restoring;
    let compact_after = arg(args, "--compact-after")
        .map_or(Ok(crate::compactor::MIN_DEAD), |n| {
            n.parse::<u64>().map_err(|_| "--compact-after <bytes>")
        })?;
    cfg.health = Some(dir.join("health.json"));
    cfg.rate = Some(match arg(args, "--rate") {
        Some(r) => r
            .split_once('/')
            .and_then(|(n, d)| Some((n.trim().parse().ok()?, d.trim().parse().ok()?)))
            .ok_or("--rate <num>/<den>")?,
        None => (1, 1),
    });
    cfg.text = Some(Arc::clone(&text));
    let cfg_text = Some(Arc::clone(&text));
    // Gateway subscriptions have their own off-clock tier, apart from the filesystem stream below. Restore its
    // body, ownership and activity membership indexes before the answers thread can hand it any live part.
    let mut hub = worldd::views::subscription::Hub::with_words(text);
    hub.closed(&closed_kinds);
    hub.seed(resumed.as_ref().map_or(initial.tree(), |(at, _)| at.tree()));
    let feed = worldd::views::served::start_with(hub).map_err(refusal)?;
    for bytes in found.after(base_record) {
        crate::progress();
        if !recorder::is_input(bytes) {
            feed.record(bytes.clone());
        }
    }
    cfg.served = Some(feed.clone());
    worldd::views::served::listen(feed, &socket.with_extension("views")).map_err(refusal)?;
    // O20's shipper for the world's own stores (its words, uploads and removal list), keyed by its lineage as O12's
    // restore reads them back (O20b, #3523); with no bucket set it says so once and ships nothing.
    let lineage = to_hex(&built.header.lineage.0);
    let stores = directoryd::backup::owned_by("worldd", &[&lineage]).map_err(refusal)?;
    let strip = format!("worlds/{lineage}/");
    let backup = directoryd::backup::run("worldd", dir.clone(), stores, Default::default(), &strip)
        .map_err(|e| format!("refusing to start: {}", refusal(e)))?;
    println!("{backup}");
    cfg.synced = Some(tx);
    // A failed log or text store ends the process by name; the unit restarts the world from its log (#4134).
    cfg.halted = Some(answers::exit_on_halt());
    // E6's day, night and weather on Eden's calendar, written at the first tick of a world whose node holds none (C5).
    cfg.sky = Some(eden_sky(built.header.lineage));
    cfg.hatches = hatches(&dir.join("hatches"))?;
    // The engine's own acts (C2) and the activities they run (C30).
    cfg.engine = Some((built.rules.clone(), built.activities.clone()));
    // With a directory, its authoritative creator (including none) is always used; static metadata is only the
    // standalone seeded-world fallback. A lookup refused above ended the start; one the store did not answer (R17)
    // left no creator known until it does, so edits fail closed meanwhile.
    if let Some(c) = creator {
        cfg.edits = Some(Editing {
            // Not read: the checker takes the creator from `cfg.creator`.
            creator: built.header.zone,
            kinds: built.rules.kinds.clone(),
        });
        cfg.creator = Some(c);
    } else if let Some(c) = meta.get("creator").and_then(Json::str) {
        cfg.edits = Some(Editing {
            creator: creator_of(c)?,
            kinds: built.rules.kinds.clone(),
        });
    }
    let kinds_path = dir.join("world.kinds");
    std::fs::write(&kinds_path, &built.kinds_text).map_err(io(&kinds_path))?;
    // The activities as this start serves them, which the gateway hands out with the entries (`activities.json`).
    // Whole or not at all: the gateway may read it at any moment.
    let served_path = dir.join(ACTIVITIES_FILE);
    let tmp = served_path.with_extension("json.tmp");
    std::fs::write(&tmp, served.to_json()).map_err(io(&tmp))?;
    std::fs::rename(&tmp, &served_path).map_err(io(&served_path))?;

    let ground = built.ground;
    cfg.join = Some(Join {
        entry: (ground, birth),
        family: humanoid()?,
        kind: Name::new(&built.body_kind).ok_or("the body's kind")?,
        per_tick: 8,
    });
    cfg.wear = Some(answers::Wearing {
        catalogue,
        born,
        looks,
    });
    cfg.built_bodies = Some(Box::new(move |placed: &Placed, builds| {
        let b = bodies(
            town,
            planner,
            ground,
            entry,
            placed,
            places.clone(),
            runs.clone(),
            builds,
        )
        .map(|mut b| {
            // A balloon's trip ends when it is home again: what its start form set goes back.
            for (thing, ends) in &trips {
                b.slots.trip_ends(*thing, ends.clone());
            }
            for (thing, course) in &given {
                b.slots.give_course(*thing, course.clone());
            }
            b
        });
        stamp("places to sit registered");
        b
    }));
    // Capture and validate the public source before answers starts its K5 writer: normal pruning may remove an
    // eligible older checkpoint. The engine still starts from its newest restored state and unchanged clock.
    let views = dir.join("views");
    let key = Key {
        node: built.header.zone,
        level: Level::Full,
        audience: Audience::Everyone,
    };
    let stream_spec = bucket
        .as_deref()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("folder:{}", dir.join(".stream-recovery-store").display()));
    let stream_store = Patient::new(
        supervisor::bucket::Bucket::from_spec(&stream_spec)
            .map_err(refusal)?
            .for_world(),
    );
    // R15: the stream's backup to the store, on its own thread with its own client.
    let backup_store = supervisor::bucket::Bucket::from_spec(&stream_spec)
        .map_err(refusal)?
        .for_world();
    // ... and its clean-up of old generations, on another thread with another client (#4954): a slow delete holds
    // back no put.
    let cleanup_store = supervisor::bucket::Bucket::from_spec(&stream_spec)
        .map_err(refusal)?
        .for_world();
    // ... and the store's identity, kept with the head its backup last confirmed there: a digest of its address, so a
    // store moved to another bucket is learned again rather than fenced on.
    let backup_identity = replica::encode::to_hex(&replica::ids::sha256(stream_spec.as_bytes()));
    if let Some(seed) = stream_mapping {
        println!(
            "stream: initial mapping from durable record {} effect {}",
            seed.record, seed.sequence
        );
    }
    let mut public_start = view_out::PublicStart {
        root: &views,
        header: &built.header,
        key,
        initial: initial.frozen(),
        // A normal world's stream keeps its own source, the world as built and the log from its own cursor; only a
        // fork's starts from the fork's checkpoint.
        record: if checkpoint.is_some() { base_record } else { 0 },
        checkpoint,
        text: cfg_text,
        names: Some(Arc::clone(&built.public_names)),
        clock_seed: stream_mapping.map(|s| s.mapping),
        history: Some(&*found),
    };
    public_start
        .earlier_legacy_checkpoint(&dir.join("checkpoints"))
        .map_err(refusal)?;
    // The source is chosen; the public stream opens on its own thread below, from these parts.
    let view_out::PublicStart {
        key,
        initial: stream_initial,
        record: stream_record,
        checkpoint: stream_checkpoint,
        text: stream_text,
        names: stream_names,
        clock_seed: stream_clock,
        ..
    } = public_start;
    stamp("before replay");
    let world = answers::start(initial.frozen(), rules, store, cfg).map_err(refusal)?;
    stamp("replay");
    println!(
        "restart: checkpoint {:?}, {} records read, {} applied",
        world.restart.checkpoint, world.restart.read, world.restart.applied
    );
    // The log's compactor (#3837): the bytes every reader has passed go back to the disk.
    let stream_floor = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let (shipped, archive_floor) = off_floors.map_or((None, None), |(m, a)| (Some(m), a));
    crate::compactor::spawn(
        log_path.clone(),
        world.durable.clone(),
        crate::compactor::Floors {
            checkpoints: dir.join("checkpoints"),
            stream: Arc::clone(&stream_floor),
            shipped,
            archive: archive_floor,
        },
        compact_after,
    );
    let door = world.door();
    // The directory's word on the Souls (W11b): its file read now, before any intent is served, and again on a change.
    let told = arg(args, "--directory")
        .map(PathBuf::from)
        .unwrap_or_else(|| worldd::directory::beside(&dir.join("tokens")));
    let (answers, answered) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for frame in answered {
            eprintln!(
                "worldd: the directory's intent answered: {}",
                worldd::directory::show(&frame)
            );
        }
    });
    worldd::directory::watch(told, world.events.clone(), answers);
    crate::watchdog::watch(
        world.beat.clone(),
        crate::watchdog::Real::start(),
        crate::watchdog::LIMIT_MS,
    );
    let views_dir = views.clone();
    // "Listening" means servable: the public pointer (views/world.json) and the stream it names are there (#3746). A
    // restart already has them from its last run (the same header and key, so the same pointer); a fresh world waits
    // for the stream's first flush, which on a fresh world has no history to replay, at most STREAM_FIRST_WITHIN.
    let pointer_path = views.join("world.json");
    let fresh = !pointer_path.exists();
    // `true` once the stream serves, `false` for each refused try while it is degraded (R12).
    let (ready_tx, ready_rx) = channel::<bool>();
    let stream_header = built.header.clone();
    let stream_found = Arc::clone(&found);
    // What a closed container holds stays out of the public stream too (#3948).
    let stream_closed = closed_kinds.clone();
    // The history page's Back to live (#3661): the public stream this world serves now, written before listening.
    public_history_live(
        &dir,
        meta.get("name")
            .and_then(Json::str)
            .ok_or("history-live-invalid")?,
        &built.header,
        &key,
    )?;
    drop(found);
    let (stream_tx, stream_rx) = channel::<(u64, Vec<u8>)>();
    // O2 (0.133 S3b): the sleep watch asks the public stream to say the world is still until its next due change.
    let (sleep_tx, sleep_rx) = channel::<crate::sleep::Ask>();
    // Shipping/archive delivery remains independent of a stopped public observer.
    std::thread::Builder::new()
        .name("synced".into())
        .spawn(move || {
            for s in synced {
                if let Some(o) = &mut off {
                    o.take(s.record, &s.bytes, s.input);
                }
                let _ = stream_tx.send((s.record, s.bytes));
            }
        })
        .map_err(|e| e.to_string())?;
    // The public stream recovers its history on its own thread, as it already follows the world there: on a restarted
    // full-Eden fork that replay takes seconds, and the world serves meanwhile; records wait in `stream_rx` (#3746).
    std::thread::Builder::new()
        .name("public-stream".into())
        .spawn(move || {
            let result = (|| -> Result<(), Refusal> {
                let recover = || -> Result<_, Refusal> {
                    let start = view_out::PublicStart {
                        root: &views_dir,
                        header: &stream_header,
                        key,
                        initial: stream_initial.frozen(),
                        record: stream_record,
                        checkpoint: stream_checkpoint.clone(),
                        text: stream_text.clone(),
                        names: stream_names.clone(),
                        clock_seed: stream_clock,
                        history: Some(&*stream_found),
                    };
                    // Its recovery reads are the world's start: patient (#1960). Its recovery chain is written to the
                    // spool beside `views/` and backed up to the store behind the stream (R15).
                    let mut writer = patiently(|| {
                        view_out::PublicWriter::open_spooled(
                            start,
                            &stream_store,
                            stream_closed.clone(),
                            Some((
                                view_out::backup_beside(&views_dir),
                                backup_identity.clone(),
                            )),
                        )
                    })?;
                    // Both the pointer and placement bootstrap resolve the existing strict public history export.
                    let history = "history/";
                    let pointer = format!(
                        "{{\"stream\":\"views/{}/\",\"history\":\"{history}\"}}\n",
                        stream::dir(&stream_header, &key)
                    );
                    view_out::write_whole(&views_dir.join("world.json"), pointer.as_bytes())?;
                    // Physical cursor includes input records; public effect versions are independently validated by
                    // the observer.
                    writer.bridge_to(stream_found.first)?;
                    for (offset, bytes) in stream_found.records.iter().enumerate() {
                        let record = stream_found.first + offset as u64;
                        if record >= writer.source_cursor() {
                            writer.push(record, bytes)?;
                        }
                    }
                    writer.flush()?;
                    Ok(writer)
                };
                // R12: a refused recovery (the store out of reach or refusing, as a read past its cap did on 23 Nov)
                // never ends the world, which systemd would only start again into the same refusal. It stays up,
                // degraded: no public pointer, so no viewers; `health.json` names the fault; tried again with back-off
                // until the store answers. Records wait in `stream_rx` meanwhile.
                measures::STREAM.recovering();
                let mut tries = 0u64;
                let mut writer = loop {
                    match recover() {
                        Ok(w) => break w,
                        Err(e) => {
                            tries += 1;
                            let wait = STREAM_RETRY_MS[(tries as usize - 1).min(STREAM_RETRY_MS.len() - 1)];
                            let fault = refusal(e);
                            // Degraded before the pointer goes: the main thread's check of it reads both.
                            measures::STREAM.degraded(&fault, tries, wait);
                            let _ = std::fs::remove_file(views_dir.join("world.json"));
                            eprintln!(
                                "worldd: the public stream is degraded, no viewers: {fault}; try {tries} refused, the next in {wait} ms"
                            );
                            let _ = ready_tx.send(false);
                            // The wait, answering each ask to sleep meanwhile: a degraded stream writes no sleeping
                            // pointer, so the world stays awake.
                            for _ in 0..wait / 100 {
                                if let Ok((_, answer)) =
                                    sleep_rx.recv_timeout(std::time::Duration::from_millis(100))
                                {
                                    let _ = answer.send(Err(format!("stream-degraded: {fault}")));
                                }
                            }
                        }
                    }
                };
                // An ask made during the last try is as old as that try, its asker likely gone: answered no, never
                // taken for a sleep the world would not make (the stream would stop with it).
                while let Ok((_, answer)) = sleep_rx.try_recv() {
                    let _ = answer.send(Err("stream-recovering: asked before it served".to_owned()));
                }
                measures::STREAM.serving();
                if tries > 0 {
                    eprintln!("worldd: the public stream recovered after {tries} refused tries");
                }
                // R15: from here the store is the backup's: a stall or refusal delays only it, never a part.
                measures::BACKUP.backup(&view_out::BackupState::Current);
                writer.back_up(
                    backup_store,
                    cleanup_store,
                    Box::new(|state| measures::BACKUP.backup(&state)),
                )?;
                // ... and a stop (SIGTERM, SIGINT) gives it up to 8 s to hold the spool's head first, inside the
                // unit's 10 s stop timeout; best effort.
                // A stopping world writes nothing new to `views/`: the stream thread is asked to stop cutting first, and
                // the drain backs up only what is already spooled.
                let stopping = Arc::new((
                    std::sync::atomic::AtomicBool::new(false),
                    std::sync::atomic::AtomicBool::new(false),
                ));
                if let Some(d) = writer.drainer() {
                    let stopping = Arc::clone(&stopping);
                    crate::stopped::on_stop(move || {
                        use std::sync::atomic::Ordering;
                        stopping.0.store(true, Ordering::Release);
                        let parked = std::time::Instant::now() + std::time::Duration::from_secs(1);
                        while !stopping.1.load(Ordering::Acquire) && std::time::Instant::now() < parked {
                            std::thread::sleep(std::time::Duration::from_millis(5));
                        }
                        let held = d.drain(std::time::Duration::from_secs(8));
                        eprintln!(
                            "worldd: the public stream's backup {} before the stop",
                            if held { "is current" } else { "is still behind" }
                        );
                    });
                }
                let published = |w: &view_out::PublicWriter<_>| {
                    stream_floor.store(w.durable_cursor(), std::sync::atomic::Ordering::Relaxed)
                };
                published(&writer);
                stamp("public stream");
                let _ = ready_tx.send(true);
                drop(stream_found);
                loop {
                    // Stopping (SIGTERM, SIGINT): nothing more is cut or published; the process ends from the stop.
                    if stopping.0.load(std::sync::atomic::Ordering::Acquire) {
                        stopping.1.store(true, std::sync::atomic::Ordering::Release);
                        loop {
                            std::thread::park();
                        }
                    }
                    match stream_rx.recv_timeout(std::time::Duration::from_millis(20)) {
                        Ok((record, bytes)) => {
                            if record >= writer.source_cursor() {
                                writer.push(record, &bytes)?;
                            }
                            // What is already waiting first: a writer behind would cut a part a record (#3799).
                            while let Ok((record, bytes)) = stream_rx.try_recv() {
                                if record >= writer.source_cursor() {
                                    writer.push(record, &bytes)?;
                                }
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            writer.flush()?;
                            return Ok(());
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    }
                    // Going to sleep (S4w, #2731): what is waiting first, then the pointer still until `due`; once
                    // written, the world exits and this thread with it. Refused (`stream-sleep`): it stays awake.
                    if let Ok((due, answer)) = sleep_rx.try_recv() {
                        while let Ok((record, bytes)) = stream_rx.try_recv() {
                            if record >= writer.source_cursor() {
                                writer.push(record, &bytes)?;
                            }
                        }
                        let slept = writer.sleep(answers::now(), due).map_err(refusal);
                        let done = slept.is_ok();
                        // R15: before the world exits to sleep, its backup is given a little time to hold the spool's
                        // head, so a move finds the store current; best effort, and well inside the sleep watch's own
                        // wait for this answer (`sleep.rs` STREAM_WITHIN, 5 s).
                        if done && let Some(d) = writer.drainer() {
                            d.drain(SLEEP_DRAIN);
                        }
                        // The sleep is taken only when the watch hears it; one that gave up waiting stays awake, and so
                        // does the stream: its next idle writes the pointer without the sleep.
                        let heard = answer.send(slept).is_ok();
                        published(&writer);
                        if done && heard {
                            return Ok(());
                        }
                    }
                    writer.idle(answers::now())?;
                    published(&writer);
                }
            })();
            if let Err(e) = result {
                let fault = refusal(e);
                measures::STREAM.stopped(&fault);
                eprintln!("worldd: the public stream stopped, the world goes on: {fault}");
            }
        })
        .map_err(|e| e.to_string())?;
    // A fresh world waits for its stream's first flush, or for its first refused try (R12): then it listens degraded,
    // with no pointer, and the stream thread tries again until it serves. The wait is bounded ([`STREAM_FIRST_WITHIN`]):
    // a world with a history and no pointer (a rehearsal's scratch copy, a folder whose views were lost) rebuilds its
    // stream from record 0, which takes Eden minutes, and a stalled store holds the recovery's reads. Such a world
    // listens with its stream still `recovering`: no pointer while the store holds it, or a pointer naming the stream
    // still being rebuilt.
    if fresh
        && let Err(std::sync::mpsc::RecvTimeoutError::Disconnected) =
            ready_rx.recv_timeout(STREAM_FIRST_WITHIN)
    {
        return Err(
            "public-stream: stopped before its first flush; the world is not servable".into(),
        );
    }
    // ... and the clock runs: its first tick is done, after it reports the state this start resumes from (`worldd:
    // started at tick`). The public stream no longer holds the start-up path, so without this a restart could say
    // listening before the clock had started.
    while world.beat.read().0 < 0 {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    if !pointer_path.is_file()
        && !measures::STREAM.is_degraded()
        && !measures::STREAM.is_recovering()
    {
        return Err(format!(
            "public-pointer-missing: {}",
            pointer_path.display()
        ));
    }
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).map_err(io(&socket))?;
    stamp("listening");
    println!("listening {}", socket.display());
    crate::ready();
    // O2 (0.133 S3b): asleep when still and nothing is due for a minute (`sleep.rs`).
    if let Some(alarms) = arg(args, "--sleep") {
        let name = arg(args, "--world-name").cloned().unwrap_or_else(|| {
            dir.file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
        });
        crate::sleep::watch(
            name,
            PathBuf::from(alarms),
            Arc::clone(&world.quiet),
            world.durable.clone(),
            sleep_tx,
            STARTED.get().map_or(0, |t| {
                i64::try_from(t.elapsed().as_micros()).unwrap_or(i64::MAX)
            }),
        );
    }
    for stream in listener.incoming().flatten() {
        let door = door.clone();
        std::thread::spawn(move || answers::serve(door, stream));
    }
    Ok(())
}

#[cfg(test)]
fn stream_writer(
    views: &Path,
    header: &Header,
    key: &Key,
    initial: &replica::effects::State,
    restored: bool,
    real: i64,
    mapping: Option<StreamMapping>,
) -> Result<Writer, String> {
    let anchor = (real, (real / 1000) as u64);
    if restored {
        match mapping {
            Some(seed) => {
                Writer::resume_with_mapping(views, header, key, anchor, initial, seed.mapping)
            }
            None => Writer::resume(views, header, key, anchor, initial),
        }
        .map_err(refusal)
    } else {
        Writer::create(views, header, key, anchor).map_err(refusal)
    }
}

#[derive(Clone, Copy)]
struct StreamMapping {
    mapping: Mapping,
    record: u64,
    sequence: u64,
}

/// Called only after the existing live-copy replay has validated this whole canonical part.
fn first_stream_mapping(
    part: &replica::effects::Part,
    header: &Header,
    record: u64,
    real: i64,
) -> Option<StreamMapping> {
    for effect in &part.effects {
        if effect.envelope.node == header.zone
            && effect.envelope.audience == Audience::Everyone
            && let replica::effects::Body::Time(time) = &effect.body
        {
            for t in time {
                if let TimeEffect::Mapping(mapping) = t
                    && mapping.real_us <= real
                {
                    return Some(StreamMapping {
                        mapping: *mapping,
                        record,
                        sequence: effect.envelope.sequence,
                    });
                }
            }
        }
    }
    None
}

#[cfg(test)]
fn replay_stream(tier: &Tier, found: &sim::log::Recovered, base_record: u64) {
    for (k, bytes) in found.records.iter().enumerate() {
        let record = found.first + k as u64;
        if record >= base_record && !recorder::is_input(bytes) {
            tier.offer(record, bytes.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #4092: every body slot the entries declare is registered or counted under one reason. A one-seat tier naming
    /// the two-seat bench entry offers its slot 1, not 2; a toilet whose def has no slots offers none of its entry's; a
    /// pew with both slots offers both.
    #[test]
    fn every_declared_seat_is_offered_or_named_with_its_reason() {
        let thing = |id: &str, r: &str, entry: &str, slots: &str| {
            format!(
                r#"{{"id": "{id}", "def": "{r}", "ref": "{r}", "parent": null, "pose": [0, 0, 0, 0],
                "world": [0, 0, 0, 0], "scale_ppm": 1000000, "entry": "{entry}", "slots": [{slots}]}}"#
            )
        };
        let slot = |n: u8, x: i32| {
            format!(r#"{{"n": {n}, "id": "s{n}", "kind": "sit", "at": [{x}, 450, 0], "yaw": 0}}"#)
        };
        let facts = format!(
            r#"{{"format": "souls/import-eden/1",
            "kinds": [{{"ref": "core-tier@2", "hash": "aa", "name": "core:tier", "form": "point"}},
                      {{"ref": "core-toilet@1", "hash": "bb", "name": "core:toilet", "form": "point"}},
                      {{"ref": "core-pew@1", "hash": "cc", "name": "core:pew", "form": "point"}}],
            "things": [{}, {}, {}],
            "doors": [], "places": [], "bake": {{}}, "byRef": {{}}}}"#,
            thing("e_tier", "core-tier@2", "eden:bench", &slot(1, 0)),
            thing("e_toilet", "core-toilet@1", "eden:toilet", ""),
            thing(
                "e_pew",
                "core-pew@1",
                "eden:bench",
                &format!("{}, {}", slot(1, -300), slot(2, 300))
            ),
        );
        let im = import_eden::load(&facts).expect("loads");
        let entry = |text: &str| json::parse(text).expect("an entry");
        let kinds = vec![
            (
                "eden:bench".to_owned(),
                entry(
                    r#"{"kind": "eden:bench", "slots": {
                    "left": {"admits": "body", "posture": "sit", "at_mm": [-300, 450, 0], "stand": "fl"},
                    "right": {"admits": "body", "posture": "sit", "at_mm": [300, 450, 0], "stand": "fr"}},
                  "points": {"fl": {"role": "stand", "at_mm": [-300, 0, 600]},
                             "fr": {"role": "stand", "at_mm": [300, 0, 600]}}}"#,
                ),
            ),
            (
                "eden:toilet".to_owned(),
                entry(
                    r#"{"kind": "eden:toilet", "slots": {
                    "s": {"admits": "body", "posture": "sit", "at_mm": [0, 420, 0], "stand": "f"}},
                  "points": {"f": {"role": "stand", "at_mm": [0, 0, 600]}}}"#,
                ),
            ),
        ];
        let (found, all) = import_eden::body_slots(&im.tree, &kinds);
        let mut offered: Vec<_> = found.iter().map(|s| (s.thing, s.slot)).collect();
        offered.sort();
        let (tier, toilet, pew) = (im.nodes["e_tier"], im.nodes["e_toilet"], im.nodes["e_pew"]);
        let mut want = vec![(tier, 1u64), (pew, 1), (pew, 2)];
        want.sort();
        assert_eq!(offered, want);
        let mut not_on = not_on_things(&im.tree, &kinds);
        not_on.sort_by_key(|t| t.thing != tier);
        assert_eq!(
            not_on,
            vec![
                NotOnThing {
                    thing: tier,
                    entry: "eden:bench".into(),
                    slots: vec![2],
                    own: vec![1],
                },
                NotOnThing {
                    thing: toilet,
                    entry: "eden:toilet".into(),
                    slots: vec![1],
                    own: vec![],
                },
            ]
        );
        // Every declared slot is offered or named: 5 declared, 3 offered, 2 named.
        let named: usize = not_on.iter().map(|t| t.slots.len()).sum();
        assert_eq!((all, found.len() + named), (5, 5));
    }

    /// A boat is read from its entry's data: a `vehicle` on `deep_water` (a rowing boat at 1.5 m/s, a canoe), never a
    /// bicycle on level ground or a punt, whose course is its mooring's.
    #[test]
    fn a_boat_is_a_vehicle_on_deep_water_by_its_entry() {
        let read = |t: &str| json::parse(t).unwrap();
        let row = read(include_str!(
            "../../../../content/kinds/vehicles/rowing_boat.json"
        ));
        let canoe = read(include_str!(
            "../../../../content/kinds/vehicles/canoe.json"
        ));
        let bike = read(include_str!(
            "../../../../content/kinds/vehicles/bicycle.json"
        ));
        let punt = read(include_str!(
            "../../../../content/kinds/vehicles/rowing_punt.json"
        ));
        assert_eq!(boat_speed(&row), Some(1_500_000));
        assert!(boat_speed(&canoe).is_some());
        assert_eq!(boat_speed(&bike), None);
        assert_eq!(boat_speed(&punt), None);
    }

    /// 0.134 T1, T2 and T3: each `content/kinds/together` entry is an activity kind of two roles, each aiming the entry's move at
    /// the other, and the client offers each by the name the world pins (`v2/client/src/together/together.mjs`).
    #[test]
    fn t1_together_entries_are_the_activity_kinds_the_client_offers() {
        let read = |t: &str| json::parse(t).unwrap();
        let entries = vec![
            (
                "eden:dance_together".to_owned(),
                read(include_str!(
                    "../../../../content/kinds/together/dance_together.json"
                )),
            ),
            (
                "eden:handshake".to_owned(),
                read(include_str!(
                    "../../../../content/kinds/together/handshake.json"
                )),
            ),
            (
                "eden:high_five".to_owned(),
                read(include_str!(
                    "../../../../content/kinds/together/high_five.json"
                )),
            ),
            (
                "eden:hug".to_owned(),
                read(include_str!("../../../../content/kinds/together/hug.json")),
            ),
            (
                "eden:hold_hands".to_owned(),
                read(include_str!(
                    "../../../../content/kinds/together/hold_hands.json"
                )),
            ),
            (
                "eden:follow".to_owned(),
                read(include_str!(
                    "../../../../content/kinds/together/follow.json"
                )),
            ),
        ];
        let client = include_str!("../../../client/src/together/together.mjs");
        let kinds = activity_kinds(&entries).unwrap();
        for (k, mv) in kinds
            .iter()
            .zip(["dance", "", "handshake", "high_five", "hold_hand", "hug"])
        {
            println!("{}", k.name.as_str());
            assert_eq!(k.roles.len(), 2);
            // 0.135 G2: following names no move; its first role follows.
            if mv.is_empty() {
                assert!(k.roles.iter().all(|r| r.mv.is_none()));
                assert_eq!(k.follows.as_ref().map(Name::as_str), Some("eden:one"));
                continue;
            }
            assert_eq!(k.follows, None);
            // 0.135 G3: hold hands' two stand shoulder to shoulder, facing one way; the dance's eight in a ring.
            if mv == "hold_hand" {
                let s: Vec<(Vec3, i64)> = k.roles.iter().flat_map(|r| r.stands.clone()).collect();
                assert_eq!(
                    s,
                    vec![
                        (Vec3::new(-290_000, 0, 0), 0),
                        (Vec3::new(290_000, 0, 0), 0)
                    ]
                );
            }
            if mv == "dance" {
                assert_eq!(k.roles.iter().map(|r| r.stands.len()).sum::<usize>(), 8);
            }
            // 0.134 T3: the dance takes up to eight, on the beat; each touch is a pair.
            let dance = mv == "dance";
            assert_eq!((k.most, k.beat), if dance { (8, true) } else { (2, false) });
            for r in &k.roles {
                assert_eq!(
                    r.mv.as_ref().map(Name::as_str),
                    Some(format!("souls:{mv}").as_str())
                );
            }
        }
        // 0.135 G3: and 0.135 E1's two, whose pins hold their stands too.
        let more = [
            (
                "eden:fist_bump".to_owned(),
                read(include_str!(
                    "../../../../content/kinds/together/fist_bump.json"
                )),
            ),
            (
                "eden:harvest_together".to_owned(),
                read(include_str!(
                    "../../../../content/kinds/together/harvest_together.json"
                )),
            ),
        ];
        // The client offers them by the names the world serves (`activities.json`), never its own copy of a pin.
        let all: Vec<_> = entries.iter().chain(&more).cloned().collect();
        let kinds: Vec<_> = kinds
            .into_iter()
            .chain(activity_kinds(&more).unwrap())
            .collect();
        let served = served_activities(&all, &kinds, &worldd::moves::library().unwrap());
        assert_eq!(
            served.get("format").and_then(Json::str),
            Some("souls-activities/1")
        );
        let list = served.get("activities").and_then(Json::arr).unwrap();
        assert_eq!(list.len(), kinds.len());
        for (a, k) in list.iter().zip(&kinds) {
            assert_eq!(a.get("name").and_then(Json::str), Some(k.name.as_str()));
            assert!(!client.contains(k.name.as_str()), "no pin in the client");
        }
        let one = |kind: &str| {
            list.iter()
                .find(|a| a.get("kind").and_then(Json::str) == Some(kind))
                .unwrap()
        };
        let hug = one("eden:hug");
        assert_eq!(hug.get("word").and_then(Json::str), Some("hug"));
        assert_eq!(
            hug.get("card").and_then(Json::str),
            Some("A hug for two: offer it, and it starts when the other accepts.")
        );
        assert_eq!(hug.get("offerer").and_then(Json::str), Some("eden:one"));
        assert_eq!(hug.get("asks"), Some(&Json::Int(1)));
        assert!(
            hug.get("near_m").is_some() && hug.get("at").is_none(),
            "a hug is anywhere, within its reach"
        );
        assert_eq!(one("eden:dance_together").get("asks"), Some(&Json::Int(7)));
        assert!(
            one("eden:dance_together").get("near_m").is_none(),
            "a dance checks no distance"
        );
        assert!(
            one("eden:follow").get("near_m").is_none(),
            "following checks no distance"
        );
        assert_eq!(
            one("eden:harvest_together").get("at").and_then(Json::str),
            Some("eden:harvest_together"),
            "a harvest is played at its basket"
        );
    }

    #[test]
    fn v9b_public_history_live_binds_restored_header_and_refuses_unsafe_exports() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.local")
            .join(format!("v9b-history-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut header = archive::script::world(0, 0, None).header;
        let key = Key {
            node: header.zone,
            level: Level::Full,
            audience: Audience::Everyone,
        };
        public_history_live(&dir, "original-instance", &header, &key).unwrap();
        let read = || std::fs::read_to_string(dir.join("history/live")).unwrap();
        let first = read();
        let locator = json::parse(&first).unwrap();
        assert_eq!(
            locator.get("world").and_then(Json::str),
            Some("original-instance")
        );
        assert_eq!(
            locator.get("lineage").and_then(Json::str),
            Some(to_hex(&header.lineage.0).as_str())
        );
        let expected = format!("../views/{}/", stream::dir(&header, &key));
        assert_eq!(
            locator.get("stream").and_then(Json::str),
            Some(expected.as_str())
        );
        assert!(expected.ends_with("/1/everyone/"));
        public_history_live(&dir, "original-instance", &header, &key).unwrap();
        assert_eq!(
            read(),
            first,
            "same restored identity has stable navigation bytes"
        );
        header.epoch += 1;
        header = Header::read(&encode(&header.to_value()).unwrap()).unwrap();
        public_history_live(&dir, "restored-instance", &header, &key).unwrap();
        let restored = read();
        assert!(restored.contains(&stream::dir(&header, &key)));
        assert!(!restored.contains("original-instance"));
        assert!(public_history_live(&dir, "../foreign", &header, &key).is_err());
        let private = Key {
            audience: Audience::Of(header.zone),
            ..key
        };
        assert!(public_history_live(&dir, "restored-instance", &header, &private).is_err());
        assert_eq!(read(), restored);
        std::fs::remove_file(dir.join("history/live")).unwrap();
        std::os::unix::fs::symlink(dir.join("outside"), dir.join("history/live")).unwrap();
        assert!(public_history_live(&dir, "restored-instance", &header, &key).is_err());
        assert!(!dir.join("outside").exists());
        std::fs::remove_file(dir.join("history/live")).unwrap();
        std::fs::remove_dir(dir.join("history")).unwrap();
        std::fs::create_dir(dir.join("outside")).unwrap();
        std::os::unix::fs::symlink(dir.join("outside"), dir.join("history")).unwrap();
        assert!(public_history_live(&dir, "restored-instance", &header, &key).is_err());
        assert!(!dir.join("outside/live").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn public_boot_carries_only_a_valid_regular_catalogue() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.local")
            .join(format!("b15-public-boot-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("facts.json"), b"{}").unwrap();
        let header = archive::script::world(0, 0, None).header;
        let legacy = public_boot(&dir, &header).unwrap();
        let Value::Map(old) = replica::encode::decode(&legacy).unwrap().value else {
            panic!("map");
        };
        assert!(!old.contains_key(&7));
        let catalogue = br#"{"format":"souls/bodies/1","bodies":[{"preset":"large","hash":"0000000000000000000000000000000000000000000000000000000000000000","size":"large","height":1800,"hover":0}]}"#;
        std::fs::write(dir.join("bodies.json"), catalogue).unwrap();
        let Value::Map(new) = replica::encode::decode(&public_boot(&dir, &header).unwrap())
            .unwrap()
            .value
        else {
            panic!("map");
        };
        assert_eq!(new.get(&7), Some(&Value::Bytes(sha256(catalogue).to_vec())));
        for (key, value) in old {
            assert_eq!(new.get(&key), Some(&value));
        }
        std::fs::write(dir.join("bodies.json"), b"{}").unwrap();
        assert!(public_boot(&dir, &header).is_err());
        std::fs::remove_file(dir.join("bodies.json")).unwrap();
        assert_eq!(public_boot(&dir, &header).unwrap(), legacy);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("facts.json", dir.join("bodies.json")).unwrap();
            assert!(public_boot(&dir, &header).is_err());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn imported_birth_choices_are_private_bound_and_atomic() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../.local")
            .join(format!("b15-import-births-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let header = archive::script::world(0, 0, None).header;
        let hash = "11".repeat(32);
        let text = format!(
            r#"{{"format":"souls/bodies/1","bodies":[{{"preset":"chosen","hash":"{hash}","size":"standard","height":1750}}]}}"#
        );
        std::fs::write(dir.join("bodies.json"), &text).unwrap();
        let catalogue = skills::wear::Catalogue::read(&text).unwrap();
        let soul = Id::new(Scope([0x4b; 16]), 0).unwrap();
        let soul_text = directoryd::accounts::principal_text(soul);
        let zone = directoryd::accounts::principal_text(header.zone);
        let row = format!(r#"{{"soul":"{soul_text}","entry":"{zone}","asked":0,"body":"{hash}"}}"#);
        let make = |lineage: &str, zone: &str, digest: &str, rows: &str| {
            format!(
                r#"{{"format":"souls-births/1","world":"old-garden","lineage":"{lineage}","zone":"{zone}","catalogueHash":"{digest}","births":[{rows}]}}"#
            )
        };
        let lineage = to_hex(&header.lineage.0);
        let digest = to_hex(&sha256(text.as_bytes()));
        let valid = make(&lineage, &zone, &digest, &row);
        let mut born = BTreeMap::new();
        let mut looks = BTreeMap::new();
        imported_births(&dir, &header, &catalogue, &mut born, &mut looks).unwrap();
        assert!(
            born.is_empty(),
            "absent private file leaves defaults unchanged"
        );
        std::fs::write(dir.join("births.json"), &valid).unwrap();
        imported_births(&dir, &header, &catalogue, &mut born, &mut looks).unwrap();
        assert_eq!(born.get(&soul), Some(&[0x11; 32]));
        assert!(looks.is_empty(), "a row with a body carries no look");
        for invalid in [
            make(&"00".repeat(16), &zone, &digest, &row),
            make(&lineage, "invalid", &digest, &row),
            make(&lineage, &zone, &"00".repeat(32), &row),
            make(&lineage, &zone, &digest, &format!("{row},{row}")),
            make(
                &lineage,
                &zone,
                &digest,
                &row.replace(&hash, &"22".repeat(32)),
            ),
        ] {
            std::fs::write(dir.join("births.json"), invalid).unwrap();
            let before = born.clone();
            assert!(imported_births(&dir, &header, &catalogue, &mut born, &mut looks).is_err());
            assert_eq!(born, before, "no partial installation on refusal");
        }
        // Old Eden's residents: a row with no body may carry a look, and its body is born wearing it.
        let other = Id::new(Scope([0x4c; 16]), 0).unwrap();
        let other_text = directoryd::accounts::principal_text(other);
        let look = r#"{"hair":"bob","height":1.7}"#;
        let quoted = |t: &str| Json::Str(t.into()).to_json();
        let looked = |l: &str| {
            format!(
                r#"{{"soul":"{other_text}","entry":"{zone}","asked":0,"look":{}}}"#,
                quoted(l)
            )
        };
        let both = format!("{row},{}", looked(look));
        std::fs::write(
            dir.join("births.json"),
            make(&lineage, &zone, &digest, &both),
        )
        .unwrap();
        imported_births(&dir, &header, &catalogue, &mut born, &mut looks).unwrap();
        assert_eq!(looks.get(&other).map(Vec::as_slice), Some(look.as_bytes()));
        assert!(!born.contains_key(&other));
        let long = format!(r#"{{"hair":"{}"}}"#, "x".repeat(skills::wear::LOOK_MOST));
        for invalid in [
            row.replace(
                r#""asked":0"#,
                &format!(r#""asked":0,"look":{}"#, quoted(look)),
            ),
            looked("[1]"),
            looked(&long),
        ] {
            let mut fresh = BTreeMap::new();
            std::fs::write(
                dir.join("births.json"),
                make(&lineage, &zone, &digest, &invalid),
            )
            .unwrap();
            assert!(
                imported_births(&dir, &header, &catalogue, &mut BTreeMap::new(), &mut fresh)
                    .is_err(),
                "{invalid}"
            );
            assert!(fresh.is_empty(), "no partial installation on refusal");
        }
        std::fs::write(dir.join("births.json"), valid).unwrap();
        let mut explicit = BTreeMap::from([(soul, [0x22; 32])]);
        assert!(
            imported_births(&dir, &header, &catalogue, &mut explicit, &mut looks)
                .unwrap_err()
                .contains("contradictory")
        );
        assert_eq!(explicit[&soul], [0x22; 32]);
        std::fs::write(dir.join("facts.json"), b"{}").unwrap();
        let boot = public_boot(&dir, &header).unwrap();
        std::fs::remove_file(dir.join("births.json")).unwrap();
        assert_eq!(
            public_boot(&dir, &header).unwrap(),
            boot,
            "private choices never enter public boot"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn body_classes_restart_on_the_edited_canonical_geometry() {
        use replica::effects::{Actor, Body, Cause, Change, ChangeRec, Effect, Envelope, Rest};
        use replica::kinds::sizes::Size;
        let facts = testworld::generate(1, 0).unwrap();
        let imported = import_eden::load(&facts.text).unwrap();
        let building = imported.nodes["building"];
        let floor = imported.nodes["building/floor-1"];
        let built = build(&facts.text, &[]).unwrap();
        let initial = Replica::start(built.header.stored()).unwrap();
        let (before, _) =
            recovered_towns(&built, &initial, std::slice::from_ref(&built.part), &[]).unwrap();
        assert!(before.surfaces.contains_key(&floor));
        let mut live = initial.frozen();
        live.apply(&replica::effects::Part::read(&built.part).unwrap())
            .unwrap();
        let sequence = live.version();
        let edited = sim::commit::write(
            &mut live,
            &[Effect {
                envelope: Envelope {
                    sequence,
                    at: 0,
                    cause: Cause::World,
                    actor: Actor::World,
                    audience: Audience::Everyone,
                    node: building,
                },
                body: Body::Changes(vec![ChangeRec {
                    change: Change::Remove { node: building },
                    rest: Rest::new(),
                }]),
                events: None,
                rest: Rest::new(),
            }],
        )
        .unwrap();
        let records = vec![built.part.clone(), edited.stored().to_vec()];
        let (mut town, mut planner) = recovered_towns(&built, &initial, &records, &[]).unwrap();
        for one in [&mut town, &mut planner] {
            one.prepare_classes([Size::Large]).unwrap();
            assert_eq!(one.tree.to_state(), live.tree().to_state());
            assert!(
                !one.surfaces_for(Size::Standard)
                    .unwrap()
                    .contains_key(&floor)
            );
            assert!(!one.surfaces_for(Size::Large).unwrap().contains_key(&floor));
        }
        let mut invalid = records;
        invalid.push(vec![0xff]);
        assert!(recovered_towns(&built, &initial, &invalid, &[]).is_err());
    }

    #[test]
    fn w3c_stored_fork_base_reopens_scoped_nonempty_archive_without_local_checkpoint() {
        use directoryd::directory::folder::Folder;
        use replica::ids::Version;
        use sim::checkpoint::{Blobs, Checkpoints};
        let dir = std::env::temp_dir().join(format!("w3c-scoped-base-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut world = archive::script::world(1, 1, None);
        let mut checkpoints =
            Checkpoints::open(&dir.join("checkpoint"), 1 << 20, Blobs::default()).unwrap();
        let version = Version {
            lineage: world.header.lineage,
            zone: world.header.zone,
            epoch: world.header.epoch,
            sequence: world.tree.next(),
        };
        checkpoints
            .take(&mut world.tree, version, 0, b"scoped archive fixture")
            .unwrap();
        checkpoints.wait().unwrap();
        let bytes = std::fs::read(dir.join("checkpoint/ckpt-00000000000000000000")).unwrap();
        let base = ArchiveBase::read(world.header.stored(), &bytes).unwrap();
        let raw = Folder::new(dir.join("store"));
        let prefix = "h/scoped-world/lineage/";
        let scoped = Under {
            store: &raw,
            prefix: prefix.to_owned(),
        };
        let mut writer = Archiver::open_based(&scoped, "", &base).unwrap();
        writer
            .push(0, archive::script::tick(&mut world, 0, 1, 0))
            .unwrap();
        writer.flush().unwrap();
        drop(writer);
        let head =
            archive::Head::read(&scoped.get("archive/head").unwrap().unwrap().bytes).unwrap();
        assert!(!head.newest.is_empty());
        assert!(scoped.get(&head.newest).unwrap().is_some());
        assert!(raw.get(&head.newest).unwrap().is_none());
        let missing = dir.join("no-local-checkpoint");
        assert!(!missing.exists());
        let recovered =
            sim::log::recover(&sim::log::Header::new(world.header.epoch).to_bytes()).unwrap();
        let reopened = fork_archive_base(
            &raw,
            prefix,
            &missing,
            &world.header,
            b"not a replacement checkpoint",
            &recovered,
        )
        .unwrap();
        assert_eq!(
            reopened, base,
            "original durable base wins without local cp0"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn w3c_off_keeps_physical_based_delivery_separate_from_legacy_counter() {
        let mut world = archive::script::world(1, 1, None);
        let part = archive::script::tick(&mut world, 0, 1, 0);
        let input = sim::recorder::record(0, &[sim::recorder::Input::Time { real: 1 }]).unwrap();
        sim::recorder::read(&input).unwrap();
        let (ship, shipped) = channel();
        let (archive, archived) = channel();
        let mut off = Off {
            ship,
            archive: Some(archive),
            handover: Handover::new(ARCHIVE_WINDOW),
            parts: 0,
            based: true,
            archive_base: 4,
            mark: shipping::Mark::default(),
            floor: None,
        };
        for (record, bytes, is_input) in [
            (0, &part, false),
            (1, &input, true),
            (4, &input, true),
            (5, &part, false),
        ] {
            off.take(record, bytes, is_input);
            let actual = shipped.try_recv().unwrap();
            assert_eq!(actual.record, record);
            assert_eq!(&actual.bytes, bytes);
        }
        assert_eq!(archived.try_recv().unwrap(), (4, input.clone()));
        assert_eq!(archived.try_recv().unwrap(), (5, part.clone()));
        assert!(archived.try_recv().is_err());
        assert_eq!(off.parts, 0);
        let (ship, shipped) = channel();
        let (archive, archived) = channel();
        let mut legacy = Off {
            ship,
            archive: Some(archive),
            handover: Handover::new(ARCHIVE_WINDOW),
            parts: 0,
            based: false,
            archive_base: 4,
            mark: shipping::Mark::default(),
            floor: None,
        };
        for (record, bytes, is_input) in
            [(10, &input, true), (11, &part, false), (12, &part, false)]
        {
            legacy.take(record, bytes, is_input);
            let actual = shipped.try_recv().unwrap();
            assert_eq!(actual.record, record);
            assert_eq!(&actual.bytes, bytes);
        }
        assert_eq!(archived.try_recv().unwrap(), (0, part.clone()));
        assert_eq!(archived.try_recv().unwrap(), (1, part));
        assert!(archived.try_recv().is_err());
        assert_eq!(legacy.parts, 2);
    }

    /// Eden, 24 Nov: one archive write the store never answered (`timeout: receive response` on the open day's
    /// counts) ended the archiver's thread, and the world ran on with no bundle or day index written for hours. On the
    /// S3 stand-in, while a world's parts come, writes refused (503) and writes done whose answers are lost: the
    /// archiver never stops, says it is behind in `health.json` meanwhile, and every object, bundle and day index
    /// lands with the bytes a store that always answered holds.
    #[test]
    fn an_archiver_keeps_going_through_a_store_that_does_not_answer_and_every_bundle_lands() {
        use archive::script;
        use directoryd::directory::stand_in::{Fail, KEY_ID, StandIn};
        use directoryd::directory::store::Memory;
        let dir = std::env::temp_dir().join(format!("archiver-persists-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A world over four minutes, a tick a second: four bundles' windows, the last one open until the flush.
        let parts = std::rc::Rc::new(std::cell::RefCell::new(Vec::<Vec<u8>>::new()));
        let logged = std::rc::Rc::clone(&parts);
        let mut w = script::world(
            1,
            2,
            Some(Box::new(move |b: &[u8]| {
                logged.borrow_mut().push(b.to_vec())
            })),
        );
        for t in 0..240u64 {
            script::tick(&mut w, t * 20, 2, 30 * 20);
        }
        let parts = parts.borrow().clone();
        let root = w.tree.node(w.tree.root()).unwrap().id();
        let kind = w.tree.node(w.tree.root()).unwrap().kind().clone();
        // What a store that always answers holds.
        let memory = Memory::default();
        let mut reference = Archiver::open(&memory, "", &w.header, root, kind.clone()).unwrap();
        for (n, p) in parts.iter().enumerate() {
            reference.push(n as u64, p.clone()).unwrap();
        }
        reference.flush().unwrap();
        let expected: Vec<String> = memory.list("").unwrap();
        assert!(
            expected
                .iter()
                .filter(|k| k.starts_with("bundles/"))
                .count()
                >= 5,
            "four bundles and a day index: {expected:?}"
        );

        let s = StandIn::start(1000).unwrap();
        let keys = |k: &str| match k {
            "AWS_ACCESS_KEY_ID" => KEY_ID.to_owned(),
            "AWS_SECRET_ACCESS_KEY" => "stand-in-secret".to_owned(),
            _ => String::new(),
        };
        let bucket = supervisor::bucket::Bucket::parse(&format!("{}/w", s.url("souls")), keys)
            .unwrap()
            .for_world();
        let again = Again {
            store: Under {
                store: Shared(Arc::new(Patient::new(bucket))),
                prefix: "h/w/".into(),
            },
            public: dir.join("history"),
            header: w.header.stored().to_vec(),
        };
        let (header, opening) = (w.header.clone(), again.clone());
        let open = move || Archiver::open(opening.clone(), "", &header, root, kind.clone());
        let text = Arc::new(
            sim::text::Store::open_dir(
                &dir.join("log.text"),
                replica::ids::Minter::new(Scope([7; 16])),
            )
            .unwrap(),
        );
        // The world's log on the disk, as the world writes it: the archiver reads from it what it is not handed.
        let (mut log, _) = Log::open(FileStore::open(&dir.join("log")).unwrap(), EPOCH).unwrap();
        for p in &parts {
            log.append(p.clone()).unwrap();
        }
        log.wait_durable(parts.len() as u64).unwrap();
        // A window of 16 KiB: the parts past it stay in the log while the store is out.
        let (tx, rx) = channel();
        let handover = Handover::new(16 << 10);
        let feed = Feed {
            rx,
            handover: Arc::clone(&handover),
            log: LogReader {
                path: dir.join("log"),
                at: None,
            },
            based: false,
            base: 0,
        };
        let (ship, _shipped) = channel();
        let mut off = Off {
            ship,
            archive: Some(tx),
            handover: Arc::clone(&handover),
            parts: 0,
            based: false,
            archive_base: 0,
            mark: shipping::Mark::default(),
            floor: None,
        };
        // Production's fault was on a write. The store refuses every write (503) while the world hands its parts over.
        s.refuse_writes(usize::MAX, 503, "");
        let h = archiving(open, feed, text, |_| {}, &[10, 20, 40]);
        let largest = parts.iter().map(Vec::len).max().unwrap() as u64;
        let (mut most, mut in_log) = (0, 0);
        for (n, p) in parts.iter().enumerate() {
            off.take(n as u64, p, false);
            let state = handover.lock();
            most = most.max(state.queued_bytes);
            in_log = in_log.max(state.left.map_or(0, |(from, _)| state.end - from));
        }
        println!("in memory at most {most} B; in the log at most {in_log} records");
        assert!(
            most <= (16 << 10) + largest,
            "memory stays in the window: {most}"
        );
        assert!(
            in_log > 100,
            "the parts past the window wait in the log: {in_log}"
        );
        // The archiver reads on from the log and meets the store out: it says so, and waits. (The deadline only stops a
        // hung test.)
        let end = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !measures::ARCHIVE.is_behind() {
            assert!(
                std::time::Instant::now() < end,
                "the archiver meets the refusals"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!h.is_finished(), "it keeps trying");
        // The store answers again, then loses the answers to writes it did, and the archiver catches up from the log.
        s.refuse_writes(0, 503, "");
        s.fail_writes(40, Fail::Lost);
        drop(off);
        h.join()
            .unwrap()
            .expect("the archiver never stops on a store that does not answer");
        let state = handover.lock();
        assert_eq!(
            (state.queued, state.queued_bytes, state.left),
            (0, 0, None),
            "nothing is counted as waiting once all is taken"
        );
        for key in &expected {
            let want = memory.get(key).unwrap().unwrap().bytes;
            let got = again.get(key).unwrap();
            assert_eq!(got.map(|o| o.bytes), Some(want), "{key} lands");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The parts left in the log are read from it a batch at a time, from its cut once it is compacted, with the bytes
    /// the world wrote; a record before the cut is refused by name, never read as something else.
    #[test]
    fn the_archivers_log_reader_reads_on_from_a_compacted_log() {
        let dir = std::env::temp_dir().join(format!("archiver-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("log");
        let records: Vec<Vec<u8>> = (0..50u8).map(|i| vec![i; 1000 + i as usize]).collect();
        let (mut log, _) = Log::open(FileStore::open(&path).unwrap(), EPOCH).unwrap();
        for r in &records[..30] {
            log.append(r.clone()).unwrap();
        }
        log.wait_durable(30).unwrap();
        let mut reader = LogReader {
            path: path.clone(),
            at: None,
        };
        let (first, reached) = reader.batch(0, 10).unwrap();
        assert_eq!(reached, 10);
        assert_eq!(
            first,
            (0..10)
                .map(|n| (n, records[n as usize].clone()))
                .collect::<Vec<_>>()
        );
        // Compacted at record 10, then written on.
        let durable = log.durable_mark();
        let cut = sim::log::compact::Cut {
            at: reader.at.unwrap(),
            note: 0,
        };
        durable.compact(
            sim::log::compact::prepare(&path, cut, durable.at())
                .unwrap()
                .unwrap(),
        );
        for r in &records[30..] {
            log.append(r.clone()).unwrap();
        }
        log.wait_durable(50).unwrap();
        // The writer finishes the compaction just after its sync; the deadline only stops a hung test.
        let end = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            match durable.compacted() {
                Some(done) => break assert!(done.is_ok(), "compacted: {done:?}"),
                None => {
                    assert!(std::time::Instant::now() < end, "the compaction finishes");
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
        }
        let mut fresh = LogReader { path, at: None };
        let (rest, reached) = fresh.batch(10, 50).unwrap();
        assert_eq!(reached, 50);
        assert_eq!(
            rest,
            (10..50)
                .map(|n| (n, records[n as usize].clone()))
                .collect::<Vec<_>>()
        );
        // The first reader goes on from its own place, across the compaction.
        assert_eq!(reader.batch(10, 50).unwrap().0, rest);
        let mut early = LogReader {
            path: dir.join("log"),
            at: None,
        };
        assert_eq!(early.batch(5, 50).unwrap_err().name, "archive-log");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A part handed to an archiver that is gone is not counted as waiting.
    #[test]
    fn a_part_the_channel_refuses_is_not_counted_as_queued() {
        let handover = Handover::new(1 << 20);
        let (tx, rx) = channel();
        handover.hand(&tx, 0, 0, b"one");
        drop(rx);
        handover.hand(&tx, 1, 1, b"two");
        let h = handover.lock();
        assert_eq!((h.queued, h.queued_bytes, h.end, h.next), (1, 3, 2, 2));
    }

    /// Eden, 25 Nov: a day's event index was a file in the public mirror, and an hour of that day split off (V4, 1,000
    /// events or more) wanted the same path as a directory, which ended the process. Both are exported now: the day's
    /// index moves into the day's directory as `day` (the origin serves it at the day's URL), in either order. A copy
    /// that cannot be placed is skipped, counted and logged once; bytes that fail their check still stop the start.
    #[test]
    fn a_day_index_and_its_split_hour_never_end_the_world() {
        use directoryd::directory::store::Store;
        use replica::history::events::{Counts, EventIndex, Span, events_key};
        let header =
            Header::read(&fixture_bytes(replica::effects::FIXTURE_HEADER).unwrap()).unwrap();
        let dir = std::env::temp_dir().join(format!("split-export-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bucket = Shared(Arc::new(Patient::new(
            supervisor::bucket::Bucket::parse(
                &format!("folder:{}", dir.join("store").display()),
                |_| String::new(),
            )
            .unwrap(),
        )));
        let public = dir.join("public");
        let adapter = Again {
            store: Under {
                store: bucket.clone(),
                prefix: "w/".into(),
            },
            public: public.clone(),
            header: header.stored().to_vec(),
        };
        let (day, hour) = (20781, 5);
        let day_bytes = EventIndex {
            day,
            hour: None,
            split: vec![hour],
            rows: Vec::new(),
        }
        .to_bytes()
        .unwrap();
        let hour_bytes = EventIndex {
            day,
            hour: Some(hour),
            split: Vec::new(),
            rows: Vec::new(),
        }
        .to_bytes()
        .unwrap();
        let (day_key, hour_key) = (events_key(day, None), events_key(day, Some(hour)));
        // Eden's mirror: the day's index placed as a file before its hour split off (the folder store here cannot hold
        // both keys either, so that state is set by hand; the bucket behind a world is an object store).
        std::fs::create_dir_all(public.join(&day_key).parent().unwrap()).unwrap();
        std::fs::write(public.join(&day_key), &day_bytes).unwrap();
        adapter.put(&hour_key, &hour_bytes, When::Absent).unwrap();
        assert_eq!(std::fs::read(public.join(&hour_key)).unwrap(), hour_bytes);
        assert_eq!(
            std::fs::read(public.join(&day_key).join("day")).unwrap(),
            day_bytes
        );
        assert!(!public.join(&day_key).with_extension("tmp").exists());
        // Later writes of the day's index land beside its hours.
        let later = EventIndex {
            day,
            hour: None,
            split: vec![hour, hour + 1],
            rows: Vec::new(),
        }
        .to_bytes()
        .unwrap();
        adapter.mirror(&day_key, &later).unwrap();
        assert_eq!(
            std::fs::read(public.join(&day_key).join("day")).unwrap(),
            later
        );
        // The other order: an hour first, then its day's index.
        let day2 = day + 1;
        let hour2 = EventIndex {
            day: day2,
            hour: Some(hour),
            split: Vec::new(),
            rows: Vec::new(),
        }
        .to_bytes()
        .unwrap();
        let day2_bytes = EventIndex {
            day: day2,
            hour: None,
            split: vec![hour],
            rows: Vec::new(),
        }
        .to_bytes()
        .unwrap();
        adapter
            .mirror(&events_key(day2, Some(hour)), &hour2)
            .unwrap();
        adapter
            .mirror(&events_key(day2, None), &day2_bytes)
            .unwrap();
        assert_eq!(
            std::fs::read(public.join(events_key(day2, None)).join("day")).unwrap(),
            day2_bytes
        );
        assert_eq!(
            std::fs::read(public.join(events_key(day2, Some(hour)))).unwrap(),
            hour2
        );
        // A copy that cannot be placed (here a file where a directory goes) is skipped: the write answers, and the
        // key is counted, held, and so logged once.
        let counts_key = "history/everyone/counts/day/00020781";
        std::fs::write(public.join("history/everyone/counts"), b"in the way").unwrap();
        let before = measures::HISTORY_EXPORT.count();
        let counts = Counts::new(Span::Day(day)).to_bytes().unwrap();
        adapter.put(counts_key, &counts, When::Absent).unwrap();
        assert!(measures::HISTORY_EXPORT.count() > before);
        assert!(!measures::HISTORY_EXPORT.fault(counts_key, "again"));
        adapter.restore_public().unwrap();
        // Bytes that fail their check are refused, in the running archiver and at a start: a corrupt archive stops.
        let corrupt = events_key(day + 2, None);
        let refused = adapter
            .put(&corrupt, b"not an index", When::Absent)
            .unwrap_err();
        assert_ne!(refused.name, "history-export");
        assert!(!public.join(&corrupt).exists());
        assert_eq!(adapter.restore_public().unwrap_err(), refused);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn w3c_public_history_mirror_is_strict_immutable_and_symlink_safe() {
        use directoryd::directory::store::Store;
        use replica::history::{Bundle, DayIndex, WINDOW_LEAST};
        let header =
            Header::read(&fixture_bytes(replica::effects::FIXTURE_HEADER).unwrap()).unwrap();
        let dir = std::env::temp_dir().join(format!("w3c-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bucket = Shared(Arc::new(Patient::new(
            supervisor::bucket::Bucket::parse(
                &format!("folder:{}", dir.join("store").display()),
                |_| String::new(),
            )
            .unwrap(),
        )));
        let public = dir.join("public");
        let adapter = Again {
            store: Under {
                store: bucket.clone(),
                prefix: "archive-test/".into(),
            },
            public: public.clone(),
            header: header.stored().to_vec(),
        };
        adapter
            .put("header", header.stored(), When::Absent)
            .unwrap();
        adapter
            .put("archive/base/private", b"private-base", When::Absent)
            .unwrap();
        adapter
            .put("archive/obj/private", b"private-input", When::Absent)
            .unwrap();
        assert!(!public.join("archive").exists());
        assert!(
            adapter
                .put("archive/base/private", b"replacement", When::Absent)
                .is_err()
        );
        assert_eq!(
            adapter.get("archive/base/private").unwrap().unwrap().bytes,
            b"private-base"
        );
        let snapshot = Value::Map([(1, Value::Array(vec![])), (2, Value::Array(vec![]))].into());
        let bundle = Bundle::new(
            header.hash().to_bytes(),
            59_500_000,
            WINDOW_LEAST,
            snapshot,
            Value::Map(Default::default()),
        )
        .unwrap();
        let key = format!(
            "bundles/00000000/{:020}-{}",
            bundle.start,
            to_hex(&bundle.hash())
        );
        adapter
            .put(&key, &archive::bundle_stored(&bundle), When::Absent)
            .unwrap();
        let index = DayIndex {
            day: 0,
            bundles: vec![(bundle.start, key.clone(), bundle.hash())],
        };
        adapter
            .put(
                "bundles/00000000/index",
                &index.to_bytes().unwrap(),
                When::Absent,
            )
            .unwrap();
        assert_eq!(
            archive::bundle_body(&std::fs::read(public.join(&key)).unwrap()).unwrap(),
            bundle.bytes()
        );
        let first = std::fs::read(public.join(&key)).unwrap();
        assert!(adapter.put(&key, b"changed", When::Absent).is_err());
        assert_eq!(std::fs::read(public.join(&key)).unwrap(), first);
        std::fs::remove_dir_all(&public).unwrap();
        adapter.restore_public().unwrap();
        assert_eq!(
            std::fs::read(public.join("header")).unwrap(),
            header.stored()
        );
        assert_eq!(std::fs::read(public.join(&key)).unwrap(), first);
        assert!(!public.join("archive").exists());
        let escaped = dir.join("escape");
        std::fs::create_dir_all(&escaped).unwrap();
        std::fs::remove_file(public.join("header")).unwrap();
        std::os::unix::fs::symlink(escaped.join("header"), public.join("header")).unwrap();
        assert_eq!(
            adapter.mirror("header", header.stored()).unwrap_err().name,
            "history-export"
        );
        assert!(!escaped.join("header").exists());
        for key in [
            "archive/head",
            "archive/range/1",
            "../header",
            "bundles/0/../header",
            "tokens",
            "history/others/events/0",
            "history/everyone/events/0/24",
        ] {
            assert!(!history_public_key(key), "{key}");
        }
    }

    /// The actual served bootstrap and physical replay boundary, from a filtered fork's checkpoint after a join.
    #[test]
    fn w3d_served_fork_checkpoint_and_restart_feed_a_fresh_stream_reader() {
        use replica::effects::{
            Actor, Body, Cause, Change, ChangeRec, Envelope, FIXTURE_HEADER, Part, Rest, TimerRec,
        };
        use replica::ids::{Hash, Purpose, Version};
        use replica::pose::{Pose, Quat, Support};
        use replica::stream::Player;
        use replica::tree::Tree;
        use sim::checkpoint::fork::{Request, fork_with_kinds};
        use sim::checkpoint::{Blobs, Checkpoints, restore};
        use std::sync::atomic::Ordering;

        let header = Header::read(&fixture_bytes(FIXTURE_HEADER).unwrap()).unwrap();
        let root_kind = header
            .kinds
            .iter()
            .find(|k| k.as_str().starts_with("souls:place@"))
            .unwrap()
            .clone();
        let body_kind = header
            .kinds
            .iter()
            .find(|k| k.as_str().starts_with("souls:body@"))
            .unwrap()
            .clone();
        let mut parent = Tree::start(header.zone, root_kind);
        let id = |counter| Id::new(Scope([0x77; 16]), counter).unwrap();
        let pose = Pose {
            frame: Frame {
                node: header.zone,
                slot: None,
            },
            position: Vec3::ZERO,
            orientation: Quat::IDENTITY,
            support: Support::Surface {
                surface: header.zone,
                height: 0,
            },
        };
        let effect = |sequence, at, node, body| {
            Effect {
                envelope: Envelope {
                    sequence,
                    at,
                    cause: Cause::World,
                    actor: Actor::World,
                    audience: Audience::Everyone,
                    node,
                },
                body,
                events: None,
                rest: Rest::new(),
            }
            .to_value()
        };
        let changes = |items: Vec<Change>| {
            Body::Changes(
                items
                    .into_iter()
                    .map(|change| ChangeRec {
                        change,
                        rest: Rest::new(),
                    })
                    .collect(),
            )
        };
        let part = |h: &Header, records: Vec<Value>| {
            Part::read(
                &encode(&Value::Map(
                    [
                        (1, Value::Bytes(h.hash().to_bytes())),
                        (2, Value::Array(records)),
                    ]
                    .into(),
                ))
                .unwrap(),
            )
            .unwrap()
        };
        // Enough real state changes for the normal fork seed's existing sequence allocation.
        let originals: Vec<Value> = (0..6)
            .map(|s| {
                effect(
                    s,
                    0,
                    header.zone,
                    changes(vec![Change::Set {
                        node: header.zone,
                        field: 20,
                        to: Value::Uint(s),
                        by: None,
                    }]),
                )
            })
            .collect();
        let imported = part(&header, originals);
        parent.apply(&header, &imported).unwrap();
        let d = std::env::temp_dir().join(format!("w3d-served-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let mut checkpoints =
            Checkpoints::open(&d.join("parent"), 1 << 20, Blobs::default()).unwrap();
        let version = Version {
            lineage: header.lineage,
            zone: header.zone,
            epoch: header.epoch,
            sequence: parent.next(),
        };
        checkpoints
            .take(&mut parent, version, 1, b"parent seed")
            .unwrap();
        checkpoints.wait().unwrap();
        let real = 1_000_000_000_000;
        let mut forked = fork_with_kinds(
            &d.join("parent"),
            &d.join("fork"),
            Request {
                through: id(99),
                scope: Scope([0xf3; 16]),
                seed: vec![0xf3; 32],
                real_us: real,
                build: Hash::of(Purpose::Fixture, b"w3d served").to_bytes(),
                every: 1 << 20,
            },
            std::slice::from_ref(&body_kind),
        )
        .unwrap();
        // K6 seals its first checkpoint before recording the fork's initial mapping in physical record 0.
        // The observer can use that validated durable mapping, but the reader must receive it through replay.
        let first = restore(&d.join("fork/ckpt")).unwrap().unwrap();
        assert_eq!(first.root.record, 0);
        assert!(first.tree.time().is_empty());
        let first_sequence = first.tree.next();
        let first_state = first.tree.to_state();
        let mut validated = Replica::restored(forked.header.clone(), first.tree, first_sequence);
        let head = Part::read(&forked.head).unwrap();
        validated.apply(&head).unwrap();
        let observer = first_stream_mapping(&head, &forked.header, 0, real + 1_000_000).unwrap();
        assert_eq!((observer.record, observer.sequence), (0, first_sequence));
        assert_eq!(observer.mapping.world_us, 0);
        assert_eq!(observer.mapping.real_us, real);
        let first_found = sim::log::recover(&std::fs::read(d.join("fork/log")).unwrap()).unwrap();
        assert_eq!(first_found.records, vec![forked.head.clone()]);
        let key = Key {
            node: forked.header.zone,
            level: Level::Full,
            audience: Audience::Everyone,
        };
        let first_tier = Tier::start(
            forked.header.clone(),
            first_state.clone(),
            Redactions::default(),
            forked.log.durable_mark(),
        )
        .unwrap();
        let first_sub = first_tier.subscribe(vec![key], BOUND);
        let first_views = d.join("first-views");
        let first_writer = stream_writer(
            &first_views,
            &forked.header,
            &key,
            &first_state,
            true,
            real + 1_000_000,
            Some(observer),
        )
        .unwrap();
        let first_stop = Arc::new(AtomicBool::new(false));
        let first_following =
            view_out::follow(first_writer, first_sub, first_stop.clone(), move || {
                real + 1_000_000
            });
        replay_stream(&first_tier, &first_found, 0);
        let first_stats = first_tier.close();
        assert!(first_stats.fault.is_none(), "{:?}", first_stats.fault);
        first_stop.store(true, Ordering::Relaxed);
        let first_writer = first_following.join().unwrap().unwrap();
        assert_eq!(
            first_writer.written().parts,
            2,
            "checkpoint then the original mapping exactly once"
        );
        let first_pointer = stream::Pointer::read(
            &std::fs::read(first_writer.dir().join(stream::POINTER)).unwrap(),
        )
        .unwrap();
        assert_eq!(first_pointer.anchor_world, 1_000_000);
        let first_header = first_views.join(format!(
            "{}/{}-{}/{}/headers/{}",
            to_hex(&forked.header.lineage.0),
            to_hex(&forked.header.zone.scope().0),
            forked.header.zone.counter(),
            forked.header.epoch,
            to_hex(&first_pointer.header)
        ));
        let mut first_player = Player::start(&std::fs::read(first_header).unwrap()).unwrap();
        for number in 0..first_writer.written().parts {
            let played = first_player
                .play(&std::fs::read(first_writer.dir().join(number.to_string())).unwrap())
                .unwrap();
            if let Some(hash) = played.hash {
                assert!(hash);
            }
        }
        assert_eq!(
            first_player.replica().tree().to_state(),
            forked.tree.to_state()
        );
        assert_eq!(
            first_player.replica().tree().time(),
            &[TimeEffect::Mapping(observer.mapping)]
        );
        let body = id(1);
        let soul = id(2);
        let timer = Id::new(Scope([0xe6; 16]), 0).unwrap();
        let sequence = forked.tree.next();
        let joined = part(
            &forked.header,
            vec![
                effect(
                    sequence,
                    2_000_000,
                    header.zone,
                    changes(vec![
                        Change::Create {
                            node: body,
                            kind: body_kind,
                            pose,
                            audience: Audience::Everyone,
                            fields: Default::default(),
                        },
                        Change::Link {
                            link: id(3),
                            ty: Name::new("souls:body-of").unwrap(),
                            ends: [body, soul],
                            owner: replica::world_model::End::First,
                            audience: Audience::Everyone,
                        },
                    ]),
                ),
                effect(
                    sequence + 1,
                    2_000_000,
                    header.zone,
                    Body::Timers(vec![TimerRec::Set {
                        timer,
                        due: 6_000_000,
                        name: Name::new("souls:light").unwrap(),
                    }]),
                ),
            ],
        );
        forked.tree.apply(&forked.header, &joined).unwrap();
        let record = forked.log.append(joined.stored().to_vec()).unwrap();
        forked.log.wait_durable(record + 1).unwrap();
        let base = record + 1;
        let version = Version {
            lineage: forked.header.lineage,
            zone: forked.header.zone,
            epoch: forked.header.epoch,
            sequence: forked.tree.next(),
        };
        forked
            .checkpoints
            .take(&mut forked.tree, version, base, b"joined checkpoint")
            .unwrap();
        forked.checkpoints.wait().unwrap();
        let checkpoint = restore(&d.join("fork/ckpt")).unwrap().unwrap();
        assert_eq!(checkpoint.root.record, base);
        assert!(checkpoint.tree.timers().contains_key(&timer));
        let next = checkpoint.tree.next();
        let after = part(
            &forked.header,
            vec![effect(
                next,
                6_000_000,
                header.zone,
                Body::Timers(vec![
                    TimerRec::Clear { timer },
                    TimerRec::Set {
                        timer: id(4),
                        due: 9_000_000,
                        name: Name::new("souls:light").unwrap(),
                    },
                ]),
            )],
        );
        forked.tree.apply(&forked.header, &after).unwrap();
        forked.log.append(after.stored().to_vec()).unwrap();
        let storage = forked.log.close();
        let (log, found) = Log::open(storage, EPOCH).unwrap();
        assert_eq!(
            found.after(base).len(),
            1,
            "only one post-checkpoint durable record"
        );
        let initial = checkpoint.tree.to_state();
        let tier = Tier::start(
            forked.header.clone(),
            initial.clone(),
            Redactions::default(),
            log.durable_mark(),
        )
        .unwrap();
        let sub = tier.subscribe(vec![key], BOUND);
        let views = d.join("views");
        let writer = stream_writer(
            &views,
            &forked.header,
            &key,
            &initial,
            true,
            real + 7_000_000,
            None,
        )
        .unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let following = view_out::follow(writer, sub, stop.clone(), move || real + 7_000_000);
        replay_stream(&tier, &found, base);
        let stats = tier.close();
        assert!(stats.fault.is_none(), "{:?}", stats.fault);
        stop.store(true, Ordering::Relaxed);
        let writer = following.join().unwrap().unwrap();
        assert_eq!(
            writer.written().parts,
            2,
            "checkpoint seed then exactly one post-base record"
        );
        let pointer =
            stream::Pointer::read(&std::fs::read(writer.dir().join(stream::POINTER)).unwrap())
                .unwrap();
        assert_eq!(pointer.newest, Some(1));
        assert_eq!(pointer.anchor_world, 7_000_000);
        // The writer may add missing checkpoint kind pins using its existing seed contract; the pointer names it.
        let header_path = views.join(format!(
            "{}/{}-{}/{}/headers/{}",
            to_hex(&forked.header.lineage.0),
            to_hex(&forked.header.zone.scope().0),
            forked.header.zone.counter(),
            forked.header.epoch,
            to_hex(&pointer.header)
        ));
        let mut player = Player::start(&std::fs::read(header_path).unwrap()).unwrap();
        for number in 0..writer.written().parts {
            let played = player
                .play(&std::fs::read(writer.dir().join(number.to_string())).unwrap())
                .unwrap();
            if let Some(hash) = played.hash {
                assert!(hash);
            }
        }
        assert_eq!(player.replica().tree().to_state(), forked.tree.to_state());
        assert!(player.replica().tree().to_state().nodes.contains_key(&body));
        assert!(!player.replica().tree().timers().contains_key(&timer));
        // Ordinary non-checkpoint creation still starts empty and consumes its complete import once.
        let empty = Replica::start(header.stored()).unwrap();
        let mut seeded = stream_writer(
            &d.join("seeded"),
            &header,
            &Key {
                node: header.zone,
                ..key
            },
            &empty.tree().to_state(),
            false,
            real,
            None,
        )
        .unwrap();
        assert_eq!(seeded.written().parts, 0);
        seeded
            .frame(
                &encode(&Value::Map(
                    [(
                        8,
                        Value::Array(imported.effects.iter().map(Effect::to_value).collect()),
                    )]
                    .into(),
                ))
                .unwrap(),
            )
            .unwrap();
        seeded.flush().unwrap();
        let mut ordinary = Player::start(header.stored()).unwrap();
        ordinary
            .play(&std::fs::read(seeded.dir().join("0")).unwrap())
            .unwrap();
        assert_eq!(ordinary.replica().tree().to_state(), parent.to_state());
        drop(log.close());
        std::fs::remove_dir_all(d).unwrap();
    }

    /// #3672: the planner `Town::with_planner` clones answers every query as `Town::copy`'s second assembly does.
    #[test]
    fn planner_clone_answers_as_the_assembled_copy() {
        let facts = testworld::generate(1, 0).unwrap();
        let built = build(&facts.text, &[]).unwrap();
        let initial = Replica::start(built.header.stored()).unwrap();
        let (mut town, mut planner) =
            recovered_towns(&built, &initial, std::slice::from_ref(&built.part), &[]).unwrap();
        let mut copy = town.copy().unwrap();
        for t in [&mut town, &mut planner, &mut copy] {
            t.prepare_classes([replica::kinds::sizes::Size::Large])
                .unwrap();
        }
        assert_eq!(planner.tree.to_state(), copy.tree.to_state());
        let floors: Vec<Id> = copy.surfaces.keys().copied().collect();
        assert!(
            floors.len() > 1,
            "the test world has floors besides the ground"
        );
        assert_eq!(planner.surfaces.keys().copied().collect::<Vec<_>>(), floors);
        let ask = |t: &mut Town| {
            let view = t.view();
            let mut out = Vec::new();
            for &node in &floors {
                for x in (-30_000..=30_000).step_by(2_500) {
                    for z in (-30_000..=30_000).step_by(2_500) {
                        let at = Vec3::new(x, 0, z);
                        out.push(format!(
                            "{:?} {:?} {:?}",
                            view.on_floor(node, at),
                            view.stand_near(node, at, 1, None),
                            view.stand_near(node, at, skills::form_runner::REACH, None)
                        ));
                    }
                }
            }
            out
        };
        let (cloned, assembled) = (ask(&mut planner), ask(&mut copy));
        assert!(cloned.iter().any(|a| !a.contains("None None")));
        assert_eq!(cloned, assembled);
        assert_eq!(ask(&mut town), assembled);
    }

    /// S5: a kept courses text is the bytes [`courses`] computes; a torn cache, changed entries, or a kept text that
    /// does not load are computed again, never a start's end.
    #[test]
    fn s5_kept_courses_equal_the_computed_and_a_torn_stale_or_bad_cache_is_computed_again() {
        let facts = testworld::generate(1, 0).expect("test world").text;
        let entries = |extra: &str| {
            vec![(
                "testworld:planter".to_owned(),
                replica::rules::json::parse(&format!(r#"{{"kind":"testworld:planter"{extra}}}"#))
                    .expect("an entry"),
            )]
        };
        let (a, b) = (entries(""), entries(r#","note":"changed""#));
        let dir = std::env::temp_dir().join(format!("s5-courses-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a folder");
        let path = dir.join("facts.courses");
        let fresh = courses(&facts, &a).expect("computed");
        assert_eq!(
            courses_cached(None, &facts, &a).expect("no cache"),
            (fresh.clone(), false)
        );
        assert_eq!(
            courses_cached(Some(&path), &facts, &a).expect("kept"),
            (fresh.clone(), false)
        );
        assert_eq!(
            courses_cached(Some(&path), &facts, &a).expect("a hit"),
            (fresh.clone(), true)
        );
        // Torn: cut short, as a crash mid-write without the sync would leave it.
        let whole = std::fs::read(&path).expect("the cache");
        std::fs::write(&path, &whole[..whole.len() / 2]).expect("torn");
        assert_eq!(
            courses_cached(Some(&path), &facts, &a).expect("torn"),
            (fresh.clone(), false)
        );
        // Other entries: computed for them, not the kept text.
        let other = courses(&facts, &b).expect("computed");
        assert_eq!(
            courses_cached(Some(&path), &facts, &b).expect("stale"),
            (other, false)
        );
        // A kept text that matches its key and hash but does not load: the start computes it again.
        let bad = "not facts";
        let key = courses_key(&facts, &a);
        std::fs::write(
            &path,
            format!("{key} {}\n{bad}", to_hex(&sha256(bad.as_bytes()))),
        )
        .expect("bad");
        assert_eq!(
            courses_cached(Some(&path), &facts, &a).expect("read"),
            (bad.to_owned(), true)
        );
        let built = build_with(Some(&path), &facts, &a).expect("built again");
        assert_eq!(
            built.header.hash(),
            build_with(None, &facts, &a).expect("built").header.hash()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #1960: a creator places a thing of a kind the world has an entry for but no seeded thing of. Without the
    /// entry, the kind is not pinned and the place is refused `edit.kind-unknown`; with it, the place commits.
    #[test]
    fn a_creator_places_an_entry_kind_no_seeded_thing_uses() {
        use replica::edit::{Edit, Op, Ref, Spot, World, check};
        use replica::pose::{Quat, Support};
        let facts = testworld::generate(1, 0).expect("test world").text;
        let entry = || {
            vec![(
                "testworld:planter".to_owned(),
                replica::rules::json::parse(r#"{"kind":"testworld:planter"}"#).expect("an entry"),
            )]
        };
        let attempt = |entries: &[(String, Json)]| {
            let built = build(&facts, entries).expect("builds");
            let pinned = built
                .rules
                .kinds
                .keys()
                .find(|k| plain(k) == "testworld:planter")
                .cloned();
            let start = Replica::start(built.header.stored()).expect("a replica");
            let mut live = start.frozen();
            live.apply(&replica::effects::Part::read(&built.part).expect("the part"))
                .expect("applies");
            let creator = Id::new(Scope([0xc0; 16]), 1).expect("an id");
            let world = World {
                creator,
                kinds: built.rules.kinds.clone(),
            };
            let kind = Name::new(
                pinned
                    .as_deref()
                    .unwrap_or(&format!("testworld:planter@1220{}", "00".repeat(32))),
            )
            .expect("a name");
            let edit = Edit {
                intent: Id::new(Scope([0x11; 16]), 1).expect("an id"),
                actor: replica::effects::Actor::Creator(creator),
                planned: live.version(),
                ops: vec![Op::Place {
                    name: 0,
                    kind,
                    parent: Ref::Node(built.ground),
                    at: Spot {
                        slot: None,
                        position: Vec3::new(0, 0, 0),
                        orientation: Quat::IDENTITY,
                        support: Support::None,
                    },
                    audience: Audience::Everyone,
                    fields: BTreeMap::new(),
                }],
                claim: None,
            };
            (pinned.is_some(), check(edit, &live, &world).map(|_| ()))
        };
        let (pinned, without) = attempt(&[]);
        assert!(!pinned, "the seeded test world has no planter");
        assert_eq!(without.expect_err("refused").name, "edit.kind-unknown");
        let (pinned, with) = attempt(&entry());
        assert!(pinned, "the entry's kind is pinned");
        with.expect("the place commits");
        // The same entries give the same header: every start of the world agrees.
        assert_eq!(
            build(&facts, &entry()).unwrap().header.hash(),
            build(&facts, &entry()).unwrap().header.hash()
        );
    }

    #[test]
    fn creator_export_preserves_pins_and_names_the_boot_body_admission() {
        let facts = testworld::generate(1, 0).expect("test world").text;
        let imported = import_eden::load(&facts).expect("loads");
        let entries = vec![(
            "creator:table".to_owned(),
            replica::rules::json::parse(r#"{"roles":{"creator:a":{},"creator:b":{}}}"#)
                .expect("roles"),
        )];
        let built = build(&facts, &entries).expect("builds");
        assert_eq!(
            built.activities.len(),
            3,
            "conversation, give and entry runtime pins"
        );
        let prefix = imported.kind_lines.join("\n") + "\n";
        assert!(
            built.kinds_text.starts_with(&prefix),
            "imported kind bytes are unchanged"
        );
        let mut exported = std::collections::BTreeMap::new();
        for line in built.kinds_text.lines() {
            exported.extend(parse_kinds(line).expect("a kind or boot annotation"));
            if let Some(projection) = line.strip_prefix("# souls-boot-activity ") {
                let (target, activity) = projection.split_once(' ').expect("target and activity");
                assert_eq!(exported[target].owner, "place");
                exported.insert(
                    activity.to_owned(),
                    Kind {
                        owner: "activity".into(),
                        children: Default::default(),
                        slots: Default::default(),
                        hands: None,
                        fields: Default::default(),
                    },
                );
            }
        }
        assert_eq!(
            exported.keys().collect::<Vec<_>>(),
            built.rules.kinds.keys().collect::<Vec<_>>(),
            "exported pins match the runtime, including generated body and runtime activities"
        );
        assert_eq!(exported[&built.body_kind].owner, "family");
        for a in &built.activities {
            assert_eq!(
                exported[a.name.as_str()],
                built.rules.kinds[a.name.as_str()]
            );
        }
        let extended: Vec<_> = built
            .kinds_text
            .lines()
            .filter_map(|l| l.strip_prefix("# souls-boot-body "))
            .collect();
        let ground: Vec<_> = built
            .rules
            .kinds
            .iter()
            .filter(|(n, _)| plain(n) == import_eden::GROUND)
            .collect();
        assert_eq!(extended.len(), ground.len());
        assert!(!extended.is_empty());
        for (name, runtime) in ground {
            assert!(runtime.children.contains("body"));
            let mut projected = exported[name].clone();
            projected.children.insert("body".into());
            for a in &built.activities {
                assert!(built.kinds_text.lines().any(
                    |line| line == format!("# souls-boot-activity {name} {}", a.name.as_str())
                ));
                projected.children.insert(plain(a.name.as_str()).to_owned());
            }
            assert_eq!(&projected, runtime, "exact boot admission and Kind parity");
            assert!(
                !exported[name].children.contains("body"),
                "the pinned definition itself was not rewritten"
            );
            assert!(
                extended.contains(&name.as_str()),
                "the exact runtime extension is explicit"
            );
        }
    }
}

#[cfg(test)]
mod conversation_tests {
    use super::*;

    #[test]
    fn served_body_can_claim_each_conversation_role() {
        let kind = conversation().unwrap();
        let body = replica::bodies::Body::new(humanoid().unwrap());
        for role in &kind.roles {
            let held = body.plan(1, &kind.shape(role)).unwrap();
            assert_eq!(held.holds, vec![Name::new("souls:voice").unwrap()]);
        }
    }
}

/// K16: the world's own header and its reconciliation with this build ([`own_header`], [`adopt`]).
#[cfg(test)]
mod header_tests {
    use super::*;

    fn built() -> Built {
        build(&testworld::generate(1, 0).unwrap().text, &[]).unwrap()
    }

    /// `h` with its record changed by `f`.
    fn header_with(h: &Header, f: impl FnOnce(&mut BTreeMap<u64, Value>)) -> Header {
        let Value::Map(mut m) = decode(h.stored()).unwrap().value else {
            panic!("a header is a map")
        };
        f(&mut m);
        Header::read(&encode(&Value::Map(m)).unwrap()).unwrap()
    }

    fn kinds_of(h: &Header, f: impl FnOnce(&mut Vec<String>)) -> Header {
        header_with(h, |m| {
            let mut k: Vec<String> = h.kinds.iter().map(|k| k.as_str().to_owned()).collect();
            f(&mut k);
            m.insert(
                6,
                Value::Array(
                    k.into_iter()
                        .map(|k| Value::Text(Name::new(&k).unwrap()))
                        .collect(),
                ),
            );
        })
    }

    /// A pin of `plain` at a made-up revision.
    fn pin(plain: &str, byte: u8) -> String {
        format!("{plain}@1220{}", to_hex(&[byte; 32]))
    }

    /// A part with no effects that names `h`.
    fn naming(h: &Header) -> Vec<u8> {
        encode(&Value::Map(
            [
                (1, Value::Bytes(h.hash().to_bytes())),
                (2, Value::Array(Vec::new())),
            ]
            .into(),
        ))
        .unwrap()
    }

    fn folder(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("k16-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn owners_of(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, o)| ((*k).to_owned(), (*o).to_owned()))
            .collect()
    }

    /// `b` with two revisions of `eden:hall` pinned, as Eden's facts have (`core:hall` at 2 and 4).
    fn with_two_halls(mut b: Built) -> (Built, String, String) {
        let place = b
            .rules
            .kinds
            .values()
            .find(|k| k.owner == "place")
            .unwrap()
            .clone();
        let (h1, h2) = (pin("eden:hall", 1), pin("eden:hall", 2));
        let mut other = place.clone();
        other.children.insert("hall-two-only".into());
        b.rules.kinds.insert(h1.clone(), place);
        b.rules.kinds.insert(h2.clone(), other);
        b.header = kinds_of(&b.header, |k| k.extend([h1.clone(), h2.clone()]));
        (b, h1, h2)
    }

    #[test]
    fn the_header_the_log_names_is_the_worlds_and_a_world_with_none_keeps_this_builds() {
        let b = built();
        let d = folder("keep");
        let (h, owners) = own_header(&d, &b, std::slice::from_ref(&b.part)).unwrap();
        assert_eq!(h.stored(), b.header.stored());
        assert_eq!(std::fs::read(d.join("header")).unwrap(), b.header.stored());
        assert_eq!(owners, self::owners(&d));
        assert_eq!(
            owners.len(),
            b.header.kinds.len(),
            "every pinned kind's owner"
        );
        // The next start reads it.
        let (again, _) = own_header(&d, &b, std::slice::from_ref(&b.part)).unwrap();
        assert_eq!(again.stored(), b.header.stored());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_header_file_the_log_does_not_name_is_refused_header_mismatch() {
        let b = built();
        let d = folder("tampered");
        let other = kinds_of(&b.header, |k| {
            k.pop();
        });
        std::fs::write(d.join("header"), other.stored()).unwrap();
        let e = own_header(&d, &b, std::slice::from_ref(&b.part)).unwrap_err();
        assert!(e.starts_with("header-mismatch: "), "{e}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn another_worlds_header_is_refused_world_identity_mismatch() {
        let b = built();
        let d = folder("identity");
        let lineage = Scope([9; 16]);
        let other = header_with(&b.header, |m| {
            m.insert(3, Value::Bytes(lineage.0.to_vec()));
            m.insert(4, Id::new(lineage, 0).unwrap().to_value());
        });
        std::fs::write(d.join("header"), other.stored()).unwrap();
        let e = own_header(&d, &b, &[naming(&other)]).unwrap_err();
        assert!(e.starts_with("world-identity-mismatch: "), "{e}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn no_header_file_and_a_log_naming_another_is_refused_header_missing() {
        let b = built();
        let d = folder("missing");
        let older = kinds_of(&b.header, |k| {
            k.pop();
        });
        let e = own_header(&d, &b, &[naming(&older)]).unwrap_err();
        assert!(e.starts_with("header-missing: "), "{e}");
        assert!(!d.join("header").exists(), "nothing is kept");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_log_compacted_with_no_part_since_keeps_its_header_file() {
        let b = built();
        let d = folder("compacted");
        let older = kinds_of(&b.header, |k| {
            k.pop();
        });
        // With no part, a missing file is not taken on trust.
        let e = own_header(&d, &b, &[]).unwrap_err();
        assert!(
            e.starts_with("header-missing: the log names header none"),
            "{e}"
        );
        std::fs::write(d.join("header"), older.stored()).unwrap();
        let (h, _) = own_header(&d, &b, &[]).unwrap();
        assert_eq!(h.stored(), older.stored());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn this_builds_header_changes_nothing() {
        let mut b = built();
        let (rules, text, header) = (
            b.rules.kinds.clone(),
            b.kinds_text.clone(),
            b.header.clone(),
        );
        adopt(&mut b, header.clone(), &BTreeMap::new());
        assert_eq!(b.rules.kinds, rules);
        assert_eq!(b.kinds_text, text);
        assert_eq!(b.header.stored(), header.stored());
    }

    #[test]
    fn one_of_two_revisions_changed_pairs_only_the_changed_one() {
        let (mut b, h1, h2) = with_two_halls(built());
        let h3 = pin("eden:hall", 3);
        let world = kinds_of(&b.header, |k| {
            k.retain(|k| *k != h2);
            k.push(h3.clone());
        });
        let (one, two) = (b.rules.kinds[&h1].clone(), b.rules.kinds[&h2].clone());
        adopt(&mut b, world.clone(), &owners_of(&[(&h3, "place")]));
        assert_eq!(b.rules.kinds[&h3], two, "the changed revision's rules");
        assert_eq!(b.rules.kinds[&h1], one, "the unchanged one keeps its own");
        assert_eq!(b.header.stored(), world.stored());
    }

    #[test]
    fn both_revisions_changed_are_not_guessed() {
        let (mut b, h1, h2) = with_two_halls(built());
        let (h3, h4) = (pin("eden:hall", 3), pin("eden:hall", 4));
        let world = kinds_of(&b.header, |k| {
            k.retain(|k| *k != h1 && *k != h2);
            k.extend([h3.clone(), h4.clone()]);
        });
        adopt(&mut b, world, &owners_of(&[(&h3, "place"), (&h4, "place")]));
        assert!(!b.rules.kinds.contains_key(&h3) && !b.rules.kinds.contains_key(&h4));
    }

    #[test]
    fn a_revision_owned_otherwise_is_not_paired() {
        let (mut b, _, h2) = with_two_halls(built());
        let h3 = pin("eden:hall", 3);
        let world = kinds_of(&b.header, |k| {
            k.retain(|k| *k != h2);
            k.push(h3.clone());
        });
        adopt(&mut b, world.clone(), &owners_of(&[(&h3, "thing")]));
        assert!(!b.rules.kinds.contains_key(&h3));
        // And with no owners kept, nothing is paired either.
        let (mut b, _, _) = with_two_halls(built());
        adopt(&mut b, world, &BTreeMap::new());
        assert!(!b.rules.kinds.contains_key(&h3));
    }

    #[test]
    fn a_changed_activity_is_made_and_offered_by_the_worlds_pin() {
        let mut b = built();
        let ours = b.activities[0].name.as_str().to_owned();
        let theirs = pin(plain(&ours), 7);
        let world = kinds_of(&b.header, |k| {
            for n in k.iter_mut().filter(|n| **n == ours) {
                *n = theirs.clone();
            }
        });
        let text = b.kinds_text.clone();
        adopt(&mut b, world, &owners_of(&[(&theirs, "activity")]));
        assert_eq!(b.activities[0].name.as_str(), theirs);
        assert_eq!(b.rules.kinds[&theirs], b.rules.kinds[&ours]);
        assert!(
            b.kinds_text
                .lines()
                .any(|l| l.starts_with("# souls-boot-activity ") && l.ends_with(&theirs)),
            "the boot activity lines name the world's pin"
        );
        // Everything else, kind lines and boot targets included, is as this build wrote it.
        assert_eq!(b.kinds_text, text.replace(&ours, &theirs));
    }
}

/// S10c: the edit checker's lazy body snapshot (S10) in lockstep, on a world with bodies: the checker waits for the
/// bodies at a job's tick however long the tick takes, so a run fed the same inputs writes the same log.
#[cfg(test)]
mod s10c_lockstep {
    use super::*;
    use replica::edit::wire::{VERB, parameters};
    use replica::edit::{Op, Ref, Spot};
    use replica::effects::{Actor, Body as EffectBody, Change, Part};
    use replica::ids::Version;
    use replica::intents::{Intent, Target};
    use replica::pose::{Quat, Support};

    /// The most world time a step waits for its answers, in ticks.
    const MOST_TICKS: i64 = 2_000;

    /// N2's test world with a rack bay at its build site (as `tests/edit_served.rs`'s yard world), the construction
    /// entries and the body's, a beam taken in a hand by a form. The facts, the entries and the bay's slots by name.
    fn yard() -> (String, Vec<(String, Json)>, BTreeMap<String, u64>) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
        let mut paths: Vec<PathBuf> = std::fs::read_dir(root.join("construction"))
            .unwrap()
            .map(|f| f.unwrap().path())
            .collect();
        paths.sort();
        paths.push(root.join("body/humanoid.json"));
        let mut entries = Vec::new();
        let mut bay = None;
        for p in paths {
            let mut e = json::parse(&std::fs::read_to_string(&p).unwrap()).unwrap();
            if p.ends_with("rack_beam.json") {
                let form = json::parse(
                    r#"{"take": {"who": "anyone", "starts": "act", "needs": [{"need": "hand", "free": true}],
                        "steps": [{"step": "take"}],
                        "effects": [{"change": "reparent", "what": "this", "into": "actor_hand", "event": "taken"}]}}"#,
                )
                .unwrap();
                if let Json::Obj(o) = &mut e {
                    o.push(("forms".into(), form));
                }
            }
            if p.ends_with("rack_bay.json") {
                bay = Some(e.to_json());
            }
            let kind = e.get("kind").and_then(Json::str).unwrap().to_owned();
            entries.push((kind, e));
        }
        let kind = replica::kinds::entry::entry_to_kind(&bay.unwrap()).unwrap();
        let mut kinds = replica::kinds::Kinds::default();
        kinds.load(&[("rack_bay", kind.as_str())]);
        let def = kinds
            .admits()
            .into_keys()
            .find_map(|k| {
                kinds
                    .get(&k)
                    .filter(|d| d.name.as_str().starts_with("mars:rack_bay@"))
            })
            .expect("the bay's kind");
        let slots: Vec<(u64, String, [i64; 3])> = def
            .slots
            .iter()
            .map(|(n, s)| {
                (
                    *n,
                    s.name.as_ref().unwrap().as_str().to_owned(),
                    s.at_mm.unwrap_or([0, 0, 0]),
                )
            })
            .collect();
        let numbers = slots.iter().map(|s| (s.1.clone(), s.0)).collect();
        let mut f = json::parse(&testworld::generate(1, 0).unwrap().text).unwrap();
        let Json::Obj(top) = &mut f else {
            panic!("facts")
        };
        let num = |v: i64| Json::Int(i128::from(v));
        for (k, v) in top.iter_mut() {
            match (k.as_str(), v) {
                ("kinds", Json::Arr(a)) => a.push(
                    json::parse(&format!(
                        r#"{{"ref": "testworld-rack-bay@1", "hash": "{}", "name": "mars:rack_bay", "form": "point"}}"#,
                        to_hex(&sha256(b"souls/testworld/testworld-rack-bay@1"))
                    ))
                    .unwrap(),
                ),
                ("things", Json::Arr(a)) => {
                    let slots = slots
                        .iter()
                        .map(|(n, id, at)| {
                            Json::Obj(vec![
                                ("n".into(), num(*n as i64)),
                                ("id".into(), Json::s(id)),
                                ("kind".into(), Json::s("bay")),
                                ("at".into(), Json::Arr(at.iter().map(|&v| num(v)).collect())),
                                ("yaw".into(), num(0)),
                                ("capacity".into(), num(1)),
                            ])
                        })
                        .collect();
                    a.push(Json::Obj(vec![
                        ("id".into(), Json::s("site-bay")),
                        ("def".into(), Json::s("testworld-rack-bay@1")),
                        ("ref".into(), Json::s("testworld-rack-bay@1")),
                        ("parent".into(), Json::Null),
                        (
                            "pose".into(),
                            Json::Arr([65_000, 0, -24_000, 0].iter().map(|&v| num(v)).collect()),
                        ),
                        ("scale_ppm".into(), num(1_000_000)),
                        ("name".into(), Json::s("the site's rack bay")),
                        ("slots".into(), Json::Arr(slots)),
                    ]));
                }
                _ => {}
            }
        }
        (f.to_json(), entries, numbers)
    }

    fn int(v: i64) -> Value {
        u64::try_from(v).map_or_else(|_| Value::Nint(v.unsigned_abs() - 1), Value::Uint)
    }

    /// An act's final answer: its kind (1 a receipt, 2 a refusal), its reason (read in a failure's message) and its
    /// entries.
    #[derive(Debug)]
    #[allow(dead_code)]
    struct Got {
        kind: u64,
        reason: String,
        entries: Vec<u64>,
    }

    fn read(frame: &[u8]) -> Got {
        let Value::Map(m) = decode(frame).unwrap().value else {
            panic!("a frame")
        };
        let Some(Value::Map(a)) = m.get(&2) else {
            panic!("an answer: {m:?}")
        };
        Got {
            kind: match a.get(&3) {
                Some(Value::Uint(k)) => *k,
                _ => 0,
            },
            reason: match a.get(&4) {
                Some(Value::Text(t)) => t.as_str().to_owned(),
                _ => String::new(),
            },
            entries: match a.get(&5) {
                Some(Value::Array(e)) => e
                    .iter()
                    .filter_map(|v| match v {
                        Value::Uint(n) => Some(*n),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            },
        }
    }

    /// The yard world served in lockstep in this process, as `serve` builds it: the engine, a static creator's edits,
    /// births by the entry, and the bodies on the served town and planner.
    struct Lock {
        world: answers::World,
        store: sim::log::Mem,
        initial: Replica,
        built: Built,
        tick: i64,
        /// How many ticks after the last run an intent sent now is taken.
        ahead: i64,
        sequences: BTreeMap<Id, u64>,
    }

    impl Lock {
        fn start(facts: &str, entries: &[(String, Json)], creator: Id) -> Lock {
            let mut kinds = entries.to_vec();
            let built = build(facts, &kinds).unwrap();
            replica::kinds::entry::family_forms(&mut kinds, plain(&built.body_kind));
            let initial = Replica::start(built.header.stored()).unwrap();
            let (mut log, _) = Log::open(sim::log::Mem::with(Vec::new()), EPOCH).unwrap();
            let n = log.append(built.part.clone()).unwrap();
            log.wait_durable(n + 1).unwrap();
            let store = log.close();
            let (mut town, planner) =
                recovered_towns(&built, &initial, std::slice::from_ref(&built.part), &[]).unwrap();
            let (places, ..) = worldd::places::register(&mut town, &kinds);
            let runs = worldd::places::runs(&town, &kinds, &places);
            let rules = Rules {
                kinds: Json::Obj(kinds),
                moves: Json::Obj(Vec::new()),
            };
            let mut cfg = Config::new(built.header.lineage, EPOCH);
            cfg.lockstep = true;
            cfg.measures = false;
            cfg.engine = Some((built.rules.clone(), built.activities.clone()));
            cfg.edits = Some(Editing {
                creator,
                kinds: built.rules.kinds.clone(),
            });
            let ground = built.ground;
            let entry = Vec3::new(36_000_000, 0, -20_000_000);
            cfg.join = Some(Join {
                entry: (ground, entry),
                family: humanoid().unwrap(),
                kind: Name::new(&built.body_kind).unwrap(),
                per_tick: 8,
            });
            cfg.built_bodies = Some(Box::new(move |placed: &Placed, builds| {
                bodies(town, planner, ground, entry, placed, places, runs, builds)
            }));
            let world = answers::start(initial.frozen(), rules, store.clone(), cfg).unwrap();
            Lock {
                world,
                store,
                initial,
                built,
                tick: 0,
                ahead: 1,
                sequences: BTreeMap::new(),
            }
        }

        fn records(&self) -> Vec<Vec<u8>> {
            let log = self.store.0.lock().unwrap().bytes.clone();
            sim::log::recover(&log).unwrap().records
        }

        /// The world as its log has it now.
        fn replay(&self) -> Replica {
            let mut r = self.initial.frozen();
            for rec in self.records() {
                if !recorder::is_input(&rec) {
                    let p = Part::read(&rec).unwrap();
                    if !p.effects.is_empty() {
                        r.apply(&p).unwrap();
                    }
                }
            }
            r
        }

        /// `actor`'s intent (its id `who`), taken at the next tick; its answers on the receiver.
        fn send(
            &mut self,
            (actor, who): (Actor, Id),
            verb: &str,
            target: Option<Id>,
            parameters: BTreeMap<u64, Value>,
            planned: u64,
        ) -> Receiver<Vec<u8>> {
            let sequence = self.sequences.entry(who).or_insert(0);
            *sequence += 1;
            let lineage = self.built.header.lineage;
            let i = Intent {
                actor,
                verb: Name::new(verb).unwrap(),
                target: target.map(Target::Node),
                parameters,
                sequence: *sequence,
                basis: Version {
                    lineage,
                    zone: Id::new(lineage, 0).unwrap(),
                    epoch: EPOCH,
                    sequence: planned,
                }
                .to_value(),
                // Lockstep world time starts at 0: an expiry far ahead, the same in every run.
                expiry: i64::MAX,
                resources: Vec::new(),
                fallbacks: Vec::new(),
                replaces: None,
                body: None,
                reflex: false,
            };
            let (reply, rx) = channel();
            self.world
                .events
                .send(answers::Event::ArrivalAt {
                    tick: self.tick + self.ahead,
                    bytes: encode(&i.to_value()).unwrap(),
                    reply,
                })
                .unwrap();
            rx
        }

        fn soul(
            &mut self,
            soul: Id,
            verb: &str,
            target: Option<Id>,
            p: BTreeMap<u64, Value>,
        ) -> Receiver<Vec<u8>> {
            self.send((Actor::Soul(soul), soul), verb, target, p, 0)
        }

        fn walk(&mut self, soul: Id, at: Vec3) -> Receiver<Vec<u8>> {
            let g = self.built.ground;
            self.soul(
                soul,
                "eden:walk",
                Some(g),
                BTreeMap::from([(1, Value::Array(vec![int(at.x), int(0), int(at.z)]))]),
            )
        }

        /// Runs ticks until each of `rxs` has its final answer, in order.
        fn answers(&mut self, rxs: Vec<Receiver<Vec<u8>>>) -> Vec<Got> {
            let mut got: Vec<Option<Got>> = rxs.iter().map(|_| None).collect();
            let mut ran = 0;
            while got.iter().any(Option::is_none) {
                assert!(ran < MOST_TICKS, "no answer in {ran} ticks: {got:?}");
                self.tick += 10;
                ran += 10;
                let (done, rx) = channel();
                self.world
                    .events
                    .send(answers::Event::RunTo {
                        tick: self.tick,
                        done,
                    })
                    .unwrap();
                rx.recv().unwrap();
                for (rx, g) in rxs.iter().zip(got.iter_mut()) {
                    for frame in rx.try_iter() {
                        if answers::progress_of(&frame).is_none() {
                            *g = Some(read(&frame));
                        }
                    }
                }
            }
            got.into_iter().map(Option::unwrap).collect()
        }

        fn one(&mut self, rx: Receiver<Vec<u8>>) -> Got {
            self.answers(vec![rx]).pop().unwrap()
        }

        fn body_of(&self, soul: Id) -> Id {
            let r = self.replay();
            let t = r.tree();
            t.links_at(soul)
                .iter()
                .filter(|e| t.ty(e).as_str() == "souls:body-of")
                .find_map(|e| Some(t.link(e.link)?.1[0]))
                .expect("a body")
        }

        /// Where `id` is in the open ground's frame.
        fn at(&self, id: Id) -> Vec3 {
            let r = self.replay();
            let t = r.tree();
            sim::ground::scene::xform_to(
                t,
                t.handle(id).unwrap(),
                t.handle(self.built.ground).unwrap(),
            )
            .unwrap()
            .pos
        }

        /// The node of a kind starting `prefix` the entries numbered `entries` created.
        fn created(&self, entries: &[u64], prefix: &str) -> Id {
            for rec in self.records() {
                if recorder::is_input(&rec) {
                    continue;
                }
                for e in Part::read(&rec).unwrap().effects {
                    if !entries.contains(&e.envelope.sequence) {
                        continue;
                    }
                    if let EffectBody::Changes(cs) = e.body {
                        for c in cs {
                            if let Change::Create { node, kind, .. } = c.change
                                && kind.as_str().starts_with(prefix)
                            {
                                return node;
                            }
                        }
                    }
                }
            }
            panic!("no {prefix} created by {entries:?}")
        }

        fn bytes(self) -> Vec<u8> {
            let b = self.store.0.lock().unwrap().bytes.clone();
            self.world.stop();
            b
        }
    }

    /// The activity kind named `plain_name` as the world pins it, as an intent names it.
    fn built_activity(built: &Built, plain_name: &str) -> Value {
        let a = built
            .activities
            .iter()
            .find(|a| plain(a.name.as_str()) == plain_name)
            .unwrap_or_else(|| panic!("the world pins {plain_name}"));
        let hex = a.name.as_str().split_once('@').unwrap().1;
        Value::Array(vec![
            Value::Text(Name::new(plain_name).unwrap()),
            Value::Bytes(from_hex(hex).unwrap()),
        ])
    }

    /// One run: three Souls join; two take frame A off the yard's stand as a crew, carry it to the bay and seat it in
    /// `upright_a` (a crew's seating, checked with the bodies); the third takes a beam in its hand and sets it down (a
    /// set-down); the world's creator places an upright on the open ground (an edit). The log's bytes.
    fn run(facts: &str, entries: &[(String, Json)], slots: &BTreeMap<String, u64>) -> Vec<u8> {
        let creator = Id::new(Scope([0x5c; 16]), 1).unwrap();
        let mut w = Lock::start(facts, entries, creator);
        let im = import_eden::load(facts).unwrap();
        let (bay, fa, b3) = (
            im.nodes["site-bay"],
            im.nodes["yard-frame-1"],
            im.nodes["yard-beam-3"],
        );
        let g = w.built.ground;
        let souls: Vec<Id> = (1..=3)
            .map(|k| Id::new(Scope([0x5d; 16]), k).unwrap())
            .collect();
        let joins = souls
            .iter()
            .map(|s| w.soul(*s, answers::JOIN, None, BTreeMap::new()))
            .collect();
        for got in w.answers(joins) {
            assert_eq!(got.kind, 1, "joined: {got:?}");
        }
        let v3 = |x, z| Vec3::new(x, 0, z);
        let ends = |at: Vec3| (v3(at.x, at.z - 2_200_000), v3(at.x, at.z + 2_200_000));
        // The crew to frame A's ends, the third Soul beside beam 3.
        let (p, q) = ends(w.at(fa));
        let beam = w.at(b3);
        let walks = vec![
            w.walk(souls[0], p),
            w.walk(souls[1], q),
            w.walk(souls[2], v3(beam.x + 700_000, beam.z)),
        ];
        for got in w.answers(walks) {
            assert_eq!(got.kind, 1, "walked: {got:?}");
        }
        let carry = built_activity(&w.built, "mars:carry_activity");
        let second = w.body_of(souls[1]);
        let rx = w.soul(
            souls[0],
            "activity:offer",
            Some(g),
            BTreeMap::from([
                (1, carry),
                (2, Value::Text(Name::new("mars:front").unwrap())),
                (3, Value::Array(vec![second.to_value()])),
            ]),
        );
        let got = w.one(rx);
        assert_eq!(got.kind, 1, "offered: {got:?}");
        let crew = w.created(&got.entries, "mars:carry_activity@");
        let rx = w.soul(souls[1], "activity:accept", Some(crew), BTreeMap::new());
        let got = w.one(rx);
        assert_eq!(got.kind, 1, "accepted: {got:?}");
        let take = w.soul(
            souls[0],
            "part:take",
            Some(crew),
            BTreeMap::from([(1, fa.to_value())]),
        );
        let hand = w.soul(souls[2], "mars:take", Some(b3), BTreeMap::new());
        for got in w.answers(vec![take, hand]) {
            assert_eq!(got.kind, 1, "taken: {got:?}");
        }
        // The crew to the slot; the beam set down; the creator's upright on the open ground.
        let ua = {
            let r = w.replay();
            let t = r.tree();
            sim::ground::scene::slot_points(t, t.handle(bay).unwrap(), t.handle(g).unwrap())
                .unwrap()
                .into_iter()
                .find(|(n, _)| *n == slots["upright_a"])
                .unwrap()
                .1
        };
        let (p, q) = ends(ua);
        let upright = w
            .built
            .rules
            .kinds
            .keys()
            .find(|k| k.starts_with("mars:rack_upright@"))
            .unwrap()
            .clone();
        let place = |x: i64| Op::Place {
            name: 1,
            kind: Name::new(&upright).unwrap(),
            parent: Ref::Node(g),
            at: Spot {
                slot: None,
                position: v3(x, -30_000_000),
                orientation: Quat::IDENTITY,
                support: Support::Surface {
                    surface: g,
                    height: 0,
                },
            },
            audience: Audience::Everyone,
            fields: BTreeMap::new(),
        };
        let planned = w.replay().version();
        // Body-reading jobs in consecutive ticks (the set-down, then two edits): each reads its own tick's bodies.
        let mut rxs = vec![
            w.walk(souls[0], p),
            w.walk(souls[1], q),
            w.soul(
                souls[2],
                "hands:set-down",
                Some(b3),
                BTreeMap::from([(1, Value::Text(Name::new("place:here").unwrap()))]),
            ),
        ];
        for (k, x) in [50_000_000, 54_000_000].into_iter().enumerate() {
            w.ahead = 2 + k as i64;
            rxs.push(w.send(
                (Actor::Creator(creator), creator),
                VERB,
                None,
                parameters(&[place(x)]),
                planned,
            ));
        }
        w.ahead = 1;
        let got = w.answers(rxs);
        println!("S10c: walks, set-down, edits: {got:?}");
        for g in &got {
            assert_eq!(g.kind, 1, "done: {g:?}");
        }
        let rx = w.soul(
            souls[0],
            "part:put",
            Some(crew),
            BTreeMap::from([(1, bay.to_value()), (2, Value::Uint(slots["upright_a"]))]),
        );
        let got = w.one(rx);
        println!("S10c: seated: {got:?}");
        assert_eq!(got.kind, 1, "seated: {got:?}");
        w.bytes()
    }

    #[test]
    fn s10c_a_lockstep_edit_set_down_and_seating_with_bodies_log_the_same_bytes_twice() {
        let (facts, entries, slots) = yard();
        let a = run(&facts, &entries, &slots);
        let b = run(&facts, &entries, &slots);
        println!("S10c: logs of {} and {} bytes", a.len(), b.len());
        assert_eq!(sha256(&a), sha256(&b), "the same inputs write the same log");
    }

    /// N2's test world built as `serve` builds it, with its building's floor and that floor's door end: the shape of
    /// the hello-hamlet world whose saved state bricked on restart (a body logged on the cottage's floor 0.77 m past
    /// the floor's door end, mid-crossing, so every restart refused every move).
    fn door_world() -> (Town, Town, Id, Vec<PlaceAt>, Id, Vec3, Id) {
        let facts = testworld::generate(1, 0).unwrap();
        let imported = import_eden::load(&facts.text).unwrap();
        let floor = imported.nodes["building/floor-1"];
        let built = build(&facts.text, &[]).unwrap();
        let initial = Replica::start(built.header.stored()).unwrap();
        let (mut town, planner) =
            recovered_towns(&built, &initial, std::slice::from_ref(&built.part), &[]).unwrap();
        let (places, ..) = worldd::places::register(&mut town, &[]);
        let (link, door) = town
            .buildings
            .iter()
            .flat_map(|b| b.links.iter())
            .find_map(|l| {
                let e = l.ends.iter().flatten().find(|e| e.floor == floor)?;
                Some((l.id, e.middle()))
            })
            .expect("the building's floor has a door");
        let ground = built.ground;
        (town, planner, floor, places, link, door, ground)
    }

    /// A point 765 mm past the floor's door end (the saved row's offset), straight out of the floor: of the four ways
    /// along the axes, the one farthest from any point the floor holds.
    fn past_door(town: &Town, floor: Id, door: Vec3) -> Vec3 {
        let surface = &town
            .surfaces_for(replica::kinds::sizes::Size::Standard)
            .unwrap()[&floor];
        let off = |p: &Vec3| {
            let (_, n) = sim::ground::exits::nearest(surface.pieces(), *p).unwrap();
            (i128::from(n.x - p.x)).pow(2) + (i128::from(n.z - p.z)).pow(2)
        };
        let p = [(765_000, 0), (-765_000, 0), (0, 765_000), (0, -765_000)]
            .into_iter()
            .map(|(dx, dz)| Vec3::new(door.x + dx, door.y, door.z + dz))
            .max_by_key(off)
            .unwrap();
        let here = Frame {
            node: floor,
            slot: None,
        };
        let probe = Id::new(Scope([7; 16]), 99).unwrap();
        assert!(
            surface
                .place(probe, here, p, replica::pose::Quat::IDENTITY)
                .is_err_and(|r| r.name == "off-surface"),
            "a point past the door end, off the floor"
        );
        p
    }

    fn standing(node: Id, at: Vec3) -> replica::pose::Pose {
        replica::pose::Pose {
            frame: Frame { node, slot: None },
            position: at,
            orientation: replica::pose::Quat::IDENTITY,
            support: replica::pose::Support::Surface {
                surface: node,
                height: 0,
            },
        }
    }

    /// The minimised fixture of the bricked world's saved state: two bodies logged standing, one on the floor past its
    /// door end (off its surface), one on the open ground, and a third with no recorded build. The restart starts the
    /// first two (the first resumed by E11d's rule, the second where it stood) and leaves the third out by name: one
    /// bad row never stops the others.
    #[test]
    fn a_body_logged_off_its_ground_is_restored_and_never_stops_the_others() {
        use replica::kinds::sizes::Build;
        let (town, planner, floor, places, _, door, ground) = door_world();
        let past = past_door(&town, floor, door);
        let off = Id::new(Scope([7; 16]), 1).unwrap();
        let fine = Id::new(Scope([7; 16]), 2).unwrap();
        let unknown = Id::new(Scope([7; 16]), 3).unwrap();
        let gone = Id::new(Scope([7; 16]), 4).unwrap();
        let on_ground = Vec3::new(-40_000_000, 0, 30_000_000);
        let no_floor = Id::new(Scope([7; 16]), 77).unwrap();
        let placed: Placed = BTreeMap::from([
            (off, (standing(floor, past), None)),
            (fine, (standing(ground, on_ground), None)),
            (unknown, (standing(ground, on_ground), None)),
            (gone, (standing(no_floor, past), None)),
        ]);
        let builds = BTreeMap::from([
            (off, Build::STANDARD),
            (fine, Build::STANDARD),
            (gone, Build::STANDARD),
        ]);
        let entry = Vec3::new(-38_000_000, 0, 30_000_000);
        let mut b = bodies(
            town,
            planner,
            ground,
            entry,
            &placed,
            places,
            Vec::new(),
            &builds,
        )
        .expect("the bodies start");
        // A body whose floor is gone stands at the world's entry, named, and an entry on it says so.
        let (enode, eat) = b.pose(gone).expect("a body whose floor is gone stands");
        assert_eq!(enode, ground, "on the ground");
        let ground_surface = &b
            .town
            .surfaces_for(replica::kinds::sizes::Size::Standard)
            .unwrap()[&ground];
        let probe = Id::new(Scope([7; 16]), 98).unwrap();
        assert!(
            ground_surface
                .place(
                    probe,
                    Frame {
                        node: ground,
                        slot: None
                    },
                    eat,
                    replica::pose::Quat::IDENTITY
                )
                .is_ok(),
            "at a point it may stand on: {eat:?}"
        );
        assert!(
            b.resumed.contains(&(gone, "resume-entry")),
            "{:?}",
            b.resumed
        );
        b.begin(0);
        b.step(50_000);
        let said: Vec<_> = b
            .wind_log
            .iter()
            .filter(|e| e.envelope.node == gone)
            .flat_map(|e| e.events.iter().flatten())
            .filter(|ev| ev.name.as_str() == worldd::unstick::RESTARTED)
            .collect();
        assert_eq!(said.len(), 1, "one entry on the body: {said:?}");
        let (node, _) = b.pose(off).expect("the body logged off its floor started");
        assert_eq!(node, floor, "on its own floor's frame");
        // E11d's resume: carried on to the floor's nearest legal point (a way out through the door), never refused.
        assert!(
            b.runner.controller.carried(off) || b.resumed.iter().any(|(i, _)| *i == off),
            "resumed by rule: {:?}",
            b.resumed
        );
        let (gnode, gat) = b.pose(fine).expect("the other body started");
        assert_eq!((gnode, gat.x, gat.z), (ground, on_ground.x, on_ground.z));
        assert!(
            b.pose(unknown).is_none(),
            "a body that cannot be placed is left out"
        );
    }

    /// The write path: a body carried across a link is not logged while it is carried (its pose then follows the
    /// line past its floor's edge), so a kill mid-crossing restarts it where it last stood.
    #[test]
    fn a_body_crossing_a_link_is_logged_where_it_last_stood() {
        use replica::kinds::sizes::Build;
        let (town, planner, floor, places, link, door, ground) = door_world();
        let surface = &town
            .surfaces_for(replica::kinds::sizes::Size::Standard)
            .unwrap()[&floor];
        let body = Id::new(Scope([7; 16]), 1).unwrap();
        let (_, inside) = sim::ground::exits::nearest(surface.pieces(), door).unwrap();
        let recorded = surface
            .place_built(
                body,
                Frame {
                    node: floor,
                    slot: None,
                },
                inside,
                replica::pose::Quat::IDENTITY,
                Build::STANDARD,
            )
            .unwrap()
            .pose;
        let placed: Placed = BTreeMap::from([(body, (recorded, None))]);
        let builds = BTreeMap::from([(body, Build::STANDARD)]);
        let mut b = bodies(
            town,
            planner,
            ground,
            Vec3::ZERO,
            &placed,
            places,
            Vec::new(),
            &builds,
        )
        .unwrap();
        assert!(b.moved().is_empty());
        // Out through the door and on past its end, at 1 m/s: half a second in, it is still crossing.
        let past = past_door(&b.town, floor, door);
        let far = Vec3::new(past.x * 2 - door.x, past.y, past.z * 2 - door.z);
        b.runner
            .controller
            .carry(
                body,
                sim::controller::Track {
                    link: Some(link),
                    line: vec![door, past, far],
                    speed: 1_000_000,
                    to: ground,
                    arrive: None,
                    hold: false,
                },
            )
            .unwrap();
        b.begin(0);
        for n in 1..=10 {
            b.step(n * 50_000);
        }
        let now = b.runner.controller.body(body).unwrap().pose;
        assert_ne!(
            now.position, recorded.position,
            "the body moved along the carry"
        );
        assert!(b.runner.controller.carried(body), "still crossing");
        assert!(b.moved().is_empty(), "nothing logged mid-crossing");
        assert_eq!(
            b.placed()[&body].0,
            recorded,
            "the checkpoint keeps where it last stood"
        );
    }
}

#[cfg(test)]
mod arrival_tests {
    use super::*;

    const FACTS: &str = r#"{"places": [
        {"id": "e_1.area", "name": "place-region-campus-quad",
         "polygon": [[-29000, -109000], [5000, -109000], [5000, -85000], [-29000, -85000]]},
        {"id": "e_2.footpath", "name": "a-path", "line": [[0, 0], [10000, 4000]]},
        {"id": "e_3.area", "name": "bare"}
    ]}"#;

    /// A world names its arrival place by name or id; Souls arrive at the middle of its outline (Eden's campus quad:
    /// its fountain), or of its line; a place the facts lack, or one with no outline, is refused by name; a world that
    /// names none keeps its entry.
    #[test]
    fn an_arrival_place_is_the_middle_of_its_outline() {
        let facts = json::parse(FACTS).unwrap();
        assert_eq!(
            arrival_of(&facts, "place-region-campus-quad"),
            Ok((-12_000, -97_000))
        );
        assert_eq!(arrival_of(&facts, "e_1.area"), Ok((-12_000, -97_000)));
        assert_eq!(arrival_of(&facts, "a-path"), Ok((5_000, 2_000)));
        assert!(
            arrival_of(&facts, "nowhere")
                .unwrap_err()
                .starts_with("arrival-unknown")
        );
        assert!(
            arrival_of(&facts, "bare")
                .unwrap_err()
                .starts_with("arrival-unknown")
        );
        let named = json::parse(r#"{"arrival": "a-path"}"#).unwrap();
        assert_eq!(arrival(&named, FACTS), Ok(Some((5_000, 2_000))));
        let none = json::parse(r#"{"entry": [1, 2]}"#).unwrap();
        assert_eq!(arrival(&none, FACTS), Ok(None));
    }
}
