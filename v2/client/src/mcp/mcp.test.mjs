// The MCP endpoint on Engine v2 (R21, #3334) against the real gateway (`gatewayd`, I1) and the world's end of it
// (`worldd gateway-link`) holding a room of 50 items, with the service run as its own process so its output can be
// read. Run from v2/ after cargo build -p gatewayd -p worldd --locked, and replica's wasm-bindgen package in
// target/wasm-load/pkg. R21_REPORT=1 prints the MCP transcript of the A1 test, for the PR.

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PKG, request } from '../daemon/client.mjs';
import { runtimeOf } from '../home/home.mjs';
import { mcpServerJson, PAGE, pageOf, TOOL_NAMES, TOOLS } from './tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const v2 = resolve(here, '../../..');
const GATEWAYD = process.env.GATEWAYD ?? join(v2, 'target/debug/gatewayd');
const WORLDD = process.env.WORLDD ?? join(v2, 'target/debug/worldd');
const PKG = process.env.SOULS_REPLICA_PKG ?? DEFAULT_PKG;
const CLI = join(here, '../cli/souls.mjs');
const ITEMS = 50, CALLS = 50;
// `worldd gateway-link`'s world mints from scope 2b: the place, the room, then each body and its lamp, then the items.
const WORLD_SCOPE = '2b'.repeat(16), FIRST_ITEM = 2 + 2 * 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tokenOf = (counter) => `soul-${WORLD_SCOPE}-${counter}.${randomBytes(32).toString('hex')}`;

const dir = mkdtempSync(join(tmpdir(), 'souls-r21-'));
const root = join(dir, 'm');
const mine = tokenOf(2), unknown = tokenOf(4); // the world's first body; the second's token, which the gateway never had
const procs = [];
const output = []; // everything the service printed
const transcript = [];
let base, rpcId = 0;

function run(bin, args, ready, sink) {
  const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return new Promise((ok, fail) => {
    let out = '';
    const take = (d) => { out += d; sink?.push(String(d)); const m = ready.exec(out); if (m) ok(m); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('exit', (c) => fail(new Error(`${bin} ended (${c}): ${out}`)));
  });
}

async function waitFor(f, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(20);
  }
}

