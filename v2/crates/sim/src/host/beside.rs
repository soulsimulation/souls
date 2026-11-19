//! Skills stepped side by side (Engine v2 N17b, #3255): one tick's skill phase on several threads, with the outcome
//! a single thread gives, bit for bit, whatever the number of threads.
//!
//! - **Why it can.** Every skill reads the world as it stood at the tick's start (T1) and writes only to its stage, so
//!   no skill's step can see another's. What the questions write as they go is either one walker's own (its line of
//!   corners, `crate::walk::town::Line`) or a cache whose value does not depend on who found it first (the route
//!   search's, `crate::routes::Scratch`), so it is split by walker or kept per thread.
//! - **Chunks.** The runs are taken in body id order and cut into chunks of at most [`CHUNK`] consecutive runs whose
//!   skills may be stepped beside others ([`Skill::beside`]); every other skill is a chunk of its own. The cut does
//!   not depend on the number of threads. Threads take the side-by-side chunks one at a time; the tick's own thread
//!   steps the others as their turn comes in chunk order, with the tick's draws and timer ids. Each run stages into its
//!   own [`Staged`] (as `super::step_in_units` does), and the stages are joined in body order, so the joined stage is
//!   the one a single thread fills.
//! - **Draws and timers** are numbered in the tick's order, so a skill stepped beside others may use neither: either
//!   is refused with a panic ([`BESIDE_ORDERED`]), at any thread count, so the outcome still does not depend on it.
//! - **A panic is one body's** (K11's unit, `crate::unit`; K18 #3160): a skill that panics has its stage dropped and
//!   its run ended by name ([`UNIT_PANICKED`], the panic's message in [`Units::ended`]), and every other body's step is
//!   as it would be without it. Panics are counted in body order once the threads have joined, so a unit retired by
//!   its third (`unit-retired`) ends the later runs of that tick as one thread would, their stages dropped.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Mutex;

use replica::encode::{Name, Value};
use replica::host::{Progress, Skill};
use replica::ids::{Id, Minter};
use replica::pose::Vec3;
use replica::time::Micros;

use super::{Here, Moved, Planned, Run, Staged, WorldHost, body_kind, named};
use crate::controller::{Controller, Driver};
use crate::routes::Scratch;
use crate::unit::Units;
use crate::walk::town::{Line, Lines, Shared, Spent, Split};

/// The most consecutive side-by-side runs one thread takes at a time.
pub const CHUNK: usize = 64;
/// A skill's step panicked: its run ends by this name.
pub const UNIT_PANICKED: &str = "unit-panicked";
/// A skill whose unit is retired: its run ends by this name.
const UNIT_RETIRED: &str = "unit-retired";
/// The panic of a skill stepped beside others that drew or set a timer.
pub const BESIDE_ORDERED: &str = "beside-ordered";

/// What every skill's step reads besides the town: the bodies, their fields, who stands settled, the tick, and with a
/// planner (K18b, #3175) its lines of the last tick.
pub(super) struct Reads<'a> {
    pub controller: &'a Controller,
    pub fields: &'a BTreeMap<Id, BTreeMap<u64, Value>>,
    pub settled: &'a BTreeSet<Id>,
    pub now: Micros,
    pub seed: u64,
    pub planned: Option<&'a Planned>,
}

/// A chunk's runs: index in the sorted runs, body, driver and skill.
type Chunk<'r, S> = Vec<(usize, Id, Driver, &'r mut S)>;
/// A chunk to step: its place in the chunk order, its runs, and its walkers' lines.
type Job<'r, S> = (usize, Chunk<'r, S>, &'r mut [(Id, Line)]);

/// What stepping one chunk gave.
struct Out {
    /// Each run's outcome, in body order.
    runs: Vec<Stepped>,
    /// Lines found for walkers that had none, in walker order.
    lines: Vec<(Id, Line)>,
    /// With a planner: the lines asked of it, in step order (K18b).
    asked: Vec<(Moved, Vec3)>,
    spent: Spent,
}

/// One run's step: its index in the sorted runs, its body, its unit, its own stage and how it went.
struct Stepped {
    i: usize,
    body: Id,
    unit: Name,
    staged: Staged,
    what: What,
}

enum What {
    Stepped(Progress),
    /// It panicked, with the panic's message: its stage is empty.
    Panicked(String),
    /// Its unit was retired at the tick's start: not stepped.
    Retired,
}

