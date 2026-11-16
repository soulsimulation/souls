// Soul Client eval, load mode (#1752 A5): N scripted Souls on one fresh fake-mind world. Each Soul runs `serve` and the new
// client's own loop: `pending` (acknowledging and closing any owner message), `look`, `find`, and `act` on a row it found.
// The harness sends each Soul an owner message every --card-sec. Every Soul's client trace (`soul-trace/1`) is
// folded by route: server time from `Server-Timing`, p50/p99/p99.9, against #1750's level (bookkeeping 50 ms, reads 100 ms,
// an act's acknowledgment 150 ms). $0: no model runs.
// #1944: the world's own side, from its live.json: an act's four parts (queue, handler, wait, commit) at p50 and p99 with
// the acts whose wait passed three ticks, at the end of the run, and each 10-second tick window that ended during it.
// #2124: each window also carries the seconds at amber per signal that held it (`amberS`) and the entries into amber per
// cause (`amberEntries`); LOAD.md sums both over the run.
// #2124 L4: each act's capability is kept beside the trace's own act calls, so LOAD.md names the slow ones (`slowActs`:
// server time less the queue, per capability) and their queue (`actQueueMs`, p50/p95/max).
// #2437: `--act-sec <s>` paces each Soul like a real agent (one act every s seconds on average) instead of the nonstop
// loop; every run also reports the act calls' whole server time and queue at p50/p95/p99 (`actLatency`).
// #2458: `--fault-every-sec <s>` runs the world with SIM_FAULT_INJECT=1 and throws an engine error inside a tick at the end
// of setup and every s seconds of the load (fault-inject `throw`); each arm reports the world's recovery hold lines
// (`recoveries`: hold ms, replays and their ticks) and its watchdog kills. `--hang-kill-sec <s>` sets the world's hang kill (SIM_HANG_KILL_MS).
// #2508 the act meter: every arm states its intended acts (Souls x seconds / --act-sec) and achieved acts, under-driven
// below 95 %. `--profile` CPU-profiles the world's clock thread over the load window (prof-hook.mjs) and reports an act's
// clock ms by part (prof-buckets.mjs: bind, check, rest of handler, the tick's route searches by kind, commit), the
// planner's sync and audit, and long holds by source, beside the means of the world's own parts (live.json sums) and the
// time admission charged each act. `--menu-stats` runs the world with EDGE_MENU_STATS=1 and folds its menu counters over
// the load window into the report, with builds per act. Without these flags nothing else changes.
import { join, resolve, relative } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { startWorld, stopWorld } from '../arena/provision.mjs';
import { readJsonl, writeJson } from '../lib/jsonl.mjs';
import { newIdentity, rng } from '../lib/hash.mjs';
import { sleep } from '../lib/clock.mjs';
import { run } from '../lib/proc.mjs';
import { sendCard } from '../arena/owner.mjs';
import { prepareFolder, runtimeDir } from './episode.mjs';
import { httpSince, routeStats, refusalCounts } from './measure.mjs';
import { bucketProfile, perAct, readProfile, ACT_GROUPS } from './prof-buckets.mjs';

const PROF_HOOK = new URL('./prof-hook.mjs', import.meta.url).pathname;

const WORDS = ['bench', 'eat', 'read', 'library', 'windmill', 'bandstand', 'music', 'fire circle', 'pond', 'garden', 'sit on the floor', 'dance'];
const REPO = resolve(new URL('../../..', import.meta.url).pathname);
const log = (...a) => process.stderr.write(`[soul-eval load] ${a.join(' ')}\n`);
const cliJson = async (folder, args) => { const r = await run('node', ['eden.mjs', ...args], { cwd: folder, maxWallMs: 90000 }); try { return { code: r.code, data: JSON.parse(r.stdout) }; } catch { return { code: r.code, data: null }; } };