/** One HTTP call to the endpoint. */
async function http(body, { token = mine, inPath = false, method = 'POST', raw } = {}) {
  const url = `${base}/w/local/mcp${inPath ? `/${token}` : ''}`;
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token && !inPath ? { authorization: `Bearer ${token}` } : {}) };
  const r = await fetch(url, { method, headers, ...(method === 'POST' ? { body: raw ?? JSON.stringify(body) } : {}) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
}

/** A JSON-RPC request as a host sends it; its result. */
async function rpc(method, params, { id = ++rpcId, ...opts } = {}) {
  const msg = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
  const r = await http(msg, opts);
  transcript.push({ sent: msg, got: r.body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(!r.body.error, JSON.stringify(r.body));
  return r.body.result;
}

/** A tool call; the daemon's answer, from the result's text. */
async function tool(name, args = {}, opts) {
  const result = await rpc('tools/call', { name, arguments: args }, opts);
  return JSON.parse(result.content[0].text);
}

/** The open session's home and Soul: the newest folder under the service's root (an older one may be closing). */
function session() {
  const [name] = readdirSync(root).filter((f) => /^[0-9a-f]{16}-\d+$/.test(f)).sort((x, y) => y.split('-')[1] - x.split('-')[1]);
  const soul = `s_${name.split('-')[0]}`;
  return { home: join(root, name), soul, rt: runtimeOf(join(root, name), soul) };
}

/** The thin command against the same session's daemon, as a harness runs it. */
function thin(args) {
  const { home, soul } = session();
  const r = spawnSync(process.execPath, [CLI, ...args, '--soul', soul], { env: { PATH: process.env.PATH, SOULS_HOME: home, SOULS_REPLICA_PKG: PKG }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}

before(async () => {
  const world = join(dir, 'w.sock'), tokens = join(dir, 'tokens.txt');
  writeFileSync(tokens, `soul-${WORLD_SCOPE}-2 ${createHash('sha256').update(mine).digest('hex')}\n`);
  procs.push(spawn(WORLDD, ['gateway-link', '--socket', world, '--lineage', randomBytes(16).toString('hex'), '--epoch', '1', '--rooms', '1', '--bodies', '2', '--items', String(ITEMS)], { stdio: 'ignore' }));
  await waitFor(() => { try { return statSync(world).isSocket(); } catch { return false; } });
  const [, gw] = await run(GATEWAYD, ['--listen', '127.0.0.1:0', '--world', world, '--tokens', tokens, '--build', `1220${'ab'.repeat(32)}`], /listening (\S+)\n/);
  const worlds = join(dir, 'worlds.json');
  writeFileSync(worlds, JSON.stringify({ local: `ws://${gw}/v2/ws` }));
  const [, addr] = await run(process.execPath, [join(here, 'server.mjs'), '--listen', '127.0.0.1:0', '--worlds', worlds, '--root', root, '--pkg', PKG], /listening (\S+)\n/, output);
  base = `http://${addr}`;
});

after(async () => {
  for (const p of procs.reverse()) { p.kill('SIGTERM'); await sleep(50); }
  await sleep(400);
  rmSync(dir, { recursive: true, force: true });
});

test('A1: a host given the URL and a token lists the six tools and uses each on the world', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-host', version: '1' } });
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.deepEqual(init.capabilities, { tools: { listChanged: false } });
  const note = await http({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202);
  const { tools } = await rpc('tools/list');
  assert.deepEqual(tools.map((t) => t.name), ['eden_status', 'eden_look', 'eden_find', 'eden_act', 'eden_wait', 'eden_stop']);
  const status = await tool('eden_status');
  assert.equal(status.ok, true);
  assert.equal(status.connected, true);
  const look = await tool('eden_look');
  assert.equal(look.room.name, 'room 1');
  const found = await tool('eden_find', { words: `item ${FIRST_ITEM + 7}` });
  assert.equal(found.found[0].name, `item ${FIRST_ITEM + 7}`);
  const act = await tool('eden_act', { verbs: ['eden:sit', 'eden:lean'] });
  assert.equal(act.ok, true);
  assert.equal(act.sent, true);
  const wait = await tool('eden_wait', { seconds: 2 });
  assert.equal(wait.ok, true);
  assert.ok(Array.isArray(wait.events));
  // The path form, for connector apps: the same session.
  assert.equal((await tool('eden_status', {}, { inPath: true })).pid, status.pid);
  const stop = await tool('eden_stop');
  assert.equal(stop.ok, true);
  await waitFor(() => readdirSync(root).length === 0, 30_000);
  // A bad argument is the host's error, not a daemon request.
  const bad = await http({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'eden_wait', arguments: { seconds: 600 } } });
  assert.equal(bad.body.error.code, -32602);
  if (process.env.R21_REPORT) console.log(JSON.stringify(transcript, null, 1));
});

const VOLATILE = ['age', 'stale', 'gap', 'asleep', 'rssBytes', 'heapBytes', 'upMs', 'started'];
/** An answer without what moves between two calls a moment apart: its age and the process's memory and uptime. */
function steady(answer) {
  const o = structuredClone(answer);
  for (const k of VOLATILE) delete o[k];
  return o;
}

/** Nothing in flight and nothing unread, so two calls in a row see the same. */
async function quiet() {
  const { rt } = session();
  await waitFor(async () => { const s = await request(rt.socket, { op: 'status' }); return s.unanswered.length === 0 && s.queued === 0 && !s.syncing; });
  await request(rt.socket, { op: 'read' });
}

test('A2: over 50 scripted calls, each tool\'s answer equals the thin command\'s to the same request at the same version', async () => {
  await tool('eden_look'); // opens the session; the first answer shows everything as new
  let rng = 21;
  const next = (n) => { rng = (rng * 1103515245 + 12345) % 2 ** 31; return (rng >>> 12) % n; };
  const counts = {};
  for (let k = 0; k < CALLS - 1; k++) {
    await quiet();
    const pick = TOOLS[next(5)];
    const args = pick.op === 'find' ? { words: `item ${FIRST_ITEM + next(ITEMS)}`, ...(next(2) ? { limit: 1 + next(10) } : {}) }
      : pick.op === 'act' ? { verbs: ['eden:sit', 'eden:lean'].slice(0, 1 + next(2)) }
        : pick.op === 'wait' ? { seconds: 0 } : {};
    const viaMcp = await tool(pick.name, args);
    const viaThin = thin(pick.argv(args));
    assert.equal(viaMcp.ok, true, JSON.stringify(viaMcp));
    if ('at' in viaMcp) assert.equal(viaThin.at, viaMcp.at, 'the same version');
    if (pick.op === 'act') {
      assert.equal(viaThin.sequence, viaMcp.sequence + 1, 'each act is its own intent');
      delete viaThin.sequence;
      delete viaMcp.sequence;
    }
    assert.deepEqual(steady(viaThin), steady(viaMcp), `${pick.name} ${JSON.stringify(args)}`);
    counts[pick.name] = (counts[pick.name] ?? 0) + 1;
  }
  // stop: each ends its session's daemon with the same answer; the next MCP call opens another.
  const stopped = await tool('eden_stop');
  await waitFor(() => readdirSync(root).length === 0, 30_000);
  await tool('eden_status');
  const thinStopped = thin(['stop']);
  assert.deepEqual(steady(thinStopped), steady(stopped));
  counts.eden_stop = 1;
  assert.equal(Object.values(counts).reduce((a, b) => a + b), CALLS);
  assert.equal(Object.keys(counts).length, TOOLS.length, `every tool compared: ${JSON.stringify(counts)}`);
  if (process.env.R21_REPORT) console.log(JSON.stringify({ compared: counts }));
});

test('A4: an act retried with the same request id acts once', async () => {
  const before = await tool('eden_status'); // a session gone with the thin command's stop is reopened
  const id = 'act-retry-1';
  const first = await tool('eden_act', { verbs: ['eden:sit'] }, { id });
  const again = await tool('eden_act', { verbs: ['eden:sit'] }, { id });
  assert.deepEqual(again, first);
  const after = await tool('eden_status');
  assert.equal(after.sent, before.sent + 1, 'one intent sent');
  assert.equal(after.sequence, before.sequence + 1);
  const other = await tool('eden_act', { verbs: ['eden:sit'] }, { id: 'act-retry-2' });
  assert.equal(other.sequence, first.sequence + 1, `a new id is a new act: ${JSON.stringify(other)}`);
});

test('A3: 401 without a token or with one the world refuses, 405 for a GET, 413 over 64 KB, no-store on all', async () => {
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const answers = [];
  for (const [opts, want] of [
    [{ token: null }, 401],
    [{ token: 'sim_not-a-v2-token' }, 401],
    [{ token: unknown, inPath: true }, 401], // well formed; the gateway refuses it
    [{ token: unknown }, 401], // refused again, without another session
    [{ method: 'GET' }, 405],
    [{ raw: JSON.stringify({ ...list, pad: 'x'.repeat(65 * 1024) }) }, 413],
  ]) {
    const r = await http(list, opts);
    answers.push(r.status);
    assert.equal(r.status, want, JSON.stringify(opts.token ? { ...opts, token: '…' } : opts));
    assert.equal(r.headers.get('cache-control'), 'no-store');
    if (want === 401) assert.equal(r.headers.get('www-authenticate'), 'Bearer');
  }
  assert.equal((await http({ jsonrpc: '2.0', id: 2, method: 'ping' })).status, 200, 'the good token still works');
  // The token is on disk only until its daemon has read it.
  const { home } = session();
  assert.equal(existsSync(join(home, 'credentials.json')), false);
});

test('A3: no token and no path reaches any log: the service\'s output and every file the sessions keep', async () => {
  const secrets = [mine, unknown].flatMap((t) => [t, t.split('.')[1]]);
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else if (f.isFile()) files.push(p); } };
  walk(root);
  const said = output.join('');
  assert.match(said, /session opened/);
  assert.match(said, /refused: a token the world refused/, 'the unknown token reached the world and was refused there');
  for (const [name, text] of [['service output', said], ...files.map((f) => [f, readFileSync(f, 'utf8')])]) {
    for (const s of secrets) assert.ok(!text.includes(s), `${name} holds a token`);
    assert.ok(!/\/w\/|\/mcp/.test(text), `${name} holds a path`);
  }
});

test('A5: the card and the page are generated from the tool table, and drift fails here', async () => {
  const card = await (await fetch(`${base}/.well-known/mcp/server.json`)).json();
  assert.deepEqual(card, mcpServerJson({ origin: base, version: '0.0.0-dev' }));
  assert.deepEqual(card._meta['io.modelcontextprotocol.registry/publisher-provided'].tools, [...TOOL_NAMES]);
  assert.equal(card.remotes[0].url, `${base}/w/{world}/mcp`);
  const page = readFileSync(PAGE, 'utf8');
  assert.equal(page, pageOf(), 'v2/docs/site/mcp.md drifted from the table: run node v2/client/src/mcp/tools.mjs --write');
  for (const name of TOOL_NAMES) assert.ok(page.includes(`### \`${name}\``), name);
});
