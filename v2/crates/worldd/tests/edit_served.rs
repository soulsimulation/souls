//! Engine v2 G1e (#3532): a world served by `worldd serve` is edited by its one creator, as its record in the directory
//! names it, through a real gateway; and BUILDSAFE refuses, by name, an edit that would bury a Soul.
//!
//! - **A1** (N2's test world): the store's list row and name record name the creator; `serve` prints it at the start.
//!   Another creator's edit is refused `edit.not-the-creator`; the named creator's commits.
//! - **A2, A3** (seeded Eden, `--ignored`: needs the exported Eden facts file): 21 Souls in a row on the open
//!   ground, 20 of them walking; the 21st walks to its place first, since no Soul stands until it acts (C3). A wall where the 21st stands is refused `edit.would-bury`; once it has walked away,
//!   the same wall commits. Each edit's answer is timed through the gateway, beside the 20 walkers.
//! - **#3923** (N2's test world, in CI): the same refusal for a Soul that has acted, standing where its walk ended.
//! - **G1f A1, K18d** (N2's test world with one Eden chair, in CI; Eden with `EDEN_FACTS`, `--release`): a creator's
//!   chair, and building, rooms, door and chair, are sat in; an occupied seat or the door to it is not removed, and
//!   a wall over the seated Soul is refused.

// A real process and a real gateway on the real clock: the waits and the times are real time.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};
use std::time::{Duration, Instant};

use directoryd::accounts::principal_text;
use directoryd::directory::store::{Store, When};
use directoryd::worlds::create::NameRecord;
use futures_util::{SinkExt, StreamExt};
use gatewayd::receipts::Receipts;
use gatewayd::token::{Grant, Token, Tokens};
use gatewayd::{Gateway, Log, resume, socket, world_link};
use replica::edit::wire::{Asked, VERB, parameters, parameters_of};
use replica::edit::{Op, Ref, Spot};
use replica::effects::Actor;
use replica::encode::{Name, Value, decode, encode, from_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Hello, Intent, PROTOCOL, Target};
use replica::pose::{Quat, Support, Vec3};
use replica::rules::json;
use replica::world_model::Audience;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use worldd::answers;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const BUILD: [u8; 4] = [0x12, 0x20, 0xab, 0xcd];
const M: i64 = 1_000_000;

fn scratch(tag: &str) -> PathBuf {
    // Short: a Unix socket's path is at most 104 bytes on macOS.
    let d = std::env::temp_dir().join(format!("{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("a scratch folder");
    d
}

/// A running `worldd serve`, its output lines on a channel.
struct Served {
    child: Child,
    lines: Receiver<String>,
}

impl Served {
    /// The first line starting with `prefix`, within `secs`.
    fn line(&self, prefix: &str, secs: u64) -> String {
        let end = Instant::now() + Duration::from_secs(secs);
        while let Some(left) = end.checked_duration_since(Instant::now()) {
            match self.lines.recv_timeout(left) {
                Ok(l) if l.starts_with(prefix) => return l,
                Ok(_) => {}
                Err(_) => break,
            }
        }
        panic!("no line {prefix:?}");
    }
}

impl Drop for Served {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// What a seeded world gives the test.
struct Seeded {
    dir: PathBuf,
    /// The Souls' bodies, in `world.json`'s order.
    souls: Vec<Id>,
    root: Id,
    zone: Id,
    ground: Id,
    /// A kind the open ground admits, with solids: the walls' kind.
    wall: Name,
}

/// `worldd seed` from the facts `text`, with `souls` Souls 2 m apart along x from (x m, z m).
fn seed(d: &Path, text: &str, souls: u64, at: (i64, i64)) -> Seeded {
    seed_entries(d, text, souls, at, None)
}

fn seed_entries(
    d: &Path,
    text: &str,
    souls: u64,
    at: (i64, i64),
    entries: Option<&Path>,
) -> Seeded {
    let facts = d.join("facts.json");
    std::fs::write(&facts, text).expect("facts");
    let im = import_eden::load(text).expect("loads");
    let (root, ground) = (im.nodes["world"], im.nodes["ground"]);
    let zone = import_eden::header(root, &im.rules).expect("a header").zone;
    let t = &im.tree;
    let gh = t.handle(ground).expect("the ground");
    let wall = t
        .children(gh)
        .unwrap_or_default()
        .iter()
        .filter_map(|&c| t.node(c))
        .find(|n| n.fields().contains_key(&import_eden::F_SOLIDS))
        .map(|n| n.kind().clone())
        .expect("a thing with solids on the open ground");
    let dir = d.join("w");
    let mut command = Command::new(env!("CARGO_BIN_EXE_worldd"));
    command
        .args(["seed", "--facts"])
        .arg(&facts)
        .arg("--dir")
        .arg(&dir)
        .args([
            "--souls",
            &souls.to_string(),
            "--at",
            &format!("{},{}", at.0, at.1),
        ]);
    if let Some(entries) = entries {
        command.arg("--entries").arg(entries);
    }
    let out = command.output().expect("seed runs");
    assert!(
        out.status.success(),
        "seed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let meta = json::parse(&std::fs::read_to_string(dir.join("world.json")).unwrap()).unwrap();
    let scope: [u8; 16] = from_hex(meta.get("souls_scope").and_then(json::Value::str).unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    Seeded {
        dir,
        souls: (1..=souls)
            .map(|c| Id::new(Scope(scope), c).unwrap())
            .collect(),
        root,
        zone,
        ground,
        wall,
    }
}

/// The directory's record of the world, in the folder store `bucket`: its row in the list and its name record, which
/// names `creator`.
fn record(bucket: &Path, w: &Seeded, creator: Id) {
    let store = directoryd::directory::folder::Folder::new(bucket.to_owned());
    let lineage = w.root.scope().0;
    let row = format!(
        "{{\"worlds\": [{{\"name\": \"g1e\", \"label\": \"G1e\", \"template\": \"eden\", \"lineage\": \"{}\", \
         \"zone\": \"{}\", \"creator\": \"{}\", \"made\": 0}}]}}",
        replica::encode::to_hex(&lineage),
        principal_text(w.zone),
        principal_text(creator)
    );
    store
        .put("world-list", row.as_bytes(), When::Absent)
        .expect("the list");
    let name = NameRecord {
        name: "g1e".into(),
        lineage,
        zone: w.zone,
        creator,
        source: [0; 16],
    };
    store
        .put(
            &NameRecord::key("g1e"),
            &name.to_bytes().unwrap(),
            When::Absent,
        )
        .expect("the name record");
}

fn serve(w: &Seeded, socket: &Path, bucket: &Path) -> Served {
    serve_with(w, socket, Some(bucket))
}

fn static_creator(w: &Seeded, creator: Id) {
    let path = w.dir.join("world.json");
    let text = std::fs::read_to_string(&path).unwrap();
    let (fields, trailing) = text.rsplit_once('}').unwrap();
    assert!(trailing.trim().is_empty());
    std::fs::write(
        path,
        format!(
            "{fields}, \"creator\": \"{}-{}\"}}",
            replica::encode::to_hex(&creator.scope().0),
            creator.counter()
        ),
    )
    .unwrap();
}

fn serve_with(w: &Seeded, socket: &Path, bucket: Option<&Path>) -> Served {
    let mut command = Command::new(env!("CARGO_BIN_EXE_worldd"));
    command
        .args(["serve", "--dir"])
        .arg(&w.dir)
        .arg("--socket")
        .arg(socket);
    if let Some(bucket) = bucket {
        command
            .arg("--store")
            .arg(format!("folder:{}", bucket.display()));
    }
    let mut child = command
        .args(["--machine", "test-machine"])
        .env_remove("WORLDD_STORE")
        .env_remove("DIRECTORY_STORE_URL")
        .env_remove("SOULS_BACKUP_URL")
        .env_remove("SOULS_BACKUP_KEY_FILE")
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
                if l.starts_with("worldd: k18d-edit-stage ") {
                    eprintln!("{l}");
                }
                let _ = tx.send(l);
            }
        });
    }
    Served { child, lines }
}

fn int(v: i64) -> Value {
    u64::try_from(v).map_or_else(|_| Value::Nint(v.unsigned_abs() - 1), Value::Uint)
}

fn basis(lineage: Scope, sequence: u64) -> Value {
    Version {
        lineage,
        zone: Id::new(lineage, 0).unwrap(),
        epoch: 1,
        sequence,
    }
    .to_value()
}

/// A wall 1 m long and 0.2 m thick, 2.5 m tall, on the open ground at (x, z) µm.
fn wall(w: &Seeded, x: i64, z: i64) -> Op {
    let solid = Value::Array(
        [0, 0, 500, 100, 0, 0, 2_500, 5, 0]
            .iter()
            .map(|&v| int(v))
            .collect(),
    );
    Op::Place {
        name: 1,
        kind: w.wall.clone(),
        parent: Ref::Node(w.ground),
        at: Spot {
            slot: None,
            position: Vec3::new(x, 0, z),
            orientation: Quat::IDENTITY,
            support: Support::Surface {
                surface: w.ground,
                height: 0,
            },
        },
        audience: Audience::Everyone,
        fields: BTreeMap::from([(import_eden::F_SOLIDS, Value::Array(vec![solid]))]),
    }
}

fn edit_intent(w: &Seeded, actor: Actor, sequence: u64, planned: u64, op: Op) -> Vec<u8> {
    edit_batch_intent(w, actor, sequence, planned, vec![op])
}

fn edit_batch_intent(
    w: &Seeded,
    actor: Actor,
    sequence: u64,
    planned: u64,
    ops: Vec<Op>,
) -> Vec<u8> {
    let i = Intent {
        actor,
        verb: Name::new(VERB).unwrap(),
        target: None,
        parameters: parameters(&ops),
        sequence,
        basis: basis(w.root.scope(), planned),
        expiry: i64::MAX,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    encode(&i.to_value()).unwrap()
}

/// Replay the actual served log, including its genesis, with the exact served kind catalog.
/// The entries a test seeded its world with (`<scratch>/entries`), by kind: none when it gave none.
fn seeded_entries(w: &Seeded) -> Vec<(String, json::Value)> {
    let dir = w.dir.parent().unwrap().join("entries");
    let Ok(files) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    files
        .filter_map(|f| {
            let e = json::parse(&std::fs::read_to_string(f.ok()?.path()).ok()?).ok()?;
            Some((e.get("kind")?.str()?.to_owned(), e))
        })
        .collect()
}

/// The slots of activity `name`'s entry that admit a thing, numbered as the entry orders them: what a running world
/// gives an activity kind (`serve.rs` `thing_slots`, 0.135 C4).
fn thing_slots(
    entries: &[(String, json::Value)],
    name: &str,
) -> BTreeMap<u64, std::collections::BTreeSet<String>> {
    let plain = name.split('@').next().unwrap_or(name);
    let slots = entries
        .iter()
        .find(|(k, _)| format!("{k}_activity") == plain)
        .and_then(|(_, e)| e.get("slots"))
        .and_then(json::Value::obj);
    (1..)
        .zip(slots.unwrap_or(&[]))
        .filter(|(_, (_, s))| s.get("admits").and_then(json::Value::str) == Some("thing"))
        .map(|(n, _)| (n, ["thing".to_owned()].into()))
        .collect()
}

fn served_copy(w: &Seeded) -> (replica::apply::Replica, replica::tree::Rules) {
    let mut rules = replica::tree::Rules::default();
    let text = std::fs::read_to_string(w.dir.join("world.kinds")).unwrap();
    for line in text.lines() {
        if line.trim_start().starts_with('#') {
            continue;
        }
        rules
            .kinds
            .extend(replica::world_model::parse_kinds(line).unwrap());
    }
    // Mirror the strict creator catalog projection: boot annotations preserve the raw pinned definitions,
    // while reconstructing the body's admission and the exact runtime activity keys used by serve::build.
    for line in text
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("# souls-boot-body"))
    {
        let target = line
            .strip_prefix("# souls-boot-body ")
            .filter(|s| !s.is_empty() && s.split_whitespace().count() == 1 && *s == s.trim())
            .expect("well-formed boot-body admission");
        rules
            .kinds
            .get_mut(target)
            .filter(|kind| kind.owner == "place")
            .expect("boot-body target is an existing full place kind")
            .children
            .insert("body".into());
    }
    for line in text
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("# souls-boot-activity"))
    {
        let fields: Vec<_> = line
            .strip_prefix("# souls-boot-activity ")
            .expect("well-formed boot-activity projection")
            .split_whitespace()
            .collect();
        let [target, activity] = fields.as_slice() else {
            panic!("well-formed boot-activity projection");
        };
        let (base, hash) = activity
            .split_once('@')
            .expect("a full runtime activity pin");
        assert!(
            !base.is_empty()
                && Name::new(base).is_some()
                && hash.len() == 68
                && hash.starts_with("1220")
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "a canonical full runtime activity pin"
        );
        assert!(
            rules
                .kinds
                .get(*target)
                .is_some_and(|kind| kind.owner == "place"),
            "boot-activity target is an existing full place kind"
        );
        // Its slots as the running world gives them: its entry's thing slots (0.135 C4), from the entries the world
        // was seeded with, when the test gave it some.
        let runtime = replica::world_model::Kind {
            owner: "activity".into(),
            children: Default::default(),
            slots: thing_slots(&seeded_entries(w), activity),
            hands: None,
            fields: Default::default(),
        };
        assert!(
            rules
                .kinds
                .get(*activity)
                .is_none_or(|kind| kind == &runtime),
            "boot-activity does not collide with another kind"
        );
        rules.kinds.insert((*activity).to_owned(), runtime);
        rules
            .kinds
            .get_mut(*target)
            .expect("validated place")
            .children
            .insert(base.to_owned());
    }
    let prefix = import_eden::header(w.root, &rules).unwrap();
    let records = sim::log::recover(&std::fs::read(w.dir.join("log")).unwrap())
        .unwrap()
        .records;
    let first = records
        .iter()
        .find(|record| !sim::recorder::is_input(record))
        .expect("the served log has a part");
    let first = replica::effects::Part::read(first).expect("a non-input log record is a part");
    let path = PathBuf::from(replica::stream::header_path(&prefix))
        .with_file_name(replica::encode::to_hex(&first.header));
    let header = replica::effects::Header::read(
        &std::fs::read(w.dir.join("views").join(&path)).expect("the actual served header"),
    )
    .expect("a canonical served header");
    assert_eq!(
        header.hash().to_bytes(),
        first.header,
        "the header named by the part"
    );
    assert_eq!(
        replica::stream::header_path(&header),
        path.to_str().unwrap()
    );
    let mut copy = replica::apply::Replica::start(header.stored()).unwrap();
    for record in records {
        if sim::recorder::is_input(&record) {
            continue;
        }
        let part = replica::effects::Part::read(&record).expect("a non-input log record is a part");
        if !part.effects.is_empty() {
            copy.apply(&part).unwrap();
        }
    }
    (copy, rules)
}

fn committed_town(
    copy: &replica::apply::Replica,
    rules: replica::tree::Rules,
    ground: Id,
) -> sim::walk::town::Town {
    let next = copy.tree().to_state().next;
    sim::walk::town::Town::new(
        copy.tree().frozen(),
        ground,
        sim::links::Doors::new(copy.header().clone(), rules, next),
    )
    .unwrap()
}

/// The fixture's original leaf is building-local; its new creator parent is the owning room.
fn g1f_leaf_in_room(tree: &replica::tree::Tree, leaf: Id, room: Id) -> Spot {
    let leaf = tree.node(tree.handle(leaf).unwrap()).unwrap();
    let building = leaf.parent().unwrap();
    let pose = leaf.place().unwrap();
    assert_eq!(leaf.slot(), None);
    assert_eq!(
        pose.support,
        Support::Surface {
            surface: building,
            height: 0
        }
    );
    let room_to_building = sim::ground::scene::xform_to(
        tree,
        tree.handle(room).unwrap(),
        tree.handle(building).unwrap(),
    )
    .unwrap();
    // This authored room has no turn relative to its building; preserve the original leaf orientation exactly.
    assert_eq!(room_to_building.rot, Quat::IDENTITY);
    let position = sim::links::back(&room_to_building, pose.position).unwrap();
    assert_eq!(room_to_building.point(position).unwrap(), pose.position);
    assert_eq!(
        room_to_building.rot.then(pose.orientation).unwrap(),
        pose.orientation
    );
    Spot {
        slot: None,
        position,
        orientation: pose.orientation,
        support: Support::Surface {
            surface: room,
            height: 0,
        },
    }
}

