//! `deploy`: deploy and roll back one world on a machine running O1's units (Engine v2 O7, #2804). Runbook:
//! `v2/docs/runbook/deploy-and-roll-back.md`.
//!
//! ```text
//! deploy <world> <build hash> [--window-s 60] [--records 200]
//! deploy <world> <build hash> --rehearse-only [--records 200]
//! deploy rollback <world> <to hash> --from <hash>
//! deploy pinned <world>
//! ```
//!
//! The release probe has its own unpaired operator identity (O18d #3575). It joins through K10/C3, commits an
//! ordinary description on its own body, and retires; it never drives a user's Soul. Its recovery receipt is
//! `$WORLDS_ROOT/deploys/<world>.probe`, protected by a stable sibling lock for the whole deployment. The machine's
//! folder is `$WORLDS_ROOT`; the directory is the object store the `DIRECTORY_STORE_*` variables name, or
//! `$WORLDS_ROOT/directory`. Prints the timeline and how it ended; exits 0 when the new build is kept or the rollback
//! served, 1 otherwise. It holds the machine's step (`step.rs`) shared while it runs, and refuses
//! `deploy.gateway-upgrading` while the gateway is upgraded (O16, #2809).
//!
//! `--rehearse-only` runs the deploy's first step and stops: the build on a scratch copy of the world
//! (`$WORLDS_ROOT/rehearsals/`), fed the recorded intents and probed by its own operator body there. It reads no pin,
//! restarts nothing, takes no step lock and writes only under `rehearsals/`; exits 0 when the rehearsal passes.
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
    // The world's own objects under the store generation its folder names (#4954), as its launcher reads them.
    let label = supervisor::generation(&supervisor::world_folder(&root, &world))
        .unwrap_or_else(|e| fail(e));
    let placed = supervisor::bucket::Generation::new(store, world, label.as_deref());
    let store: &dyn Store = &placed;
    // The build the world is pinned to, which a deploy leaves and `--from` must name (the runbook's wrappers).
    if pinned {
        let (b, _) = supervisor::pin(store, &root, &world).unwrap_or_else(|e| fail(e));
        println!("{}", replica::encode::to_hex(&b));
        return;
    }
    let build = from_hex(a.get(at + 1).unwrap_or_else(|| fail("no build named")))
        .unwrap_or_else(|e| fail(e));
    let num = |n: &str, d: u64| get(n).map_or(d, |v| v.parse().unwrap_or_else(|_| fail(n)));
    let rehearse_only = a.iter().any(|x| x == "--rehearse-only");
    // Never in the same step as the gateway's upgrade. A rehearsal alone touches neither, so it takes no step.
    let _step = (!rehearse_only).then(|| {
        step::deploying(&root).unwrap_or_else(|e| {
            println!("refused: {e}");
            std::process::exit(1)
        })
    });
    // O18d: no user pairing or profile. A stable per-world probe lock also serializes interrupted-watch recovery.
    // A rehearsal alone probes with its own body in the scratch copy; its lock stays under `rehearsals/`.
    let receipts = root.join(if rehearse_only {
        "rehearsals"
    } else {
        "deploys"
    });
    let mut probe = Probe::operator(&receipts.join(format!("{}.probe", world.name())))
        .unwrap_or_else(|e| fail(e));
    let d = Deploy {
        store,
        root: &root,
        world,
        canary: Canary {
            window: Duration::from_secs(num("--window-s", 60)),
            // A real world loads its facts and replays its log (O18b, #3498): the world's own bound from its limits
            // drop-in (world-limits.json, Eden's 600 s), else START_WITHIN, 120 s: a slow store's start (R17).
            start_within: supervisor::deploy::start_within(
                std::fs::read_to_string(format!(
                    "/etc/systemd/system/worldd@{}.service.d/limits.conf",
                    world.name()
                ))
                .ok()
                .as_deref(),
            ),
            answer_within: Duration::from_secs(2),
            every: Duration::from_millis(500),
        },
        window: num("--records", 200) as usize,
    };
    if rehearse_only {
        let t0 = std::time::Instant::now();
        match d.rehearse(&build, &mut probe) {
            Ok(r) => {
                println!(
                    "{:>7} ms  rehearsed on {}: {} records copied, {} recorded intents fed, {} named ends \
                     ({} receipts, refused {:?}); served log kept: {}",
                    t0.elapsed().as_millis(),
                    r.scratch.display(),
                    r.copied,
                    r.fed,
                    r.ended,
                    r.receipts,
                    r.refused,
                    r.served_kept
                );
                println!("Rehearsed");
            }
            Err(why) => {
                println!(
                    "{:>7} ms  rehearsal failed: {why}",
                    t0.elapsed().as_millis()
                );
                println!("NotRehearsed {{ why: {why:?} }}");
                std::process::exit(1)
            }
        }
        return;
    }
    let mut unit = Systemd::new(world.name());
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
