//! `cargo run -p archive --release -- seek [hours]`: V4's measure (#2713). A day of a world of 1,000 bodies and 9,000
//! things is recorded into W8's in-memory store; then 100 random moments of the day, and 100 random moments of its
//! busiest minutes, are each seeked cold (the day's index and one bundle fetched, nothing kept between seeks) and the
//! time to draw is modelled on the declared reference link. Also prints Step 0's sizes and the index sizes for the day
//! and a modelled year (`v2/docs/archive.md`, seeking).
//!
//! The load: in the first minute of each hour every body moves each world second (the busiest scripted load: at the
//! history level a moving body keeps one sample a second, so this is what a world of 1,000 moving bodies writes);
//! the rest of the hour ten bodies step each ten seconds. One Soul speaks each minute (a named event).

use std::collections::BTreeMap;
use std::sync::Arc;

use miniz_oxide::deflate::compress_to_vec;

use archive::script::{self, TICK};
use archive::{Archiver, R, Shared, seek};
use directoryd::directory::store::{Memory, Store};
use replica::encode::encode;
use replica::history::events::{Counts, HourIndex, Span, counts_key, hour_key};
use replica::history::{Bundle, DayIndex, day_of};

/// The reference link until the coordinator names one (the issue's default), declared before the run.
const LINK_BITS_PER_S: f64 = 20e6;
const LINK_RTT_S: f64 = 0.050;
/// A cold connection: TCP's and TLS 1.3's round trips before the first request.
const SETUP_RTTS: f64 = 2.0;

const PREFIX: &str = "worlds/seek/";
const BODIES: usize = 1_000;

/// A small seeded generator (xorshift64*): the moments are the same each run.
struct Rng(u64);

impl Rng {
    fn below(&mut self, n: u64) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d) % n
    }
}

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.total_cmp(b));
    let i = ((p * v.len() as f64).ceil() as usize).clamp(1, v.len()) - 1;
    v[i]
}

/// Seeks each moment cold and prints the table: link time modelled, apply time measured on this machine.
#[allow(clippy::disallowed_methods)] // A bench: it times the apply on the wall clock (K7 allows tools to).
fn seeks(
    store: &Memory,
    header: &replica::effects::Header,
    label: &str,
    at: &[i64],
    wire: &mut BTreeMap<String, u64>,
) -> R<()> {
    let (mut total, mut bytes, mut apply, mut raw) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut nodes = 0;
    for &t in at {
        let start = std::time::Instant::now();
        let s = seek(store, PREFIX, header, t)?;
        let cpu = start.elapsed().as_secs_f64();
        let mut on_wire = 0;
        for k in &s.keys {
            if !wire.contains_key(k) {
                let b = store.get(k)?.map(|o| o.bytes).unwrap_or_default();
                wire.insert(k.clone(), compress_to_vec(&b, 6).len() as u64);
            }
            on_wire += wire[k];
        }
        let link = (SETUP_RTTS + f64::from(s.requests)) * LINK_RTT_S
            + on_wire as f64 * 8.0 / LINK_BITS_PER_S;
        total.push(link + cpu);
        bytes.push(on_wire as f64);
        raw.push(s.bytes as f64);
        apply.push(cpu);
        nodes = nodes.max(s.state.nodes.len());
    }
    let mean = bytes.iter().sum::<f64>() / bytes.len() as f64;
    println!(
        "{label}: {} seeks, ready to draw p50 {:.3} s, p95 {:.3} s, max {:.3} s; bytes per seek on the wire mean {:.0}, \
         p95 {:.0}, max {:.0} (stored, uncompressed: p95 {:.0}); apply p95 {:.3} s; up to {nodes} public nodes; \
         bar p95 < 2 s {}",
        at.len(),
        pct(&mut total.clone(), 0.5),
        pct(&mut total.clone(), 0.95),
        pct(&mut total.clone(), 1.0),
        mean,
        pct(&mut bytes.clone(), 0.95),
        pct(&mut bytes, 1.0),
        pct(&mut raw, 0.95),
        pct(&mut apply, 0.95),
        if pct(&mut total, 0.95) < 2.0 {
            "MET"
        } else {
            "UNMET"
        }
    );
    Ok(())
}

fn size<S: Store>(store: &S, key: &str) -> R<usize> {
    Ok(store.get(key)?.map_or(0, |o| o.bytes.len()))
}

