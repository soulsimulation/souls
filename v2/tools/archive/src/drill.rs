//! O3's drill and count (Engine v2 O3, #2732): the scripted world's log shipped off the machine by worldd's shipper
//! (`v2/crates/worldd/src/shipping.rs`), its data folder destroyed, and the world rebuilt from the bucket alone.
//! Runbook: `v2/docs/runbook/log-shipping.md`; the ten-kill test is `v2/tools/ops/o3-kill.sh`.
//!
//! - `ship <dir> <receipts> <even|uneven|still> <seconds> [seed]`: the benches' world (1,000 bodies, 9,000 things)
//!   acting in real time under a load shape of `tools/bench/capacity/profiles/shapes.json`, its log (K4) and
//!   checkpoints (K5) in `<dir>`, shipped to the store. The driver's receipts go to `<receipts>`, outside `<dir>`:
//!   each acknowledgement as it is sent. Runs `<seconds>` (0: until killed).
//! - `rebuild <receipts>`: fetches the newest checkpoint and the pieces after it, replays them, and checks the acts it
//!   holds against the receipts: one row of the kill table.
//! - `ship-count <dir>`: a busy hour on a fake clock, shipped and archived (V3) into the in-memory store; the writes,
//!   scaled to a month and priced.

use std::cell::RefCell;
use std::io::Write;
use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use archive::script::{self, TICK, World};
use archive::{Archiver, R, Shared, refuse};
use directoryd::directory::Directory;
use directoryd::directory::store::{Memory, Store};
use replica::effects::{Effect, Header, Part};
use replica::encode::Name;
use replica::ids::{Scope, Version};
use replica::pose::{HandOff, Owner, Vec3};
use sim::checkpoint::{Checkpoints, replay};
use sim::log::{FileStore, Log};
use worldd::shipping::{self, Clock, Item, LOSS_BAR_US, Shipper, Wall};

/// K5's interval in the drill: a checkpoint each 256 KiB of log (the first after the build).
const EVERY: u64 = 256 << 10;
/// The drill ships a checkpoint at most each 20 s, so each run's rebuild starts from one past the first.
const DRILL_GAP_US: u64 = 20_000_000;
/// One act each this many ticks (20 s) cannot be undone: it waits for the directory's mark.
const STAKES_EVERY: u64 = 400;
/// A build hash for the directory record (the scripted world's build is not pinned anywhere).
const BUILD: [u8; 34] = [0x12; 34];

fn io<T>(r: std::io::Result<T>) -> R<T> {
    r.or_else(|e| refuse("io", e.to_string()))
}

fn machine() -> Name {
    Name::new("drill-machine").expect("a name")
}

fn version(w: &World) -> Version {
    Version {
        lineage: Scope(w.header.lineage.0),
        zone: w.header.zone,
        epoch: 1,
        sequence: w.tree.next(),
    }
}

/// One act: body `ix` takes a step at tick `tick` (K5's restart load's act).
fn step(w: &mut World, ix: usize, tick: u64) -> Effect {
    let (b, room) = (w.bodies[ix], w.rooms[ix / 10]);
    let at = tick as i64 * TICK;
    let x = (ix % 10) as i64 * 1000 + (tick % 1000) as i64;
    let mut e = w.entry(
        b,
        vec![replica::effects::Change::Motion(HandOff {
            node: b,
            at,
            from: Owner::Mover,
            to: Owner::Mover,
            pose: script::world::pose(room, None, x),
            linear: Vec3::new(20_000, 0, 0),
            angular: Vec3::ZERO,
        })],
    );
    e.envelope.at = at;
    e
}

// --- The load shapes ------------------------------------------------------------------------------------------------

/// SplitMix64: the drill's own numbers, never the world's.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn between(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.unit()
    }

    fn normal(&mut self) -> f64 {
        let (u, v) = (self.unit().max(1e-12), self.unit());
        (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()
    }
}

