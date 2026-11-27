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
        let mut s = String::from("prof:");
        for i in 0..39 {
            let v = SUM[i].swap(0, Ordering::Relaxed);
            let m = MAX[i].swap(0, Ordering::Relaxed);
            s.push_str(&format!(" {}={:.0}/{}", NAMES[i], v as f64 / n as f64, m));
        }
        SUM[39].store(0, Ordering::Relaxed);
        eprintln!("{s}");
    }
}