/// Steps every run once, as `super::step_in_units` does, on the threads `split` has a scratch for: the runs sorted by
/// body, the ones that ended taken out, each panic and refusal counted in `units`. Returns the joined stage; with a
/// planner, the lines asked of it are added to `asked` in body order (K18b).
pub(super) fn step(
    split: Split<'_>,
    reads: Reads<'_>,
    minter: &mut Minter,
    runs: &mut Vec<Run>,
    chunk: usize,
    units: &mut Units,
    asked: &mut Vec<(Moved, Vec3)>,
) -> Staged {
    let Split {
        shared,
        scratches,
        lines: town_lines,
        spent: town_spent,
    } = split;
    runs.sort_by_key(|r| r.body);
    let chunk = chunk.max(1);
    let beside: Vec<bool> = runs
        .iter_mut()
        .map(|r| r.skill.beside().is_some())
        .collect();
    // Where each chunk starts, and whether its skills are stepped beside others.
    let mut starts: Vec<(usize, bool)> = Vec::new();
    for (i, &b) in beside.iter().enumerate() {
        let open = match starts.last() {
            Some(&(f, lb)) => !b || !lb || i - f >= chunk,
            None => true,
        };
        if open {
            starts.push((i, b));
        }
    }
    if starts.is_empty() {
        return Staged::default();
    }
    // Each chunk takes the lines of the walkers from its first body up to the next chunk's.
    let firsts: Vec<Id> = starts.iter().map(|&(f, _)| runs[f].body).collect();
    let mut rest: &mut [(Id, Line)] = town_lines;
    let mut parts = Vec::with_capacity(starts.len());
    for k in 0..starts.len() {
        let n = firsts
            .get(k + 1)
            .map_or(rest.len(), |b| rest.partition_point(|e| e.0 < *b));
        let (mine, more) = std::mem::take(&mut rest).split_at_mut(n);
        rest = more;
        parts.push(mine);
    }
    let mut parts = parts.into_iter();
    let mut besides: Vec<Job<'_, dyn Skill + Send>> = Vec::new();
    let mut alones: Vec<Job<'_, dyn Skill>> = Vec::new();
    let mut next = 0;
    for (i, r) in runs.iter_mut().enumerate() {
        if next < starts.len() && starts[next].0 == i {
            let l = parts.next().unwrap_or_default();
            if starts[next].1 {
                besides.push((next, Vec::new(), l));
            } else {
                alones.push((next, Vec::new(), l));
            }
            next += 1;
        }
        let Run {
            body,
            driver,
            skill,
        } = r;
        if beside[i] {
            let Some(s) = skill.beside() else {
                unreachable!("a skill stepped beside others a moment ago")
            };
            if let Some(c) = besides.last_mut() {
                c.1.push((i, *body, *driver, s));
            }
        } else if let Some(c) = alones.last_mut() {
            c.1.push((i, *body, *driver, &mut **skill));
        }
    }

    let kind = body_kind();
    let mut outs: Vec<Option<Out>> = (0..starts.len()).map(|_| None).collect();
    let queue = Mutex::new(besides.into_iter());
    let before: &Units = units;
    let work = |scratch: &mut Scratch| -> Vec<(usize, Out)> {
        let mut done = Vec::new();
        while let Some((at, mut runs, lines)) = queue.lock().ok().and_then(|mut q| q.next()) {
            done.push((
                at,
                run(
                    shared, &reads, scratch, &kind, None, 0, before, &mut runs, lines,
                ),
            ));
        }
        done
    };
    let work = &work;
    let done: Vec<Vec<(usize, Out)>> = match scratches.split_first_mut() {
        Some((first, others)) if !others.is_empty() => std::thread::scope(|sc| {
            let handles: Vec<_> = others
                .iter_mut()
                .map(|s| sc.spawn(move || work(s)))
                .collect();
            let mut all = vec![work(first)];
            for h in handles {
                // A panic outside every skill's step (none is expected) goes on as the tick's own.
                all.push(h.join().unwrap_or_else(|p| std::panic::resume_unwind(p)));
            }
            all
        }),
        Some((first, _)) => vec![work(first)],
        None => vec![work(&mut Scratch::default())],
    };
    for (at, out) in done.into_iter().flatten() {
        outs[at] = Some(out);
    }

    // In chunk order: the other skills stepped on the tick's own thread as their turn comes, with the tick's draws
    // and timers, and every run's outcome counted in K11's units, as one thread steps them (`super::step_in_units`).
    let mut staged = Staged::default();
    let mut gone = BTreeSet::new();
    let mut spent = town_spent.get();
    let mut new: Vec<(Id, Line)> = Vec::new();
    let mut own = Scratch::default();
    let scratch = scratches.first_mut().unwrap_or(&mut own);
    let mut alones = alones.into_iter();
    // An empty slot is the next of the other skills' chunks, which come in chunk order.
    for slot in &mut outs {
        let out = match slot.take() {
            Some(out) => out,
            None => {
                let Some((_, mut runs, lines)) = alones.next() else {
                    continue;
                };
                let draws = staged.draws;
                run(
                    shared,
                    &reads,
                    scratch,
                    &kind,
                    Some(&mut *minter),
                    draws,
                    units,
                    &mut runs,
                    lines,
                )
            }
        };
        for r in out.runs {
            let unit = r.unit.as_str();
            let ended = match r.what {
                What::Panicked(message) => Some(named(units.fail(unit, r.body, message).reason)),
                What::Retired => Some(named(units.refuse(unit, r.body).unwrap_or(UNIT_RETIRED))),
                // Retired by a panic earlier in this tick: a single thread would not have stepped it.
                What::Stepped(_) if units.is_retired(unit) => {
                    Some(named(units.refuse(unit, r.body).unwrap_or(UNIT_RETIRED)))
                }
                What::Stepped(progress) => {
                    staged.merge(r.staged);
                    match progress {
                        Progress::Going => None,
                        ended => {
                            staged.ended.push((r.body, ended));
                            gone.insert(r.i);
                            continue;
                        }
                    }
                }
            };
            if let Some(name) = ended {
                staged.ended.push((r.body, Progress::Failed(name)));
                gone.insert(r.i);
            }
        }
        spent.add(&out.spent);
        new.extend(out.lines);
        asked.extend(out.asked);
    }
    town_spent.set(spent);
    if !new.is_empty() {
        // The new lines join the rest in walker order: one pass.
        new.sort_by_key(|e| e.0);
        let old = std::mem::take(town_lines);
        let mut joined = Vec::with_capacity(old.len() + new.len());
        let (mut a, mut b) = (old.into_iter().peekable(), new.into_iter().peekable());
        while let (Some(x), Some(y)) = (a.peek(), b.peek()) {
            let next = if x.0 < y.0 { a.next() } else { b.next() };
            joined.extend(next);
        }
        joined.extend(a);
        joined.extend(b);
        *town_lines = joined;
    }
    let mut i = 0;
    runs.retain(|_| {
        i += 1;
        !gone.contains(&(i - 1))
    });
    staged
}

