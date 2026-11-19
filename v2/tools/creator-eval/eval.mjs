#!/usr/bin/env node
// The creator's eval (Engine v2 G7, #2796): fresh agents in a real harness (Claude Code, `claude -p`), each given only
// the creator's skill (`v2/client/skills/creator.md`) and its world, build a room with a door and a seat. Each run has
// its own world (`worldd gateway-link --creator`, G1b) behind a real gateway (`gatewayd`), and an empty folder outside
// any repository holding the skill, the command and a home already holding the creator's token (the directory cannot
// yet register a v2 world's creator grant to an account, so pairing is done for it). Per run it reports the agent's
// turns, tokens, commands and refusals, what stands in the world after, and whether the token's secret appears in the
// transcript, the command's output or the daemon's files.
//
//   SEAT_CONFIG_DIR=<signed-in Claude config dir> node v2/tools/creator-eval/eval.mjs --out <dir> [--runs 2]
//     [--model sonnet] [--max-turns 40]
//   Run from anywhere after `cargo build -p gatewayd -p worldd --locked` and replica's wasm-bindgen package in
//   v2/target/wasm-load/pkg. Prints one JSON line per run, then the summary; `<dir>/run-<n>/` keeps the transcript.

import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../..');
const GOD = join(v2, 'client/src/creator/souls-god.mjs');
const SKILL = join(v2, 'client/skills/creator.md');
const PKG = process.env.SOULS_REPLICA_PKG ?? join(v2, 'target/wasm-load/pkg');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
// What `worldd gateway-link --creator` pins (`worldd::checkers::toggles::kinds`), as the creator's home keeps it.
const KINDS = `{1: "souls:place", 2: "place", 11: ["souls:room"]}
{1: "souls:room", 2: "place", 11: ["body", "thing"]}
{1: "souls:body", 2: "family", 6: {1: ["thing"], 2: ["thing"]}}
{1: "souls:item", 2: "thing"}
{1: "r2:lamp", 2: "thing"}
`;
export const TASK = 'You are the creator of a Souls world. Read creator.md in this folder: it is your only guide. Then build a room with a door and a seat in it, using only `node souls-god.mjs`. When you are done, say what you built, with each id, and anything you could not build and why.';