/// Which agents (bodies) act each tick: `uniform` (even) or `event` (uneven) from shapes.json, simplified to what
/// the log sees: even, 1,000 agents each acting every 10 s × U(0.5, 1.5); uneven, 800 present agents in runs of 1 to
/// 4 acts 2 to 4 s apart, pauses lognormal (median 30 s, sigma 1.25, at least 2 s), and every 45 to 120 s a crowd
/// moment where 30 % of them act within 2 s; still, none.
struct Load {
    shape: String,
    rng: Rng,
    due: Vec<u64>,
    run: Vec<u32>,
    crowd: u64,
}

impl Load {
    fn new(shape: &str, seed: u64) -> R<Load> {
        let agents = match shape {
            "even" => 1_000,
            "uneven" => 800,
            "still" => 0,
            _ => return refuse("usage", "a load is even, uneven or still"),
        };
        let mut rng = Rng(seed);
        let first = if shape == "even" { 10.0 } else { 30.0 };
        let due = (0..agents)
            .map(|_| (rng.between(0.0, first) * 1e6) as u64)
            .collect();
        let crowd = (rng.between(45.0, 120.0) * 1e6) as u64;
        Ok(Load {
            shape: shape.to_owned(),
            rng,
            due,
            run: vec![0; agents],
            crowd,
        })
    }

    fn pause(&mut self) -> f64 {
        (30f64.ln() + 1.25 * self.rng.normal()).exp().max(2.0)
    }

    /// The agents whose act falls in the tick ending at `now` µs, each acting at most once a tick.
    fn acting(&mut self, now: u64) -> Vec<usize> {
        if self.shape == "uneven" && now >= self.crowd {
            for i in 0..self.due.len() {
                if self.rng.unit() < 0.3 {
                    self.due[i] = self.due[i].min(now + (self.rng.between(0.0, 2.0) * 1e6) as u64);
                }
            }
            self.crowd = now + (self.rng.between(45.0, 120.0) * 1e6) as u64;
        }
        let mut out = Vec::new();
        for i in 0..self.due.len() {
            if self.due[i] > now {
                continue;
            }
            out.push(i);
            let gap = if self.shape == "even" {
                10.0 * self.rng.between(0.5, 1.5)
            } else if self.run[i] > 0 {
                self.run[i] -= 1;
                self.rng.between(2.0, 4.0)
            } else {
                self.run[i] = (self.rng.next() % 4) as u32;
                self.pause()
            };
            self.due[i] = now + (gap * 1e6) as u64;
        }
        out
    }
}

// --- ship -----------------------------------------------------------------------------------------------------------

/// A record on its way: appended to the log, not yet on the disk.
struct Pending {
    record: u64,
    bytes: Vec<u8>,
    acts: u64,
    stakes: bool,
}

