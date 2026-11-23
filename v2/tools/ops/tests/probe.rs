//! O18c (#3524): a release's probe never drives anyone's Soul. A world with seeded Souls (I4's world, each Soul with a
//! toggle of its own) is served on a socket as `worldd serve` serves one; the canary watches it with the release's
//! probe and the world is restarted mid-window.
// A canary's window is wall-clock time (the wall-clock rule, K7, is the engine's).
#![allow(clippy::disallowed_methods)]

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use replica::effects::{Actor, read_id};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Intent, Target};
use replica::sync::wire;
use sim::log::{FileStore, recover};
use supervisor::deploy::{ANSWERED, Canary, Probe, now_us, watch};
use worldd::answers::{self, Config, World};
use worldd::checkers::toggles;

const LINEAGE: Scope = Scope([0x18; 16]);
const SOULS: usize = 3;

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("o18c-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// The world on its log in `d`, served on `d/gateway.sock` (a start, or a restart from the same log).
fn serve(d: &Path) -> (World, Vec<(Id, Id)>) {
    let built = toggles::World::build(1, SOULS, 0);
    let mut cfg = Config::new(LINEAGE, 1);
    cfg.tick = Duration::from_millis(10);
    let store = FileStore::open(&d.join("log")).unwrap();
    let world = answers::start(built.replica, toggles::rules(), store, cfg).unwrap();
    let sock = d.join("gateway.sock");
    let _ = std::fs::remove_file(&sock);
    let listener = UnixListener::bind(&sock).unwrap();
    let door = world.door();
    std::thread::spawn(move || {
        for s in listener.incoming().flatten() {
            let door = door.clone();
            std::thread::spawn(move || answers::serve(door, s));
        }
    });
    (world, built.pairs)
}

/// The world's version and its root's hash, by one sync ask of the test's own.
fn root(d: &Path) -> (Value, Value) {
    let mut s = UnixStream::connect(d.join("gateway.sock")).unwrap();
    let ask = encode(&Value::Map(BTreeMap::from([
        (wire::ASK, Value::Uint(1)),
        (wire::IDS, Value::Array(Vec::new())),
    ])))
    .unwrap();
    s.write_all(&(ask.len() as u32).to_be_bytes()).unwrap();
    s.write_all(&ask).unwrap();
    let mut len = [0u8; 4];
    s.read_exact(&mut len).unwrap();
    let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
    s.read_exact(&mut frame).unwrap();
    let Value::Map(m) = decode(&frame).unwrap().value else {
        panic!("a sync answer")
    };
    (m[&1].clone(), m[&wire::IDS].clone())
}

/// The Souls whose intents the world's log answered.
fn answered_souls(d: &Path) -> BTreeSet<Id> {
    let bytes = std::fs::read(d.join("log")).unwrap();
    let mut souls = BTreeSet::new();
    for r in recover(&bytes).unwrap().records {
        let Ok(Value::Map(part)) = decode(&r).map(|d| d.value) else {
            continue;
        };
        let Some(Value::Array(rows)) = part.get(&ANSWERED) else {
            continue;
        };
        for row in rows {
            let Value::Map(row) = row else { continue };
            // The actor's encoded bytes: `{1: kind, 2: id}`.
            let Some(Value::Map(actor)) = (match row.get(&1) {
                Some(Value::Bytes(b)) => decode(b).ok().map(|d| d.value),
                _ => None,
            }) else {
                continue;
            };
            if let Some(id) = actor.get(&2).and_then(|v| read_id(v).ok()) {
                souls.insert(id);
            }
        }
    }
    souls
}

fn canary(window_ms: u64) -> Canary {
    Canary {
        window: Duration::from_millis(window_ms),
        start_within: Duration::from_secs(10),
        answer_within: Duration::from_secs(5),
        every: Duration::from_millis(50),
    }
}

/// A1, A2: the release's probe, through a restart mid-window, leaves the world as it was: no Soul's intent answered,
/// the same version and the same root hash, so no body was added and none moved.
#[test]
fn a1_a2_the_release_probe_drives_no_soul_and_leaves_no_body() {
    let d = dir("ask");
    let (world, _) = serve(&d);
    let before = root(&d);
    let sock = d.join("gateway.sock");
    let watching =
        std::thread::spawn(move || watch(&sock, &canary(2_000), &mut Probe::Ask(0), false));
    std::thread::sleep(Duration::from_millis(700));
    world.stop();
    let (world, _) = serve(&d);
    assert_eq!(
        watching.join().unwrap(),
        Ok(()),
        "the probe is answered across the restart"
    );
    let after = root(&d);
    world.stop();
    assert_eq!(
        answered_souls(&d),
        BTreeSet::new(),
        "no Soul's intent in the log"
    );
    assert_eq!(
        before, after,
        "the world's version and root hash are as they were"
    );
}

/// The control: an act probe of a Soul is in the same log, by that Soul, and moves the world on, so the checks above
/// would catch a probe that drove anyone.
#[test]
fn a1_control_an_act_probe_is_seen() {
    let d = dir("act");
    let (world, pairs) = serve(&d);
    let before = root(&d);
    let (soul, thing) = pairs[0];
    let n = |s: &str| Name::new(s).unwrap();
    let act = Intent {
        actor: Actor::Soul(soul),
        verb: n("r2:switch_on"),
        target: Some(Target::Node(thing)),
        parameters: BTreeMap::new(),
        sequence: 0,
        basis: Version {
            lineage: LINEAGE,
            zone: Id::new(LINEAGE, 0).unwrap(),
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        expiry: now_us() + 5_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    let r = watch(
        &d.join("gateway.sock"),
        &canary(200),
        &mut Probe::Act(Box::new(act)),
        true,
    );
    let after = root(&d);
    world.stop();
    assert_eq!(r, Ok(()));
    assert_eq!(answered_souls(&d), BTreeSet::from([soul]));
    assert_ne!(before, after, "the act changed the world");
}

// O18d uses C3's real lifecycle, not the older toggle fixture's pre-existing bodies.
fn probe_family() -> replica::bodies::Family {
    use replica::bodies::{Class, Family, Resource};
    Family {
        name: Name::new("souls:humanoid").unwrap(),
        resources: ["souls:leg-left", "souls:leg-right"]
            .into_iter()
            .map(|name| Resource {
                name: Name::new(name).unwrap(),
                class: Class::Locomotion,
                slot: None,
            })
            .collect(),
    }
}

fn joined_fixture() -> (
    replica::apply::Replica,
    sim::walk::town::Town,
    answers::Join,
) {
    use replica::effects::{Effect, Part};
    use replica::pose::Vec3;
    let mut im = import_eden::load(&testworld::generate(1, 0).unwrap().text).unwrap();
    // Match worldd serve's replica root admission (also used by the served loose-body fixture).
    im.rules.kinds.extend(
        replica::world_model::parse_kinds(&format!(
            "{{1: \"souls:place\", 2: \"place\", 11: [\"{}\"]}}",
            import_eden::GROUND
        ))
        .unwrap(),
    );
    let body = replica::world_model::parse_kinds(
        "{1: \"souls:body\", 2: \"family\", 6: {1: [\"thing\"], 2: [\"thing\"]}} ",
    )
    .unwrap();
    let body_kind = body.keys().next().unwrap().clone();
    im.rules.kinds.extend(body);
    for (name, kind) in &mut im.rules.kinds {
        if name.starts_with("eden:ground@") {
            kind.children.insert("body".into());
        }
    }
    let ground = im.nodes["ground"];
    let header = import_eden::header(im.nodes["world"], &im.rules).unwrap();
    let part = Part::read(
        &encode(&Value::Map(BTreeMap::from([
            (1, Value::Bytes(header.hash().to_bytes())),
            (
                2,
                Value::Array(im.effects.iter().map(Effect::to_value).collect()),
            ),
        ])))
        .unwrap(),
    )
    .unwrap();
    let mut replica = replica::apply::Replica::start(header.stored()).unwrap();
    replica.apply(&part).unwrap();
    let next = im.tree.to_state().next;
    let town = sim::walk::town::Town::new(
        im.tree,
        ground,
        sim::links::Doors::new(header, im.rules, next),
    )
    .unwrap();
    let join = answers::Join {
        entry: (ground, Vec3::new(-40_000_000, 0, 30_000_000)),
        family: probe_family(),
        kind: Name::new(&body_kind).unwrap(),
        per_tick: 8,
    };
    (replica, town, join)
}

#[derive(Clone, Copy)]
enum ProbeFault {
    None,
    RefuseActs,
    RefuseAfterJoin,
    LoseJoinAck,
}

fn joined_server(d: &Path, fault: ProbeFault) -> World {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::channel,
    };
    let (replica, town, join) = joined_fixture();
    let mut cfg = Config::new(replica.header().lineage, 1);
    cfg.tick = Duration::from_millis(10);
    cfg.bodies = Some(Box::new(move |placed: &worldd::bodies::Placed| {
        let mut bodies = worldd::bodies::Bodies::new(town, 10_000)?;
        for (&id, (pose, _)) in placed {
            let moved = bodies.town.surfaces[&pose.frame.node].place(
                id,
                pose.frame,
                pose.position,
                pose.orientation,
            )?;
            bodies.add_body_at(probe_family(), moved, placed)?;
        }
        Ok(bodies)
    }));
    cfg.join = Some(join);
    let world = answers::start(
        replica,
        toggles::rules(),
        FileStore::open(&d.join("log")).unwrap(),
        cfg,
    )
    .unwrap();
    let sock = d.join("gateway.sock");
    let _ = std::fs::remove_file(&sock);
    let listener = UnixListener::bind(sock).unwrap();
    let door = world.door();
    let lost = Arc::new(AtomicBool::new(false));
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (door, lost) = (door.clone(), lost.clone());
            std::thread::spawn(move || {
                let mut stream = stream;
                loop {
                    let mut len = [0; 4];
                    if stream.read_exact(&mut len).is_err() {
                        return;
                    }
                    let mut bytes = vec![0; u32::from_be_bytes(len) as usize];
                    if stream.read_exact(&mut bytes).is_err() {
                        return;
                    }
                    let intent = Intent::read(&bytes).ok();
                    let (reply, rx) = channel();
                    let refuses = intent.as_ref().is_some_and(|i| match fault {
                        ProbeFault::RefuseActs => true,
                        ProbeFault::RefuseAfterJoin => i.verb.as_str() != answers::JOIN,
                        _ => false,
                    });
                    let answer = if refuses {
                        let i = intent.as_ref().unwrap();
                        let a = replica::intents::Answer::Refused {
                            actor: i.actor,
                            sequence: i.sequence,
                            reason: Name::new("probe:refuses-all-acts").unwrap(),
                            now: i.basis.clone(),
                            changed: Vec::new(),
                            op: None,
                        };
                        encode(&Value::Map(BTreeMap::from([
                            (1, i.basis.clone()),
                            (2, a.to_value()),
                        ])))
                        .unwrap()
                    } else {
                        if !door.arrive(bytes, reply) {
                            return;
                        }
                        match rx.recv_timeout(Duration::from_secs(5)) {
                            Ok(a) => a,
                            Err(_) => return,
                        }
                    };
                    if matches!(fault, ProbeFault::LoseJoinAck)
                        && intent.is_some_and(|i| i.verb.as_str() == answers::JOIN)
                        && !lost.swap(true, Ordering::SeqCst)
                    {
                        return; // The real durable birth happened, but its owner did not receive the acknowledgement.
                    }
                    if stream
                        .write_all(&(answer.len() as u32).to_be_bytes())
                        .and_then(|()| stream.write_all(&answer))
                        .is_err()
                    {
                        return;
                    }
                }
            });
        }
    });
    world
}

