//! `supervisor`: what `worldd@<world>.service` runs around a world (Engine v2 O1, #2730).
//!
//! ```text
//! supervisor launch <world>     the unit's ExecStart: record the start, read the pin, run builds/<hash>/worldd serve
//! supervisor ready <world>      the unit's ExecStartPost (after worldd said READY=1): record that it serves
//! supervisor exited <world>     the unit's ExecStopPost: record how it ended, from $SERVICE_RESULT and $EXIT_*
//! supervisor health [<world>]   print the health record (every world's, without a name)
//! supervisor pin <world> <hash> pin a build in the directory (W8's set_build)
//! supervisor hash <file>        a build's hash
//! ```
//!
//! The machine's folder is `$WORLDS_ROOT`: `builds/<hash>/worldd`, `worlds/<world>/` (each world's state), `cache/`
//! (the cached copy of each world's record) and `health/`. The directory is the object store `DIRECTORY_STORE_*`
//! names, or the folder `$WORLDS_ROOT/directory` on a machine without one.

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use directoryd::directory::s3::S3;
use directoryd::directory::store::Store;
use replica::encode::{from_hex, to_hex};
use supervisor::folder::Folder;
use supervisor::health::{self, Event};
use supervisor::{
    EXIT_BUILD_MISMATCH, EXIT_BUILD_MISSING, EXIT_PIN_MISSING, World, build_hash, build_path, pin,
    set_pin,
};

// The supervisor is operations, not the engine: its records carry the wall clock's time (the wall-clock rule, K7).
#[allow(clippy::disallowed_methods)]
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn root() -> PathBuf {
    std::env::var_os("WORLDS_ROOT")
        .map_or_else(|| PathBuf::from("/var/lib/souls/worlds"), PathBuf::from)
}

/// Runs `f` against the directory's store.
fn with_store<T>(root: &Path, f: impl FnOnce(&dyn Store) -> T) -> Result<T, String> {
    match S3::from_env() {
        Some(Ok(s3)) => Ok(f(&s3)),
        Some(Err(e)) => Err(format!("{}: {}", e.name, e.detail)),
        None => Ok(f(&Folder::new(root.join("directory")))),
    }
}

fn world_arg(args: &[String]) -> Result<World, String> {
    World::parse(args.get(2).ok_or("no world named")?)
}

/// Records the start, reads the pin and replaces this process with the build's `worldd serve --dir worlds/<world>` (C1,
/// #3365: the world from its folder, behind the gateway). Returns only on failure.
fn launch(root: &Path, world: &World) -> i32 {
    let name = world.name();
    if let Err(e) = health::record(root, &name, now_ms(), Event::Start) {
        eprintln!("launch: health record: {e}");
    }
    let fences = std::env::var_os("SOULS_ARCHIVE_FENCES").map_or_else(
        || PathBuf::from("/etc/souls/placement-data/archived"),
        PathBuf::from,
    );
    if let Err(e) =
        with_store(root, |s| supervisor::archive_guard(s, &fences, world)).and_then(|r| r)
    {
        eprintln!("launch: {e}");
        return EXIT_PIN_MISSING;
    }
    let pinned = with_store(root, |s| pin(s, root, world)).and_then(|r| r);
    let (build, from) = match pinned {
        Ok(p) => p,
        Err(e) => {
            eprintln!("launch: {e}");
            return EXIT_PIN_MISSING;
        }
    };
    let hex = to_hex(&build);
    let path = build_path(root, &build);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => {
            eprintln!("launch: build.missing: {hex} is not on this machine");
            return EXIT_BUILD_MISSING;
        }
    };
    if build_hash(&bytes) != build {
        eprintln!("launch: build.mismatch: {} is not {hex}", path.display());
        return EXIT_BUILD_MISMATCH;
    }
    println!("launch: world {name} build {hex} (pin from the {from:?})");
    let state = root.join("worlds").join(&name);
    let err = Command::new(&path)
        .arg("serve")
        .arg("--dir")
        .arg(&state)
        .env("WORLDD_BUILD", &hex)
        .exec();
    eprintln!("launch: build.missing: {hex}: {err}");
    EXIT_BUILD_MISSING
}