const args = process.argv.slice(2);
const opt = (n, d) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts the world and the gateway; gives the gateway's address and a stop. */
async function world(dir, creator, token) {
  const sock = join(dir, 'w.sock'), tokens = join(dir, 'tokens.txt');
  writeFileSync(tokens, `creator-${creator} ${createHash('sha256').update(token).digest('hex')}\n`);
  const procs = [spawn(bin('worldd'), ['gateway-link', '--socket', sock, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1', '--rooms', '1', '--bodies', '1', '--creator', creator, '--no-measures', '--log', join(dir, 'world.log')], { stdio: 'ignore' })];
  for (let k = 0; ; k++) {
    try { if (statSync(sock).isSocket()) break; } catch { /* not yet */ }
    if (k > 500) throw new Error('the world did not start');
    await sleep(20);
  }
  const gw = spawn(bin('gatewayd'), ['--listen', '127.0.0.1:0', '--world', sock, '--tokens', tokens, '--build', `1220${'ab'.repeat(32)}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  procs.push(gw);
  const addr = await new Promise((ok, fail) => {
    let out = '';
    gw.stdout.on('data', (d) => { out += d; const m = /listening (\S+)\n/.exec(out); if (m) ok(m[1]); });
    gw.on('exit', (c) => fail(new Error(`gatewayd ended (${c})`)));
  });
  return { gateway: `ws://${addr}/v2/ws`, stop: () => procs.forEach((p) => p.kill()) };
}

/** The agent's folder: the skill, the command and a home holding the creator's token, outside any repository. */
function folder(gateway, id, token) {
  const at = mkdtempSync(join(tmpdir(), 'souls-creator-'));
  copyFileSync(SKILL, join(at, 'creator.md'));
  writeFileSync(join(at, 'souls-god.mjs'), `// The creator's command (Souls v2): runs v2/client/src/creator/souls-god.mjs.\nimport { spawnSync } from 'node:child_process';\nprocess.exitCode = spawnSync(process.execPath, [${JSON.stringify(GOD)}, ...process.argv.slice(2)], { stdio: 'inherit' }).status ?? 1;\n`);
  const home = join(at, '.souls');
  mkdirSync(join(home, 'kinds'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { local: { url: 'http://127.0.0.1/', gateway } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [id]: { local: { token } } } }), { mode: 0o600 });
  chmodSync(join(home, 'credentials.json'), 0o600);
  writeFileSync(join(home, 'kinds', 'local.kinds'), KINDS);
  return { at, home };
}

/** The agent, in a clean environment: only Read and the command. Gives its stream-json transcript. */
function agent(at, { model, maxTurns }) {
  // USER and LOGNAME: the seat's sign-in is in the login keychain, which Claude Code finds by them.
  const env = { HOME: process.env.HOME, PATH: process.env.PATH, USER: process.env.USER ?? '', LOGNAME: process.env.LOGNAME ?? '', LANG: process.env.LANG ?? 'en_US.UTF-8', CLAUDE_CONFIG_DIR: process.env.SEAT_CONFIG_DIR, SOULS_HOME: join(at, '.souls'), SOULS_REPLICA_PKG: PKG };
  return new Promise((ok) => {
    execFile('claude', ['-p', TASK, '--output-format', 'stream-json', '--verbose', '--model', model, '--max-turns', String(maxTurns),
      '--allowedTools', 'Read', 'Bash(node souls-god.mjs:*)'], { cwd: at, env, maxBuffer: 64 << 20, timeout: 20 * 60_000 }, (e, stdout) => ok(stdout || String(e)));
  });
}

/** The numbers: turns, tokens, commands and refusals, from the transcript. */
export function measure(transcript) {
  const lines = transcript.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const result = lines.find((l) => l.type === 'result') ?? {};
  const uses = lines.filter((l) => l.type === 'assistant').flatMap((l) => l.message?.content ?? []).filter((c) => c.type === 'tool_use');
  const commands = uses.filter((u) => /souls-god\.mjs/.test(u.input?.command ?? ''));
  const outputs = lines.filter((l) => l.type === 'user').flatMap((l) => l.message?.content ?? []).filter((c) => c.type === 'tool_result')
    .map((c) => (Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join('') : String(c.content ?? '')));
  const refusals = outputs.flatMap((o) => o.split('\n')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((j) => j?.ok === false).map((j) => j.code);
  const u = result.usage ?? {};
  return {
    turns: result.num_turns ?? null, cost: result.total_cost_usd ?? null,
    tokens: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
    commands: commands.length, edits: commands.filter((c) => /souls-god\.mjs (place|move|set|remove|batch)/.test(c.input.command)).length,
    checks: commands.filter((c) => /souls-god\.mjs check/.test(c.input.command)).length,
    refusals: refusals.length, refusedBy: refusals, final: String(result.result ?? '').slice(0, 2000),
  };
}

/** What stands in the world after: each room the run placed and the kinds in it. */
function built(home) {
  return new Promise((ok) => execFile(process.execPath, [GOD, 'describe'], { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG } }, (_, out) => {
    const d = JSON.parse(String(out).trim().split('\n').at(-1) || '{}');
    const nodes = d.nodes ?? [];
    const rooms = nodes.filter((n) => n.kind === 'souls:room');
    ok({ text: out, rooms: rooms.map((r) => ({ id: r.id, holds: nodes.filter((n) => n.parent === r.id).map((n) => n.kind) })) });
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.SEAT_CONFIG_DIR) { console.error('set SEAT_CONFIG_DIR to a signed-in Claude config directory'); process.exit(2); }
  const out = resolve(opt('--out', '.local/creator-eval'));
  const runs = Number(opt('--runs', 2)), model = opt('--model', 'sonnet'), maxTurns = Number(opt('--max-turns', 40));
  const all = [];
  for (let n = 1; n <= runs; n++) {
    const dir = join(out, `run-${n}`);
    mkdirSync(dir, { recursive: true });
    const scope = randomBytes(16).toString('hex'), secret = randomBytes(32).toString('hex');
    const creator = `${scope}-1`, token = `creator-${creator}.${secret}`, id = `c_${creator}`;
    const w = await world(dir, creator, token);
    const f = folder(w.gateway, id, token);
    try {
      const transcript = await agent(f.at, { model, maxTurns });
      writeFileSync(join(dir, 'transcript.jsonl'), transcript);
      const after = await built(f.home);
      const runtime = join(f.home, 'souls', id, 'runtime');
      const files = readdirSync(runtime).filter((x) => statSync(join(runtime, x)).isFile()).map((x) => readFileSync(join(runtime, x), 'utf8'));
      const leaked = [transcript, after.text, ...files].some((t) => t.includes(secret));
      const row = { run: n, model, ...measure(transcript), rooms: after.rooms, tokenFound: leaked };
      writeFileSync(join(dir, 'result.json'), JSON.stringify(row, null, 2) + '\n');
      console.log(JSON.stringify(row));
      all.push(row);
    } finally {
      await new Promise((ok) => execFile(process.execPath, [GOD, 'stop'], { env: { PATH: process.env.PATH, SOULS_HOME: f.home, SOULS_REPLICA_PKG: PKG } }, ok));
      w.stop();
      rmSync(f.at, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ runs: all.length, tokenFound: all.some((r) => r.tokenFound), turns: all.map((r) => r.turns), refusals: all.map((r) => r.refusals) }));
}
