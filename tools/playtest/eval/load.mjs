// Soul Client eval, load mode (#1752 A5): N scripted Souls on one fresh fake-mind world. Each Soul runs `serve` and the new
// client's own loop: `pending` (acknowledging and closing any owner message), `look`, `find`, and `act` on a row it found.
// The harness sends each Soul an owner message every --card-sec. Every Soul's client trace (`soul-trace/1`) is
// folded by route: server time from `Server-Timing`, p50/p99/p99.9, against #1750's level (bookkeeping 50 ms, reads 100 ms,
// an act's acknowledgment 150 ms). $0: no model runs.
import { join, resolve, relative } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { startWorld, stopWorld } from '../arena/provision.mjs';
import { readJsonl, writeJson } from '../lib/jsonl.mjs';
import { newIdentity, rng } from '../lib/hash.mjs';
import { sleep } from '../lib/clock.mjs';
import { run } from '../lib/proc.mjs';
import { sendCard } from '../arena/owner.mjs';
import { prepareFolder, runtimeDir } from './episode.mjs';
import { httpSince, routeStats, refusalCounts } from './measure.mjs';

const WORDS = ['bench', 'eat', 'read', 'library', 'windmill', 'bandstand', 'music', 'fire circle', 'pond', 'garden', 'sit on the floor', 'dance'];
const REPO = resolve(new URL('../../..', import.meta.url).pathname);
const log = (...a) => process.stderr.write(`[soul-eval load] ${a.join(' ')}\n`);
const cliJson = async (folder, args) => { const r = await run('node', ['eden.mjs', ...args], { cwd: folder, maxWallMs: 90000 }); try { return { code: r.code, data: JSON.parse(r.stdout) }; } catch { return { code: r.code, data: null }; } };

async function soulLoop({ folder, until, r, counts }) {
  while (Date.now() < until) {
    const p = await cliJson(folder, ['pending']); counts.cmds++;
    for (const m of p.data?.ownerMessages ?? []) {
      if (!m?.id) continue;
      await cliJson(folder, ['ack', m.id, 'On it.']); await cliJson(folder, ['result', m.id, 'done', 'Done.']); counts.cmds += 2; counts.closed++;
    }
    await cliJson(folder, ['look']); counts.cmds++;
    const f = await cliJson(folder, ['find', WORDS[Math.floor(r() * WORDS.length)]]); counts.cmds++;
    const rows = (f.data?.found ?? []).filter((x) => x.act);
    if (rows.length) { const a = await cliJson(folder, ['act', rows[Math.floor(r() * Math.min(3, rows.length))].act]); counts.cmds++; counts.acts++; if (a.data?.accepted === false) counts.refused++; }
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
    const w = await startWorld({ serverRoot, slug: 'eden-load', port, genesis: 'worlds/templates/eden-2026.json', dataDir: join(dir, 'server', 'data'), log: join(dir, 'server', 'world.log') });
    const souls = [];
    try {
      // setup is paced at 6 Souls per 30 s: all Souls share one address, and a world pairs at most 20 in any 60 s from one
      // address (POST /v1/agent/pair). Setup is not measured.
      for (let i = 0; i < n; i += 6) { const b0 = Date.now(); await Promise.all(Array.from({ length: Math.min(6, n - i) }, async (_, j) => {
        const k = i + j, folder = join(dir, 'souls', `s${k}`); mkdirSync(folder, { recursive: true });
        const identity = newIdentity(); writeFileSync(join(folder, '.eden-agent.json'), JSON.stringify({ identity }) + '\n', { mode: 0o600 });
        const fake = { folder, base: w.base, info: {}, save() {} };
        const s = await prepareFolder(fake, { name: `Load ${k}` });
        souls[k] = { folder, identity, soulId: s.soulId };
      })); if (i + 6 < n) await sleep(Math.max(0, b0 + 30000 - Date.now())); }
      log(`n${n} r${rep}: ${souls.length} Souls serving; load for ${durSec} s`);
      const t0 = Date.now(), until = t0 + durSec * 1000, counts = { cmds: 0, acts: 0, refused: 0, closed: 0, cards: 0, cardErrors: 0 };
      const cards = (async () => { while (Date.now() + cardSec * 1000 < until) { await sleep(cardSec * 1000); await Promise.all(souls.map((s) => sendCard({ base: w.base, soulId: s.soulId, identity: s.identity, text: 'Look around.' }).then(() => counts.cards++, () => counts.cardErrors++))); } })();
      await Promise.all(souls.map((s, k) => soulLoop({ folder: s.folder, until, r: rng(1000 * rep + k), counts })));
      await cards;
      const http = [];
      for (const [k, s] of souls.entries()) {
        await cliJson(s.folder, ['serve', '--stop']);
        const f = join(runtimeDir(s.folder, s.soulId), '.eden-report.jsonl');
        if (existsSync(f)) { mkdirSync(join(dir, 'trace'), { recursive: true }); copyFileSync(f, join(dir, 'trace', `s${k}.jsonl`)); http.push(...httpSince(readJsonl(f), t0)); }
      }
      const routes = routeStats(http);
      arms.push({ souls: n, repeat: rep, durationSec: durSec, counts, calls: http.length, routes, refusals: refusalCounts(http), held: routes.every((x) => x.levelMs == null || (x.serverMs.p999 ?? 0) <= x.levelMs) });
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
  }
  return L.join('\n') + '\n';
}