/// `ship`: the world acting in real time, its log shipped (the module doc). Runs `seconds`, or until killed.
#[allow(clippy::disallowed_methods)] // A drill in real time: it sleeps to the next tick by the wall clock.
pub fn ship<S: Store + Send + Sync + 'static>(
    store: S,
    dir: &Path,
    receipts: &Path,
    shape: &str,
    seconds: u64,
    seed: u64,
) -> R<()> {
    let store = Shared(Arc::new(store));
    let mut load = Load::new(shape, seed)?;
    io(std::fs::create_dir_all(dir))?;
    let mut out = std::io::BufWriter::new(io(std::fs::File::create(receipts))?);
    let (mut w, queue) = super::logged(100, 90);
    let (lineage, zone) = (w.header.lineage.0, w.header.zone);
    let mut directory = Directory::new(store.clone(), machine());
    directory.set_build(&lineage, zone, &BUILD)?;
    let claim = directory.claim(&lineage, zone)?;
    let (mut log, _) = Log::open(FileStore::open(&dir.join("log"))?, 1)?;
    let mut ckpts = Checkpoints::open(&dir.join("ckpt"), EVERY, Default::default())?;
    let shipper = Shipper::open(
        directory,
        claim,
        lineage,
        zone,
        w.header.stored(),
        0,
        Wall::start(),
    )?
    .checkpoints(&dir.join("ckpt"), DRILL_GAP_US);
    let (tx, mark, handle) = shipper.spawn();
    let clock = Wall::start();
    io(writeln!(out, "start {shape} seed {seed}"))?;
    let (mut appended, mut logged_acts) = (0u64, 0u64);
    let mut pending: Vec<Pending> = Vec::new();
    let mut held: Vec<u64> = Vec::new();
    let mut quiet_from: Option<(u64, u64)> = None;
    let mut tick = 0u64;
    loop {
        let now = clock.now_us();
        // The tick's acts: committed, appended to the log, a checkpoint taken when one is due.
        let acting = load.acting(now);
        if !acting.is_empty() {
            let entries: Vec<Effect> = acting.iter().map(|&ix| step(&mut w, ix, tick)).collect();
            w.commit(entries);
        }
        let stakes_tick = tick.is_multiple_of(STAKES_EVERY);
        for p in queue.borrow_mut().drain(..) {
            let acts = Part::read(&p)?.effects.len() as u64;
            ckpts.appended(p.len() as u64);
            let record = log.append(p.clone())?;
            appended += 1;
            logged_acts += acts;
            pending.push(Pending {
                record,
                bytes: p,
                acts,
                stakes: stakes_tick && acts > 0 && tick > 0,
            });
        }
        // Between ticks, once every committed part is in the log (the build commits many before the first tick).
        if ckpts.due() {
            let v = version(&w);
            ckpts.take(&mut w.tree, v, appended, &logged_acts.to_le_bytes())?;
        }
        // Acknowledged at the disk; an act that cannot be undone waits for the directory's mark.
        let durable = log.durable();
        let ready = pending.iter().take_while(|p| p.record < durable).count();
        for p in pending.drain(..ready) {
            let ordinary = p.acts - u64::from(p.stakes);
            io(writeln!(out, "ack {} {ordinary} {now}", p.record))?;
            if p.stakes {
                io(writeln!(out, "hold {} {now}", p.record))?;
                held.push(p.record);
            }
            tx.send(Item {
                record: p.record,
                bytes: p.bytes,
                acts: p.acts,
                stakes: p.stakes,
            })
            .or_else(|_| refuse("ship-stopped", "the shipper stopped"))?;
        }
        let recorded = mark.recorded();
        held.retain(|&r| {
            if r < recorded {
                let _ = writeln!(out, "irrev {r} {now} {recorded}");
                false
            } else {
                true
            }
        });
        let g = mark.gauges();
        io(writeln!(
            out,
            "alive {now} {} {recorded} {} {}",
            mark.landed(),
            g.unshipped_us,
            g.unshipped_acts
        ))?;
        io(out.flush())?;
        // A still world: the uploads from one minute in, once the build is off the machine.
        if now >= 60_000_000 && quiet_from.is_none() {
            quiet_from = Some((now, mark.uploads().total()));
        }
        tick += 1;
        if seconds > 0 && now >= seconds * 1_000_000 {
            break;
        }
        let next = tick * TICK as u64;
        let now = clock.now_us();
        if next > now {
            std::thread::sleep(std::time::Duration::from_micros(next - now));
        }
    }
    let end = clock.now_us();
    let last = mark.uploads();
    drop(tx);
    let uploads = handle
        .join()
        .unwrap_or_else(|p| std::panic::resume_unwind(p))?;
    ckpts.wait()?;
    println!(
        "ship: {shape}, {tick} ticks, {appended} records, {logged_acts} acts; uploads {uploads:?}; seal age {} µs \
         (loss bar {LOSS_BAR_US} less 100,000 and the slowest recent upload, {} µs)",
        shipping::seal_age(mark.upload_us()),
        mark.upload_us()
    );
    if let Some((t, n)) = quiet_from {
        println!(
            "uploads from {} s to {} s: {}",
            t / 1_000_000,
            end / 1_000_000,
            last.total() - n
        );
    }
    Ok(())
}

// --- rebuild --------------------------------------------------------------------------------------------------------

/// What the driver's receipts say.
#[derive(Default)]
struct Receipts {
    shape: String,
    acks: Vec<(u64, u64, u64)>,
    held: Vec<u64>,
    irrev: Vec<(u64, u64)>,
    last_alive: u64,
}

