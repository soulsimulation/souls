//! The fork request (Engine v2 K6, #2670): `worldd fork --from <checkpoints> --to <new folder> --through <principal>`
//! starts the newest good checkpoint in `--from` as a new world in `--to` (`sim::checkpoint::fork`). The process
//! gives it what the engine may not make itself: a fresh lineage and minting scope and a seed from the operating
//! system's random source (T3 rule 1: never the world's random numbers, which a fork replays), and the real time of
//! the request, read once (T5 rule 10). A principal is written `<32 hex digits>:<counter>`.

use crate::watchdog::Real;
use replica::encode::{from_hex, to_hex};
use replica::ids::{Hash, Id, Purpose, Scope};
use sim::checkpoint::fork::{Request, fork};
use sim::clock::Clock;
use std::io::Read;
use std::path::PathBuf;

/// The fork's checkpoint interval: a checkpoint each 8 MiB of log (K5's bench constant).
const EVERY: u64 = 8 << 20;

/// `n` bytes from the operating system's random source.
fn random(n: usize) -> std::io::Result<Vec<u8>> {
    let mut b = vec![0; n];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
    Ok(b)
}

fn principal(s: &str) -> Option<Id> {
    let (scope, counter) = s.split_once(':')?;
    let scope: [u8; 16] = from_hex(scope).ok()?.try_into().ok()?;
    Id::new(Scope(scope), counter.parse().ok()?)
}

/// The fork request. Returns the exit code.
pub fn run(args: &[String]) -> i32 {
    let arg = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|k| args.get(k + 1))
    };
    let (Some(from), Some(to), Some(through)) = (
        arg("--from").map(PathBuf::from),
        arg("--to").map(PathBuf::from),
        arg("--through").and_then(|p| principal(p)),
    ) else {
        eprintln!(
            "usage: worldd fork --from <checkpoints> --to <new folder> --through <32 hex>:<counter>"
        );
        return 2;
    };
    let (scope, seed) = match (random(16), random(32)) {
        (Ok(s), Ok(seed)) => (Scope(s.try_into().unwrap_or([0; 16])), seed),
        (Err(e), _) | (_, Err(e)) => {
            eprintln!("worldd: fork: the random source: {e}");
            return 1;
        }
    };
    let mut real = Real::start();
    let real_us = real.now();
    let req = Request {
        through,
        scope,
        seed,
        real_us,
        // A stand-in for the build's hash until K14 names the real one.
        build: Hash::of(Purpose::Fixture, b"souls/worldd/0.0.0").to_bytes(),
        every: EVERY,
    };
    match fork(&from, &to, req) {
        Ok(f) => {
            println!(
                "fork: lineage {} at sequence {}, {} bodies removed, {} things set down, {} bytes written, {} us",
                to_hex(&f.version.lineage.0),
                f.version.sequence,
                f.bodies.len(),
                f.set_down.len(),
                f.bytes,
                real.now() - real_us
            );
            0
        }
        Err(e) => {
            eprintln!("worldd: fork: {e}");
            1
        }
    }
}
