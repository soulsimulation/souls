//! Engine v2 C12 (#3427): a Soul on a seeded Eden parks a bicycle in a real bike rack and takes it out again, through
//! Eden's own entries (`content/kinds/vehicles/bike_rack.json`), end to end: `worldd seed` from Eden's facts with
//! `--entries content/kinds`, `worldd serve`, and a client on the world's socket (I1's framing), as the gateway
//! speaks to it. The rack's `park` walks to the chosen stand's `front` point and puts the bicycle, wheeled beside the
//! body, into that stand; its `take_out` walks to `front` and takes the bicycle into a hand.
//!
//! Needs the generated Eden 2026 facts file (`v2/tools/import-eden/README.md`) and a built `worldd`:
//! `cargo test -p worldd --test eden -- --ignored --nocapture` from `v2/` (`EDEN_FACTS` names another file).

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use replica::effects::{Actor, Body, Part, TransferRec};
use replica::encode::{Name, Value, decode, encode};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Intent, Target};
use worldd::answers::{self, JOIN};

fn name(s: &str) -> Name {
    Name::new(s).unwrap()
}

/// The world's end of the gateway's socket, as one Soul.
struct Client(UnixStream, Id, u64, Scope);

impl Client {
    fn act(
        &mut self,
        verb: &str,
        target: Option<Id>,
        parameters: BTreeMap<u64, Value>,
    ) -> Result<Vec<u64>, String> {
        self.2 += 1;
        let i = Intent {
            actor: Actor::Soul(self.1),
            verb: name(verb),
            target: target.map(Target::Node),
            parameters,
            sequence: self.2,
            basis: Version {
                lineage: self.3,
                zone: Id::new(self.3, 0).unwrap(),
                epoch: 1,
                sequence: 0,
            }
            .to_value(),
            expiry: answers::now() + 120_000_000,
            resources: Vec::new(),
            fallbacks: Vec::new(),
            replaces: None,
            body: None,
        };
        let bytes = encode(&i.to_value()).unwrap();
        self.0
            .write_all(&u32::try_from(bytes.len()).unwrap().to_be_bytes())
            .unwrap();
        self.0.write_all(&bytes).unwrap();
        let mut len = [0u8; 4];
        self.0.read_exact(&mut len).expect("an answer");
        let mut frame = vec![0u8; u32::from_be_bytes(len) as usize];
        self.0.read_exact(&mut frame).unwrap();
        let Value::Map(m) = decode(&frame).unwrap().value else {
            panic!("a frame")
        };
        let Some(Value::Map(a)) = m.get(&2) else {
            panic!("an answer")
        };
        match (a.get(&3), a.get(&5), a.get(&4)) {
            (Some(Value::Uint(1)), Some(Value::Array(e)), _) => Ok(e
                .iter()
                .map(|v| if let Value::Uint(n) = v { *n } else { 0 })
                .collect()),
            (Some(Value::Uint(2)), _, Some(Value::Text(t))) => Err(t.as_str().to_owned()),
            other => panic!("an answer: {other:?}"),
        }
    }
}

struct Served(Child);

impl Drop for Served {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// `[[name, value], ...]`: a form's arguments, a thing by id, a slot by number.
fn args(pairs: &[(&str, Value)]) -> BTreeMap<u64, Value> {
    let a = pairs
        .iter()
        .map(|(k, v)| Value::Array(vec![Value::Bytes(k.as_bytes().to_vec()), v.clone()]))
        .collect();
    BTreeMap::from([(1, Value::Array(a))])
}

#[test]
#[ignore = "needs the generated Eden 2026 facts file and a built worldd (see the module doc)"]
fn a2_a_soul_parks_and_takes_out_a_bicycle_through_edens_own_rack() {
    let root = format!("{}/../../..", env!("CARGO_MANIFEST_DIR"));
    let facts = std::env::var("EDEN_FACTS")
        .unwrap_or_else(|_| format!("{root}/.local/import-eden/eden-2026.facts.json"));
    let im = import_eden::load(&std::fs::read_to_string(&facts).expect("the Eden facts file"))
        .expect("Eden loads");
    // The rack by the west gate (e_9e923006, at (53.8, 1.6) m) and the bicycle standing 400 mm west of it.
    let (rack, bike) = (im.nodes["e_9e923006"], im.nodes["e_a23bb167"]);
    let lineage = rack.scope();
    let dir = std::env::temp_dir().join(format!("c12-eden-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let worldd = env!("CARGO_BIN_EXE_worldd");
    // Births stand 1 m east of the entry: 1.2 m south-west of the rack's front.
    let seeded = Command::new(worldd)
        .args(["seed", "--facts", &facts, "--dir"])
        .arg(&dir)
        .args([
            "--entries",
            &format!("{root}/content/kinds"),
            "--souls",
            "0",
            "--at",
            "52.6,3.5",
        ])
        .output()
        .unwrap();
    println!("seed: {}", String::from_utf8_lossy(&seeded.stdout).trim());
    assert!(
        seeded.status.success(),
        "{}",
        String::from_utf8_lossy(&seeded.stderr)
    );
    let mut child = Command::new(worldd)
        .args(["serve", "--dir"])
        .arg(&dir)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let served = Served(child);
    let mut line = String::new();
    while out.read_line(&mut line).unwrap() > 0 && !line.contains("listening ") {
        print!("serve: {line}");
        line.clear();
    }
    print!("serve: {line}");
    let s = UnixStream::connect(dir.join("gateway.sock")).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(90))).unwrap();
    let mut soul = Client(s, Id::new(Scope([0xc1; 16]), 1).unwrap(), 0, lineage);

    let joined = soul.act(JOIN, None, BTreeMap::new());
    println!("join: {joined:?}");
    joined.expect("born by the entry");
    let park = soul.act(
        "eden:park",
        Some(rack),
        args(&[("bike", bike.to_value()), ("stand", Value::Uint(1))]),
    );
    println!("park the bicycle in stand 1: {park:?}");
    park.expect("parked through the rack's own entry");
    let unpark = soul.act(
        "eden:take_out",
        Some(rack),
        args(&[("bike", bike.to_value())]),
    );
    println!("take it out: {unpark:?}");
    unpark.expect("taken out through the rack's own entry");
    let park2 = soul.act(
        "eden:park",
        Some(rack),
        args(&[("bike", bike.to_value()), ("stand", Value::Uint(2))]),
    );
    println!("park it again, held, in stand 2: {park2:?}");
    park2.expect("parked again");
    drop(served);

    // The log: each frame the bicycle was moved to, in order (B4's transfers' leaves).
    let bytes = std::fs::read(dir.join("log")).unwrap();
    let mut frames = Vec::new();
    for r in sim::log::recover(&bytes).unwrap().records {
        if sim::recorder::is_input(&r) {
            continue;
        }
        for e in Part::read(&r).unwrap().effects {
            if let Body::Transfer(TransferRec::Leave { node, pose, .. }) = e.body
                && node == bike
            {
                frames.push((pose.frame.node, pose.frame.slot));
            }
        }
    }
    println!("the bicycle's frames: {frames:?}");
    assert_eq!(frames.len(), 3, "three moves");
    assert_eq!(frames[0], (rack, Some(1)), "parked in stand 1");
    assert!(
        frames[1].0 != rack && matches!(frames[1].1, Some(1 | 2)),
        "taken out into a hand of the body"
    );
    assert_eq!(frames[2], (rack, Some(2)), "parked in stand 2");
    let _ = std::fs::remove_dir_all(&dir);
}
