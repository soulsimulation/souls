//! X10 (#4019): one row of the fault table, from a driver run's trace (`driver --trace`), the world's log, the fault
//! script's events and its memory samples (`x10-faults.sh`).
//!
//!   x10-check --fault <name> --trace <file> --log <world folder>/log --events <file> [--rss <file>]
//!
//! - **recovery**: each agent's first act in play at or after the fault (for a drop, after the agent signed in
//!   again), timed from the later of its send and that point to its answer, a receipt or the world's refusal (p50 and
//!   slowest, ms); an agent with an act never answered is never back.
//! - **acked, lost**: every receipt the driver had (kind 1) must be among the world's log's answered rows (I4's
//!   `ANSWERED`, `worldd::answers`): those that are not were acknowledged and lost. The bar is 0.
//! - **duplicates**: a second receipt for one (Soul, sequence). The bar is 0.
//! - **stuck**: an agent that sent acts in the run's last 60 s and had no receipt for any of them, or one with an act
//!   never answered (the gateway's never-silence rule, C8, answers every intent). The bar is 0.
//! - **memory**: worldd's and gatewayd's resident size before the fault, at its peak and at the end (MB).
//!
//! Exit 0 when every bar holds.

use std::collections::{BTreeMap, BTreeSet};

use replica::effects::read_id;
use replica::encode::{Value, decode, to_hex};
use sim::log::recover;

/// The field of a world's tick record that lists the intents it answered (`worldd::answers::ANSWERED`).
const ANSWERED: u64 = 3;

