//! PROFILING ONLY (tick-budget-1000): sub-phase sums, printed every 600 ticks. Not for merge.
#![allow(clippy::disallowed_methods)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

pub const NAMES: [&str; 24] = [
    "b.carrying", "b.step", "b.walks", "b.writes", "b.settle", "b.forms", "b.engine", "b.places", "m.motion",
    "m.write", "r.orders", "r.inputs", "r.moved", "r.poses", "r.tree", "r.hash", "r.encode", "r.room",
    "n.moved", "n.samples", "n.poses", "n.tree", "n.bytes", "n.ticks",
];
static SUM: [AtomicU64; 24] = [const { AtomicU64::new(0) }; 24];
static MAX: [AtomicU64; 24] = [const { AtomicU64::new(0) }; 24];

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
    add(23, 1);
    let n = SUM[23].load(Ordering::Relaxed);
    if n >= 600 {
        let mut s = String::from("prof:");
        for i in 0..23 {
            let v = SUM[i].swap(0, Ordering::Relaxed);
            let m = MAX[i].swap(0, Ordering::Relaxed);
            s.push_str(&format!(" {}={:.0}/{}", NAMES[i], v as f64 / n as f64, m));
        }
        SUM[23].store(0, Ordering::Relaxed);
        eprintln!("{s}");
    }
}
