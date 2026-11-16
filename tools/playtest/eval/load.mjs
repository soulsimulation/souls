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
// #2509 `--raw-from <k>`: Souls k and above (1-based) are raw-HTTP Souls in this process (no `serve`, no CLI per act): each
// joins from its own documentation-range address (x-forwarded-for, so one address's pairing limit does not pace setup), 8
// at a time; reads the catalog and live picture once; acts by catalog id with an idempotency key and the client's retry
// rules (../../bench/capacity/meetup/client-soul.mjs), reading each act's receipt once. Its acts are the paced loop's,
// drawn from the same seeded draws a real Soul in its place would make; the differences are in rawDifferences below. The
// report gives the driver's processor share, and acts achieved against intended and act wait per tenth of agents by
// activity, busiest first. `--shape uniform` is the paced loop.
// #2556 `--shape <everyday|event|...>`: the raw Souls follow the shapes module's seeded schedule (one per repeat): who is
// present when (an arrival after the start re-reads the catalog and live picture once), each agent's own act times, the
// act kinds (speech by the say route, gestures and the rest by catalog id) and the walks gathered near one named place.
// One call at a time per Soul, in order: an act due while the last is still out starts when it is answered, and acts
// not started by the end of the window are not achieved. Real Souls keep the paced loop. The report prints what the
// schedule offered and tenths of agents by their intended acts.
// #2533: `--scan-census` runs the world with SIM_L4_STATS=1 and SIM_L4_SCAN_SITES=1 and reads the planner's static scans
// from its `[l4]` lines (engine-bridge.ts, one a minute): scans and trusted syncs a second, ms a scan, and the scan sites
// (service.ts navChanged: the first frame outside the spatial service, a minute's top 8). With `--profile` the report adds
// the profile's nav.sync by who asked (prof-buckets.mjs navSyncBy). Only lines whose whole minute lies inside the load
// window count, so a census wants a load of at least 120 s. Nothing in the world changes but those two debug switches.
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
import { clientCall, clientHeaders, actBody, startPicture, catalogIds, SAY_PATH, sayBody } from '../../bench/capacity/meetup/client-soul.mjs';
import { SHAPES, schedule, describe } from '../../bench/capacity/profiles/shapes.mjs';
import { randomBytes } from 'node:crypto';

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

/** #2509: raw Soul i's address: the documentation ranges (192.0.2/24, 198.51.100/24, 203.0.113/24), one per Soul. */
export function docAddress(i) {
  if (!(i >= 0 && i < 762)) throw new Error('raw Souls: at most 762 documentation addresses');
  const [net, k] = i < 254 ? ['192.0.2', i] : i < 508 ? ['198.51.100', i - 254] : ['203.0.113', i - 508];
  return `${net}.${k + 1}`;
}
/** What a raw Soul does unlike the real client, for the report. */
export const rawDifferences = 'Raw Souls: no `serve` daemon or long-polls, no owner messages (cards go to real Souls only), no `look`/`find`/`pending`; a word is resolved from the catalog once (its places, spots and seats by name), not from the nearest rows the CLI\'s `find` ranks; each act reads its receipt once.';
/** #2509: the catalog's ids for each paced word (as `find <word>` would offer them, without the CLI's nearest-first order). */
export function wordIds(cat) {
  const places = cat?.places ?? [], acts = (cat?.acts ?? []).filter((a) => !a.with && !a.needs), things = cat?.things ?? [];
  const named = (w) => { const re = new RegExp(w.replace(/[^a-z ]/g, '').split(' ').join('.?'), 'i'); return [...places.filter((p) => re.test(`${p.name ?? ''} ${p.ref ?? p.id}`)).map((p) => `walk:${p.ref ?? p.id}`), ...acts.filter((a) => re.test(`${a.label ?? ''} ${a.id}`)).map((a) => a.id)]; };
  const verb = (v) => acts.filter((a) => a.verb === v).map((a) => a.id);
  return { bandstand: named('bandstand'), windmill: named('windmill'), 'fire circle': named('fire circle'), lake: named('lake'), library: named('library'), pond: named('pond'), garden: [...verb('garden'), ...named('garden')],
    'sit on the floor': ['sit-ground:here'], eat: verb('eat'), read: verb('read'), bench: [...verb('sit'), ...things.filter((t) => t.seat).map((t) => `sit:${t.id}`)], music: [...verb('play-music'), ...verb('listen')] };
}
const timingOf = (h) => Object.fromEntries([...String(h ?? '').matchAll(/([a-z-]+);dur=([\d.]+)/g)].map((m) => [m[1], Number(m[2])]));
/** #2509: a raw Soul joins: create (waiting out a pending arrival), pair, token. Dev identity, its own address. */
export async function rawJoin(base, i, { call = clientCall } = {}) {
  const soul = { i, address: docAddress(i), identity: 'agent-' + randomBytes(12).toString('hex') };
  const dev = { ...clientHeaders(soul), authorization: `Bearer dev:${soul.identity}` }, name = `Load ${i}`;
  const c = await call(`${base}/v1/souls`, { method: 'POST', headers: dev, body: { name } });
  let id = c.data?.soul?.id ?? null;
  if (!id && c.status === 503 && c.data?.lifecycle?.requestId) {
    for (const until = Date.now() + 180_000; !id && Date.now() < until;) {
      await sleep(2000);
      const r = await call(`${base}/v1/lifecycle/${c.data.lifecycle.requestId}`, { headers: dev }), lc = r.data?.lifecycle;
      if (lc?.state === 'admitted' && lc.ready) id = lc.soulId ?? c.data.lifecycle.soulId;
      else if (lc?.state === 'refused' || r.status === 404) break;
    }
  }
  if (!id) throw new Error(`raw Soul ${i}: create ${c.status} ${c.code ?? ''}`);
  const code = (await call(`${base}/v1/souls/${id}/pair`, { method: 'POST', headers: dev, body: {} })).data?.code;
  const t = code ? await call(`${base}/v1/agent/pair`, { method: 'POST', headers: clientHeaders(soul, { auth: false }), body: { code, agent: 'eval-load raw' } }) : null;
  if (!t?.data?.token) throw new Error(`raw Soul ${i}: pair ${t?.status ?? 'no code'} ${t?.code ?? ''}`);
  return { ...soul, soulId: id, token: t.data.token };
}
/** #2509: the paced loop for a raw Soul, with the same draws as pacedLoop (first offset, gap, word, row) and no owner
 *  messages. Each act: POST /v1/edge/act by catalog id (keyed), then its receipt once. Trace records as the client's. */
