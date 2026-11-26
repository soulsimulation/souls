//! The auditor's faults and the clock (K21 follow-up, #3430): a world whose every pass names standing faults runs on
//! the real clock for ten seconds while its stderr drains slowly, as a loaded log reader does, so a write to stderr
//! blocks. The clock's worst tick and the auditor's phase are measured. `cargo test -p worldd --release --test
//! audit_print -- --nocapture` prints the numbers.
//!
//! The slow stderr is real: the test runs itself again as a child process whose stderr is a pipe this process reads
//! a little at a time, then all at once when the child's run is measured.

#![allow(clippy::disallowed_methods)]

use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use replica::ids::Scope;
use sim::log::Mem;
use worldd::answers::{self, Config};
use worldd::checkers::toggles;
use worldd::measures::PHASES;

const LINEAGE: Scope = Scope([0x21; 16]);
const CHILD: &str = "WORLDD_AUDIT_PRINT_CHILD";
const NAME: &str = "the_clock_never_waits_on_the_auditors_prints";
/// Bodies in the world, each holding two things in each hand.
const BODIES: usize = 40;
/// How long the world runs.
const RUN: Duration = Duration::from_secs(10);
/// The slow reader: this much of stderr every 250 ms, 16 KiB a second.
const READ: usize = 4096;
const EVERY: Duration = Duration::from_millis(250);

/// The world, run in the child: its numbers on one line of stdout.
fn child() {
    let mut w = toggles::World::build(1, BODIES, 0);
    let per_pass = w.overfill_hands();
    let world = answers::start(
        w.replica,
        toggles::rules(),
        Mem::with(Vec::new()),
        Config::new(LINEAGE, 1),
    )
    .expect("the world starts");
    std::thread::sleep(RUN);
    let m = world.measures.clone().expect("measures are on");
    let (ticks, _) = world.beat.read();
    let audit = PHASES.iter().position(|p| *p == "audit").expect("the audit phase");
    println!(
        "audit-print: {per_pass} faults a pass; {ticks} ticks in {} s; worst tick {} us (p99 {} us); audit phase \
         worst {} us (p99 {} us)",
        RUN.as_secs(),
        m.ticks.quantile(1.0),
        m.ticks.quantile(0.99),
        m.phases[audit].quantile(1.0),
        m.phases[audit].quantile(0.99),
    );
    world.stop();
}

#[test]
fn the_clock_never_waits_on_the_auditors_prints() {
    if std::env::var_os(CHILD).is_some() {
        return child();
    }
    let mut c = Command::new(std::env::current_exe().expect("this test's binary"))
        .args(["--exact", NAME, "--nocapture", "--test-threads", "1"])
        .env(CHILD, "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the child runs");
    let fast = Arc::new(AtomicBool::new(false));
    let mut err = c.stderr.take().expect("its stderr");
    let reader = {
        let fast = fast.clone();
        std::thread::spawn(move || {
            let (mut text, mut buf) = (Vec::new(), vec![0; READ]);
            loop {
                let n = err.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                text.extend_from_slice(&buf[..n]);
                if !fast.load(Ordering::Relaxed) {
                    std::thread::sleep(EVERY);
                }
            }
            String::from_utf8_lossy(&text).into_owned()
        })
    };
    let mut numbers = None;
    for line in BufReader::new(c.stdout.take().expect("its stdout")).lines() {
        let line = line.expect("a line");
        // The harness writes the test's name on the same line, before its output.
        if let Some((_, n)) = line.split_once("audit-print: ") {
            numbers = Some(n.to_string());
            fast.store(true, Ordering::Relaxed);
        }
    }
    let status = c.wait().expect("the child ends");
    let err = reader.join().expect("the reader");
    let faults = err
        .lines()
        .filter(|l| l.starts_with("worldd: audit: Fault"))
        .count();
    let said: Vec<&str> = err
        .lines()
        .filter(|l| l.starts_with("worldd: audit:") && !l.starts_with("worldd: audit: Fault"))
        .collect();
    println!("{}", numbers.as_deref().unwrap_or("no numbers"));
    println!(
        "stderr: {faults} fault lines read; {} other audit lines, the last: {:?}",
        said.len(),
        said.last()
    );
    assert!(status.success(), "the child passed: {status}");
    assert!(numbers.is_some(), "the child measured its run");
    assert!(faults > 0, "the faults were printed");
}