fn run(args: &[String]) -> Result<i32, String> {
    let root = root();
    match args.get(1).map(String::as_str) {
        Some("launch") => Ok(launch(&root, &world_arg(args)?)),
        Some("archive-state") => {
            use directoryd::worlds::list::archive;
            let op = args
                .get(2)
                .map(String::as_str)
                .ok_or("archive operation missing")?;
            let name = args.get(3).map(String::as_str).unwrap_or_default();
            let result = with_store(&root, |store| -> Result<String, String> {
                let err = |e: replica::effects::Refusal| e.name.to_owned();
                let describe = |p: archive::Phase| -> Result<String, String> {
                    let mut value = p.json();
                    let (build, _) = pin(
                        store,
                        &root,
                        &World {
                            lineage: p.lineage,
                            zone: p.zone,
                        },
                    )?;
                    value["build"] = to_hex(&build).into();
                    Ok(value.to_string())
                };
                match op {
                    "list" if args.len() == 3 => Ok(format!(
                        "[{}]",
                        archive::list(&store)
                            .map_err(err)?
                            .iter()
                            .map(|p| p.json().to_string())
                            .collect::<Vec<_>>()
                            .join(",")
                    )),
                    "request" if args.len() == 4 => archive::pending_request(&store, name)
                        .map_err(err)?
                        .map_or_else(|| Ok("null".into()), describe),
                    "get" if args.len() == 4 => describe(archive::get(&store, name).map_err(err)?),
                    "restore" if args.len() == 4 => {
                        describe(archive::begin(&store, name, None, "", true).map_err(err)?)
                    }
                    "finish" | "recover" if args.len() == 5 => {
                        let phase = archive::get(&store, name).map_err(err)?;
                        if Some(&phase.request) != args.get(4) {
                            return Err("archive-stale".into());
                        }
                        describe(if op == "finish" {
                            archive::finish(&store, &phase).map_err(err)?
                        } else {
                            archive::retry_restore(&store, name, &phase.request).map_err(err)?
                        })
                    }
                    _ => Err("archive-arguments-invalid".into()),
                }
            })??;
            println!("{result}");
            Ok(0)
        }
        Some("ready") => {
            health::record(&root, &world_arg(args)?.name(), now_ms(), Event::Ready)
                .map_err(|e| e.to_string())?;
            Ok(0)
        }
        Some("exited") => {
            let var = |k| std::env::var(k).unwrap_or_default();
            let event = health::exit_name(
                &var("SERVICE_RESULT"),
                &var("EXIT_CODE"),
                &var("EXIT_STATUS"),
            )
            .map_or(Event::Stop, Event::Exit);
            let h = health::record(&root, &world_arg(args)?.name(), now_ms(), event)
                .map_err(|e| e.to_string())?;
            println!(
                "health: {} after {} failures, last exit {:?}",
                h.state, h.failures, h.last_exit
            );
            Ok(0)
        }
        Some("health") => {
            let names: Vec<String> = match args.get(2) {
                Some(_) => vec![world_arg(args)?.name()],
                None => std::fs::read_dir(root.join("health"))
                    .map(|d| {
                        d.filter_map(|e| {
                            e.ok()?
                                .file_name()
                                .to_str()?
                                .strip_suffix(".json")
                                .map(str::to_owned)
                        })
                        .collect()
                    })
                    .unwrap_or_default(),
            };
            for n in names {
                print!(
                    "{}",
                    std::fs::read_to_string(health::record_path(&root, &n)).unwrap_or_default()
                );
            }
            Ok(0)
        }
        Some("pin") => {
            let world = world_arg(args)?;
            let build = from_hex(args.get(3).ok_or("no build named")?)?;
            with_store(&root, |s| set_pin(s, &world, &build))??;
            Ok(0)
        }
        Some("hash") => {
            let bytes =
                std::fs::read(args.get(2).ok_or("no file named")?).map_err(|e| e.to_string())?;
            println!("{}", to_hex(&build_hash(&bytes)));
            Ok(0)
        }
        _ => Err(
            "usage: supervisor launch|ready|exited|health|pin|hash ... (see the crate's docs)"
                .into(),
        ),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match run(&args) {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("supervisor: {e}");
            std::process::exit(2);
        }
    }
}