const readLive = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const pq = (q) => (q ? { p50: q.p50, p99: q.p99 } : null);
/** #1944: the world's act parts (live.json `api.routes['edge:act']`), or null when it has none. */
function actPartsOfLive(live) {
  const a = live?.api?.routes?.['edge:act'];
  if (!a?.parts) return null;
  return { n: a.n, queue: pq(a.queue), handler: pq(a.parts.handler), wait: pq(a.parts.wait), commit: pq(a.parts.commit), waitOver3Ticks: a.parts.waitOver3Ticks };
}

/** The capability of a found row: its verb, else the id's kind (`walk:…` → walk, `object:<thing>:<verb>` → the verb). */
export const capabilityOf = (row) => row?.verb ?? (String(row?.act ?? '').startsWith('object:') ? String(row.act).split(/[:\s]/)[2] : String(row?.act ?? '').split(/[:\s]/)[0]) ?? 'act';

/** Per capability: the act calls' server time less their queue (handler + wait + commit), slowest first. `acts` are the
 *  loop's own acts ({cap, t0, t1}, local wall ms) and `http` the same Soul's trace; an act call is the loop's act whose
 *  span holds it. */
export function slowActs(pairs) {
  const by = new Map();
  for (const { acts, http } of pairs) for (const r of http) {
    if (r.method !== 'POST' || !/\/v1\/edge\/act(?:\?|$)/.test(r.route ?? '') || !Number.isFinite(r.serverMs)) continue;
    const a = acts.find((x) => r.at >= x.t0 && r.at <= x.t1 + 100), cap = a?.cap ?? 'unmatched';
    const e = by.get(cap) ?? []; e.push(Math.max(0, r.serverMs - (r.queuedMs ?? 0))); by.set(cap, e);
  }
  return [...by.entries()].map(([capability, ms]) => {
    ms.sort((x, y) => x - y);
    return { capability, n: ms.length, p50: ms[Math.floor(0.5 * (ms.length - 1))], max: ms.at(-1), over250: ms.filter((x) => x > 250).length };
  }).sort((x, y) => y.max - x.max);
}

/** The act calls' queue (Server-Timing `queue`, the client trace's `queuedMs`): p50, p95 and max over the run, ms. */
export function actQueue(pairs) {
  const ms = pairs.flatMap(({ http }) => http.filter((r) => r.method === 'POST' && /\/v1\/edge\/act(?:\?|$)/.test(r.route ?? '') && Number.isFinite(r.queuedMs)).map((r) => r.queuedMs)).sort((x, y) => x - y);
  const q = (p) => ms[Math.min(ms.length - 1, Math.max(0, Math.ceil(p * ms.length) - 1))];
  return ms.length ? { n: ms.length, p50: q(0.5), p95: q(0.95), max: ms.at(-1) } : null;
}

/** #2437: the act calls' whole server time (Server-Timing total, queue included) and their queue: p50/p95/p99/max, ms. */
export function actLatency(pairs) {
  const calls = pairs.flatMap(({ http }) => http.filter((r) => r.method === 'POST' && /\/v1\/edge\/act(?:\?|$)/.test(r.route ?? '') && Number.isFinite(r.serverMs)));
  const stats = (ms) => { ms.sort((x, y) => x - y); const q = (p) => ms[Math.min(ms.length - 1, Math.max(0, Math.ceil(p * ms.length) - 1))]; return ms.length ? { n: ms.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: ms.at(-1) } : null; };
  return { server: stats(calls.map((r) => r.serverMs)), queue: stats(calls.filter((r) => Number.isFinite(r.queuedMs)).map((r) => r.queuedMs)) };
}

// #2437: the paced loop's verbs, like the m4-v1 battery's: walks to named places, sit, eat, read, a bench, music.
const PACED_WORDS = ['bandstand', 'windmill', 'fire circle', 'lake', 'library', 'sit on the floor', 'eat', 'read', 'bench', 'music', 'garden', 'pond'];

/** #2437: a Soul paced like a real agent: one act every `actSec` on average (uniform ±50 %, from a random first offset,
 *  so Souls do not act in step), each a `find` and an `act` on one of its three nearest rows; owner messages are checked
 *  every 30 s. A cycle that runs late starts the next at once, never two together. */