#[test]
fn g1f_leaf_frame_roundtrip_matches_the_original_authored_aperture() {
    let im = import_eden::load(&testworld::generate(1, 0).unwrap().text).unwrap();
    let leaf = im.nodes["door-building-to-b"];
    let room = im.nodes["building/corridor"];
    let local = g1f_leaf_in_room(&im.tree, leaf, room);
    assert_eq!(local.position, Vec3::new(-100_000, 0, -550_000));
    assert_eq!(local.orientation, Quat::IDENTITY);
    assert_eq!(
        local.support,
        Support::Surface {
            surface: room,
            height: 0
        }
    );
    assert_eq!(local.slot, None);
    println!(
        "G1f canonical frame round-trip PASS: room-local [-100,0,-550] mm -> authored building-local [1000,3000,-550] mm; yaw 0; frame room/none; support Surface(room,0)"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn g1f_a2_doorway_commits_owned_metadata_and_removal_guards_the_last_way_out() {
    use replica::edit::{Edit, World};
    use replica::pose::{Frame, Pose};
    use sim::ground::scene::{F_DOORWAYS, F_OPEN_DOOR_LINK, F_SOLIDS};
    let d = scratch("g1f-door");
    let facts = testworld::generate(1, 0).unwrap().text;
    let im = import_eden::load(&facts).unwrap();
    let original = im.nodes["door-building-to-b"];
    let leaf = im.tree.node(im.tree.handle(original).unwrap()).unwrap();
    let old_link = replica::effects::read_id(&leaf.fields()[&F_OPEN_DOOR_LINK]).unwrap();
    let (_, [from, to], ..) = im.tree.link(old_link).unwrap();
    let owner = im.tree.node(im.tree.handle(from).unwrap()).unwrap();
    let Value::Array(rows) = &owner.fields()[&F_DOORWAYS] else {
        panic!("door rows")
    };
    let row = rows
        .iter()
        .find_map(|r| match r {
            Value::Array(r) if r.first() == Some(&old_link.to_value()) => Some(r.clone()),
            _ => None,
        })
        .unwrap();
    let number = |n| match row[n] {
        Value::Uint(v) => v as i64,
        Value::Nint(v) => -1 - v as i64,
        _ => panic!("door geometry"),
    };
    // Exact authored wall from testworld::building: (floor 1, [split,-cz-w], [cx1+w,-cz-w]).
    // Restore that complete original wall span, rather than inventing a blocker in the aperture.
    let wall = im.nodes["building"];
    let (left, right) = (
        -2_000,
        -2_000 + testworld::WALL + testworld::CORRIDOR_LENGTH,
    );
    let solid = |a: i64, b: i64| {
        Value::Array(
            [
                (a + b) / 2,
                number(3),
                (b - a) / 2,
                testworld::WALL / 2,
                0,
                testworld::STOREY,
                2 * testworld::STOREY,
                1,
                0,
            ]
            .into_iter()
            .map(int)
            .collect(),
        )
    };
    let closed_rows = vec![solid(left, right)];
    let open_rows = vec![
        solid(left, number(2) - number(5) / 2),
        solid(number(2) + number(5) / 2, right),
    ];
    let wall_node = im.tree.node(im.tree.handle(wall).unwrap()).unwrap();
    let restored =
        replica::edit::doorway_solids(&wall_node.fields()[&F_SOLIDS], &open_rows, &closed_rows)
            .expect("exact authored open wall rows");
    let w = seed(&d, &facts, 1, (-40, 30));
    let (c, actor) = creator(0xd1);
    static_creator(&w, c);
    let socket = d.join("w.sock");
    let served = serve_with(&w, &socket, None);
    served.line("listening ", 60);
    let (url, tokens) = gateway(&socket, &[actor]).await;
    let mut creator = sign_in(&url, &tokens[0]).await;
    let (initial, _) = served_copy(&w);
    assert!(initial.tree().handle(original).is_some());
    assert_eq!(initial.tree().link(old_link).unwrap().1, [from, to]);
    let (removed, _) = send(
        &mut creator,
        edit_batch_intent(
            &w,
            actor,
            1,
            initial.version(),
            vec![
                Op::Remove {
                    node: Ref::Node(original),
                },
                Op::Set {
                    node: Ref::Node(wall),
                    field: F_SOLIDS,
                    to: restored.clone(),
                },
            ],
        ),
    )
    .await;
    assert_eq!(removed.kind, 1, "original door removal: {removed:?}");
    let (closed, rules) = served_copy(&w);
    assert!(
        closed.tree().link(old_link).is_none(),
        "removing the leaf retires its owned passage"
    );
    let floor = im.nodes["building/floor-1"];
    let who = Id::new(Scope([0xdd; 16]), 1).unwrap();
    let start = Vec3::new(5 * M, 3 * M, -3 * M);
    let goal = Vec3::new(-5 * M, 3 * M, 3 * M);
    let mut town = committed_town(&closed, rules.clone(), w.ground);
    let body = town.surfaces[&floor]
        .place(
            who,
            Frame {
                node: floor,
                slot: None,
            },
            start,
            Quat::IDENTITY,
        )
        .unwrap();
    assert!(
        town.view().plan(&body, floor, goal).is_err(),
        "the missing door closes the actual committed map"
    );
    let mut fields = leaf.fields().clone();
    fields.remove(&F_OPEN_DOOR_LINK);
    let pose = leaf.place().unwrap();
    let leaf_at = g1f_leaf_in_room(&im.tree, original, from);
    let ops = vec![
        Op::Place {
            name: 1,
            kind: leaf.kind().clone(),
            parent: Ref::Node(from),
            at: leaf_at,
            audience: Audience::Everyone,
            fields,
        },
        Op::Doorway {
            name: 2,
            door: Ref::New(1),
            from: Ref::Node(from),
            to: Ref::Node(to),
            at: [number(2), number(3)],
            yaw: number(4),
            width: number(5),
            height: number(6),
            wall: Ref::Node(wall),
            closed: closed_rows.clone(),
            open: open_rows.clone(),
        },
    ];
    let bytes = edit_batch_intent(&w, actor, 2, removed.version, ops);
    replica::intent_decode::decode(&bytes)
        .expect("the actual strict gateway I2 decoder admits the doorway frame");
    let (placed, _) = send(&mut creator, bytes).await;
    assert_eq!(
        placed.kind, 1,
        "door placement and link are one accepted batch: {placed:?}"
    );
    let (door, link) = (placed.names[&1], placed.names[&2]);
    let (mut open, rules) = served_copy(&w);
    assert_eq!(open.tree().link(link).unwrap().1, [from, to]);
    let new_leaf = open.tree().node(open.tree().handle(door).unwrap()).unwrap();
    assert_eq!(new_leaf.fields()[&F_OPEN_DOOR_LINK], link.to_value());
    assert_eq!(new_leaf.parent(), Some(from));
    assert_eq!(new_leaf.slot(), None);
    assert_eq!(new_leaf.place().unwrap().support, leaf_at.support);
    let committed_pose = sim::ground::scene::xform_to(
        open.tree(),
        open.tree().handle(door).unwrap(),
        open.tree().handle(wall).unwrap(),
    )
    .unwrap();
    assert_eq!(
        committed_pose.point(Vec3::ZERO).unwrap(),
        pose.position,
        "the committed leaf occupies the exact original authored wall aperture"
    );
    assert_eq!(committed_pose.rot, pose.orientation);
    println!(
        "G1f committed physical leaf matches building-local [1000,3000,-550] mm, yaw 0; room-local [-100,0,-550] mm, frame room/none, support Surface(room,0)"
    );
    let mut town = committed_town(&open, rules.clone(), w.ground);
    let legs = town
        .view()
        .plan(&body, floor, goal)
        .expect("a walk can use the committed doorway");
    assert!(
        legs.iter().any(|leg| leg.link == Some(link)),
        "the route crosses this exact new passage"
    );
    let edit = Edit {
        claim: None,
        intent: Id::new(Scope([0xde; 16]), 1).unwrap(),
        actor,
        planned: open.version(),
        ops: vec![Op::Remove {
            node: Ref::Node(door),
        }],
    };
    let checked = replica::edit::check(
        edit,
        &open,
        &World {
            creator: c,
            kinds: rules.kinds.clone(),
        },
    )
    .unwrap();
    let plan = sim::edit::plan(checked, &open, Some(w.ground)).unwrap();
    // A standing body fixture in the upper room, judged against the actual committed replica. No live body is moved.
    let inside = sim::edit::safety::Who {
        soul: who,
        body: who,
        pose: Pose {
            frame: Frame {
                node: floor,
                slot: None,
            },
            position: start,
            orientation: Quat::IDENTITY,
            support: Support::Surface {
                surface: floor,
                height: 0,
            },
        },
        has: sim::routes::HANDS | sim::routes::CLIMB,
        crossing: None,
    };
    let before = open.version();
    let refusal = sim::edit::commit(
        &mut open,
        &mut replica::ids::Minter::new(Scope([0xdf; 16])),
        &plan,
        &[inside],
        0,
    )
    .unwrap_err();
    assert_eq!(refusal.name, "edit.would-cut-off");
    assert_eq!(open.version(), before, "cutoff refusal is atomic");
    // A separately committed wall change must not be overwritten by a previously prepared removal or its inverse.
    let open_wall = open
        .tree()
        .node(open.tree().handle(wall).unwrap())
        .unwrap()
        .fields()[&F_SOLIDS]
        .clone();
    let Value::Array(mut changed_wall) = open_wall.clone() else {
        panic!("wall rows")
    };
    let row = changed_wall
        .iter_mut()
        .find(|row| **row == open_rows[0])
        .unwrap();
    let Value::Array(row) = row else {
        panic!("solid row")
    };
    let x = match row[0] {
        Value::Uint(x) => x as i64,
        Value::Nint(x) => -1 - x as i64,
        _ => panic!("x"),
    };
    row[0] = int(x + 1);
    let (changed, _) = send(
        &mut creator,
        edit_intent(
            &w,
            actor,
            3,
            placed.version,
            Op::Set {
                node: Ref::Node(wall),
                field: F_SOLIDS,
                to: Value::Array(changed_wall),
            },
        ),
    )
    .await;
    assert_eq!(
        changed.kind, 1,
        "a separate legal wall edit commits: {changed:?}"
    );
    let (mut changed_copy, _) = served_copy(&w);
    let before_stale = changed_copy.version();
    let stale = sim::edit::commit(
        &mut changed_copy,
        &mut replica::ids::Minter::new(Scope([0xdf; 16])),
        &plan,
        &[],
        0,
    )
    .unwrap_err();
    assert_eq!(stale.name, "edit.stale");
    assert_eq!(changed_copy.version(), before_stale);
    let (incompatible, _) = send(
        &mut creator,
        edit_intent(
            &w,
            actor,
            4,
            changed.version,
            Op::Remove {
                node: Ref::Node(door),
            },
        ),
    )
    .await;
    assert_eq!(
        (incompatible.kind, incompatible.reason.as_str()),
        (2, "edit.doorway-wall-changed")
    );
    let (fixed, _) = send(
        &mut creator,
        edit_intent(
            &w,
            actor,
            5,
            incompatible.version,
            Op::Set {
                node: Ref::Node(wall),
                field: F_SOLIDS,
                to: open_wall,
            },
        ),
    )
    .await;
    assert_eq!(fixed.kind, 1);
    let (retired, _) = send(
        &mut creator,
        edit_intent(
            &w,
            actor,
            6,
            fixed.version,
            Op::Remove {
                node: Ref::Node(door),
            },
        ),
    )
    .await;
    assert_eq!(
        retired.kind, 1,
        "nobody upstairs in the live world: {retired:?}"
    );
    let (closed, rules) = served_copy(&w);
    assert!(closed.tree().link(link).is_none());
    assert!(closed.tree().handle(door).is_none());
    let wall_after = closed
        .tree()
        .node(closed.tree().handle(wall).unwrap())
        .unwrap();
    assert_eq!(
        wall_after.fields()[&F_SOLIDS],
        restored,
        "only the owned patch is restored; all unrelated solids remain byte-identical"
    );
    for other in ["door-building-narrow", "door-building-to-c"] {
        let leaf = closed
            .tree()
            .node(closed.tree().handle(im.nodes[other]).unwrap())
            .unwrap();
        let link = replica::effects::read_id(&leaf.fields()[&F_OPEN_DOOR_LINK]).unwrap();
        assert!(
            closed.tree().link(link).is_some(),
            "another door's passage remains intact"
        );
    }
    let owner = closed
        .tree()
        .node(closed.tree().handle(from).unwrap())
        .unwrap();
    assert!(
        !matches!(&owner.fields()[&F_DOORWAYS], Value::Array(rows) if rows.iter().any(|r| matches!(r, Value::Array(row) if row.first() == Some(&link.to_value()))))
    );
    let mut town = committed_town(&closed, rules, w.ground);
    assert!(town.view().plan(&body, floor, goal).is_err());
    println!(
        "G1f A2 original removal {:?}; new doorway receipt {:?}; exact new passage used by committed-map route; cutoff {}; cleanup receipt {:?}",
        removed.entries, placed.entries, refusal.name, retired.entries
    );
}

/// A Soul's walk to (x, z) µm, on the world's socket (I1's framing).
fn walk(s: &mut UnixStream, w: &Seeded, body: Id, sequence: u64, x: i64, z: i64) {
    let i = Intent {
        actor: Actor::Soul(body),
        verb: Name::new("eden:walk").unwrap(),
        target: Some(Target::Node(w.ground)),
        parameters: BTreeMap::from([(1, Value::Array(vec![int(x), int(0), int(z)]))]),
        sequence,
        basis: basis(w.root.scope(), 0),
        expiry: answers::now() + 120_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    let bytes = encode(&i.to_value()).unwrap();
    s.write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
        .unwrap();
    s.write_all(&bytes).unwrap();
}

/// An answer: its kind (1 a receipt, 2 a refusal), reason and the world's version.
#[derive(Debug)]
struct Got {
    kind: u64,
    reason: String,
    version: u64,
    names: BTreeMap<u64, Id>,
    entries: Vec<u64>,
}

fn read_answer(v: &Value) -> Got {
    let Value::Map(f) = v else { panic!("a frame") };
    let Some(Value::Map(a)) = f.get(&2) else {
        panic!("an answer")
    };
    let version = match f.get(&1) {
        Some(Value::Array(a)) => match a.get(3) {
            Some(Value::Uint(s)) => *s,
            _ => panic!("a version"),
        },
        _ => panic!(
            "versionless answer: kind {:?}, reason {:?}",
            a.get(&3),
            a.get(&4)
        ),
    };
    Got {
        kind: match a.get(&3) {
            Some(Value::Uint(n)) => *n,
            _ => panic!("a kind"),
        },
        reason: match a.get(&4) {
            Some(Value::Text(t)) => t.as_str().to_owned(),
            _ => String::new(),
        },
        version,
        names: match a.get(&6) {
            Some(Value::Map(names)) => names
                .iter()
                .map(|(n, id)| (*n, replica::effects::read_id(id).unwrap()))
                .collect(),
            _ => BTreeMap::new(),
        },
        entries: match a.get(&5) {
            Some(Value::Array(rows)) => rows
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

/// The next answer on the world's socket.
fn socket_answer(s: &mut UnixStream) -> Got {
    let mut len = [0u8; 4];
    s.read_exact(&mut len).expect("an answer");
    let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
    s.read_exact(&mut frame).expect("an answer");
    read_answer(&decode(&frame).expect("a frame").value)
}

/// The next answer on the world's socket that ends an intent: a walk long enough to run past its tick is first
/// answered accepted (kind 3), then at its end.
fn socket_end(s: &mut UnixStream) -> Got {
    loop {
        let got = socket_answer(s);
        if got.kind != 3 {
            return got;
        }
    }
}

fn connect_socket(socket: &Path) -> UnixStream {
    let end = Instant::now() + Duration::from_secs(60);
    loop {
        match UnixStream::connect(socket) {
            Ok(s) => return s,
            Err(_) if Instant::now() < end => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => panic!("the socket: {e}"),
        }
    }
}

async fn next(ws: &mut Ws) -> Value {
    loop {
        let m = tokio::time::timeout(Duration::from_secs(30), ws.next())
            .await
            .expect("an answer within 30 s")
            .expect("the socket is open")
            .expect("a message");
        if let Message::Binary(b) = m {
            return decode(&b).unwrap().value;
        }
    }
}

async fn put(ws: &mut Ws, bytes: Vec<u8>) {
    ws.send(Message::Binary(bytes.into())).await.unwrap();
}

/// A gateway in this process, linked to the world's socket, with a token for each creator: its socket's URL and the
/// tokens.
async fn gateway(socket: &Path, creators: &[Actor]) -> (String, Vec<Token>) {
    let mut tokens = Tokens::default();
    let mut out = Vec::new();
    for &c in creators {
        let token = Token::issue(Grant::Actor(c)).unwrap();
        tokens.add(Grant::Actor(c), token.hash());
        out.push(token);
    }
    let log: Log = Arc::new(|_: &str| {});
    let gw = Gateway::with_receipts(tokens, BUILD.to_vec(), log, Receipts::off());
    tokio::spawn(world_link::run(gw.clone(), socket.to_owned()));
    let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}{}", tcp.local_addr().unwrap(), socket::PATH);
    tokio::spawn(axum::serve(tcp, socket::router(gw.clone())).into_future());
    let end = Instant::now() + Duration::from_secs(60);
    while !gw.link.up() {
        assert!(Instant::now() < end, "the gateway links to the world");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    (url, out)
}

async fn sign_in(url: &str, token: &Token) -> Ws {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    let hello = Hello {
        protocol: PROTOCOL,
        build: BUILD.to_vec(),
        refused: None,
        other: None,
    };
    put(&mut ws, hello.to_bytes().unwrap()).await;
    next(&mut ws).await;
    let sign_in = BTreeMap::from([(1, Value::Text(Name::new(token.reveal()).unwrap()))]);
    put(&mut ws, encode(&Value::Map(sign_in)).unwrap()).await;
    let Value::Map(o) = next(&mut ws).await else {
        panic!("an outcome")
    };
    assert_eq!(
        o.get(&4),
        Some(&Value::Text(Name::new(resume::STARTED).unwrap()))
    );
    ws
}

/// Sends one edit through the gateway: its answer and how long it took.
async fn send(ws: &mut Ws, bytes: Vec<u8>) -> (Got, Duration) {
    let t = Instant::now();
    put(ws, bytes).await;
    let got = read_answer(&next(ws).await);
    (got, t.elapsed())
}

/// `bytes` sent, and its act's own answer: a Soul's act that starts a form or a move is first answered in progress
/// (kind 3, C20) in the tick it starts (#4133, W11 #4087), and its receipt or refusal follows.
async fn send_ended(ws: &mut Ws, bytes: Vec<u8>) -> Got {
    put(ws, bytes).await;
    loop {
        let got = read_answer(&next(ws).await);
        if got.kind != 3 {
            return got;
        }
    }
}

fn creator(n: u8) -> (Id, Actor) {
    let id = Id::new(Scope([n; 16]), 1).unwrap();
    (id, Actor::Creator(id))
}

/// R17 (0.133): a world whose store does not answer at the start listens with no creator known. The record's own
/// creator's edit is refused `edit.not-the-creator` meanwhile (closed, never open), and accepted once the store
/// answers, with no restart.
#[tokio::test(flavor = "multi_thread")]
async fn r17_an_edit_while_the_creator_waits_for_the_store_is_refused_then_accepted() {
    let d = scratch("r17-creator");
    let w = seed(
        &d,
        &testworld::generate(1, 0).expect("the test world").text,
        1,
        (-40, 30),
    );
    let bucket = d.join("bucket");
    let (c, creator) = creator(0xc0);
    record(&bucket, &w, c);
    // Out of reach: a file where the folder store's folder was.
    let away = d.join("bucket.away");
    std::fs::rename(&bucket, &away).unwrap();
    std::fs::write(&bucket, b"").unwrap();
    let socket = d.join("s");
    let s = serve(&w, &socket, &bucket);
    assert_eq!(s.line("creator: ", 60), "creator: none");
    s.line("listening ", 60);
    let (url, tokens) = gateway(&socket, &[creator]).await;
    let mut ws = sign_in(&url, &tokens[0]).await;
    let (got, _) = send(
        &mut ws,
        edit_intent(&w, creator, 1, 0, wall(&w, -30 * M, 30 * M)),
    )
    .await;
    println!("R17: the creator's edit while its record waits: {got:?}");
    assert_eq!((got.kind, got.reason.as_str()), (2, "edit.not-the-creator"));
    // The store answers: the creator's thread reads the record, and the same edit commits.
    std::fs::remove_file(&bucket).unwrap();
    std::fs::rename(&away, &bucket).unwrap();
    assert_eq!(
        s.line("creator: ", 120),
        format!("creator: {}", principal_text(c))
    );
    let (got, _) = send(
        &mut ws,
        edit_intent(&w, creator, 2, got.version, wall(&w, -30 * M, 30 * M)),
    )
    .await;
    println!("R17: the creator's edit once the store answers: {got:?}");
    assert_eq!(got.kind, 1, "the creator's wall commits: {got:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn g1e_a1_the_worlds_record_names_its_one_creator() {
    let d = scratch("g1e");
    let w = seed(
        &d,
        &testworld::generate(1, 0).expect("the test world").text,
        1,
        (-40, 30),
    );
    let bucket = d.join("bucket");
    let ((c, creator), (stale, other)) = (creator(0xc0), creator(0xc1));
    static_creator(&w, stale); // Directory authority must override this stale standalone metadata.
    record(&bucket, &w, c);
    let socket = d.join("s");
    let s = serve(&w, &socket, &bucket);
    let named = s.line("creator: ", 60);
    println!("A1: {named}");
    assert_eq!(named, format!("creator: {}", principal_text(c)));
    s.line("listening ", 60);
    let (url, tokens) = gateway(&socket, &[creator, other]).await;
    let mut theirs = sign_in(&url, &tokens[1]).await;
    let (got, _) = send(
        &mut theirs,
        edit_intent(&w, other, 1, 0, wall(&w, -30 * M, 30 * M)),
    )
    .await;
    println!("A1: another creator's edit: {got:?}");
    assert_eq!((got.kind, got.reason.as_str()), (2, "edit.not-the-creator"));
    let mut ws = sign_in(&url, &tokens[0]).await;
    let (got, _) = send(
        &mut ws,
        edit_intent(&w, creator, 1, got.version, wall(&w, -30 * M, 30 * M)),
    )
    .await;
    println!("A1: the record's creator's edit: {got:?}");
    assert_eq!(got.kind, 1, "the creator's wall commits: {got:?}");
    std::fs::remove_file(bucket.join(NameRecord::key("g1e")))
        .expect("revoke the test world's creator");
    assert_eq!(
        s.line("creator: ", 60),
        "creator: none",
        "the live directory reader observes revocation"
    );
    for (socket, actor) in [(&mut ws, creator), (&mut theirs, other)] {
        let (refused, _) = send(
            socket,
            edit_intent(&w, actor, 2, got.version, wall(&w, -25 * M, 30 * M)),
        )
        .await;
        assert_eq!(
            (refused.kind, refused.reason.as_str()),
            (2, "edit.not-the-creator"),
            "neither the revoked creator nor stale metadata may edit"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn g7b_standalone_metadata_creator_still_edits_without_a_directory() {
    let d = scratch("g7b-standalone");
    let w = seed(&d, &testworld::generate(1, 0).unwrap().text, 1, (-40, 30));
    let (id, actor) = creator(0xc2);
    static_creator(&w, id);
    let socket = d.join("s");
    let s = serve_with(&w, &socket, None);
    s.line("listening ", 60);
    let (url, tokens) = gateway(&socket, &[actor]).await;
    let mut ws = sign_in(&url, &tokens[0]).await;
    let (got, _) = send(
        &mut ws,
        edit_intent(&w, actor, 1, 0, wall(&w, -30 * M, 30 * M)),
    )
    .await;
    assert_eq!(
        got.kind, 1,
        "the explicit standalone creator's wall commits: {got:?}"
    );
}

/// #3923: BUILDSAFE on a served world, in CI (N2's test world, no Eden facts): a wall where a Soul stands, once its
/// first act has born it, is refused `edit.would-bury` by the record's creator, and the same wall beside it commits.
#[tokio::test(flavor = "multi_thread")]
async fn g1e_buildsafe_refuses_a_wall_on_a_standing_soul_on_the_test_world() {
    let d = scratch("g1e-buildsafe");
    let w = seed(&d, &testworld::generate(1, 0).unwrap().text, 1, (-40, 30));
    let bucket = d.join("bucket");
    let (c, creator) = creator(0xc0);
    record(&bucket, &w, c);
    let socket = d.join("s");
    let s = serve(&w, &socket, &bucket);
    s.line("listening ", 60);
    // No Soul stands in a world until it acts (C3): the Soul's walk births its body and ends where it stands.
    let mut souls = connect_socket(&socket);
    souls
        .set_read_timeout(Some(Duration::from_secs(60)))
        .unwrap();
    let (sx, sz) = (-37 * M, 30 * M);
    walk(&mut souls, &w, w.souls[0], 1, sx, sz);
    let got = socket_end(&mut souls);
    assert_eq!(got.kind, 1, "the Soul's walk ends: {got:?}");
    let (url, tokens) = gateway(&socket, &[creator]).await;
    let mut ws = sign_in(&url, &tokens[0]).await;
    let (got, _) = send(&mut ws, edit_intent(&w, creator, 1, 0, wall(&w, sx, sz))).await;
    println!("a wall where the Soul stands: {got:?}");
    assert_eq!((got.kind, got.reason.as_str()), (2, "edit.would-bury"));
    let (got, _) = send(
        &mut ws,
        edit_intent(&w, creator, 2, got.version, wall(&w, -30 * M, 30 * M)),
    )
    .await;
    assert_eq!(got.kind, 1, "a wall where no Soul stands commits: {got:?}");
}

/// The Souls' row on Eden: 21 places 2 m apart along x from (x0, z0) m, each clear for 8 m to the north, and the walls'
/// places east of the row (x0 + 44 to x0 + 50 m), all on the open ground.
/// The facts the G1f and K18d served tests build on, and the id of the chair whose kind and fields a creator copies:
/// Eden's (`EDEN_FACTS`, its cabin chair; run with `--release`, as a building's whole-ground rebuild of Eden takes
/// about 15 s in a debug build, past an act's 10 s), else N2's test world with one Eden chair on the square, as the
/// export writes it (`core:chair`, loaded as `eden:chair` to find its entry), so CI runs them without Eden.
fn seat_world() -> (String, &'static str) {
    if let Ok(path) = std::env::var("EDEN_FACTS") {
        return (std::fs::read_to_string(path).unwrap(), "e_0fc49dc9");
    }
    let mut f = json::parse(&testworld::generate(1, 0).unwrap().text).unwrap();
    let json::Value::Obj(top) = &mut f else {
        panic!("facts")
    };
    for (k, v) in top.iter_mut() {
        match (k.as_str(), v) {
            ("kinds", json::Value::Arr(a)) => a.push(
                json::parse(&format!(
                    r#"{{"ref": "core-chair@1", "hash": "{}", "name": "core:chair", "form": "point", "layer": "solid",
                        "door": false, "mesh": false, "slots": 1}}"#,
                    replica::encode::to_hex(&replica::ids::sha256(b"souls/testworld/core-chair@1"))
                ))
                .unwrap(),
            ),
            ("things", json::Value::Arr(a)) => a.push(
                json::parse(
                    r#"{"id": "fixture-chair", "def": "core-chair@1", "ref": "core-chair@1", "parent": null,
                        "pose": [25000, 0, 25000, 0], "scale_ppm": 1000000, "name": "a chair on the square",
                        "solids": [[-160, -150, 22, 22, 0, 0, 430, 0, 0], [160, -150, 22, 22, 0, 0, 430, 0, 0],
                                   [-160, 150, 22, 22, 0, 0, 430, 0, 0], [160, 150, 22, 22, 0, 0, 430, 0, 0],
                                   [-200, -190, 20, 20, 0, 465, 915, 0, 0], [200, -190, 20, 20, 0, 465, 915, 0, 0]],
                        "slots": [{"n": 1, "id": "seat", "kind": "seat", "at": [0, 470, 20], "yaw": 0,
                                   "capacity": 1}]}"#,
                )
                .unwrap(),
            ),
            _ => {}
        }
    }
    (f.to_json(), "fixture-chair")
}

fn clear_row(text: &str) -> (i64, i64) {
    let im = import_eden::load(text).expect("Eden loads");
    let ground = im.nodes["ground"];
    let root = im.nodes["world"];
    let header = import_eden::header(root, &im.rules).unwrap();
    let next = im.tree.to_state().next;
    let doors = sim::links::Doors::new(header, im.rules, next);
    let town = sim::walk::town::Town::new(im.tree, ground, doors).expect("the town");
    let surface = &town.surfaces[&ground];
    let frame = replica::pose::Frame {
        node: ground,
        slot: None,
    };
    let id = Id::new(Scope([0x77; 16]), 1).unwrap();
    let ok = |x: i64, z: i64| {
        surface
            .place(id, frame, Vec3::new(x * M, 0, z * M), Quat::IDENTITY)
            .is_ok()
    };
    for r in 0..40 {
        for (dx, dz) in [
            (1, 0),
            (-1, 0),
            (0, 1),
            (0, -1),
            (1, 1),
            (-1, -1),
            (1, -1),
            (-1, 1),
        ] {
            let (x0, z0) = (dx * r * 10, dz * r * 10);
            if (0..=25).all(|k| (0..=8).all(|j| ok(x0 + 2 * k, z0 + j))) {
                return (x0, z0);
            }
        }
    }
    panic!("no clear row on Eden's open ground");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the exported Eden facts file"]
async fn g1e_a2_a3_eden_buildsafe_refuses_a_wall_on_a_soul_and_answers_fast() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../.local/import-eden/eden-2026.facts.json"
    );
    let text =
        std::fs::read_to_string(path).expect("run v2/tools/import-eden/export/export.ts first");
    let (x0, z0) = clear_row(&text);
    println!("the Souls' row on Eden from ({x0} m, {z0} m)");
    let d = scratch("g1e-eden");
    let w = seed(&d, &text, 21, (x0, z0));
    let bucket = d.join("bucket");
    let ((c, creator), (_, other)) = (creator(0xc0), creator(0xc1));
    record(&bucket, &w, c);
    let socket = d.join("s");
    let s = serve(&w, &socket, &bucket);
    println!("{}", s.line("creator: ", 120));
    s.line("listening ", 300);
    let (url, tokens) = gateway(&socket, &[creator, other]).await;
    let mut ws = sign_in(&url, &tokens[0]).await;
    let mut theirs = sign_in(&url, &tokens[1]).await;

    // No Soul stands in a world until it acts (C3, #3367): the 21st walks to the row's east end first, which births
    // its body there; then the 20 walkers set off north, 8 m each.
    let mut souls = connect_socket(&socket);
    souls
        .set_read_timeout(Some(Duration::from_secs(60)))
        .unwrap();
    let stander = w.souls[20];
    let (sx, sz) = ((x0 + 40) * M, z0 * M);
    walk(&mut souls, &w, stander, 1, sx, sz);
    let got = socket_end(&mut souls);
    assert_eq!(
        got.kind, 1,
        "the 21st Soul's walk to its place ends: {got:?}"
    );
    for (k, &body) in w.souls.iter().enumerate().take(20) {
        let x = (x0 + 2 * k as i64) * M;
        walk(&mut souls, &w, body, 1, x, (z0 + 8) * M);
    }
    tokio::time::sleep(Duration::from_millis(500)).await;

    // The path an edit takes without G2's guard, for comparison: another creator's edits, refused by the checker
    // before any plan.
    let mut path = Vec::new();
    for k in 0..8 {
        let (got, t) = send(
            &mut theirs,
            edit_intent(&w, other, 1 + k, 0, wall(&w, sx, sz)),
        )
        .await;
        assert_eq!(got.reason, "edit.not-the-creator");
        path.push(t);
    }
    path.sort();
    println!(
        "A3: the path alone (8 edits refused before a plan): p50 {:.1} ms",
        path[path.len() / 2].as_secs_f64() * 1000.0
    );

    // A2: a wall where the 21st Soul stands is refused by BUILDSAFE's name.
    let mut sequence = 1;
    let (got, first) = send(
        &mut ws,
        edit_intent(&w, creator, sequence, 0, wall(&w, sx, sz)),
    )
    .await;
    println!(
        "A2: a wall where a Soul stands: {got:?} in {} ms",
        first.as_millis()
    );
    assert_eq!((got.kind, got.reason.as_str()), (2, "edit.would-bury"));
    let mut version = got.version;

    // A3: walls east of the row, beside the walkers, each timed through the gateway, then the wall on the Soul again.
    let mut times = Vec::new();
    for i in 0..12 {
        sequence += 1;
        let (x, z) = ((x0 + 44 + 2 * (i % 4)) * M, (z0 + 2 * (i / 4)) * M);
        let (got, t) = send(
            &mut ws,
            edit_intent(&w, creator, sequence, version, wall(&w, x, z)),
        )
        .await;
        assert_eq!(got.kind, 1, "a wall where no Soul is commits: {got:?}");
        version = got.version;
        times.push(t);
        sequence += 1;
        let (got, t) = send(
            &mut ws,
            edit_intent(&w, creator, sequence, version, wall(&w, sx, sz)),
        )
        .await;
        assert_eq!(
            (got.kind, got.reason.as_str()),
            (2, "edit.would-bury"),
            "{got:?}"
        );
        times.push(t);
    }
    times.sort();
    let ms = |d: &Duration| d.as_secs_f64() * 1000.0;
    let (p50, p90, most) = (
        ms(&times[times.len() / 2]),
        ms(&times[times.len() * 9 / 10]),
        ms(times.last().unwrap()),
    );
    println!(
        "A3: {} edits beside 20 walkers through the gateway: p50 {p50:.1} ms, p90 {p90:.1} ms, longest {most:.1} ms",
        times.len()
    );

    // The 21st walks away north; then the same wall commits.
    walk(&mut souls, &w, stander, 2, sx, sz + 6 * M);
    // Walks answer at their ends: all 21, the 21st's among them.
    for _ in 0..21 {
        let got = socket_end(&mut souls);
        assert_eq!(got.kind, 1, "a walk ends: {got:?}");
    }
    sequence += 1;
    let (got, _) = send(
        &mut ws,
        edit_intent(&w, creator, sequence, version, wall(&w, sx, sz)),
    )
    .await;
    println!("A2: the same wall, the Soul gone: {got:?}");
    assert_eq!(
        got.kind, 1,
        "the same wall commits once no Soul stands there: {got:?}"
    );
    // A3's 200 ms bar is read from the printed numbers on a quiet machine (#3157): on a loaded laptop the path alone
    // (two ticks and the log's sync) passes it before any plan.
}

/// G1f A1: an actual creator edit registers the declared seat before its receipt, and removal is safe and complete.
#[tokio::test(flavor = "multi_thread")]
async fn g1f_a1_committed_seat_is_usable_and_occupied_removal_is_refused() {
    let (text, chair) = seat_world();
    let im = import_eden::load(&text).unwrap();
    let source = im
        .tree
        .node(im.tree.handle(im.nodes[chair]).unwrap())
        .unwrap();
    let kind = source.kind().clone();
    let fields = source.fields().clone();
    let (x, z) = clear_row(&text);
    let d = scratch("g1f-seat");
    let entries = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let w = seed_entries(&d, &text, 1, (x, z), Some(&entries));
    let (c, actor) = creator(0xcf);
    static_creator(&w, c);
    let socket = d.join("s");
    let served = serve_with(&w, &socket, None);
    served.line("listening ", 120);
    let (url, tokens) = gateway(&socket, &[actor, Actor::Soul(w.souls[0])]).await;
    let mut creator = sign_in(&url, &tokens[0]).await;
    let mut soul = sign_in(&url, &tokens[1]).await;
    let op = Op::Place {
        name: 1,
        kind,
        parent: Ref::Node(w.ground),
        at: Spot {
            slot: None,
            position: Vec3::new((x + 1) * M, 0, z * M - 509_000),
            orientation: Quat::IDENTITY,
            support: Support::Surface {
                surface: w.ground,
                height: 0,
            },
        },
        audience: Audience::Everyone,
        fields,
    };
    let (placed, _) = send(&mut creator, edit_intent(&w, actor, 1, 0, op)).await;
    assert_eq!(placed.kind, 1, "new chair commits: {placed:?}");
    let chair = placed.names[&1];
    let ask = |sequence, verb: &str, target: Option<Id>| {
        encode(
            &Intent {
                actor: Actor::Soul(w.souls[0]),
                verb: Name::new(verb).unwrap(),
                target: target.map(Target::Node),
                parameters: BTreeMap::new(),
                sequence,
                basis: basis(w.root.scope(), placed.version),
                expiry: i64::MAX,
                resources: Vec::new(),
                fallbacks: Vec::new(),
                replaces: None,
                body: None,
                reflex: false,
            }
            .to_value(),
        )
        .unwrap()
    };
    let sat = send_ended(&mut soul, ask(1, "eden:sit", Some(chair))).await;
    println!(
        "G1f placed receipt {:?}; sat receipt {:?}",
        placed.entries, sat.entries
    );
    assert_eq!(sat.kind, 1, "new seat is usable immediately: {sat:?}");
    let log = std::fs::read(w.dir.join("log")).unwrap();
    let seated = sim::log::recover(&log)
        .unwrap()
        .records
        .iter()
        .filter_map(|r| {
            let Value::Map(m) = decode(r).ok()?.value else {
                return None;
            };
            let Value::Array(rows) = m.get(&answers::BODIES)? else {
                return None;
            };
            rows.iter()
                .filter_map(worldd::bodies::read_row)
                .find(|(_, p, _)| {
                    p.frame.node == chair && p.frame.slot == Some(1) && p.support == Support::Slot
                })
        })
        .next_back();
    assert!(
        seated.is_some(),
        "the actual body occupies the new seat's exact slot"
    );
    let (metadata, _) = send(
        &mut creator,
        edit_intent(
            &w,
            actor,
            2,
            sat.version,
            Op::Set {
                node: Ref::Node(w.ground),
                field: 99,
                to: Value::Uint(1),
            },
        ),
    )
    .await;
    assert_eq!(
        metadata.kind, 1,
        "safe ancestor metadata does not change the occupied seat: {metadata:?}"
    );
    let remove = || Op::Remove {
        node: Ref::Node(chair),
    };
    let (blocked, _) = send(
        &mut creator,
        edit_intent(&w, actor, 3, metadata.version, remove()),
    )
    .await;
    assert_eq!((blocked.kind, blocked.reason.as_str()), (2, "edit.in-use"));
    let rose = send_ended(&mut soul, ask(2, "eden:rise", None)).await;
    assert_eq!(rose.kind, 1, "the Soul rises: {rose:?}");
    let (removed, _) = send(
        &mut creator,
        edit_intent(&w, actor, 4, rose.version, remove()),
    )
    .await;
    assert_eq!(
        removed.kind, 1,
        "unoccupied seat removal commits: {removed:?}"
    );
    let gone = send_ended(&mut soul, ask(3, "eden:sit", Some(chair))).await;
    assert_eq!(gone.kind, 2, "a retired seat cannot take a body: {gone:?}");
    println!(
        "G1f occupied removal: {}; rise receipt {:?}; removal receipt {:?}; retired seat: {}",
        blocked.reason, rose.entries, removed.entries, gone.reason
    );
}

#[path = "edit_served/k18d.rs"]
mod k18d;

/// The kind names of the content entries (`souls-entry/1`) under `dir`, read as `worldd seed --entries` reads them.
fn entry_kinds(dir: &Path) -> std::collections::BTreeSet<String> {
    let mut out = std::collections::BTreeSet::new();
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(entry_kinds(&p));
        } else if p.extension().is_some_and(|x| x == "json")
            && let Ok(v) = json::parse(&std::fs::read_to_string(&p).unwrap_or_default())
            && let Some(k) = v.get("kind").and_then(json::Value::str)
        {
            out.insert(k.to_owned());
        }
    }
    out
}

/// #3697: a creator's own kind stands as its record's bounds say, through the one loader. A hedge defined by the
/// creator, placed across a Soul's way, commits; the Soul's real walk past it ends at its goal; on the served log
/// (replayed whole) the hedge holds its solids and the committed ground has no room for a body inside it. Placed where a Soul
/// stands it is refused `edit.would-bury`, as g1e's boot wall is (both need BUILDSAFE's served bury check).
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the exported Eden facts file (EDEN_FACTS)"]
async fn p3697_a_creator_kind_buries_no_soul_and_souls_walk_round_it() {
    use replica::kinds::defined;
    let text = std::fs::read_to_string(std::env::var("EDEN_FACTS").expect("EDEN_FACTS")).unwrap();
    let (x0, z0) = clear_row(&text);
    let d = scratch("k3697");
    // With today's content entries, so a boot thing's forms run beside the creator's (gap 2).
    let entries = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let w = seed_entries(&d, &text, 2, (x0, z0), Some(&entries));
    let bucket = d.join("bucket");
    let (c, creator) = creator(0xc0);
    record(&bucket, &w, c);
    let socket = d.join("s");
    let s = serve(&w, &socket, &bucket);
    s.line("listening ", 300);
    let (url, tokens) = gateway(&socket, &[creator]).await;
    let mut ws = sign_in(&url, &tokens[0]).await;
    // The Souls' socket, as g1e's: their bodies stand in the world, and the edit checker holds them.
    let mut souls = connect_socket(&socket);
    souls
        .set_read_timeout(Some(Duration::from_secs(60)))
        .unwrap();
    // Since C3 a seeded Soul has a body only once it acts: each walks to where it stands, and its end is read.
    for (k, &body) in w.souls.iter().enumerate() {
        walk(&mut souls, &w, body, 1, (x0 + 2 * k as i64) * M, z0 * M);
        let got = socket_end(&mut souls);
        assert_eq!(got.kind, 1, "Soul {k} stands: {got:?}");
    }
    let at = |x: i64, z: i64, parent: Id| Spot {
        slot: None,
        position: Vec3::new(x, 0, z),
        orientation: Quat::IDENTITY,
        support: if parent == w.ground {
            Support::Surface {
                surface: w.ground,
                height: 0,
            }
        } else {
            Support::None
        },
    };

    // The creator defines a hedge: 6 m along x, 2.5 m tall, 0.4 m deep.
    let record = r#"{"format":"souls-entry/1","kind":"garden:hedge","owner":"thing","geometry":{"bounds_mm":[6000,2500,400]},"text":{"name":"hedge"}}"#;
    let full = defined::read(record.as_bytes(), &|_| false).unwrap().full;
    let define = Op::Place {
        name: 1,
        kind: Name::new(&defined::kind().0).unwrap(),
        parent: Ref::Node(w.root),
        at: at(0, 0, w.root),
        audience: Audience::Everyone,
        fields: BTreeMap::from([(defined::ENTRY, Value::Bytes(record.as_bytes().to_vec()))]),
    };
    let (got, _) = send(&mut ws, edit_intent(&w, creator, 1, 0, define)).await;
    assert_eq!(got.kind, 1, "the definition commits: {got:?}");
    // The open ground is the terrain: a thing stands at the ground's height where it is put.
    let (copy, _) = served_copy(&w);
    let terrain = sim::ground::scene::Terrain::of(copy.tree(), w.ground).unwrap();
    let height = |x: i64, z: i64| {
        terrain
            .as_ref()
            .and_then(|t| t.height_at(x, z))
            .unwrap_or(0)
    };
    println!(
        "the ground's height where the Souls stand: {} mm",
        height(x0 * M, z0 * M) / 1000
    );
    let hedge = |x: i64, z: i64| Op::Place {
        name: 1,
        kind: Name::new(&full).unwrap(),
        parent: Ref::Node(w.ground),
        at: Spot {
            position: Vec3::new(x, height(x, z), z),
            ..at(x, z, w.ground)
        },
        audience: Audience::Everyone,
        fields: BTreeMap::new(),
    };

    // Across the second Soul's way north: it commits, and the Soul's walk past it ends at its goal.
    let (wx, hz, goal) = ((x0 + 2) * M, (z0 + 3) * M, (z0 + 6) * M);
    let (got, _) = send(
        &mut ws,
        edit_intent(&w, creator, 2, got.version, hedge(wx, hz)),
    )
    .await;
    assert_eq!(got.kind, 1, "the hedge across the way commits: {got:?}");
    let version = got.version;
    walk(&mut souls, &w, w.souls[1], 2, wx, goal);
    let got = socket_end(&mut souls);
    println!("the second Soul's walk past the hedge: {got:?}");
    assert_eq!(got.kind, 1, "the walk ends at its goal: {got:?}");

    // The served log replays whole (a replica learns the kind from it); the hedge holds its solids; the route round.
    let (copy, rules) = served_copy(&w);
    let t = copy.tree();
    let placed = t
        .children(t.handle(w.ground).unwrap())
        .unwrap()
        .iter()
        .filter_map(|h| t.node(*h))
        .find(|n| n.kind().as_str() == full)
        .expect("the hedge on the ground");
    assert!(
        placed.fields().contains_key(&import_eden::F_SOLIDS),
        "it stands as its kind's bounds say"
    );
    let town = committed_town(&copy, rules, w.ground);
    let frame = replica::pose::Frame {
        node: w.ground,
        slot: None,
    };
    let stand = |k: u64, x: i64, z: i64| {
        town.surfaces[&w.ground]
            .place(
                Id::new(Scope([0xdd; 16]), k).unwrap(),
                frame,
                Vec3::new(x, 0, z),
                Quat::IDENTITY,
            )
            .is_ok()
    };
    println!(
        "the committed ground: inside the hedge {}, a metre in front of it {}",
        stand(1, wx, hz),
        stand(2, wx, hz - M)
    );
    assert!(
        !stand(1, wx, hz),
        "no body stands inside the hedge: walkers go round it"
    );
    assert!(
        stand(2, wx, hz - M),
        "a metre in front of it is open ground"
    );
    // On the first Soul, where it stands: refused by BUILDSAFE's name, as a boot thing would be.
    let (got, _) = send(
        &mut ws,
        edit_intent(&w, creator, 4, version, hedge(x0 * M, z0 * M)),
    )
    .await;
    println!("a creator's hedge where a Soul stands: {got:?}");
    assert_eq!((got.kind, got.reason.as_str()), (2, "edit.would-bury"));

    // Gap 2: a Soul runs a form the creator's kind defines, as it runs a content entry's, through the one loader.
    let bell = r#"{"format":"souls-entry/1","kind":"garden:bell","owner":"thing","state":{"rung":{"n":1,"type":"bool","default":false,"audience":{"rule":"everyone"}}},"geometry":{"bounds_mm":[300,400,300]},"forms":{"ring":{"who":"anyone","starts":"act","needs":[{"need":"state","field":"rung","is":false}],"effects":[{"change":"set","field":"rung","to":true,"event":"rang"}]}},"text":{"name":"bell"}}"#;
    let bell_full = defined::read(bell.as_bytes(), &|_| false).unwrap().full;
    let define_bell = Op::Place {
        name: 1,
        kind: Name::new(&defined::kind().0).unwrap(),
        parent: Ref::Node(w.root),
        at: at(0, 0, w.root),
        audience: Audience::Everyone,
        fields: BTreeMap::from([(defined::ENTRY, Value::Bytes(bell.as_bytes().to_vec()))]),
    };
    let (got, _) = send(&mut ws, edit_intent(&w, creator, 5, version, define_bell)).await;
    assert_eq!(got.kind, 1, "the bell's definition commits: {got:?}");
    let (bx, bz) = ((x0 - 1) * M, z0 * M);
    let place_bell = Op::Place {
        name: 1,
        kind: Name::new(&bell_full).unwrap(),
        parent: Ref::Node(w.ground),
        at: Spot {
            position: Vec3::new(bx, height(bx, bz), bz),
            ..at(bx, bz, w.ground)
        },
        audience: Audience::Everyone,
        fields: BTreeMap::new(),
    };
    let (got, _) = send(
        &mut ws,
        edit_intent(&w, creator, 6, got.version, place_bell),
    )
    .await;
    assert_eq!(
        got.kind, 1,
        "the bell is placed beside the first Soul: {got:?}"
    );
    let bell_id = got.names[&1];
    let act = |s: &mut UnixStream, sequence: u64, verb: &str, target: Id| {
        let i = Intent {
            actor: Actor::Soul(w.souls[0]),
            verb: Name::new(verb).unwrap(),
            target: Some(Target::Node(target)),
            parameters: BTreeMap::new(),
            sequence,
            basis: basis(w.root.scope(), 0),
            expiry: answers::now() + 120_000_000,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
            reflex: false,
        };
        let bytes = encode(&i.to_value()).unwrap();
        s.write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
            .unwrap();
        s.write_all(&bytes).unwrap();
    };
    act(&mut souls, 2, "eden:ring", bell_id);
    let rang = socket_end(&mut souls);
    println!("the first Soul rings the creator's bell: {rang:?}");
    assert_eq!(rang.kind, 1, "the form runs to its receipt: {rang:?}");
    let (copy, _) = served_copy(&w);
    let t = copy.tree();
    let rung = t
        .node(t.handle(bell_id).unwrap())
        .unwrap()
        .fields()
        .get(&1)
        .cloned();
    println!("the bell's field rung on the served log: {rung:?}");
    assert!(
        matches!(rung, Some(Value::Uint(1))),
        "the form's effect set the field: {rung:?}"
    );
    // Refused by name exactly as a content kind's form is: a form the kind has not (on the bell and on a boot thing),
    // and the bell's own form whose need no longer holds.
    let kinds = entry_kinds(&entries);
    let mut todo = vec![t.root()];
    let mut boot = None;
    while let (None, Some(h)) = (boot, todo.pop()) {
        let n = t.node(h).unwrap();
        // A thing that stays put: one on a course (a punt) is refused first for where it is.
        if kinds.contains(import_eden::entry_name(n.kind().as_str(), n.fields()))
            && !n.fields().contains_key(&replica::schedule::F_COURSE)
        {
            boot = Some(n.id());
        }
        todo.extend(t.children(h).unwrap_or_default().iter().copied());
    }
    let boot = boot.expect("a boot thing with a content entry");
    act(&mut souls, 3, "eden:toll", bell_id);
    let creator_no = socket_end(&mut souls);
    act(&mut souls, 4, "eden:toll", boot);
    let boot_no = socket_end(&mut souls);
    act(&mut souls, 5, "eden:ring", bell_id);
    let again = socket_end(&mut souls);
    println!(
        "refused: toll on the bell {creator_no:?}; toll on a boot thing {boot_no:?}; ring again {again:?}"
    );
    assert_eq!(creator_no.kind, 2);
    assert_eq!(
        (creator_no.kind, creator_no.reason.as_str()),
        (boot_no.kind, boot_no.reason.as_str()),
        "an unknown form is refused by the same name"
    );
    // The form runner's path checks no form's `needs` for any kind, content or creator's (the Soul's own check
    // stops it before it is sent, as the client test shows): the same answer as a content form's.
    assert_eq!(again.kind, 1, "{again:?}");

    drop(s);
}

/// An undo or a redo (or a build's step), as souls-god sends it (#3694).
fn asked_intent(w: &Seeded, actor: Actor, sequence: u64, planned: u64, asked: &Asked) -> Vec<u8> {
    let i = Intent {
        actor,
        verb: Name::new(VERB).unwrap(),
        target: None,
        parameters: parameters_of(asked),
        sequence,
        basis: basis(w.root.scope(), planned),
        expiry: i64::MAX,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    encode(&i.to_value()).unwrap()
}

/// #3694 A1, A3: undo and redo step the served world's edit history through a real gateway, a build's step is one
/// batch of its history, and an undo that would bring a wall back onto a Soul is refused by BUILDSAFE's name.
#[tokio::test(flavor = "multi_thread")]
async fn g4_undo_and_redo_on_the_wire_and_buildsafe_refuses_an_undo_onto_a_soul() {
    let d = scratch("g4-undo");
    let w = seed(&d, &testworld::generate(1, 0).unwrap().text, 1, (-40, 30));
    let (id, creator) = creator(0xc3);
    static_creator(&w, id);
    let socket = d.join("s");
    let s = serve_with(&w, &socket, None);
    s.line("listening ", 60);
    let (url, tokens) = gateway(&socket, &[creator]).await;
    let mut ws = sign_in(&url, &tokens[0]).await;
    let (mut sequence, mut version) = (0, 0);
    let mut go = async |ws: &mut Ws, asked: Asked| {
        sequence += 1;
        let got = send(ws, asked_intent(&w, creator, sequence, version, &asked))
            .await
            .0;
        version = got.version;
        got
    };

    // Nothing to undo or redo yet.
    let got = go(&mut ws, Asked::Undo).await;
    assert_eq!((got.kind, got.reason.as_str()), (2, "undo.nothing"));
    let got = go(&mut ws, Asked::Redo).await;
    assert_eq!((got.kind, got.reason.as_str()), (2, "undo.nothing-to-redo"));

    // A build's step: one wall, kept as step "shell" of build "hut".
    let step = Some(("hut".to_owned(), "the shell".to_owned()));
    let got = go(&mut ws, Asked::Batch(vec![wall(&w, -30 * M, 30 * M)], step)).await;
    assert_eq!(got.kind, 1, "the step commits: {got:?}");
    let placed = got.names[&1];
    let got = go(&mut ws, Asked::Undo).await;
    println!("A1: undo of the step: {got:?}");
    assert_eq!(got.kind, 1, "the step is undone: {got:?}");
    let got = go(&mut ws, Asked::Redo).await;
    println!("A1: redo: {got:?}");
    assert_eq!(got.kind, 1, "and redone: {got:?}");
    // The redo gives the wall back with its id: removing it by that id commits.
    let got = go(
        &mut ws,
        Asked::Batch(
            vec![Op::Remove {
                node: Ref::Node(placed),
            }],
            None,
        ),
    )
    .await;
    assert_eq!(got.kind, 1, "the redone wall has its first id: {got:?}");

    // A3: the Soul walks to where the wall stood; undoing its removal would bury it, and is refused by name.
    let mut souls = connect_socket(&socket);
    walk(&mut souls, &w, w.souls[0], 1, -30 * M, 30 * M);
    souls
        .set_read_timeout(Some(Duration::from_secs(60)))
        .unwrap();
    assert_eq!(socket_end(&mut souls).kind, 1, "the walk ends");
    let got = go(&mut ws, Asked::Undo).await;
    println!("A3: undo onto the Soul: {got:?}");
    assert_eq!((got.kind, got.reason.as_str()), (2, "edit.would-bury"));
    // Refused, nothing changed: the Soul walks off and the same undo commits.
    walk(&mut souls, &w, w.souls[0], 2, -36 * M, 30 * M);
    assert_eq!(socket_end(&mut souls).kind, 1, "the walk ends");
    let got = go(&mut ws, Asked::Undo).await;
    assert_eq!(
        got.kind, 1,
        "the undo commits once the Soul is gone: {got:?}"
    );
}

/// #3958: a creator's move of a thing far off the open ground (100 km east), sent straight to the world with no
/// client check, is answered (refused by name or done), and the creator's next edit is answered too.
#[tokio::test(flavor = "multi_thread")]
async fn a_move_far_off_the_ground_is_answered_and_so_is_the_next_edit() {
    let d = scratch("far-move");
    let w = seed(&d, &testworld::generate(1, 0).unwrap().text, 1, (-40, 30));
    let bucket = d.join("bucket");
    let (c, creator) = creator(0xc0);
    record(&bucket, &w, c);
    let socket = d.join("s");
    let s = serve(&w, &socket, &bucket);
    s.line("listening ", 60);
    let (url, tokens) = gateway(&socket, &[creator]).await;
    let mut ws = sign_in(&url, &tokens[0]).await;
    let (placed, _) = send(
        &mut ws,
        edit_intent(&w, creator, 1, 0, wall(&w, -30 * M, 30 * M)),
    )
    .await;
    assert_eq!(placed.kind, 1, "the wall commits: {placed:?}");
    let far = Op::Move {
        node: Ref::Node(placed.names[&1]),
        at: Spot {
            slot: None,
            position: Vec3::new(100_000 * 1_000 * 1_000, 0, 0),
            orientation: Quat::IDENTITY,
            support: Support::None,
        },
    };
    let (moved, took) = send(&mut ws, edit_intent(&w, creator, 2, placed.version, far)).await;
    println!("#3958: the far move: {moved:?} in {took:?}");
    assert_eq!(
        (moved.kind, moved.reason.as_str()),
        (2, "edit.off-ground"),
        "the far move is refused by name, not timed out"
    );
    let (next, took) = send(
        &mut ws,
        edit_intent(&w, creator, 3, moved.version, wall(&w, -25 * M, 30 * M)),
    )
    .await;
    println!("#3958: the next edit: {next:?} in {took:?}");
    assert_eq!(next.kind, 1, "the next edit commits: {next:?}");
}

// --- B20 (#3356, 0.135 A1): a running world enforces joined-part building -------------------------------------------

/// N2's test world with a rack bay at its build site, its slots numbered as the bay's entry numbers them (the facts
/// give a kind its slots by the things that have them), and the folder of entries: the four construction kinds, the
/// body, and on the bay a form that stands an upright in its first upright slot, a Soul's act that would leave a part
/// hanging. Returns the facts and the bay's slot numbers, by name.
fn yard_world(d: &Path) -> (String, BTreeMap<String, u64>) {
    yard_world_raised(d, 0)
}

/// [`yard_world`] on ground raised `raise_mm` everywhere: the open ground's terrain is flat tiles at that height
/// (as import-eden reads Eden's), and every thing at the world's root stands on it.
fn yard_world_raised(d: &Path, raise_mm: i64) -> (String, BTreeMap<String, u64>) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds");
    let entries = d.join("entries");
    std::fs::create_dir_all(&entries).unwrap();
    let mut texts = Vec::new();
    for f in std::fs::read_dir(root.join("construction")).unwrap() {
        let p = f.unwrap().path();
        let mut text = std::fs::read_to_string(&p).unwrap();
        if p.ends_with("rack_beam.json") {
            // A Soul may take a beam in its hand (0.135 A2's take from a hand), as a stone is taken.
            let mut e = json::parse(&text).unwrap();
            let form = json::parse(
                r#"{"take": {"who": "anyone", "starts": "act", "needs": [{"need": "hand", "free": true}],
                    "steps": [{"step": "take"}],
                    "effects": [{"change": "reparent", "what": "this", "into": "actor_hand", "event": "taken"}]}}"#,
            )
            .unwrap();
            if let json::Value::Obj(o) = &mut e {
                o.push(("forms".into(), form));
            }
            text = e.to_json();
        }
        if p.ends_with("rack_bay.json") {
            let mut e = json::parse(&text).unwrap();
            let form = json::parse(
                r#"{"stand_upright": {"who": "anyone", "steps": [],
                    "effects": [{"change": "create", "kind": "mars:rack_upright", "into": "upright_a",
                                 "event": "stood"}]}}"#,
            )
            .unwrap();
            if let json::Value::Obj(o) = &mut e {
                o.push(("forms".into(), form));
            }
            text = e.to_json();
        }
        std::fs::write(entries.join(p.file_name().unwrap()), &text).unwrap();
        texts.push((p.file_name().unwrap().to_string_lossy().into_owned(), text));
    }
    std::fs::copy(
        root.join("body/humanoid.json"),
        entries.join("humanoid.json"),
    )
    .unwrap();
    // The bay's slots as its entry numbers them.
    let mut bay =
        json::parse(&texts.iter().find(|(n, _)| n == "rack_bay.json").unwrap().1).unwrap();
    if let json::Value::Obj(o) = &mut bay {
        o.retain(|(k, _)| k != "forms");
    }
    let kind = replica::kinds::entry::entry_to_kind(&bay.to_json()).unwrap();
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
    let numbers: BTreeMap<String, u64> = slots.iter().map(|s| (s.1.clone(), s.0)).collect();
    let mut f = json::parse(&testworld::generate(1, 0).unwrap().text).unwrap();
    let json::Value::Obj(top) = &mut f else {
        panic!("facts")
    };
    let num = |v: i64| json::Value::Int(i128::from(v));
    for (k, v) in top.iter_mut() {
        match (k.as_str(), v) {
            ("kinds", json::Value::Arr(a)) => a.push(
                json::parse(&format!(
                    r#"{{"ref": "testworld-rack-bay@1", "hash": "{}", "name": "mars:rack_bay", "form": "point"}}"#,
                    replica::encode::to_hex(&replica::ids::sha256(b"souls/testworld/testworld-rack-bay@1"))
                ))
                .unwrap(),
            ),
            ("things", json::Value::Arr(a)) => {
                let slots = slots
                    .iter()
                    .map(|(n, id, at)| {
                        json::Value::Obj(vec![
                            ("n".into(), num(*n as i64)),
                            ("id".into(), json::Value::s(id)),
                            ("kind".into(), json::Value::s("bay")),
                            ("at".into(), json::Value::Arr(at.iter().map(|&v| num(v)).collect())),
                            ("yaw".into(), num(0)),
                            ("capacity".into(), num(1)),
                        ])
                    })
                    .collect();
                a.push(json::Value::Obj(vec![
                    ("id".into(), json::Value::s("site-bay")),
                    ("def".into(), json::Value::s("testworld-rack-bay@1")),
                    ("ref".into(), json::Value::s("testworld-rack-bay@1")),
                    ("parent".into(), json::Value::Null),
                    (
                        "pose".into(),
                        json::Value::Arr([65_000, 0, -24_000, 0].iter().map(|&v| num(v)).collect()),
                    ),
                    ("scale_ppm".into(), num(1_000_000)),
                    ("name".into(), json::Value::s("the site's rack bay")),
                    ("slots".into(), json::Value::Arr(slots)),
                ]));
            }
            _ => {}
        }
    }
    if raise_mm != 0 {
        let num = |v: i64| json::Value::Int(i128::from(v));
        for (k, v) in top.iter_mut() {
            if let ("things", json::Value::Arr(a)) = (k.as_str(), v) {
                for t in a.iter_mut() {
                    let json::Value::Obj(o) = t else { continue };
                    let root = o
                        .iter()
                        .any(|(k, v)| k == "parent" && matches!(v, json::Value::Null));
                    for (k, v) in o.iter_mut() {
                        if let ("pose", json::Value::Arr(p)) = (k.as_str(), v)
                            && root
                            && let Some(json::Value::Int(y)) = p.get(1).cloned()
                        {
                            p[1] = json::Value::Int(y + i128::from(raise_mm));
                        }
                    }
                }
            }
        }
        // Tiles 64 m a side, one cell each, flat at `raise_mm`: heights are four little-endian i32 mm, classes a byte.
        let mut bytes = Vec::new();
        for _ in 0..4 {
            bytes.extend((raise_mm as i32).to_le_bytes());
        }
        let b64 = |b: &[u8]| -> String {
            const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let mut out = String::new();
            for c in b.chunks(3) {
                let n = (u32::from(c[0]) << 16)
                    | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
                    | u32::from(*c.get(2).unwrap_or(&0));
                for k in 0..4 {
                    if k <= c.len() {
                        out.push(A[(n >> (18 - 6 * k) & 63) as usize] as char);
                    } else {
                        out.push('=');
                    }
                }
            }
            out
        };
        let mut tiles = Vec::new();
        for tx in -6..=6 {
            for tz in -6..=6 {
                tiles.push(json::Value::Obj(vec![
                    ("tx".into(), num(tx)),
                    ("tz".into(), num(tz)),
                    ("heights".into(), json::Value::s(&b64(&bytes))),
                    ("classes".into(), json::Value::s(&b64(&[0]))),
                ]));
            }
        }
        top.push((
            "ground".into(),
            json::Value::Obj(vec![
                ("tileM".into(), num(64)),
                ("tiles".into(), json::Value::Arr(tiles)),
            ]),
        ));
    }
    (f.to_json(), numbers)
}