fn quantile(v: &mut [u64], q: f64) -> u64 {
    if v.is_empty() {
        return 0;
    }
    v.sort_unstable();
    v[((v.len() - 1) as f64 * q).round() as usize]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|k| args.get(k + 1))
    };
    let (Some(fault), Some(trace), Some(log), Some(events)) = (
        arg("--fault"),
        arg("--trace"),
        arg("--log"),
        arg("--events"),
    ) else {
        eprintln!(
            "usage: x10-check --fault <name> --trace <file> --log <world log> --events <file> [--rss <file>]"
        );
        std::process::exit(2);
    };
    let read = |p: &str| std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{p}: {e}"));
    // The fault's events: `<unix ms> <name>`; the first is the fault itself.
    let events: Vec<(u64, String)> = read(events)
        .lines()
        .filter_map(|l| {
            let (t, n) = l.split_once(' ')?;
            Some((t.parse().ok()?, n.to_owned()))
        })
        .collect();
    let at = events.first().map_or(0, |e| e.0);

    // The trace.
    let mut soul: BTreeMap<u64, String> = BTreeMap::new();
    let mut acked: BTreeSet<(String, u64)> = BTreeSet::new();
    let mut firsts: Vec<(u64, u64, u64, String)> = Vec::new();
    let (mut dups, mut open) = (0u64, Vec::new());
    let mut back: BTreeMap<u64, Vec<u64>> = BTreeMap::new();
    let mut gone = BTreeSet::new();
    let mut end = 0u64;
    for l in read(trace).lines() {
        let f: Vec<&str> = l.split(' ').collect();
        let n = |i: usize| f.get(i).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
        match f[0] {
            "soul" => {
                soul.insert(n(1), f[2].to_owned());
            }
            "ack" => {
                acked.insert((soul[&n(1)].clone(), n(2)));
                end = end.max(n(3));
            }
            "dup" => dups += 1,
            "first" => {
                firsts.push((n(1), n(3), n(4), f[5..].join(" ")));
                end = end.max(n(4));
            }
            "open" => open.push(n(1)),
            "gone" => {
                gone.insert(n(1));
            }
            "back" => back.entry(n(1)).or_default().push(n(2)),
            _ => {}
        }
    }

    // Recovery: each agent's first act in play at or after the fault (for a drop, after it signed in again), timed
    // from the later of its send and that point to its answer (a receipt or the world's refusal).
    let mut took: Vec<u64> = Vec::new();
    let mut never = 0u64;
    let mut agents: BTreeMap<u64, Vec<(u64, u64)>> = BTreeMap::new();
    for (k, sent, answered, _) in &firsts {
        agents.entry(*k).or_default().push((*sent, *answered));
    }
    let from = |k: u64| {
        if fault.starts_with("drop") {
            back.get(&k).map(|t| t[0])
        } else {
            Some(at)
        }
    };
    let mut timed: BTreeSet<u64> = BTreeSet::new();
    for (k, acts) in &mut agents {
        let Some(r) = from(*k) else { continue };
        acts.sort_unstable();
        if let Some((sent, answered)) = acts.iter().find(|(_, a)| *a >= r) {
            took.push(answered - sent.max(&r));
            timed.insert(*k);
        }
    }
    for k in open.iter().collect::<BTreeSet<_>>() {
        if from(*k).is_some() && !timed.contains(k) {
            never += 1;
        }
    }
    let p50 = quantile(&mut took.clone(), 0.5);
    let slowest = took.iter().copied().max().unwrap_or(0);

    // The world's log: every (Soul, sequence) it answered.
    let bytes = std::fs::read(log).unwrap_or_else(|e| panic!("{log}: {e}"));
    let found = recover(&bytes).unwrap_or_else(|e| panic!("{log}: {e:?}"));
    let mut logged: BTreeSet<(String, u64)> = BTreeSet::new();
    for r in &found.records {
        let Ok(Value::Map(part)) = decode(r).map(|d| d.value) else {
            continue;
        };
        let Some(Value::Array(rows)) = part.get(&ANSWERED) else {
            continue;
        };
        for row in rows {
            let Value::Map(m) = row else { continue };
            let (Some(Value::Bytes(key)), Some(Value::Uint(q))) = (m.get(&1), m.get(&2)) else {
                continue;
            };
            let id = decode(key).ok().and_then(|d| match d.value {
                Value::Map(a) => a.get(&2).and_then(|v| read_id(v).ok()),
                _ => None,
            });
            if let Some(id) = id {
                logged.insert((format!("{}:{}", to_hex(&id.scope().0), id.counter()), *q));
            }
        }
    }
    let lost: Vec<&(String, u64)> = acked.difference(&logged).collect();

    // Stuck: acts in the last 60 s with no receipt among them, or an act never answered.
    let mut last: BTreeMap<u64, (u64, u64, BTreeMap<String, u64>)> = BTreeMap::new();
    for (k, _, answered, outcome) in &firsts {
        if *answered + 60_000 >= end {
            let e = last.entry(*k).or_default();
            e.0 += 1;
            if outcome == "receipt" {
                e.1 += 1;
            } else {
                *e.2.entry(outcome.clone()).or_default() += 1;
            }
        }
    }
    let mut stuck: BTreeSet<u64> = last
        .iter()
        .filter(|(_, (n, r, _))| *n > 0 && *r == 0)
        .map(|(k, _)| *k)
        .collect();
    stuck.extend(open.iter().copied());
    let why: Vec<String> = stuck
        .iter()
        .map(|k| {
            let refused = last
                .get(k)
                .map(|e| format!("{:?}", e.2))
                .unwrap_or_default();
            format!("agent {k} {refused}")
        })
        .collect();

    // Memory: `<unix ms> <worldd kB> <gatewayd kB>` samples.
    let mem = arg("--rss").map(|p| {
        let s: Vec<(u64, u64, u64)> = read(p)
            .lines()
            .filter_map(|l| {
                let f: Vec<u64> = l.split(' ').filter_map(|v| v.parse().ok()).collect();
                (f.len() == 3).then(|| (f[0], f[1], f[2]))
            })
            .collect();
        let mb = |kb: u64| kb / 1024;
        let before = s
            .iter()
            .rev()
            .find(|x| x.0 < at)
            .copied()
            .unwrap_or_default();
        let peak_w = s.iter().map(|x| x.1).max().unwrap_or(0);
        let peak_g = s.iter().map(|x| x.2).max().unwrap_or(0);
        let last = s.last().copied().unwrap_or_default();
        format!(
            "worldd {}/{}/{} MB, gatewayd {}/{}/{} MB",
            mb(before.1),
            mb(peak_w),
            mb(last.1),
            mb(before.2),
            mb(peak_g),
            mb(last.2)
        )
    });

    let pass = lost.is_empty() && dups == 0 && stuck.is_empty() && never == 0;
    let ev: Vec<String> = events
        .iter()
        .map(|(t, n)| format!("{n} +{} ms", t.saturating_sub(at)))
        .collect();
    println!(
        "| {fault} | {} | {} | {p50} | {slowest} | {never} | {} | {} | {dups} | {} | {} | {} |",
        ev.join(", "),
        took.len(),
        acked.len(),
        lost.len(),
        stuck.len(),
        mem.unwrap_or_else(|| "-".into()),
        if pass { "MET" } else { "MISSED" }
    );
    for (s, q) in lost.iter().take(10) {
        eprintln!("  lost: soul {s} sequence {q}");
    }
    for w in why.iter().take(10) {
        eprintln!("  stuck: {w}");
    }
    eprintln!(
        "  gone {} agents; {} log records; {} answered rows",
        gone.len(),
        found.records.len(),
        logged.len()
    );
    std::process::exit(if pass { 0 } else { 1 });
}