export async function pacedLoop({ folder, until, r, counts, acts = [], actSec, cli = cliJson }) {
  let next = Date.now() + r() * actSec * 1000, lastPending = Date.now();
  for (;;) {
    await sleep(Math.max(0, next - Date.now()));
    if (Date.now() >= until) break;
    next = Math.max(Date.now(), next + actSec * 1000 * (0.5 + r()));
    if (Date.now() - lastPending >= 30000) {
      lastPending = Date.now(); const p = await cli(folder, ['pending']); counts.cmds++;
      for (const m of p.data?.ownerMessages ?? []) { if (!m?.id) continue; await cli(folder, ['ack', m.id, 'On it.']); await cli(folder, ['result', m.id, 'done', 'Done.']); counts.cmds += 2; counts.closed++; }
    }
    const f = await cli(folder, ['find', PACED_WORDS[Math.floor(r() * PACED_WORDS.length)]]); counts.cmds++;
    const rows = (f.data?.found ?? []).filter((x) => x.act);
    if (!rows.length) continue;
    const row = rows[Math.floor(r() * Math.min(3, rows.length))], t0 = Date.now();
    const a = await cli(folder, ['act', row.act]); counts.cmds++; counts.acts++; if (a.data?.accepted === false) counts.refused++;
    acts.push({ cap: capabilityOf(row), t0, t1: Date.now() });
  }
}

async function soulLoop({ folder, until, r, counts, acts = [] }) {
  while (Date.now() < until) {
    const p = await cliJson(folder, ['pending']); counts.cmds++;
    for (const m of p.data?.ownerMessages ?? []) {
      if (!m?.id) continue;
      await cliJson(folder, ['ack', m.id, 'On it.']); await cliJson(folder, ['result', m.id, 'done', 'Done.']); counts.cmds += 2; counts.closed++;
    }
    await cliJson(folder, ['look']); counts.cmds++;
    const f = await cliJson(folder, ['find', WORDS[Math.floor(r() * WORDS.length)]]); counts.cmds++;
    const rows = (f.data?.found ?? []).filter((x) => x.act);
    if (rows.length) {
      const row = rows[Math.floor(r() * Math.min(3, rows.length))], t0 = Date.now();
      const a = await cliJson(folder, ['act', row.act]); counts.cmds++; counts.acts++; if (a.data?.accepted === false) counts.refused++;
      acts.push({ cap: capabilityOf(row), t0, t1: Date.now() });
    }
    await sleep(3000 + Math.floor(r() * 3000));
  }
}

