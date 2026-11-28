// The soak's sampler (Engine v2 O6, #2803): one JSON line a minute to <run folder>/minutes.jsonl.
//
//   node v2/tools/soak/sampler.mjs <run folder> <world folder> <worldd pid> <gatewayd pid>
//
// Each line: per process (world, gateway) `anon`, `file` and peak memory (kB, /proc status RssAnon, RssFile, VmHWM),
// open files and threads; the run's cgroup (memory.stat anon and file, memory.current and memory.peak, bytes); the
// world folder's bytes by top-level entry; the disk's free bytes; the tick over the minute: the exact mean and the
// over-budget count from health.json's cumulative counters, and p50, p99 and max of the last tick read at each of
// health.json's writes (every 2 s; its own percentiles are since the process started, so not a minute's); the
// queues' oldest item. pids.txt is read each minute, so a restarted world is followed. Stops on <run folder>/STOP.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [dir, world] = process.argv.slice(2);
const out = path.join(dir, 'minutes.jsonl');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const status = (pid) => {
  const s = read(`/proc/${pid}/status`);
  if (!s) return null;
  const kb = (k) => Number(s.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] ?? NaN);
  let fds = null;
  try { fds = fs.readdirSync(`/proc/${pid}/fd`).length; } catch {}
  return { anonKb: kb('RssAnon'), fileKb: kb('RssFile'), peakKb: kb('VmHWM'), rssKb: kb('VmRSS'), threads: kb('Threads'), fds };
};
const cgroup = () => {
  const rel = read('/proc/self/cgroup')?.split('\n').find((l) => l.startsWith('0::'))?.slice(3);
  if (!rel) return null;
  const base = path.join('/sys/fs/cgroup', rel);
  const stat = read(path.join(base, 'memory.stat'));
  if (!stat) return null;
  const v = (k) => Number(stat.match(new RegExp(`^${k} (\\d+)`, 'm'))?.[1] ?? NaN);
  const num = (f) => { const t = read(path.join(base, f)); return t == null ? null : Number(t); };
  return { anon: v('anon'), file: v('file'), current: num('memory.current'), peak: num('memory.peak'), unit: path.basename(rel) };
};
const bytes = () => {
  const o = {};
  try { for (const e of fs.readdirSync(world)) o[e] = Number(execFileSync('du', ['-sb', path.join(world, e)], { encoding: 'utf8' }).split('\t')[0]); } catch {}
  return o;
};
const free = () => { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return null; } };
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)]; };

let ticks = [], lastWritten = null, prev = null;
const poll = () => {
  const t = read(path.join(world, 'health.json'));
  let h = null;
  try { h = JSON.parse(t); } catch { return null; }
  if (h.written !== lastWritten && h.last_tick_us) {
    lastWritten = h.written;
    ticks.push(Object.values(h.last_tick_us).reduce((a, b) => a + b, 0));
  }
  return h;
};
let health = null;
setInterval(() => { health = poll() ?? health; }, 1000);
setInterval(() => {
  const [wp, gp] = (read(path.join(dir, 'pids.txt')) ?? '').trim().split(/\s+/);
  const h = health;
  let tick = null;
  if (h?.ticks) {
    const sum = h.ticks.mean_us * h.ticks.count;
    const d = prev && h.ticks.count >= prev.count ? { n: h.ticks.count - prev.count, sum: sum - prev.sum, over: h.over_budget - prev.over } : null;
    tick = { count: h.ticks.count, meanUs: d?.n ? Math.round(d.sum / d.n) : null, overBudget: d?.over ?? null, n: d?.n ?? null,
      sampled: ticks.length, p50Us: q(ticks, 0.5), p99Us: q(ticks, 0.99), maxUs: ticks.length ? Math.max(...ticks) : null };
    prev = { count: h.ticks.count, sum, over: h.over_budget };
  }
  const queues = h?.queues ? Object.fromEntries(Object.entries(h.queues).map(([k, v]) => [k, v.oldest_us])) : null;
  fs.appendFileSync(out, JSON.stringify({ t: Math.round(Date.now() / 1000), world: status(wp), gateway: status(gp), cgroup: cgroup(),
    bytes: bytes(), freeBytes: free(), tick, queues, souls: h?.souls ?? null }) + '\n');
  ticks = [];
  if (fs.existsSync(path.join(dir, 'STOP'))) process.exit(0);
}, 60_000);
