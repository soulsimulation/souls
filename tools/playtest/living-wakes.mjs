#!/usr/bin/env node
// A Soul on its own (#1980 A2): one live seat, an owner who says "make a friend today" and nothing else, and three
// heartbeat wakes ten minutes apart. A local fake-mind world with two Souls: the seat's Soul and a second Soul that only
// stands there. Each wake is one headless run of the prompt `wake heartbeat` prints, as a scheduled task would start it;
// no scheduled task is created: this script waits between wakes itself.
//
//   node tools/playtest/living-wakes.mjs --live --out <dir outside any checkout> [--port 4731] [--every 10] [--wakes 3]
//     [--model sonnet] [--cap-usd 1.00]
//
// Writes <out>/run.json (per wake: exit, turns, tokens, cost, the commands the seat ran, the brief and `now` after it) and
// <out>/wake-<n>.jsonl (the seat's stream-json transcript). A wake that would pass the cap is not started.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { run } from './lib/proc.mjs';
import { assertSeatHome } from './arena/seat-home.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';

const { values: o } = parseArgs({ options: { live: { type: 'boolean' }, out: { type: 'string' }, port: { type: 'string', default: '4731' }, every: { type: 'string', default: '10' },
  wakes: { type: 'string', default: '3' }, model: { type: 'string', default: 'sonnet' }, 'cap-usd': { type: 'string', default: '1.00' } } });