export async function runLoad(o) {
  const sizes = String(o.souls ?? '12,24').split(',').map(Number).filter((n) => n > 0);
  const first = Number(o['first-repeat'] ?? 1), repeats = Number(o.repeats ?? 1), durSec = Number(o['duration-sec'] ?? 120), cardSec = Number(o['card-sec'] ?? 30), actSec = o['act-sec'] != null ? Number(o['act-sec']) : null, port = Number(o.port ?? 18780);
  const serverRoot = resolve(o['server-root'] ?? REPO), faultSec = o['fault-every-sec'] != null ? Number(o['fault-every-sec']) : null;
  if (faultSec) process.env.SIM_FAULT_INJECT = '1';
  if (o['hang-kill-sec'] != null) process.env.SIM_HANG_KILL_MS = String(1000 * Number(o['hang-kill-sec']));
  const profile = !!o.profile, menuStats = !!o['menu-stats'];
  const out = resolve(o.out ?? join(REPO, '.local/soul-eval', `load-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  mkdirSync(out, { recursive: true });
  const arms = [];
  for (let rep = first; rep < first + repeats; rep++) for (const n of sizes) {
    const dir = join(out, `n${n}-r${rep}`); mkdirSync(dir, { recursive: true });
    // a world that exits on its own says how (code, signal) and its resident memory every 30 s, in this log (Linux /proc)
    let stopping = false;
    // #2508: the profiler hook and the menu counters reach the world through its environment, only while it starts
    const profDir = join(dir, 'server', 'prof'), envWas = { NODE_OPTIONS: process.env.NODE_OPTIONS, SIM_PROF_DIR: process.env.SIM_PROF_DIR, EDGE_MENU_STATS: process.env.EDGE_MENU_STATS };
    if (profile) { mkdirSync(profDir, { recursive: true }); process.env.NODE_OPTIONS = `${envWas.NODE_OPTIONS ? envWas.NODE_OPTIONS + ' ' : ''}--import=${PROF_HOOK}`; process.env.SIM_PROF_DIR = profDir; }
    if (menuStats) process.env.EDGE_MENU_STATS = '1';
    let w;
    try { w = await startWorld({ serverRoot, slug: 'eden-load', port, genesis: 'worlds/templates/eden-2026.json', dataDir: join(dir, 'server', 'data'), log: join(dir, 'server', 'world.log'),
      onSpawn: (c) => c.on('exit', (code, signal) => { if (!stopping) log(`n${n} r${rep}: the world exited on its own (code ${code}, signal ${signal}); see n${n}-r${rep}/server/world.log`); }) }); }
    finally { for (const [k, v] of Object.entries(envWas)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
    const rss = setInterval(() => { try { const kb = /^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${w.pid}/status`, 'utf8'))?.[1]; if (kb) log(`n${n} r${rep}: world rss ${Math.round(kb / 1024)} MB`); } catch { /* not Linux, or gone */ } }, 30000);
    const souls = [];
    try {
      // setup is paced at 6 Souls per 30 s: all Souls share one address, and a world pairs at most 20 in any 60 s from one
      // address (POST /v1/agent/pair). Setup is not measured.
      for (let i = 0; i < n; i += 6) { const b0 = Date.now(); await Promise.all(Array.from({ length: Math.min(6, n - i) }, async (_, j) => {
        const k = i + j, folder = join(dir, 'souls', `s${k}`); mkdirSync(folder, { recursive: true });
        const identity = newIdentity(); writeFileSync(join(folder, '.eden-agent.json'), JSON.stringify({ identity }) + '\n', { mode: 0o600 });
        const fake = { folder, base: w.base, info: {}, save() {} };
        const s = await prepareFolder(fake, { name: `Load ${k}` });
        souls[k] = { folder, identity, soulId: s.soulId, acts: [] };
      })); if (i + 6 < n) await sleep(Math.max(0, b0 + 30000 - Date.now())); }
      log(`n${n} r${rep}: ${souls.length} Souls serving; load for ${durSec} s`);
      const t0 = Date.now(), until = t0 + durSec * 1000, counts = { cmds: 0, acts: 0, refused: 0, closed: 0, cards: 0, cardErrors: 0 };
      // #1944 A3: each tick window that ended during the load (live.json is rewritten every 2 s; a window lasts 10 s)
      const liveFile = join(dir, 'server', 'data', 'live.json'), tickWindows = new Map();
      const worldLog = join(dir, 'server', 'world.log'), sums0 = actSums(readLive(liveFile)), logAtStart = menuStats ? logSize(worldLog) : 0;
      if (profile) writeFileSync(join(profDir, 'prof.start'), '');
      const watch = setInterval(() => { const w = readLive(liveFile)?.api?.ticks; if (w?.at > t0 && w.at <= until + 2000) tickWindows.set(w.at, w); }, 4000);
      const faults = faultSec ? (async () => { for (let at = t0; at < until; at += faultSec * 1000) { await sleep(Math.max(0, at - Date.now())); await injectThrow(port); } })() : null;
      const cards = (async () => { while (Date.now() + cardSec * 1000 < until) { await sleep(cardSec * 1000); await Promise.all(souls.map((s) => sendCard({ base: w.base, soulId: s.soulId, identity: s.identity, text: 'Look around.' }).then(() => counts.cards++, () => counts.cardErrors++))); } })();
      await Promise.all(souls.map((s, k) => (actSec ? pacedLoop({ folder: s.folder, until, r: rng(1000 * rep + k), counts, acts: s.acts, actSec }) : soulLoop({ folder: s.folder, until, r: rng(1000 * rep + k), counts, acts: s.acts }))));
      await cards; await faults;
      if (profile) writeFileSync(join(profDir, 'prof.stop'), '');   // #2508: the profile covers the load, not the settle after it
      const logAtEnd = menuStats ? logSize(worldLog) : 0;
      await sleep(2500); clearInterval(watch);   // the watchdog's next live.json has the last acts
      const live = readLive(liveFile), server = { act: actPartsOfLive(live), tickWindows: [...tickWindows.values()].sort((x, y) => x.at - y.at) };
      if (profile || menuStats) server.meter = await meterOf({ sums0, sums1: actSums(live), menu0: menuStats ? menuStatsAfter(worldLog, logAtStart) : null, menu1: menuStats ? await menuStatsAfterWait(worldLog, logAtEnd) : null, profDir: profile ? profDir : null, serverRoot });
      const http = [], pairs = [];
      for (const [k, s] of souls.entries()) {
        await cliJson(s.folder, ['serve', '--stop']);
        const f = join(runtimeDir(s.folder, s.soulId), '.eden-report.jsonl');
        if (existsSync(f)) { mkdirSync(join(dir, 'trace'), { recursive: true }); copyFileSync(f, join(dir, 'trace', `s${k}.jsonl`)); const own = httpSince(readJsonl(f), t0); http.push(...own); pairs.push({ acts: s.acts, http: own }); }
      }
      const routes = routeStats(http);
      const intended = actSec ? Math.round(n * durSec / actSec) : null;
      arms.push({ souls: n, repeat: rep, durationSec: durSec, counts, intendedActs: intended, achievedShare: intended ? Math.round(1000 * counts.acts / intended) / 1000 : null, calls: http.length, routes, refusals: refusalCounts(http), server, slowActs: slowActs(pairs), actQueueMs: actQueue(pairs), actLatency: actLatency(pairs), actSec, held: routes.every((x) => x.levelMs == null || (x.serverMs.p999 ?? 0) <= x.levelMs), ...(faultSec ? recoveryLines(join(dir, 'server', 'world.log')) : {}) });
      log(`n${n} r${rep}: ${http.length} calls, ${counts.acts} acts, ${counts.closed} messages closed; level held on every route: ${arms.at(-1).held}`);
    } finally {
      clearInterval(rss); stopping = true;
      await stopWorld({ pid: w.pid });
      if (!o['keep-data']) { rmSync(join(dir, 'server', 'data'), { recursive: true, force: true }); rmSync(join(dir, 'souls'), { recursive: true, force: true }); }
    }
  }
  const result = { schema: 'soul-eval-load/1', world: 'local:eden-2026', arms, endedAt: new Date().toISOString() };
  writeJson(join(out, 'load-result.json'), result);
  writeFileSync(join(out, 'LOAD.md'), renderLoad(result));
  log(`wrote ${relative(process.cwd(), out)}/load-result.json and LOAD.md`);
  return result;
}