export async function rawPacedLoop({ base, soul, ids, until, r, counts, acts = [], http = [], actSec, call = clientCall }) {
  let next = Date.now() + r() * actSec * 1000;
  for (let n = 0; ; n++) {
    await sleep(Math.max(0, next - Date.now()));
    if (Date.now() >= until) break;
    next = Math.max(Date.now(), next + actSec * 1000 * (0.5 + r()));
    const word = PACED_WORDS[Math.floor(r() * PACED_WORDS.length)], rows = ids[word] ?? [];
    if (!rows.length) continue;
    await rawAct({ base, soul, id: rows[Math.floor(r() * Math.min(3, rows.length))], key: `raw-${soul.i}-${n}-${Date.now()}`, counts, acts, http, call });
  }
}
/** One raw act: POST /v1/edge/act by catalog id (keyed), then its receipt once. Trace records as the client's. */
async function rawAct({ base, soul, id, key, counts, acts, http, call }) {
  const t0 = Date.now(), a = await call(`${base}/v1/edge/act`, { method: 'POST', headers: clientHeaders(soul, { key }), body: actBody(id, key) });
  counts.cmds++; counts.acts++; if (a.data?.accepted === false) counts.refused++;
  const tm = timingOf(a.timing);
  http.push({ v: 'soul-trace/1', kind: 'http', at: t0, method: 'POST', route: '/v1/edge/act', status: a.status, durationMs: Date.now() - t0, serverMs: tm.world, queuedMs: tm.queue, facts: { accepted: a.data?.accepted, code: a.data?.code ?? a.code } });
  acts.push({ cap: capabilityOf({ act: id }), t0, t1: Date.now() });
  const rid = a.data?.receipt?.id;
  if (rid) { const t1 = Date.now(), g = await call(`${base}/v1/edge/receipts/${rid}`, { headers: clientHeaders(soul) }); counts.cmds++; http.push({ v: 'soul-trace/1', kind: 'http', at: t1, method: 'GET', route: `/v1/edge/receipts/${rid}`, status: g.status, durationMs: Date.now() - t1, serverMs: timingOf(g.timing).world, queuedMs: timingOf(g.timing).queue }); }
}
/** #2556: a GET with its trace record (an arrival's catalog and live picture). */
async function rawRead({ base, soul, route, counts, http, call }) {
  const t0 = Date.now(), g = await call(`${base}${route}`, { headers: clientHeaders(soul, { auth: false }) }); counts.cmds++;
  http.push({ v: 'soul-trace/1', kind: 'http', at: t0, method: 'GET', route, status: g.status, durationMs: Date.now() - t0, serverMs: timingOf(g.timing).world, queuedMs: timingOf(g.timing).queue });
}
/** #2556: a shape's ids by act kind from the catalog (client-soul.mjs catalogIds), with `gathered`: the walk to one named
 *  place (the bandstand, else the first walk in id order) and to every place whose outline's centre is within `radiusM`
 *  of that place's. `named` is that place's walk. */