pub fn run(hours: i64) -> R<()> {
    println!(
        "reference link (declared before the run): {} Mbit/s, {} ms round trip, {} round trips to open a connection, \
         one per request; no cache",
        LINK_BITS_PER_S / 1e6,
        LINK_RTT_S * 1e3,
        SETUP_RTTS
    );
    let (mut w, queue) = crate::logged(BODIES / 10, 90);
    let (root, kind) = crate::root_of(&w);
    let store = Arc::new(Memory::default());
    let a = Archiver::open(Shared(store.clone()), PREFIX, &w.header, root, kind)?;
    let (tx, archiver) = a.spawn();
    let mut n = 0u64;
    let mut send = |queue: &std::rc::Rc<std::cell::RefCell<Vec<Vec<u8>>>>| -> R<()> {
        for p in queue.borrow_mut().drain(..) {
            tx.send((n, p))
                .or_else(|_| archive::refuse("archive-stopped", "the archiver stopped"))?;
            n += 1;
        }
        Ok(())
    };
    send(&queue)?;
    let ticks_a_second = (1_000_000 / TICK) as u64;
    for s in 1..hours * 3600 {
        let busy = s % 3600 < 60;
        if !busy && s % 10 != 0 {
            continue;
        }
        let movers = if busy { BODIES } else { 10 };
        script::tick(
            &mut w,
            s as u64 * ticks_a_second,
            movers,
            60 * ticks_a_second,
        );
        send(&queue)?;
    }
    drop(tx);
    let writes = archiver
        .join()
        .unwrap_or_else(|p| std::panic::resume_unwind(p))?;
    println!("recorded {hours} h: {n} records, writes {writes:?}");

    // Step 0: one snapshot and one bundle at the top load (a busy minute's bundle).
    let ix = DayIndex::read(
        &store
            .get(&format!("{PREFIX}bundles/00000000/index"))?
            .expect("a day index")
            .bytes,
    )?;
    let busy = ix
        .bundles
        .iter()
        .find(|(s, _, _)| *s == 3_600_000_000)
        .expect("a busy minute");
    let b = Bundle::read(&store.get(&busy.1)?.expect("the bundle").bytes)?;
    let snap = encode(&b.snapshot).map_or(0, |v| v.len());
    let z = |v: &[u8]| compress_to_vec(v, 6).len();
    let snap_z = z(&encode(&b.snapshot).unwrap_or_default());
    println!(
        "step 0 on the wire (deflate, as V1's compression in transit carries them): snapshot {snap_z} bytes, the \
         one-minute bundle {} bytes; bar 4,000,000 {}",
        z(b.bytes()),
        if z(b.bytes()) < 4_000_000 {
            "MET at one minute"
        } else {
            "UNMET"
        }
    );
    println!(
        "step 0: at the top load a one-minute bundle is {} bytes, its snapshot {snap} and its view {} ({} records); \
         a five-minute bundle would hold five times the view: {} bytes; bar 4,000,000 {}",
        b.bytes().len(),
        b.bytes().len() - snap,
        b.records(),
        snap + 5 * (b.bytes().len() - snap),
        if b.bytes().len() < 4_000_000 {
            "MET at one minute"
        } else {
            "UNMET"
        }
    );

    let header = &w.header;
    let span = hours * 3_600_000_000;
    let mut rng = Rng(0x2713_2713);
    let any: Vec<i64> = (0..100).map(|_| rng.below(span as u64) as i64).collect();
    let mut wire = BTreeMap::new();
    seeks(
        &store,
        header,
        "100 random moments of the day",
        &any,
        &mut wire,
    )?;
    let busy: Vec<i64> = (0..100)
        .map(|_| rng.below(hours as u64) as i64 * 3_600_000_000 + rng.below(60_000_000) as i64)
        .collect();
    seeks(
        &store,
        header,
        "100 random moments of its busy minutes",
        &busy,
        &mut wire,
    )?;

    // The index sizes: the day's, and a modelled year's.
    let day = day_of(0);
    let hours_bytes: usize = (0..24)
        .map(|h| size(&*store, &format!("{PREFIX}{}", hour_key(day, h))))
        .sum::<R<usize>>()?;
    let rows: usize = (0..24)
        .filter_map(|h| {
            store
                .get(&format!("{PREFIX}{}", hour_key(day, h)))
                .ok()
                .flatten()
        })
        .map(|o| HourIndex::read(&o.bytes).map(|i| i.rows.len()))
        .sum::<R<usize>>()?;
    let counts_day = size(&*store, &format!("{PREFIX}{}", counts_key(Span::Day(day))))?;
    let counts_year = size(&*store, &format!("{PREFIX}{}", counts_key(Span::Year(0))))?;
    let day_index = size(&*store, &format!("{PREFIX}bundles/{day:08}/index"))?;
    let check = Counts::read(
        &store
            .get(&format!("{PREFIX}{}", counts_key(Span::Day(day))))?
            .expect("counts")
            .bytes,
    )?;
    let per_row = hours_bytes as f64 / rows.max(1) as f64;
    println!(
        "index, one day: event index {hours_bytes} bytes in {} hours ({rows} events, {per_row:.1} bytes each); \
         ten-minute counts {counts_day} bytes ({} rows); bundles' day index {day_index} bytes",
        24,
        check.counts.len()
    );
    println!(
        "timeline of a day: drawn from its ten-minute counts, {counts_day} bytes; with the whole event index for \
         markers, {} bytes; bar 200,000 {}",
        counts_day + hours_bytes,
        if counts_day + hours_bytes < 200_000 {
            "MET"
        } else {
            "UNMET"
        }
    );
    // A year: 365 such days; the year's counts gain one slot a day per kind, so at most 365 times one day's.
    println!(
        "modelled year at this load: event index {:.1} MB, day counts {:.2} MB, year counts at most {:.0} bytes, \
         bundles' day indexes {:.1} MB",
        hours_bytes as f64 * 365.0 / 1e6,
        counts_day as f64 * 365.0 / 1e6,
        counts_year as f64 * 365.0,
        day_index as f64 * 365.0 / 1e6
    );
    println!(
        "modelled year at the target's 5,000 acts a minute, each a named event: {:.2} GB of event index ({:.0} MB a \
         day, {:.0} MB an hour); a day's ten-minute counts stay at most 144 slots per kind",
        per_row * 5_000.0 * 60.0 * 24.0 * 365.0 / 1e9,
        per_row * 5_000.0 * 60.0 * 24.0 / 1e6,
        per_row * 5_000.0 * 60.0 / 1e6
    );
    Ok(())
}