/** #2508: live.json's since-start act sums (api-times.ts `parts.sums`), or null on a world without them. */
const actSums = (live) => live?.api?.routes?.['edge:act']?.parts?.sums ?? null;
const logSize = (file) => { try { return statSync(file).size; } catch { return 0; } };
/** #2508: the first `[menu-stats]` line (menu-stats.ts, every 10 s with EDGE_MENU_STATS=1) the world logged after byte
 *  `from` of its log, or null. Both ends of the window are taken this way, so each starts up to 10 s after its moment. */
export function menuStatsAfter(file, from) {
  let text = ''; try { text = readFileSync(file).subarray(from).toString('utf8'); } catch { return null; }
  const i = text.indexOf('[menu-stats] '), j = text.indexOf('\n', i); if (i < 0 || j < 0) return null;
  try { return JSON.parse(text.slice(i + 13, j)); } catch { return null; }
}
async function menuStatsAfterWait(file, from) { for (let k = 0; k < 24; k++) { const m = menuStatsAfter(file, from); if (m) return m; await sleep(500); } return null; }
/** Numeric fields of `b` less `a`'s, one level of nesting deep (the menu counters' blocks). */
function minus(b, a) {
  const out = {};
  for (const [k, v] of Object.entries(b ?? {})) out[k] = typeof v === 'number' ? Math.round(10 * (v - (a?.[k] ?? 0))) / 10 : v && typeof v === 'object' ? minus(v, a?.[k]) : v;
  return out;
}
/** #2508: the act meter of one arm, over its load window: per act, the means of the world's own parts (live.json sums) and
 *  of admission's charge; with a profile, each act's clock ms by part, the planner's sync and audit, and long holds; with
 *  the menu counters, their change and builds per act. */
