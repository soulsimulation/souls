#!/usr/bin/env node
// A fresh live agent from the one-line onboarding prompt, then plain asks (0.133 Q1 b). The world is a hello-hamlet
// template on the new engine (world.mjs) with two apples on the green, and a second Soul, Moss (a scripted seat that
// stands on the green and accepts every conversation, touch and gift). The client files a world serves (eden.mjs,
// skill.md, instructions.md, replica) are built by `v2/client/served/build.mjs` and answered in front of the world as
// `v2/client/served/serve.mjs` as the front door answers them. The agent starts in an empty folder with the line
// docs/site/for-agents.md gives an owner, approves nothing itself (the harness approves its pairing code as the
// test person would), then gets each ask as the owner's next chat line, one turn each. Each ask is classified from the
// agent's own `node eden.mjs` calls and their answers:
//   one-call   its first world intent was taken (done, or sent) and nothing was refused
//   retry      something was refused, and a later intent was taken
//   refused    it ended in a refusal (or the client's error) it could not act on
//   no-intent  it sent nothing to the world (answered in words)
//
//   node tools/playtest/arena/new-engine/onboard.mjs [--asks <file.json>] [--only 1,2] [--model sonnet] [--out <dir>]
//
// Live seats run on the existing Claude login (live.mjs useSeatLogin). Prints the table as JSON and writes
// <out>/onboard.json.
import { execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isMain } from '../../../lib/is-main.mjs';
import { REPO_ROOT } from '../../../lib/paths.mjs';
import { sleep } from '../../lib/clock.mjs';
import { turn } from '../adapters/claude-headless.mjs';
import { startWorld, stopWorld, exportFacts } from './world.mjs';
import { pairSeat, REPLICA_PKG } from './seat.mjs';
import { LIVE_ALLOWED, useSeatLogin, commandsFromStream, intentsOf, refusalRate } from './live.mjs';

/** The one line an owner gives their agent (docs/site/for-agents.md, "Pair with a Soul in one pass"). */
export const ONE_LINE = (world, name) => `Read the instructions at ${world}instructions.md to create a new soul in the world ${name}.`;

/** Twenty plain asks a person would make, in an order that a Soul in the hamlet can follow. */
export const ASKS = [
  'Go to the cottage.',
  'Now head over to the pond.',
  'Go into the presentation hall.',
  'Sit down on a chair in there.',
  'Get up and go back out to the green.',
  'Wave.',
  'Say hello to everyone nearby.',
  'Go over to Moss and say hi.',
  'Ask Moss how their day is going.',
  'Shake hands with Moss.',
  'Give Moss a hug.',
  'Pick up an apple.',
  'Give the apple to Moss.',
  'Pick up the other apple and put it down by a bench.',
  'Sit on a bench.',
  'Stand up.',
  'Dance with Moss.',
  'Jog over to the waterside hall.',
  'Lie down somewhere comfortable.',
  'Clap your hands.',
];

/** Things added to a genesis's facts: [{kind (an entry's name), ref, name, at: [x, z] metres}]. */
export function placeThings(facts, things) {
  for (const t of things) {
    if (!facts.kinds.some((k) => k.ref === t.ref)) facts.kinds.push({ ref: t.ref, hash: Buffer.from(`souls/playtest/${t.ref}`).toString('hex').padEnd(64, '0').slice(0, 64), name: t.kind, form: 'point' });
    const [x, z] = t.at.map((m) => Math.round(m * 1000));
    facts.things.push({ id: `e_${t.ref.replace(/\W/g, '_')}_${facts.things.length}`, def: t.ref, ref: t.ref, parent: null, pose: [x, 0, z, 0], world: [x, 0, z, 0], scale_ppm: 1_000_000, name: t.name, slots: [] });
  }
  return facts;
}

/** One ask's turn → its class, from the agent's world intents. */
export function classify(intents) {
  if (!intents.length) return 'no-intent';
  const refused = intents.some((i) => i.end === 'refused'), last = intents.at(-1);
  if (!refused) return 'one-call';
  if (last.end !== 'refused' || intents.slice(intents.findIndex((i) => i.end === 'refused')).some((i) => i.end !== 'refused')) return 'retry';
  return 'refused';
}

/** The pairing code the agent printed (`{"step":"approve","code":…}` in a tool result), or null. */
export function codeIn(stream) {
  for (const e of stream) if (e?.type === 'user') for (const c of e.message?.content ?? []) if (c.type === 'tool_result') {
    const text = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x) => x.text ?? '').join('\n');
    const m = /"code"\s*:\s*"([A-Z0-9-]{4,})"/.exec(text) ?? /"step"\s*:\s*"approve"[^}]*"code"\s*:\s*"([^"]+)"/.exec(text);
    if (m && /approve/.test(text)) return m[1];
  }
  return null;
}

