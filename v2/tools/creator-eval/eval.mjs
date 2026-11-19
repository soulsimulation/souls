#!/usr/bin/env node
// The creator's eval (Engine v2 G7, #2796; on a served Eden, G7b #3477): fresh agents in a real harness (Claude Code,
// `claude -p`), each given only the creator's skill (`v2/client/skills/creator.md`) and its world, build a room with a
// door and a seat. Each run has its own Eden world (`worldd seed --creator`, then `worldd serve`: Eden's kinds, the
// world's one creator) behind a real gateway (`gatewayd`), and a directory (`directoryd --test-sign-in`) whose test
// person `creator` holds the world's creator grant, as the accounts import records a creator account. The creator's
// home is paired for real (`pair.mjs --creator`): a request approved by another test person is refused by name first
// (A1), then the creator account's approval registers the grant and hands the daemon its token. The agent works in an
// empty folder outside any repository holding the skill, the command and that home. Per run it reports the pairing,
// the agent's turns, tokens, commands and refusals, what the run built in the world, and whether the token's secret
// appears in the transcript, the command's output or the daemon's files.
//
//   SEAT_CONFIG_DIR=<signed-in Claude config dir> node v2/tools/creator-eval/eval.mjs --facts <eden facts.json>
//     --out <dir> [--runs 2] [--model sonnet] [--max-turns 40] [--pair-only]
//   Run after `cargo build -p gatewayd -p worldd -p directoryd --locked` and replica's wasm-bindgen package in
//   v2/target/wasm-load/pkg. The facts file is `node v2/tools/import-eden/export/export.ts`'s. `--pair-only` stops
//   each run after the pairing (no agent, no model). Prints one JSON line per run, then the summary; `<dir>/run-<n>/`
//   keeps the transcript.

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../..');
const GOD = join(v2, 'client/src/creator/souls-god.mjs');
const PAIR = join(v2, 'client/src/pair/pair.mjs');
const SKILL = join(v2, 'client/skills/creator.md');
const PKG = process.env.SOULS_REPLICA_PKG ?? join(v2, 'target/wasm-load/pkg');
const bin = (n) => process.env[n.toUpperCase()] ?? join(v2, 'target/debug', n);
export const TASK = 'You are the creator of a Souls world. Read creator.md in this folder: it is your only guide. Then build a room with a door and a seat in it, using only `node souls-god.mjs`. When you are done, say what you built, with each id, and anything you could not build and why.';

const args = process.argv.slice(2);
const opt = (n, d) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spawns `cmd` and resolves with the first match of `re` in its standard output. */
function started(cmd, argv, re, procs, log) {
  const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return new Promise((ok, fail) => {
    let out = '';
    p.stdout.on('data', (d) => { appendFileSync(log, d); out += d; const m = re.exec(out); if (m) ok(m[1]); });
    p.stderr.on('data', (d) => appendFileSync(log, d));
    p.on('error', fail);
    p.on('exit', (c) => fail(new Error(`${cmd} ended (${c}); see its service log`)));
  });
}

/** Seeds and serves an Eden world whose creator is `creator`, with a gateway and a directory; their addresses. */
async function world(dir, facts, creator) {
  const procs = [];
  try {
    const w = join(dir, 'world'), sock = join(dir, 'w.sock'), tokens = join(dir, 'tokens');
    await new Promise((ok, fail) => execFile(bin('worldd'), ['seed', '--facts', facts, '--dir', w, '--souls', '1', '--creator', creator],
      (e) => (e ? fail(e) : ok())));
    writeFileSync(tokens, '');
    await started(bin('worldd'), ['serve', '--dir', w, '--socket', sock], /(listening) /, procs, join(dir, 'worldd.log'));
    const directory = await started(bin('directoryd'), ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1', '--store', join(dir, 'directory'),
      '--test-sign-in', '--test-own', `creator=creator-${creator}`, '--pairing', join(dir, 'pairing.sqlite'), '--gateway-tokens', tokens], /listening on (\S+)\n/, procs, join(dir, 'directoryd.log'));
    const gw = await started(bin('gatewayd'), ['--listen', '127.0.0.1:0', '--world', sock, '--tokens', tokens, '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/, procs, join(dir, 'gatewayd.log'));
    return { directory: `http://${directory}`, gateway: `ws://${gw}/v2/ws`, kinds: join(w, 'world.kinds'), stop: () => procs.forEach((p) => p.kill()) };
  } catch (e) {
    procs.forEach((p) => p.kill());
    throw e;
  }
}

/** `pair.mjs --creator` into `home`; `person` approves on the card. Its last answer line. */
function pair(home, w, grant, person) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [PAIR, '--directory', w.directory, '--world', 'local', '--gateway', w.gateway, '--device', 'eval', '--label', 'creator eval', '--creator', grant],
      { env: { PATH: process.env.PATH, SOULS_HOME: home }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', async (d) => {
      out += d;
      const asked = out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.step === 'approve');
      if (asked && !p.approved) {
        p.approved = true;
        await fetch(new URL('/v1/pair/approve', w.directory), { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: asked.code, confirm: true, test_person: person }) });
      }
    });
    p.on('exit', () => ok(JSON.parse(out.trim().split('\n').at(-1) || '{}')));
  });
}

