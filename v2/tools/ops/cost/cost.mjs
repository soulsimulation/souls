// What a world costs (Engine v2 O11, #2721): dollars per world per day, by part, from use times a unit price.
//
// - The machine is rented at a fixed price. Its day's price is split by part (prices.json `split`), and each part's
//   unit price is that share over the machine's capacity: a core-second, a memory GiB-hour, a local-disk GB-hour. A
//   world is charged its use; what no world used is the line "unused", priced from capacity minus use, so the worlds
//   and "unused" add up to the machine's price ([check]).
// - Stored bytes, uploads and bytes served are priced per unit from the same file.
// - A part with no meter is `null` and reads "not metered", never zero. Uploads and stored bytes have no meter until
//   V3 (history to the object store) has merged.
//
// Meters, sampled every minute by `run` (or one `sample` from a timer), one JSON line per world into
// `$WORLDS_ROOT/health/cost/<UTC day>.jsonl`:
// - processor seconds and resident memory of the world's process (`worldd@<world>`'s MainPID), read from the OS
//   (`/proc` on Linux, `ps` elsewhere); a world with no process uses neither;
// - local disk: the bytes under `$WORLDS_ROOT/worlds/<world>`;
// - bytes served: the origin's counters (`ORIGIN_STATS`, v2/tools/origin/origin.mjs), by the stream path's first
//   segment, which is the world's name.
//
// The page (`page`) is one table written to `$WORLDS_ROOT/health/cost.html`, readable by the machine's owner only
// (mode 0600); nothing serves it. Usage:
//   node cost.mjs sample <worlds root> [world=pid ...]
//   node cost.mjs run <worlds root> [seconds]
//   node cost.mjs page <worlds root> [day] [prices.json]
import { isMain } from '../../../../tools/lib/is-main.mjs';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PARTS = ['processor', 'memory', 'local_disk', 'stored_bytes', 'uploads', 'bytes_served'];
export const MACHINE_PARTS = ['processor', 'memory', 'local_disk'];
export const LABELS = {
  processor: 'Processor', memory: 'Memory', local_disk: 'Local disk',
  stored_bytes: 'Stored bytes', uploads: 'Uploads', bytes_served: 'Bytes served',
};
const DAYS_A_MONTH = 365.25 / 12;
const GIB = 2 ** 30;
const GB = 1e9;
export const PRICES = join(dirname(fileURLToPath(import.meta.url)), 'prices.json');

/** Every priced entry in the file, by name: each must carry a date and a source. */
export function priceEntries(p) {
  return Object.entries(p).filter(([, v]) => v && typeof v === 'object');
}

/**
 * Unit prices in dollars. Use is in: processor core-seconds, memory GiB-hours, local disk GB-hours, stored GB-hours,
 * uploads (count), bytes served (bytes).
 */
export function unitPrices(p) {
  const fx = p.eur_usd.value;
  const usdDay = (p.machine.eur_month * fx) / DAYS_A_MONTH;
  const m = p.machine, s = p.split;
  return {
    usdDay,
    processor: (usdDay * s.processor) / (m.cores * 86_400),
    memory: (usdDay * s.memory) / (m.memory_gb * 24),
    local_disk: (usdDay * s.local_disk) / (m.disk_gb * 24),
    stored_bytes: p.stored_bytes.usd_per_gb_month / (DAYS_A_MONTH * 24),
    uploads: p.uploads.usd_per_million / 1e6,
    bytes_served: (p.bytes_served.eur_per_tb * fx) / 1e12,
  };
}

/** The machine's capacity in each machine part's unit over `hours`. */
export function capacity(p, hours) {
  return { processor: p.machine.cores * hours * 3600, memory: p.machine.memory_gb * hours, local_disk: p.machine.disk_gb * hours };
}

/** A counter's growth between two readings; a new process or origin (`epoch` changed) starts from zero. */
function grown(a, b, value, epoch) {
  if (typeof b[value] !== 'number') return 0;
  if (a[epoch] !== b[epoch] || typeof a[value] !== 'number') return b[value];
  return Math.max(0, b[value] - a[value]);
}

/**
 * Use by world from a day's samples: `{ hours, worlds: { <world>: { <part>: number | null } } }`. Each sample is
 * `{ at_ms, world, pid, cpu_s, rss_bytes, disk_bytes, origin, served_bytes, uploads, stored_bytes }`; a field never
 * given for a world is not metered. Levels (memory, disks) count until the next sample.
 */