fn read_receipts(path: &Path) -> R<Receipts> {
    let text = io(std::fs::read_to_string(path))?;
    let mut r = Receipts::default();
    for line in text.lines() {
        let f: Vec<&str> = line.split(' ').collect();
        let n = |i: usize| f.get(i).and_then(|s| s.parse::<u64>().ok());
        match (f.first().copied(), n(1), n(2), n(3)) {
            (Some("start"), _, _, _) => r.shape = f.get(1).copied().unwrap_or("").to_owned(),
            (Some("ack"), Some(rec), Some(acts), Some(t)) => r.acks.push((rec, acts, t)),
            (Some("hold"), Some(rec), Some(_), _) => r.held.push(rec),
            (Some("irrev"), Some(rec), Some(_), Some(m)) => r.irrev.push((rec, m)),
            (Some("alive"), Some(t), _, _) => r.last_alive = t,
            // A line cut by the kill is not a receipt: it was never sent whole.
            _ => {}
        }
    }
    Ok(r)
}

/// `rebuild`: the world from the bucket alone, checked against the receipts; prints one row of the kill table.
pub fn rebuild<S: Store>(store: S, receipts: &Path, kill: &str) -> R<()> {
    let w = World::new();
    let (lineage, zone) = (w.header.lineage.0, w.header.zone);
    let f = shipping::fetch(&store, &lineage, zone)?;
    for l in &f.log {
        println!("rebuild: {l}");
    }
    let Some((at, bytes)) = &f.checkpoint else {
        return refuse("checkpoint-missing", "no checkpoint was shipped");
    };
    let tmp = receipts.with_extension("ckpt");
    let _ = std::fs::remove_dir_all(&tmp);
    io(std::fs::create_dir_all(&tmp))?;
    io(std::fs::write(tmp.join(format!("ckpt-{at:020}")), bytes))?;
    let Some(r) = sim::checkpoint::restore(&tmp)? else {
        return refuse("checkpoint-missing", "the checkpoint did not read");
    };
    let _ = std::fs::remove_dir_all(&tmp);
    let mut tree = r.tree;
    let seed: [u8; 8] = r.root.seed.as_slice().try_into().unwrap_or_default();
    let mut acts = u64::from_le_bytes(seed);
    let mut through = r.root.record;
    for p in &f.pieces {
        let from = r.root.record.saturating_sub(p.first);
        replay(&mut tree, &Header::read(&p.header)?, &p.records, from)?;
        for b in p.records.iter().skip(from as usize) {
            acts += Part::read(b)?.effects.len() as u64;
        }
        through = p.first + p.records.len() as u64;
    }
    let rc = read_receipts(receipts)?;
    let acked_below: u64 = rc.acks.iter().filter(|a| a.0 < through).map(|a| a.1).sum();
    let held_below = rc.held.iter().filter(|&&h| h < through).count() as u64;
    let lost: Vec<&(u64, u64, u64)> = rc
        .acks
        .iter()
        .filter(|a| a.0 >= through && a.1 > 0)
        .collect();
    let lost_acts: u64 = lost.iter().map(|a| a.1).sum();
    let window = lost
        .first()
        .map_or(0, |a| rc.last_alive.saturating_sub(a.2));
    let past = rc
        .irrev
        .iter()
        .filter(|(rec, m)| rec >= m || *rec >= through)
        .count();
    let equal = acts == acked_below + held_below;
    let ok = equal && window <= LOSS_BAR_US && past == 0;
    println!(
        "| {} | {kill} | {} | {through} | {acts} | {} + {held_below} | {} | {lost_acts} | {:.2} | {} | {past} | {} |",
        rc.shape,
        at,
        acked_below,
        if equal { "EQUAL" } else { "DIFFER" },
        window as f64 / 1e6,
        rc.irrev.len(),
        if ok { "MET" } else { "UNMET" }
    );
    if !ok {
        return refuse("rebuild-differs", "see the row");
    }
    Ok(())
}