export function shapeIds(cat, radiusM = 30) {
  const ids = catalogIds(cat), places = cat?.places ?? [], walkOf = (p) => `walk:${p.ref ?? p.id}`;
  const centre = (p) => (p?.outline?.length ? [p.outline.reduce((t, q) => t + q[0], 0) / p.outline.length, p.outline.reduce((t, q) => t + q[1], 0) / p.outline.length] : null);
  const named = places.find((p) => /bandstand/i.test(`${p.name ?? ''} ${p.ref ?? p.id}`) && ids.walk.includes(walkOf(p))) ?? places.find((p) => walkOf(p) === [...ids.walk].sort()[0]);
  const c = centre(named), near = c ? places.filter((p) => p !== named && ids.walk.includes(walkOf(p)) && centre(p) && Math.hypot(centre(p)[0] - c[0], centre(p)[1] - c[1]) <= radiusM).map(walkOf) : [];
  return { ...ids, named: named ? walkOf(named) : null, gathered: named ? [walkOf(named), ...near] : [] };
}
/** #2556: a raw Soul driven by its agent of a shape's schedule ({stays, acts}; times in s from `t0`, local wall ms). One call
 *  at a time, in order; an arrival after the start reads the catalog and live picture once; each act by its kind: speech
 *  to the say route, a walk spread or gathered, the rest by an id of that kind (`pick` chooses). A kind the world does
 *  not offer is sent as a spread walk and counted in `fallback`. Nothing starts at or after `until`. */
export async function rawShapedLoop({ base, soul, ids, agent, t0, until, counts, acts = [], http = [], fallback = {}, call = clientCall }) {
  const events = [...agent.stays.filter(([a]) => a > 0).map(([at]) => ({ at, arrive: true })), ...agent.acts].sort((x, y) => x.at - y.at || (y.arrive ? 1 : 0) - (x.arrive ? 1 : 0));
  for (const [n, x] of events.entries()) {
    if (t0 + x.at * 1000 >= until) break;
    await sleep(Math.max(0, t0 + x.at * 1000 - Date.now()));
    if (Date.now() >= until) break;
    if (x.arrive) { for (const route of ['/v1/edge/catalog', '/v1/edge/live']) await rawRead({ base, soul, route, counts, http, call }); continue; }
    const key = `raw-${soul.i}-${n}-${Date.now()}`;
    if (x.kind === 'say') {
      const t1 = Date.now(), a = await call(`${base}${SAY_PATH}`, { method: 'POST', headers: clientHeaders(soul, { key }), body: sayBody('hello from the load shapes') }), tm = timingOf(a.timing);
      counts.cmds++; counts.acts++; counts.says = (counts.says ?? 0) + 1;
      http.push({ v: 'soul-trace/1', kind: 'http', at: t1, method: 'POST', route: SAY_PATH, status: a.status, durationMs: Date.now() - t1, serverMs: tm.world, queuedMs: tm.queue, facts: { code: a.data?.code ?? a.code } });
      continue;
    }
    let pool = x.kind === 'walk' ? (x.place === 'gathered' ? ids.gathered : ids.walk) : ids[x.kind];
    if (!pool?.length) { fallback[x.kind] = (fallback[x.kind] ?? 0) + 1; pool = ids.walk.length ? ids.walk : ['sit-ground:here']; }
    await rawAct({ base, soul, id: pool[x.pick % pool.length], key, counts, acts, http, call });
  }
}
/** #2509: per tenth of agents by activity (intended acts, then achieved; busiest first): agents, intended and achieved
 *  acts, act queue p50 and the slow-down refusals (an active agent held back by its own budget). */
