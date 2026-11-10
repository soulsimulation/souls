#!/usr/bin/env node
// Soul Client eval (#1752): one command measures an agent driving a Soul on a fixed battery of plain instructions.
//
//   node tools/playtest/eval/soul-eval.mjs run --battery tools/playtest/eval/battery/m4-v1.json --seat tools/playtest/eval/seats/scripted-m4-v1.json \
//        [--world local:eden-2026] [--server-root <checkout>] [--repeats 2] [--items a,b] [--out <dir>] [--port 18760] [--max-usd 0]
//   node tools/playtest/eval/soul-eval.mjs report <out> [--against <other out>]
//   node tools/playtest/eval/soul-eval.mjs load --souls 12,24 ...         (tools/playtest/eval/load.mjs)
//
// A live seat (claude-headless) needs --max-usd: the run stops before an episode once its spend reaches the cap. Each
// local episode runs on its own fresh fake-mind world, which keeps its own model budget (default $0.50 a day).
// Docs: docs/testing/soul-eval.md.
import { resolve, join, relative } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { startWorld, stopWorld } from '../arena/provision.mjs';
import { LIVE_ADAPTERS } from '../arena/seat.mjs';
import { validateScript } from '../arena/adapters/scripted-owner.mjs';
import { readJson, writeJson } from '../lib/jsonl.mjs';
import { runEpisode } from './episode.mjs';
import { validateBattery, summarize } from './measure.mjs';
import { renderReport } from './report.mjs';

export const RESULT_SCHEMA = 'soul-eval/1';
const REPO = resolve(new URL('../../..', import.meta.url).pathname);
const GENESIS = { 'eden-2026': 'worlds/templates/eden-2026.json' };
const log = (...a) => process.stderr.write(`[soul-eval] ${a.join(' ')}\n`);

export function parseArgs(argv) {
  const [cmd, ...rest] = argv, o = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) { const k = a.slice(2), v = rest[i + 1]; if (v == null || v.startsWith('--')) o[k] = true; else { o[k] = v; i++; } }
    else o._.push(a);
  }
  return { cmd, o };
}
const gitHead = (dir) => { try { return execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(); } catch { return null; } };