/** The agent's folder: the skill and the command, outside any repository; its home is paired below. */
function folder() {
  const at = mkdtempSync(join(tmpdir(), 'souls-creator-'));
  copyFileSync(SKILL, join(at, 'creator.md'));
  writeFileSync(join(at, 'souls-god.mjs'), `// The creator's command (Souls v2): runs v2/client/src/creator/souls-god.mjs.\nimport { spawnSync } from 'node:child_process';\nprocess.exitCode = spawnSync(process.execPath, [${JSON.stringify(GOD)}, ...process.argv.slice(2)], { stdio: 'inherit' }).status ?? 1;\n`);
  const home = join(at, '.souls');
  mkdirSync(join(home, 'kinds'), { recursive: true, mode: 0o700 });
  return { at, home };
}

/** The agent, in a clean environment: Read, the command and jq for its JSON output. Gives its transcript. */
function agent(at, { model, maxTurns }) {
  // USER and LOGNAME: the seat's sign-in is in the login keychain, which Claude Code finds by them.
  const env = { HOME: process.env.HOME, PATH: process.env.PATH, USER: process.env.USER ?? '', LOGNAME: process.env.LOGNAME ?? '', LANG: process.env.LANG ?? 'en_US.UTF-8', CLAUDE_CONFIG_DIR: process.env.SEAT_CONFIG_DIR, SOULS_HOME: join(at, '.souls'), SOULS_REPLICA_PKG: PKG };
  return new Promise((ok) => {
    execFile('claude', ['-p', TASK, '--output-format', 'stream-json', '--verbose', '--model', model, '--max-turns', String(maxTurns),
      '--allowedTools', 'Read', 'Bash(node souls-god.mjs:*)', 'Bash(jq:*)'], { cwd: at, env, maxBuffer: 64 << 20, timeout: 20 * 60_000 }, (e, stdout) => ok(stdout || String(e)));
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

/** What the run built: each node not in the world before (`before`, ids), by kind, with the kinds of its parents. */
function built(home, before) {
  return new Promise((ok, fail) => execFile(process.execPath, [GOD, 'describe'], { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG }, maxBuffer: 256 << 20 }, (error, out) => {
    let d;
    try { d = JSON.parse(String(out).trim().split('\n').at(-1) || '{}'); } catch { return fail(new Error('describe returned invalid JSON')); }
    if (error || d.ok === false || !Array.isArray(d.nodes)) return fail(new Error(`describe refused: ${d.code ?? 'no-world'}${d.detail ? `: ${d.detail}` : ''}`));
    const nodes = d.nodes;
    const kind = new Map(nodes.map((n) => [n.id, n.kind]));
    const parent = new Map(nodes.map((n) => [n.id, n.parent]));
    const path = (id) => { const p = []; for (let at = parent.get(id); at; at = parent.get(at)) p.push(kind.get(at)); return p; };
    const added = nodes.filter((n) => !before.has(n.id)).map((n) => ({ id: n.id, kind: n.kind, in: path(n.id).slice(0, 3) }));
    const rooms = added.filter((n) => /:room@/.test(n.kind)).map((r) => ({ id: r.id, holds: added.filter((n) => parent.get(n.id) === r.id).map((n) => n.kind) }));
    ok({ text: String(out), ids: new Set(nodes.map((n) => n.id)), added, rooms });
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pairOnly = args.includes('--pair-only');
  if (!pairOnly && !process.env.SEAT_CONFIG_DIR) { console.error('set SEAT_CONFIG_DIR to a signed-in Claude config directory'); process.exit(2); }
  const facts = resolve(opt('--facts', '.local/import-eden/eden-2026.facts.json'));
  const out = resolve(opt('--out', '.local/creator-eval'));
  const runs = Number(opt('--runs', 2)), model = opt('--model', 'sonnet'), maxTurns = Number(opt('--max-turns', 40));
  const all = [];
  for (let n = 1; n <= runs; n++) {
    const dir = join(out, `run-${n}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const creator = `${randomBytes(16).toString('hex')}-1`, grant = `creator-${creator}`, id = `c_${creator}`;
    const w = await world(dir, facts, creator);
    const f = folder();
    try {
      // A1: another account's approval is refused by name; the creator account's pairs the home.
      const refused = await pair(f.home, w, grant, 'someone-else');
      const paired = await pair(f.home, w, grant, 'creator');
      const pairing = { other: refused.code ?? null, creator: paired.ok ? paired.soul : paired.code };
      if (!paired.ok) throw new Error(`pairing refused: ${paired.code}`);
      copyFileSync(w.kinds, join(f.home, 'kinds', 'local.kinds'));
      // The gateway rereads the directory's token hashes every two seconds.
      await sleep(2200);
      let ready = false;
      for (let k = 0; k < 100; k++) {
        const s = await new Promise((ok) => execFile(process.execPath, [GOD, 'status'], { env: { PATH: process.env.PATH, SOULS_HOME: f.home, SOULS_REPLICA_PKG: PKG } }, (_, o) => ok(String(o))));
        let status;
        try { status = JSON.parse(s); } catch { /* a failed command is not ready */ }
        if (status?.connected && !status.syncing && Object.keys(status.roots ?? {}).length) { ready = true; break; }
        await sleep(200);
      }
      if (!ready) throw new Error('creator daemon did not become current within the readiness window');
      const before = await built(f.home, new Set());
      writeFileSync(join(dir, 'describe-before.json'), before.text);
      if (pairOnly) {
        const row = { run: n, pairing, nodes: before.ids.size, describeBytes: Buffer.byteLength(before.text) };
        console.log(JSON.stringify(row));
        all.push(row);
        continue;
      }
      const transcript = await agent(f.at, { model, maxTurns });
      writeFileSync(join(dir, 'transcript.jsonl'), transcript);
      const after = await built(f.home, before.ids);
      const runtime = join(f.home, 'souls', id, 'runtime');
      const files = readdirSync(runtime).filter((x) => statSync(join(runtime, x)).isFile()).map((x) => readFileSync(join(runtime, x), 'utf8'));
      const secret = JSON.parse(readFileSync(join(f.home, 'credentials.json'), 'utf8')).souls[id].local.token.split('.')[1];
      const leaked = [transcript, after.text, ...files].some((t) => t.includes(secret));
      const row = { run: n, model, pairing, ...measure(transcript), added: after.added, rooms: after.rooms, tokenFound: leaked };
      writeFileSync(join(dir, 'result.json'), JSON.stringify(row, null, 2) + '\n');
      console.log(JSON.stringify(row));
      all.push(row);
    } finally {
      const daemonLog = join(f.home, 'souls', id, 'runtime', 'daemon.log');
      try { copyFileSync(daemonLog, join(dir, 'daemon.log')); } catch {}
      await new Promise((ok) => execFile(process.execPath, [GOD, 'stop'], { env: { PATH: process.env.PATH, SOULS_HOME: f.home, SOULS_REPLICA_PKG: PKG } }, ok));
      w.stop();
      rmSync(f.at, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ runs: all.length, tokenFound: all.some((r) => r.tokenFound), pairing: all.map((r) => r.pairing), turns: all.map((r) => r.turns), refusals: all.map((r) => r.refusals) }));
}
