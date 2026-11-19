//! `deploy`: deploy and roll back one world on a machine running O1's units (Engine v2 O7, #2804). Runbook:
//! `v2/docs/runbook/deploy-and-roll-back.md`.
//!
//! ```text
//! deploy <world> <build hash> --probe <file> [--window-s 60] [--records 200]
//! deploy rollback <world> <to hash> --from <hash> --probe <file>
//! deploy pinned <world>
//! ```
//!
//! The probe file holds one intent (T10's bytes) of an act a healthy world gives a receipt; it is sent with a new
//! sequence and expiry each time. When the file is not there, `deploy` makes it from the world's folder and keeps it
//! there (O18b, #3498): the folder's first Soul (`world.json`) walks to the place it was seeded on the ground. The machine's folder is `$WORLDS_ROOT`; the directory is the object store the
//! `DIRECTORY_STORE_*` variables name, or `$WORLDS_ROOT/directory`. Prints the timeline and how it ended; exits 0
//! when the new build is kept or the rollback served, 1 otherwise. It holds the machine's step (`step.rs`) shared while
//! it runs, and refuses `deploy.gateway-upgrading` while the gateway is upgraded (O16, #2809).
// Operations, not the engine: the rollback's timeline is wall-clock time (the wall-clock rule, K7).
#![allow(clippy::disallowed_methods)]

mod step;

use std::path::PathBuf;
use std::time::Duration;

use directoryd::directory::s3::S3;
use directoryd::directory::store::Store;
use std::collections::BTreeMap;
use std::path::Path;

use replica::effects::Actor;
use replica::encode::{Name, Value, encode, from_hex};
use replica::ids::{Id, Scope, Version};
use replica::intents::{Intent, Target};
use replica::rules::json;
use supervisor::World;
use supervisor::deploy::{Canary, Deploy, Ended, Probe, Systemd, Timeline};
use supervisor::folder::Folder;

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("deploy: {msg}");
    std::process::exit(2)
}

/// The probe of a world placed from a seeded folder (`worldd seed`): its first Soul walks to where it was seeded, on
/// the ground of the world's facts. A healthy world gives that walk a receipt.
fn made_probe(state: &Path, world: &World) -> Result<Intent, String> {
    let read = |f: &str| std::fs::read_to_string(state.join(f)).map_err(|e| format!("{f}: {e}"));
    let meta = json::parse(&read("world.json")?)?;
    let scope: [u8; 16] = meta
        .get("souls_scope")
        .and_then(json::Value::str)
        .and_then(|h| from_hex(h).ok()?.try_into().ok())
        .ok_or("world.json names no souls_scope")?;
    let num = |v: &json::Value| match v {
        json::Value::Int(n) => i64::try_from(*n).ok(),
        _ => None,
    };
    let soul = meta
        .get("souls")
        .and_then(json::Value::arr)
        .and_then(|a| {
            a.first()?
                .arr()?
                .iter()
                .map(num)
                .collect::<Option<Vec<_>>>()
        })
        .filter(|s| s.len() == 3)
        .ok_or("world.json names no Soul")?;
    let body = Id::new(Scope(scope), soul[0] as u64).ok_or("the Soul's id")?;
    let ground = *import_eden::load(&read("facts.json")?)?
        .nodes
        .get("ground")
        .ok_or("the facts have no ground")?;
    let um = |mm: i64| {
        let n = mm * 1000;
        u64::try_from(n).map_or_else(|_| Value::Nint(n.unsigned_abs() - 1), Value::Uint)
    };
    Ok(Intent {
        actor: Actor::Soul(body),
        verb: Name::new("eden:walk").ok_or("a name")?,
        target: Some(Target::Node(ground)),
        parameters: BTreeMap::from([(1, Value::Array(vec![um(soul[1]), um(0), um(soul[2])]))]),
        sequence: 0,
        basis: Version {
            lineage: Scope(world.lineage),
            zone: world.zone,
            epoch: 1,
            sequence: 0,
        }
        .to_value(),
        expiry: supervisor::deploy::now_us() + 5_000_000,
        resources: Vec::new(),
        fallbacks: Vec::new(),
        replaces: None,
        body: None,
    })
}