export function useFromSamples(samples) {
  const byWorld = new Map();
  for (const s of samples) {
    if (!byWorld.has(s.world)) byWorld.set(s.world, []);
    byWorld.get(s.world).push(s);
  }
  const ats = samples.map((s) => s.at_ms);
  const hours = ats.length ? (Math.max(...ats) - Math.min(...ats)) / 3.6e6 : 0;
  const worlds = {};
  for (const [world, list] of byWorld) {
    list.sort((a, b) => a.at_ms - b.at_ms);
    const has = (k) => list.some((s) => typeof s[k] === 'number');
    const use = {
      processor: 0, memory: 0,
      local_disk: has('disk_bytes') ? 0 : null,
      stored_bytes: has('stored_bytes') ? 0 : null,
      uploads: has('uploads') ? 0 : null,
      bytes_served: has('served_bytes') ? 0 : null,
    };
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      const h = (b.at_ms - a.at_ms) / 3.6e6;
      if (b.pid != null) use.processor += grown(a, b, 'cpu_s', 'pid');
      if (a.pid != null) use.memory += ((a.rss_bytes ?? 0) / GIB) * h;
      if (use.local_disk !== null) use.local_disk += ((a.disk_bytes ?? 0) / GB) * h;
      if (use.stored_bytes !== null) use.stored_bytes += ((a.stored_bytes ?? 0) / GB) * h;
      if (use.uploads !== null) use.uploads += grown(a, b, 'uploads', 'store');
      if (use.bytes_served !== null) use.bytes_served += grown(a, b, 'served_bytes', 'origin');
    }
    worlds[world] = use;
  }
  return { hours, worlds };
}

/** Dollars by world and part (null where not metered), the "unused" line and the machine's price over `hours`. */
export function price(p, { hours, worlds }) {
  const u = unitPrices(p);
  const rows = {};
  const used = { processor: 0, memory: 0, local_disk: 0 };
  for (const [world, use] of Object.entries(worlds)) {
    const row = {};
    for (const part of PARTS) row[part] = use[part] == null ? null : use[part] * u[part];
    for (const part of MACHINE_PARTS) used[part] += use[part] ?? 0;
    rows[world] = row;
  }
  const cap = capacity(p, hours);
  const unused = {};
  for (const part of MACHINE_PARTS) unused[part] = (cap[part] - used[part]) * u[part];
  return { hours, rows, unused, machine: (u.usdDay * hours) / 24 };
}

const total = (row) => Object.values(row).reduce((a, v) => a + (v ?? 0), 0);

/**
 * The sum check: the worlds' machine parts plus "unused" against the machine's price. "Unused" is priced from capacity
 * less use, not taken as the remainder, so a split that does not add to one or a unit price that does not match the
 * machine's size shows here. The figures are summed unrounded: a cell's rounding to the cent is display only.
 */
export function check(priced) {
  let sum = MACHINE_PARTS.reduce((a, part) => a + priced.unused[part], 0);
  for (const row of Object.values(priced.rows)) for (const part of MACHINE_PARTS) sum += row[part] ?? 0;
  const off = priced.machine ? Math.abs(sum - priced.machine) / priced.machine : 0;
  return { sum, machine: priced.machine, off, ok: off <= 0.01 };
}

/** Dollars as shown: to the cent, "under $0.01" for a positive amount below it, "not metered" for no meter. */
export function money(v) {
  if (v == null) return 'not metered';
  if (v > 0 && v < 0.005) return 'under $0.01';
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The table's rows as text cells: worlds, then "unused", then the machine. */
export function tableRows(priced) {
  const out = [];
  for (const world of Object.keys(priced.rows).sort()) {
    const row = priced.rows[world];
    const missing = PARTS.some((part) => row[part] == null);
    out.push([world, ...PARTS.map((part) => money(row[part])), money(total(row)) + (missing ? ' + not metered' : '')]);
  }
  out.push(['unused', ...PARTS.map((part) => (MACHINE_PARTS.includes(part) ? money(priced.unused[part]) : '')), money(total(priced.unused))]);
  out.push(['machine', '', '', '', '', '', '', money(priced.machine)]);
  return out;
}

/** The page: one table. */
export function page(priced, { day, pricesDate }) {
  const head = ['World', ...PARTS.map((part) => LABELS[part]), 'Total'];
  const c = check(priced);
  const tr = (cells, tag = 'td') => `<tr>${cells.map((x) => `<${tag}>${esc(x)}</${tag}>`).join('')}</tr>`;
  return `<!doctype html><meta charset="utf-8"><title>What each world cost</title>
<style>body{font:14px system-ui,sans-serif;margin:16px}table{border-collapse:collapse}td,th{padding:4px 10px;border-bottom:1px solid #ccc;text-align:right}td:first-child,th:first-child{text-align:left}</style>
<h1>What each world cost, ${esc(day)}</h1>
<p>Dollars over ${priced.hours.toFixed(2)} h of samples. Unit prices of ${esc(pricesDate)} (v2/tools/ops/cost/prices.json). Worlds plus "unused" ${money(c.sum)} against the machine's ${money(c.machine)}: ${(c.off * 100).toFixed(2)} % apart.</p>
<table>${tr(head, 'th')}${tableRows(priced).map((r) => tr(r)).join('')}</table>
`;
}

// ---- meters (the machine's own; nothing here touches a world)

/** Processor seconds and resident bytes of a process, or null if it is gone. */
export function readProcess(pid) {
  try {
    if (existsSync(`/proc/${pid}/stat`)) {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const tick = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }));
      const page = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }));
      const rss = Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * page;
      return { cpu_s: (Number(f[11]) + Number(f[12])) / tick, rss_bytes: rss };
    }
    const [time, rssK] = execFileSync('ps', ['-o', 'cputime=,rss=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
    const [days, clock] = time.includes('-') ? time.split('-') : ['0', time];
    const cpu = clock.split(':').reduce((a, x) => a * 60 + Number(x), 0) + Number(days) * 86_400;
    return { cpu_s: cpu, rss_bytes: Number(rssK) * 1024 };
  } catch {
    return null;
  }
}

