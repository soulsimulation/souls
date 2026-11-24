// The limits run's guard on a served Eden (0.133 P3): what the run may load, and when it must stop.
//
//   node guard.mjs probe [--root /var/lib/souls/worlds] [--cgroup /sys/fs/cgroup] [--world eden]
//                        [--authority /etc/souls/placement-data/authority.json] [--instance <id>] [--every 5]
//       On the machine that serves the worlds: one JSON line every `--every` s, files only (it connects to nothing and
//       wakes no world): Eden's health record (`h`, as stage 2a's sampler keeps it), its supervisor state, its and
//       souls.slice's memory against their MemoryMax, and every world's state. Read-only; run it as a user that can
//       read the worlds root (the health page's), never as root.
//   node guard.mjs preflight --probe '<command>' [--gateway ws://host:port] [--stream <url>] [--viewers <url>]
//       Where the load runs: reads the probe's lines (any command printing them, e.g. `ssh <machine> node guard.mjs
//       probe`) until two are 10 s apart, then refuses (exit 2, naming why) unless Eden is running, its health is
//       fresh, its ticks were on time in between, and Eden and the slice have memory headroom; each stream URL given
//       must answer its `pointer`. Prints one line: the worlds' states, Eden's memory and the gateway's connect time.
//   node guard.mjs watch --probe '<command>' --samples <file> --pids <file> --abort <file>
//       Beside a rung: appends every probe line to <samples> (stage 2a's analyser reads them), and stops the load
//       (SIGTERM to every pid in <pids>), writing the reason to <abort>, when Eden's ticks on time over the last 30 s
//       fall below 95 %, Eden's or the slice's memory passes 85 % of its MemoryMax, or the probe is silent for 30 s.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { healthFile, worldRow, worlds } from '../../ops/health/read.mjs';

export const BARS = Object.freeze({
  // preflight: what a run may start from
  startOnTime: 0.99, startMemShare: 0.6, healthAgeS: 30, spanS: 10,
  // watch: when a run stops
  abortOnTime: 0.95, abortMemShare: 0.85, windowS: 30, silentS: 30,
});

const json = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const num = (f) => { try { const v = readFileSync(f, 'utf8').trim(); return v === 'max' ? null : Number(v); } catch { return null; } };
const mem = (dir) => ({ current: num(join(dir, 'memory.current')), max: num(join(dir, 'memory.max')) });

/** One probe sample, files only. `instance` is Eden's placed instance (from the authority map when not given). */
export function sample({ root, cgroup, instance, now = Date.now() }) {
  const h = healthFile(root, instance);
  const row = worldRow(root, instance, now);
  const states = {};
  for (const w of worlds(root)) { const s = worldRow(root, w, now).state; states[s] = (states[s] ?? 0) + 1; }
  const slice = join(cgroup, 'souls.slice');
  const eden = mem(join(slice, `worldd@${instance}.service`));
  const stream = json(join(root, 'worlds', instance, 'views', 'world.json'))?.stream ?? null;
  // `wrss` in kB, as stage 2a's sampler writes a process's resident memory: here the world's whole cgroup.
  return { t: now / 1000, h, state: row.state, healthAgeS: row.tick?.health_age_s ?? null, eden, slice: mem(slice), worlds: states, stream, wrss: eden.current == null ? 0 : Math.round(eden.current / 1024) };
}

const share = (m) => (m?.current != null && m?.max ? m.current / m.max : null);
/** Ticks on time between two samples' health counters (null when no tick ran). */
export function onTime(a, b) {
  const n = (b?.h?.ticks?.count ?? 0) - (a?.h?.ticks?.count ?? 0), over = (b?.h?.over_budget ?? 0) - (a?.h?.over_budget ?? 0);
  return n > 0 ? 1 - over / n : null;
}

/** Why a run may not start from these two samples (10 s or more apart); [] when it may. */
export function refusals(a, b, bars = BARS) {
  const why = [];
  if (b.state !== 'running') why.push(`Eden is ${b.state}, not running`);
  if (b.healthAgeS == null || b.healthAgeS > bars.healthAgeS) why.push(`Eden's health is ${b.healthAgeS ?? 'not'} s old (at most ${bars.healthAgeS})`);
  const on = onTime(a, b);
  if (on == null || on < bars.startOnTime) why.push(`Eden's ticks on time ${on == null ? 'unknown (no tick ran)' : (100 * on).toFixed(2) + ' %'} (at least ${100 * bars.startOnTime} %)`);
  for (const [name, m] of [['Eden', b.eden], ['souls.slice', b.slice]]) {
    const s = share(m);
    if (s == null) why.push(`${name}'s memory or MemoryMax unknown`);
    else if (s > bars.startMemShare) why.push(`${name} uses ${(100 * s).toFixed(0)} % of its MemoryMax (at most ${100 * bars.startMemShare} % to start)`);
  }
  return why;
}

/** Why a running load must stop, from the samples so far and the time the last arrived; null to go on. */
export function abortReason(samples, nowS, lastAtS, bars = BARS) {
  if (nowS - lastAtS > bars.silentS) return `the probe has been silent for ${Math.round(nowS - lastAtS)} s`;
  const b = samples.at(-1);
  if (!b) return null;
  for (const [name, m] of [['Eden', b.eden], ['souls.slice', b.slice]]) {
    const s = share(m);
    if (s != null && s > bars.abortMemShare) return `${name} at ${(100 * s).toFixed(0)} % of its MemoryMax (above ${100 * bars.abortMemShare} %)`;
  }
  const a = samples.findLast((x) => x.t <= b.t - bars.windowS);
  const on = a && onTime(a, b);
  if (on != null && on < bars.abortOnTime) return `Eden's ticks on time ${(100 * on).toFixed(2)} % over the last ${Math.round(b.t - a.t)} s (below ${100 * bars.abortOnTime} %)`;
  return null;
}

