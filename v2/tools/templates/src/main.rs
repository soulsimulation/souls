//! A template from a facts file: `templates <facts> <out> --name <name> [--support <seeded folder>]` loads N1's import
//! with the support's entries, takes its checkpoint in `<out>/<name>.source` and publishes it as the template `name`
//! in `<out>/<name>` (`templates::publish_facts`). Installed as `publish-template`; refuses a folder that exists.

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

fn main() {
    let args: Vec<String> = std::env::args().collect();
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