if (!o.live || !o.out) { console.error('usage: living-wakes.mjs --live --out <dir> [--port n] [--every min] [--wakes n] [--model m] [--cap-usd x] (it runs a live model)'); process.exit(2); }
const out = resolve(o.out), port = Number(o.port), every = Number(o.every), wakes = Number(o.wakes), cap = Number(o['cap-usd']);
const slug = 'living', base = `http://127.0.0.1:${port}/w/${slug}`, owner = 'living-owner', GOAL = 'make a friend today';
const soulCli = join(REPO_ROOT, 'tools/world-launcher/soul');
mkdirSync(out, { recursive: true });
assertSeatHome(join(out, 'mira', 'x'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const record = { started: new Date().toISOString(), model: o.model, everyMin: every, wakes: [], capUsd: cap };
const save = () => writeFileSync(join(out, 'run.json'), JSON.stringify(record, null, 1) + '\n');

// The world: fake minds, dev owners, served from this checkout.
const log = openSync(join(out, 'server.log'), 'a');
const server = spawn(process.execPath, ['apps/server/src/main.ts'], { cwd: REPO_ROOT, detached: true, stdio: ['ignore', log, log], env: { ...process.env,
  INVITE_REQUIRED: '0', EDGE_CONTROLLER_CLI_FILE: join(soulCli, 'eden.mjs'), EDGE_CLI_FILE: join(soulCli, 'eden-agent.mjs'), EDGE_SKILL_FILE: join(soulCli, 'skill.md'),
  EDGE_INSTRUCTIONS_FILE: join(soulCli, 'instructions.md'), WORLD_KEY: slug, WORLD_ID: `${slug}-1`, ENGINE: 'mars', PORT: String(port), DEV_AUTH: '1', BRAIN_MODE: 'fake',
  SEED_NATIVES: '0', DATA_DIR: join(out, 'data'), PUBLIC_URL: `http://127.0.0.1:${port}` } });
const stopAll = async () => {
  for (const f of ['mira', 'bo']) if (existsSync(join(out, f, 'eden.mjs'))) await run(process.execPath, ['eden.mjs', 'serve', '--stop'], { cwd: join(out, f), maxWallMs: 20_000 });
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
};
process.on('SIGINT', async () => { await stopAll(); process.exit(130); });

// The harness's own CLI calls see a user folder under the run, so a new home is never listed in a real ~/.souls.
const userHome = join(out, 'user-home'); mkdirSync(userHome, { recursive: true });
const cli = async (folder, ...args) => {
  const r = await run(process.execPath, ['eden.mjs', ...args], { cwd: join(out, folder), env: { HOME: userHome }, maxWallMs: 60_000 });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* text */ }
  return { code: r.code, json, text: r.stdout, err: r.stderr.slice(-400) };
};

try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* booting */ } await sleep(1000); }
  // Two Souls, each in its own home; the dev owner identity is seeded before create, as the arena seats do. `import` then
  // moves each folder into a Souls home (<folder>/.souls), as an owner's own folder is, so memory and the brief work.
  const souls = {};
  for (const [folder, name] of [['mira', 'Mira'], ['bo', 'Bo']]) {
    const dir = join(out, folder); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ identity: `${owner}-${folder}` }) + '\n', { mode: 0o600 });
    writeFileSync(join(dir, 'eden.mjs'), await (await fetch(`${base}/eden.mjs`)).text());
    await cli(folder, 'register', base);
    const c = await cli(folder, 'create', name);
    if (!c.json?.soul?.id) throw new Error(`create ${name}: ${c.text}${c.err}`);
    souls[folder] = c.json.soul.id;
    const im = await cli(folder, 'import');
    if (!existsSync(join(dir, '.souls', 'config.json')) || im.code !== 0) throw new Error(`import ${name}: ${im.text}${im.err}`);
    await cli(folder, 'serve');
  }
  // The seat's skill, where a home keeps a project copy (SKILL_COPIES in eden.mjs).
  mkdirSync(join(out, 'mira', '.claude/skills/souls'), { recursive: true });
  writeFileSync(join(out, 'mira', '.claude/skills/souls/SKILL.md'), await (await fetch(`${base}/skill.md`)).text());
  // The owner's choices: a wake budget and a heartbeat. Then one message, and nothing else from them.
  record.budget = (await cli('mira', 'wake', 'budget', 'normal')).json;
  const hb = (await cli('mira', 'wake', 'heartbeat', '--every', String(every))).json?.heartbeat;
  if (!hb?.prompt) throw new Error('wake heartbeat printed no prompt');
  record.prompt = hb.prompt;
  const sent = await fetch(`${base}/v1/edge/owner/${souls.mira}/inbox`, { method: 'POST', headers: { authorization: `Bearer dev:${owner}-mira`, 'content-type': 'application/json' }, body: JSON.stringify({ text: GOAL }) });
  record.ownerMessage = { text: GOAL, status: sent.status };
  record.souls = souls; save();

  let spent = 0;
  for (let n = 1; n <= wakes; n++) {
    const at = Date.parse(record.started) + (n - 1) * every * 60_000 + 60_000;
    if (Date.now() < at) await sleep(at - Date.now());
    const per = Math.min(cap - spent, cap / wakes);
    if (per <= 0.01) { record.wakes.push({ n, skipped: 'cap reached' }); save(); continue; }
    const lines = [];
    const env = { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' }; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    const r = await run('claude', ['-p', hb.prompt, '--model', o.model, '--allowedTools', 'Bash(node:*)', '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--output-format', 'stream-json', '--verbose', '--max-budget-usd', per.toFixed(2)], { cwd: join(out, 'mira'), env, maxWallMs: 9 * 60_000, onStdoutLine: (l) => lines.push(l) });
    writeFileSync(join(out, `wake-${n}.jsonl`), lines.join('\n') + '\n');
    const events = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    const result = events.findLast((e) => e.type === 'result') ?? {};
    const commands = events.filter((e) => e.type === 'assistant').flatMap((e) => e.message?.content ?? []).filter((c) => c.type === 'tool_use').map((c) => c.input?.command ?? c.name);
    spent += result.total_cost_usd ?? per;
    const status = (await cli('mira', 'status')).json;
    record.wakes.push({ n, startedAt: new Date(Date.now() - r.wallMs).toISOString(), wallMs: r.wallMs, exit: r.code, timedOut: r.timedOut, turns: result.num_turns ?? null,
      costUsd: result.total_cost_usd ?? null, usage: result.usage ?? null, result: result.result ?? null, commands, brief: status?.brief ?? null, now: status?.now ?? null, place: status?.place ?? status?.here?.place ?? null });
    record.spentUsd = spent; save();
  }
} finally {
  record.ended = new Date().toISOString(); save();
  await stopAll();
}
