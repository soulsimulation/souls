#!/usr/bin/env node
// A bounded history of the health page's numbers and its report (Engine v2 O21, #3325; today's telemetry.mjs, #738,
// carried over). Each sample is every world's row (read.mjs) at that moment: files only, so collecting wakes no world.
//
// The store, a folder:
// - `fine/<UTC day>.jsonl`: one line per world per sample, {t, w, s (state), a (1 awake), lag, p99, ob (over
//   budget), f (failures), c (starts in 5 min)}, for the last `fineDays` days;
// - `hourly/<UTC day>.jsonl`: older days reduced to one line per world per hour, {t (hour start), w, n, a (awake
//   samples), loop (restart-loop samples), lag (max), p99 (max), ob (max), f (max)}, for `keepDays` days;
// - and never more than `maxBytes` in all: past it, the oldest files go first (today's never).
//
//   node history.mjs collect --root <worlds root> --dir <store> [--every 30] [--once]
//   node history.mjs report --dir <store> [--range 24h|7d|<n>h|<n>d] [--json]
import { isMain } from '../../../../tools/lib/is-main.mjs';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWorlds } from './read.mjs';

const HOUR_MS = 3_600_000, DAY_MS = 24 * HOUR_MS;
/** The declared bounds. 64 MiB holds about 19 worlds sampled every 30 s for 7 fine days and 83 hourly ones (3.3 MiB
 *  a world, measured by health.test.mjs a4); past that the oldest go first. `maxBytes` must exceed one day's fine
 *  samples: today's file is never dropped. */
export const DEFAULTS = { fineDays: 7, keepDays: 90, maxBytes: 64 * 2 ** 20 };
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const files = (dir) => { try { return readdirSync(dir).filter((n) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(n)).sort(); } catch { return []; } };
const lines = (file) => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; } };

/** A sample's lines for `rows` (read.mjs) at `t`. */
export function sampleLines(rows, t) {
  return rows.map((r) => JSON.stringify({
    t, w: r.world, s: r.state, a: r.awake === 'awake' ? 1 : 0, lag: r.tick?.lag_ms ?? null, p99: r.tick?.p99_ms ?? null,
    ob: r.tick?.over_budget ?? null, f: r.restarts?.failures ?? null, c: r.restarts?.in_5_min ?? null,
  })).join('\n') + (rows.length ? '\n' : '');
}

/** The store's bytes. */
export function bytes(dir) {
  let n = 0;
  for (const sub of ['fine', 'hourly']) for (const f of files(join(dir, sub))) n += statSync(join(dir, sub, f)).size;
  return n;
}

const max = (a, b) => (b == null ? a : a == null ? b : Math.max(a, b));

/** Reduces fine samples to one line per world per hour. */
export function reduce(samples) {
  const by = new Map();
  for (const x of samples) {
    const t = Math.floor(x.t / HOUR_MS) * HOUR_MS, k = `${x.w} ${t}`;
    let h = by.get(k);
    if (!h) by.set(k, h = { t, w: x.w, n: 0, a: 0, loop: 0, lag: null, p99: null, ob: null, f: null });
    h.n++; h.a += x.a; if (x.s === 'restart-loop') h.loop++;
    h.lag = max(h.lag, x.lag); h.p99 = max(h.p99, x.p99); h.ob = max(h.ob, x.ob); h.f = max(h.f, x.f);
  }
  return [...by.values()].sort((a, b) => a.t - b.t || (a.w < b.w ? -1 : 1));
}

/** Keeps the store in its bounds at `now`: fine days past `fineDays` reduced, hourly days past `keepDays` dropped,
 *  then the oldest files dropped while it holds more than `maxBytes` less `room`. */
export function compact(dir, now, { fineDays, keepDays, maxBytes } = DEFAULTS, room = 0) {
  const fine = join(dir, 'fine'), hourly = join(dir, 'hourly');
  mkdirSync(hourly, { recursive: true });
  const today = dayOf(now);
  for (const f of files(fine)) {
    if (f.slice(0, 10) > dayOf(now - fineDays * DAY_MS)) continue;
    const out = reduce(lines(join(fine, f)));
    writeFileSync(join(hourly, f), out.map((x) => JSON.stringify(x)).join('\n') + (out.length ? '\n' : ''));
    rmSync(join(fine, f));
  }
  for (const f of files(hourly)) if (f.slice(0, 10) <= dayOf(now - keepDays * DAY_MS)) rmSync(join(hourly, f));
  let total = bytes(dir);
  const oldest = [...files(hourly).map((f) => join(hourly, f)), ...files(fine).filter((f) => f.slice(0, 10) !== today).map((f) => join(fine, f))];
  while (total + room > maxBytes && oldest.length) {
    const f = oldest.shift();
    total -= statSync(f).size;
    rmSync(f);
  }
  return total;
}

