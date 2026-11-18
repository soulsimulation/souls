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
//!   then steps the others, in order, with the tick's draws and timer ids. Each chunk stages into its own [`Staged`],
//!   and the stages are joined in chunk order, so the joined stage is the one a single thread fills.
//! - **Draws and timers** are numbered in the tick's order, so a skill stepped beside others may use neither: either
//!   is refused with a panic ([`BESIDE_ORDERED`]), at any thread count, so the outcome still does not depend on it.
//! - **A panic is one body's** (K11's unit, `crate::unit`): a skill that panics has its stage dropped, its run ended
//!   by name ([`UNIT_PANICKED`], the panic's message in the refusal's detail), and every other body's step is as it
//!   would be without it.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Mutex;

use replica::effects::Refusal;
use replica::encode::{Name, Value};
use replica::host::{Progress, Skill};
use replica::ids::{Id, Minter};
use replica::time::Micros;

use super::{Here, Run, Staged, WorldHost, body_kind, named};
use crate::controller::{Controller, Driver};
use crate::routes::Scratch;
use crate::walk::town::{Line, Lines, Shared, Spent, Split};

/// The most consecutive side-by-side runs one thread takes at a time.
pub const CHUNK: usize = 64;
/// A skill's step panicked: its run ends by this name.
pub const UNIT_PANICKED: &str = "unit-panicked";
/// The panic of a skill stepped beside others that drew or set a timer.
pub const BESIDE_ORDERED: &str = "beside-ordered";

/// What every skill's step reads besides the town: the bodies, their fields, who stands settled, and the tick.
pub(super) struct Reads<'a> {
    pub controller: &'a Controller,
    pub fields: &'a BTreeMap<Id, BTreeMap<u64, Value>>,
    pub settled: &'a BTreeSet<Id>,
    pub now: Micros,
    pub seed: u64,
}

/// A chunk's runs: index in the sorted runs, body, driver and skill.
type Chunk<'r, S> = Vec<(usize, Id, Driver, &'r mut S)>;
/// A chunk to step: its place in the chunk order, its runs, and its walkers' lines.
type Job<'r, S> = (usize, Chunk<'r, S>, &'r mut [(Id, Line)]);

/// What stepping one chunk gave.
struct Out {
    staged: Staged,
    refused: Vec<(Id, Refusal)>,
    /// Indices of the runs that ended.
    ended: Vec<usize>,
    /// Lines found for walkers that had none, in walker order.
    lines: Vec<(Id, Line)>,
    spent: Spent,
}