/** The probe command's lines, each parsed, to `onLine(sample, receivedAtS)`; returns the child. */
function stream(cmd, onLine) {
  const p = spawn('sh', ['-c', `exec ${cmd}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const s = JSON.parse(line); if (s && typeof s.t === 'number') onLine(s, Date.now() / 1000, line); } catch { /* not a sample */ }
    }
  });
  return p;
}

/** Median TCP connect time to the gateway, ms: the network share of every receipt measured from here. */
async function connectMs(url, n = 5) {
  const u = new URL(url), ms = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await new Promise((ok, no) => { const s = connect(Number(u.port || 80), u.hostname, () => { s.destroy(); ok(); }); s.on('error', no); s.setTimeout(5000, () => { s.destroy(); no(new Error('timeout')); }); });
    ms.push(performance.now() - t);
  }
  return +ms.sort((a, b) => a - b)[n >> 1].toFixed(1);
}

async function pointerOk(base) {
  try { const r = await fetch(new URL('pointer', base.endsWith('/') ? base : base + '/'), { headers: { 'cache-control': 'no-store' } }); await r.arrayBuffer(); return r.ok; } catch { return false; }
}

const gb = (b) => (b == null ? '-' : (b / 2 ** 30).toFixed(2));
const states = (w) => Object.entries(w ?? {}).map(([k, n]) => `${n} ${k}`).join(', ') || 'none';

async function preflight(o) {
  const got = [];
  const done = await new Promise((ok) => {
    const t = setTimeout(() => ok(null), 90_000);
    const p = stream(o.probe, (s) => {
      got.push(s);
      const a = got.find((x) => s.t - x.t >= BARS.spanS);
      if (a) { clearTimeout(t); p.kill(); ok([a, s]); }
    });
    p.on('exit', () => { clearTimeout(t); ok(null); });
  });
  if (!done) { console.error(`preflight: refused: the probe gave ${got.length ? 'no two samples 10 s apart' : 'no sample'} within 90 s`); return 2; }
  const [a, b] = done, why = refusals(a, b);
  for (const [name, url] of [['--stream', o.stream], ['--viewers', o.viewers]]) if (url && !(await pointerOk(url))) why.push(`${name} ${url}: its pointer does not answer`);
  let rtt = null;
  if (o.gateway) { try { rtt = await connectMs(o.gateway.replace(/^ws:/, 'http:')); } catch (e) { why.push(`--gateway does not connect (${e.message})`); } }
  const on = onTime(a, b);
  const line = `worlds: ${states(b.worlds)}; Eden ${b.state}, ticks on time ${on == null ? '-' : (100 * on).toFixed(2) + ' %'}, memory ${gb(b.eden.current)} of ${gb(b.eden.max)} GB; souls.slice ${gb(b.slice.current)} of ${gb(b.slice.max)} GB; stream ${b.stream ?? '-'}; gateway connect ${rtt ?? '-'} ms`;
  if (why.length) { console.error(`preflight: refused: ${why.join('; ')}\npreflight: ${line}`); return 2; }
  console.log(`preflight: ok; ${line}`);
  return 0;
}

function watch(o) {
  const samples = [];
  let last = Date.now() / 1000, stopped = false;
  const stop = (why) => {
    if (stopped) return;
    stopped = true;
    writeFileSync(o.abort, why + '\n');
    console.error(`guard: stopping the load: ${why}`);
    const pids = existsSync(o.pids) ? readFileSync(o.pids, 'utf8').split(/\s+/).filter((p) => /^\d+$/.test(p)) : [];
    for (const p of pids) { try { process.kill(Number(p), 'SIGTERM'); } catch { /* already ended */ } }
  };
  const p = stream(o.probe, (s, at, line) => {
    samples.push(s); last = at;
    appendFileSync(o.samples, line + '\n');
    const why = abortReason(samples, at, last);
    if (why) stop(why);
  });
  const timer = setInterval(() => { const why = abortReason(samples, Date.now() / 1000, last); if (why) stop(why); }, 5000);
  const end = () => { clearInterval(timer); p.kill(); process.exit(0); };
  process.on('SIGTERM', end); process.on('SIGINT', end);
}

function probe(o) {
  const root = o.root ?? '/var/lib/souls/worlds', cgroup = o.cgroup ?? '/sys/fs/cgroup';
  const instance = o.instance ?? json(o.authority ?? '/etc/souls/placement-data/authority.json')?.worlds?.[o.world ?? 'eden']?.instance;
  if (!instance) { console.error(`probe: no instance for ${o.world ?? 'eden'} in the authority map; give --instance`); process.exit(2); }
  process.stdout.on('error', () => process.exit(0)); // its reader has gone (a preflight ends once it has two samples)
  const once = () => console.log(JSON.stringify(sample({ root, cgroup, instance })));
  once();
  setInterval(once, 1000 * Number(o.every ?? 5));
}

// realpath: the release path on the production machine is a symlink, and the module's own URL is resolved.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2), o = {};
  for (let i = 0; i < rest.length; i += 2) o[rest[i].replace(/^--/, '')] = rest[i + 1];
  if (mode === 'probe') probe(o);
  else if (mode === 'preflight' && o.probe) process.exit(await preflight(o));
  else if (mode === 'watch' && o.probe && o.samples && o.pids && o.abort) watch(o);
  else { console.error('guard.mjs probe [...] | preflight --probe <cmd> [--gateway <ws url>] [--stream <url>] [--viewers <url>] | watch --probe <cmd> --samples <f> --pids <f> --abort <f>'); process.exit(2); }
}
