//! The `tree` bench (Engine v2 K2, #2646): a world of 10,000 things and 1,000 bodies built in `replica`'s tree
//! through `commit`, then the memory it holds (A2) and the cost of listing children and links (A3), in that world
//! and in one ten times larger. Run from `v2/`: `cargo run -p bench --release --bin tree`. Declared on #2646.

// Times its own runs: the wall-clock rule (K7) binds the engine, not this bench.
#![allow(clippy::disallowed_methods)]

mod world;

use replica::ids::Id;
use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;
use world::build;

/// Counts the bytes the program holds, and the most it has held.
struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every call is passed straight to the system allocator; the counters only add and subtract sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            let now = LIVE.fetch_add(layout.size(), Relaxed) + layout.size();
            PEAK.fetch_max(now, Relaxed);
        }
        p
    }

    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        unsafe { System.dealloc(p, layout) };
        LIVE.fetch_sub(layout.size(), Relaxed);
    }

    unsafe fn realloc(&self, p: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, layout, size) };
        if !q.is_null() {
            LIVE.fetch_sub(layout.size(), Relaxed);
            let now = LIVE.fetch_add(size, Relaxed) + size;
            PEAK.fetch_max(now, Relaxed);
        }
        q
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn mb(bytes: usize) -> String {
    format!("{:.1} MB", bytes as f64 / 1e6)
}

/// Mean nanoseconds of `f` over `n` calls.
fn ns(n: u32, mut f: impl FnMut(u32)) -> f64 {
    let start = Instant::now();
    for i in 0..n {
        f(i);
    }
    start.elapsed().as_nanos() as f64 / f64::from(n)
}

fn main() {
    // A2: what the world holds.
    let before = LIVE.load(Relaxed);
    PEAK.store(before, Relaxed);
    let t0 = Instant::now();
    let w = build(1);
    let built = t0.elapsed();
    let (nodes, links) = w.tree.counts();
    let held = LIVE.load(Relaxed) - before;
    let peak = PEAK.load(Relaxed) - before;
    let moving = w.tree.moving().iter().flatten().count();
    println!("## A2: memory");
    println!();
    println!(
        "| world | nodes | links | moving | held after build | peak while building | built in |"
    );
    println!("|---|---|---|---|---|---|---|");
    println!(
        "| 10,000 things, 1,000 bodies | {nodes} | {links} | {moving} | {} | {} | {:.0} ms |",
        mb(held),
        mb(peak),
        built.as_secs_f64() * 1000.0
    );

    // A3: children, listed from nodes holding 1, 10, 100 and 1,000.
    let mut w = w;
    println!();
    println!("## A3: listing children (1x world)");
    println!();
    println!("| children | ns per listing | ns per child | node reads, link reads |");
    println!("|---|---|---|---|");
    for k in [1usize, 10, 100, 1000] {
        let room = w.room(0, k);
        let h = w.tree.handle(room).expect("the room");
        w.tree.reset_reads();
        let _ = w.tree.children(h);
        let reads = w.tree.reads();
        let n = 2_000_000 / k as u32;
        let per = ns(n, |_| {
            for c in w.tree.children(black_box(h)).expect("live") {
                black_box(c);
            }
        });
        println!("| {k} | {per:.1} | {:.2} | {reads:?} |", per / k as f64);
    }

    // A3: links from either end, in the world and in one ten times larger.
    println!();
    println!("## A3: finding links from either end");
    println!();
    println!("| world | nodes | end | ns per listing | links listed | node reads, link reads |");
    println!("|---|---|---|---|---|---|");
    drop(w);
    for scale in [1usize, 10] {
        let w = build(scale);
        let (nodes, _) = w.tree.counts();
        for (end, ids) in [("body (node end)", &w.bodies), ("Soul (far end)", &w.souls)] {
            let sample: Vec<Id> = ids
                .iter()
                .step_by(ids.len() / 1000)
                .copied()
                .take(1000)
                .collect();
            w.tree.reset_reads();
            let listed = w.tree.links_at(sample[0]).len();
            let reads = w.tree.reads();
            let per = ns(2_000_000, |i| {
                let e = w
                    .tree
                    .links_at(black_box(sample[i as usize % sample.len()]));
                black_box(e.first().map(|x| x.other));
            });
            println!("| {scale}x | {nodes} | {end}, by id | {per:.1} | {listed} | {reads:?} |");
        }
        let handles: Vec<_> = w
            .bodies
            .iter()
            .step_by(w.bodies.len() / 1000)
            .map(|b| w.tree.handle(*b).expect("live"))
            .collect();
        let per = ns(2_000_000, |i| {
            let e = w
                .tree
                .links_of(black_box(handles[i as usize % handles.len()]))
                .expect("live");
            black_box(e.first().map(|x| x.other));
        });
        println!("| {scale}x | {nodes} | body (node end), by handle | {per:.1} | 1 | (1, 0) |");
    }
}