// --- ship-count -----------------------------------------------------------------------------------------------------

#[derive(Clone, Default)]
struct Ticks(Arc<AtomicU64>);

impl Clock for Ticks {
    fn now_us(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// `ship-count`: V3's busy hour (100 of 1,000 bodies step each 50 ms tick, K5's restart load), shipped by the shipper
/// on a fake clock, archived by V3 and checkpointed by K5 (each 8 MiB of log, a checkpoint shipped at most each ten
/// minutes), into the in-memory store; each kind of write counted, scaled to a 30-day month and priced at R2's.
pub fn count(dir: &Path) -> R<()> {
    let _ = std::fs::remove_dir_all(dir);
    let store = Shared(Arc::new(Memory::default()));
    let (mut w, queue): (World, Rc<RefCell<Vec<Vec<u8>>>>) = super::logged(100, 90);
    let (lineage, zone) = (w.header.lineage.0, w.header.zone);
    let root = w.tree.node(w.tree.root()).expect("the root");
    let (rid, kind) = (root.id(), root.kind().clone());
    let mut archiver = Archiver::open(store.clone(), super::PREFIX, &w.header, rid, kind)?;
    let mut directory = Directory::new(store.clone(), machine());
    directory.set_build(&lineage, zone, &BUILD)?;
    let claim = directory.claim(&lineage, zone)?;
    let clock = Ticks::default();
    let mut s = Shipper::open(
        directory,
        claim,
        lineage,
        zone,
        w.header.stored(),
        0,
        clock.clone(),
    )?
    .checkpoints(&dir.join("ckpt"), shipping::CHECKPOINT_GAP_US);
    let mut ckpts = Checkpoints::open(&dir.join("ckpt"), 8 << 20, Default::default())?;
    let (mut n, mut acts) = (0u64, 0u64);
    for t in 0..72_000u64 {
        if t > 0 {
            script::tick(&mut w, t, 100, 1_200);
        }
        for p in queue.borrow_mut().drain(..) {
            let a = Part::read(&p)?.effects.len() as u64;
            acts += a;
            ckpts.appended(p.len() as u64);
            archiver.push(n, p.clone())?;
            s.push(Item {
                record: n,
                bytes: p,
                acts: a,
                stakes: false,
            })?;
            n += 1;
        }
        if ckpts.due() {
            let v = version(&w);
            ckpts.take(&mut w.tree, v, n, &acts.to_le_bytes())?;
            ckpts.wait()?;
        }
        s.poll()?;
        clock.0.fetch_add(TICK as u64, Ordering::SeqCst);
    }
    s.flush()?;
    archiver.flush()?;
    let up = s.mark().uploads();
    let v3 = archiver.writes();
    let _ = std::fs::remove_dir_all(dir);
    let month = |x: u64| x * 720;
    let price = |x: u64| x as f64 * 4.50 / 1e6;
    println!("busy hour: {n} records, {acts} acts");
    println!(
        "busy hour, O3: {} pieces, {} directory marks, {} checkpoints, {} pointers; V3: {} writes ({v3:?})",
        up.pieces,
        up.marks,
        up.checkpoints,
        up.pointers,
        v3.total()
    );
    let (pieces, ckpt, v3m) = (
        month(up.pieces),
        month(up.checkpoints + up.pointers),
        month(v3.total()),
    );
    let all = pieces + ckpt + v3m + month(up.marks);
    println!(
        "month (x 720): pieces {pieces} ${:.3}; checkpoints and pointers {ckpt} ${:.3}; V3 {v3m} ${:.3}; \
         directory marks {} ${:.3}; together {all} ${:.3}",
        price(pieces),
        price(ckpt),
        price(v3m),
        month(up.marks),
        price(month(up.marks)),
        price(all)
    );
    println!(
        "bars: pieces about $1.17 {}; together under $2 {}",
        if (price(pieces) - 1.17).abs() < 0.1 {
            "MET"
        } else {
            "UNMET"
        },
        if price(all) < 2.0 { "MET" } else { "UNMET" }
    );
    Ok(())
}
