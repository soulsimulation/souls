// What the site owner's health page (Engine v2 O21, #3325) reads of each world on this machine: files only. Nothing
// here connects to a world, its gateway or the directory's store, so reading wakes no world.
//
// Sources under the machine's worlds root ($WORLDS_ROOT, v2/tools/ops/units/worldd@.service):
// - the supervisor's health record, `health/<world>.json` (O1, #2730): state, starts in five minutes, failures since
//   it last served, last exit, next try;
// - the world's `health.json` (O4, #2694) in `worlds/<world>/` (`health.json` or `<log>.health.json`): ticks against
//   their budget and each queue's oldest item;
// - this machine's cached copy of the world's directory record, `cache/<world>` (W8, #2729): where it runs and when a
//   sleeping world must wake.
// The watcher's last look (O15) and the cost (O11) have no source yet: they are `null` and read "not metered".
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** States in which the world's process is up or being brought up: the world is awake. */
export const AWAKE = new Set(['running', 'starting', 'restarting', 'restart-loop']);
/** Fields the page shows that nothing meters yet, by the task that will. */
export const NOT_METERED = { watcher: 'O15 (#2808)', cost: 'O11 (#2721)' };

const json = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const names = (dir, strip = '') => {
  try { return readdirSync(dir).filter((n) => !n.startsWith('.') && n.endsWith(strip)).map((n) => n.slice(0, n.length - strip.length)); } catch { return []; }
};

/** Every world this machine knows of: a supervisor record, a state folder or a cached directory record. */
export function worlds(root) {
  const all = new Set([...names(join(root, 'health'), '.json'), ...names(join(root, 'worlds')), ...names(join(root, 'cache'))]);
  return [...all].filter((n) => /^[0-9a-f]+-[0-9a-f]+-\d+$/.test(n)).sort();
}

/** The world's O4 health file: `health.json`, else the newest `*.health.json` in its state folder. */
export function healthFile(root, world) {
  const dir = join(root, 'worlds', world);
  if (existsSync(join(dir, 'health.json'))) return json(join(dir, 'health.json'));
  const found = names(dir, '.health.json');
  return found.length ? json(join(dir, `${found.sort().at(-1)}.health.json`)) : null;
}

/** A small CBOR reader for the directory record's profile (`replica::encode`): uints, bytes, text, arrays, maps. */
export function cbor(bytes) {
  let i = 0;
  const arg = (info) => {
    if (info < 24) return info;
    const n = 1 << (info - 24);
    let v = 0;
    for (let k = 0; k < n; k++) v = v * 256 + bytes[i++];
    return v;
  };
  const item = () => {
    const b = bytes[i++], major = b >> 5, n = arg(b & 31);
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2) { const v = bytes.subarray(i, i + n); i += n; return v; }
    if (major === 3) { const v = Buffer.from(bytes.subarray(i, i + n)).toString('utf8'); i += n; return v; }
    if (major === 4) return Array.from({ length: n }, item);
    if (major === 5) { const m = new Map(); for (let k = 0; k < n; k++) m.set(item(), item()); return m; }
    if (major === 6) return item();
    throw new Error(`cbor: major type ${major}`);
  };
  return item();
}

/** Where the world runs and when it must wake, from this machine's cached copy of its directory record. */
export function directoryRecord(root, world) {
  try {
    const m = cbor(readFileSync(join(root, 'cache', world)));
    const wake = m.get(7);
    return { where: m.get(3) ?? null, epoch: m.get(4) ?? null, wakeAt: typeof wake === 'number' ? Math.floor(wake / 1000) : null };
  } catch { return null; }
}

const ms = (us) => (Number.isFinite(us) ? Math.round(us / 100) / 10 : null);

/** One world's row: numbers only, no Soul, account, token or words. */
export function worldRow(root, world, now) {
  const sup = json(join(root, 'health', `${world}.json`));
  const h = healthFile(root, world);
  const dir = directoryRecord(root, world);
  const state = sup?.state ?? 'unknown';
  const queues = h?.queues ? Object.values(h.queues) : [];
  return {
    world,
    where: dir?.where ?? null,
    awake: AWAKE.has(state) ? 'awake' : 'asleep',
    state,
    wake_at: dir?.wakeAt ?? null,
    restarts: sup ? { in_5_min: sup.count, failures: sup.failures, last_exit: sup.last_exit, next_try: sup.next_try, at: sup.at } : null,
    tick: h ? {
      lag_ms: ms(Math.max(0, ...queues.map((q) => q.oldest_us ?? 0))),
      p99_ms: ms(h.ticks?.p99_us),
      budget_ms: ms(h.budget_us),
      over_budget: h.over_budget ?? null,
      health_age_s: Number.isFinite(h.at_unix_ms) ? Math.max(0, Math.round((now - h.at_unix_ms) / 1000)) : null,
    } : null,
    watcher: null,
    cost: null,
  };
}

/** Every world's row at `now`. `cost(world)` (O11) fills the cost column when it is given. */
export function readWorlds(root, now = Date.now(), { cost } = {}) {
  return worlds(root).map((w) => {
    const row = worldRow(root, w, now);
    if (cost) row.cost = cost(w) ?? null;
    return row;
  });
}
