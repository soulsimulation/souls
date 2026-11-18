//! `facts` (Engine v2 V10, #2720). From `v2/`, `cargo run -p facts --release -- <command>`:
//!
//! - `record <dir> <seconds>`: the scripted world (`facts::record`), its live parts and its bundles under `<dir>`.
//! - `sheet <dir> <live|history> <first second> <end second> <out>`: a recording's sheet, from its parts or bundles.
//! - `diff <sheet> <sheet>`: prints `equal: <n> seconds` or the first difference, `first difference: second <s>:
//!   <what>` (and exits 1).
//! - `fault <dir> <out dir> <after µs>`: the bundles with one body moved 30 cm, and the second to expect.
//! - `scan <sheet>`: its text items, references and speech acts, and the words found in it (none).
//! - `hour <dir> [seconds]`: all of it on one recording (default an hour): record, both sheets, diff (A1), the fault
//!   and its diff (A2), the scan (A4).
//! - `vectors <dir>`: a 20 s recording with its native sheets and one `factsAt` record, for `wasm.mjs` (A3).

use std::path::Path;
use std::process::exit;

use facts::{R, Side, fault, record, refuse, scan, sheet};
use replica::facts::{compare, show};

fn arg(args: &[String], i: usize, what: &str) -> R<String> {
    args.get(i)
        .cloned()
        .map_or_else(|| refuse("usage", format!("missing {what}")), Ok)
}

fn num(args: &[String], i: usize, what: &str) -> R<i64> {
    arg(args, i, what)?
        .parse()
        .or_else(|_| refuse("usage", format!("{what} is a number")))
}

fn from(s: &str) -> R<Side> {
    match s {
        "live" => Ok(Side::Live),
        "history" => Ok(Side::History),
        _ => refuse("usage", "a sheet is read from live or history"),
    }
}

fn write(path: &Path, bytes: &[u8]) -> R<()> {
    std::fs::write(path, bytes).or_else(|e| refuse("io", e.to_string()))
}

fn read(path: &str) -> R<Vec<u8>> {
    std::fs::read(path).or_else(|e| refuse("io", e.to_string()))
}

/// Prints the comparison; true when equal.
fn diff(a: &[u8], b: &[u8]) -> R<bool> {
    match compare(a, b)? {
        None => {
            let n = replica::facts::records(a).count().saturating_sub(1);
            println!("equal: {n} seconds");
            Ok(true)
        }
        Some(d) => {
            println!("first difference: second {}: {}", d.second, d.what);
            Ok(false)
        }
    }
}

fn print_scan(name: &str, bytes: &[u8]) -> R<bool> {
    let s = scan(bytes)?;
    println!(
        "scan {name}: {} bytes, text items {:?}, {} references, {} speech acts, words found {:?}",
        bytes.len(),
        s.texts,
        s.references,
        s.speech_acts,
        s.words_found
    );
    Ok(s.words_found.is_empty())
}

fn hour(dir: &Path, seconds: u64) -> R<bool> {
    let bodies = record(dir, seconds)?;
    println!(
        "recorded {seconds} s: {} bodies, {} live parts, {} bundles",
        bodies.len(),
        facts::files(dir, Side::Live)?.len(),
        facts::files(dir, Side::History)?.len()
    );
    let end = i64::try_from(seconds).unwrap_or(i64::MAX);
    let (live, _) = sheet(dir, Side::Live, 0, end, None)?;
    let (history, _) = sheet(dir, Side::History, 0, end, None)?;
    write(&dir.join("live.sheet"), &live)?;
    write(&dir.join("history.sheet"), &history)?;
    println!(
        "sheets: live {} bytes, history {} bytes, {}",
        live.len(),
        history.len(),
        if live == history {
            "the same bytes"
        } else {
            "other bytes"
        }
    );
    print!("A1 live against history: ");
    let equal = diff(&live, &history)?;
    let f = fault(dir, &dir.join("fault"), end * 1_000_000 / 2)?;
    println!(
        "fault: body {} moved 30 cm in its sample at {} µs; expected at second {}",
        show(f.body),
        f.at,
        f.second
    );
    let (faulted, _) = sheet(&dir.join("fault"), Side::History, 0, end, None)?;
    print!("A2 live against the faulted history: ");
    let caught = match compare(&live, &faulted)? {
        Some(d) => {
            println!("first difference: second {}: {}", d.second, d.what);
            d.second == f.second && d.what.contains(&show(f.body))
        }
        None => {
            println!("equal (the fault was missed)");
            false
        }
    };
    let clean = print_scan("live", &live)? & print_scan("history", &history)?;
    println!("A1 {equal}, A2 {caught}, A4 {clean}");
    Ok(equal && caught && clean)
}

fn vectors(dir: &Path) -> R<()> {
    record(dir, 20)?;
    let (live, at) = sheet(dir, Side::Live, 0, 20, Some(15_500_000))?;
    let (history, at_h) = sheet(dir, Side::History, 0, 20, Some(15_500_000))?;
    write(&dir.join("live.sheet"), &live)?;
    write(&dir.join("history.sheet"), &history)?;
    write(&dir.join("live.facts-at"), &at)?;
    write(&dir.join("history.facts-at"), &at_h)?;
    println!(
        "vectors: live {} parts, history {} bundles, sheets of {} and {} bytes",
        facts::files(dir, Side::Live)?.len(),
        facts::files(dir, Side::History)?.len(),
        live.len(),
        history.len()
    );
    Ok(())
}

fn run(args: &[String]) -> R<bool> {
    let cmd = arg(args, 1, "a command")?;
    match cmd.as_str() {
        "record" => {
            let b = record(
                Path::new(&arg(args, 2, "a dir")?),
                num(args, 3, "seconds")?.unsigned_abs(),
            )?;
            println!("recorded: {} bodies", b.len());
            Ok(true)
        }
        "sheet" => {
            let (s, _) = sheet(
                Path::new(&arg(args, 2, "a dir")?),
                from(&arg(args, 3, "live or history")?)?,
                num(args, 4, "the first second")?,
                num(args, 5, "the end second")?,
                None,
            )?;
            write(Path::new(&arg(args, 6, "an out file")?), &s)?;
            println!("sheet: {} bytes", s.len());
            Ok(true)
        }
        "diff" => diff(
            &read(&arg(args, 2, "a sheet")?)?,
            &read(&arg(args, 3, "a sheet")?)?,
        ),
        "fault" => {
            let f = fault(
                Path::new(&arg(args, 2, "a dir")?),
                Path::new(&arg(args, 3, "an out dir")?),
                num(args, 4, "after µs")?,
            )?;
            println!(
                "fault: body {} moved 30 cm at {} µs; expected at second {}",
                show(f.body),
                f.at,
                f.second
            );
            Ok(true)
        }
        "scan" => {
            let path = arg(args, 2, "a sheet")?;
            print_scan(&path, &read(&path)?)
        }
        "hour" => {
            let seconds = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(3600);
            hour(Path::new(&arg(args, 2, "a dir")?), seconds)
        }
        "vectors" => vectors(Path::new(&arg(args, 2, "a dir")?)).map(|()| true),
        _ => refuse("usage", format!("unknown command {cmd}")),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match run(&args) {
        Ok(true) => {}
        Ok(false) => exit(1),
        Err(r) => {
            eprintln!("facts: {r}");
            exit(2);
        }
    }
}
