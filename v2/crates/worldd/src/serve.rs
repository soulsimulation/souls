//! One process runs a real world (Engine v2 C1, #3365): `worldd seed` makes a world folder from a loader's facts
//! file, and `worldd serve` runs it behind the gateway, as `supervisor launch` starts it.
//!
//! **The world folder** (`seed` writes it; everything after is the world's own):
//!
//! - `world.json`: `{"format": "souls/world/1", "name", "souls": [[counter, x mm, z mm], ...], "souls_scope",
//!   "entry": [x mm, z mm]}`. The name is the world's instance name, `<lineage hex>-<zone scope hex>-<zone counter>`
//!   (`worldd@<name>`); the entry is where Souls' bodies are born (C3), `seed`'s `--at`. With
//!   `"creator": "<32 hex>-<n>"` (`seed --creator`, G7b #3477) the world takes that creator's edit intents (G1b),
//!   checked against its own kinds. `world.kinds` keeps the unchanged pinned kinds text and explicit
//!   `# souls-boot-body <full place kind>` and `# souls-boot-activity <full place kind> <full activity pin>`
//!   lines for the creator's local checks of the existing boot registrations and admissions.
//! - `facts.json`: the facts file N1's exporter wrote (`v2/tools/import-eden`, or X6's `v2/tools/import-world` for a
//!   live world). The world as built is read from it at each start: its header and the walkers' town.
//! - `entries/`: the Soul Actions entries (`souls-entry/1`), one file each, read into the checkers' rules by kind.
//!   An entry whose `roles` name two or more roles is also an activity kind (C30, [`activity_kinds`]).
//!   `moves.json`, when there, is each move's reach (`{<move>: {reach_mm}}`).
//! - `log`: K4's log. Its first record is the import's part, every node and link the loader committed, so the log
//!   holds the world from empty and a stream written from it draws the whole world.
//! - `checkpoints/`: K5's, taken by K18c's rule; a start resumes from the newest that verifies.
//! - `tokens`: the gateway's tokens file, `<grant> <sha-256 hex>` per Soul, never a token. `souls.tokens` (mode 0600)
//!   holds the Souls' tokens themselves, for a local client; it is never copied off the machine.
//! - `log.text/`: K16's text store, every word said in the world (O20b, #3523).
//! - `views/`: V1's stream of the zone's root (full, everyone), written by its off-clock canonical public observer, and
//!   `views/world.json`, `{"stream": "views/<its folder>/", "history": "history/"}`, both relative to the world's
//!   folder, which the page reads for `?world=` and pairing for the Soul's `history` (R16b, #3480). With a store,
//!   only public archive bundles/indexes are mirrored into `history/`; private bases/source remain in the Store.
//! - `gateway.sock`: the gateway's local socket (I1's framing, `answers::serve`), unless `--socket` or
//!   `$WORLDD_SOCKET` names another (a placed world's: a socket's path is at most 108 bytes, and a world folder's
//!   name is 67). `health.json`: O4's.
//!
//! **A start** reads the log through once (its records feed the stream from record 0), then hands it to K18's loop
//! (`answers::start`), which restores the newest checkpoint and replays the records after it. It prints `worldd:
//! started at tick <n> state <hash>`: after a SIGKILL that hash is the last logged tick's (K18's A3), bodies included.
//! Each record the loop syncs comes back on [`answers::Config::synced`] and goes to the public observer, off the clock
//! thread. No body stands on a first start; after it, each body the log has stands where the log last had it.
//! `world.json`'s Souls are their tokens' grants (`souls.tokens`), born as any Soul is.
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
//! <moved> stand points moved to clear ground`. A stand point a body cannot stand on is moved to the nearest clear ground
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
//! offer or a proposal on the ground (where bodies are born) makes its node there. A start prints `activities: <plain
//! names>`.
//! **Its creator** (G1e, #3532): with a store, the world's one creator is the one its record in the directory names
//! (the list's row for its lineage and zone, then that name's record, `directoryd::worlds::list::creator_of`), read
//! at the start and again every 30 s. Only that creator's edits are taken, each judged by G2's rule on the town before
//! it commits (`answers`'s edit checker); every other actor's, and every edit while the record names none, is refused
//! `edit.not-the-creator`. Without a store, only an explicit `world.json` creator may edit a standalone seeded world.
//!
//! Not here: a G9 fork as a seed (a fork's checkpoint has no facts file for the walkers' town).