export function byTenth(agents) {
  const s = [...agents].sort((a, b) => b.intended - a.intended || b.achieved - a.achieved), out = [];
  for (let t = 0; t < Math.min(10, s.length); t++) {
    const g = s.slice(Math.round(t * s.length / Math.min(10, s.length)), Math.round((t + 1) * s.length / Math.min(10, s.length))), waits = g.flatMap((x) => x.waits).sort((a, b) => a - b), intended = g.reduce((t, x) => t + x.intended, 0), achieved = g.reduce((t, x) => t + x.achieved, 0);
    out.push({ tenth: out.length + 1, agents: g.length, raw: g.filter((x) => x.raw).length, intended, achieved, share: intended ? Math.round(1000 * achieved / intended) / 1000 : null, waitP50: waits.length ? waits[Math.floor(0.5 * (waits.length - 1))] : null, slowDown: g.reduce((t, x) => t + x.slowDown, 0) });
  }
  return out;
}
/** #2509: act queue p50 of the real and of the raw agents (ms), for comparing the two drivers on one world. */
export function waitByDriver(agents) {
  const p50 = (xs) => { const v = xs.flatMap((x) => x.waits).sort((a, b) => a - b); return v.length ? { n: v.length, p50: v[Math.floor(0.5 * (v.length - 1))] } : null; };
  return { real: p50(agents.filter((x) => !x.raw)), raw: p50(agents.filter((x) => x.raw)) };
}
/** One agent's numbers from its act calls (trace records) for byTenth. */
const agentOf = (http, intended, raw) => { const calls = http.filter((x) => x.method === 'POST' && /\/v1\/edge\/(?:act|say)(?:\?|$)/.test(x.route ?? '')); return { intended, achieved: calls.length, raw, waits: calls.map((x) => x.queuedMs).filter(Number.isFinite), slowDown: calls.filter((x) => (x.facts?.code ?? '') === 'soul.slow-down').length }; };
/** --shape: `uniform` (or none) is the paced loop (null); any other shape of the shapes module is its name. */
export function shapeOf(name) {
  if (!name || name === 'uniform') return null;
  if (!SHAPES.agents[name]) throw new Error(`--shape ${name}: known shapes ${Object.keys(SHAPES.agents).join(', ')}`);
  return name;
}
/** #2556: the raw Souls' schedule for one repeat: `rawN` agents over `seconds`, seeded by the repeat. */
export const shapePlan = (shape, rawN, seconds, rep) => schedule(shape, rawN, seconds, `eval-load|${rep}`);