async function meterOf({ sums0, sums1, menu0, menu1, profDir, serverRoot }) {
  const d = sums1 ? minus(sums1, sums0) : null, acts = d?.n ?? 0, r1 = (x) => Math.round(10 * x) / 10;
  const meter = { acts, parts: d && acts ? Object.fromEntries(['handler', 'bind', 'check', 'route', 'wait', 'commit'].map((k) => [k, r1(d[k] / acts)])) : null,
    charged: d?.chargedN ? { acts: d.chargedN, msPerAct: r1(d.chargedMs / d.chargedN) } : null };
  if (profDir) {
    const pf = join(profDir, 'world.cpuprofile');
    for (let k = 0; k < 240 && !existsSync(pf); k++) await sleep(500); await sleep(1000);
    try { const b = bucketProfile(readProfile(pf), serverRoot); meter.profile = { ...b, perAct: perAct(b, acts) }; }
    catch (e) { meter.profile = { error: String(e?.message ?? e).slice(0, 200) }; }
    rmSync(pf, { force: true });   // tens of MB; the buckets above are what the report keeps
  }
  if (menu1) {
    const m = minus(menu1, menu0); delete m.missBySoul;
    meter.menu = { ...m, buildsPerAct: acts ? r1(100 * ((m.one?.built ?? 0) + (m.one?.exact ?? 0)) / acts) / 100 : null };
  }
  return meter;
}