/// Steps every run once, as `super::step` does, on the threads `split` has a scratch for: the runs sorted by body,
/// the ones that ended taken out. Returns the joined stage and the runs refused by a panic, each with its body.
pub(super) fn step(
    split: Split<'_>,
    reads: Reads<'_>,
    minter: &mut Minter,
    runs: &mut Vec<Run>,
    chunk: usize,
) -> (Staged, Vec<(Id, Refusal)>) {
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
        return (Staged::default(), Vec::new());
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
    let work = |scratch: &mut Scratch| -> Vec<(usize, Out)> {
        let mut done = Vec::new();
        while let Some((at, mut runs, lines)) = queue.lock().ok().and_then(|mut q| q.next()) {
            done.push((
                at,
                run(shared, &reads, scratch, &kind, None, 0, &mut runs, lines),
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
    // The other skills, on the tick's own thread, in order, with the tick's draws and timers.
    let mut draws = 0;
    let mut own = Scratch::default();
    let scratch = scratches.first_mut().unwrap_or(&mut own);
    for (at, mut runs, lines) in alones {
        let out = run(
            shared,
            &reads,
            scratch,
            &kind,
            Some(&mut *minter),
            draws,
            &mut runs,
            lines,
        );
        draws = out.staged.draws;
        outs[at] = Some(out);
    }

    // Joined in chunk order: the stage one thread fills.
    let mut staged = Staged::default();
    let mut refused = Vec::new();
    let mut gone = BTreeSet::new();
    let mut spent = town_spent.get();
    let mut new: Vec<(Id, Line)> = Vec::new();
    for out in outs.into_iter().flatten() {
        let s = out.staged;
        for c in s.controls {
            // A run's last input in the tick wins (`WorldHost::control`), across chunks too.
            match staged.controls.last_mut() {
                Some((b, d, last)) if *b == c.0 && *d == c.1 => *last = c.2,
                _ => staged.controls.push(c),
            }
        }
        staged.crossings.extend(s.crossings);
        staged.emits.extend(s.emits);
        staged.timers.extend(s.timers);
        staged.cleared.extend(s.cleared);
        staged.ended.extend(s.ended);
        staged.calls += s.calls;
        refused.extend(out.refused);
        gone.extend(out.ended);
        spent.add(&out.spent);
        new.extend(out.lines);
    }
    staged.draws = draws;
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
    (staged, refused)
}

/// Steps one chunk's runs in order against the town as `scratch`'s thread reads it, into a stage of its own that
/// starts at the tick's `draws`. `minter` is `None` for side-by-side runs: they may neither draw nor set a timer.
#[allow(clippy::too_many_arguments)]
fn run<S: Skill + ?Sized>(
    shared: Shared<'_>,
    reads: &Reads<'_>,
    scratch: &mut Scratch,
    kind: &Name,
    mut minter: Option<&mut Minter>,
    draws: u64,
    runs: &mut Chunk<'_, S>,
    kept: &mut [(Id, Line)],
) -> Out {
    let mut lines = Vec::new();
    let spent = Cell::new(Spent::default());
    let mut staged = Staged {
        draws,
        ..Staged::default()
    };
    let mut refused = Vec::new();
    let mut ended = Vec::new();
    {
        let here = Here {
            town: shared.view(scratch, Lines::Part(kept, &mut lines), &spent),
            controller: reads.controller,
            fields: reads.fields,
            settled: reads.settled,
            kind: kind.clone(),
        };
        for (i, body, driver, skill) in runs.iter_mut() {
            let marks = (
                staged.controls.len(),
                staged.crossings.len(),
                staged.emits.len(),
                staged.timers.len(),
                staged.cleared.len(),
            );
            let stepped = catch_unwind(AssertUnwindSafe(|| {
                let mut host = WorldHost {
                    tree: shared.tree,
                    geometry: &here,
                    now: reads.now,
                    seed: reads.seed,
                    body: *body,
                    driver: *driver,
                    minter: minter.as_deref_mut(),
                    staged: &mut staged,
                    calls: Cell::new(0),
                };
                let progress = skill.step(&mut host);
                (progress, host.calls.get())
            }));
            match stepped {
                Ok((Progress::Going, calls)) => staged.calls += calls,
                Ok((progress, calls)) => {
                    staged.calls += calls;
                    staged.ended.push((*body, progress));
                    ended.push(*i);
                }
                Err(payload) => {
                    // Its stage is dropped: the body stands as if it had not stepped.
                    staged.controls.truncate(marks.0);
                    staged.crossings.truncate(marks.1);
                    staged.emits.truncate(marks.2);
                    staged.timers.truncate(marks.3);
                    staged.cleared.truncate(marks.4);
                    let message = payload
                        .downcast_ref::<&str>()
                        .map(|s| (*s).to_string())
                        .or_else(|| payload.downcast_ref::<String>().cloned())
                        .unwrap_or_default();
                    staged
                        .ended
                        .push((*body, Progress::Failed(named(UNIT_PANICKED))));
                    refused.push((
                        *body,
                        Refusal {
                            name: UNIT_PANICKED,
                            detail: format!("{}: {message}", replica::world_model::show(*body)),
                        },
                    ));
                    ended.push(*i);
                }
            }
        }
    }
    Out {
        staged,
        refused,
        ended,
        lines,
        spent: spent.get(),
    }
}
