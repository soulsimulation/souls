#!/usr/bin/env node
// A Soul lives on its own for a day (#1981): one live seat, Mira, whose owner says "make friends and find out what
// happens here" and nothing else, on a local Eden 2026 world (fake minds) with five scripted Souls that talk and two
// calendar events. The harness is the local heartbeat: every --every minutes it runs the prompt `wake heartbeat` prints,
// one headless Claude Code run, as a scheduled task would start it; no scheduled task is created. Before each wake it
// also runs `pending --check` (the gated form) and records what it said.
//
//   node tools/playtest/living-day.mjs --live --out <dir outside any checkout> [--port 4741] [--every 60] [--hours 8]
//     [--model sonnet] [--cap-usd 1.00]
//
// Writes <out>/run.json (setup, per wake: check, exit, turns, tokens, cost, commands, brief, serve status, plan-usage
// readings; the neighbours' log; the end state) and <out>/wake-<n>.jsonl (the seat's stream-json transcript). A wake that
// would pass the cap is not started. PLAYTEST_USAGE_PY names a plan-usage tool to read at each wake (lib/quota.mjs).
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { run } from './lib/proc.mjs';
import { quota } from './lib/quota.mjs';
import { assertSeatHome } from './arena/seat-home.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';

const { values: o } = parseArgs({ options: { live: { type: 'boolean' }, out: { type: 'string' }, port: { type: 'string', default: '4741' }, every: { type: 'string', default: '60' },
  hours: { type: 'string', default: '8' }, model: { type: 'string', default: 'sonnet' }, 'cap-usd': { type: 'string', default: '1.00' } } });
