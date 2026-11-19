//! Eden's template, saved once: `cargo run -p templates --release -- <eden facts> <out>` loads N1's import, takes
//! its checkpoint in `<out>/source` and publishes it as the template `eden-2026` in `<out>/eden-2026`.

use std::io::Read;
use std::path::PathBuf;

use replica::ids::{Hash, Purpose, Scope};

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
    let (Some(facts), Some(out)) = (args.get(1), args.get(2).map(PathBuf::from)) else {
        eprintln!("usage: templates <eden facts> <out>");
        std::process::exit(2);
    };
    let run = || -> Result<String, String> {
        let text = std::fs::read_to_string(facts).map_err(|e| e.to_string())?;
        let mut im = import_eden::load(&text)?;
        let root = im.tree.node(im.tree.root()).ok_or("no root")?.id();
        templates::checkpoint(&mut im.tree, root.scope(), &out.join("source"))
            .map_err(|e| e.to_string())?;
        let scope: [u8; 16] = random(16)
            .map_err(|e| e.to_string())?
            .try_into()
            .map_err(|_| "16 bytes")?;
        let t = templates::publish(
            &out.join("source"),
            &out.join("eden-2026"),
            "eden-2026",
            Scope(scope),
            random(32).map_err(|e| e.to_string())?,
            real_us(),
            Hash::of(Purpose::Fixture, b"souls/worldd/0.0.0").to_bytes(),
        )
        .map_err(|e| e.to_string())?;
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
