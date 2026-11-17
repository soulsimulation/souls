// #2553 A2: a wave of new Souls on a busy world. A fresh Eden 2026 (the launcher's command, production decoration, fake
// minds, Eyes off) with `acting` raw Souls (../../../playtest/eval/load.mjs, M3's driver) acting through the whole run,
// either paced (`uniform`: one act every 10 s on average) or in the `event` shape (#2556's schedule, raw Souls as the
// shapes driver of eval-load runs them). After a minute of warm-up, the world's clock thread is CPU-profiled (M2's hook,
// prof-hook.mjs) for a baseline minute of that load alone, then again while `n` Souls are created at `perSec` a second
// (a raw join each: create, pair, token, then the catalog and live picture once, as an arriving client reads them), all
// arriving at the world's arrival point, and for 20 s after the last. Reported: each create's wall time; the clock ms one
// create costs (the wave window's busy ms less the baseline's at the same length, over the creates); the longest hold of
// the clock in the wave and its source (prof-buckets.mjs); the load level of each 10-second tick window (live.json); the
// world's heap; and, 30 s after the wave, where the new bodies stand (the public live picture).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rawJoin, rawPacedLoop, wordIds } from '../../../playtest/eval/load.mjs';
import { bucketProfile, readProfile } from '../../../playtest/eval/prof-buckets.mjs';
import { startPicture } from '../meetup/client-soul.mjs';
import { rng } from '../../../playtest/lib/hash.mjs';

const PROF_HOOK = new URL('../../../playtest/eval/prof-hook.mjs', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const r1 = (x) => (x == null ? null : Math.round(10 * x) / 10);
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] : null; };
const readLive = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** The event shape's driver from eval-load (#2556, PR 2588): its loop and its ids, or a clear error where it is not here. */
async function eventDriver() {
  const m = await import('../../../playtest/eval/load.mjs'), s = await import('../profiles/shapes.mjs');
  if (typeof m.rawShapedLoop !== 'function' || typeof m.shapeIds !== 'function') throw new Error('--shape event: eval-load\'s shaped raw driver (rawShapedLoop, shapeIds; #2556) is not in this checkout');
  return { loop: m.rawShapedLoop, ids: m.shapeIds, schedule: s.schedule, describe: s.describe };
}

/** #2615 S6: the clock kept between the first and last of `samples` ({at, tick, rate} read from live.json): world ticks run
 *  over ticks owed at 20 a second times the clock rate, to 3 places; null with fewer than two samples. */
export function clockKept(samples) {
  if (samples.length < 2) return null;
  const a = samples[0], b = samples.at(-1), owed = ((b.at - a.at) / 1000) * 20 * (a.rate || 1);
  return owed > 0 ? Math.round(1000 * Math.min(1, (b.tick - a.tick) / owed)) / 1000 : null;
}

/** One profiled window: start, wait `ms` (or until `until()` resolves), stop; the profile's buckets. */
async function profiled(profDir, name, root, wait) {
  writeFileSync(join(profDir, 'prof.start'), ''); const t0 = Date.now();
  await wait();
  writeFileSync(join(profDir, 'prof.stop'), ''); const wallMs = Date.now() - t0;
  const pf = join(profDir, 'world.cpuprofile');
  // a busy clock thread can take minutes to stop and write a long profile; without one the window keeps its wall time
  for (let k = 0; k < 1200 && !existsSync(pf); k++) await sleep(500); await sleep(2000);
  if (!existsSync(pf)) return { wallMs, busyMs: null, groups: {}, holds: null, error: 'the profile was not written within 10 min' };
  const file = join(profDir, `${name}.cpuprofile`); renameSync(pf, file);
  try { return { wallMs, ...bucketProfile(readProfile(file), root) }; } finally { rmSync(file, { force: true }); }
}

/** Where the bodies stand: of `ids`, how many the live picture places, how many distinct spots (0.5 m), the nearest
 *  neighbour's distance (p50, min), how many stand within 1 m of another, and the spread (distance from their centre). */
