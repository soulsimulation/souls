//! An intent checked for form on arrival (Engine v2 I2, #2689). The WASM build gives the same table in the
//! `intent-decode` step of `v2/tools/ci.sh`.

use std::time::{Duration, Instant};

use replica::effects::fixture_bytes;
use replica::intent_decode::{LIMITS, MALFORMED, decode, intent_decode_table};
use replica::intents::{FALLBACKS_MOST, FIXTURES, INTENT_MOST};
use replica::refusals::{REFUSALS, named};

#[test]
fn a1_each_malformed_fixture_is_refused_by_the_name_beside_it() {
    let table = intent_decode_table();
    let mut wrong = Vec::new();
    println!("{:<32} {:<34} given", "fixture", "expected");
    for line in table.lines() {
        let parts: Vec<&str> = line.split(' ').collect();
        let [fixture, want, given] = parts[..] else {
            panic!("a table line: {line}");
        };
        println!("{fixture:<32} {want:<34} {given}");
        if want != given {
            wrong.push(line.to_owned());
        }
    }
    let n = table.lines().count();
    println!(
        "{n} malformed fixtures, {} refused by another name",
        wrong.len()
    );
    assert!(n >= 60, "at least 60 malformed fixtures, {n} given");
    assert!(wrong.is_empty(), "refused by another name: {wrong:#?}");
    // T10's golden intents are well formed, so none is refused here.
    for (name, text) in FIXTURES {
        let bytes = fixture_bytes(text).expect("bytes");
        assert!(
            decode(&bytes).is_ok(),
            "the golden {name}: {:?}",
            decode(&bytes)
        );
    }
}

#[test]
fn a2_a_frame_over_the_limit_is_refused_from_its_length_alone() {
    let most = usize::try_from(LIMITS.frame_bytes).expect("fits");
    // 0xff is a break: parsed, the first byte would be refused as `intent.cbor.break`, not by its size.
    let r = decode(&vec![0xff; most + 1]).expect_err("refused");
    assert_eq!(r.name, "intent.too-large");
    // A frame claiming a length of 2^64 items, padded over the limit: refused before the claim is read.
    let mut claim = vec![0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    claim.resize(most + 1, 0);
    assert_eq!(
        decode(&claim).expect_err("refused").name,
        "intent.too-large"
    );
    // At the limit, the same bytes are parsed, and refused for what they are.
    assert_eq!(
        decode(&vec![0xff; most]).expect_err("refused").name,
        "intent.cbor.break"
    );
    println!("{} bytes: {}", most + 1, r);
}

/// Random bytes, and golden intents with random bytes changed, fed to the parser for `INTENT_FUZZ_SECONDS` (default:
/// 20,000 inputs). Nothing may panic, and every refusal is a registry name. Reports the slowest parse.
#[test]
fn a3_fuzzing_causes_no_crash_and_reports_the_slowest_parse() {
    let goldens: Vec<Vec<u8>> = FIXTURES
        .iter()
        .map(|(_, t)| fixture_bytes(t).expect("bytes"))
        .collect();
    let seconds = std::env::var("INTENT_FUZZ_SECONDS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok());
    let mut seed = 0x2689_u64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    #[allow(
        clippy::disallowed_methods,
        reason = "a fuzz test times its run and its parses"
    )]
    let start = Instant::now();
    let (mut runs, mut accepted) = (0_u64, 0_u64);
    let mut slowest = (Duration::ZERO, 0_usize);
    let mut names = std::collections::BTreeMap::<&str, u64>::new();
    loop {
        #[allow(clippy::disallowed_methods, reason = "a fuzz test times its run")]
        let done = match seconds {
            Some(s) => start.elapsed() >= Duration::from_secs(s),
            None => runs >= 20_000,
        };
        if done {
            break;
        }
        let r = next();
        let input = if r % 3 == 0 {
            // Random bytes, up to a little over the limit.
            let n = usize::try_from(next() % (u64::from(LIMITS.frame_bytes) + 64)).unwrap_or(0);
            (0..n).map(|_| next() as u8).collect::<Vec<u8>>()
        } else {
            // A golden intent with a few bytes changed, cut short or lengthened.
            let mut b = goldens[usize::try_from(r % 8).unwrap_or(0)].clone();
            for _ in 0..1 + next() % 4 {
                let at = usize::try_from(next()).unwrap_or(0) % b.len().max(1);
                match next() % 4 {
                    0 if !b.is_empty() => b.truncate(at),
                    1 => b.insert(at.min(b.len()), next() as u8),
                    _ if !b.is_empty() => b[at] = next() as u8,
                    _ => {}
                }
            }
            b
        };
        #[allow(clippy::disallowed_methods, reason = "a fuzz test times each parse")]
        let t = Instant::now();
        let out = decode(&input);
        #[allow(clippy::disallowed_methods, reason = "a fuzz test times each parse")]
        let took = t.elapsed();
        if took > slowest.0 {
            slowest = (took, input.len());
        }
        match out {
            Ok(_) => accepted += 1,
            Err(e) => {
                assert!(named(e.name).is_some(), "not a registry name: {}", e.name);
                *names.entry(e.name).or_default() += 1;
            }
        }
        runs += 1;
    }
    #[allow(clippy::disallowed_methods, reason = "a fuzz test reports its run")]
    let ran = start.elapsed();
    println!(
        "fuzz: {runs} inputs in {:.1} s, no panic; {accepted} accepted; slowest parse {} us ({} bytes)",
        ran.as_secs_f64(),
        slowest.0.as_micros(),
        slowest.1
    );
    for (n, c) in &names {
        println!("  {n:<34} {c}");
    }
}

#[test]
fn a4_the_limits_are_one_file_and_agree_with_t10() {
    println!("{LIMITS:?}");
    assert_eq!(u64::from(LIMITS.frame_bytes), INTENT_MOST);
    assert_eq!(u64::from(LIMITS.fallbacks), FALLBACKS_MOST);
    assert!(MALFORMED.lines().count() > 60);
}

#[test]
fn a5_the_registry_is_one_table_of_dotted_unique_names() {
    let mut seen = std::collections::BTreeSet::new();
    for (name, meaning) in REFUSALS {
        assert!(name.starts_with("intent.") && !meaning.is_empty(), "{name}");
        assert!(
            name.bytes()
                .all(|b| b.is_ascii_lowercase() || b == b'.' || b == b'-'),
            "{name}"
        );
        assert!(seen.insert(name), "{name} twice");
    }
    // Every name a fixture expects is the registry's.
    for line in MALFORMED
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
    {
        let want = line.split(' ').nth(1).expect("a name");
        assert!(named(want).is_some(), "{want} is not in the registry");
    }
}