if (!o.live || !o.out) { console.error('usage: living-day.mjs --live --out <dir> [--port n] [--every min] [--hours h] [--model m] [--cap-usd x] (it runs a live model)'); process.exit(2); }
const out = resolve(o.out), port = Number(o.port), every = Number(o.every), hours = Number(o.hours), cap = Number(o['cap-usd']);
const wakes = Math.floor((hours * 60) / every), endAt = Date.now() + hours * 3_600_000;
const slug = 'living-day', base = `http://127.0.0.1:${port}/w/${slug}`, owner = 'living-owner', GOAL = 'make friends and find out what happens here';
const TALK_MIN = 5;
// Five scripted neighbours: lines they say in turn, and the one answer each gives when Mira speaks to them.
const NEIGHBOURS = [
  { folder: 'ana', name: 'Ana', reply: 'Nice to meet you, Mira! I host tea most mornings, come by.', lines: ['Lovely light today.', 'Has anyone seen the garden lately?', 'I am putting the kettle on soon.'] },
  { folder: 'bo', name: 'Bo', reply: 'Hey Mira, I play music in the evening. You should come.', lines: ['I am tuning my guitar.', 'Music tonight, everyone is welcome.', 'Anyone know a good song?'] },
  { folder: 'cleo', name: 'Cleo', reply: 'Hi Mira, I keep the library tidy. Ask me about books any time.', lines: ['I found an old map in the library.', 'Quiet is underrated.', 'Who left this book here?'] },
  { folder: 'dev', name: 'Dev', reply: 'Mira! Good to see a new face. I walk the paths every day.', lines: ['The paths are long today.', 'I counted twelve trees on my walk.', 'Morning, all.'] },
  { folder: 'esi', name: 'Esi', reply: 'Welcome, Mira. I will see you at the music later, I hope.', lines: ['I am learning to paint.', 'The sky looks like rain.', 'Who is going to the music tonight?'] },
];
const soulCli = join(REPO_ROOT, 'tools/world-launcher/soul');
mkdirSync(out, { recursive: true });
assertSeatHome(join(out, 'mira', 'x'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const record = { started: new Date().toISOString(), model: o.model, everyMin: every, hours, plannedWakes: wakes, capUsd: cap, goal: GOAL, wakes: [], neighbours: [] };
const save = () => writeFileSync(join(out, 'run.json'), JSON.stringify(record, null, 1) + '\n');

// The world: Eden 2026 from its template, fake minds, dev owners, served from this checkout.
const log = openSync(join(out, 'server.log'), 'a');
const server = spawn(process.execPath, ['apps/server/src/main.ts'], { cwd: REPO_ROOT, detached: true, stdio: ['ignore', log, log], env: { ...process.env,
  INVITE_REQUIRED: '0', EDGE_CONTROLLER_CLI_FILE: join(soulCli, 'eden.mjs'), EDGE_CLI_FILE: join(soulCli, 'eden-agent.mjs'), EDGE_SKILL_FILE: join(soulCli, 'skill.md'),
  EDGE_INSTRUCTIONS_FILE: join(soulCli, 'instructions.md'), WORLD_KEY: slug, WORLD_ID: `${slug}-1`, ENGINE: 'mars', PORT: String(port), DEV_AUTH: '1', BRAIN_MODE: 'fake',
  SEED_NATIVES: '0', DATA_DIR: join(out, 'data'), PUBLIC_URL: `http://127.0.0.1:${port}`, GENESIS_FILE: join(REPO_ROOT, 'worlds/templates/eden-2026.json') } });
const folders = ['mira', ...NEIGHBOURS.map((n) => n.folder)];
const stopAll = async () => {
  for (const f of folders) if (existsSync(join(out, f, 'eden.mjs'))) await run(process.execPath, ['eden.mjs', 'serve', '--stop'], { cwd: join(out, f), maxWallMs: 20_000 });
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* gone */ }
};
process.on('SIGINT', async () => { await stopAll(); process.exit(130); });
process.on('SIGTERM', async () => { record.stopped = 'SIGTERM'; save(); await stopAll(); process.exit(143); });

// The harness's own CLI calls see a user folder under the run, so a new home is never listed in a real ~/.souls.
const userHome = join(out, 'user-home'); mkdirSync(userHome, { recursive: true });
const cli = async (folder, ...args) => {
  const r = await run(process.execPath, ['eden.mjs', ...args], { cwd: join(out, folder), env: { HOME: userHome }, maxWallMs: 60_000 });
  let json = null; try { json = JSON.parse(r.stdout); } catch { /* text */ }
  return { code: r.code, json, text: r.stdout, err: r.stderr.slice(-400) };
};
const note = (who, cmd, r) => { record.neighbours.push({ at: new Date().toISOString(), who, cmd, code: r.code, ...(r.code ? { err: (r.err || r.text).slice(-300) } : {}) }); };

// The neighbours, until the run ends: every TALK_MIN minutes one of them speaks in turn (every third line to Mira by
// name), each answers Mira when `pending` shows she spoke to them, and at each event's start its host and two more walk there.
async function neighbours(events) {
  const answered = new Set(), walked = new Set();
  for (let k = 0; Date.now() < endAt - TALK_MIN * 60_000; k++) {
    await sleep(TALK_MIN * 60_000);
    for (const n of NEIGHBOURS) {
      const p = await cli(n.folder, 'pending');
      if (!(p.json?.addressed ?? []).some((a) => a.from === 'Mira')) continue;
      const text = answered.has(n.folder) ? 'Good to talk again, Mira.' : n.reply; answered.add(n.folder);
      note(n.name, `say --to Mira (answer): ${text}`, await cli(n.folder, 'say', text, '--to', 'Mira'));
    }
    const n = NEIGHBOURS[k % NEIGHBOURS.length], line = n.lines[Math.floor(k / NEIGHBOURS.length) % n.lines.length];
    const r = k % 3 === 2 ? await cli(n.folder, 'say', `Mira, ${line.charAt(0).toLowerCase()}${line.slice(1)}`, '--to', 'Mira') : await cli(n.folder, 'say', line);
    note(n.name, k % 3 === 2 ? `say --to Mira: ${line}` : `say: ${line}`, r);
    for (const e of events) {
      if (walked.has(e.id) || Date.now() < e.startsAt) continue;
      walked.add(e.id);
      for (const f of e.goers) { const w = await cli(f, 'act', e.walk, '--for', 'none'); note(f, `act ${e.walk}`, w); }
    }
  }
}

try {
  for (let i = 0; i < 180; i++) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* booting */ } await sleep(1000); }
  // Six Souls, each in its own home; the dev owner identity is seeded before create, as the arena seats do; `import` moves
  // each folder into a Souls home (<folder>/.souls), as an owner's own folder is.
  const souls = {};
  for (const [folder, name] of [['mira', 'Mira'], ...NEIGHBOURS.map((n) => [n.folder, n.name])]) {
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
  record.souls = souls;
  // Two calendar events, announced by Ana and Bo at two places the world's search finds: tea in 90 minutes, music in 5 hours.
  const placeOf = async (words) => (await cli('ana', 'find', words)).json?.found?.find((x) => x.type === 'place') ?? {};
  const plan = [{ host: 'ana', title: 'Morning tea', words: 'tea', in: 90, for: 60, goers: ['ana', 'cleo', 'dev'] }, { host: 'bo', title: 'Music night', words: 'stage', in: 300, for: 90, goers: ['bo', 'esi', 'dev'] }];
  const events = [];
  for (const e of plan) {
    const place = await placeOf(e.words);
    const a = await cli(e.host, 'calendar', 'add', e.title, '--place', place.id ?? '', '--in', String(e.in), '--for', String(e.for));
    if (!a.json?.calendarItem?.id) throw new Error(`calendar add ${e.title}: ${a.text}${a.err}`);
    events.push({ id: a.json.calendarItem.id, title: e.title, placeId: place.id, place: place.name, walk: place.act, host: e.host, startsAt: Date.now() + e.in * 60_000, forMin: e.for, goers: e.goers });
  }
  record.events = events;
  // The seat's skill, where a home keeps a project copy (SKILL_COPIES in eden.mjs).
  mkdirSync(join(out, 'mira', '.claude/skills/souls'), { recursive: true });
  writeFileSync(join(out, 'mira', '.claude/skills/souls/SKILL.md'), await (await fetch(`${base}/skill.md`)).text());
  // The owner's choices: the normal wake budget and a heartbeat. Then one message, and nothing else from them.
  record.budget = (await cli('mira', 'wake', 'budget', 'normal')).json;
  const hb = (await cli('mira', 'wake', 'heartbeat', '--every', String(every))).json?.heartbeat;
  if (!hb?.prompt) throw new Error('wake heartbeat printed no prompt');
  record.prompt = hb.prompt;
  const sent = await fetch(`${base}/v1/edge/owner/${souls.mira}/inbox`, { method: 'POST', headers: { authorization: `Bearer dev:${owner}-mira`, 'content-type': 'application/json' }, body: JSON.stringify({ text: GOAL }) });
  record.ownerMessage = { text: GOAL, status: sent.status };
  record.usageAtStart = await quota(); save();

  const town = neighbours(events).catch((e) => { record.neighboursError = String(e?.stack ?? e).slice(0, 500); save(); });
  let spent = 0;
  for (let n = 1; n <= wakes; n++) {
    const at = Date.parse(record.started) + (n - 1) * every * 60_000 + 60_000;
    if (Date.now() < at) await sleep(at - Date.now());
    const check = await run(process.execPath, ['eden.mjs', 'pending', '--check'], { cwd: join(out, 'mira'), env: { HOME: userHome }, maxWallMs: 60_000 });
    const per = Math.min(cap - spent, cap / wakes);
    if (per <= 0.01) { record.wakes.push({ n, check: check.code, skipped: 'cap reached' }); save(); continue; }
    const lines = [];
    const env = { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' }; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
    const startedAt = new Date().toISOString();
    const r = await run('claude', ['-p', hb.prompt, '--model', o.model, '--allowedTools', 'Bash(node:*)', '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--output-format', 'stream-json', '--verbose', '--max-budget-usd', per.toFixed(2)], { cwd: join(out, 'mira'), env, maxWallMs: 15 * 60_000, onStdoutLine: (l) => lines.push(l) });
    writeFileSync(join(out, `wake-${n}.jsonl`), lines.join('\n') + '\n');
    const evs = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    const result = evs.findLast((e) => e.type === 'result') ?? {};
    const commands = evs.filter((e) => e.type === 'assistant').flatMap((e) => e.message?.content ?? []).filter((c) => c.type === 'tool_use').map((c) => c.input?.command ?? c.name);
    spent += result.total_cost_usd ?? per;
    const status = (await cli('mira', 'status')).json;
    const serve = await cli('mira', 'serve', '--status');
    record.wakes.push({ n, startedAt, wallMs: r.wallMs, check: check.code, exit: r.code, timedOut: r.timedOut, turns: result.num_turns ?? null, costUsd: result.total_cost_usd ?? null,
      usage: result.usage ?? null, rateLimits: evs.filter((e) => e.type === 'rate_limit_event'), result: result.result ?? null, commands, brief: status?.brief ?? null, now: status?.now ?? null,
      serve: serve.json ?? serve.text.slice(0, 300), plan: (await quota()) });
    record.spentUsd = spent; save();
  }
  if (Date.now() < endAt) await sleep(endAt - Date.now());
  await town;
  record.end = { status: (await cli('mira', 'status')).json, serve: (await cli('mira', 'serve', '--status')).json, wake: (await cli('mira', 'wake')).json, usage: await quota() };
} catch (e) {
  record.error = String(e?.stack ?? e).slice(0, 800);
} finally {
  record.ended = new Date().toISOString(); save();
  await stopAll();
}