/** A collector: `add(rows, t)` appends one sample and keeps the store in bounds. */
export function collector(dir, bounds = DEFAULTS) {
  const b = { ...DEFAULTS, ...bounds };
  mkdirSync(join(dir, 'fine'), { recursive: true });
  let total = bytes(dir), lastDay = null;
  return {
    add(rows, t) {
      const text = sampleLines(rows, t), day = dayOf(t);
      if (day !== lastDay || total + text.length > b.maxBytes) { total = compact(dir, t, b, Buffer.byteLength(text)); lastDay = day; }
      appendFileSync(join(dir, 'fine', `${day}.jsonl`), text);
      total += Buffer.byteLength(text);
      return total;
    },
    bytes: () => total,
  };
}

/** `24h`, `7d`, `<n>h`, `<n>d`: milliseconds. */
export function parseRange(r) {
  const m = /^(\d+)([hd])$/.exec(String(r));
  if (!m) throw new Error(`--range must be like 24h or 7d, not ${r}`);
  return Number(m[1]) * (m[2] === 'h' ? HOUR_MS : DAY_MS);
}

/** Per world over the range: samples, awake share, restart-loop samples, lag and tick p99 at their worst, most
 *  failures and most ticks over budget. Fine samples where kept, hourly lines before. */
export function report(dir, range, now = Date.now()) {
  const from = now - parseRange(range), first = dayOf(from);
  const worlds = new Map();
  const w = (name) => { let r = worlds.get(name); if (!r) worlds.set(name, r = { world: name, samples: 0, awake: 0, restart_loop: 0, lag_ms_max: null, p99_ms_max: null, failures_max: null, over_budget_max: null }); return r; };
  const take = (x, n, a, loop) => {
    if (x.t < from || x.t > now) return;
    const r = w(x.w);
    r.samples += n; r.awake += a; r.restart_loop += loop;
    r.lag_ms_max = max(r.lag_ms_max, x.lag); r.p99_ms_max = max(r.p99_ms_max, x.p99);
    r.failures_max = max(r.failures_max, x.f); r.over_budget_max = max(r.over_budget_max, x.ob);
  };
  for (const f of files(join(dir, 'hourly'))) if (f.slice(0, 10) >= first) for (const x of lines(join(dir, 'hourly', f))) take(x, x.n, x.a, x.loop);
  for (const f of files(join(dir, 'fine'))) if (f.slice(0, 10) >= first) for (const x of lines(join(dir, 'fine', f))) take(x, 1, x.a, x.s === 'restart-loop' ? 1 : 0);
  return { from, to: now, range, worlds: [...worlds.values()].sort((a, b) => (a.world < b.world ? -1 : 1)) };
}

export function text(r) {
  const out = [`history ${new Date(r.from).toISOString()} .. ${new Date(r.to).toISOString()} (${r.range})`,
    'world         samples  awake%  restart-loop  lag max ms  tick p99 max ms  failures max  over budget max'];
  for (const x of r.worlds) {
    const pct = x.samples ? Math.round((100 * x.awake) / x.samples) : 0;
    out.push(`${x.world.slice(0, 12).padEnd(12)}  ${String(x.samples).padStart(7)}  ${String(pct).padStart(6)}  ${String(x.restart_loop).padStart(12)}  ${String(x.lag_ms_max ?? '—').padStart(10)}  ${String(x.p99_ms_max ?? '—').padStart(15)}  ${String(x.failures_max ?? '—').padStart(12)}  ${String(x.over_budget_max ?? '—').padStart(15)}`);
  }
  if (!r.worlds.length) out.push('(no samples in range)');
  return out.join('\n');
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
  const dir = opt('dir');
  if (argv[0] === 'collect') {
    const root = opt('root', process.env.WORLDS_ROOT ?? '/var/lib/souls/worlds'), c = collector(dir);
    const once = () => { const t = Date.now(); c.add(readWorlds(root, t), t); };
    once();
    if (!argv.includes('--once')) setInterval(once, Number(opt('every', 30)) * 1000);
  } else if (argv[0] === 'report') {
    const r = report(dir, opt('range', '24h'));
    console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : text(r));
  } else {
    console.error('usage: history.mjs collect --root <worlds root> --dir <store> [--every 30] [--once] | report --dir <store> [--range 24h|7d] [--json]');
    process.exit(2);
  }
}
