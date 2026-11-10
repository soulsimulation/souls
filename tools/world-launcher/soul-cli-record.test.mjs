// #1773: the session record. Off is the client as if the feature did not exist; on, nothing anyone using the client sees
// changes either, and every command and world call is kept in .eden-record/ with its content but never a token.
// A fake world over HTTP, the real CLI as a child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordScrub } from './soul/eden.mjs';

const cli = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
const TOKEN = 'sim_s_ada_PLANTEDTOKEN0123', SPEECH = 'PLANTEDSPEECH said the world';

function world({ actPhase = 'completed' } = {}) {
  const seen = [];
  const answer = (req, body) => {
    const p = new URL(req.url, 'http://x').pathname.replace(/^\/w\/t/, '');
    if (p === '/v1/edge/act') return JSON.parse(body).capability === 'walk:no' ? { accepted: false, code: 'route.unreachable', reason: SPEECH, alternatives: [{ id: 'walk:yes', label: SPEECH }] } : { accepted: true, receipt: { id: 'r_1', capability: 'walk:yes', phase: actPhase, ...(actPhase === 'completed' ? { endedTick: 9 } : {}) } };
    // a world that echoes a credential back, by key and inside free text: neither may reach the record
    if (p === '/v1/edge/here') return { me: { name: 'Ada', posture: 'standing' }, heard: [{ text: `${SPEECH} ${TOKEN}` }], session: { token: TOKEN, pollSecret: 'abcdefghijklmnop' }, inbox: { queued: 0 } };
    if (p === '/v1/agent/me') return { soul: { id: 's_ada', name: 'Ada' } };
    return {};
  };
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body.replace(/"clientRef":"[^"]+"/, '"clientRef":"x"') });
      if (req.url.includes('/events') || req.url.includes('/listen') || req.url.includes('/wait')) {
        const acted = seen.some((s) => s.url.includes('/v1/edge/act')), events = acted && req.url.includes('/wait') ? { cursor: 'c_1', events: [{ kind: 'receipt', at: 1, receipt: { id: 'r_1', capability: 'walk:yes', phase: 'completed', endedTick: 9 } }] } : {};
        setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(events)); }, 200); return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'server-timing': 'world;dur=3' }); res.end(JSON.stringify(answer(req, body)));
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ seen, url: `http://127.0.0.1:${server.address().port}/w/t`, close: () => { server.closeAllConnections?.(); server.close(); } })));
}
const run = (cwd, ...args) => new Promise((ok) => {
  const c = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, EDEN_NO_NOW: '1' } }); let out = '', err = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; }); c.on('close', (code) => ok({ code, out, err }));
});
const folder = (url, on) => {
  const d = mkdtempSync(join(tmpdir(), 'eden-record-'));
  writeFileSync(join(d, '.eden-agent.json'), JSON.stringify({ world: url, soul: 's_ada', token: TOKEN }), { mode: 0o600 });
  if (on) writeFileSync(join(d, '.eden-record-on'), '');
  return d;
};
const recordText = (d) => { const dir = join(d, '.eden-record'); return existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('') : ''; };
const records = (d) => recordText(d).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const until = async (ok) => { for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 100)); };
const SCRIPT = [['help'], ['version'], ['here'], ['status'], ['act', 'walk:yes', '--for', 'none'], ['act', 'walk:no', '--for', 'none'], ['receipt', 'r_1'], ['bogus-command'], ['note', 'a', 'b']];

test('on changes nothing anyone using the client sees; off writes nothing', { timeout: 90_000 }, async () => {
  const a = await world(), b = await world(), off = folder(a.url, false), on = folder(b.url, true);
  try {
    for (const args of SCRIPT) {
      const x = await run(off, ...args), y = await run(on, ...args);
      assert.equal(x.code, y.code, args.join(' '));
      assert.equal(x.out.replaceAll(a.url, 'W'), y.out.replaceAll(b.url, 'W'), args.join(' '));
      assert.equal(x.err.replaceAll(a.url, 'W'), y.err.replaceAll(b.url, 'W'), args.join(' '));
    }
    await run(off, 'guide'); await run(on, 'guide');
    for (const f of ['CLAUDE.md', 'AGENTS.md']) if (existsSync(join(off, f))) assert.equal(readFileSync(join(off, f), 'utf8'), readFileSync(join(on, f), 'utf8'), f);
    assert.deepEqual(a.seen, b.seen, 'the same requests, on or off');
    assert.deepEqual(readdirSync(off).filter((f) => /record/.test(f)), [], 'off writes nothing');
    assert.deepEqual(readdirSync(on).filter((f) => /record/.test(f)).sort(), ['.eden-record', '.eden-record-on'], 'on: one folder beside the switch');
    assert.deepEqual(readdirSync(off).sort(), readdirSync(on).filter((f) => !/record/.test(f)).sort(), 'every other file the same');
  } finally { a.close(); b.close(); rmSync(off, { recursive: true, force: true }); rmSync(on, { recursive: true, force: true }); }
});