/// Steps one chunk's runs in order against the town as `scratch`'s thread reads it, each into a stage of its own that
/// starts at the tick's `draws` (`super::step_in_units`). `minter` is `None` for side-by-side runs: they may neither
/// draw nor set a timer. A run whose unit `units` holds retired is not stepped.
#[allow(clippy::too_many_arguments)]
fn run<S: Skill + ?Sized>(
    shared: Shared<'_>,
    reads: &Reads<'_>,
    scratch: &mut Scratch,
    kind: &Name,
    mut minter: Option<&mut Minter>,
    draws: u64,
    units: &Units,
    runs: &mut Chunk<'_, S>,
    kept: &mut [(Id, Line)],
) -> Out {
    let mut lines = Vec::new();
    let spent = Cell::new(Spent::default());
    let mut out = Vec::with_capacity(runs.len());
    let asked;
    {
        let here = Here {
            town: shared.view(scratch, Lines::Part(kept, &mut lines), &spent),
            controller: reads.controller,
            fields: reads.fields,
            settled: reads.settled,
            kind: kind.clone(),
            planned: reads.planned.map(|p| (p, RefCell::new(Vec::new()))),
        };
        for (i, body, driver, skill) in runs.iter_mut() {
            let unit = skill.shape().name;
            let mut own = Staged {
                draws,
                ..Staged::default()
            };
            let what = if units.is_retired(unit.as_str()) {
                What::Retired
            } else {
                let stepped = catch_unwind(AssertUnwindSafe(|| {
                    let mut host = WorldHost {
                        tree: shared.tree,
                        geometry: &here,
                        now: reads.now,
                        seed: reads.seed,
                        body: *body,
                        driver: *driver,
                        minter: minter.as_deref_mut(),
                        staged: &mut own,
                        calls: Cell::new(0),
                    };
                    let progress = skill.step(&mut host);
                    (progress, host.calls.get())
                }));
                match stepped {
                    Ok((progress, calls)) => {
                        own.calls += calls;
                        What::Stepped(progress)
                    }
                    Err(payload) => {
                        // Its stage is dropped: the body stands as if it had not stepped.
                        own = Staged::default();
                        What::Panicked(
                            payload
                                .downcast_ref::<&str>()
                                .map(|s| (*s).to_string())
                                .or_else(|| payload.downcast_ref::<String>().cloned())
                                .unwrap_or_default(),
                        )
                    }
                }
            };
            out.push(Stepped {
                i: *i,
                body: *body,
                unit,
                staged: own,
                what,
            });
        }
        asked = here
            .planned
            .map(|(_, a)| a.into_inner())
            .unwrap_or_default();
    }
    Out {
        runs: out,
        lines,
        asked,
        spent: spent.get(),
    }
}