function mainPid(world) {
  try {
    const pid = Number(execFileSync('systemctl', ['show', '-p', 'MainPID', '--value', `worldd@${world}`], { encoding: 'utf8' }).trim());
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function diskBytes(dir) {
  try {
    return Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split(/\s+/)[0]) * 1024;
  } catch {
    return null;
  }
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** One sample of every world under `root`, appended to the day's file. `pids` overrides the unit's MainPID. */
export function sample(root, pids = {}, now = Date.now()) {
  const worldsDir = join(root, 'worlds');
  const worlds = existsSync(worldsDir) ? readdirSync(worldsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  let origin = null;
  try {
    origin = JSON.parse(readFileSync(process.env.ORIGIN_STATS ?? join(root, 'health', 'origin-stats.json'), 'utf8'));
  } catch {}
  const lines = [];
  for (const world of worlds.sort()) {
    const pid = world in pids ? pids[world] : mainPid(world);
    const proc = pid == null ? null : readProcess(pid);
    const s = { at_ms: now, world, pid: proc ? pid : null, cpu_s: proc?.cpu_s ?? 0, rss_bytes: proc?.rss_bytes ?? 0, disk_bytes: diskBytes(join(worldsDir, world)) };
    if (origin) Object.assign(s, { origin: origin.started, served_bytes: origin.bytes?.[world] ?? 0 });
    lines.push(JSON.stringify(s));
  }
  const dir = join(root, 'health', 'cost');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lines.length) appendFileSync(join(dir, `${utcDay(now)}.jsonl`), lines.join('\n') + '\n', { mode: 0o600 });
  return lines.length;
}

/** The day's page and figures, written for the owner only. Returns the priced day and the check. */
export function writePage(root, day = utcDay(Date.now()), pricesPath = PRICES) {
  const p = JSON.parse(readFileSync(pricesPath, 'utf8'));
  const file = join(root, 'health', 'cost', `${day}.jsonl`);
  const samples = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const priced = price(p, useFromSamples(samples));
  const out = join(root, 'health', 'cost.html');
  writeFileSync(`${out}.tmp`, page(priced, { day, pricesDate: p.machine.date }), { mode: 0o600 });
  chmodSync(`${out}.tmp`, 0o600);
  renameSync(`${out}.tmp`, out);
  return { priced, check: check(priced), out };
}

if (isMain(import.meta.url)) {
  const [cmd, root, ...rest] = process.argv.slice(2);
  if (!root) throw new Error('usage: node cost.mjs sample|run|page <worlds root> ...');
  const pids = Object.fromEntries(rest.filter((a) => a.includes('=')).map((a) => a.split('=')).map(([w, p]) => [w, Number(p) || null]));
  if (cmd === 'sample') console.log(`sampled ${sample(root, pids)}`);
  else if (cmd === 'run') {
    const every = Number(rest[0] ?? 60) * 1000;
    sample(root);
    setInterval(() => sample(root), every);
  } else if (cmd === 'page') {
    const { priced, check: c, out } = writePage(root, rest[0], rest[1]);
    for (const r of tableRows(priced)) console.log(r.join('\t'));
    console.log(`check ${JSON.stringify(c)}`);
    console.log(`page ${out}`);
    if (!c.ok) process.exitCode = 1;
  } else throw new Error(`unknown command ${cmd}`);
}