test('on: commands and world calls are kept with their content, ids and times, and never a token', { timeout: 60_000 }, async () => {
  const w = await world(), d = folder(w.url, true);
  try {
    await run(d, 'here'); await run(d, 'act', 'walk:no', '--for', 'none'); await run(d, 'act', 'walk:yes', '--for', 'none');
    const raw = recordText(d), rows = records(d);
    assert.ok(!raw.includes('PLANTEDTOKEN'), 'no token anywhere in the record');
    assert.ok(!/bearer/i.test(raw) && !raw.includes('abcdefghijklmnop'), 'no authorization header and no credential by key');
    assert.ok(raw.includes('PLANTEDSPEECH'), 'content is kept');
    assert.ok(rows.every((r) => r.v === 'soul-trace/2'));
    const starts = rows.filter((r) => r.kind === 'proc.start'), ends = rows.filter((r) => r.kind === 'proc.end');
    assert.equal(starts.length, 3); assert.equal(ends.length, 3);
    assert.deepEqual(starts[2].argv, ['walk:yes', '--for', 'none']); assert.equal(starts[2].command, 'act');
    assert.equal(ends[2].exitCode, 0); assert.match(ends[2].stdout, /r_1/); assert.ok(ends[2].wallStart > 0 && ends[2].ms >= 0);
    const acts = rows.filter((r) => r.kind === 'http' && r.path === '/w/t/v1/edge/act');
    assert.equal(acts.length, 2);
    assert.equal(acts[0].req.capability, 'walk:no'); assert.equal(acts[0].res.code, 'route.unreachable'); assert.equal(acts[0].via, 'direct');
    assert.equal(acts[1].res.receipt.id, 'r_1'); assert.deepEqual(acts[1].ids.receipts, ['r_1']); assert.ok(acts[1].ids.clientRef);
    assert.ok(acts[1].key, 'the idempotency key'); assert.deepEqual(acts[1].server, { world: 3 }); assert.equal(acts[1].status, 200);
    const here = rows.find((r) => r.kind === 'http' && r.path.startsWith('/w/t/v1/edge/here'));
    assert.equal(here.res.session.token, '[omitted]'); assert.match(here.res.heard[0].text, /\[omitted\]$/);
    const out = rows.find((r) => r.kind === 'proc.end' && /PLANTEDSPEECH/.test(r.stdout ?? ''));
    assert.ok(!out || !out.stdout.includes('PLANTEDTOKEN'));
  } finally { w.close(); rmSync(d, { recursive: true, force: true }); }
});

test('a command that handles codes or tokens keeps only its name, exit and times', { timeout: 60_000 }, async () => {
  const w = await world(), d = folder(w.url, true);
  try {
    // an account world: the window code goes to the world in the request body
    writeFileSync(join(d, '.eden-agent.json'), JSON.stringify({ world: w.url, worldId: 'w1', accountAuth: true }), { mode: 0o600 });
    await run(d, 'create', 'Ada', '--for', 'K7QX-M2PA');
    assert.ok(w.seen.some((x) => x.body.includes('K7QX-M2PA')), 'the code reached the world');
    const raw = recordText(d), start = records(d).find((r) => r.kind === 'proc.start');
    assert.ok(raw.length > 0 && !raw.includes('K7QX-M2PA') && !raw.includes('PLANTEDTOKEN'));
    assert.equal(start.command, 'create'); assert.equal(start.quiet, true); assert.equal(start.argv, undefined);
    assert.ok(records(d).filter((r) => r.kind === 'http' || r.kind === 'wire').every((r) => r.req === undefined && r.res === undefined));
  } finally { w.close(); rmSync(d, { recursive: true, force: true }); }
});

test('with serve up a command\'s call is kept once with its content, and serve keeps its own calls', { timeout: 60_000 }, async () => {
  const w = await world({ actPhase: 'started' }), d = folder(w.url, true);
  try {
    assert.equal((await run(d, 'serve')).code, 0);
    await run(d, 'here');
    await run(d, 'plan', '["walk:yes"]');
    await until(() => records(d).some((r) => r.kind === 'wire' && r.path.endsWith('/v1/edge/act')));
    await until(() => records(d).some((r) => r.kind === 'wire' && /\/v1\/edge\/(wait|inbox\/listen)/.test(r.path)));
    await run(d, 'serve', '--stop');
    await until(() => records(d).filter((r) => r.kind === 'proc.start').length === records(d).filter((r) => r.kind === 'proc.end').length);
    const rows = records(d), raw = recordText(d);
    assert.ok(!raw.includes('PLANTEDTOKEN'));
    const here = rows.filter((r) => /\/v1\/edge\/here/.test(r.path ?? ''));
    assert.equal(here.filter((r) => r.kind === 'http').length, 1); const asked = here.find((r) => r.kind === 'http'); assert.equal(asked.via, 'serve'); assert.ok(asked.res.me);
    const wire = here.find((r) => r.kind === 'wire');
    assert.ok(wire && wire.proxied && wire.res === undefined, 'serve keeps the wire time of a call it carried, not its content twice');
    assert.ok(rows.some((r) => r.kind === 'wire' && /\/v1\/edge\/(wait|events|inbox\/listen)/.test(r.path)), 'serve\'s own stream and inbox calls');
    const step = rows.find((r) => r.kind === 'wire' && r.path.endsWith('/v1/edge/act'));
    assert.equal(step.req.capability, 'walk:yes'); assert.ok(step.key);
    assert.ok(rows.some((r) => r.kind === 'proc.start' && r.command === 'serve' && r.argv.includes('--foreground')));
  } finally { w.close(); rmSync(d, { recursive: true, force: true }); }
});