// The process reads the wall clock once for the stream's anchor (V1 rule 5); the engine never does.
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, BTreeSet};
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
use replica::activity::{ActivityKind, Role};
use replica::apply::Replica;
use replica::bodies::{Class, Family, Resource, Want};
use replica::edit::World as Editing;
use replica::effects::{Effect, Header, Refusal, fixture_bytes};
use replica::encode::{Name, Value, decode, encode, from_hex, to_hex};
use replica::ids::{Id, Scope, sha256};
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
use supervisor::bucket::Under;
use worldd::answers::{self, Config, Join};
use worldd::bodies::{Bodies, Placed};
use worldd::buildsafe::Creator;
use worldd::checkers::Rules;
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

/// One start-up stage's elapsed-time stamp (#3672), only while `serve` starts.
fn stamp(stage: &str) {
    if let Some(t) = STARTED.get() {
        println!("start-up: {stage} at {} ms", t.elapsed().as_millis());
    }
}
/// K5's checkpoint interval: one each 8 MiB of log (the bench constant, as `worldd fork`).
const EVERY: u64 = 8 << 20;
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
struct Built {
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

/// The activity kinds a world's entries declare (C30, #3556): one for each entry whose `roles` (SA-G1a) name two or
/// more roles (B5 refuses a kind of one), `<entry kind>_activity`, pinned by the hash of its entry's roles. A role
/// is `<namespace>:<role>`, standing at its entry's first slot (`souls:here` when it has none) and claiming one hand,
/// so a member walks, sits and talks while it plays; an offer lapses after a minute and a leave takes at most 0.4 s,
/// as a conversation's. The `now` line (SA-G1b) is not a role.
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
        for (role, v) in &roles {
            let slot = v
                .get("places")
                .and_then(|p| p.get("slots"))
                .and_then(Json::arr)
                .and_then(|s| s.first())
                .and_then(Json::str);
            let place = slot.map_or("souls:here".to_owned(), |s| format!("{ns}:{s}"));
            out.push(Role {
                name: Name::new(&format!("{ns}:{role}")).ok_or("a role's name")?,
                place: Name::new(&place).ok_or("a role's place")?,
                claims: vec![Want::One(Class::Manipulator)],
            });
        }
        let pin = to_hex(&sha256(
            format!(
                "souls/activity/{kind}/{}",
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
            },
        );
    }
    Ok(by_kind.into_values().collect())
}

