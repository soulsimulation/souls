//! The check's child process (G6, #2747; `assets::child`): the file on standard input, the limits and the memory
//! bound on the command line, one line of JSON and then the stripped bytes on standard output. Every allocation is
//! counted; one past the bound fails, which ends the process.

use assets::check::{Limits, check};
use assets::child::write_answer;
use std::alloc::{GlobalAlloc, Layout, System};
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counted;

static NOW: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static BOUND: AtomicUsize = AtomicUsize::new(usize::MAX);

// SAFETY: every call goes to the system allocator; the counters only decide whether to ask it.
unsafe impl GlobalAlloc for Counted {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let now = NOW.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
        if now > BOUND.load(Ordering::Relaxed) {
            NOW.fetch_sub(layout.size(), Ordering::Relaxed);
            return std::ptr::null_mut();
        }
        PEAK.fetch_max(now, Ordering::Relaxed);
        // SAFETY: the caller's layout, passed on.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        NOW.fetch_sub(layout.size(), Ordering::Relaxed);
        // SAFETY: allocated above with this layout.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static COUNTED: Counted = Counted;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(limits), Some(bound)) = (
        args.get(..7).and_then(Limits::from_args),
        args.get(7).and_then(|a| a.parse::<usize>().ok()),
    ) else {
        eprintln!("usage: assets-check <7 limits> <memory bytes> < file");
        std::process::exit(2);
    };
    BOUND.store(bound, Ordering::Relaxed);
    let mut file = Vec::new();
    // One byte past the size limit is enough to refuse it.
    if std::io::stdin()
        .take(limits.bytes + 1)
        .read_to_end(&mut file)
        .is_err()
    {
        std::process::exit(3);
    }
    let result = check(&file, &limits);
    drop(file);
    let peak = PEAK.load(Ordering::Relaxed) as u64;
    if write_answer(&mut std::io::stdout().lock(), &result, peak).is_err() {
        std::process::exit(4);
    }
}