/** #2458: POST the loopback fault endpoint: the next tick's engine step throws. */
async function injectThrow(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/__sim/fault?kind=throw`, { method: 'POST' }); log(`fault-inject throw: ${r.status}`); } catch (e) { log(`fault-inject throw failed: ${String(e).slice(0, 120)}`); }
}
/** #2458: the world log's recovery hold lines (world.ts recoverFault) and watchdog kills. */
export function recoveryLines(file) {
  let text = ''; try { text = readFileSync(file, 'utf8'); } catch { /* no log */ }
  const recoveries = [...text.matchAll(/\[world\] recovery hold (\d+) ms at tick (\d+): (\d+) replays \(([^)]*) ticks\)[^;\n]*(?:; since the last snapshot (\d+) ticks, (\d+) ms of wall, (\d+) ms of steps \(its cost (\d+) ms\))?/g)].map((m) => ({ holdMs: Number(m[1]), tick: Number(m[2]), replays: Number(m[3]), replayTicks: m[4] === 'none' ? [] : m[4].split(', ').map(Number), ...(m[5] ? { sinceSnapshot: { ticks: Number(m[5]), wallMs: Number(m[6]), stepMs: Number(m[7]), snapshotCostMs: Number(m[8]) } } : {}) }));
  return { recoveries, kills: [...text.matchAll(/watchdog: (world\.killed\.[a-z]+)/g)].map((m) => m[1]) };
}
/** #2508: an arm's act meter as report lines. */
export function renderMeter(m) {
  const L = ['', `### The act meter (#2508): ${m.acts} acts answered in the load window`];
  if (m.parts) L.push('', `The world's own parts, mean ms per act (live.json sums): handler ${m.parts.handler} = bind ${m.parts.bind} + check ${m.parts.check} (of it the check's own feasibility search, route ${m.parts.route}) + rest ${Math.round(10 * (m.parts.handler - m.parts.bind - m.parts.check)) / 10}; wait ${m.parts.wait}; commit ${m.parts.commit}.${m.charged ? ` Admission charged ${m.charged.msPerAct} ms per act (${m.charged.acts} acts).` : ''}`);
  const p = m.profile;
  if (p?.error) L.push('', `Profile: ${p.error}`);
  else if (p) {
    const q = p.perAct, h = q.handlerSide, c = m.charged?.msPerAct;
    L.push('', `Clock-thread profile (V8 sampling every 1 ms; the sampling itself costs some time, so read shares, not absolutes): ${p.totalMs} ms profiled, ${Math.round(100 * q.busyShare)} % busy. Each sample is in one group: the planner's sync and audit stay nav.* even inside an act, and the strict gate's work other than binding is act.check (the world's own parts count the whole gate as bind).`, '',
      '| part | clock ms per act |', '|---|---|');
    for (const k of ACT_GROUPS) L.push(`| ${k} | ${q[k] ?? ''} |`);
    L.push(`| act.route(tick), all kinds | ${q['act.route(tick)'] ?? ''} |`, '',
      `Handler-side parts (bind + check + rest) sum to ${h} ms per act${c ? `; admission charged ${c} ms per act (${c ? Math.round(100 * (h - c) / c) : ''} %)` : ''}. The planner: nav.sync ${q.navSyncMsPerSec} ms and nav.audit ${q.navAuditMsPerSec} ms per second of clock.`,
      '', `Long holds (busy runs of ${p.holds.overMs} ms or more): ${p.holds.n}, ${p.holds.ms} ms in all; by source: ${Object.entries(p.holds.bySource).map(([g, e]) => `${g} ${e.n} (${e.ms} ms, longest ${e.maxMs})`).join(', ') || 'none'}.`,
      '', `Every group, ms over the window: ${Object.entries(p.groups).slice(0, 24).map(([g, ms]) => `${g} ${ms}`).join(', ')}.`);
  }
  if (m.menu) L.push('', `Menu counters over the load window (EDGE_MENU_STATS): builds per act ${m.menu.buildsPerAct} (one.built + exact-walk projections); one ${JSON.stringify(m.menu.one)}; cap ${JSON.stringify(m.menu.cap)}; words ${JSON.stringify(m.menu.words)}; clears ${JSON.stringify(m.menu.capClear)}.`);
  return L;
}
export function renderLoad(result) {
  const L = ['# Soul Client eval: load', '', 'Server time per call from `Server-Timing`. #1750 levels at p99.9: bookkeeping 50 ms, reads 100 ms, an act\'s acknowledgment 150 ms. Long polls have no level.'];
  for (const a of result.arms) {
    L.push('', `## ${a.souls} Souls, repeat ${a.repeat} (${a.durationSec} s${a.actSec ? `, one act per ${a.actSec} s per Soul` : ', nonstop'})`, '', `${a.calls} calls; ${a.counts.acts} acts (${a.counts.refused} refused); ${a.counts.closed} owner messages acknowledged and closed of ${a.counts.cards} sent. Level held on every route: **${a.held ? 'yes' : 'no'}**. Refusals: ${Object.entries(a.refusals).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`, '',
      '| route | calls | server p50 | p99 | p99.9 | max | level | over |', '|---|---|---|---|---|---|---|---|');
    for (const x of a.routes) L.push(`| \`${x.route}\` | ${x.n} | ${x.serverMs.p50} | ${x.serverMs.p99} | ${x.serverMs.p999} | ${x.serverMs.max} | ${x.longPoll ? 'long poll' : `${x.level} ${x.levelMs} ms`} | ${x.overLevel ?? ''} |`);
    const act = a.server?.act, tw = a.server?.tickWindows ?? [];
    if (act) {
      L.push('', `An act's server time in four parts (the world's own histograms, ${act.n} acts in its last 5 to 10 minutes): queue + handler + wait + commit = the whole. ${act.waitOver3Ticks} acts waited more than three ticks (150 ms).`, '',
        '| part | p50 | p99 |', '|---|---|---|');
      for (const k of ['queue', 'handler', 'wait', 'commit']) L.push(`| ${k} | ${act[k]?.p50 ?? ''} | ${act[k]?.p99 ?? ''} |`);
    }
    if (tw.length) {
      L.push('', 'Ticks per 10-second window: the tick\'s own ms, ticks that started more than 25 ms after they were due, the longest gap between tick starts, and the share of the window at each load level.', '',
        '| window end | ticks | tick p50 | p99 | late | longest gap | green | amber | red | black |', '|---|---|---|---|---|---|---|---|---|---|');
      for (const w of tw) L.push(`| ${new Date(w.at).toISOString().slice(11, 19)} | ${w.ticks} | ${w.tickMs.p50} | ${w.tickMs.p99} | ${w.lateTicks} | ${w.longestGapMs} | ${w.levels.green} | ${w.levels.amber} | ${w.levels.red} | ${w.levels.black} |`);
      const sum = (key) => { const t = {}; for (const w of tw) for (const [k, v] of Object.entries(w[key] ?? {})) t[k] = Math.round(10 * ((t[k] ?? 0) + v)) / 10; return t; };
      const held = sum('amberS'), entered = sum('amberEntries'), list = (t, u = '') => Object.entries(t).map(([k, v]) => `${k} ${v}${u}`).join(', ') || 'none';
      L.push('', `What held amber, over these windows (a second can count under several signals; \`dwell\` = every signal under the band, the 30 s calm running): ${list(held, ' s')}. Entries into amber by cause (\`red\` = the step down from red): ${list(entered)}.`);
    }
    if (a.intendedActs) L.push('', `Acts: ${a.counts.acts} achieved of ${a.intendedActs} intended (${Math.round(100 * a.achievedShare)} %)${a.achievedShare < 0.95 ? ': **under-driven** (under 95 %)' : ''}.`);
    if (a.server?.meter) L.push(...renderMeter(a.server.meter));
    const al = a.actLatency;
    if (al?.server) L.push('', `Act calls (client trace, ${al.server.n}; ${Math.round(100 * a.counts.acts / a.durationSec) / 100} acts/s): server time p50 ${al.server.p50}, p95 ${al.server.p95}, p99 ${al.server.p99}, max ${al.server.max} ms; of it queue p50 ${al.queue?.p50 ?? ''}, p95 ${al.queue?.p95 ?? ''}, p99 ${al.queue?.p99 ?? ''} ms.`);
    if (a.slowActs?.length) {
      if (a.actQueueMs) L.push('', `Act calls' queue (client trace): p50 ${a.actQueueMs.p50}, p95 ${a.actQueueMs.p95}, max ${a.actQueueMs.max} ms over ${a.actQueueMs.n} calls.`);
      L.push('', 'Acts by capability, slowest first: server time less the queue (handler + wait + commit), ms.', '', '| capability | acts | p50 | max | over 250 ms |', '|---|---|---|---|---|');
      for (const x of a.slowActs) L.push(`| ${x.capability} | ${x.n} | ${x.p50} | ${x.max} | ${x.over250} |`);
    }
    if (a.recoveries) L.push('', `Injected engine errors (#2458): ${a.recoveries.length} recoveries, holds ${a.recoveries.map((r) => `${r.holdMs} ms (${r.replayTicks.join('+') || 0} ticks replayed)`).join(', ') || 'none'}; watchdog kills: ${a.kills.join(', ') || 'none'}.`);
  }
  return L.join('\n') + '\n';
}
