//! PROFILING ONLY (tick-budget-1000): sub-phase sums, printed every 600 ticks. Not for merge.
#![allow(clippy::disallowed_methods)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

pub const NAMES: [&str; 40] = [
    "b.carrying", "b.step", "b.walks", "b.writes", "b.settle", "b.forms", "b.engine", "b.places", "m.motion",
    "m.write", "r.orders", "r.inputs", "r.moved", "r.poses", "r.tree", "r.hash", "r.encode", "r.room",
    "n.moved", "n.samples", "n.poses", "n.tree", "n.bytes", "x23",
    "s.take", "s.due", "s.orders", "s.wind", "s.unstuckp", "s.planned", "s.after", "s.reach", "s.send", "s.heard",
    "s.walks", "t.scan", "t.nodes", "t.aud", "n.rehash", "n.ticks",
];
static SUM: [AtomicU64; 40] = [const { AtomicU64::new(0) }; 40];
static MAX: [AtomicU64; 40] = [const { AtomicU64::new(0) }; 40];

pub struct T(Instant);
pub fn t() -> T {
    T(Instant::now())
}
impl T {
    pub fn lap(&mut self, i: usize) {
        let n = Instant::now();
        add(i, n.duration_since(self.0).as_micros() as u64);
        self.0 = n;
    }
}
pub fn add(i: usize, v: u64) {
    SUM[i].fetch_add(v, Ordering::Relaxed);
    MAX[i].fetch_max(v, Ordering::Relaxed);
}
static TOTALS: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());
/// A whole tick's µs (all phases), kept for the run's exact percentiles.
pub fn total(us: u64) {
    if let Ok(mut v) = TOTALS.lock() {
        v.push(u32::try_from(us).unwrap_or(u32::MAX));
    }
}
fn totals_line() -> String {
    let Ok(v) = TOTALS.lock() else { return String::new() };
    let mut s = v.clone();
    s.sort_unstable();
    let q = |f: f64| s.get(((s.len() as f64 - 1.0) * f).round() as usize).copied().unwrap_or(0);
    let over = s.iter().filter(|&&x| x > 50_000).count();
    let mean = s.iter().map(|&x| u64::from(x)).sum::<u64>() / (s.len().max(1) as u64);
    format!(
        "prof-ticks: n={} mean={} p50={} p95={} p99={} max={} over={} over_pct={:.2}",
        s.len(), mean, q(0.5), q(0.95), q(0.99), s.last().copied().unwrap_or(0), over,
        over as f64 * 100.0 / s.len().max(1) as f64
    )
}
pub fn tick() {
    add(39, 1);
    let n = SUM[39].load(Ordering::Relaxed);
    if n >= 600 {
        for (i, k) in [(35, 0), (36, 1), (37, 2), (38, 3)] {
            add(i, replica::tree::PROF[k].swap(0, Ordering::Relaxed));
        }
        let tops = replica::tree::PROF[4].swap(0, Ordering::Relaxed);
        let timers = replica::tree::PROF[5].swap(0, Ordering::Relaxed);
        eprintln!("prof-n: tops={} timers={}", tops / n.max(1), timers / n.max(1));
        let u: Vec<u64> = sim::unstick::PROF.iter().map(|a| a.swap(0, Ordering::Relaxed)).collect();
        eprintln!(
            "prof-u: faults={}/{} reads={}/{} makeway={}/{} reroute={}/{} walker={}/{}",
            u[0] / n, u[1], u[2] / n, u[3], u[4] / n, u[5], u[6] / n, u[7], u[8] / n, u[9]
        );
        let mut s = String::from("prof:");
        for i in 0..39 {
            let v = SUM[i].swap(0, Ordering::Relaxed);
            let m = MAX[i].swap(0, Ordering::Relaxed);
            s.push_str(&format!(" {}={:.0}/{}", NAMES[i], v as f64 / n as f64, m));
        }
        SUM[39].store(0, Ordering::Relaxed);
        eprintln!("{s}");
        eprintln!("{}", totals_line());
    }
}