/// Loads a facts file (N1's or X6's) as the world as built, with the activity kinds of `entries` (C30).
/// The facts with today's rowing punts added (#3603): one moored on each standing water that has room
/// (`sim::courses::punts`), a thing of kind `core:rowing_punt` at its home, turned with its plank toward the bank, on its
/// own loop (its course). The same facts give the same punts, so a seed and every serve of the world agree.
fn with_punts(facts: &str) -> R<String> {
    let im = import_eden::load(facts)?;
    let Some(&ground) = im.nodes.get("ground") else {
        return Ok(facts.to_owned());
    };
    // Planks and exits only where a body can stand on the ground as the walk cuts it (C15's `stand_near`).
    let (waters, terrain) = sim::courses::punts::waters_of(&im.tree, ground)?;
    let root = *im.nodes.get("world").ok_or("the facts have no world")?;
    let header = import_eden::header(root, &im.rules)?;
    let next = im.tree.to_state().next;
    let mut town = Town::new(im.tree, ground, Doors::new(header, im.rules, next))
        .map_err(|e| format!("the town: {e:?}"))?;
    let view = town.view();
    let moorings = sim::courses::punts::moorings(&waters, terrain.as_ref(), |p| {
        view.stand_near(ground, p, 0, None).is_some()
    });
    if moorings.is_empty() {
        return Ok(facts.to_owned());
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
    Ok(f.to_json())
}

/// The facts with a kind for each entry kind a form makes (a `create`) that the facts do not already name (#3703): a
/// blank notice the notice board gives, made in a Soul's hand. A made thing's kind must be pinned in the world's header
/// like any other; with no thing of it in the facts it would not be. The same entries give the same kinds.
fn with_made(facts: &str, entries: &[(String, Json)]) -> R<String> {
    let mut f = json::parse(facts).map_err(|e| format!("the facts: {e:?}"))?;
    let named: BTreeSet<String> = f
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
    let known: BTreeSet<&str> = entries.iter().map(|(k, _)| k.as_str()).collect();
    let made: BTreeSet<String> = entries
        .iter()
        .flat_map(|(_, e)| e.get("forms").and_then(Json::obj).unwrap_or(&[]))
        .flat_map(|(_, f)| f.get("effects").and_then(Json::arr).unwrap_or(&[]))
        .filter(|e| e.get("change").and_then(Json::str) == Some("create"))
        .filter_map(|e| e.get("kind").and_then(Json::str))
        .filter(|k| known.contains(k) && !named.contains(*k))
        .map(str::to_owned)
        .collect();
    if made.is_empty() {
        return Ok(facts.to_owned());
    }
    let Json::Obj(top) = &mut f else {
        return Err("the facts are not an object".into());
    };
    let add: Vec<Json> = made
        .iter()
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
    match top.iter_mut().find(|(k, _)| k == "kinds") {
        Some((_, Json::Arr(a))) => a.extend(add),
        _ => return Err("the facts have no 'kinds' list".into()),
    }
    Ok(f.to_json())
}

/// The rowing punt's def (#3603): today's `rowing-punt`, a kind the world adds.
const PUNT_REF: &str = "core-rowing-punt@1";

fn build(facts: &str, entries: &[(String, Json)]) -> R<Built> {
    let facts = &with_made(&with_punts(facts)?, entries)?;
    let mut im = import_eden::load(facts)?;
    stamp("facts");
    for (k, id) in (0..).map_while(|k| Some((k, *im.nodes.get(&format!("e_punt{k}"))?))) {
        println!(
            "punt: rowing-punt-{} is {}",
            k + 1,
            replica::world_model::show(id)
        );
    }
    let mut activities = vec![conversation()?];
    activities.extend(activity_kinds(entries)?);
    stamp("activities");
    for a in &activities {
        im.rules.kinds.insert(
            a.name.as_str().to_owned(),
            Kind {
                owner: "activity".into(),
                children: Default::default(),
                slots: Default::default(),
                hands: None,
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
    })
}

/// The normal restart's movement geometry follows the same validated durable canonical parts as its writer.
/// The reader's initial replica, log mark, mapping and checkpoint selection remain unchanged.
fn recovered_towns(built: &Built, initial: &Replica, records: &[Vec<u8>]) -> R<(Town, Town)> {
    let mut live = initial.frozen();
    for bytes in records {
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
    let towns = Town::with_planner(live.tree().frozen(), built.ground, doors)
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
                    [--at <x m>,<z m>] [--creator <32 hex>-<n>]"
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
    let built = build(&text, &found)?;
    std::fs::create_dir_all(dir.join("entries")).map_err(io(&dir))?;
    std::fs::write(dir.join("facts.json"), &text).map_err(io(&dir))?;
    if let Some(text) = catalogue_text {
        std::fs::write(dir.join("bodies.json"), text).map_err(io(&dir))?;
    }
    if arg(args, "--entries").is_some() {
        // C13: preserve the current main stand-point repair while keeping activity loading above.
        for line in import_eden::clear_stand_points(&import_eden::load(&text)?, &mut found) {
            println!("stand point: {line}");
        }
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
    let n = log.append(built.part).map_err(refusal)?;
    log.wait_durable(n + 1).map_err(refusal)?;
    drop(log.close());
    // The world's one creator (G7b), if named: `serve` takes its edits.
    let creator = match arg(args, "--creator") {
        Some(c) => format!(", \"creator\": \"{c}\"", c = creator_of(c).map(|_| c)?),
        None => String::new(),
    };
    let meta = format!(
        "{{\"format\": \"souls/world/1\", \"name\": \"{name}\", \"souls_scope\": \"{}\", \"souls\": [{}], \
         \"entry\": [{}, {}]{creator}}}\n",
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

/// The seats the world's entries `kinds` declare on its things ([`import_eden::body_slots`]), each placed on the floor a
/// body stands on: its point and facing there, and its stand point in the slot's frame. A stand point a body cannot
/// stand on (under a table, against a wall) is moved to the nearest place within a form's reach of it where a body
/// can (C15's rule, `skills::form_runner::REACH`), so a rise always sets the body down on clear ground; one in a
/// doorway's clearance is moved out of it ([`out_of_passage`]), so the gateway's walk to the seat ends at it. Returns the
/// seats, the things they are on, the count of every body slot on those things, the seats that could not be placed (no
/// floor above the thing) and the stand points moved.
fn places(town: &mut Town, kinds: &[(String, Json)]) -> (Vec<PlaceAt>, usize, usize, usize, usize) {
    let (found, all) = import_eden::body_slots(&town.tree, kinds);
    let (buildings, ground) = (town.buildings.clone(), town.ground);
    let view = town.view();
    let (mut out, mut moved) = (Vec::new(), 0);
    for s in &found {
        let Some((floor, point, facing)) = view.on_floor(s.thing, s.at) else {
            continue;
        };
        let mut place = PlaceAt {
            thing: s.thing,
            place: replica::moves::Place {
                slot: s.slot,
                height: s.at.y.max(0),
                stand: [s.stand.x - s.at.x, s.stand.z - s.at.z],
            },
            point,
            facing,
            floor,
        };
        // The stand point on the floor, at the floor's height under the seat.
        let stand = place.stand().map(|p| Vec3::new(p.x, point.y - s.at.y, p.z));
        let [w, x, y, z] = facing.parts();
        let back = replica::pose::Quat::new(w, -x, -y, -z);
        // A stand point in a doorway's clearance is one the spot tables never give a walker (N9): a walk to it ends
        // a ring out, beyond the sit's reach, so it is moved out of the doorway as a blocked one is moved clear.
        let passage = |p: Vec3| sim::walk::town::in_passage(&buildings, &[], ground, floor, p);
        let clear = stand.ok().and_then(|stand| {
            if view.stand_near(floor, stand, 1, None).is_none() {
                view.stand_near(floor, stand, skills::form_runner::REACH, None)
            } else if passage(stand) {
                out_of_passage(&view, floor, stand, point, &passage)
            } else {
                None
            }
        });
        if let (Some(clear), Ok(back)) = (clear, back)
            && let Ok(d) = back.rotate(Vec3::new(clear.x - point.x, 0, clear.z - point.z))
        {
            place.place.stand = [d.x, d.z];
            moved += 1;
        }
        out.push(place);
    }
    let left = found.len() - out.len();
    let mut things: Vec<Id> = out.iter().map(|p| p.thing).collect();
    things.dedup();
    (out, things.len(), all, left, moved)
}

/// The nearest place to `at` (µm, `floor`'s frame) within [`skills::form_runner::REACH`] where a body may stand, that
/// is out of every doorway and stair (`passage`) and no nearer the slot's point `slot_at` than `at` is (so not into the
/// thing: a bed's mattress is not a solid), on [`sim::spots::within`]'s rings; `None` when none is.
fn out_of_passage(
    view: &sim::walk::town::View<'_>,
    floor: Id,
    at: Vec3,
    slot_at: Vec3,
    passage: &dyn Fn(Vec3) -> bool,
) -> Option<Vec3> {
    let pitch = sim::spots::REACH_PITCH;
    let mut best: Option<(i64, Vec3)> = None;
    for ring in 1..=skills::form_runner::REACH / pitch {
        let n = 6_283 * ring / 1_000;
        for k in 0..n {
            let Ok(off) = replica::pose::Quat::from_yaw_mdeg(k * 360_000 / n)
                .and_then(|q| q.rotate(Vec3::new(0, 0, ring * pitch)))
            else {
                continue;
            };
            let Some(p) =
                view.stand_near(floor, Vec3::new(at.x + off.x, at.y, at.z + off.z), 1, None)
            else {
                continue;
            };
            let gap = sim::spots::flat(p, at);
            let out = sim::spots::flat(p, slot_at) >= sim::spots::flat(at, slot_at);
            if out && !passage(p) && best.is_none_or(|b| gap < b.0) {
                best = Some((gap, p));
            }
        }
        if best.is_some() {
            break;
        }
    }
    best.map(|b| b.1)
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

/// Fixed private migration support. It can choose only an already admitted birth, never mutate a live body.
fn imported_births(
    dir: &Path,
    header: &replica::effects::Header,
    catalogue: &skills::wear::Catalogue,
    born: &mut BTreeMap<Id, [u8; 32]>,
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
    for row in rows {
        let fields = row.obj().ok_or(bad)?;
        if !(3..=4).contains(&fields.len())
            || fields
                .iter()
                .any(|(k, _)| !["soul", "entry", "asked", "body"].contains(&k.as_str()))
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
    Ok(())
}

/// The world's bodies: none on a first start (each Soul's is born when it first acts, C3); on a restart, each body
/// where the log last had it. The planner keeps its own town and all declared seats are registered.
fn bodies(
    town: Town,
    planner: Town,
    ground: Id,
    placed: &Placed,
    places: Vec<PlaceAt>,
    builds: &std::collections::BTreeMap<Id, replica::kinds::sizes::Build>,
) -> Result<Bodies, Refusal> {
    let family = humanoid().map_err(|e| Refusal {
        name: "family",
        detail: e,
    })?;
    let mut at = Vec::new();
    for (id, (pose, _)) in placed {
        let build = builds.get(id).copied().ok_or_else(|| Refusal {
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
                        p.thing == pose.frame.node
                            && pose.frame.slot.is_none_or(|s| s == p.place.slot)
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
        let moved = surface.place_built(*id, Frame { node, slot: None }, point, facing, build)?;
        at.push((moved, build));
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
    let mut b = Bodies::with_planner(town, planner, 50_000)?;
    for s in places {
        b.add_place(s)?;
    }
    for (thing, course) in moving {
        let home = course.stations.first().map_or(Vec3::ZERO, |s| s.at);
        b.slots.moving(thing, &course, home)?;
    }

    for (a, build) in at {
        b.add_body_at_built(family.clone(), a, placed, build)?;
    }
    Ok(b)
}

type Bucket = Shared<supervisor::bucket::Bucket>;

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
    fn mirror(&self, key: &str, bytes: &[u8]) -> Result<(), Refusal> {
        if !history_public_key(key) {
            return Ok(());
        }
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
        let mut path = self.public.clone();
        for component in std::iter::once("").chain(key.split('/').take(key.split('/').count() - 1))
        {
            if !component.is_empty() {
                path.push(component);
            }
            match std::fs::symlink_metadata(&path) {
                Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
                Ok(_) => return Err(fail("directory symlink or type mismatch")),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => std::fs::create_dir(&path)
                    .map_err(|_| fail("cannot create export directory"))?,
                Err(_) => return Err(fail("cannot inspect export directory")),
            }
        }
        let path = self.public.join(key);
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
                self.mirror(&key, &object.bytes)?;
            }
        }
        Ok(())
    }
}
impl Store for Again {
    fn get(&self, key: &str) -> Result<Option<Object>, Refusal> {
        self.store.get(key)
    }
    fn list(&self, prefix: &str) -> Result<Vec<String>, Refusal> {
        self.store.list(prefix)
    }
    fn put(&self, key: &str, bytes: &[u8], when: When) -> Result<String, Refusal> {
        let result = match self.store.put(key, bytes, when) {
            Err(e) if e.name == "precondition-failed" && when == When::Absent => {
                match self.store.get(key)? {
                    Some(old) if old.bytes == bytes => Ok(old.etag),
                    Some(old) if history_mutable_key(key) => {
                        self.store.put(key, bytes, When::Is(&old.etag))
                    }
                    _ => Err(e),
                }
            }
            other => other,
        }?;
        self.mirror(key, bytes)?;
        Ok(result)
    }
}

/// Where each record on the disk goes off the machine: the shipper, and the archiver (parts only, numbered among
/// the parts).
struct Off {
    ship: Sender<Item>,
    archive: Option<Sender<(u64, Vec<u8>)>>,
    parts: u64,
    based: bool,
    archive_base: u64,
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
                    let _ = a.send((record, bytes.to_vec()));
                }
            } else if !input {
                let _ = a.send((self.parts, bytes.to_vec()));
                self.parts += 1;
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
/// in `rx` in order (#3746).
fn archiving(
    open: impl FnOnce() -> Result<Archiver<Again>, Refusal> + Send + 'static,
    rx: Receiver<(u64, Vec<u8>)>,
    text: Arc<sim::text::Store>,
) -> std::thread::JoinHandle<Result<(), Refusal>> {
    std::thread::spawn(move || {
        let mut a = open()?;
        let mut indexed = a.shelf.writes.bundles;
        let (mut fresh, mut viewed) = (false, std::time::Instant::now());
        loop {
            if a.is_based() && a.refresh_redactions(text.redactions())? {
                fresh = true;
            }
            match rx.recv_timeout(shipping::POLL * 20) {
                Ok((n, bytes)) => {
                    if a.is_based() {
                        a.refresh_redactions(text.redactions())?;
                    }
                    a.push(n, bytes)?;
                    fresh = true;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
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
            if fresh && viewed.elapsed() >= VIEWS_EVERY {
                a.publish_open()?;
                for (k, v) in a.open_views()? {
                    a.shelf.put_view(&k, &v)?;
                }
                (fresh, viewed) = (false, std::time::Instant::now());
            }
        }
    })
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
        checkpoint,
        text,
    } = source;
    let (first, records) = (recovered.first, recovered.records.as_slice());
    let store: Bucket = Shared(Arc::new(
        supervisor::bucket::Bucket::from_spec(spec).map_err(refusal)?,
    ));
    println!("store: {}", store.0.what());
    let prefix = format!("h/{name}/{}/", to_hex(&built.header.lineage.0));
    let fork_base = checkpoint
        .map(|newest| fork_archive_base(&store, &prefix, dir, &built.header, newest, recovered))
        .transpose()
        .map_err(refusal)?;
    let machine = Name::new(machine).ok_or_else(|| format!("--machine {machine}: not a name"))?;
    let mut d = Directory::new(store.clone(), machine);
    let (lineage, zone) = (built.header.lineage.0, built.header.zone);
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
    let archive = if let Some(base) = fork_base {
        // The opened archive's base is this one: `fork_archive_base` read the stored head's base, as the open does.
        based = true;
        archive_base = base.record;
        let (store, header, words) = (store.clone(), built.header.clone(), Arc::clone(&text));
        let open = move || {
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
        report("the archiver", archiving(open, rx, Arc::clone(&text)));
        Some(tx)
    } else if let Some(kind) = built
        .header
        .kinds
        .iter()
        .find(|k| k.as_str().starts_with("souls:place@"))
        .cloned()
    {
        again
            .put("header", built.header.stored(), When::Absent)
            .map_err(refusal)?;
        let a = Archiver::open(again.clone(), "", &built.header, zone, kind).map_err(refusal)?;
        again.restore_public().map_err(refusal)?;
        let (tx, rx) = channel();
        report(
            "the archiver",
            archiving(move || Ok(a), rx, Arc::clone(&text)),
        );
        Some(tx)
    } else {
        None
    };
    let mut off = Off {
        ship,
        archive,
        parts: 0,
        based,
        archive_base,
    };
    for (k, bytes) in records.iter().enumerate() {
        let record = first + k as u64;
        let input = recorder::is_input(bytes);
        if record >= from {
            off.take(record, bytes, input);
        } else if let Some(a) = &off.archive {
            if off.based {
                if record >= off.archive_base {
                    let _ = a.send((record, bytes.clone()));
                }
            } else if !input {
                let _ = a.send((off.parts, bytes.clone()));
                off.parts += 1;
            }
        }
    }
    Ok(off)
}

/// The world's one creator, read from its record in the directory `spec` names (G1e, #3532) at the start, and again
/// each [`CREATOR_EVERY`] on a thread of its own: a change replaces it (there is never more than one), and a failed
/// read keeps the last.
fn creator(spec: &str, built: &Built) -> R<Arc<Creator>> {
    let store = supervisor::bucket::Bucket::from_spec(spec).map_err(refusal)?;
    let (lineage, zone) = (built.header.lineage.0, built.header.zone);
    let read = Arc::new(move || directory_creator_of(&store, &lineage, zone));
    let admission = Arc::clone(&read);
    let creator = Arc::new(Creator::with_reader(
        read().map_err(refusal)?,
        Arc::new(move || admission().ok().flatten()),
    ));
    let say = |c: Option<Id>| c.map_or_else(|| "none".to_owned(), principal_text);
    println!("creator: {}", say(creator.get()));
    let watched = Arc::clone(&creator);
    std::thread::Builder::new()
        .name("creator".into())
        .spawn(move || {
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

/// `worldd serve --dir <world folder> [--socket <path>] [--checkpoint-every <bytes>] [--store <store>] [--machine
/// <name>] [--rate <num>/<den>]`: runs the world until killed. A checkpoint is taken each `--checkpoint-every` bytes
/// of log (default 8 MiB). The clock's rate is world µs per real µs (default 1/1); a start whose rate differs from the
/// last logged applies a new mapping, and the mapping in force is on the zone root for every copy (E7b, #3516).
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
    let _ = STARTED.set(std::time::Instant::now());
    stamp("launch");
    let dir = PathBuf::from(arg(args, "--dir").ok_or(
        "usage: worldd serve --dir <world folder> [--socket <path>] [--checkpoint-every <bytes>] [--store <store>] \
         [--machine <name>] [--directory <file>] [--rate <num>/<den>]",
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
    let facts = dir.join("facts.json");
    let mut kinds = Vec::new();
    if dir.join("entries").is_dir() {
        entries(&dir.join("entries"), &mut kinds)?;
    }
    stamp("entries");
    let built = build(
        &std::fs::read_to_string(&facts).map_err(io(&facts))?,
        &kinds,
    )?;
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
        let towns = Town::with_planner(live.tree().frozen(), built.ground, doors)
            .map_err(|e| format!("the fork's town: {e}"))?;
        stamp("town and planner");
        (initial, record, observer, Some(checkpoint), towns)
    } else {
        let initial = Replica::start(built.header.stored()).map_err(refusal)?;
        let towns = recovered_towns(&built, &initial, &found.records)?;
        (initial, 0, None, None, towns)
    };
    let (initial, base_record, stream_mapping, checkpoint, (mut town, mut planner)) = started;
    town.prepare_classes(catalogue.classes())
        .map_err(|e| format!("body-classes: {e}"))?;
    planner
        .prepare_classes(catalogue.classes())
        .map_err(|e| format!("body-classes: {e}"))?;
    stamp("body classes");
    let (places, things, all, left, moved) = places(&mut town, &kinds);
    stamp("places to sit placed");
    println!(
        "places to sit or lie: {} registered on {} things; {all} body slots declared; {left} with no floor; {moved} stand points \
         moved to clear ground",
        places.len(),
        things
    );
    let rules = Rules {
        kinds: Json::Obj(kinds),
        moves,
    };
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
            Some(off_machine(
                spec,
                &machine,
                &built,
                &name,
                &dir,
                SourceContext {
                    recovered: &found,
                    checkpoint: checkpoint.as_deref(),
                    text: Arc::clone(&text),
                },
            )?)
        }
        None => None,
    };
    let (tx, synced) = channel();
    imported_births(&dir, initial.header(), &catalogue, &mut born)?;
    let mut cfg = Config::new(built.header.lineage, EPOCH);
    cfg.public_names = Arc::clone(&built.public_names);
    let every = arg(args, "--checkpoint-every").map_or(Ok(EVERY), |n| {
        n.parse::<u64>().map_err(|_| "--checkpoint-every <bytes>")
    })?;
    cfg.checkpoints = Some((dir.join("checkpoints"), every));
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
    hub.seed(initial.tree());
    let feed = worldd::views::served::start_with(hub).map_err(refusal)?;
    for bytes in found.after(base_record) {
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
    // E6's day, night and weather on Eden's calendar, written at the first tick of a world whose node holds none (C5).
    cfg.sky = Some(eden_sky(built.header.lineage));
    // The engine's own acts (C2) and the activities they run (C30).
    cfg.engine = Some((built.rules.clone(), built.activities.clone()));
    // With a directory, its authoritative creator (including none) is always used; static metadata is only the
    // standalone seeded-world fallback. Lookup failures have already refused startup above.
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

    let ground = built.ground;

    // Births by the world's entry (C3): `world.json`'s `entry`, else the first place it lists for a Soul.
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
    cfg.join = Some(Join {
        entry: (ground, entry),
        family: humanoid()?,
        kind: Name::new(&built.body_kind).ok_or("the body's kind")?,
        per_tick: 8,
    });
    cfg.wear = Some(answers::Wearing { catalogue, born });
    cfg.built_bodies = Some(Box::new(move |placed: &Placed, builds| {
        let b = bodies(town, planner, ground, placed, places.clone(), builds);
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
    let stream_store = supervisor::bucket::Bucket::from_spec(
        bucket
            .as_deref()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("folder:{}", dir.join(".stream-recovery-store").display()))
            .as_str(),
    )
    .map_err(refusal)?;
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
        record: base_record,
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
    // for the stream's first flush, which on a fresh world has no history to replay.
    let pointer_path = views.join("world.json");
    let fresh = !pointer_path.exists();
    let (ready_tx, ready_rx) = channel::<()>();
    let stream_header = built.header.clone();
    let stream_found = Arc::clone(&found);
    drop(found);
    let (stream_tx, stream_rx) = channel::<(u64, Vec<u8>)>();
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
                let start = view_out::PublicStart {
                    root: &views_dir,
                    header: &stream_header,
                    key,
                    initial: stream_initial,
                    record: stream_record,
                    checkpoint: stream_checkpoint,
                    text: stream_text,
                    names: stream_names,
                    clock_seed: stream_clock,
                    history: Some(&*stream_found),
                };
                let mut writer = view_out::PublicWriter::open(start, stream_store)?;
                // Both the pointer and placement bootstrap resolve the existing strict public history export.
                let history = "history/";
                let pointer = format!(
                    "{{\"stream\":\"views/{}/\",\"history\":\"{history}\"}}\n",
                    stream::dir(&stream_header, &key)
                );
                view_out::write_whole(&views_dir.join("world.json"), pointer.as_bytes())?;
                // Physical cursor includes input records; public effect versions are independently validated by the
                // observer.
                writer.bridge_to(stream_found.first)?;
                for (offset, bytes) in stream_found.records.iter().enumerate() {
                    let record = stream_found.first + offset as u64;
                    if record >= writer.source_cursor() {
                        writer.push(record, bytes)?;
                    }
                }
                writer.flush()?;
                stamp("public stream");
                let _ = ready_tx.send(());
                drop(stream_found);
                loop {
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
                    writer.idle(answers::now())?;
                }
            })();
            if let Err(e) = result {
                eprintln!(
                    "worldd: the public stream stopped, the world goes on: {}",
                    refusal(e)
                );
            }
        })
        .map_err(|e| e.to_string())?;
    if fresh && ready_rx.recv().is_err() {
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
    if !pointer_path.is_file() {
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
        imported_births(&dir, &header, &catalogue, &mut born).unwrap();
        assert!(
            born.is_empty(),
            "absent private file leaves defaults unchanged"
        );
        std::fs::write(dir.join("births.json"), &valid).unwrap();
        imported_births(&dir, &header, &catalogue, &mut born).unwrap();
        assert_eq!(born.get(&soul), Some(&[0x11; 32]));
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
            assert!(imported_births(&dir, &header, &catalogue, &mut born).is_err());
            assert_eq!(born, before, "no partial installation on refusal");
        }
        std::fs::write(dir.join("births.json"), valid).unwrap();
        let mut explicit = BTreeMap::from([(soul, [0x22; 32])]);
        assert!(
            imported_births(&dir, &header, &catalogue, &mut explicit)
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
            recovered_towns(&built, &initial, std::slice::from_ref(&built.part)).unwrap();
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
        let (mut town, mut planner) = recovered_towns(&built, &initial, &records).unwrap();
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
        assert!(recovered_towns(&built, &initial, &invalid).is_err());
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
            parts: 0,
            based: true,
            archive_base: 4,
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
            parts: 0,
            based: false,
            archive_base: 4,
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

    #[test]
    fn w3c_public_history_mirror_is_strict_immutable_and_symlink_safe() {
        use directoryd::directory::store::Store;
        use replica::history::{Bundle, DayIndex, WINDOW_LEAST};
        let header =
            Header::read(&fixture_bytes(replica::effects::FIXTURE_HEADER).unwrap()).unwrap();
        let dir = std::env::temp_dir().join(format!("w3c-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bucket = Shared(Arc::new(
            supervisor::bucket::Bucket::parse(
                &format!("folder:{}", dir.join("store").display()),
                |_| String::new(),
            )
            .unwrap(),
        ));
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
            recovered_towns(&built, &initial, std::slice::from_ref(&built.part)).unwrap();
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
            2,
            "conversation and entry runtime pins"
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
