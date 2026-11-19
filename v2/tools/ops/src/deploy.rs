//! `deploy`: deploy and roll back one world on a machine running O1's units (Engine v2 O7, #2804). Runbook:
//! `v2/docs/runbook/deploy-and-roll-back.md`.
//!
//! ```text
//! deploy <world> <build hash> [--window-s 60] [--records 200]
//! deploy rollback <world> <to hash> --from <hash>
//! deploy pinned <world>
//! ```
//!
//! The probe is R5b's sync ask for the world's root hash (`supervisor::deploy::Probe::Ask`, O18c #3524): it needs no
//! body, so a release never drives anyone's Soul, and it is never logged. The machine's folder is `$WORLDS_ROOT`; the
//! directory is the object store the `DIRECTORY_STORE_*` variables name, or `$WORLDS_ROOT/directory`. Prints the timeline and how it ended; exits 0
//! when the new build is kept or the rollback served, 1 otherwise. It holds the machine's step (`step.rs`) shared while
//! it runs, and refuses `deploy.gateway-upgrading` while the gateway is upgraded (O16, #2809).
// Operations, not the engine: the rollback's timeline is wall-clock time (the wall-clock rule, K7).
#![allow(clippy::disallowed_methods)]

mod step;

use std::path::PathBuf;
use std::time::Duration;

use directoryd::directory::s3::S3;
use directoryd::directory::store::Store;
use replica::encode::from_hex;
use supervisor::World;
use supervisor::deploy::{Canary, Deploy, Ended, Probe, Systemd, Timeline};
use supervisor::folder::Folder;

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("deploy: {msg}");
    std::process::exit(2)
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
    // R5b's sync ask, which needs no body: a release never drives anyone's Soul (O18c, #3524).
    let mut probe = Probe::Ask(0);
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