test('a long session rolls its file and keeps under the cap, and says when it dropped the oldest', { timeout: 60_000 }, async () => {
  const w = await world(), d = folder(w.url, true), dir = join(d, '.eden-record');
  try {
    mkdirSync(dir);
    // sparse files: sizes without the bytes
    execFileSync('truncate', ['-s', String(17 * 1024 * 1024), join(dir, 'record.jsonl')]);
    for (let i = 1; i <= 31; i++) execFileSync('truncate', ['-s', String(16 * 1024 * 1024), join(dir, `record-${1000 + i}-aa.jsonl`)]);
    const x = await run(d, 'version');
    assert.equal(x.code, 0);
    const files = readdirSync(dir);
    assert.ok(!files.includes('record-1001-aa.jsonl') && files.includes('record-1031-aa.jsonl'), 'the oldest roll went first');
    const fresh = readFileSync(join(dir, 'record.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)), limit = fresh.find((r) => r.kind === 'limit');
    assert.ok(limit && limit.removed.includes('record-1001-aa.jsonl'));
    assert.ok(readFileSync(join(dir, 'record.jsonl'), 'utf8').includes('proc.start'), 'a fresh file');
  } finally { w.close(); rmSync(d, { recursive: true, force: true }); }
});

test('a record that cannot be written changes nothing for the command', { timeout: 60_000 }, async () => {
  const w = await world(), d = folder(w.url, true), plain = folder(w.url, false);
  try {
    mkdirSync(join(d, '.eden-record')); chmodSync(join(d, '.eden-record'), 0o555);
    const x = await run(d, 'here'), y = await run(plain, 'here');
    assert.deepEqual([x.code, x.out, x.err], [y.code, y.out, y.err]);
    writeFileSync(join(plain, '.eden-record'), 'not a folder'); writeFileSync(join(plain, '.eden-record-on'), '');
    const z = await run(plain, 'here');
    assert.deepEqual([z.code, z.out, z.err], [y.code, y.out, y.err]);
  } finally { chmodSync(join(d, '.eden-record'), 0o755); w.close(); rmSync(d, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true }); }
});

test('in a Souls home the switch in the runtime folder or the home\'s root turns it on, and the record is the Soul\'s', { timeout: 60_000 }, async () => {
  const w = await world(), home = folder(w.url, false);
  try {
    assert.equal((await run(home, 'import')).code, 0);
    const souls = join(home, '.souls', 'souls'), [id] = readdirSync(souls), runtime = join(souls, id, 'runtime');
    writeFileSync(join(home, '.eden-record-on'), '');
    assert.equal((await run(home, 'here')).code, 0);
    assert.ok(!existsSync(join(runtime, '.eden-record')) && !existsSync(join(home, '.eden-record')), 'the folder one stands in is not the switch');
    rmSync(join(home, '.eden-record-on'));
    writeFileSync(join(home, '.souls', '.eden-record-on'), '');
    assert.equal((await run(home, 'here')).code, 0);
    assert.ok(existsSync(join(runtime, '.eden-record', 'record.jsonl')), 'the home\'s switch: recorded in the Soul\'s runtime folder');
    rmSync(join(home, '.souls', '.eden-record-on')); rmSync(join(runtime, '.eden-record'), { recursive: true });
    writeFileSync(join(runtime, '.eden-record-on'), '');
    assert.equal((await run(home, 'here')).code, 0);
    assert.ok(existsSync(join(runtime, '.eden-record', 'record.jsonl')));
    const raw = readFileSync(join(runtime, '.eden-record', 'record.jsonl'), 'utf8');
    assert.ok(!raw.includes('PLANTEDTOKEN'), 'a home\'s token is not kept either');
  } finally { w.close(); rmSync(home, { recursive: true, force: true }); }
});

test('recordScrub: keys and values out, a long field cut and marked', () => {
  const s = new Set(['tok_123456789']);
  assert.deepEqual(recordScrub({ a: 'x tok_123456789 y', authorization: 'z', nested: [{ refreshToken: 'q', secret: 'w', ok: 1 }] }, s), { a: 'x [omitted] y', authorization: '[omitted]', nested: [{ refreshToken: '[omitted]', secret: '[omitted]', ok: 1 }] });
  const big = recordScrub({ t: 'x'.repeat(70 * 1024) }, s);
  assert.equal(big.cut, true); assert.ok(big.bytes > 70 * 1024); assert.equal(big.head.length, 64 * 1024);
});
