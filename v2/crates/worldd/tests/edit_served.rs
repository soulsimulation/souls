//! Engine v2 G1e (#3532): a world served by `worldd serve` is edited by its one creator, as its record in the directory
//! names it, through a real gateway; and BUILDSAFE refuses, by name, an edit that would bury a Soul.
//!
//! - **A1** (N2's test world): the store's list row and name record name the creator; `serve` prints it at the start.
//!   Another creator's edit is refused `edit.not-the-creator`; the named creator's commits.
//! - **A2, A3** (seeded Eden, `--ignored`: needs the exported Eden facts file): 21 Souls stand in a row on the open
//!   ground, 20 of them walking. A wall where the 21st stands is refused `edit.would-bury`; once it has walked away,
//!   the same wall commits. Each edit's answer is timed through the gateway, beside the 20 walkers.

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
use replica::edit::wire::{VERB, parameters};
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
        let runtime = replica::world_model::Kind {
            owner: "activity".into(),
            children: Default::default(),
            slots: Default::default(),
            hands: None,
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

fn creator(n: u8) -> (Id, Actor) {
    let id = Id::new(Scope([n; 16]), 1).unwrap();
    (id, Actor::Creator(id))
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

/// The Souls' row on Eden: 21 places 2 m apart along x from (x0, z0) m, each clear for 8 m to the north, and the walls'
/// places east of the row (x0 + 44 to x0 + 50 m), all on the open ground.
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

    // The 20 walkers set off north, 8 m each; the 21st stands at the row's east end.
    let mut souls = connect_socket(&socket);
    for (k, &body) in w.souls.iter().enumerate().take(20) {
        let x = (x0 + 2 * k as i64) * M;
        walk(&mut souls, &w, body, 1, x, (z0 + 8) * M);
    }
    let stander = w.souls[20];
    let (sx, sz) = ((x0 + 40) * M, z0 * M);
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
    walk(&mut souls, &w, stander, 1, sx, sz + 6 * M);
    // Walks answer at their ends: all 21, the 21st's among them.
    souls
        .set_read_timeout(Some(Duration::from_secs(60)))
        .unwrap();
    for _ in 0..21 {
        let got = socket_answer(&mut souls);
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
#[ignore = "needs the exported static Eden facts file"]
async fn g1f_a1_committed_seat_is_usable_and_occupied_removal_is_refused() {
    let text = std::fs::read_to_string(std::env::var("EDEN_FACTS").expect("EDEN_FACTS")).unwrap();
    let im = import_eden::load(&text).unwrap();
    let source = im
        .tree
        .node(im.tree.handle(im.nodes["e_0fc49dc9"]).unwrap())
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
    let (sat, _) = send(&mut soul, ask(1, "eden:sit", Some(chair))).await;
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
    let (rose, _) = send(&mut soul, ask(2, "eden:rise", None)).await;
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
    let (gone, _) = send(&mut soul, ask(3, "eden:sit", Some(chair))).await;
    assert_eq!(gone.kind, 2, "a retired seat cannot take a body: {gone:?}");
    println!(
        "G1f occupied removal: {}; rise receipt {:?}; removal receipt {:?}; retired seat: {}",
        blocked.reason, rose.entries, removed.entries, gone.reason
    );
}

#[path = "edit_served/k18d.rs"]
mod k18d;

/// #3697: a creator's own kind stands as its record's bounds say, through the one loader. A hedge defined by the
/// creator, placed across a Soul's way, commits; the Soul's real walk past it ends at its goal; on the served log
/// (replayed whole) the hedge holds its solids and the committed town's route goes round it. Placed where a Soul
/// stands it is refused `edit.would-bury`, as g1e's boot wall is (both need BUILDSAFE's served bury check).
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the exported Eden facts file (EDEN_FACTS)"]
async fn p3697_a_creator_kind_buries_no_soul_and_souls_walk_round_it() {
    use replica::kinds::defined;
    let text = std::fs::read_to_string(std::env::var("EDEN_FACTS").expect("EDEN_FACTS")).unwrap();
    let (x0, z0) = clear_row(&text);
    let d = scratch("k3697");
    let w = seed(&d, &text, 2, (x0, z0));
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
    let end = |s: &mut UnixStream| loop {
        let got = socket_answer(s);
        if got.kind != 3 {
            return got;
        }
    };
    for (k, &body) in w.souls.iter().enumerate() {
        walk(&mut souls, &w, body, 1, (x0 + 2 * k as i64) * M, z0 * M);
        let got = end(&mut souls);
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
    let got = end(&mut souls);
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
    let mut town = committed_town(&copy, rules, w.ground);
    let who = Id::new(Scope([0xdd; 16]), 1).unwrap();
    let frame = replica::pose::Frame {
        node: w.ground,
        slot: None,
    };
    let body = town.surfaces[&w.ground]
        .place(who, frame, Vec3::new(wx, 0, (z0 + 1) * M), Quat::IDENTITY)
        .unwrap();
    let legs = town
        .view()
        .plan(&body, w.ground, Vec3::new(wx, 0, (z0 + 5) * M))
        .expect("a way round the hedge");
    let widest = legs.iter().map(|l| (l.to.x - wx).abs()).max().unwrap_or(0);
    println!(
        "the committed route round the hedge: {} legs, widest {} mm from the straight line",
        legs.len(),
        widest / 1000
    );
    assert!(
        widest >= 3 * M,
        "the route goes round the hedge's 3 m half-width: {legs:?}"
    );
    // On the first Soul, where it stands: refused by BUILDSAFE's name, as a boot thing would be.
    let (got, _) = send(
        &mut ws,
        edit_intent(&w, creator, 4, version, hedge(x0 * M, z0 * M)),
    )
    .await;
    println!("a creator's hedge where a Soul stands: {got:?}");
    assert_eq!((got.kind, got.reason.as_str()), (2, "edit.would-bury"));

    drop(s);
}