export async function runEval(o) {
  const battery = readJson(resolve(o.battery ?? join(REPO, 'tools/playtest/eval/battery/m4-v1.json')));
  const seatCfg = readJson(resolve(o.seat ?? join(REPO, 'tools/playtest/eval/seats/scripted-m4-v1.json')));
  if (!battery || !seatCfg) throw new Error('--battery and --seat must be readable JSON');
  const errs = validateBattery(battery);
  if (seatCfg.adapter === 'scripted-owner') errs.push(...validateScript(seatCfg.script));
  if (errs.length) throw new Error(`invalid input:\n  ${errs.join('\n  ')}`);
  const live = LIVE_ADAPTERS.has(seatCfg.adapter ?? 'claude-headless');
  const maxUsd = Number(o['max-usd'] ?? 0);
  if (live && !(maxUsd > 0)) throw new Error('a live seat needs --max-usd (the run\'s paid cap)');
  const world = String(o.world ?? `local:${battery.world ?? 'eden-2026'}`);
  const local = world.startsWith('local:'), folder = o.folder ? resolve(o.folder) : null;
  if (!local && !/^(?:https:\/\/|http:\/\/(?:127\.0\.0\.1|localhost)[:/])/.test(world)) throw new Error('--world is local:<template> or an https world URL');
  if (!local && !folder) throw new Error('a remote world needs --folder: a Soul folder its owner already paired (the eval never creates or pairs)');
  const deliver = String(o.deliver ?? (local ? 'inbox' : 'chat'));
  if (!['inbox', 'chat'].includes(deliver)) throw new Error('--deliver inbox|chat');
  if (!local && deliver === 'inbox') throw new Error('owner messages on a remote world need the owner\'s own sign-in; use --deliver chat');
  const template = local ? world.slice('local:'.length) : null, genesis = local ? GENESIS[template] : null;
  if (local && !genesis) throw new Error(`unknown local world ${template}`);
  const serverRoot = resolve(o['server-root'] ?? REPO), port = Number(o.port ?? 18760), repeats = Number(o.repeats ?? 1);
  const pick = o.items ? new Set(String(o.items).split(',')) : null;
  const items = battery.items.filter((it) => !pick || pick.has(it.id));
  const out = resolve(o.out ?? join(REPO, '.local/soul-eval', `${battery.battery}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  mkdirSync(out, { recursive: true });
  const meta = { schema: RESULT_SCHEMA, battery: battery.battery, world: local ? world : /^http:/.test(world) ? 'local-url' : world.replace(/\/$/, ''), deliver, serverCommit: local ? gitHead(serverRoot) : null, evalCommit: gitHead(REPO),
    seat: { adapter: seatCfg.adapter ?? 'claude-headless', model: seatCfg.model ?? null, effort: seatCfg.effort ?? null, clean: live ? cleanEnvReport() : null },
    repeats, warmSec: Number(o['warm-sec'] ?? 0), items: items.map((i) => i.id), maxUsd: live ? maxUsd : 0, startedAt: new Date().toISOString() };
  writeJson(join(out, 'run.json'), meta);
  const episodes = []; let spent = 0, stoppedBy = null, n = 0;
  for (let rep = 1; rep <= repeats && !stoppedBy; rep++) for (const item of items) {
    if (live && spent >= maxUsd) { stoppedBy = `paid cap $${maxUsd} reached ($${spent.toFixed(3)})`; break; }
    const dir = join(out, 'episodes', `${String(++n).padStart(3, '0')}-${item.id}-r${rep}`);
    let w = null;
    try {
      if (local) w = await startWorld({ serverRoot, slug: 'eden-eval', port, genesis, dataDir: join(dir, 'server', 'data'), log: join(dir, 'server', 'world.log') });
      const rec = await runEpisode({ dir, base: local ? w.base : world.replace(/\/$/, ''), item, seatCfg, rails: { ...(seatCfg.rails ?? {}) }, folder, deliver, warmSec: Number(o['warm-sec'] ?? 0), refreshClient: !!o['refresh-client'] && rep === 1 && n === 1,
        resetTo: local ? null : (o['reset-to'] === true ? null : o['reset-to'] ?? null), log });
      rec.repeat = rep; episodes.push(rec);
      spent += (rec.seat.costUsd ?? 0) + (rec.kickoff.costUsd ?? 0);
      log(`${item.id} r${rep}: ${rec.succeeded ? 'PASS' : 'FAIL'} (${rec.why}) turns=${rec.seat.modelTurns} calls=${rec.worldCalls} motion=${rec.firstMotionMs}ms spent=$${spent.toFixed(3)}`);
    } catch (e) {
      log(`${item.id} r${rep}: ERROR ${e.message}`);
      episodes.push({ item: item.id, repeat: rep, error: String(e.message).slice(0, 300), succeeded: false, seat: { modelTurns: 0, apiCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, cliCalls: {} }, refusals: {}, routes: [] });
      if (/is not in this world|no place of kind|no thing of kind/.test(e.message)) { stoppedBy = `battery invalid for this world: ${e.message}`; }
    } finally {
      if (w) { await stopWorld({ pid: w.pid }); if (!o['keep-data']) rmSync(join(dir, 'server', 'data'), { recursive: true, force: true }); }
    }
  }
  const result = { ...meta, endedAt: new Date().toISOString(), stoppedBy, spentUsd: Math.round(spent * 10000) / 10000, episodes, summary: summarize(episodes.filter((e) => !e.error)) };
  writeJson(join(out, 'result.json'), result);
  writeFileSync(join(out, 'REPORT.md'), renderReport(result));
  log(`wrote ${relative(process.cwd(), out)}/result.json and REPORT.md`);
  return { out, result };
}

/** What the seat's environment held (names only), so a report shows the seat ran clean (#1688's allowlist). */
function cleanEnvReport() {
  const names = Object.keys(process.env).sort();
  return { names, configIsolated: !!process.env.CLAUDE_CONFIG_DIR };
}

/** result.json, or one rebuilt from the episodes a stopped run left (episodes/<n>/episode.json and run.json). */
export function loadResult(dir) {
  // a,b,…: one arm run in several invocations (one repeat each); its episodes are joined, repeat k from the k-th run
  if (String(dir).includes(',')) {
    const parts = String(dir).split(',').map((p) => loadResult(p));
    if (parts.some((p) => !p)) return null;
    const episodes = parts.flatMap((p, k) => p.episodes.map((e) => ({ ...e, repeat: k + 1 })));
    return { ...parts[0], repeats: parts.length, spentUsd: parts.reduce((s, p) => s + (p.spentUsd ?? 0), 0), stoppedBy: parts.map((p) => p.stoppedBy).filter(Boolean).join('; ') || null, episodes, summary: summarize(episodes.filter((e) => !e.error)) };
  }
  const d = resolve(dir), r = readJson(join(d, 'result.json'));
  if (r) return { ...r, summary: summarize((r.episodes ?? []).filter((e) => !e.error)) };   // totals are always refolded from the episodes
  const meta = readJson(join(d, 'run.json'));
  if (!meta) return null;
  const eps = existsSync(join(d, 'episodes')) ? readdirSync(join(d, 'episodes')).sort().map((e) => readJson(join(d, 'episodes', e, 'episode.json'))).filter(Boolean) : [];
  for (const [i, e] of eps.entries()) e.repeat ??= Number(/-r(\d+)$/.exec(readdirSync(join(d, 'episodes')).sort()[i])?.[1] ?? 1);
  return { ...meta, stoppedBy: 'the run stopped before it wrote result.json; rebuilt from its finished episodes', spentUsd: eps.reduce((s, e) => s + (e.seat.costUsd ?? 0) + (e.kickoff?.costUsd ?? 0), 0), episodes: eps, summary: summarize(eps) };
}

async function main() {
  const { cmd, o } = parseArgs(process.argv.slice(2));
  if (cmd === 'run') { await runEval(o); process.exit(0); }   // a seat's in-flight turn or timers must not hold the lock past the result
  if (cmd === 'report') {
    const dir = o._[0]; if (!dir) throw new Error('report <out> [--against <out>]');
    const a = loadResult(dir), b = o.against ? loadResult(o.against) : null;
    if (!a) throw new Error(`no result.json in ${dir}`);
    process.stdout.write(renderReport(a, b));
    return;
  }
  if (cmd === 'load') { const { runLoad } = await import('./load.mjs'); await runLoad(o); process.exit(0); }
  process.stderr.write('usage: soul-eval.mjs run|report|load (see the header)\n'); process.exitCode = 2;
}
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('soul-eval.mjs')) main().catch((e) => { log(e.stack ?? e.message); process.exitCode = 1; });