/// An upright, as a creator places it: into the bay's slot `slot`, or on the open ground at (x, z) µm.
fn upright(
    w: &Seeded,
    kinds: &replica::tree::Rules,
    into: Option<(Id, u64)>,
    x: i64,
    z: i64,
) -> Op {
    let kind = kinds
        .kinds
        .keys()
        .find(|k| k.starts_with("mars:rack_upright@"))
        .expect("the upright's kind")
        .clone();
    let (parent, at) = match into {
        Some((bay, slot)) => (
            bay,
            Spot {
                slot: Some(slot),
                position: Vec3::new(0, 0, 0),
                orientation: Quat::IDENTITY,
                support: Support::Slot,
            },
        ),
        None => (
            w.ground,
            Spot {
                slot: None,
                position: Vec3::new(x, 0, z),
                orientation: Quat::IDENTITY,
                support: Support::Surface {
                    surface: w.ground,
                    height: 0,
                },
            },
        ),
    };
    Op::Place {
        name: 1,
        kind: Name::new(&kind).unwrap(),
        parent: Ref::Node(parent),
        at,
        audience: Audience::Everyone,
        fields: BTreeMap::new(),
    }
}

/// A Soul's act of form `verb` on `target`, on the world's socket.
fn act(s: &mut UnixStream, w: &Seeded, body: Id, sequence: u64, verb: &str, target: Id) {
    let i = Intent {
        actor: Actor::Soul(body),
        verb: Name::new(verb).unwrap(),
        target: Some(Target::Node(target)),
        parameters: BTreeMap::new(),
        sequence,
        basis: basis(w.root.scope(), 0),
        expiry: answers::now() + 120_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    let bytes = encode(&i.to_value()).unwrap();
    s.write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
        .unwrap();
    s.write_all(&bytes).unwrap();
}

/// 0.135 A2, review round seven: parts rest at the ground's height. On ground raised 1 m (terrain tiles, as Eden's),
/// a lone holder's lay-down rests frame A on the ground beside the bay, not 1 m under it; a retiring last holder out of
/// reach lays it flat where it stands, on its own base; and, with a Soul standing where it would lie, leaves it standing
/// on its base, with no jump.
#[test]
fn a2_parts_rest_at_the_grounds_height() {
    const RAISE: i64 = 1_000_000;
    let d = scratch("a2raised");
    let (facts, slots) = yard_world_raised(&d, RAISE / 1000);
    let w = seed_entries(&d, &facts, 4, (36, -20), Some(&d.join("entries")));
    let socket = d.join("s");
    let s = serve_with(&w, &socket, None);
    s.line("listening ", 120);
    let im = import_eden::load(&facts).unwrap();
    let (bay, fa) = (im.nodes["site-bay"], im.nodes["yard-frame-1"]);
    let g = w.ground;
    {
        let (copy, _) = served_copy(&w);
        let t = sim::ground::scene::Terrain::of(copy.tree(), g)
            .unwrap()
            .unwrap();
        assert_eq!(
            t.height_at(65_000_000, -24_000_000),
            Some(RAISE),
            "the bay's ground is raised"
        );
    }
    let mut hands: Vec<Hand> = w.souls.iter().map(|s| Hand::new(&socket, &w, *s)).collect();
    let both = |hands: &mut [Hand], (a, b): (usize, usize), pa: Vec3, pb: Vec3, what: &str| {
        hands[a].walk_to(g, pa);
        hands[b].walk_to(g, pb);
        let x = socket_end(&mut hands[a].s);
        let y = socket_end(&mut hands[b].s);
        assert_eq!((x.kind, y.kind), (1, 1), "{what}: {x:?} {y:?}");
    };
    let one = |hands: &mut [Hand], k: usize, p: Vec3, what: &str| {
        hands[k].walk_to(g, p);
        let x = socket_end(&mut hands[k].s);
        assert_eq!(x.kind, 1, "{what}: {x:?}");
    };
    let crew = |hands: &mut [Hand], (a, b): (usize, usize)| {
        let body = body_of(&w, w.souls[b]);
        let got = hands[a].act(
            "activity:offer",
            g,
            BTreeMap::from([
                (1, pinned_activity(&w, "mars:carry_activity")),
                (2, Value::Text(Name::new("mars:front").unwrap())),
                (3, Value::Array(vec![body.to_value()])),
            ]),
        );
        assert_eq!(got.kind, 1, "offered: {got:?}");
        let made = created_by(&w, &got.entries, "mars:carry_activity@");
        let got = hands[b].act("activity:accept", made, BTreeMap::new());
        assert_eq!(got.kind, 1, "accepted: {got:?}");
        made
    };
    let part = |p: Id| BTreeMap::from([(1, p.to_value())]);
    let ua = {
        let k = slots["upright_a"];
        let (copy, _) = served_copy(&w);
        let t = copy.tree();
        sim::ground::scene::slot_points(t, t.handle(bay).unwrap(), t.handle(g).unwrap())
            .unwrap()
            .into_iter()
            .find(|(n, _)| *n == k)
            .unwrap()
            .1
    };
    let ends = |at: Vec3| (v3(at.x, 0, at.z - 2_200_000), v3(at.x, 0, at.z + 2_200_000));
    // A crew of Souls `ab` takes frame A from where it lies, puts it in upright_a, and Soul `ab.0` lets go.
    let seat = |hands: &mut [Hand], ab: (usize, usize), what: &str| {
        let (p, q) = ends(where_is(&w, fa).2);
        both(hands, ab, p, q, what);
        let c = crew(hands, ab);
        assert_eq!(
            hands[ab.0].act("part:take", c, part(fa)).kind,
            1,
            "{what}: taken"
        );
        let (p, q) = ends(ua);
        both(hands, ab, p, q, what);
        let got = hands[ab.0].act(
            "part:put",
            c,
            BTreeMap::from([(1, bay.to_value()), (2, Value::Uint(slots["upright_a"]))]),
        );
        assert_eq!(got.kind, 1, "{what}: put: {got:?}");
        let got = hands[ab.0].act("activity:leave", c, BTreeMap::new());
        assert_eq!(got.kind, 1, "{what}: one lets go: {got:?}");
        c
    };
    let on_ground = |what: &str, mid: i64| {
        println!(
            "{what}: its middle {} mm above the raised ground",
            (mid - RAISE) / 1000
        );
        assert!(
            (RAISE..=RAISE + 120_000).contains(&mid),
            "{what}: on the raised ground, not in it or over it: middle {mid} µm"
        );
    };

    // A lone holder's lay-down.
    let c = seat(&mut hands, (0, 1), "frame A in");
    one(
        &mut hands,
        1,
        v3(ua.x, 0, ua.z + 1_200_000),
        "Soul 2 beside frame A",
    );
    let got = hands[1].act("part:unseat", c, part(fa));
    assert_eq!(got.kind, 1, "frame A laid down: {got:?}");
    assert_eq!(where_is(&w, fa).0, Some(g));
    let (_, mid, lying) = rest_of(&w, fa, 1_219);
    assert!(lying, "laid down");
    on_ground("laid down beside the bay", mid);
    assert_eq!(hands[1].act("activity:leave", c, BTreeMap::new()).kind, 1);

    // A retiring last holder out of reach: laid flat where it stands.
    seat(&mut hands, (0, 1), "frame A in again");
    one(
        &mut hands,
        1,
        v3(ua.x + 2_000_000, 0, ua.z),
        "Soul 2 2 m off",
    );
    hands[1].send_to(answers::LEAVE, None, BTreeMap::new());
    let got = socket_end(&mut hands[1].s);
    assert_eq!(got.kind, 1, "Soul 2 leaves the world: {got:?}");
    let why = whys_caused(&w, &got.entries, "souls:carry-set-down");
    assert!(
        why.contains(&(fa, "souls:holder-left-flat".into())),
        "{why:?}"
    );
    let (_, mid, lying) = rest_of(&w, fa, 1_219);
    assert!(lying, "laid flat");
    on_ground("laid flat where it stood", mid);

    // With Soul 4 standing where it would lie: left standing on its base.
    seat(&mut hands, (0, 2), "frame A in a third time");
    one(
        &mut hands,
        3,
        v3(ua.x + 1_000_000, 0, ua.z),
        "Soul 4 where frame A would lie",
    );
    one(
        &mut hands,
        2,
        v3(ua.x, 0, ua.z - 2_000_000),
        "Soul 3 2 m off",
    );
    hands[2].send_to(answers::LEAVE, None, BTreeMap::new());
    let got = socket_end(&mut hands[2].s);
    assert_eq!(got.kind, 1, "Soul 3 leaves the world: {got:?}");
    // Its set-down goes through the walkers' maps, which a Soul beside it moving holds back: Soul 4 walks off.
    one(
        &mut hands,
        3,
        v3(ua.x + 4_000_000, 0, ua.z),
        "Soul 4 walks off",
    );
    let why = whys_caused(&w, &got.entries, "souls:carry-set-down");
    assert!(
        why.contains(&(fa, "souls:holder-left-standing".into())),
        "{why:?}"
    );
    let (base, _, lying) = rest_of(&w, fa, 1_219);
    println!(
        "left standing: its base {} mm above the raised ground",
        (base - RAISE) / 1000
    );
    assert!(!lying, "standing");
    assert!(
        (base - RAISE).abs() <= 1_000,
        "on its base, with no jump: {base} µm"
    );
}

/// B20 A1 and A2 (#3356): a world served from N2's test world with its yard and a bay at the site reads the
/// construction kinds' joined-part rule as it starts (it prints the bays, standing parts and bearing parts it read),
/// and refuses, `support.none`, both a creator's edit that stands an upright alone in the bay and a Soul's act that
/// does the same; the same upright placed on the open ground commits.
#[tokio::test(flavor = "multi_thread")]
async fn b20_a_running_world_refuses_a_part_left_hanging() {
    let d = scratch("b20");
    let (facts, slots) = yard_world(&d);
    let slot = slots["upright_a"];
    let w = seed_entries(&d, &facts, 1, (62, -24), Some(&d.join("entries")));
    let bucket = d.join("bucket");
    let (c, creator) = creator(0xc0);
    record(&bucket, &w, c);
    let socket = d.join("s");
    let s = serve(&w, &socket, &bucket);
    let joined = s.line("joined parts: ", 120);
    println!("{joined}");
    assert_eq!(
        joined,
        "joined parts: bays [mars:rack_bay], standing [mars:rack_upright], bearing [mars:rack_beam]"
    );
    s.line("listening ", 120);
    let (_, rules) = served_copy(&w);
    let im = import_eden::load(&facts).unwrap();
    let bay = im.nodes["site-bay"];
    let (url, tokens) = gateway(&socket, &[creator]).await;
    let mut ws = sign_in(&url, &tokens[0]).await;
    let (got, _) = send(
        &mut ws,
        edit_intent(
            &w,
            creator,
            1,
            0,
            upright(&w, &rules, Some((bay, slot)), 0, 0),
        ),
    )
    .await;
    println!("a creator stands an upright alone in the bay: {got:?}");
    assert_eq!((got.kind, got.reason.as_str()), (2, "support.none"));
    let (got, _) = send(
        &mut ws,
        edit_intent(
            &w,
            creator,
            2,
            got.version,
            upright(&w, &rules, None, 60 * M, -20 * M),
        ),
    )
    .await;
    assert_eq!(
        got.kind, 1,
        "an upright on the open ground commits: {got:?}"
    );
    // No Soul stands until it acts (C3): its walk births it near the site, then its act on the bay.
    let mut souls = connect_socket(&socket);
    souls
        .set_read_timeout(Some(Duration::from_secs(60)))
        .unwrap();
    walk(&mut souls, &w, w.souls[0], 1, 63 * M, -24 * M);
    let got = socket_end(&mut souls);
    assert_eq!(got.kind, 1, "the Soul's walk ends: {got:?}");
    act(&mut souls, &w, w.souls[0], 2, "mars:stand_upright", bay);
    let got = socket_end(&mut souls);
    println!("a Soul's act stands an upright alone in the bay: {got:?}");
    assert_eq!((got.kind, got.reason.as_str()), (2, "support.none"));
}

/// #3956: a batch whose fields would outgrow what one log record holds is refused by name (`edit.too-large`) before
/// it reaches the world, and the world keeps answering: the edit after it commits. The field is set to 7 MB (under
/// the bulk limit, sent on the world's socket as the gateway hands on a bulk edit); each rows operation writes the
/// whole field again, so three of them in one batch come to 21 MB, over `replica::edit::WRITTEN_MOST`.
#[test]
fn an_oversize_rows_edit_is_refused_by_name_and_the_world_keeps_answering() {
    let d = scratch("rows-big");
    let w = seed(&d, &testworld::generate(1, 0).unwrap().text, 1, (-40, 30));
    let (id, actor) = creator(0xc3);
    static_creator(&w, id);
    let socket = d.join("s");
    let s = serve_with(&w, &socket, None);
    s.line("listening ", 60);
    let mut world = connect_socket(&socket);
    const FIELD: u64 = 90;
    let row = |k: u64, len: usize| {
        Value::Array(vec![
            Value::Uint(k),
            Value::Uint(0),
            Value::Bytes(vec![k as u8; len]),
        ])
    };
    let rows = |rows: Vec<Value>| Op::Rows {
        node: Ref::Node(w.ground),
        field: FIELD,
        rows,
    };
    // Each batch planned against the newest version it has seen: the ground's own changes make an older plan stale.
    let (mut sequence, mut planned) = (0, 0);
    let mut edit = |ops: Vec<Op>| loop {
        sequence += 1;
        let bytes = edit_batch_intent(&w, actor, sequence, planned, ops.clone());
        world
            .write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
            .unwrap();
        world.write_all(&bytes).unwrap();
        let got = socket_answer(&mut world);
        planned = planned.max(got.version);
        if got.reason != "edit.stale" {
            return got;
        }
    };
    let got = edit(vec![Op::Set {
        node: Ref::Node(w.ground),
        field: FIELD,
        to: Value::Array(vec![row(0, 7 << 20)]),
    }]);
    assert_eq!(got.kind, 1, "a 7 MB field of rows: {got:?}");
    let got = edit(vec![rows(Vec::new())]);
    assert_eq!((got.kind, got.reason.as_str()), (2, "edit.rows"), "no rows");
    let got = edit((1..4).map(|k| rows(vec![row(k, 64)])).collect());
    assert_eq!(
        (got.kind, got.reason.as_str()),
        (2, "edit.too-large"),
        "three writes of a 7 MB field in one batch"
    );
    let got = edit(vec![wall(&w, -30 * M, 30 * M)]);
    assert_eq!(got.kind, 1, "the world still answers and edits: {got:?}");
}

/// The 0.132 release check's gesture (#1960): a Soul's wave on its own body in a served world, three times. Its run
/// starts in the act's tick, its move (`souls:form-move`, the record the page draws the gesture from) starts in the same
/// tick, and its `done` receipt comes when the move ends, 1.2 s on (`wave`: 0.3 s to the contact, 0.9 s after): the
/// receipt never goes out before the move plays. World times from the log; the answers' wall times are printed.
#[test]
fn a_gestures_move_starts_in_its_acts_tick_and_its_receipt_comes_when_it_ends() {
    let d = scratch("gesture");
    let entries = d.join("entries");
    std::fs::create_dir_all(&entries).unwrap();
    let root =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../content/kinds/body/humanoid.json");
    std::fs::copy(root, entries.join("humanoid.json")).unwrap();
    let w = seed_entries(
        &d,
        &testworld::generate(1, 0).unwrap().text,
        1,
        (-40, 30),
        Some(&entries),
    );
    let socket = d.join("s");
    let s = serve_with(&w, &socket, None);
    s.line("listening ", 60);
    let mut souls = connect_socket(&socket);
    souls
        .set_read_timeout(Some(Duration::from_secs(60)))
        .unwrap();
    walk(&mut souls, &w, w.souls[0], 1, -37 * M, 30 * M);
    let got = socket_end(&mut souls);
    assert_eq!(got.kind, 1, "the Soul's walk births it: {got:?}");
    let (copy, _) = served_copy(&w);
    let t = copy.tree();
    let body = t
        .links_at(w.souls[0])
        .iter()
        .filter(|e| t.ty(e).as_str() == "souls:body-of")
        .find_map(|e| Some(t.link(e.link)?.1[0]))
        .expect("the Soul's body");
    for round in 0..3u64 {
        let i = Intent {
            actor: Actor::Soul(w.souls[0]),
            verb: Name::new("eden:wave").unwrap(),
            target: Some(Target::Node(body)),
            parameters: BTreeMap::new(),
            sequence: 2 + round,
            basis: basis(w.root.scope(), 0),
            expiry: answers::now() + 120_000_000,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
            reflex: false,
        };
        let bytes = encode(&i.to_value()).unwrap();
        let (sent, from) = (Instant::now(), answers::now());
        souls
            .write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
            .unwrap();
        souls.write_all(&bytes).unwrap();
        let mut kinds = Vec::new();
        loop {
            let got = socket_answer(&mut souls);
            kinds.push((got.kind, sent.elapsed().as_millis()));
            if got.kind != 3 {
                break;
            }
        }
        // The run's entries, in world time.
        let log = std::fs::read(w.dir.join("log")).unwrap();
        let mut at = BTreeMap::new();
        for rec in sim::log::recover(&log).unwrap().records {
            if sim::recorder::is_input(&rec) {
                continue;
            }
            for e in replica::effects::Part::read(&rec).unwrap().effects {
                for v in e.events.iter().flatten().filter(|_| e.envelope.at >= from) {
                    at.entry(v.name.as_str().to_owned())
                        .or_insert(e.envelope.at);
                }
            }
        }
        let (started, moved, ended) = (
            at["souls:form-started"],
            at["souls:form-move"],
            at["souls:form-ended"],
        );
        println!(
            "wave {round}: answers (kind, ms after the send) {kinds:?}; run started +{} ms, move +{} ms, ended +{} ms",
            (started - from) / 1000,
            (moved - from) / 1000,
            (ended - from) / 1000
        );
        assert_eq!(kinds.first().map(|k| k.0), Some(3), "accepted first");
        assert_eq!(kinds.last().map(|k| k.0), Some(1), "then done");
        assert!(
            moved - started <= 100_000,
            "the move starts within two ticks of the run"
        );
        assert_eq!(ended - moved, 1_200_000, "done when the move ends");
    }
}

/// One Soul's end of the world's socket (0.135 A2): its own connection, so two Souls' walks run at once and each
/// reads its own answers.
struct Hand {
    s: UnixStream,
    soul: Id,
    lineage: Scope,
    sequence: u64,
}

impl Hand {
    fn new(socket: &Path, w: &Seeded, soul: Id) -> Hand {
        let s = connect_socket(socket);
        s.set_read_timeout(Some(Duration::from_secs(90))).unwrap();
        Hand {
            s,
            soul,
            lineage: w.root.scope(),
            sequence: 0,
        }
    }

    fn send(&mut self, verb: &str, target: Id, parameters: BTreeMap<u64, Value>) {
        self.send_to(verb, Some(target), parameters);
    }

    fn send_to(&mut self, verb: &str, target: Option<Id>, parameters: BTreeMap<u64, Value>) {
        self.sequence += 1;
        let i = Intent {
            actor: Actor::Soul(self.soul),
            verb: Name::new(verb).unwrap(),
            target: target.map(Target::Node),
            parameters,
            sequence: self.sequence,
            basis: basis(self.lineage, 0),
            expiry: answers::now() + 120_000_000,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
            reflex: false,
        };
        let bytes = encode(&i.to_value()).unwrap();
        self.s
            .write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
            .unwrap();
        self.s.write_all(&bytes).unwrap();
    }

    fn act(&mut self, verb: &str, target: Id, parameters: BTreeMap<u64, Value>) -> Got {
        self.send(verb, target, parameters);
        socket_end(&mut self.s)
    }

    fn walk_to(&mut self, ground: Id, at: Vec3) {
        let p = BTreeMap::from([(1, Value::Array(vec![int(at.x), int(0), int(at.z)]))]);
        self.send("eden:walk", ground, p);
    }
}

/// Every part the served world has logged, in order.
fn logged(w: &Seeded) -> Vec<replica::effects::Part> {
    sim::log::recover(&std::fs::read(w.dir.join("log")).unwrap())
        .unwrap()
        .records
        .into_iter()
        .filter(|r| !sim::recorder::is_input(r))
        .map(|r| replica::effects::Part::read(&r).unwrap())
        .filter(|p| !p.effects.is_empty())
        .collect()
}

/// The node of a kind starting `prefix` created by the entries numbered `entries`.
fn created_by(w: &Seeded, entries: &[u64], prefix: &str) -> Id {
    use replica::effects::{Body, Change};
    for p in logged(w) {
        for e in p
            .effects
            .iter()
            .filter(|e| entries.contains(&e.envelope.sequence))
        {
            if let Body::Changes(cs) = &e.body {
                for c in cs {
                    if let Change::Create { node, kind, .. } = &c.change
                        && kind.as_str().starts_with(prefix)
                    {
                        return *node;
                    }
                }
            }
        }
    }
    panic!("no {prefix} created by {entries:?}")
}

/// The activity kind named `plain` as the world pins it, as an intent names it: its plain name and its hash's bytes.
fn pinned_activity(w: &Seeded, plain: &str) -> Value {
    let text = std::fs::read_to_string(w.dir.join("world.kinds")).unwrap();
    let full = text
        .lines()
        .filter_map(|l| l.strip_prefix("# souls-boot-activity "))
        .filter_map(|l| l.split_whitespace().nth(1))
        .find(|f| f.starts_with(&format!("{plain}@")))
        .unwrap_or_else(|| panic!("the world pins {plain}"));
    let hex = full.split_once('@').unwrap().1;
    Value::Array(vec![
        Value::Text(Name::new(plain).unwrap()),
        Value::Bytes(from_hex(hex).unwrap()),
    ])
}

/// What the served world holds now: `id`'s parent and slot, and its place in the open ground's frame (zero in a crew's
/// slot).
fn where_is(w: &Seeded, id: Id) -> (Option<Id>, Option<u64>, Vec3) {
    let (copy, _) = served_copy(w);
    let t = copy.tree();
    let h = t.handle(id).expect("the node");
    let n = t.node(h).unwrap();
    // A part in a crew's slot has no place of its own on the ground (the crew's node has no slot points).
    let at = sim::ground::scene::xform_to(t, h, t.handle(w.ground).unwrap())
        .map_or(Vec3::ZERO, |x| x.pos);
    (n.parent(), n.slot(), at)
}

/// The body a Soul's first intent gave it (C3), by its `souls:body-of` link.
fn body_of(w: &Seeded, soul: Id) -> Id {
    let (copy, _) = served_copy(w);
    let t = copy.tree();
    t.links_at(soul)
        .iter()
        .filter(|e| t.ty(e).as_str() == "souls:body-of")
        .find_map(|e| Some(t.link(e.link)?.1[0]))
        .expect("a body")
}

/// Where body `body` last stood, as the log's body rows have it (bodies are not written to the tree as they walk).
fn body_at(w: &Seeded, body: Id) -> Vec3 {
    let mut at = None;
    for p in logged(w) {
        if let Some(Value::Array(rows)) = p.rest.get(&answers::BODIES) {
            for (b, pose, _) in rows.iter().filter_map(worldd::bodies::read_row) {
                if b == body {
                    at = Some(pose.position);
                }
            }
        }
    }
    at.expect("a body row")
}

fn v3(x: i64, y: i64, z: i64) -> Vec3 {
    Vec3::new(x, y, z)
}

/// The `why` of each event named `event` written by the entries numbered `entries`, with the load it names.
fn whys(w: &Seeded, entries: &[u64], event: &str) -> Vec<(Id, String)> {
    logged(w)
        .iter()
        .flat_map(|p| p.effects.iter())
        .filter(|e| entries.contains(&e.envelope.sequence))
        .flat_map(|e| e.events.iter().flatten())
        .filter(|ev| ev.name.as_str() == event)
        .filter_map(|ev| match (ev.fields.get(&2), ev.fields.get(&3)) {
            (Some(load), Some(Value::Text(t))) => {
                Some((replica::effects::read_id(load).ok()?, t.as_str().to_owned()))
            }
            _ => None,
        })
        .collect()
}

/// The crews on part `id` (its children of the crew's kind) and how many of them are kept holds (B18's `F_KEPT`).
fn crews_on(w: &Seeded, id: Id) -> (usize, usize) {
    let (copy, _) = served_copy(w);
    let t = copy.tree();
    let crews: Vec<_> = t
        .children(t.handle(id).unwrap())
        .unwrap_or(&[])
        .iter()
        .filter_map(|h| t.node(*h))
        .filter(|n| n.kind().as_str().starts_with("mars:carry_activity@"))
        .collect();
    let kept = crews
        .iter()
        .filter(
            |n| matches!(n.fields().get(&sim::structure::F_KEPT), Some(Value::Uint(k)) if *k > 0),
        )
        .count();
    (crews.len(), kept)
}

/// As [`whys`], for every entry caused by the intent that wrote the entries numbered `entries` (a retire's set-down is
/// written after its answer, through the walkers' maps): waits up to 10 s for one.
fn whys_caused(w: &Seeded, entries: &[u64], event: &str) -> Vec<(Id, String)> {
    let cause = logged(w)
        .iter()
        .flat_map(|p| p.effects.iter())
        .find(|e| entries.contains(&e.envelope.sequence))
        .map(|e| e.envelope.cause);
    for _ in 0..50 {
        let all: Vec<u64> = logged(w)
            .iter()
            .flat_map(|p| p.effects.iter())
            .filter(|e| Some(e.envelope.cause) == cause)
            .map(|e| e.envelope.sequence)
            .collect();
        let found = whys(w, &all, event);
        if !found.is_empty() {
            return found;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Vec::new()
}

/// The links of B18's joint type at `id`, as the served world holds them.
fn joints_at(w: &Seeded, id: Id) -> usize {
    let (copy, _) = served_copy(w);
    let t = copy.tree();
    t.links_at(id)
        .iter()
        .filter(|e| t.ty(e).as_str().contains("joint"))
        .count()
}

/// Where `id` rests in the open ground's frame: its origin's height, its middle's height (`up_mm` up its own y), and
/// whether it lies (its own y axis level).
fn rest_of(w: &Seeded, id: Id, up_mm: i64) -> (i64, i64, bool) {
    let (copy, _) = served_copy(w);
    let t = copy.tree();
    let x = sim::ground::scene::xform_to(t, t.handle(id).unwrap(), t.handle(w.ground).unwrap())
        .unwrap();
    let up = x.rot.rotate(Vec3::new(0, 1_000_000, 0)).unwrap();
    let mid = x.rot.rotate(Vec3::new(0, up_mm * 1000, 0)).unwrap();
    (x.pos.y, x.pos.y + mid.y, up.y.abs() < 100_000)
}

/// 0.135 A2 (#3340's B19, by intents): Souls take, put and unseat rack parts in a running world, each step its own
/// intent on its own connection, on N2's test world with a bay at the build site and the construction entries (B17).
/// A body plays in one activity at a time, and a crew of two starts it.
///
/// - Two Souls (crew A) take frame A off the stand, carry it 25 m and put it in `upright_a`, where they hold it; a walk
///   to its column ends clear of it, the ground rebuilt with the seating. Crew B, asked into the same slot while crew A's
///   frame is still on its way in, is refused `slot.occupied` at its track's end: frame B stays in its crew's slot and
///   goes back along a track to where its set-in started; its carriers having walked off meanwhile, its carry breaks
///   off there and it is set down (never pulled after them). Taken up again, from 3 m it may not be put
///   (`part.out-of-reach`); from beside `upright_b` it is. Its other carrier leaving the world (which leaves crew B
///   too), Soul 4, alone between the frames with frame B unbraced, may not let go (`support.none`) but lays it down:
///   not into the bay, not into a wall the creator put outside it, but on a side. It leaves; a crew puts frame B back.
/// - Refused before anything moves: a take by a conversation (`part.not-a-crew`), its lift (`not-a-carry`, C4), a
///   take of a frame riding another crew
///   (`part.held-by-another`), of a beam 25 m away (`part.out-of-reach`), of a beam in a Soul's hand (`part.in-a-hand`),
///   frame B into frame A's slot joined to frame A (`connectors-do-not-mate`).
/// - Crew C puts beam 1 in `beam_low_l`. With a Soul inside the bay, beam 2 into `beam_low_r` would shut it in: refused
///   `edit.would-cut-off` at its commit, the beam left in crew C's slot; once the Soul has walked out, the same put
///   commits; while it goes in, Soul 3 may not leave crew C (`crew.setting-in`). Crew C then takes beam 2 out again (an
///   unseat) and carries it off; when Soul 3 leaves the world on the way, the carry breaks off, the beam is set down
///   where it was, and Soul 1 may leave the crew.
/// - Taking frame A out from under beam 1 is refused `support.none`, and nothing changes.
#[test]
fn a2_souls_take_put_and_unseat_rack_parts_by_intents() {
    const H: i64 = 1_200_000;
    let d = scratch("a2seat");
    let (facts, slots) = yard_world(&d);
    let w = seed_entries(&d, &facts, 7, (36, -20), Some(&d.join("entries")));
    let (creator_id, creator_actor) = creator(0xa2);
    static_creator(&w, creator_id);
    let socket = d.join("s");
    let s = serve_with(&w, &socket, None);
    s.line("listening ", 120);
    // The world's creator's edits, on a connection of its own, each planned on the newest version it has seen.
    let mut world = connect_socket(&socket);
    world
        .set_read_timeout(Some(Duration::from_secs(60)))
        .unwrap();
    let (mut edits, mut planned) = (0, 0);
    let mut creator_edit = |op: Op| loop {
        edits += 1;
        let bytes = edit_intent(&w, creator_actor, edits, planned, op.clone());
        world
            .write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
            .unwrap();
        world.write_all(&bytes).unwrap();
        let got = socket_answer(&mut world);
        planned = planned.max(got.version);
        if got.reason != "edit.stale" {
            return got;
        }
    };
    let im = import_eden::load(&facts).unwrap();
    let (bay, fa, fb, b1, b2) = (
        im.nodes["site-bay"],
        im.nodes["yard-frame-1"],
        im.nodes["yard-frame-2"],
        im.nodes["yard-beam-1"],
        im.nodes["yard-beam-2"],
    );
    let g = w.ground;
    let mut hands: Vec<Hand> = w.souls.iter().map(|s| Hand::new(&socket, &w, *s)).collect();
    let both = |hands: &mut [Hand], (a, b): (usize, usize), pa: Vec3, pb: Vec3, what: &str| {
        hands[a].walk_to(g, pa);
        hands[b].walk_to(g, pb);
        let x = socket_end(&mut hands[a].s);
        let y = socket_end(&mut hands[b].s);
        assert_eq!((x.kind, y.kind), (1, 1), "{what}: {x:?} {y:?}");
    };
    let one = |hands: &mut [Hand], k: usize, p: Vec3, what: &str| {
        hands[k].walk_to(g, p);
        let x = socket_end(&mut hands[k].s);
        assert_eq!(x.kind, 1, "{what}: {x:?}");
    };
    let role = |r: &str| Value::Text(Name::new(r).unwrap());
    // An activity of `kind` on `place`: Soul `a` offers as `first`, Soul `b` accepts and it starts.
    let offer = |hands: &mut [Hand], (a, b): (usize, usize), kind: &str, first: &str, place: Id| {
        let body = body_of(&w, w.souls[b]);
        let got = hands[a].act(
            "activity:offer",
            place,
            BTreeMap::from([
                (1, pinned_activity(&w, kind)),
                (2, role(first)),
                (3, Value::Array(vec![body.to_value()])),
            ]),
        );
        assert_eq!(got.kind, 1, "offered: {got:?}");
        let made = created_by(&w, &got.entries, &format!("{kind}@"));
        let got = hands[b].act("activity:accept", made, BTreeMap::new());
        assert_eq!(got.kind, 1, "accepted: {got:?}");
        made
    };
    let crew = |hands: &mut [Hand], ab: (usize, usize), place: Id| {
        offer(hands, ab, "mars:carry_activity", "mars:front", place)
    };
    let leave =
        |hands: &mut [Hand], k: usize, c: Id| hands[k].act("activity:leave", c, BTreeMap::new());
    let part = |p: Id| BTreeMap::from([(1, p.to_value())]);
    let into = |slot: &str| BTreeMap::from([(1, bay.to_value()), (2, Value::Uint(slots[slot]))]);
    let slot_at = |slot: &str| {
        let k = slots[slot];
        let (copy, _) = served_copy(&w);
        let t = copy.tree();
        sim::ground::scene::slot_points(t, t.handle(bay).unwrap(), t.handle(g).unwrap())
            .unwrap()
            .into_iter()
            .find(|(n, _)| *n == k)
            .unwrap()
            .1
    };
    let across = |at: Vec3, dz: i64| (v3(at.x + H, 0, at.z + dz), v3(at.x - H, 0, at.z + dz));
    let along = |at: Vec3| (v3(at.x, 0, at.z + 2_200_000), v3(at.x, 0, at.z - 2_200_000));
    // A frame's carriers stand 2.2 m either side of it along z, clear of the stand, the beams and the other frame, so
    // they walk east side by side and keep their span (a carry whose carriers drift apart breaks off, C3).
    let ends = |at: Vec3, dx: i64| {
        (
            v3(at.x + dx, 0, at.z - 2_200_000),
            v3(at.x + dx, 0, at.z + 2_200_000),
        )
    };
    let refused = |got: &Got, name: &str, what: &str| {
        println!("{what}: {got:?}");
        assert_eq!((got.kind, got.reason.as_str()), (2, name), "{what}");
    };

    // Crews A (Souls 1, 2) and B (Souls 3, 4) each take a frame off the stand and carry it to the bay.
    let (p, q) = ends(where_is(&w, fa).2, 0);
    both(&mut hands, (0, 1), p, q, "crew A to frame A");
    let crew_a = crew(&mut hands, (0, 1), g);
    let got = hands[0].act("part:take", crew_a, part(fa));
    println!("crew A takes frame A off the stand: {got:?}");
    assert_eq!(got.kind, 1, "taken");
    assert_eq!(where_is(&w, fa).0, Some(crew_a), "frame A rides its crew");
    let (p, q) = ends(where_is(&w, fb).2, 0);
    both(&mut hands, (2, 3), p, q, "crew B to frame B");
    let crew_b = crew(&mut hands, (2, 3), g);
    assert_eq!(
        hands[2].act("part:take", crew_b, part(fb)).kind,
        1,
        "frame B taken"
    );
    let (ua, ub) = (slot_at("upright_a"), slot_at("upright_b"));
    let (p, q) = ends(ua, 0);
    both(&mut hands, (0, 1), p, q, "frame A to the bay");
    let (p, q) = ends(ua, -800_000);
    both(
        &mut hands,
        (2, 3),
        p,
        q,
        "frame B to the bay, 0.8 m short of upright_a",
    );
    // Both crews ask for upright_a; crew A's track is the shorter, so frame A is in when crew B's ends.
    hands[0].send("part:put", crew_a, into("upright_a"));
    hands[2].send("part:put", crew_b, into("upright_a"));
    let got = socket_end(&mut hands[0].s);
    println!("crew A puts frame A in upright_a: {got:?}");
    assert_eq!(got.kind, 1, "frame A in");
    let got = socket_end(&mut hands[2].s);
    refused(
        &got,
        "slot.occupied",
        "crew B into the same slot, at its track's end",
    );
    assert_eq!(where_is(&w, fa).0, Some(bay), "frame A in the bay");
    assert_eq!(where_is(&w, crew_a).0, Some(fa), "crew A holds frame A");
    assert_eq!(
        where_is(&w, fb).0,
        Some(crew_b),
        "frame B still rides crew B"
    );
    // Its node goes back along a track to where its set-in started; its carriers walk 2 m off meanwhile, so its
    // carry does not start again (it would pull the frame after them): it breaks off there, frame B set down.
    let (p, q) = ends(ua, -2_800_000);
    both(
        &mut hands,
        (2, 3),
        p,
        q,
        "crew B walks off while frame B comes back",
    );
    std::thread::sleep(Duration::from_secs(3));
    let (parent, _, laid) = where_is(&w, fb);
    println!(
        "frame B, its carriers gone off: set down at ({}, {}) mm",
        laid.x / 1000,
        laid.z / 1000
    );
    assert_eq!(parent, Some(g), "frame B set down where its set-in started");
    // Crew B takes it up again; from there upright_b is too far to put it in.
    let (p, q) = ends(laid, 0);
    both(&mut hands, (2, 3), p, q, "crew B back to frame B");
    let got = hands[2].act("part:take", crew_b, part(fb));
    assert_eq!(got.kind, 1, "frame B taken up again: {got:?}");
    let got = hands[0].act("part:take", crew_a, part(fb));
    refused(
        &got,
        "part.held-by-another",
        "crew A takes the frame riding crew B",
    );
    let got = hands[2].act("part:put", crew_b, into("upright_b"));
    refused(
        &got,
        "part.out-of-reach",
        "crew B puts frame B in upright_b from 3 m",
    );
    // The ground under frame A is rebuilt: a walk to its column ends clear of it.
    let column = v3(ua.x + 572_000, 0, ua.z);
    hands[1].walk_to(g, column);
    let got = socket_end(&mut hands[1].s);
    let at = body_at(&w, body_of(&w, w.souls[1]));
    let off = (i128::from(at.x - column.x).pow(2) + i128::from(at.z - column.z).pow(2)).isqrt();
    println!(
        "Soul 2 walks to frame A's column: {got:?}, ends {} mm from it",
        off / 1000
    );
    assert!(off > 100_000, "a walker goes round the seated frame");
    one(
        &mut hands,
        1,
        v3(ua.x + 3_000_000, 0, ua.z - 2_000_000),
        "Soul 2 stands clear",
    );
    let (p, q) = ends(ub, -800_000);
    both(&mut hands, (2, 3), p, q, "crew B along z");
    let (p, q) = ends(ub, 0);
    both(&mut hands, (2, 3), p, q, "crew B on to upright_b");
    let mut joined = into("upright_b");
    joined.insert(4, Value::Array(vec![fa.to_value()]));
    let got = hands[2].act("part:put", crew_b, joined);
    refused(&got, "connectors-do-not-mate", "frame B joined to frame A");
    let got = hands[2].act("part:put", crew_b, into("upright_b"));
    println!("crew B, its carry going on, puts frame B in upright_b: {got:?}");
    assert_eq!(got.kind, 1, "frame B in");
    assert_eq!(where_is(&w, fb).0, Some(bay));
    // Soul 3 leaves the world, and with it crew B (a retire leaves every activity). Soul 4, alone between the two
    // frames, holds frame B unbraced: it may not let go, so it lays frame B down (a lone holder's unseat). Out of the bay
    // is blocked by a wall the creator puts there, and into the bay is never taken: it lies on a side, clear of both.
    hands[2].send_to(answers::LEAVE, None, BTreeMap::new());
    let got = socket_end(&mut hands[2].s);
    assert_eq!(got.kind, 1, "Soul 3 leaves the world: {got:?}");
    one(
        &mut hands,
        3,
        v3(ub.x, 0, ub.z - 2_000_000),
        "Soul 4 2 m from frame B",
    );
    let got = hands[3].act("part:unseat", crew_b, part(fb));
    refused(
        &got,
        "part.out-of-reach",
        "Soul 4 lays frame B down from 2 m",
    );
    one(
        &mut hands,
        3,
        v3(ub.x, 0, ub.z - 1_200_000),
        "Soul 4 between the frames",
    );
    let mut walls = Vec::new();
    for (x, z, what) in [
        (ub.x, ub.z + 2_200_000, "outside frame B"),
        (ub.x + 1_000_000, ub.z, "between frame B and its +x side"),
        (ub.x - 1_000_000, ub.z, "between frame B and its -x side"),
    ] {
        let got = creator_edit(wall(&w, x, z));
        println!("the creator puts a wall {what}: {got:?}");
        assert_eq!(got.kind, 1, "a wall");
        walls.push(got.names[&1]);
    }
    let got = leave(&mut hands, 3, crew_b);
    refused(&got, "support.none", "Soul 4, alone, lets go of frame B");
    let got = hands[3].act("part:unseat", crew_b, part(fb));
    refused(
        &got,
        "laydown.no-room",
        "every way out for frame B passes through a wall",
    );
    for side in walls.drain(1..) {
        let got = creator_edit(Op::Remove {
            node: Ref::Node(side),
        });
        assert_eq!(got.kind, 1, "a side wall taken away: {got:?}");
    }
    let wall_id = walls[0];
    let got = hands[3].act("part:unseat", crew_b, part(fb));
    println!("Soul 4 lays frame B down beside the bay: {got:?}");
    assert_eq!(got.kind, 1, "frame B laid down");
    let (parent, _, laid) = where_is(&w, fb);
    println!(
        "frame B lies at ({}, {}) mm, its slot at ({}, {})",
        laid.x / 1000,
        laid.z / 1000,
        ub.x / 1000,
        ub.z / 1000
    );
    assert_eq!(parent, Some(g), "frame B on the ground");
    assert!(
        // Its foot is where it lies from: half its height off its middle, which is level with its slot.
        (laid.z - ub.z).abs() < 1_300_000 && (laid.x - ub.x).abs() > 1_500_000,
        "frame B on a side of its slot: not into the bay, not into the wall"
    );
    assert_eq!(leave(&mut hands, 3, crew_b).kind, 1, "Soul 4 leaves");
    let got = creator_edit(Op::Remove {
        node: Ref::Node(wall_id),
    });
    assert_eq!(got.kind, 1, "the wall taken away: {got:?}");
    // Crew B again (Souls 3, 4) takes it up and puts it back; Soul 3 lets go, Soul 4 holds it.
    let (p, q) = ends(laid, 0);
    both(&mut hands, (2, 3), p, q, "Souls 3 and 4 to frame B");
    let crew_b = crew(&mut hands, (2, 3), g);
    assert_eq!(
        hands[2].act("part:take", crew_b, part(fb)).kind,
        1,
        "frame B taken up"
    );
    let (p, q) = ends(ub, 0);
    both(&mut hands, (2, 3), p, q, "frame B back to upright_b");
    let got = hands[2].act("part:put", crew_b, into("upright_b"));
    assert_eq!(got.kind, 1, "frame B back in: {got:?}");
    assert_eq!(
        leave(&mut hands, 2, crew_b).kind,
        1,
        "Soul 3 lets go of frame B"
    );
    // Soul 4, frame B's last holder, leaves the world: frame B is set down as its retire's first step (laid beside
    // the bay, or where it stands when there is no room), never left hanging; a crew puts it back.
    // It stands 2 m off, out of reach for a lay-down beside the bay: frame B is laid flat where it stands.
    one(
        &mut hands,
        3,
        v3(ub.x + 2_000_000, 0, ub.z),
        "Soul 4 2 m from frame B",
    );
    hands[3].send_to(answers::LEAVE, None, BTreeMap::new());
    let got = socket_end(&mut hands[3].s);
    println!("Soul 4, frame B's last holder, leaves the world: {got:?}");
    assert_eq!(got.kind, 1, "Soul 4 leaves the world");
    let why = whys_caused(&w, &got.entries, "souls:carry-set-down")
        .into_iter()
        .find(|(l, _)| *l == fb)
        .map(|(_, why)| why);
    let (parent, _, down) = where_is(&w, fb);
    let (up, middle) = {
        let (copy, _) = served_copy(&w);
        let t = copy.tree();
        let x =
            sim::ground::scene::xform_to(t, t.handle(fb).unwrap(), t.handle(g).unwrap()).unwrap();
        let up = x.rot.rotate(Vec3::new(0, 1_000_000, 0)).unwrap();
        let mid = x.rot.rotate(Vec3::new(0, 1_219_000, 0)).unwrap();
        (up, x.pos.y + mid.y)
    };
    println!(
        "frame B set down ({why:?}) at ({}, {}) mm, its middle {} mm up, its length {}",
        down.x / 1000,
        down.z / 1000,
        middle / 1000,
        if up.y.abs() < 100_000 {
            "lying"
        } else {
            "standing"
        }
    );
    assert_eq!(parent, Some(g), "frame B set down, not left hanging");
    assert_eq!(
        why.as_deref(),
        Some("souls:holder-left-flat"),
        "laid flat where it stood"
    );
    assert!(up.y.abs() < 100_000, "lying flat");
    assert!(
        (0..=120_000).contains(&middle),
        "on the ground, not in it: its middle {middle} µm up"
    );
    let (p, q) = ends(down, 0);
    both(&mut hands, (2, 3), p, q, "Souls 3 and 4 to frame B");
    let crew_b = crew(&mut hands, (2, 3), g);
    assert_eq!(
        hands[2].act("part:take", crew_b, part(fb)).kind,
        1,
        "frame B taken up"
    );
    let (p, q) = ends(ub, 0);
    both(&mut hands, (2, 3), p, q, "frame B back to upright_b");
    let got = hands[2].act("part:put", crew_b, into("upright_b"));
    assert_eq!(got.kind, 1, "frame B back in: {got:?}");
    assert_eq!(
        leave(&mut hands, 2, crew_b).kind,
        1,
        "Soul 3 lets go of frame B"
    );
    // Soul 1 lets go; Soul 2 holds frame A, Soul 4 frame B.
    assert_eq!(
        leave(&mut hands, 0, crew_a).kind,
        1,
        "Soul 1 lets go of frame A"
    );
    one(
        &mut hands,
        3,
        v3(ub.x - 3_000_000, 0, ub.z + 2_000_000),
        "Soul 4 stands clear",
    );

    // Refused before anything moves.
    let talk = offer(&mut hands, (0, 2), "souls:conversation", "souls:opener", g);
    let got = hands[0].act("part:take", talk, part(fa));
    refused(&got, "part.not-a-crew", "a conversation takes a frame");
    let got = hands[0].act("carry:lift", talk, part(b1));
    refused(&got, "not-a-carry", "a conversation lifts a beam");
    assert_eq!(leave(&mut hands, 0, talk).kind, 1);
    assert_eq!(leave(&mut hands, 2, talk).kind, 1);
    let (p, q) = across(ua, 0);
    both(&mut hands, (0, 2), p, q, "Souls 1 and 3 to frame A");
    let crew_c = crew(&mut hands, (0, 2), g);
    let got = hands[0].act("part:take", crew_c, part(b1));
    refused(&got, "part.out-of-reach", "crew C takes a beam 25 m away");
    {
        // Soul 4 takes beam 3 in its hand; crew C may not take it from there.
        let b3 = im.nodes["yard-beam-3"];
        let at = where_is(&w, b3).2;
        one(
            &mut hands,
            3,
            v3(at.x + 700_000, 0, at.z),
            "Soul 4 to beam 3",
        );
        let got = hands[3].act("mars:take", b3, BTreeMap::new());
        println!("Soul 4 takes beam 3 in its hand: {got:?}");
        assert_eq!(got.kind, 1, "a beam in a hand");
        let at = body_at(&w, body_of(&w, w.souls[3]));
        let (p, q) = (v3(at.x, 0, at.z + 900_000), v3(at.x, 0, at.z - 900_000));
        both(&mut hands, (0, 2), p, q, "crew C to Soul 4");
        let got = hands[0].act("part:take", crew_c, part(b3));
        refused(
            &got,
            "part.in-a-hand",
            "crew C takes the beam in Soul 4's hand",
        );
    }

    // Crew C puts beam 1 in beam_low_l.
    let (p, q) = along(where_is(&w, b1).2);
    both(&mut hands, (0, 2), p, q, "crew C to beam 1");
    assert_eq!(
        hands[0].act("part:take", crew_c, part(b1)).kind,
        1,
        "beam 1 taken"
    );
    let (bl, br) = (slot_at("beam_low_l"), slot_at("beam_low_r"));
    let (p, q) = along(bl);
    both(&mut hands, (0, 2), p, q, "beam 1 to the bay");
    let got = hands[0].act("part:put", crew_c, into("beam_low_l"));
    println!("crew C puts beam 1 in beam_low_l, joined to both frames: {got:?}");
    assert_eq!(got.kind, 1, "beam 1 in");
    // Beam 2, with Soul 2 inside the bay: refused at its commit; put again once Soul 2 is out.
    let (p, q) = along(where_is(&w, b2).2);
    both(&mut hands, (0, 2), p, q, "crew C to beam 2");
    assert_eq!(
        hands[0].act("part:take", crew_c, part(b2)).kind,
        1,
        "beam 2 taken"
    );
    let inside = v3((bl.x + br.x) / 2, 0, (ua.z + ub.z) / 2);
    one(&mut hands, 1, inside, "Soul 2 into the bay");
    let (p, q) = along(br);
    both(&mut hands, (0, 2), p, q, "beam 2 to the bay");
    let got = hands[0].act("part:put", crew_c, into("beam_low_r"));
    refused(
        &got,
        "edit.would-cut-off",
        "beam 2 would shut Soul 2 in the bay",
    );
    assert_eq!(
        where_is(&w, b2).0,
        Some(crew_c),
        "beam 2 still rides crew C"
    );
    one(
        &mut hands,
        1,
        v3(br.x + 3_000_000, 0, br.z),
        "Soul 2 walks out",
    );
    hands[0].send("part:put", crew_c, into("beam_low_r"));
    let got = leave(&mut hands, 2, crew_c);
    refused(
        &got,
        "crew.setting-in",
        "Soul 3 leaves crew C while beam 2 goes in",
    );
    let got = socket_end(&mut hands[0].s);
    println!("crew C puts beam 2 in beam_low_r: {got:?}");
    assert_eq!(got.kind, 1, "beam 2 in");
    // Beam 2 out again; crew C may not leave while it holds it; it lays it on the ground.
    let got = hands[0].act("part:unseat", crew_c, part(b2));
    println!("crew C takes beam 2 out of the bay: {got:?}");
    assert_eq!(got.kind, 1, "beam 2 out");
    assert_eq!(where_is(&w, b2).0, Some(crew_c));
    // Crew C carries beam 2 off; on the way Soul 3 leaves the world. The carry breaks off, beam 2 is set down where
    // it was, and Soul 1 may leave the crew.
    let down = v3(br.x + 2_500_000, 0, br.z);
    let (p, q) = along(down);
    hands[0].walk_to(g, p);
    hands[2].walk_to(g, q);
    std::thread::sleep(Duration::from_millis(800));
    hands[2].send_to(answers::LEAVE, None, BTreeMap::new());
    let ends_of_two = (socket_end(&mut hands[2].s), socket_end(&mut hands[2].s));
    println!("Soul 3 leaves the world mid-carry: {ends_of_two:?}");
    let _ = socket_end(&mut hands[0].s);
    std::thread::sleep(Duration::from_secs(1));
    assert_eq!(
        where_is(&w, b2).0,
        Some(g),
        "beam 2 set down when its carrier left"
    );
    let got = leave(&mut hands, 0, crew_c);
    println!("Soul 1 leaves crew C: {got:?}");
    assert_eq!(got.kind, 1, "Soul 1 may leave the crew");

    // Frame A out from under beam 1: crew D holds it (Soul 2 then goes), and its take is refused.
    let (p, q) = across(ua, -800_000);
    both(&mut hands, (0, 2), p, q, "Souls 1 and 3 to frame A");
    let crew_d = crew(&mut hands, (0, 2), fa);
    assert_eq!(
        leave(&mut hands, 1, crew_a).kind,
        1,
        "Soul 2 lets go; crew D holds frame A"
    );
    let (frame_before, beam_before) = (where_is(&w, fa), where_is(&w, b1));
    let got = hands[0].act("part:unseat", crew_d, part(fa));
    refused(
        &got,
        "support.none",
        "crew D takes frame A out from under beam 1",
    );
    assert_eq!(
        (where_is(&w, fa), where_is(&w, b1)),
        (frame_before, beam_before),
        "nothing changed"
    );

    // Frame B's last holder, Soul 4, leaves the world with beam 1 joined to frame B and walls round beam 1 (review
    // round eight): beam 1 would hang by frame B and has no room to be laid down, so nothing moves. The structure is
    // kept as it stands, its hold still counting for B18 (`souls:holder-left-structure-kept`), never frozen: a new
    // crew (Souls 2 and 5) takes the hold over.
    assert!(joints_at(&w, b1) > 0, "beam 1 joined");
    let mut walls = Vec::new();
    for (x, z, what) in [
        (bl.x - 1_500_000, bl.z, "out of the bay from beam 1"),
        (bl.x, bl.z + 2_000_000, "past frame B from beam 1"),
        (bl.x + 400_000, bl.z - 2_000_000, "past frame A from beam 1"),
    ] {
        let got = creator_edit(wall(&w, x, z));
        println!("the creator puts a wall {what}: {got:?}");
        assert_eq!(got.kind, 1, "a wall");
        walls.push(got.names[&1]);
    }
    hands[3].send_to(answers::LEAVE, None, BTreeMap::new());
    let got = socket_end(&mut hands[3].s);
    println!("Soul 4, frame B's last holder, leaves with beam 1 boxed in: {got:?}");
    assert_eq!(
        got.kind, 1,
        "Soul 4 leaves the world: the retire is never refused"
    );
    let kept = whys(&w, &got.entries, "souls:hold-kept");
    println!("kept: {kept:?}");
    assert_eq!(
        kept,
        vec![(fb, "souls:holder-left-structure-kept".to_owned())],
        "the structure kept, named"
    );
    assert_eq!(
        (where_is(&w, fb).0, where_is(&w, b1).0),
        (Some(bay), Some(bay)),
        "nothing moved"
    );
    // A kept hold ends when another crew holds the frame: crew E (Souls 2 and 5) holds it, and frame B has one crew.
    let (p, q) = across(ub, 800_000);
    both(&mut hands, (1, 4), p, q, "Souls 2 and 5 to frame B");
    let crew_e = crew(&mut hands, (1, 4), fb);
    assert_eq!(
        crews_on(&w, fb),
        (1, 0),
        "crew E holds frame B; the kept hold is gone"
    );
    assert_eq!(
        leave(&mut hands, 4, crew_e).kind,
        1,
        "Soul 5 lets go; Soul 2 holds frame B"
    );
    // A second retire with the hold kept; a new crew (Souls 5 and 6) may still hold frame B (no `crew.over-most`).
    let retire_kept = |hands: &mut [Hand], k: usize, what: &str| {
        hands[k].send_to(answers::LEAVE, None, BTreeMap::new());
        let got = socket_end(&mut hands[k].s);
        println!("{what}: {got:?}");
        assert_eq!(got.kind, 1, "{what}");
        assert_eq!(
            whys(&w, &got.entries, "souls:hold-kept"),
            vec![(fb, "souls:holder-left-structure-kept".to_owned())],
            "{what}: kept"
        );
    };
    retire_kept(
        &mut hands,
        1,
        "Soul 2, frame B's last holder, leaves with beam 1 boxed in",
    );
    let (p, q) = across(ub, 800_000);
    both(&mut hands, (4, 5), p, q, "Souls 5 and 6 to frame B");
    let crew_f = crew(&mut hands, (4, 5), fb);
    assert_eq!(
        crews_on(&w, fb),
        (1, 0),
        "crew F holds frame B, after two kept holds"
    );
    assert_eq!(leave(&mut hands, 5, crew_f).kind, 1, "Soul 6 lets go");
    retire_kept(
        &mut hands,
        4,
        "Soul 5, frame B's last holder, leaves with beam 1 boxed in",
    );
    for wall_id in walls {
        let got = creator_edit(Op::Remove {
            node: Ref::Node(wall_id),
        });
        assert_eq!(got.kind, 1, "a wall taken away: {got:?}");
    }
    // The kept hold counts for B18: crew H (Souls 1 and 6) takes beam 1 out and sets it down.
    assert_eq!(
        leave(&mut hands, 0, crew_d).kind,
        1,
        "Soul 1 lets go of frame A; Soul 3 holds it"
    );
    let (p, q) = along(bl);
    both(&mut hands, (0, 5), p, q, "Souls 1 and 6 to beam 1");
    let crew_h = crew(&mut hands, (0, 5), g);
    let got = hands[0].act("part:unseat", crew_h, part(b1));
    println!("crew H takes beam 1 out from frame B's kept hold: {got:?}");
    assert_eq!(got.kind, 1, "beam 1 out");
    assert_eq!(
        leave(&mut hands, 0, crew_h).kind,
        1,
        "Soul 1 lets go: beam 1 set down"
    );
    assert_eq!(leave(&mut hands, 5, crew_h).kind, 1, "Soul 6 leaves crew H");
    assert_eq!(where_is(&w, b1).0, Some(g), "beam 1 on the ground");
    // A new crew takes the kept frame out: the kept hold ends with it, so no phantom holder rides along, and once frame
    // B is back in its slot, its last holder may not let go (`support.none`).
    let (p, q) = ends(ub, 0);
    both(&mut hands, (0, 5), p, q, "Souls 1 and 6 to frame B");
    let crew_i = crew(&mut hands, (0, 5), g);
    let got = hands[0].act("part:unseat", crew_i, part(fb));
    println!("crew I takes the kept frame B out (an unseat): {got:?}");
    assert_eq!(got.kind, 1, "frame B taken");
    assert_eq!(where_is(&w, fb).0, Some(crew_i), "frame B rides crew I");
    assert_eq!(crews_on(&w, fb), (0, 0), "no kept hold rides along");
    let got = hands[0].act("part:put", crew_i, into("upright_b"));
    assert_eq!(got.kind, 1, "frame B back in: {got:?}");
    assert_eq!(leave(&mut hands, 0, crew_i).kind, 1, "Soul 1 lets go");
    let got = leave(&mut hands, 5, crew_i);
    refused(
        &got,
        "support.none",
        "Soul 6, frame B's last holder, lets go of it unbraced",
    );
    // Crew J (Souls 1 and 7) puts beam 1 back, joined to both frames.
    let (p, q) = along(where_is(&w, b1).2);
    both(&mut hands, (0, 6), p, q, "Souls 1 and 7 to beam 1");
    let crew_j = crew(&mut hands, (0, 6), g);
    assert_eq!(
        hands[0].act("part:take", crew_j, part(b1)).kind,
        1,
        "beam 1 taken"
    );
    let (p, q) = along(bl);
    both(&mut hands, (0, 6), p, q, "beam 1 to the bay");
    let got = hands[0].act("part:put", crew_j, into("beam_low_l"));
    assert_eq!(got.kind, 1, "beam 1 back in: {got:?}");
    assert!(joints_at(&w, b1) > 0, "beam 1 joined again");
    assert_eq!(leave(&mut hands, 0, crew_j).kind, 1);
    assert_eq!(leave(&mut hands, 6, crew_j).kind, 1);

    // Soul 6, frame B's last holder, leaves the world, no walls now: beam 1 would hang by frame B's one end, so it is
    // laid down first, then frame B, and B18 judges both together. Frame A stays, held by Soul 3; no part is left
    // hanging.
    hands[5].send_to(answers::LEAVE, None, BTreeMap::new());
    let got = socket_end(&mut hands[5].s);
    println!("Soul 6, frame B's last holder, leaves with beam 1 joined to frame B: {got:?}");
    assert_eq!(got.kind, 1, "Soul 6 leaves the world");
    let set_down = whys_caused(&w, &got.entries, "souls:carry-set-down");
    println!("its set-downs: {set_down:?}");
    assert!(
        whys(&w, &got.entries, "souls:hold-kept").is_empty(),
        "room for both: nothing kept"
    );
    assert_eq!(
        where_is(&w, b1).0,
        Some(g),
        "beam 1 laid down, not left hanging"
    );
    assert_eq!(joints_at(&w, b1), 0, "beam 1's joints undone");
    assert_eq!(where_is(&w, fb).0, Some(g), "frame B set down");
    assert!(
        set_down
            .iter()
            .any(|(l, why)| *l == fb && why.starts_with("souls:holder-left")),
        "frame B's set-down named"
    );
    assert_eq!(
        where_is(&w, fa).0,
        Some(bay),
        "frame A stays, held by Soul 3"
    );
    let (beam_y, _, _) = rest_of(&w, b1, 0);
    assert!(
        (0..=120_000).contains(&beam_y),
        "beam 1 rests on the ground: {beam_y} µm"
    );
    // The retire's set-down went through the walkers' maps: Soul 7 walks to beam 1's slot, which it held, and gets
    // there (a stale map would still have the beam across it, and the walk would end a body's radius off).
    one(
        &mut hands,
        6,
        v3(bl.x, 0, bl.z),
        "Soul 7 to beam 1's empty slot",
    );
    let at = body_at(&w, body_of(&w, w.souls[6]));
    let off = (i128::from(at.x - bl.x).pow(2) + i128::from(at.z - bl.z).pow(2)).isqrt();
    println!("Soul 7 ends {} mm from beam 1's empty slot", off / 1000);
    // Beam 1 still in its slot would keep the body's middle a body's radius and half the beam's width off.
    assert!(
        off < i128::from(sim::ground::HUMAN_RADIUS * 1000),
        "the walkers' map has beam 1 out of its slot"
    );
}

/// One Soul on its own gateway connection, signed in with its own token (0.135 A3).
struct GwSoul {
    ws: Ws,
    soul: Id,
    lineage: Scope,
    sequence: u64,
}

impl GwSoul {
    async fn new(url: &str, token: &Token, w: &Seeded, soul: Id) -> GwSoul {
        GwSoul {
            ws: sign_in(url, token).await,
            soul,
            lineage: w.root.scope(),
            sequence: 0,
        }
    }

    async fn send(&mut self, verb: &str, target: Id, parameters: BTreeMap<u64, Value>) {
        self.sequence += 1;
        let i = Intent {
            actor: Actor::Soul(self.soul),
            verb: Name::new(verb).unwrap(),
            target: Some(Target::Node(target)),
            parameters,
            sequence: self.sequence,
            basis: basis(self.lineage, 0),
            expiry: answers::now() + 120_000_000,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
            reflex: false,
        };
        put(&mut self.ws, encode(&i.to_value()).unwrap()).await;
    }

    /// The end of this Soul's last intent: a receipt (kind 1) or a refusal (kind 2); progress is read past.
    async fn end(&mut self) -> Got {
        loop {
            let v = next(&mut self.ws).await;
            let Value::Map(f) = &v else { continue };
            let Some(Value::Map(a)) = f.get(&2) else {
                continue;
            };
            if a.get(&2) != Some(&Value::Uint(self.sequence)) {
                continue;
            }
            if matches!(a.get(&3), Some(Value::Uint(1 | 2))) {
                return read_answer(&v);
            }
        }
    }

    async fn act(&mut self, verb: &str, target: Id, parameters: BTreeMap<u64, Value>) -> Got {
        self.send(verb, target, parameters).await;
        self.end().await
    }
}

/// 0.135 A3 (#3342's X17, narrowed): four Souls build one rack bay from the yard and take it down, each step its own
/// intent on its own gateway connection, in a served world (N2's test world, a bay at the build site, the construction
/// entries). A body plays in one activity at a time, and a crew of two starts it.
///
/// - Build: crew A (Souls 1, 2) takes frame A off the stand, carries it 25 m and seats it in `upright_a`; crew B
///   (Souls 1, 3) does frame B into `upright_b`, each frame then held by one of its crew. **The change of crew**, while
///   frame A is held in its slot: Soul 4 takes Soul 2's place as its holder (a hold crew of Souls 4 and 1 on the
///   frame, Soul 1 goes, then Soul 2 leaves crew A). Crew C (Souls 1, 2) seats beam 1 in `beam_low_l` and beam 2 in
///   `beam_low_r`, each joined to both frames. Then every holder lets go: the bay stands on its joints, nobody holds it.
/// - Take down, in reverse: two hold crews take the frames again; crew D (Souls 2, 4) takes the beams out, `beam_low_r`
///   first, and lays each where it lay in the yard; then a crew of two takes each frame out (frame B, then frame A)
///   and stands it back in its slot on the stand.
/// - Every part ends where it started, under the same id, and every node of the world as built is still there. The
///   checks read the world as its log replays from the start, so the history plays back.
#[tokio::test(flavor = "multi_thread")]
async fn a3_four_souls_build_a_bay_and_take_it_down() {
    const H: i64 = 1_200_000;
    let d = scratch("a3bay");
    let (facts, slots) = yard_world(&d);
    let w = seed_entries(&d, &facts, 4, (36, -20), Some(&d.join("entries")));
    let socket = d.join("s");
    let s = serve_with(&w, &socket, None);
    s.line("listening ", 120);
    let im = import_eden::load(&facts).unwrap();
    let (bay, stand, fa, fb) = (
        im.nodes["site-bay"],
        im.nodes["yard-stand"],
        im.nodes["yard-frame-1"],
        im.nodes["yard-frame-2"],
    );
    let beams = [im.nodes["yard-beam-1"], im.nodes["yard-beam-2"]];
    let g = w.ground;
    let actors: Vec<Actor> = w.souls.iter().map(|s| Actor::Soul(*s)).collect();
    let (url, tokens) = gateway(&socket, &actors).await;
    let mut souls = Vec::new();
    for (k, t) in tokens.iter().enumerate() {
        souls.push(GwSoul::new(&url, t, &w, w.souls[k]).await);
    }
    // As built: every node, and where each part rests.
    let built: std::collections::BTreeSet<Id> = {
        let (copy, _) = served_copy(&w);
        let t = copy.tree();
        let root = t.handle(w.root).unwrap();
        let mut out = std::collections::BTreeSet::new();
        let mut stack = vec![root];
        while let Some(h) = stack.pop() {
            out.insert(t.node(h).unwrap().id());
            stack.extend(t.children(h).unwrap_or(&[]).iter().copied());
        }
        out
    };
    let start: Vec<_> = [fa, fb, beams[0], beams[1]]
        .iter()
        .map(|p| where_is(&w, *p))
        .collect();
    async fn both(
        souls: &mut [GwSoul],
        g: Id,
        (a, b): (usize, usize),
        pa: Vec3,
        pb: Vec3,
        what: &str,
    ) {
        let p = |v: Vec3| BTreeMap::from([(1, Value::Array(vec![int(v.x), int(0), int(v.z)]))]);
        souls[a].send("eden:walk", g, p(pa)).await;
        souls[b].send("eden:walk", g, p(pb)).await;
        let x = souls[a].end().await;
        let y = souls[b].end().await;
        assert_eq!((x.kind, y.kind), (1, 1), "{what}: {x:?} {y:?}");
    }
    let crew_kind = pinned_activity(&w, "mars:carry_activity");
    // A crew on `place` (the ground, or a part it then holds): Soul `a` offers in front, Soul `b` accepts.
    let crew = async |souls: &mut [GwSoul], (a, b): (usize, usize), place: Id| {
        let body = body_of(&w, w.souls[b]);
        let got = souls[a]
            .act(
                "activity:offer",
                place,
                BTreeMap::from([
                    (1, crew_kind.clone()),
                    (2, Value::Text(Name::new("mars:front").unwrap())),
                    (3, Value::Array(vec![body.to_value()])),
                ]),
            )
            .await;
        assert_eq!(got.kind, 1, "offered: {got:?}");
        let c = created_by(&w, &got.entries, "mars:carry_activity@");
        let got = souls[b].act("activity:accept", c, BTreeMap::new()).await;
        assert_eq!(got.kind, 1, "accepted: {got:?}");
        c
    };
    let leave = async |souls: &mut [GwSoul], k: usize, c: Id, what: &str| {
        let got = souls[k].act("activity:leave", c, BTreeMap::new()).await;
        assert_eq!(got.kind, 1, "{what}: {got:?}");
    };
    let part = |p: Id| BTreeMap::from([(1, p.to_value())]);
    let slot_of = |node: Id, k: u64| {
        let (copy, _) = served_copy(&w);
        let t = copy.tree();
        sim::ground::scene::slot_points(t, t.handle(node).unwrap(), t.handle(g).unwrap())
            .unwrap()
            .into_iter()
            .find(|(n, _)| *n == k)
            .unwrap()
            .1
    };
    let in_slot = |node: Id, k: u64| BTreeMap::from([(1, node.to_value()), (2, Value::Uint(k))]);
    let on_ground = |at: Vec3| {
        BTreeMap::from([
            (1, g.to_value()),
            (3, Value::Array(vec![int(at.x), int(at.y), int(at.z)])),
        ])
    };
    // Crew `c` of Souls `ab` takes `p` (a frame across x, a beam along z), carries it to `to` and puts it there.
    let frame_across = |at: Vec3| (v3(at.x + H, 0, at.z), v3(at.x - H, 0, at.z));
    // A frame's carriers stand 2.2 m either side of it along z, clear of the stand, the beams and the other frame, so
    // they walk side by side and keep their span (a carry whose carriers drift apart breaks off, C3).
    let frame_ends = |at: Vec3| (v3(at.x, 0, at.z - 2_200_000), v3(at.x, 0, at.z + 2_200_000));
    let beam_along = |at: Vec3| (v3(at.x, 0, at.z + 2_200_000), v3(at.x, 0, at.z - 2_200_000));

    // Build. Frame A by crew A (Souls 1, 2).
    let (f0, f1) = frame_ends(where_is(&w, fa).2);
    both(&mut souls, g, (0, 1), f0, f1, "to frame A").await;
    let crew_a = crew(&mut souls, (0, 1), g).await;
    let got = souls[0].act("part:take", crew_a, part(fa)).await;
    assert_eq!(got.kind, 1, "frame A taken: {got:?}");
    let ua = slot_of(bay, slots["upright_a"]);
    let (f0, f1) = frame_ends(ua);
    both(&mut souls, g, (0, 1), f0, f1, "frame A to the bay").await;
    let got = souls[0]
        .act("part:put", crew_a, in_slot(bay, slots["upright_a"]))
        .await;
    println!("crew A seats frame A: {got:?}");
    assert_eq!(got.kind, 1, "frame A seated");
    leave(
        &mut souls,
        0,
        crew_a,
        "Soul 1 lets go of frame A; Soul 2 holds it",
    )
    .await;
    // Frame B by crew B (Souls 1, 3).
    let (f0, f1) = frame_ends(where_is(&w, fb).2);
    both(&mut souls, g, (0, 2), f0, f1, "to frame B").await;
    let crew_b = crew(&mut souls, (0, 2), g).await;
    let got = souls[0].act("part:take", crew_b, part(fb)).await;
    assert_eq!(got.kind, 1, "frame B taken: {got:?}");
    let ub = slot_of(bay, slots["upright_b"]);
    let (f0, f1) = frame_ends(ub);
    both(&mut souls, g, (0, 2), f0, f1, "frame B to the bay").await;
    let got = souls[0]
        .act("part:put", crew_b, in_slot(bay, slots["upright_b"]))
        .await;
    println!("crew B seats frame B: {got:?}");
    assert_eq!(got.kind, 1, "frame B seated");
    leave(
        &mut souls,
        0,
        crew_b,
        "Soul 1 lets go of frame B; Soul 3 holds it",
    )
    .await;
    // The change of crew on frame A, held in its slot: Soul 4 takes Soul 2's place.
    let (f0, f1) = frame_across(ua);
    both(
        &mut souls,
        g,
        (3, 0),
        f0,
        v3(f1.x, 0, f1.z - 800_000),
        "Souls 4 and 1 to frame A",
    )
    .await;
    let crew_a2 = crew(&mut souls, (3, 0), fa).await;
    leave(
        &mut souls,
        0,
        crew_a2,
        "Soul 1 goes; Soul 4 holds frame A beside Soul 2",
    )
    .await;
    leave(
        &mut souls,
        1,
        crew_a,
        "Soul 2 leaves crew A; Soul 4 holds frame A",
    )
    .await;
    println!("the change of crew: frame A, held in its slot, is held by Soul 4 in Soul 2's place");
    // Beams by crew C (Souls 1, 2), each joined to both frames.
    let crew_c = crew(&mut souls, (0, 1), g).await;
    for (beam, slot) in [(beams[0], "beam_low_l"), (beams[1], "beam_low_r")] {
        let (b0, b1) = beam_along(where_is(&w, beam).2);
        both(&mut souls, g, (0, 1), b0, b1, "to the beam").await;
        let got = souls[0].act("part:take", crew_c, part(beam)).await;
        assert_eq!(got.kind, 1, "beam taken: {got:?}");
        let (b0, b1) = beam_along(slot_of(bay, slots[slot]));
        both(&mut souls, g, (0, 1), b0, b1, "the beam to the bay").await;
        let got = souls[0]
            .act("part:put", crew_c, in_slot(bay, slots[slot]))
            .await;
        println!("crew C seats beam {} in {slot}: {got:?}", beam.counter());
        assert_eq!(got.kind, 1, "beam seated");
    }
    leave(&mut souls, 2, crew_b, "Soul 3 lets go of frame B").await;
    leave(&mut souls, 3, crew_a2, "Soul 4 lets go of frame A").await;
    leave(&mut souls, 0, crew_c, "crew C goes").await;
    leave(&mut souls, 1, crew_c, "crew C goes").await;
    {
        let (copy, _) = served_copy(&w);
        let t = copy.tree();
        let kids: Vec<Id> = t
            .children(t.handle(bay).unwrap())
            .unwrap()
            .iter()
            .map(|h| t.node(*h).unwrap().id())
            .collect();
        let held: usize = [fa, fb]
            .iter()
            .map(|f| t.children(t.handle(*f).unwrap()).unwrap_or(&[]).len())
            .sum();
        println!(
            "the bay stands: {} parts in it, {held} crews holding them",
            kids.len()
        );
        assert_eq!(kids.len(), 4, "two frames and two beams in the bay");
        assert_eq!(held, 0, "nobody holds the bay");
    }

    // Take down. Hold crews take the frames again: Souls 3, 4 on frame A and Souls 1, 2 on frame B, one of each goes.
    let (f0, f1) = frame_across(ua);
    both(
        &mut souls,
        g,
        (2, 3),
        f0,
        v3(f1.x, 0, f1.z - 800_000),
        "Souls 3 and 4 to frame A",
    )
    .await;
    let hold_a = crew(&mut souls, (2, 3), fa).await;
    leave(&mut souls, 3, hold_a, "Soul 3 holds frame A").await;
    let (f0, f1) = frame_across(ub);
    both(
        &mut souls,
        g,
        (0, 1),
        f0,
        v3(f1.x, 0, f1.z + 800_000),
        "Souls 1 and 2 to frame B",
    )
    .await;
    let hold_b = crew(&mut souls, (0, 1), fb).await;
    leave(&mut souls, 1, hold_b, "Soul 1 holds frame B").await;
    // Crew D (Souls 2, 4) takes the beams out, the right one first, and lays each where it lay.
    let crew_d = crew(&mut souls, (1, 3), g).await;
    for (k, slot) in [(1, "beam_low_r"), (0, "beam_low_l")] {
        let (b0, b1) = beam_along(slot_of(bay, slots[slot]));
        both(&mut souls, g, (1, 3), b0, b1, "to the beam in the bay").await;
        let got = souls[1].act("part:unseat", crew_d, part(beams[k])).await;
        println!(
            "crew D takes beam {} out of {slot}: {got:?}",
            beams[k].counter()
        );
        assert_eq!(got.kind, 1, "beam out");
        let home = start[2 + k].2;
        let (b0, b1) = beam_along(home);
        both(&mut souls, g, (1, 3), b0, b1, "the beam to the yard").await;
        let got = souls[1].act("part:put", crew_d, on_ground(home)).await;
        assert_eq!(got.kind, 1, "beam laid in the yard: {got:?}");
    }
    leave(&mut souls, 1, crew_d, "crew D goes").await;
    leave(&mut souls, 3, crew_d, "crew D goes").await;
    // Each frame out by a crew of two on it, its last holder then going; back to its slot on the stand.
    for (f, hold, holder, at, stand_slot) in [(fb, hold_b, 0, ub, 2), (fa, hold_a, 2, ua, 1)] {
        let (f0, f1) = frame_ends(at);
        both(&mut souls, g, (1, 3), f0, f1, "to the frame").await;
        let out = crew(&mut souls, (1, 3), f).await;
        leave(
            &mut souls,
            holder,
            hold,
            "its last holder goes, the new crew holding it",
        )
        .await;
        let got = souls[1].act("part:unseat", out, part(f)).await;
        println!("frame {} out of the bay: {got:?}", f.counter());
        assert_eq!(got.kind, 1, "frame out");
        let to = slot_of(stand, stand_slot);
        let (f0, f1) = frame_ends(to);
        both(&mut souls, g, (1, 3), f0, f1, "the frame to the stand").await;
        let got = souls[1]
            .act("part:put", out, in_slot(stand, stand_slot))
            .await;
        assert_eq!(got.kind, 1, "frame back on the stand: {got:?}");
        leave(&mut souls, 1, out, "the crew goes").await;
        leave(&mut souls, 3, out, "the crew goes").await;
    }

    // Every part where it started, under its id; every node of the world as built still there; the log replays.
    for (p, was) in [fa, fb, beams[0], beams[1]].iter().zip(&start) {
        let now = where_is(&w, *p);
        println!(
            "part {}: was in {:?} slot {:?} at ({}, {}) mm, now in {:?} slot {:?} at ({}, {}) mm",
            p.counter(),
            was.0.map(|i| i.counter()),
            was.1,
            was.2.x / 1000,
            was.2.z / 1000,
            now.0.map(|i| i.counter()),
            now.1,
            now.2.x / 1000,
            now.2.z / 1000
        );
        assert_eq!((now.0, now.1), (was.0, was.1), "back where it started");
        let off =
            (i128::from(now.2.x - was.2.x).pow(2) + i128::from(now.2.z - was.2.z).pow(2)).isqrt();
        assert!(off < 5_000, "within 5 mm of where it lay: {off} µm");
    }
    let (copy, _) = served_copy(&w);
    let t = copy.tree();
    let missing: Vec<Id> = built
        .iter()
        .filter(|id| t.handle(**id).is_none())
        .copied()
        .collect();
    assert!(
        missing.is_empty(),
        "every node as built is still there: {missing:?}"
    );
    println!(
        "{} nodes as built, all still there; the log replays to here",
        built.len()
    );
}

/// [`yard_world`] with three bays side by side at the build site and parts for each from two yards (0.135 A4): the
/// site's bay (x 65 m) with a bay 4 m west of it and one 4 m east, each its own two frames and two low beams. The west
/// yard is the test world's (two frames on its stand, four beams) and a second stand 6 m south with one frame; the east
/// yard, 23 m east of the site, mirrors it: a stand with two frames, two beams beside it, a second stand with one.
fn three_bays_world(d: &Path) -> (String, BTreeMap<String, u64>) {
    let (text, slots) = yard_world(d);
    let mut f = json::parse(&text).unwrap();
    let json::Value::Obj(top) = &mut f else {
        panic!("facts")
    };
    let things = top
        .iter_mut()
        .find_map(|(k, v)| match (k.as_str(), v) {
            ("things", json::Value::Arr(a)) => Some(a),
            _ => None,
        })
        .unwrap();
    let find = |things: &[json::Value], id: &str| {
        things
            .iter()
            .find(|t| t.get("id").and_then(json::Value::str) == Some(id))
            .unwrap_or_else(|| panic!("the world's {id}"))
            .clone()
    };
    let num = |v: i64| json::Value::Int(i128::from(v));
    // `t` as a new thing: its id, name, parent, pose and (in a stand) its slot.
    let like = |t: &json::Value,
                id: &str,
                name: &str,
                parent: Option<&str>,
                pose: [i64; 3],
                slot: Option<i64>| {
        let json::Value::Obj(mut o) = t.clone() else {
            panic!("a thing")
        };
        for (k, v) in o.iter_mut() {
            match k.as_str() {
                "id" => *v = json::Value::s(id),
                "name" => *v = json::Value::s(name),
                "parent" => *v = parent.map_or(json::Value::Null, json::Value::s),
                "pose" => *v = json::Value::Arr([pose[0], pose[1], pose[2], 0].map(num).to_vec()),
                "slot" => *v = json::Value::Obj(vec![("n".into(), num(slot.unwrap()))]),
                _ => {}
            }
        }
        json::Value::Obj(o)
    };
    let (bay, stand, frame, beam) = (
        find(things, "site-bay"),
        find(things, "yard-stand"),
        find(things, "yard-frame-1"),
        find(things, "yard-beam-1"),
    );
    for (id, name, x) in [
        ("site-bay-w", "the site's west rack bay", 61_000),
        ("site-bay-e", "the site's east rack bay", 69_000),
    ] {
        things.push(like(&bay, id, name, None, [x, 0, -24_000], None));
    }
    for (id, name, x, z) in [
        (
            "yard-stand-w2",
            "the west yard's second stand",
            40_000,
            -30_000,
        ),
        (
            "yard-stand-e",
            "the east yard's frame stand",
            88_000,
            -24_000,
        ),
        (
            "yard-stand-e2",
            "the east yard's second stand",
            88_000,
            -30_000,
        ),
    ] {
        things.push(like(&stand, id, name, None, [x, 0, z], None));
    }
    for (id, name, parent, n) in [
        ("yard-frame-w", "rack frame w", "yard-stand-w2", 1),
        ("yard-frame-e1", "rack frame e1", "yard-stand-e", 1),
        ("yard-frame-e2", "rack frame e2", "yard-stand-e", 2),
        ("yard-frame-e3", "rack frame e3", "yard-stand-e2", 1),
    ] {
        let z = if n == 1 { -150 } else { 150 };
        things.push(like(&frame, id, name, Some(parent), [0, 100, z], Some(n)));
    }
    for (id, name, x) in [
        ("yard-beam-5", "rack beam 5", 86_000),
        ("yard-beam-6", "rack beam 6", 85_700),
    ] {
        things.push(like(&beam, id, name, None, [x, 0, -24_000], None));
    }
    (f.to_json(), slots)
}

/// What A4's steps share: the served world, its open ground and the crew's kind.
struct Site<'a> {
    w: &'a Seeded,
    g: Id,
    crew: Value,
}

/// A part's carriers 2.2 m either side of it along z (as A3's): a frame's first carrier on its -z side, a beam's on +z.
fn frame_ends(at: Vec3) -> (Vec3, Vec3) {
    (v3(at.x, 0, at.z - 2_200_000), v3(at.x, 0, at.z + 2_200_000))
}

fn beam_ends(at: Vec3) -> (Vec3, Vec3) {
    (v3(at.x, 0, at.z + 2_200_000), v3(at.x, 0, at.z - 2_200_000))
}

/// Where a holder and its helper stand to start a hold crew on a frame at `at` in a bay: the holder 1 m to the side
/// `side` (+1 east, -1 west: away from where the beams come in), the helper 1.2 m to the other side and 0.8 m out
/// from the bay (`out` -1 for `upright_a`, +1 for `upright_b`).
fn hold_places(at: Vec3, side: i64, out: i64) -> (Vec3, Vec3) {
    (
        v3(at.x + side * 1_000_000, 0, at.z),
        v3(at.x - side * 1_200_000, 0, at.z + out * 800_000),
    )
}

async fn walk_two(
    s: &Site<'_>,
    a: &mut GwSoul,
    b: &mut GwSoul,
    (pa, pb): (Vec3, Vec3),
    what: &str,
) {
    a.send("eden:walk", s.g, to_point(pa)).await;
    b.send("eden:walk", s.g, to_point(pb)).await;
    let (x, y) = (a.end().await, b.end().await);
    assert_eq!((x.kind, y.kind), (1, 1), "{what}: {x:?} {y:?}");
}

/// A walk's parameters: to `at` on the ground.
fn to_point(at: Vec3) -> BTreeMap<u64, Value> {
    BTreeMap::from([(1, Value::Array(vec![int(at.x), int(0), int(at.z)]))])
}

/// A crew on `place` (the ground, or a part it then holds): `a` offers in front, `b` accepts.
async fn crew_of(s: &Site<'_>, a: &mut GwSoul, b: &mut GwSoul, place: Id) -> Id {
    let body = body_of(s.w, b.soul);
    let got = a
        .act(
            "activity:offer",
            place,
            BTreeMap::from([
                (1, s.crew.clone()),
                (2, Value::Text(Name::new("mars:front").unwrap())),
                (3, Value::Array(vec![body.to_value()])),
            ]),
        )
        .await;
    assert_eq!(got.kind, 1, "offered: {got:?}");
    let c = created_by(s.w, &got.entries, "mars:carry_activity@");
    let got = b.act("activity:accept", c, BTreeMap::new()).await;
    assert_eq!(got.kind, 1, "accepted: {got:?}");
    c
}

async fn leave_crew(a: &mut GwSoul, c: Id, what: &str) {
    let got = a.act("activity:leave", c, BTreeMap::new()).await;
    assert_eq!(got.kind, 1, "{what}: {got:?}");
}

fn part_of(p: Id) -> BTreeMap<u64, Value> {
    BTreeMap::from([(1, p.to_value())])
}

fn into_slot(node: Id, k: u64) -> BTreeMap<u64, Value> {
    BTreeMap::from([(1, node.to_value()), (2, Value::Uint(k))])
}

/// `part:put` by `a` for crew `c`, asked again while it is refused at its commit because a walker moved while the
/// walkers' maps were prepared (`edit.body-stale`: the part comes back to its crew, which may put again) or while it
/// is still on its way back (`part.setting-in`). Six Souls walk at once here, so a commit can meet a moving body.
async fn put_part(a: &mut GwSoul, c: Id, to: BTreeMap<u64, Value>) -> Got {
    for _ in 0..10 {
        let got = a.act("part:put", c, to.clone()).await;
        if !(got.kind == 2 && matches!(got.reason.as_str(), "edit.body-stale" | "part.setting-in"))
        {
            return got;
        }
        println!("asked again after {}", got.reason);
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    panic!("a put refused ten times while walkers moved");
}

/// Where a part's carriers stand for it: [`frame_ends`] or [`beam_ends`].
type Ends = fn(Vec3) -> (Vec3, Vec3);

/// Pair `a`, `b` takes `part` on a new crew (its carriers at `ends` of it) and carries it along `via` (the part's
/// middle at each): the crew, the part riding it.
#[allow(clippy::too_many_arguments)]
async fn take_along(
    s: &Site<'_>,
    a: &mut GwSoul,
    b: &mut GwSoul,
    part: Id,
    ends: Ends,
    via: &[Vec3],
    what: &str,
) -> Id {
    walk_two(s, a, b, ends(where_is(s.w, part).2), what).await;
    let c = crew_of(s, a, b, s.g).await;
    let got = a.act("part:take", c, part_of(part)).await;
    assert_eq!(got.kind, 1, "{what}: taken: {got:?}");
    for at in via {
        walk_two(s, a, b, ends(*at), what).await;
    }
    c
}

/// As [`take_along`], then the part put by `to`: the crew (holding it if it stands in a bay).
#[allow(clippy::too_many_arguments)]
async fn carry_in(
    s: &Site<'_>,
    a: &mut GwSoul,
    b: &mut GwSoul,
    part: Id,
    ends: Ends,
    via: &[Vec3],
    to: BTreeMap<u64, Value>,
    what: &str,
) -> Id {
    let c = take_along(s, a, b, part, ends, via, what).await;
    let got = put_part(a, c, to).await;
    println!("{what}: {got:?}");
    assert_eq!(got.kind, 1, "{what}");
    c
}

/// A beam into slot `k` of `bay` (at `at`) by its own crew of `a`, `b`, who then go: it bears on its joints to the
/// bay's frames.
#[allow(clippy::too_many_arguments)]
async fn beam_in(
    s: &Site<'_>,
    a: &mut GwSoul,
    b: &mut GwSoul,
    beam: Id,
    bay: Id,
    k: u64,
    at: Vec3,
    what: &str,
) {
    let c = carry_in(s, a, b, beam, beam_ends, &[at], into_slot(bay, k), what).await;
    leave_crew(a, c, what).await;
    leave_crew(b, c, what).await;
}

/// Holder `h` takes frame `f` from `q`, who holds it alone in crew `c`, with `p`'s help (A3's change of crew): a hold
/// crew of `h` and `p` on the frame, `p` goes, then `q` leaves `c`. The hold crew.
#[allow(clippy::too_many_arguments)]
async fn hand_over(
    s: &Site<'_>,
    h: &mut GwSoul,
    p: &mut GwSoul,
    q: &mut GwSoul,
    c: Id,
    f: Id,
    places: (Vec3, Vec3),
    what: &str,
) -> Id {
    walk_two(s, h, p, places, what).await;
    let hold = crew_of(s, h, p, f).await;
    leave_crew(p, hold, what).await;
    leave_crew(q, c, what).await;
    println!("{what}");
    hold
}

/// Holder `h` takes frame `f`, standing in its bay on its joints, with `p`'s help: the hold crew.
async fn hold_frame(
    s: &Site<'_>,
    h: &mut GwSoul,
    p: &mut GwSoul,
    f: Id,
    places: (Vec3, Vec3),
    what: &str,
) -> Id {
    walk_two(s, h, p, places, what).await;
    let hold = crew_of(s, h, p, f).await;
    leave_crew(p, hold, what).await;
    println!("{what}");
    hold
}

/// A beam out of its bay's slot at `at` by a new crew of `a`, `b`, laid where it lay in its yard (`home`); they go.
#[allow(clippy::too_many_arguments)]
async fn beam_out(
    s: &Site<'_>,
    a: &mut GwSoul,
    b: &mut GwSoul,
    beam: Id,
    at: Vec3,
    home: Vec3,
    what: &str,
) {
    walk_two(s, a, b, beam_ends(at), what).await;
    let c = crew_of(s, a, b, s.g).await;
    let got = a.act("part:unseat", c, part_of(beam)).await;
    println!("{what}: {got:?}");
    assert_eq!(got.kind, 1, "{what}: out");
    walk_two(s, a, b, beam_ends(home), what).await;
    let on_ground = BTreeMap::from([
        (1, s.g.to_value()),
        (3, Value::Array(vec![int(home.x), int(home.y), int(home.z)])),
    ]);
    let got = put_part(a, c, on_ground).await;
    assert_eq!(got.kind, 1, "{what}: laid in the yard: {got:?}");
    leave_crew(a, c, what).await;
    leave_crew(b, c, what).await;
}

/// A crew of `a`, `b` on frame `f` (standing at `at` in its bay, held by `h` in `hold`), then `h` goes: the crew.
#[allow(clippy::too_many_arguments)]
async fn frame_crew(
    s: &Site<'_>,
    a: &mut GwSoul,
    b: &mut GwSoul,
    h: &mut GwSoul,
    hold: Id,
    f: Id,
    at: Vec3,
    what: &str,
) -> Id {
    walk_two(s, a, b, frame_ends(at), what).await;
    let c = crew_of(s, a, b, f).await;
    leave_crew(h, hold, what).await;
    c
}

/// Crew `c` of `a`, `b` takes frame `f` out of its bay, carries it along `via` and stands it in slot `k` of `stand`
/// (at `home`); they go.
#[allow(clippy::too_many_arguments)]
async fn frame_home(
    s: &Site<'_>,
    a: &mut GwSoul,
    b: &mut GwSoul,
    c: Id,
    f: Id,
    via: &[Vec3],
    (stand, k, home): (Id, u64, Vec3),
    what: &str,
) {
    let got = a.act("part:unseat", c, part_of(f)).await;
    println!("{what}: {got:?}");
    assert_eq!(got.kind, 1, "{what}: out");
    for at in via.iter().chain([&home]) {
        walk_two(s, a, b, frame_ends(*at), what).await;
    }
    let got = put_part(a, c, into_slot(stand, k)).await;
    assert_eq!(got.kind, 1, "{what}: on its stand: {got:?}");
    leave_crew(a, c, what).await;
    leave_crew(b, c, what).await;
}

/// How many parts are in `bay`, and how many crews hold them, as the served world has it.
fn bay_holds(w: &Seeded, bay: Id) -> (usize, usize) {
    let (copy, _) = served_copy(w);
    let t = copy.tree();
    let kids: Vec<_> = t.children(t.handle(bay).unwrap()).unwrap().to_vec();
    let held = kids
        .iter()
        .map(|h| t.children(*h).unwrap_or(&[]).len())
        .sum();
    (kids.len(), held)
}

/// 0.135 A4: six Souls in two teams of three, each a carry pair and a holder (as A3's), build three rack bays side by
/// side from two yards and take them down again, each step its own intent on its own gateway connection, in a served
/// world ([`three_bays_world`]). Each bay is its own two frames and two low beams.
///
/// A bay's frames are held while its beams go in (B18: a frame stands on beams on both its columns, or held), so a bay
/// at its beams needs its two frames held and a pair at once: four Souls. The two holders hold whichever bay is at its
/// beams; the two pairs work at once, each on its own part of the row:
///
/// - **The middle bay, both teams:** team 1 (Souls 1, 2; holder 3) carries a frame from the west yard into its
///   `upright_a` while team 2 (Souls 4, 5; holder 6) carries one from the east yard. Team 2 asks for `upright_a` too:
///   refused `slot.occupied`, and nothing moves. It brings its frame round to `upright_b`, where Soul 2 of team 1 stands:
///   refused `site.occupied`, nothing moves. Soul 2 steps out to help holder 3 take frame A; team 2's frame goes in and
///   holder 6 takes it. Team 1 seats the two beams from the west while team 2 seats the east bay's first frame.
/// - **The east bay by team 2** (frames and beams from the east yard) and the holders, while team 1 seats the west
///   bay's first frame. Then **the west bay by team 1** and the holders.
/// - Every bay stands on its joints with nobody holding it.
/// - **Take down**, in reverse: the west bay (team 1, the holders taking its frames again), then the east (team 2) while
///   team 1 carries the west bay's last frame home, then the middle (team 1 its beams and frame A, team 2 its frame
///   B). Every part goes back where it lay in its yard, under its id; every node of the world as built is still there;
///   the checks read the world as its log replays from the start.
#[tokio::test(flavor = "multi_thread")]
async fn a4_two_teams_build_three_bays_and_take_them_down() {
    let d = scratch("a4bays");
    let (facts, slots) = three_bays_world(&d);
    let w = seed_entries(&d, &facts, 6, (59, -34), Some(&d.join("entries")));
    let socket = d.join("s");
    let served = serve_with(&w, &socket, None);
    served.line("listening ", 120);
    println!("a4: world dir {}", w.dir.display());
    let im = import_eden::load(&facts).unwrap();
    let n = |k: &str| im.nodes[k];
    let (bw, bm, be) = (n("site-bay-w"), n("site-bay"), n("site-bay-e"));
    let (stand, stand_w2, stand_e, stand_e2) = (
        n("yard-stand"),
        n("yard-stand-w2"),
        n("yard-stand-e"),
        n("yard-stand-e2"),
    );
    // Frames: the middle bay's A from the west stand, its B from the east stand; the west bay's from the west yard,
    // the east bay's from the east yard. Beams 1, 2 to the middle bay, 3, 4 to the west, 5, 6 to the east.
    let (ma, wa, wb) = (n("yard-frame-1"), n("yard-frame-2"), n("yard-frame-w"));
    let (mb, ea, eb) = (n("yard-frame-e1"), n("yard-frame-e2"), n("yard-frame-e3"));
    let beam: Vec<Id> = (1..=6).map(|k| n(&format!("yard-beam-{k}"))).collect();
    let parts = [
        ma, mb, wa, wb, ea, eb, beam[0], beam[1], beam[2], beam[3], beam[4], beam[5],
    ];
    let g = w.ground;
    let actors: Vec<Actor> = w.souls.iter().map(|s| Actor::Soul(*s)).collect();
    let (url, tokens) = gateway(&socket, &actors).await;
    let mut souls = Vec::new();
    for (k, t) in tokens.iter().enumerate() {
        souls.push(GwSoul::new(&url, t, &w, w.souls[k]).await);
    }
    let s = Site {
        w: &w,
        g,
        crew: pinned_activity(&w, "mars:carry_activity"),
    };
    if let Ok(t) = std::env::var("A4_WAIT") { std::thread::sleep(Duration::from_secs(t.parse().unwrap())); }
    // As built: every node, where each part rests, and the slots' places (the bays and stands never move).
    let built: std::collections::BTreeSet<Id> = {
        let (copy, _) = served_copy(&w);
        let t = copy.tree();
        let mut out = std::collections::BTreeSet::new();
        let mut stack = vec![t.handle(w.root).unwrap()];
        while let Some(h) = stack.pop() {
            out.insert(t.node(h).unwrap().id());
            stack.extend(t.children(h).unwrap_or(&[]).iter().copied());
        }
        out
    };
    let start: Vec<_> = parts.iter().map(|p| where_is(&w, *p)).collect();
    let home = |k: usize| start[k].2;
    let (ua, ub, ll, lr) = (
        slots["upright_a"],
        slots["upright_b"],
        slots["beam_low_l"],
        slots["beam_low_r"],
    );
    let places = |bay: Id| {
        let (copy, _) = served_copy(&w);
        let t = copy.tree();
        let p = sim::ground::scene::slot_points(t, t.handle(bay).unwrap(), t.handle(g).unwrap())
            .unwrap();
        let at = |k: u64| p.iter().find(|(n, _)| *n == k).unwrap().1;
        (at(ua), at(ub), at(ll), at(lr))
    };
    let (w_a, w_b, w_l, w_r) = places(bw);
    let (m_a, m_b, m_l, m_r) = places(bm);
    let (e_a, e_b, e_l, e_r) = places(be);
    let refused = |got: &Got, name: &str, what: &str| {
        println!("{what}: {got:?}");
        assert_eq!((got.kind, got.reason.as_str()), (2, name), "{what}");
    };
    let [s1, s2, s3, s4, s5, s6] = &mut souls[..] else {
        unreachable!()
    };

    // Build. The middle bay: team 1 carries frame A into `upright_a` while team 2 carries its frame from the east
    // yard to wait 0.9 m north of it, inside the bay.
    let wait_a = v3(m_a.x, 0, m_a.z + 900_000);
    let (to_ma, to_wait, to_ea, to_wa) = ([m_a], [wait_a], [e_a], [w_a]);
    let (crew_ma, crew_mb) = tokio::join!(
        carry_in(
            &s,
            s1,
            s2,
            ma,
            frame_ends,
            &to_ma,
            into_slot(bm, ua),
            "team 1 seats frame A in the middle bay"
        ),
        take_along(
            &s,
            s4,
            s5,
            mb,
            frame_ends,
            &to_wait,
            "team 2 brings frame B to the middle bay"
        ),
    );
    leave_crew(s2, crew_ma, "Soul 2 lets go of frame A; Soul 1 holds it").await;
    let was = where_is(&w, crew_mb);
    let got = s4.act("part:put", crew_mb, into_slot(bm, ua)).await;
    refused(
        &got,
        "slot.occupied",
        "team 2 puts its frame in upright_a, where team 1's frame stands",
    );
    assert_eq!(
        where_is(&w, ma).0,
        Some(bm),
        "frame A still in the middle bay"
    );
    assert_eq!(
        where_is(&w, mb).0,
        Some(crew_mb),
        "team 2's frame still rides its crew"
    );
    assert_eq!(where_is(&w, crew_mb), was, "and nothing moved");
    // Team 2 brings its frame round frame A (east, then north) to 0.9 m east of `upright_b`, while Soul 2 of team 1
    // stands where frame B's west column would be.
    let round = [
        v3(m_a.x + 2_000_000, 0, wait_a.z),
        v3(m_a.x + 2_000_000, 0, m_b.z),
        v3(m_b.x + 900_000, 0, m_b.z),
    ];
    let column = v3(m_b.x - 572_000, 0, m_b.z);
    let ((), got) = tokio::join!(
        async {
            for at in round {
                walk_two(&s, s4, s5, frame_ends(at), "team 2 round frame A").await;
            }
        },
        s2.act("eden:walk", g, to_point(column)),
    );
    assert_eq!(got.kind, 1, "Soul 2 to upright_b: {got:?}");
    let was = where_is(&w, crew_mb);
    let got = s4.act("part:put", crew_mb, into_slot(bm, ub)).await;
    refused(
        &got,
        "site.occupied",
        "team 2 puts its frame in upright_b, where Soul 2 of team 1 stands",
    );
    assert_eq!(
        where_is(&w, mb).0,
        Some(crew_mb),
        "team 2's frame still rides its crew"
    );
    assert_eq!(where_is(&w, crew_mb), was, "and nothing moved");
    // Soul 2 steps out to help holder 3 take frame A from Soul 1; then team 2's frame goes in and holder 6 takes it.
    let hold_ma = hand_over(
        &s,
        s3,
        s2,
        s1,
        crew_ma,
        ma,
        hold_places(m_a, 1, -1),
        "holder 3 takes frame A from Soul 1",
    )
    .await;
    let got = put_part(s4, crew_mb, into_slot(bm, ub)).await;
    println!("team 2 seats frame B in the middle bay, Soul 2 gone: {got:?}");
    assert_eq!(got.kind, 1, "frame B seated");
    leave_crew(s4, crew_mb, "Soul 4 lets go of frame B; Soul 5 holds it").await;
    let hold_mb = hand_over(
        &s,
        s6,
        s4,
        s5,
        crew_mb,
        mb,
        hold_places(m_b, 1, 1),
        "holder 6 takes frame B from Soul 5",
    )
    .await;
    // Team 1 seats the middle bay's beams from the west while team 2 seats the east bay's frame A.
    let ((), crew_ea) = tokio::join!(
        async {
            beam_in(
                &s,
                s1,
                s2,
                beam[0],
                bm,
                ll,
                m_l,
                "team 1 seats beam 1 in the middle bay",
            )
            .await;
            beam_in(
                &s,
                s1,
                s2,
                beam[1],
                bm,
                lr,
                m_r,
                "team 1 seats beam 2 in the middle bay",
            )
            .await;
        },
        carry_in(
            &s,
            s4,
            s5,
            ea,
            frame_ends,
            &to_ea,
            into_slot(be, ua),
            "team 2 seats frame A in the east bay"
        ),
    );
    leave_crew(
        s4,
        crew_ea,
        "Soul 4 lets go of the east frame A; Soul 5 holds it",
    )
    .await;
    leave_crew(s3, hold_ma, "holder 3 lets go").await;
    leave_crew(s6, hold_mb, "holder 6 lets go").await;
    let (parts_in, held) = bay_holds(&w, bm);
    println!("the middle bay stands: {parts_in} parts in it, {held} crews holding them");
    assert_eq!(
        (parts_in, held),
        (4, 0),
        "the middle bay stands on its joints"
    );

    // The east bay by team 2 and the holders, while team 1 seats the west bay's frame A.
    let (crew_wa, (hold_ea, hold_eb)) = tokio::join!(
        carry_in(
            &s,
            s1,
            s2,
            wa,
            frame_ends,
            &to_wa,
            into_slot(bw, ua),
            "team 1 seats frame A in the west bay"
        ),
        async {
            let hold_ea = hand_over(
                &s,
                s6,
                s4,
                s5,
                crew_ea,
                ea,
                hold_places(e_a, -1, -1),
                "holder 6 takes east frame A from Soul 5",
            )
            .await;
            let via = [v3(e_b.x + 3_000_000, 0, e_b.z), e_b];
            let crew_eb = carry_in(
                &s,
                s4,
                s5,
                eb,
                frame_ends,
                &via,
                into_slot(be, ub),
                "team 2 seats frame B in the east bay",
            )
            .await;
            leave_crew(s4, crew_eb, "Soul 4 lets go of the east frame B").await;
            let hold_eb = hand_over(
                &s,
                s3,
                s4,
                s5,
                crew_eb,
                eb,
                hold_places(e_b, -1, 1),
                "holder 3 takes east frame B from Soul 5",
            )
            .await;
            beam_in(
                &s,
                s4,
                s5,
                beam[4],
                be,
                lr,
                e_r,
                "team 2 seats beam 5 in the east bay",
            )
            .await;
            beam_in(
                &s,
                s4,
                s5,
                beam[5],
                be,
                ll,
                e_l,
                "team 2 seats beam 6 in the east bay",
            )
            .await;
            (hold_ea, hold_eb)
        },
    );
    leave_crew(s6, hold_ea, "holder 6 lets go").await;
    leave_crew(s3, hold_eb, "holder 3 lets go").await;
    let (parts_in, held) = bay_holds(&w, be);
    println!("the east bay stands: {parts_in} parts in it, {held} crews holding them");
    assert_eq!(
        (parts_in, held),
        (4, 0),
        "the east bay stands on its joints"
    );
    // The west bay by team 1 and the holders.
    leave_crew(
        s1,
        crew_wa,
        "Soul 1 lets go of the west frame A; Soul 2 holds it",
    )
    .await;
    let hold_wa = hand_over(
        &s,
        s3,
        s1,
        s2,
        crew_wa,
        wa,
        hold_places(w_a, 1, -1),
        "holder 3 takes west frame A from Soul 2",
    )
    .await;
    let via = [v3(w_b.x - 3_000_000, 0, w_b.z), w_b];
    let crew_wb = carry_in(
        &s,
        s1,
        s2,
        wb,
        frame_ends,
        &via,
        into_slot(bw, ub),
        "team 1 seats frame B in the west bay",
    )
    .await;
    leave_crew(s1, crew_wb, "Soul 1 lets go of the west frame B").await;
    let hold_wb = hand_over(
        &s,
        s6,
        s1,
        s2,
        crew_wb,
        wb,
        hold_places(w_b, 1, 1),
        "holder 6 takes west frame B from Soul 2",
    )
    .await;
    beam_in(
        &s,
        s1,
        s2,
        beam[2],
        bw,
        ll,
        w_l,
        "team 1 seats beam 3 in the west bay",
    )
    .await;
    beam_in(
        &s,
        s1,
        s2,
        beam[3],
        bw,
        lr,
        w_r,
        "team 1 seats beam 4 in the west bay",
    )
    .await;
    leave_crew(s3, hold_wa, "holder 3 lets go").await;
    leave_crew(s6, hold_wb, "holder 6 lets go").await;
    for (bay, name) in [(bw, "west"), (bm, "middle"), (be, "east")] {
        let (parts_in, held) = bay_holds(&w, bay);
        println!("the {name} bay stands: {parts_in} parts in it, {held} crews holding them");
        assert_eq!(
            (parts_in, held),
            (4, 0),
            "the {name} bay stands, nobody holding it"
        );
    }

    // Take down. The west bay: the holders take its frames again; team 1 takes its beams out and lays each where it
    // lay; then frame B out and to its stand, then frame A out.
    let hold_wa = hold_frame(
        &s,
        s3,
        s1,
        wa,
        hold_places(w_a, 1, -1),
        "holder 3 takes west frame A again",
    )
    .await;
    let hold_wb = hold_frame(
        &s,
        s6,
        s2,
        wb,
        hold_places(w_b, 1, 1),
        "holder 6 takes west frame B again",
    )
    .await;
    beam_out(
        &s,
        s1,
        s2,
        beam[3],
        w_r,
        home(9),
        "team 1 takes beam 4 out of the west bay",
    )
    .await;
    beam_out(
        &s,
        s1,
        s2,
        beam[2],
        w_l,
        home(8),
        "team 1 takes beam 3 out of the west bay",
    )
    .await;
    let out = frame_crew(&s, s1, s2, s6, hold_wb, wb, w_b, "team 1 on west frame B").await;
    let via = [v3(w_b.x - 3_000_000, 0, w_b.z)];
    frame_home(
        &s,
        s1,
        s2,
        out,
        wb,
        &via,
        (stand_w2, 1, home(3)),
        "team 1 takes west frame B home",
    )
    .await;
    let out_wa = frame_crew(&s, s1, s2, s3, hold_wa, wa, w_a, "team 1 on west frame A").await;
    // The east bay by team 2 and the holders, while team 1 carries west frame A home.
    let ((), out_ea) = tokio::join!(
        frame_home(
            &s,
            s1,
            s2,
            out_wa,
            wa,
            &[],
            (stand, 2, home(2)),
            "team 1 takes west frame A home"
        ),
        async {
            let hold_ea = hold_frame(
                &s,
                s3,
                s4,
                ea,
                hold_places(e_a, -1, -1),
                "holder 3 takes east frame A again",
            )
            .await;
            let hold_eb = hold_frame(
                &s,
                s6,
                s5,
                eb,
                hold_places(e_b, -1, 1),
                "holder 6 takes east frame B again",
            )
            .await;
            beam_out(
                &s,
                s4,
                s5,
                beam[5],
                e_l,
                home(11),
                "team 2 takes beam 6 out of the east bay",
            )
            .await;
            beam_out(
                &s,
                s4,
                s5,
                beam[4],
                e_r,
                home(10),
                "team 2 takes beam 5 out of the east bay",
            )
            .await;
            let out = frame_crew(&s, s4, s5, s6, hold_eb, eb, e_b, "team 2 on east frame B").await;
            let via = [v3(e_b.x + 3_000_000, 0, e_b.z)];
            frame_home(
                &s,
                s4,
                s5,
                out,
                eb,
                &via,
                (stand_e2, 1, home(5)),
                "team 2 takes east frame B home",
            )
            .await;
            frame_crew(&s, s4, s5, s3, hold_ea, ea, e_a, "team 2 on east frame A").await
        },
    );
    // The middle bay: team 1 takes its beams out while team 2 carries east frame A home; then each team its frame.
    let ((), (out_ma, hold_mb)) = tokio::join!(
        frame_home(
            &s,
            s4,
            s5,
            out_ea,
            ea,
            &[],
            (stand_e, 2, home(4)),
            "team 2 takes east frame A home"
        ),
        async {
            let hold_ma = hold_frame(
                &s,
                s3,
                s1,
                ma,
                hold_places(m_a, 1, -1),
                "holder 3 takes frame A again",
            )
            .await;
            let hold_mb = hold_frame(
                &s,
                s6,
                s2,
                mb,
                hold_places(m_b, 1, 1),
                "holder 6 takes frame B again",
            )
            .await;
            beam_out(
                &s,
                s1,
                s2,
                beam[1],
                m_r,
                home(7),
                "team 1 takes beam 2 out of the middle bay",
            )
            .await;
            beam_out(
                &s,
                s1,
                s2,
                beam[0],
                m_l,
                home(6),
                "team 1 takes beam 1 out of the middle bay",
            )
            .await;
            (
                frame_crew(&s, s1, s2, s3, hold_ma, ma, m_a, "team 1 on frame A").await,
                hold_mb,
            )
        },
    );
    let out_mb = frame_crew(&s, s4, s5, s6, hold_mb, mb, m_b, "team 2 on frame B").await;
    // The holders stood east of the bay, where team 2 carries frame B home: they step out of its way first.
    let aside = (
        v3(m_a.x - 2_000_000, 0, -32_000_000),
        v3(m_a.x + 2_000_000, 0, -32_000_000),
    );
    walk_two(&s, s3, s6, aside, "the holders step out of team 2's way").await;
    // Each frame leaves the row between the bays and goes home with its carriers either side of the bays' middle line,
    // as the beams do. Walkers still go round the west and east bays' frames where they stood before they went home
    // (a take is not written to the walkers' map): a carrier walking 0.6 m from where one stood goes round it, its
    // partner walks straight, and the carry breaks off `souls:carriers-apart` (seen in this test; its own fix, outside
    // A4).
    let a_out = [
        v3(m_a.x - 2_000_000, 0, m_a.z),
        v3(m_a.x - 2_000_000, 0, -24_000_000),
        v3(m_a.x - 7_000_000, 0, -24_000_000),
    ];
    let b_out = [
        v3(m_b.x + 2_000_000, 0, m_b.z),
        v3(m_b.x + 2_000_000, 0, -24_000_000),
        v3(m_b.x + 7_000_000, 0, -24_000_000),
    ];
    tokio::join!(
        frame_home(
            &s,
            s1,
            s2,
            out_ma,
            ma,
            &a_out,
            (stand, 1, home(0)),
            "team 1 takes frame A home"
        ),
        frame_home(
            &s,
            s4,
            s5,
            out_mb,
            mb,
            &b_out,
            (stand_e, 1, home(1)),
            "team 2 takes frame B home"
        ),
    );

    // Every part where it started, under its id; every node of the world as built still there; the log replays.
    for (p, was) in parts.iter().zip(&start) {
        let now = where_is(&w, *p);
        println!(
            "part {}: was in {:?} slot {:?} at ({}, {}) mm, now in {:?} slot {:?} at ({}, {}) mm",
            p.counter(),
            was.0.map(|i| i.counter()),
            was.1,
            was.2.x / 1000,
            was.2.z / 1000,
            now.0.map(|i| i.counter()),
            now.1,
            now.2.x / 1000,
            now.2.z / 1000
        );
        assert_eq!((now.0, now.1), (was.0, was.1), "back where it started");
        let off =
            (i128::from(now.2.x - was.2.x).pow(2) + i128::from(now.2.z - was.2.z).pow(2)).isqrt();
        assert!(off < 5_000, "within 5 mm of where it lay: {off} µm");
    }
    let (copy, _) = served_copy(&w);
    let t = copy.tree();
    let missing: Vec<Id> = built
        .iter()
        .filter(|id| t.handle(**id).is_none())
        .copied()
        .collect();
    assert!(
        missing.is_empty(),
        "every node as built is still there: {missing:?}"
    );
    println!(
        "{} nodes as built, all still there; the log replays to here",
        built.len()
    );
    if let Ok(t) = std::env::var("A4_HOLD") { std::thread::sleep(Duration::from_secs(t.parse().unwrap())); }
}