export function spread(rows) {
  const at = rows.filter((x) => Array.isArray(x.at)).map((x) => x.at);
  if (!at.length) return { placed: 0 };
  const cx = at.reduce((s, p) => s + p[0], 0) / at.length, cz = at.reduce((s, p) => s + p[1], 0) / at.length;
  const nn = at.map((p, i) => Math.min(...at.map((o, j) => (i === j ? Infinity : Math.hypot(p[0] - o[0], p[1] - o[1])))));
  const fromCentre = at.map((p) => Math.hypot(p[0] - cx, p[1] - cz));
  return { placed: at.length, hidden: rows.length - at.length, spots: new Set(at.map((p) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`)).size,
    nearestM: { min: r1(Math.min(...nn)), p50: r1(q(nn, 0.5)) }, within1m: nn.filter((d) => d < 1).length, radiusM: { p50: r1(q(fromCentre, 0.5)), max: r1(Math.max(...fromCentre)) },
    places: Object.entries(rows.reduce((m, x) => { const k = x.place ?? '(none)'; m[k] = (m[k] ?? 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 5) };
}

export async function runWave({ bootWorld, stopWorld, template = 'eden-2026', heapMb, dir, root, log, acting = 50, n = 200, perSec = 2, shape = 'uniform', seed = 1, profile = true }) {
  mkdirSync(dir, { recursive: true });
  const profDir = join(dir, 'prof'); mkdirSync(profDir, { recursive: true });
  const ev = shape === 'event' ? await eventDriver() : null;
  // #2615: the profiler stops and serializes its profile on the world's main thread (prof-hook.mjs), which took longer than the
  // 10 s hang kill on a loaded runner and ended the world at the baseline's end (3 of 3 Step 0 runs); the stall log still logs every hold
  // #2615 S6: `profile: false` (--no-profile) boots the world without the profiler and with its own hang kill, for scored runs;
  // each window then keeps only its wall time
  const w = await bootWorld(dir, profile ? { slug: 'st-wave', template, heapMb, env: { SIM_PROF_DIR: profDir, SIM_HANG_KILL_MS: '120000' }, nodeOptions: `--import=${PROF_HOOK}` } : { slug: 'st-wave', template, heapMb });
  const window = profile ? profiled : async (_d, _n, _r, wait) => { const t0 = Date.now(); await wait(); return { wallMs: Date.now() - t0, busyMs: null, groups: {}, holds: null }; };
  const out = { shape, acting, n, perSec, profiled: profile, bootS: w.bootS };
  const liveFile = join(w.data, 'live.json'), windows = new Map(), clock = []; let watching = true;
  const watch = (async () => { while (watching) { const l = readLive(liveFile), t = l?.api?.ticks;
    if (l?.tick?.world != null) clock.push({ at: Date.now(), tick: l.tick.world, rate: l.tick.clockRate, service5s: l.tick.service5s }); if (t?.at) windows.set(t.at, { at: t.at, ticks: t.ticks, windowS: t.windowS, levels: t.levels, amberS: t.amberS, tickMs: t.tickMs, gapMs: t.longestGapMs }); await sleep(4000); } })();
  try {
    // the acting Souls: joined 8 at a time, each with its catalog and live picture
    const souls = [];
    for (let i = 0; i < acting; i += 8) await Promise.all(Array.from({ length: Math.min(8, acting - i) }, async (_, j) => {
      const s = await rawJoin(w.origin, i + j), pic = await startPicture(w.origin, s);
      souls[i + j] = { ...s, ids: ev ? ev.ids(pic.catalog) : wordIds(pic.catalog), acts: [], http: [] };
    }));
    const warmMs = 60_000, baseMs = 60_000, waveMs = Math.ceil((n / perSec) * 1000) + 20_000, tailMs = 30_000;
    const T = (warmMs + baseMs + waveMs + tailMs + 30_000) / 1000, t0 = Date.now(), until = t0 + T * 1000, counts = { cmds: 0, acts: 0, refused: 0 };
    const sch = ev ? ev.schedule('event', acting, T, seed) : null;
    if (sch) out.schedule = ev.describe(sch.summary, 'event');
    log(`wave: ${acting} acting Souls (${shape}) joined; warm ${warmMs / 1000} s, baseline ${baseMs / 1000} s, then ${n} creates at ${perSec}/s`);
    const loops = Promise.all(souls.map((s, k) => (ev ? ev.loop({ base: w.origin, soul: s, ids: s.ids, agent: sch.agents[k], t0, until, counts, acts: s.acts, http: s.http })
      : rawPacedLoop({ base: w.origin, soul: s, ids: s.ids, until, r: rng(1000 * seed + k), counts, acts: s.acts, http: s.http, actSec: 10 }))));
    await sleep(warmMs);
    const base0 = Date.now();
    out.baseline = await window(profDir, 'base', root, () => sleep(baseMs));
    const wave0 = Date.now(), joins = [], errors = [];
    out.wave = await window(profDir, 'wave', root, async () => {
      await Promise.all(Array.from({ length: n }, async (_, k) => {
        const due = wave0 + (k * 1000) / perSec; await sleep(due - Date.now());
        const a = Date.now();
        // #2615 S6: each create is also timed from when it was due (fromDueMs), so a late start counts against it
        try { const s = await rawJoin(w.origin, acting + k), j = Date.now() - a; await startPicture(w.origin, s); joins.push({ k, soulId: s.soulId, joinMs: j, withPictureMs: Date.now() - a, fromDueMs: Date.now() - due, doneS: (Date.now() - wave0) / 1000 }); }
        catch (e) { errors.push(String(e.message ?? e).slice(0, 160)); }
      }));
      await sleep(20_000);
    });
    out.waveS = r1((Date.now() - wave0) / 1000);
    out.baselineKept = clockKept(clock.filter((x) => x.at >= base0 && x.at <= wave0));
    if (w.child.exitCode != null) out.worldExited = { code: w.child.exitCode, tail: w.tail() };   // the world ended on its own during the wave
    await sleep(tailMs);
    const live = await fetch(`${w.origin}/v1/edge/live`).then((r) => r.json()).catch(() => null), mine = new Set(joins.map((j) => j.soulId));
    out.bodies = spread((live?.souls ?? []).filter((x) => mine.has(x.id)));
    const heap = readLive(liveFile)?.heap; out.heapEnd = heap ? { usedMb: heap.usedMb, limitMb: heap.limitMb } : null;
    watching = false; await watch;
    const inWave = [...windows.values()].filter((x) => x.at > wave0 && x.at <= wave0 + waveMs + 10_000).sort((a, b) => a.at - b.at);
    const lv = (k) => (inWave.length ? Math.round(1000 * inWave.reduce((s, x) => s + (x.levels?.[k] ?? 0), 0) / inWave.length) / 1000 : null);
    out.levels = { windows: inWave.length, amber: lv('amber'), red: lv('red'), black: lv('black'), worst: ['black', 'red', 'amber', 'green'].find((k) => inWave.some((x) => (x.levels?.[k] ?? 0) > 0)) ?? null,
      amberS: inWave.reduce((m, x) => { for (const [k, v] of Object.entries(x.amberS ?? {})) m[k] = r1((m[k] ?? 0) + v); return m; }, {}), tickP99Max: Math.max(0, ...inWave.map((x) => x.tickMs?.p99 ?? 0)), longestGapMs: Math.max(0, ...inWave.map((x) => x.gapMs ?? 0)),
      // #2615 S6: the clock kept from the wave's first create to 20 s after the last (live.json read every 4 s), and the lowest
      // 5 s tick service the load monitor showed in that time
      ...(() => { const s = clock.filter((x) => x.at >= wave0 && x.at <= wave0 + waveMs); return { kept: clockKept(s), service5sMin: s.length ? Math.min(...s.map((x) => x.service5s ?? 1)) : null }; })() };
    const created = joins.length, scaled = out.baseline.busyMs * (out.wave.wallMs / out.baseline.wallMs), profiledOk = out.wave.busyMs != null && out.baseline.busyMs != null;
    out.creates = { created, errors: errors.length, firstErrors: errors.slice(0, 3), joinMs: { p50: q(joins.map((j) => j.joinMs), 0.5), p95: q(joins.map((j) => j.joinMs), 0.95), max: q(joins.map((j) => j.joinMs), 1) },
      withPictureMs: { p50: q(joins.map((j) => j.withPictureMs), 0.5), p95: q(joins.map((j) => j.withPictureMs), 0.95) },
      clockMsPerCreate: created && profiledOk ? r1((out.wave.busyMs - scaled) / created) : null,
      // #2615 S6: creates achieved against intended: completed per second of the wave until the last completed, and each from its due time
      fromDueMs: { p50: q(joins.map((j) => j.fromDueMs), 0.5), p95: q(joins.map((j) => j.fromDueMs), 0.95), max: q(joins.map((j) => j.fromDueMs), 1) },
      achievedPerSec: created ? Math.round(100 * created / Math.max(...joins.map((j) => j.doneS))) / 100 : 0, intendedPerSec: perSec };
    const lt = [...(out.wave.step0?.longTasks ?? [])].sort((a, b) => b.ms - a.ms);
    out.longestHold = lt[0] ? { ms: lt[0].ms, atS: lt[0].atS, group: lt[0].group, cause: lt[0].cause } : null;
    out.longTasks = lt.slice(0, 8).map((x) => ({ ms: x.ms, group: x.group, cause: x.cause }));
    out.actsDuring = counts;
    for (const k of ['baseline', 'wave']) out[k] = { wallMs: out[k].wallMs, busyMs: out[k].busyMs, groups: Object.fromEntries(Object.entries(out[k].groups ?? {}).slice(0, 12)), holds: out[k].holds, causes: out[k].step0?.causes, ...(out[k].error ? { error: out[k].error } : {}) };
    await loops;
    log(`wave (${shape}): ${created} created (${errors.length} errors), clock ${out.creates.clockMsPerCreate} ms per create, longest hold ${out.longestHold?.ms ?? '-'} ms (${out.longestHold?.cause ?? '-'}), worst level ${out.levels.worst}, bodies on ${out.bodies.spots ?? 0} spots`);
  } catch (e) { out.error = String(e.message ?? e).split(root).join('.'); if (w.child.exitCode != null) out.worldExited = { code: w.child.exitCode, tail: w.tail() }; log(`wave: ${out.error}${out.worldExited ? ` (world exited ${out.worldExited.code}: ${out.worldExited.tail})` : ''}`); }
  finally { watching = false; await stopWorld(w); }
  return out;
}