fn print(tl: &Timeline) {
    for (ms, what) in &tl.0 {
        println!("{ms:>7} ms  {what}");
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let get = |n: &str| a.iter().position(|x| x == n).and_then(|k| a.get(k + 1));
    let rollback = a.get(1).map(String::as_str) == Some("rollback");
    let pinned = a.get(1).map(String::as_str) == Some("pinned");
    let at = if rollback || pinned { 2 } else { 1 };
    let world = World::parse(a.get(at).unwrap_or_else(|| fail("no world named")))
        .unwrap_or_else(|e| fail(e));
    let root = std::env::var_os("WORLDS_ROOT")
        .map_or_else(|| PathBuf::from("/var/lib/souls/worlds"), PathBuf::from);
    let s3;
    let folder;
    let store: &dyn Store = match S3::from_env() {
        Some(Ok(s)) => {
            s3 = s;
            &s3
        }
        Some(Err(e)) => fail(format!("{}: {}", e.name, e.detail)),
        None => {
            folder = Folder::new(root.join("directory"));
            &folder
        }
    };
    // The build the world is pinned to, which a deploy leaves and `--from` must name (the runbook's wrappers).
    if pinned {
        let (b, _) = supervisor::pin(store, &root, &world).unwrap_or_else(|e| fail(e));
        println!("{}", replica::encode::to_hex(&b));
        return;
    }
    let build = from_hex(a.get(at + 1).unwrap_or_else(|| fail("no build named")))
        .unwrap_or_else(|e| fail(e));
    let num = |n: &str, d: u64| get(n).map_or(d, |v| v.parse().unwrap_or_else(|_| fail(n)));
    let file = PathBuf::from(get("--probe").unwrap_or_else(|| fail("no --probe file")));
    if !file.exists() {
        let state = supervisor::deploy::state_path(&root, &world);
        let made = made_probe(&state, &world)
            .and_then(|i| encode(&i.to_value()).map_err(|e| format!("{e:?}")))
            .unwrap_or_else(|e| {
                fail(format!(
                    "the probe: none at {}, none made: {e}",
                    file.display()
                ))
            });
        if let Some(d) = file.parent() {
            std::fs::create_dir_all(d).unwrap_or_else(|e| fail(format!("the probe: {e}")));
        }
        std::fs::write(&file, made).unwrap_or_else(|e| fail(format!("the probe: {e}")));
        println!("probe: made {} from the world's folder", file.display());
    }
    let probe = std::fs::read(&file)
        .map_err(|e| e.to_string())
        .and_then(|b| Intent::read(&b).map_err(|e| e.to_string()))
        .unwrap_or_else(|e| fail(format!("the probe: {e}")));
    let mut probe = Probe { intent: probe };
    // Never in the same step as the gateway's upgrade.
    let _step = step::deploying(&root).unwrap_or_else(|e| {
        println!("refused: {e}");
        std::process::exit(1)
    });
    let d = Deploy {
        store,
        root: &root,
        world,
        canary: Canary {
            window: Duration::from_secs(num("--window-s", 60)),
            // As worldd@.service's TimeoutStartSec: a real world loads its facts and replays its log (O18b, #3498).
            start_within: Duration::from_secs(30),
            answer_within: Duration::from_secs(2),
            every: Duration::from_millis(500),
        },
        window: num("--records", 200) as usize,
    };
    let mut unit = Systemd(world.name());
    if rollback {
        let from = from_hex(get("--from").unwrap_or_else(|| fail("no --from build")))
            .unwrap_or_else(|e| fail(e));
        // Only the live build is taken back (O18, #2811): the world's pin must be `--from`.
        let live = supervisor::pin(store, &root, &world).map_or_else(|e| fail(e), |(b, _)| b);
        if live != from {
            let live = replica::encode::to_hex(&live);
            println!("refused: rollback.wrong-from: the world is pinned to {live}, not --from");
            std::process::exit(1)
        }
        // Whether the build being left wrote anything is not known here: assume it did, so the schemas are compared.
        let mut tl = Timeline::default();
        let t0 = std::time::Instant::now();
        let r = d.roll_back(&build, &from, true, &mut unit, &mut probe, &mut |s| {
            tl.0.push((t0.elapsed().as_millis(), s))
        });
        print(&tl);
        match r {
            Ok(()) => println!("rolled back"),
            Err(e) => {
                println!("refused: {e}");
                std::process::exit(1)
            }
        }
        return;
    }
    let (ended, tl, _) = d.run(&build, &mut unit, &mut probe);
    print(&tl);
    println!("{ended:?}");
    std::process::exit(i32::from(!matches!(ended, Ended::Kept)));
}