/** The files a world serves its agents, by name (as v2/client/served/serve.mjs answers them), read from `served`. */
const SERVED = { 'eden.mjs': 'text/javascript', 'replica.js': 'text/javascript', 'replica_bg.wasm': 'application/wasm', 'skill.md': 'text/markdown',
  'creator.md': 'text/markdown', 'instructions.md': 'text/markdown', 'safety.md': 'text/markdown' };
function answer(served, path) {
  const name = /\/([a-z_.]+)$/.exec(path.replace(/\/llms\.txt$/, '/instructions.md'))?.[1];
  if (/\/v1\/config$/.test(path)) return { status: 200, type: 'application/json', body: Buffer.from(JSON.stringify({ soulClient: JSON.parse(readFileSync(join(served, 'soul-client.json'), 'utf8')) })) };
  if (!SERVED[name] || !existsSync(join(served, name))) return null;
  return { status: 200, type: SERVED[name], body: readFileSync(join(served, name)) };
}

/** The world's address with the served client files in front, as the front door mounts them: every other request, a
 *  gateway's WebSocket upgrade included, goes on to the front door unchanged. */
async function standIn(served, upstream) {
  const up = new URL(upstream);
  const server = createServer((req, res) => {
    const a = req.method === 'GET' || req.method === 'HEAD' ? answer(served, new URL(req.url, 'http://x').pathname) : null;
    if (a) { res.writeHead(a.status, { 'content-type': a.type, 'content-length': a.body.length }); return res.end(req.method === 'HEAD' ? undefined : a.body); }
    const p = httpRequest({ host: up.hostname, port: up.port, method: req.method, path: req.url, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(p);
  });
  server.on('upgrade', (req, sock, head) => {
    const c = connect(Number(up.port), up.hostname, () => {
      c.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head?.length) c.write(head);
      c.pipe(sock); sock.pipe(c);
    });
    c.on('error', () => sock.destroy()); sock.on('error', () => c.destroy());
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/** Moss: stands on the green and accepts what it is offered, answering a conversation once. */
function responder(moss, log) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      const w = await moss.cli('wait', '15').catch(() => null);
      for (const e of w?.events ?? []) {
        if (e.kind === 'conversation' && e.what === 'invited') { await moss.cli('converse', 'accept', e.conversation); await moss.cli('converse', 'say', e.conversation, "I'm well, thanks for asking. Lovely day on the green."); log(`moss: joined ${e.conversation}`); }
        else if (e.kind === 'together' && e.what === 'offered') { const r = await moss.cli('together', 'accept', e.offer); log(`moss: accepted ${e.touch} ${r.ok !== false ? 'ok' : r.code}`); }
        else if (e.kind === 'give' && e.what === 'offered') { const r = await moss.cli('give', 'accept', e.offer); log(`moss: took ${e.thing} ${r.ok !== false ? 'ok' : r.code}`); }
      }
      if (!w) await sleep(1000);
    }
  })();
  return { stop: () => { stopped = true; } };
}