fn probe_receipt(d: &Path) -> PathBuf {
    d.join("deploys/operator.probe")
}

fn parts(d: &Path) -> Vec<replica::effects::Part> {
    recover(&std::fs::read(d.join("log")).unwrap())
        .unwrap()
        .records
        .into_iter()
        .filter(|r| !sim::recorder::is_input(r))
        .map(|r| replica::effects::Part::read(&r).unwrap())
        .collect()
}

fn no_probe_bodies(d: &Path) {
    no_probe_bodies_except(d, &BTreeSet::new());
}

fn no_probe_bodies_except(d: &Path, users: &BTreeSet<Id>) {
    use replica::effects::{Body, Change};
    let mut bodies = BTreeSet::new();
    for part in parts(d) {
        for effect in part.effects {
            if let Body::Changes(changes) = effect.body {
                for c in changes {
                    match c.change {
                        Change::Link { ty, ends, .. } if ty.as_str() == "souls:body-of" => {
                            bodies.insert(ends[0]);
                        }
                        Change::Remove { node } => {
                            bodies.remove(&node);
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    assert_eq!(
        &bodies, users,
        "only the seeded users remain; every operator body actually retired"
    );
}

#[test]
fn o18d_a1_the_operator_act_has_exact_committed_effects_and_retires() {
    use replica::effects::{Body, Cause, Change};
    let d = dir("owned");
    let world = joined_server(&d, ProbeFault::None);
    let users: Vec<_> = (1..=3)
        .map(|n| Id::new(Scope([0x75; 16]), n).unwrap())
        .collect();
    for &soul in &users {
        seed_user(&d, soul);
    }
    let user_before = user_snapshot(&d, &users);
    let baseline = parts(&d).len();
    let receipt = probe_receipt(&d);
    let mut probe = Probe::operator(&receipt).unwrap();
    assert!(
        Probe::operator(&receipt).is_err(),
        "a second watcher cannot share the identity"
    );
    watch(&d.join("gateway.sock"), &canary(150), &mut probe, false).unwrap();
    assert!(
        !receipt.exists(),
        "verified retirement clears the recovery receipt"
    );
    world.stop();
    let parts = parts(&d);
    let effects: BTreeMap<_, _> = parts
        .iter()
        .flat_map(|p| &p.effects)
        .map(|e| (e.envelope.sequence, e))
        .collect();
    let mut acts = 0;
    for part in &parts {
        let Some(Value::Array(rows)) = part.rest.get(&ANSWERED) else {
            continue;
        };
        for row in rows {
            let Value::Map(row) = row else { continue };
            let Some(value) = row.get(&5) else { continue };
            let intent = Intent::read(&encode(value).unwrap()).unwrap();
            if intent.verb.as_str() != "eden:describe" {
                continue;
            }
            let Value::Bytes(frame) = &row[&4] else {
                panic!("a durable answer")
            };
            let Value::Map(frame) = decode(frame).unwrap().value else {
                panic!("a frame")
            };
            let Value::Map(answer) = &frame[&2] else {
                panic!("an answer")
            };
            let Value::Map(sent) = intent.to_value() else {
                panic!("intent")
            };
            assert_eq!(answer[&1], sent[&1], "exact ordinary actor");
            assert_eq!(answer[&2], Value::Uint(intent.sequence));
            assert_eq!(answer[&3], Value::Uint(1));
            let cause = read_id(&answer[&4]).unwrap();
            assert_eq!(row[&3], answer[&4]);
            let Value::Array(entries) = &answer[&5] else {
                panic!("entries")
            };
            assert!(!entries.is_empty());
            for entry in entries {
                let Value::Uint(n) = entry else {
                    panic!("entry number")
                };
                let e = effects[n];
                assert_eq!(e.envelope.actor, intent.actor);
                assert_eq!(e.envelope.cause, Cause::Intent(cause));
                assert!(
                    matches!(&e.body, Body::Changes(c) if c.iter().any(|c| matches!(c.change, Change::Set { field: 31, .. })))
                );
            }
            acts += 1;
        }
    }
    assert!(acts > 0, "an ordinary describe actually committed");
    assert_eq!(
        user_snapshot(&d, &users),
        user_before,
        "seeded user bodies do not change"
    );
    for part in parts.iter().skip(baseline) {
        for e in &part.effects {
            assert!(
                !matches!(e.envelope.actor, Actor::Soul(s) if users.contains(&s)),
                "no user intent is driven"
            );
            if let Body::Changes(c) = &e.body {
                for c in c {
                    let changed = match c.change {
                        Change::Set { node, .. } | Change::Remove { node } => Some(node),
                        _ => None,
                    };
                    assert!(
                        !changed.is_some_and(|n| user_before.contains_key(&n)),
                        "no user body is edited"
                    );
                }
            }
        }
    }
    no_probe_bodies_except(&d, &user_before.keys().copied().collect());
}

#[test]
fn o18d_a2_root_asks_do_not_hide_refused_acts_and_rollback_retires_pending_probe() {
    use std::os::unix::fs::PermissionsExt;
    use supervisor::deploy::{Deploy, Unit};
    const CHILD: &str = "SOULS_OPERATOR_ROLLBACK_CHILD";
    if std::env::var(CHILD).ok().as_deref() != Some("1") {
        // Isolate the short relative socket paths without changing the parallel test harness's cwd.
        let scratch = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .unwrap()
            .join(".local/p3575")
            .join(format!("rollback-{}", std::process::id()))
            .join("root");
        std::fs::create_dir_all(scratch.parent().unwrap()).unwrap();
        std::fs::create_dir(&scratch).unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "o18d_a2_root_asks_do_not_hide_refused_acts_and_rollback_retires_pending_probe",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .current_dir(&scratch)
            .status()
            .unwrap();
        assert!(status.success(), "the isolated rollback fixture passed");
        return;
    }
    let fixture = joined_fixture().0;
    let instance = supervisor::World {
        lineage: fixture.header().lineage.0,
        zone: fixture.header().zone,
    };
    // The subprocess already owns unique ignored checkout scratch; do not remove its cwd.
    let root = PathBuf::new();
    let state = supervisor::deploy::state_path(&root, &instance);
    assert!(
        state
            .join("gateway.sock")
            .as_os_str()
            .as_encoded_bytes()
            .len()
            < 104,
        "the complete fixture socket path fits SUN_LEN"
    );
    std::fs::create_dir_all(&state).unwrap();
    let world = joined_server(&state, ProbeFault::RefuseActs);
    assert_eq!(
        watch(
            &state.join("gateway.sock"),
            &canary(50),
            &mut Probe::Ask(0),
            true
        ),
        Ok(())
    );
    let receipt = root
        .join("deploys")
        .join(format!("{}.probe", instance.name()));
    let mut probe = Probe::operator(&receipt).unwrap();
    let refused = watch(&state.join("gateway.sock"), &canary(50), &mut probe, true).unwrap_err();
    assert!(refused.contains("probe:refuses-all-acts"), "{refused}");
    assert!(
        receipt.exists(),
        "uncertain cleanup is retained, never claimed complete"
    );
    // The root-only/refuse-every-act candidate above really failed. For rollback, leave an ACTUAL live body:
    // this next candidate admits birth, then refuses both the ordinary act and its retirement.
    world.stop();
    let healthy = joined_server(&state, ProbeFault::None);
    watch(&state.join("gateway.sock"), &canary(50), &mut probe, true).unwrap();
    drop(probe);
    healthy.stop();
    assert!(!receipt.exists());
    no_probe_bodies(&state);
    let world = joined_server(&state, ProbeFault::RefuseAfterJoin);
    let mut probe = Probe::operator(&receipt).unwrap();
    let refused = watch(&state.join("gateway.sock"), &canary(50), &mut probe, true).unwrap_err();
    assert!(refused.contains("probe:refuses-all-acts"), "{refused}");
    assert!(
        receipt.exists(),
        "actual pending body remains named for rollback"
    );
    let Value::Map(saved) = decode(&std::fs::read(&receipt).unwrap()).unwrap().value else {
        panic!("receipt")
    };
    let pending_actor = read_id(&saved[&1]).unwrap();
    assert_eq!(
        user_snapshot(&state, &[pending_actor]).len(),
        1,
        "the failed candidate left a live operator body"
    );
    struct Restart {
        state: PathBuf,
        world: Option<World>,
    }
    impl Unit for Restart {
        fn restart(&mut self) -> Result<(), String> {
            self.world.take().unwrap().stop();
            self.world = Some(joined_server(&self.state, ProbeFault::None));
            Ok(())
        }
    }
    let old = supervisor::build_hash(b"old rollback fixture");
    let new = supervisor::build_hash(b"new rollback fixture");
    for hash in [&old, &new] {
        let file = supervisor::build_path(&root, hash);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            &file,
            "#!/bin/sh\nprintf 'reads test-schema\\nwrites test-schema\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let store = supervisor::folder::Folder::new(root.join("directory"));
    supervisor::set_pin(&store, &instance, &new).unwrap();
    let deploy = Deploy {
        store: &store,
        root: &root,
        world: instance,
        canary: canary(100),
        window: 1,
    };
    let mut unit = Restart {
        state: state.clone(),
        world: Some(world),
    };
    deploy
        .roll_back(&old, &new, true, &mut unit, &mut probe, &mut |_| {})
        .unwrap();
    assert_eq!(supervisor::pin(&store, &root, &instance).unwrap().0, old);
    assert!(!receipt.exists());
    unit.world.take().unwrap().stop();
    no_probe_bodies(&state);
}

#[test]
fn o18d_a3_a_lost_join_ack_and_world_restart_leave_no_probe() {
    let d = dir("lost-ack");
    let world = joined_server(&d, ProbeFault::LoseJoinAck);
    let receipt = probe_receipt(&d);
    let mut probe = Probe::operator(&receipt).unwrap();
    let sock = d.join("gateway.sock");
    let watching = std::thread::spawn(move || {
        let result = watch(&sock, &canary(1_200), &mut probe, false);
        (result, probe)
    });
    std::thread::sleep(Duration::from_millis(400));
    world.stop();
    let world = joined_server(&d, ProbeFault::None);
    let (result, _probe) = watching.join().unwrap();
    assert_eq!(result, Ok(()));
    assert!(!receipt.exists());
    world.stop();
    no_probe_bodies(&d);
}

fn seed_user(d: &Path, soul: Id) {
    let intent = Intent {
        actor: Actor::Soul(soul),
        verb: Name::new("life:join").unwrap(),
        target: None,
        parameters: BTreeMap::from([(
            1,
            Value::Map(BTreeMap::from([(
                23,
                Value::Bytes(b"Seeded user".to_vec()),
            )])),
        )]),
        sequence: 0,
        basis: root(d).0,
        expiry: now_us() + 5_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
        reflex: false,
    };
    watch(
        &d.join("gateway.sock"),
        &canary(50),
        &mut Probe::Act(Box::new(intent)),
        true,
    )
    .unwrap();
}

type UserSnapshot = BTreeMap<
    Id,
    (
        Option<Id>,
        Option<replica::tree::Place>,
        BTreeMap<u64, Value>,
    ),
>;
fn user_snapshot(d: &Path, users: &[Id]) -> UserSnapshot {
    let mut replica = joined_fixture().0;
    for p in parts(d) {
        replica.apply(&p).unwrap();
    }
    let tree = replica.tree();
    users
        .iter()
        .map(|&soul| {
            let body = tree
                .links_at(soul)
                .iter()
                .find_map(|e| {
                    let (ty, [body, owner], _, _) = tree.link(e.link)?;
                    (ty.as_str() == "souls:body-of" && owner == soul).then_some(body)
                })
                .unwrap();
            let node = tree.node(tree.handle(body).unwrap()).unwrap();
            (body, (node.parent(), node.place(), node.fields().clone()))
        })
        .collect()
}

#[test]
fn o18d_a3_interrupted_operator_watch_recovers_its_pending_identity() {
    use std::process::{Command, Stdio};
    use std::time::Instant;
    const CHILD: &str = "SOULS_OPERATOR_WATCH_CHILD";
    if let Some(d) = std::env::var_os(CHILD).map(PathBuf::from) {
        let mut probe = Probe::operator(&probe_receipt(&d)).unwrap();
        watch(&d.join("gateway.sock"), &canary(60_000), &mut probe, false).unwrap();
        return;
    }
    let d = dir("interrupted");
    let world = joined_server(&d, ProbeFault::None);
    let receipt = probe_receipt(&d);
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "o18d_a3_interrupted_operator_watch_recovers_its_pending_identity",
            "--nocapture",
        ])
        .env(CHILD, &d)
        .stdout(Stdio::from(
            std::fs::File::create(d.join("child.log")).unwrap(),
        ))
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    let saved = loop {
        if let Ok(bytes) = std::fs::read(&receipt)
            && let Ok(Value::Map(m)) = decode(&bytes).map(|d| d.value)
            && m.get(&3) == Some(&Value::Uint(2))
        {
            break m;
        }
        assert!(
            Instant::now() < until,
            "the child reached its pending ordinary act"
        );
        std::thread::sleep(Duration::from_millis(5));
    };
    assert!(
        Probe::operator(&receipt).is_err(),
        "the live operator owns the stable lock"
    );
    child.kill().unwrap();
    child.wait().unwrap();
    let Value::Map(after) = decode(&std::fs::read(&receipt).unwrap()).unwrap().value else {
        panic!("receipt")
    };
    assert_eq!(
        after[&1], saved[&1],
        "the interrupted operator identity was not discarded"
    );
    let mut recovered = Probe::operator(&receipt).unwrap();
    watch(&d.join("gateway.sock"), &canary(100), &mut recovered, true).unwrap();
    assert!(!receipt.exists());
    world.stop();
    no_probe_bodies(&d);
    let owner = read_id(&saved[&1]).unwrap();
    let mut live = BTreeSet::new();
    let mut births = 0;
    for p in parts(&d) {
        for e in p.effects {
            if e.envelope.actor == Actor::Soul(owner)
                && let replica::effects::Body::Changes(c) = e.body
            {
                for c in c {
                    match c.change {
                        replica::effects::Change::Create { node, .. } => {
                            assert!(live.is_empty(), "old body retired before fresh watch birth");
                            live.insert(node);
                            births += 1;
                        }
                        replica::effects::Change::Remove { node } => {
                            live.remove(&node);
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    let mut joins = 0;
    for part in parts(&d) {
        let Some(Value::Array(rows)) = part.rest.get(&ANSWERED) else {
            continue;
        };
        for row in rows {
            let Value::Map(row) = row else { continue };
            let Some(value) = row.get(&5) else { continue };
            let intent = Intent::read(&encode(value).unwrap()).unwrap();
            if intent.actor == Actor::Soul(owner) && intent.verb.as_str() == answers::JOIN {
                joins += 1;
            }
        }
    }
    assert!(
        joins >= 3,
        "initial birth, already-born recovery join and fresh watch join all committed"
    );
    assert!(
        births >= 2 && live.is_empty(),
        "interrupted and fresh bodies both actually retired"
    );
}

#[test]
fn o18d_a4_scratch_rehearsal_commits_and_retires_its_own_probe() {
    use std::os::unix::fs::PermissionsExt;
    const CHILD: &str = "SOULS_OPERATOR_REHEARSAL_CHILD";
    if let Some(d) = std::env::var_os(CHILD).map(PathBuf::from) {
        let _world = joined_server(&d, ProbeFault::None);
        loop {
            std::thread::park();
        }
    }
    let d = dir("rehearsal");
    let state = d.join("state");
    std::fs::create_dir_all(&state).unwrap();
    let world = joined_server(&state, ProbeFault::None);
    let user = Id::new(Scope([0x77; 16]), 1).unwrap();
    seed_user(&state, user);
    world.stop();
    let before = user_snapshot(&state, &[user]);
    let script = d.join("build");
    let exe = std::env::current_exe().unwrap();
    let quoted = format!("'{}'", exe.to_string_lossy().replace('\'', "'\\''"));
    std::fs::write(&script, format!("#!/bin/sh\nexport {CHILD}=\"$3\"\nexec {quoted} --exact o18d_a4_scratch_rehearsal_commits_and_retires_its_own_probe --nocapture\n")).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let scratch = d.join("scratch");
    let mut probe = Probe::operator(&probe_receipt(&state)).unwrap();
    let r = supervisor::deploy::rehearse(&script, &state, &scratch, 0, &canary(100), &mut probe)
        .unwrap();
    assert!(r.served_kept && r.copied > 0);
    assert!(!scratch.join("operator.probe").exists());
    assert_eq!(user_snapshot(&scratch, &[user]), before);
    no_probe_bodies_except(&scratch, &before.keys().copied().collect());
    assert_eq!(
        user_snapshot(&state, &[user]),
        before,
        "served users are not driven by rehearsal"
    );
}
