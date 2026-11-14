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
import { join, resolve, relative } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { startWorld, stopWorld } from '../arena/provision.mjs';
import { readJsonl, writeJson } from '../lib/jsonl.mjs';
import { newIdentity, rng } from '../lib/hash.mjs';
import { sleep } from '../lib/clock.mjs';
import { run } from '../lib/proc.mjs';
import { sendCard } from '../arena/owner.mjs';
import { prepareFolder, runtimeDir } from './episode.mjs';
import { httpSince, routeStats, refusalCounts } from './measure.mjs';
import { summarizeProfile } from './prof-summary.mjs';
// #2354 MEASUREMENT BRANCH ONLY (never merged): a CPU profile of the world over the first repeat of the largest arm.
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
  const first = Number(o['first-repeat'] ?? 1), repeats = Number(o.repeats ?? 1), durSec = Number(o['duration-sec'] ?? 120), cardSec = Number(o['card-sec'] ?? 30), port = Number(o.port ?? 18780);
  const serverRoot = resolve(o['server-root'] ?? REPO);
  const out = resolve(o.out ?? join(REPO, '.local/soul-eval', `load-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  mkdirSync(out, { recursive: true });
  const arms = [];
  for (let rep = first; rep < first + repeats; rep++) for (const n of sizes) {
    const dir = join(out, `n${n}-r${rep}`); mkdirSync(dir, { recursive: true });
    const prof = rep === first && n === Math.max(...sizes), profDir = join(dir, 'server', 'prof'), prevOpts = process.env.NODE_OPTIONS;
    if (prof) { mkdirSync(profDir, { recursive: true }); process.env.NODE_OPTIONS = `${prevOpts ? prevOpts + ' ' : ''}--import=${PROF_HOOK}`; process.env.SIM_PROF_DIR = profDir; }
    let w; try { w = await startWorld({ serverRoot, slug: 'eden-load', port, genesis: 'worlds/templates/eden-2026.json', dataDir: join(dir, 'server', 'data'), log: join(dir, 'server', 'world.log') }); }
    finally { if (prof) { if (prevOpts === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prevOpts; delete process.env.SIM_PROF_DIR; } }
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
      if (prof) writeFileSync(join(profDir, 'prof.start'), '');
      const t0 = Date.now(), until = t0 + durSec * 1000, counts = { cmds: 0, acts: 0, refused: 0, closed: 0, cards: 0, cardErrors: 0 };
      // #1944 A3: each tick window that ended during the load (live.json is rewritten every 2 s; a window lasts 10 s)
      const liveFile = join(dir, 'server', 'data', 'live.json'), tickWindows = new Map();
      const watch = setInterval(() => { const w = readLive(liveFile)?.api?.ticks; if (w?.at > t0 && w.at <= until + 2000) tickWindows.set(w.at, w); }, 4000);
      const cards = (async () => { while (Date.now() + cardSec * 1000 < until) { await sleep(cardSec * 1000); await Promise.all(souls.map((s) => sendCard({ base: w.base, soulId: s.soulId, identity: s.identity, text: 'Look around.' }).then(() => counts.cards++, () => counts.cardErrors++))); } })();
      await Promise.all(souls.map((s, k) => soulLoop({ folder: s.folder, until, r: rng(1000 * rep + k), counts, acts: s.acts })));
      await cards;
      await sleep(2500); clearInterval(watch);   // the watchdog's next live.json has the last acts
      const server = { act: actPartsOfLive(readLive(liveFile)), tickWindows: [...tickWindows.values()].sort((x, y) => x.at - y.at) };
      if (prof) {
        writeFileSync(join(profDir, 'prof.stop'), ''); const pf = join(profDir, 'world.cpuprofile');
        for (let k = 0; k < 240 && !existsSync(pf); k++) await sleep(500); await sleep(2000);
        try { server.profile = summarizeProfile(pf, serverRoot); } catch (e) { server.profile = { error: String(e?.message ?? e).slice(0, 200) }; }
      }
      const http = [], pairs = [];
      for (const [k, s] of souls.entries()) {
        await cliJson(s.folder, ['serve', '--stop']);
        const f = join(runtimeDir(s.folder, s.soulId), '.eden-report.jsonl');
        if (existsSync(f)) { mkdirSync(join(dir, 'trace'), { recursive: true }); copyFileSync(f, join(dir, 'trace', `s${k}.jsonl`)); const own = httpSince(readJsonl(f), t0); http.push(...own); pairs.push({ acts: s.acts, http: own }); }
      }
      const routes = routeStats(http);
      arms.push({ souls: n, repeat: rep, durationSec: durSec, counts, calls: http.length, routes, refusals: refusalCounts(http), server, slowActs: slowActs(pairs), actQueueMs: actQueue(pairs), held: routes.every((x) => x.levelMs == null || (x.serverMs.p999 ?? 0) <= x.levelMs) });
      log(`n${n} r${rep}: ${http.length} calls, ${counts.acts} acts, ${counts.closed} messages closed; level held on every route: ${arms.at(-1).held}`);
    } finally {
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

export function renderLoad(result) {
  const L = ['# Soul Client eval: load', '', 'Server time per call from `Server-Timing`. #1750 levels at p99.9: bookkeeping 50 ms, reads 100 ms, an act\'s acknowledgment 150 ms. Long polls have no level.'];
  for (const a of result.arms) {
    L.push('', `## ${a.souls} Souls, repeat ${a.repeat} (${a.durationSec} s)`, '', `${a.calls} calls; ${a.counts.acts} acts (${a.counts.refused} refused); ${a.counts.closed} owner messages acknowledged and closed of ${a.counts.cards} sent. Level held on every route: **${a.held ? 'yes' : 'no'}**. Refusals: ${Object.entries(a.refusals).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`, '',
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
    if (a.slowActs?.length) {
      if (a.actQueueMs) L.push('', `Act calls' queue (client trace): p50 ${a.actQueueMs.p50}, p95 ${a.actQueueMs.p95}, max ${a.actQueueMs.max} ms over ${a.actQueueMs.n} calls.`);
      L.push('', 'Acts by capability, slowest first: server time less the queue (handler + wait + commit), ms.', '', '| capability | acts | p50 | max | over 250 ms |', '|---|---|---|---|---|');
      for (const x of a.slowActs) L.push(`| ${x.capability} | ${x.n} | ${x.p50} | ${x.max} | ${x.over250} |`);
    }
  }
  return L.join('\n') + '\n';
}