export async function runLoad(o) {
  const sizes = String(o.souls ?? '12,24').split(',').map(Number).filter((n) => n > 0);
  const first = Number(o['first-repeat'] ?? 1), repeats = Number(o.repeats ?? 1), durSec = Number(o['duration-sec'] ?? 120), cardSec = Number(o['card-sec'] ?? 30), actSec = o['act-sec'] != null ? Number(o['act-sec']) : null, port = Number(o.port ?? 18780);
  const serverRoot = resolve(o['server-root'] ?? REPO), faultSec = o['fault-every-sec'] != null ? Number(o['fault-every-sec']) : null;
  if (faultSec) process.env.SIM_FAULT_INJECT = '1';
  if (o['hang-kill-sec'] != null) process.env.SIM_HANG_KILL_MS = String(1000 * Number(o['hang-kill-sec']));
  // #2556: a shape drives raw Souls, so with one and no --raw-from every Soul is raw
  const shape = shapeOf(o.shape), radiusM = shape ? (SHAPES.agents[shape].place?.radiusM?.value ?? 30) : null;
  const profile = !!o.profile, menuStats = !!o['menu-stats'], census = !!o['scan-census'], rawFrom = o['raw-from'] != null ? Number(o['raw-from']) : shape ? 1 : Infinity;
  if (!(rawFrom >= 1)) throw new Error('--raw-from <first raw Soul, 1-based>');
  if (shape && sizes.some((n) => n < rawFrom)) throw new Error(`--shape ${shape} drives raw Souls: every --souls size must reach --raw-from`);
  const out = resolve(o.out ?? join(REPO, '.local/soul-eval', `load-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  mkdirSync(out, { recursive: true });
  const arms = [];
  for (let rep = first; rep < first + repeats; rep++) for (const n of sizes) {
    const dir = join(out, `n${n}-r${rep}`); mkdirSync(dir, { recursive: true });
    // a world that exits on its own says how (code, signal) and its resident memory every 30 s, in this log (Linux /proc)
    let stopping = false;
    // #2508: the profiler hook and the menu counters reach the world through its environment, only while it starts
    const profDir = join(dir, 'server', 'prof'), envWas = { NODE_OPTIONS: process.env.NODE_OPTIONS, SIM_PROF_DIR: process.env.SIM_PROF_DIR, EDGE_MENU_STATS: process.env.EDGE_MENU_STATS, SIM_L4_STATS: process.env.SIM_L4_STATS, SIM_L4_SCAN_SITES: process.env.SIM_L4_SCAN_SITES };
    if (profile) { mkdirSync(profDir, { recursive: true }); process.env.NODE_OPTIONS = `${envWas.NODE_OPTIONS ? envWas.NODE_OPTIONS + ' ' : ''}--import=${PROF_HOOK}`; process.env.SIM_PROF_DIR = profDir; }
    if (menuStats) process.env.EDGE_MENU_STATS = '1';
    if (census) { process.env.SIM_L4_STATS = '1'; process.env.SIM_L4_SCAN_SITES = '1'; }
    let w;
    try { w = await startWorld({ serverRoot, slug: 'eden-load', port, genesis: 'worlds/templates/eden-2026.json', dataDir: join(dir, 'server', 'data'), log: join(dir, 'server', 'world.log'),
      onSpawn: (c) => c.on('exit', (code, signal) => { if (!stopping) log(`n${n} r${rep}: the world exited on its own (code ${code}, signal ${signal}); see n${n}-r${rep}/server/world.log`); }) }); }
    finally { for (const [k, v] of Object.entries(envWas)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
    const rss = setInterval(() => { try { const kb = /^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${w.pid}/status`, 'utf8'))?.[1]; if (kb) log(`n${n} r${rep}: world rss ${Math.round(kb / 1024)} MB`); } catch { /* not Linux, or gone */ } }, 30000);
    const souls = [];
    try {
      // setup is paced at 6 Souls per 30 s: all Souls share one address, and a world pairs at most 20 in any 60 s from one
      // address (POST /v1/agent/pair). Setup is not measured.
      const real = Math.min(n, rawFrom - 1), setup0 = Date.now();
      for (let i = 0; i < real; i += 6) { const b0 = Date.now(); await Promise.all(Array.from({ length: Math.min(6, real - i) }, async (_, j) => {
        const k = i + j, folder = join(dir, 'souls', `s${k}`); mkdirSync(folder, { recursive: true });
        const identity = newIdentity(); writeFileSync(join(folder, '.eden-agent.json'), JSON.stringify({ identity }) + '\n', { mode: 0o600 });
        const fake = { folder, base: w.base, info: {}, save() {} };
        const s = await prepareFolder(fake, { name: `Load ${k}` });
        souls[k] = { folder, identity, soulId: s.soulId, acts: [] };
      })); if (i + 6 < real) await sleep(Math.max(0, b0 + 30000 - Date.now())); }
      // #2509: raw Souls, 8 at a time, each from its own address; one catalog and live picture each
      for (let i = real; i < n; i += 8) await Promise.all(Array.from({ length: Math.min(8, n - i) }, async (_, j) => {
        // a world still laying out its places answers the catalog `world.starting`: ask again until it has one
        const s = await rawJoin(w.base, i + j); let pic = await startPicture(w.base, s);
        for (const until = Date.now() + 120_000; !pic.catalog && Date.now() < until;) { await sleep(2000); pic = await startPicture(w.base, s); }
        if (!pic.catalog) throw new Error(`raw Soul ${i + j}: no catalog (${pic.catalogStatus})`);
        souls[i + j] = { ...s, raw: true, ids: wordIds(pic.catalog), ...(shape ? { shapeIds: shapeIds(pic.catalog, radiusM) } : {}), acts: [], http: [] };
      }));
      const plan = shape ? shapePlan(shape, n - real, durSec, rep) : null, fallback = {};
      if (plan) log(`n${n} r${rep}: ${describe(plan.summary, `shape ${shape}`)}`);
      const setupS = Math.round((Date.now() - setup0) / 1000);
      log(`n${n} r${rep}: ${souls.length} Souls serving (${n - real} raw) after ${setupS} s of setup; load for ${durSec} s`);
      const t0 = Date.now(), until = t0 + durSec * 1000, counts = { cmds: 0, acts: 0, refused: 0, closed: 0, cards: 0, cardErrors: 0 }, cpu0 = driverCpu();
      // #1944 A3: each tick window that ended during the load (live.json is rewritten every 2 s; a window lasts 10 s)
      const liveFile = join(dir, 'server', 'data', 'live.json'), tickWindows = new Map();
      const worldLog = join(dir, 'server', 'world.log'), sums0 = actSums(readLive(liveFile)), logAtStart = menuStats ? logSize(worldLog) : 0;
      if (profile) writeFileSync(join(profDir, 'prof.start'), '');
      // #2533: an [l4] line logged after this offset (a minute into the load) covers a minute inside the load window
      let censusFrom = null; const censusTimer = census ? setTimeout(() => { censusFrom = logSize(worldLog); }, 60000) : null;
      const watch = setInterval(() => { const w = readLive(liveFile)?.api?.ticks; if (w?.at > t0 && w.at <= until + 2000) tickWindows.set(w.at, w); }, 4000);
      const faults = faultSec ? (async () => { for (let at = t0; at < until; at += faultSec * 1000) { await sleep(Math.max(0, at - Date.now())); await injectThrow(port); } })() : null;
      const cards = (async () => { while (Date.now() + cardSec * 1000 < until) { await sleep(cardSec * 1000); await Promise.all(souls.filter((s) => !s.raw).map((s) => sendCard({ base: w.base, soulId: s.soulId, identity: s.identity, text: 'Look around.' }).then(() => counts.cards++, () => counts.cardErrors++))); } })();
      await Promise.all(souls.map((s, k) => (s.raw && plan ? rawShapedLoop({ base: w.base, soul: s, ids: s.shapeIds, agent: plan.agents[k - real], t0, until, counts, acts: s.acts, http: s.http, fallback }) : s.raw ? rawPacedLoop({ base: w.base, soul: s, ids: s.ids, until, r: rng(1000 * rep + k), counts, acts: s.acts, http: s.http, actSec: actSec ?? 10 }) : actSec ? pacedLoop({ folder: s.folder, until, r: rng(1000 * rep + k), counts, acts: s.acts, actSec }) : soulLoop({ folder: s.folder, until, r: rng(1000 * rep + k), counts, acts: s.acts }))));
      await cards; await faults;
      const driver = driverCpuSince(cpu0);   // #2509: the driver's processor share over the load
      if (profile) writeFileSync(join(profDir, 'prof.stop'), '');   // #2508: the profile covers the load, not the settle after it
      const logAtEnd = menuStats ? logSize(worldLog) : 0, censusTo = census ? logSize(worldLog) : 0; clearTimeout(censusTimer);
      await sleep(2500); clearInterval(watch);   // the watchdog's next live.json has the last acts
      const live = readLive(liveFile), server = { act: actPartsOfLive(live), tickWindows: [...tickWindows.values()].sort((x, y) => x.at - y.at) };
      if (profile || menuStats) server.meter = await meterOf({ sums0, sums1: actSums(live), menu0: menuStats ? menuStatsAfter(worldLog, logAtStart) : null, menu1: menuStats ? await menuStatsAfterWait(worldLog, logAtEnd) : null, profDir: profile ? profDir : null, serverRoot });
      if (census) server.scanCensus = censusFrom == null ? { error: 'the load was shorter than a minute' } : scanCensusOf(worldLog, censusFrom, censusTo);
      const http = [], pairs = [];
      const agents = [];
      for (const [k, s] of souls.entries()) {
        if (s.raw) { const own = httpSince(s.http, t0); http.push(...own); pairs.push({ acts: s.acts, http: own }); agents.push(agentOf(own, plan ? plan.agents[k - real].acts.length : actSec ? durSec / actSec : 0, true)); continue; }
        await cliJson(s.folder, ['serve', '--stop']);
        const f = join(runtimeDir(s.folder, s.soulId), '.eden-report.jsonl');
        if (existsSync(f)) { mkdirSync(join(dir, 'trace'), { recursive: true }); copyFileSync(f, join(dir, 'trace', `s${k}.jsonl`)); const own = httpSince(readJsonl(f), t0); http.push(...own); pairs.push({ acts: s.acts, http: own }); agents.push(agentOf(own, actSec ? durSec / actSec : 0, false)); }
      }
      const routes = routeStats(http);
      const intended = plan ? Math.round(plan.summary.acts + (actSec ? real * durSec / actSec : 0)) : actSec ? Math.round(n * durSec / actSec) : null;
      const shaped = plan ? { shape: { name: shape, seed: plan.seed, raw: n - real, offered: describe(plan.summary), summary: { ...plan.summary, perS: undefined }, named: souls[real]?.shapeIds?.named ?? null, gathered: souls[real]?.shapeIds?.gathered?.length ?? 0, fallback } } : {};
      arms.push({ souls: n, repeat: rep, durationSec: durSec, ...shaped, counts, driver, ...(n > real ? { raw: n - real, setupS, rawDifferences, tenths: byTenth(agents), waitByDriver: waitByDriver(agents) } : { setupS }), intendedActs: intended, achievedShare: intended ? Math.round(1000 * counts.acts / intended) / 1000 : null, calls: http.length, routes, refusals: refusalCounts(http), server, slowActs: slowActs(pairs), actQueueMs: actQueue(pairs), actLatency: actLatency(pairs), actSec, held: routes.every((x) => x.levelMs == null || (x.serverMs.p999 ?? 0) <= x.levelMs), ...(faultSec ? recoveryLines(join(dir, 'server', 'world.log')) : {}) });
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

/** #2509: the driver's processor use: this process's own (user + system, its reaped children included), and on Linux every
 *  process on this process's CPUs (/proc/stat), which under timed-run are the load generator's own cores (the world is
 *  pinned to others): the `serve` daemons and `eden.mjs` calls too. */
function driverCpu() {
  const own = process.cpuUsage(), self = (() => { try { const f = readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' '); return (Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14])) * 10; } catch { return null; } })();   // utime, stime, cutime, cstime (10 ms ticks)
  let cpus = null, stat = null;
  try { const m = /^Cpus_allowed_list:\s*(\S+)/m.exec(readFileSync('/proc/self/status', 'utf8')); cpus = m ? m[1].split(',').flatMap((r) => { const [a, b = a] = r.split('-').map(Number); return Array.from({ length: b - a + 1 }, (_, k) => a + k); }) : null; stat = readFileSync('/proc/stat', 'utf8'); } catch { /* not Linux */ }
  return { at: Date.now(), own, children: self, cpus, stat };
}
function driverCpuSince(a) {
  const b = driverCpu(), wall = b.at - a.at, r2 = (x) => Math.round(100 * x) / 100;
  const per = (text) => Object.fromEntries(text.split('\n').filter((l) => /^cpu\d+ /.test(l)).map((l) => { const [k, ...v] = l.trim().split(/\s+/), n = v.map(Number), idle = n[3] + (n[4] ?? 0), total = n.slice(0, 8).reduce((x, y) => x + y, 0); return [Number(k.slice(3)), [total - idle, total]]; }));
  let cores = null;
  if (a.stat && b.stat && a.cpus) { const x = per(a.stat), y = per(b.stat); cores = r2(a.cpus.reduce((sum, c) => { const d = y[c] && x[c] ? y[c][1] - x[c][1] : 0; return sum + (d > 0 ? (y[c][0] - x[c][0]) / d : 0); }, 0)); }
  const ownMs = (b.own.user - a.own.user + b.own.system - a.own.system) / 1000;
  return { wallS: Math.round(wall / 1000), harnessCores: r2(ownMs / wall), harnessWithChildrenCores: a.children != null && b.children != null ? r2((b.children - a.children) / wall) : null, generatorCpus: a.cpus?.length ?? null, generatorCores: cores };
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
/** #2533: one `[l4]` line's scan sites (`<caller> <file>:<line>=<n>`, space-separated; a caller may hold a space), each
 *  key reduced to file names (an anonymous frame prints its whole URL). */
export function scanSitesOf(part) {
  const xs = String(part ?? '').split(/=(\d+)(?: |$)/), out = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i].trim().replace(/\S*\/([^/\s]+)/g, '$1'), Number(xs[i + 1])]);
  return out;
}
/** #2533: the `[l4]` lines of `file` between byte offsets `from` and `to`: scans, their ms, trusted syncs, the seconds the
 *  lines cover, and the scan sites they list (the first frame outside the spatial service; each line lists its minute's
 *  top 8 and clears, so `listedShare` is the share of the scans they name). */