export async function onboard({ out, asks = ASKS, only = null, model = 'sonnet', template = 'worlds/templates/hello-hamlet.json', worldName = 'Hello Hamlet', log = (m) => process.stderr.write(`[onboard] ${m}\n`) }) {
  useSeatLogin();
  out = resolve(out); mkdirSync(out, { recursive: true });
  const served = join(out, 'served');
  execFileSync(process.execPath, [join(REPO_ROOT, 'v2/client/served/build.mjs'), '--out', served, '--version', '0.1.0', '--pkg', REPLICA_PKG], { stdio: ['ignore', 'ignore', 'inherit'] });
  const facts = exportFacts(template, join(out, 'genesis.facts.json'));
  writeFileSync(facts, JSON.stringify(placeThings(JSON.parse(readFileSync(facts, 'utf8')), [
    { kind: 'eden:apple', ref: 'q1-apple@1', name: 'a red apple', at: [3, 2] }, { kind: 'eden:apple', ref: 'q1-apple@1', name: 'a green apple', at: [2.4, 3.2] }])));
  // The agent's folder is outside this checkout: the client finds its home by walking up from the folder it runs in,
  // and a checkout can sit below a real Souls home (whose Souls are live). Refused if any folder above holds one,
  // before anything starts.
  const rows = [], agentDir = realpathSync(mkdtempSync(join(tmpdir(), 'souls-q1-agent-')));
  for (let d = dirname(agentDir); d !== dirname(d); d = dirname(d)) if (existsSync(join(d, '.souls'))) throw new Error(`a Souls home above the agent's folder (${d}): refused`);
  writeFileSync(join(out, 'agent-folder.txt'), agentDir + '\n');
  const world = await startWorld({ facts, dir: join(out, 'world') });
  let front = null, moss = null, resp = null;
  try {
    front = await standIn(served, world.base);
    const page = `${front.url}/w/dev/`;
    log(`world ${page}`);
    moss = await pairSeat({ world, dir: join(out, 'seats'), label: 'moss', name: 'Moss' });
    await moss.join();
    resp = responder(moss, log);

    let sessionId = randomUUID(), n = 0;
    const turns = [];
    const say = async (text, why) => {
      const r = await turn({ cwd: agentDir, sessionId, resume: n++ > 0, model, text, allowedTools: LIVE_ALLOWED, maxWallSec: 300, ctxMax: 0 });
      sessionId = r.sessionId ?? sessionId;
      writeFileSync(join(out, `turn-${String(n).padStart(2, '0')}.jsonl`), r.stream.map((e) => JSON.stringify(e)).join('\n') + '\n');
      const commands = commandsFromStream(r.toolCalls), intents = intentsOf(commands);
      const t = { n, why, text, wallMs: r.wallMs, exit: r.exit, timedOut: r.timedOut, tools: r.toolCalls.length, commands: commands.map((c) => c.words.join(' ')), intents, final: String(r.finalText ?? '').slice(0, 400), costUsd: r.usage?.costUsd ?? null };
      turns.push(t);
      log(`turn ${n} (${why}): ${Math.round(r.wallMs / 1000)} s, ${r.toolCalls.length} tools, ${intents.map((i) => `${i.words[0]}:${i.end}${i.cause ? `(${i.cause})` : ''}`).join(' ')}`);
      return { r, t };
    };

    // the one line, then the owner's approval of whatever code the agent printed, as the person would at the link; an
    // agent that stopped short (its own harness's permission rule, say) is told to go ahead, as its owner would, twice
    const onboarding = { prompt: ONE_LINE('<world>/', worldName), turns: 0, codeShown: false, approved: false, joined: false };
    for (let text = ONE_LINE(page, worldName); onboarding.turns < 3 && !onboarding.approved; text = 'Yes, go ahead.') {
      const t = await say(text, 'onboard');
      onboarding.turns++;
      const code = codeIn(t.r.stream);
      if (!code) continue;
      onboarding.codeShown = true;
      const a = await fetch(new URL('/v1/pair/approve', world.directory), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, confirm: true, test_person: 'owner' }) });
      onboarding.approved = a.status === 200;
      log(`approved ${code}: ${a.status}`);
      await sleep(2000);
      const second = await say('Done, I approved it on the card.', 'approved');
      onboarding.joined = second.t.intents.some((i) => /join/.test(i.words.join(' ')) && i.end !== 'refused');
    }
    const pick = asks.map((text, i) => ({ i: i + 1, text })).filter((a) => !only || only.has(a.i));
    for (const a of pick) {
      const { t } = await say(a.text, `ask ${a.i}`);
      rows.push({ ask: a.i, text: a.text, class: classify(t.intents), intents: t.intents.map((x) => ({ words: x.words.join(' '), end: x.end, cause: x.cause })), wallMs: t.wallMs, final: t.final });
    }
    const all = turns.flatMap((t) => t.intents);
    const result = { onboarding, rows, counts: Object.fromEntries(['one-call', 'retry', 'refused', 'no-intent'].map((k) => [k, rows.filter((r) => r.class === k).length])), refusals: refusalRate(all), turns };
    writeFileSync(join(out, 'onboard.json'), JSON.stringify(result, null, 1));
    return result;
  } finally {
    resp?.stop(); await moss?.stop(); front?.close(); await stopWorld(world);
    // the agent's own Soul daemon, started by its client in its folder: stopped by its pid, never by a pattern
    for (const l of execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n')) if (l.includes(agentDir)) { try { process.kill(Number(l.trim().split(' ')[0])); } catch { /* gone */ } }
  }
}

if (isMain(import.meta.url)) {
  const a = process.argv.slice(2), opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const asks = opt('--asks') ? JSON.parse(readFileSync(opt('--asks'), 'utf8')) : ASKS;
  const only = opt('--only') ? new Set(opt('--only').split(',').map(Number)) : null;
  const r = await onboard({ out: opt('--out') ?? join(REPO_ROOT, '.local/q1/onboard', new Date().toISOString().replace(/[:.]/g, '-')), asks, only, model: opt('--model') ?? 'sonnet' });
  process.stdout.write(JSON.stringify({ onboarding: r.onboarding, counts: r.counts, refusals: r.refusals, rows: r.rows.map((x) => [x.ask, x.class, x.intents.map((i) => `${i.words} → ${i.end}${i.cause ? ` ${i.cause}` : ''}`)]) }, null, 1) + '\n');
}
