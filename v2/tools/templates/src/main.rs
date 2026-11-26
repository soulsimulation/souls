//! A template from a facts file: `templates <facts> <out> --name <name> [--support <seeded folder>]` loads N1's import
//! with the support's entries, takes its checkpoint in `<out>/<name>.source` and publishes it as the template `name`
//! in `<out>/<name>` (`templates::publish_facts`). Installed as `publish-template`; refuses a folder that exists.
//! `templates courses <checkpoints>` lists each thing on a course in a world's newest checkpoint (a template's `ckpt`, a
//! forked world's `checkpoints`): where it stands and its loop, as `worldd seed` prints the punts and rides it adds.

use replica::ids::Scope;
use std::io::Read;
use std::path::{Path, PathBuf};

fn random(n: usize) -> std::io::Result<Vec<u8>> {
    let mut b = vec![0; n];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
    Ok(b)
}

// The publish's real time is a recorded input of the template (T5 rule 10), read once here.
#[allow(clippy::disallowed_methods)]
fn real_us() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_micros()).unwrap_or(i64::MAX))
}

/// `course: <id> at <x>,<z> m, loop <period> us from <t0> us`, one line for each thing on a course, in id order.
fn courses(dir: &Path) -> Result<Vec<String>, String> {
    use replica::schedule::{F_COURSE, course::Course};
    let tree = sim::checkpoint::restore(dir)
        .map_err(|e| format!("{e:?}"))?
        .ok_or("no checkpoint")?
        .tree;
    let (mut out, mut todo) = (Vec::new(), vec![tree.root()]);
    while let Some(h) = todo.pop() {
        todo.extend(tree.children(h).unwrap_or(&[]));
        let Some(n) = tree.node(h) else { continue };
        let Some(c) = n.fields().get(&F_COURSE).and_then(Course::read) else {
            continue;
        };
        let at = n.place().map_or(replica::pose::Vec3::ZERO, |p| p.position);
        out.push((
            n.id(),
            format!(
                "course: {} at {:.3},{:.3} m, loop {} us from {} us",
                replica::world_model::show(n.id()),
                at.x as f64 / 1e6,
                at.z as f64 / 1e6,
                c.load().map_or(0, |t| t.period),
                c.t0
            ),
        ));
    }
    out.sort();
    Ok(out.into_iter().map(|(_, line)| line).collect())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("courses") {
        match args.get(2).map(|d| courses(Path::new(d))) {
            Some(Ok(lines)) => lines.iter().for_each(|l| println!("{l}")),
            Some(Err(e)) => {
                eprintln!("templates: courses: {e}");
                std::process::exit(1);
            }
            None => {
                eprintln!("usage: templates courses <checkpoints>");
                std::process::exit(2);
            }
        }
        return;
    }
    let flag = |k: &str| {
        args.iter()
            .position(|a| a == k)
            .and_then(|i| args.get(i + 1))
    };
    let (Some(facts), Some(out), Some(name)) =
        (args.get(1), args.get(2).map(PathBuf::from), flag("--name"))
    else {
        eprintln!("usage: templates <facts> <out> --name <name> [--support <seeded folder>]");
        std::process::exit(2);
    };
    let run = || -> Result<String, String> {
        let text = std::fs::read_to_string(facts).map_err(|e| e.to_string())?;
        let scope: [u8; 16] = random(16)
            .map_err(|e| e.to_string())?
            .try_into()
            .map_err(|_| "16 bytes")?;
        let t = templates::publish_facts(
            &text,
            &out,
            name,
            flag("--support").map(Path::new),
            Scope(scope),
            random(32).map_err(|e| e.to_string())?,
            real_us(),
        )?;
        Ok(format!(
            "template {}: lineage {}, {} bytes, {} bodies removed",
            t.name,
            replica::encode::to_hex(&t.lineage.0),
            t.bytes,
            t.bodies.len()
        ))
    };
    match run() {
        Ok(s) => println!("{s}"),
        Err(e) => {
            eprintln!("templates: {e}");
            std::process::exit(1);
        }
    }
}