export function scanCensusOf(file, from, to) {
  let text = ''; try { text = readFileSync(file).subarray(from, to).toString('utf8'); } catch { return { error: 'no world log' }; }
  const lines = text.split('\n').filter((l) => l.includes('[l4] cpu '));
  if (!lines.length) return { error: 'no [l4] line inside the load window' };
  let sec = 0, scans = 0, scanMs = 0, trusted = 0; const sites = new Map();
  for (const l of lines) {
    const w = /over (\d+) s/.exec(l), s = /nav scans (\d+) (\d+) ms trusted (\d+)/.exec(l);
    if (!w || !s) continue;
    sec += Number(w[1]); scans += Number(s[1]); scanMs += Number(s[2]); trusted += Number(s[3]);
    const part = /; scan sites (.*?)(?:; live |$)/.exec(l)?.[1] ?? '';
    for (const [k, n] of scanSitesOf(part)) sites.set(k, (sites.get(k) ?? 0) + n);
  }
  const r1 = (x) => Math.round(10 * x) / 10, per = (x) => (sec ? r1(x / sec) : null), listed = [...sites.values()].reduce((a, b) => a + b, 0);
  return { lines: lines.length, sec, scans, scanMs, trusted, scansPerSec: per(scans), scanMsPerSec: per(scanMs), msPerScan: scans ? Math.round(1000 * scanMs / scans) / 1000 : null, trustedPerSec: per(trusted),
    listedShare: scans ? Math.round(1000 * listed / scans) / 1000 : null,
    sites: [...sites].sort((a, b) => b[1] - a[1]).map(([site, n]) => ({ site, scansPerSec: per(n) })) };
}
/** #2533: an arm's scan census as report lines, with the profile's nav.sync by who asked when the arm has one. */
export function renderCensus(c, navSyncBy, totalMs) {
  const L = ['', '### The planner\'s scans (#2533: the SIM_L4_SCAN_SITES census, from the world\'s [l4] lines)'];
  if (c.error) L.push('', `Census: ${c.error}.`);
  else {
    L.push('', `${c.lines} line(s), ${c.sec} s inside the load window: ${c.scansPerSec} scans a second, ${c.msPerScan} ms a scan (${c.scanMsPerSec} ms a second), ${c.trustedPerSec} trusted syncs a second. The listed sites (the first frame outside the spatial service) name ${Math.round(100 * c.listedShare)} % of the scans.`,
      '', '| caller | scans a second |', '|---|---|');
    for (const x of c.sites) L.push(`| \`${x.site}\` | ${x.scansPerSec} |`);
  }
  if (navSyncBy?.length && totalMs) {
    L.push('', 'The profile\'s nav.sync by who asked (a tick: the runtime frame > the action step or pass it called; outside a tick: the innermost server frame), ms per second of clock:', '', '| asked from | caller | ms a second |', '|---|---|---|');
    for (const x of navSyncBy) L.push(`| \`${x.where}\` | \`${x.caller}\` | ${Math.round(10000 * x.ms / totalMs) / 10} |`);
  }
  return L;
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
    if (a.driver) L.push('', `Driver (#2509): this process ${a.driver.harnessCores} of a core${a.driver.harnessWithChildrenCores != null ? ` (${a.driver.harnessWithChildrenCores} with its finished children)` : ''}${a.driver.generatorCores != null ? `; everything on its ${a.driver.generatorCpus} CPUs (the serve daemons and CLI calls too) ${a.driver.generatorCores} of a core` : ''}, over ${a.driver.wallS} s.`);
    if (a.raw) {
      const wd = a.waitByDriver;
      L.push('', `Raw Souls (#2509): ${a.raw} of ${a.souls}; setup took ${a.setupS} s. ${a.rawDifferences}`);
      if (wd?.real && wd?.raw) L.push('', `Act queue p50: real Souls ${wd.real.p50} ms (${wd.real.n} acts), raw Souls ${wd.raw.p50} ms (${wd.raw.n} acts)${wd.real.p50 > 0 ? `: raw ${Math.round(100 * (wd.raw.p50 - wd.real.p50) / wd.real.p50)} % against real` : ''}.`);
      L.push('', 'Per tenth of agents by activity (busiest first): acts achieved against intended, act queue p50 (ms), and slow-down refusals (an agent held back by its own budget).', '', '| tenth | agents (raw) | intended | achieved | share | queue p50 | slow-down |', '|---|---|---|---|---|---|---|');
      for (const t of a.tenths) L.push(`| ${t.tenth} | ${t.agents} (${t.raw}) | ${Math.round(t.intended)} | ${t.achieved} | ${t.share == null ? '' : Math.round(100 * t.share) + ' %'} | ${t.waitP50 ?? ''} | ${t.slowDown} |`);
    }
    if (a.shape) L.push('', `Shape **${a.shape.name}** (#2556; seed \`${a.shape.seed}\`) drives the ${a.shape.raw} raw Souls; real Souls keep the paced loop. Offered: ${a.shape.offered}. Gathered walks go to ${a.shape.named ?? 'no place'} and ${Math.max(0, a.shape.gathered - 1)} places near it; ${a.counts.says ?? 0} of the acts were speech. Kinds the world does not offer, sent as walks: ${Object.entries(a.shape.fallback).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`);
    if (a.intendedActs) L.push('', `Acts: ${a.counts.acts} achieved of ${a.intendedActs} intended (${Math.round(100 * a.achievedShare)} %)${a.achievedShare < 0.95 ? ': **under-driven** (under 95 %)' : ''}.`);
    if (a.server?.meter) L.push(...renderMeter(a.server.meter));
    if (a.server?.scanCensus) L.push(...renderCensus(a.server.scanCensus, a.server.meter?.profile?.navSyncBy, a.server.meter?.profile?.totalMs));
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
