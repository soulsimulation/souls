// R17b (#3561), carried from tools/world-launcher/soul-home.test.mjs. Only fabricated homes, tokens and servers.
// Applicability of every original test (no skipped checks):
// - inline: served/loader belongs to R17, not these home commands; covered by served/ tests, unchanged here.
// - discovery: carried below through list in a nested folder and SOULS_HOME override.
// - secrets: carried below through list/default/doctor/export/import stdout and the sole 0600 credential file.
// - addressing: carried below for id/name/default and ambiguous twins; legacy prefix/name@world/retired semantics
//   belong to today's context dispatch; v2 uses --soul and W11 owns retirement.
// - A1 A5 A8 (two Souls): list/default/private credentials and export/import are carried below; register/create,
//   guides and the old one-request world API no longer apply to W2 and the resident v2 daemon.
// - A2 (adopt): carried below; W2's explicit Soul grant replaces account name lookup and --new creation.
// - A2 (pending approval): today's persisted approval API is replaced by W2; its request/poll boundary is exercised below.
// - A3 (doctor): dead locks, no token, orphan credentials and no-token output are carried below; account retirement
//   and adoptable-name enumeration belong to W11's directory My Souls, not this home command.
// - A3 (account doctor): unreachable world leaves residents intact is carried below; retired/replaced account API
//   status is W11, not v2's local doctor.
// - A4 (legacy import): not applicable; v2 imports its own transit folders, and R18 upgrades former homes.
// - world cannot write guide: not applicable; these commands never write a guide.
// - travel: not applicable; today's register/travel is explicitly outside this task.
// - import 1.9 delegations/identities/pending approvals: not applicable; those legacy imports belong to R18;
//   durable daemon cursor/sequence and memory movement is carried below.
// - re-pairing/name like command: carried below for a command-name selector and preserved cursor; already-here
//   refuses re-pairing in v2, and cross-world travel cursors do not apply.
// - A6 listen/serve concurrency: unchanged daemon R6, outside the six home commands.
// - picture location: no picture command changed here.
// - worlds by URL/empty-home guide: import world collision refuses below; home guide creation is R17, unchanged.
// - #1137 memory gitignore: not applicable to these commands; they do not initialize or repair gitignore.
// - #1137 owner gitignore bytes: not applicable; these commands never write gitignore.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as socketServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { atSocket, runtimeOf } from './home.mjs';
import { chooseSoul, exportSoul, importSoul, listSouls } from './commands.mjs';
import { build } from '../../served/build.mjs';

const CLI = fileURLToPath(new URL('../cli/souls.mjs', import.meta.url));
const A = `s_${'ab'.repeat(16)}-1`, B = `s_${'ab'.repeat(16)}-2`;
const token = (id) => `soul-${id.slice(2)}.${'cd'.repeat(32)}`;
const json = (file, value, mode = 0o600) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value), { mode }); chmodSync(file, mode); };
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const folder = (t) => { const p = mkdtempSync(join(tmpdir(), 'r17b-')); t.after(() => rmSync(p, { recursive: true, force: true })); return p; };
function fixture(t, ids = [A, B]) {
  const dir = folder(t), home = join(dir, '.souls');
  json(join(home, 'config.json'), { worlds: { eden: { url: 'https://directory.example/eden', gateway: 'wss://gateway.example/v2/ws', history: 'https://history.example/eden/' } }, souls: Object.fromEntries(ids.map((id, i) => [id, { name: i ? 'Say' : 'Mira', world: 'eden' }])) });
  json(join(home, 'credentials.json'), { souls: Object.fromEntries(ids.map((id) => [id, { eden: { token: token(id) } }])) });
  for (const id of ids) {
    mkdirSync(join(home, 'souls', id, 'memory', 'people'), { recursive: true });
    writeFileSync(join(home, 'souls', id, 'memory', 'people', 'friend.md'), 'A remembered friend.\nA promise kept.\n');
    writeFileSync(join(home, 'souls', id, 'MEMORY.md'), 'The Soul\u2019s own words.\n');
    const rt = runtimeOf(home, id);
    json(rt.state, { cursor: 'ab'.repeat(32), sequence: 17, unanswered: [16, 17], seen: 3 });
  }
  return { dir, home };
}
async function cli(home, args, { cwd = dirname(home), entry = CLI, extra = {} } = {}) {
  const child = spawn(process.execPath, [entry, ...args], { cwd, env: { PATH: process.env.PATH, BRAIN_MODE: 'fake', SOULS_HOME: home, ...extra } });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((ok) => child.on('close', ok));
  const lines = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const id of [A, B]) assert.ok(!out.includes(token(id).split('.')[1]), 'no fabricated token secret in output');
  return { code, out, err, lines, value: lines.at(-1) };
}
const durable = (home, id) => new Map(['MEMORY.md', 'memory/people/friend.md', 'runtime/daemon.json'].map((f) => [f, readFileSync(join(home, 'souls', id, f))]));

test('A1 carried addressing and two-Soul list/default: ambiguous names refuse, default and --soul select across dispatch paths', async (t) => {
  const { dir, home } = fixture(t);
  const rows = (await cli(home, ['list'])).value.souls;
  assert.deepEqual(rows, [{ id: A, name: 'Mira', world: 'eden', default: false }, { id: B, name: 'Say', world: 'eden', default: false }]);
  const unclear = await cli(home, ['status']);
  assert.equal(unclear.code, 1); assert.equal(unclear.value.code, 'which-soul');
  assert.match(unclear.value.detail, /Mira.*Say/);
  assert.equal((await cli(home, ['default', 'Say'])).value.default.id, B);
  assert.equal(chooseSoul(home), B);
  assert.equal(chooseSoul(home, 'Mira'), A);
  assert.equal(chooseSoul(home, A), A);
  for (const args of [['digest'], ['schedule', 'list'], ['digest', '--soul', 'Mira']]) {
    const result = await cli(home, args);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(result.value.soul, args.includes('Mira') ? A : B);
  }
  const cfg = read(join(home, 'config.json')); cfg.souls[A].name = 'Say'; delete cfg.default;
  json(join(home, 'config.json'), cfg);
  assert.throws(() => chooseSoul(home, 'Say'), { code: 'which-soul' });
  assert.throws(() => chooseSoul(home, 'unknown'), { code: 'no-such-soul' });
  const nested = join(dir, 'notes', 'today'); mkdirSync(nested, { recursive: true });
  const found = await cli(home, ['list'], { cwd: nested, extra: { SOULS_HOME: '' } });
  assert.equal(found.value.souls.length, 2, 'nearest home is discovered');
  const blank = join(dir, 'different');
  assert.deepEqual((await cli(blank, ['list'], { cwd: nested })).value.souls, [], 'explicit home wins');
});

test('A1 carried names after R18 aliases: old names/default select the current v2 id, and a sole token needs no name', (t) => {
  const { home } = fixture(t, [A]);
  const config = read(join(home, 'config.json'));
  config.souls = { s_former: { name: 'Mira', world: 'eden', state: 'active' } }; config.default = 's_former';
  json(join(home, 'config.json'), config);
  json(join(home, 'aliases.json'), { version: 'souls-aliases/1', ids: { s_former: A } });
  assert.equal(chooseSoul(home, 'Mira'), A); assert.equal(chooseSoul(home), A);
  assert.equal(listSouls(home)[0].default, true);
  config.souls = {}; delete config.default; json(join(home, 'config.json'), config);
  assert.equal(chooseSoul(home), A); assert.equal(listSouls(home)[0].name, null);
});

test('command selection refuses a tokenless Soul with only a stale socket and a live pid in its lock', async (t) => {
  const { home } = fixture(t, [A]), rt = runtimeOf(home, A);
  rmSync(join(home, 'credentials.json'));
  json(rt.lock, { pid: process.pid });
  writeFileSync(rt.socket, 'not a listening daemon');
  const refused = await cli(home, ['status', '--soul', A]);
  assert.equal(refused.code, 1, refused.out + refused.err);
  assert.equal(refused.value.code, 'no-such-soul');
  assert.deepEqual(read(rt.lock), { pid: process.pid }, 'selection starts no replacement daemon');
  assert.equal(existsSync(rt.log), false);
});

test('A2 carried export/import: real CLI moves exact memory, private token and cursor/sequence; source and transit disappear after verification', async (t) => {
  const { dir, home } = fixture(t);
  const before = durable(home, A), rt = runtimeOf(home, A), state = read(rt.state);
  json(rt.lock, { pid: 2 ** 30 }); writeFileSync(rt.socket, 'stale socket'); writeFileSync(rt.log, 'old runtime log');
  const transit = join(dir, 'transit');
  // A dead lock with a non-socket placeholder is cleared by doctor first, without touching durable state.
  const cfg = read(join(home, 'config.json')); cfg.worlds = {}; json(join(home, 'config.json'), cfg);
  await cli(home, ['doctor']); cfg.worlds.eden = { url: 'https://directory.example/eden', gateway: 'wss://gateway.example/v2/ws', history: 'https://history.example/eden/' }; json(join(home, 'config.json'), cfg);
  const exported = await cli(home, ['export', 'Mira', '--out', transit]);
  assert.equal(exported.code, 0, exported.out + exported.err);
  assert.equal(exported.value.soul, A);
  assert.equal(existsSync(join(home, 'souls', A)), false);
  assert.equal(read(join(home, 'credentials.json')).souls[A], undefined);
  assert.ok(read(join(home, 'credentials.json')).souls[B], 'another Soul stays');
  assert.equal(statSync(join(transit, 'credentials.json')).mode & 0o777, 0o600);
  assert.deepEqual(read(join(transit, 'credentials.json')), { souls: { [A]: { eden: { token: token(A) } } } });
  for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(transit, 'souls', A, name)), bytes);
  for (const name of ['daemon.lock', 'daemon.sock', 'daemon.log']) assert.equal(existsSync(join(transit, 'souls', A, 'runtime', name)), false);
  assert.ok(!readFileSync(join(transit, 'soul.json'), 'utf8').includes(token(A)));
  const next = join(folder(t), '.souls');
  const imported = await cli(next, ['import', transit], { cwd: dir });
  assert.equal(imported.code, 0, imported.out + imported.err);
  assert.equal(existsSync(transit), false);
  assert.equal(read(join(next, 'credentials.json')).souls[A].eden.token, token(A));
  assert.equal(statSync(join(next, 'credentials.json')).mode & 0o777, 0o600);
  for (const [name, bytes] of before) assert.deepEqual(readFileSync(join(next, 'souls', A, name)), bytes);
  assert.deepEqual(read(runtimeOf(next, A).state), state);
  assert.equal(listSouls(next)[0].name, 'Mira'); assert.equal(listSouls(home).length, 1);
});

test('A2 move refuses collisions, open credentials and symlinks without removing the source', async (t) => {
  const { dir, home } = fixture(t, [A]), transit = join(dir, 'transit');
  mkdirSync(transit);
  await assert.rejects(exportSoul(home, A, transit), { code: 'destination-exists' });
  assert.ok(read(join(home, 'credentials.json')).souls[A]);
  rmSync(transit, { recursive: true });
  const outside = join(dir, 'outside'); writeFileSync(outside, 'kept');
  symlinkSync(outside, join(home, 'souls', A, 'memory', 'linked'));
  await assert.rejects(exportSoul(home, A, transit), { code: 'unsupported-home-file' });
  assert.ok(existsSync(join(home, 'souls', A)));
  rmSync(join(home, 'souls', A, 'memory', 'linked'));
  await exportSoul(home, A, transit);
  chmodSync(join(transit, 'credentials.json'), 0o644);
  const to = join(dir, 'next');
  assert.throws(() => importSoul(to, transit), { code: 'copy-not-verified' });
  assert.ok(existsSync(transit)); assert.equal(existsSync(to), false);
  chmodSync(join(transit, 'credentials.json'), 0o600);
  json(join(to, 'config.json'), { worlds: { eden: { url: 'https://other.example/', gateway: 'wss://other.example/v2/ws' } } });
  assert.throws(() => importSoul(to, transit), { code: 'world-conflict' });
  assert.ok(existsSync(transit)); assert.equal(existsSync(join(to, 'credentials.json')), false);
});

test('A2 an active daemon is stopped and its final cursor/sequence bytes move, without starting a daemon for an idle Soul', async (t) => {
  const { dir, home } = fixture(t, [A]), rt = runtimeOf(home, A);
  json(rt.lock, { pid: process.pid });
  const final = { cursor: 'final', sequence: 23, unanswered: [23] };
  const s = socketServer((c) => c.once('data', (data) => {
    assert.deepEqual(JSON.parse(String(data)), { op: 'stop' });
    json(rt.state, final); rmSync(rt.lock); s.close();
    c.end('{"ok":true}\n');
  }));
  await new Promise((ok) => atSocket(rt.socket, (path) => s.listen(path, ok)));
  t.after(() => s.close());
  const to = join(dir, 'moved');
  await exportSoul(home, A, to);
  assert.deepEqual(read(join(to, 'souls', A, 'runtime', 'daemon.json')), final);
});

test('A2 concurrent exports at the stale-lock boundary move once and put the token in exactly one transit folder', async (t) => {
  const { dir, home } = fixture(t, [A]), first = join(dir, 'first'), second = join(dir, 'second');
  const preload = join(dir, 'boundary.mjs');
  writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync, write = fs.writeFileSync;
const stage = process.env.MOVE_STAGE, release = process.env.MOVE_RELEASE;
const pause = () => { write(stage, 'ready'); const until = Date.now() + 10000; while (!fs.existsSync(release)) { if (Date.now() > until) throw Error('boundary timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } };
let reads = 0, copied = false;
fs.readFileSync = (file, ...args) => {
  let bytes, error; try { bytes = read(file, ...args); } catch (e) { error = e; }
  if (process.env.MOVE_ROLE === 'contender' && String(file).endsWith('/daemon.lock') && ++reads === 2) pause();
  if (error) throw error; return bytes;
};
fs.writeFileSync = (file, ...args) => {
  const result = write(file, ...args);
  if (process.env.MOVE_ROLE === 'winner' && !copied && String(file).startsWith(process.env.MOVE_OUT + '/credentials.json.')) { copied = true; pause(); }
  return result;
};
syncBuiltinESMExports();\n`);
  const launch = (role, out) => {
    const stage = join(dir, `${role}.stage`), release = join(dir, `${role}.release`);
    const child = spawn(process.execPath, ['--import', preload, CLI, 'export', A, '--out', out], { env: { PATH: process.env.PATH, BRAIN_MODE: 'fake', SOULS_HOME: home, MOVE_ROLE: role, MOVE_OUT: out, MOVE_STAGE: stage, MOVE_RELEASE: release } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    const job = { stage, release, child, ended: false };
    job.done = new Promise((ok) => child.on('close', (code) => { job.ended = true; ok({ code, stdout, stderr }); }));
    t.after(() => { if (!job.ended) { if (existsSync(dir)) writeFileSync(release, 'release'); child.kill(); } });
    return job;
  };
  const until = async (ready) => { const end = Date.now() + 5000; while (!ready()) { assert.ok(Date.now() < end, 'lock-boundary synchronization timed out'); await new Promise((r) => setTimeout(r, 10)); } };
  const contender = launch('contender', second);
  await until(() => existsSync(contender.stage) || contender.ended);
  assert.ok(existsSync(contender.stage), 'contender read the stale/absent daemon lock');
  const winner = launch('winner', first);
  await until(() => existsSync(winner.stage) || winner.ended);
  writeFileSync(contender.release, 'release');
  const c = await contender.done;
  writeFileSync(winner.release, 'release');
  const w = await winner.done;
  const copies = [first, second].filter((out) => existsSync(join(out, 'credentials.json')) && read(join(out, 'credentials.json')).souls[A]?.eden.token === token(A));
  assert.equal(copies.length, 1, 'only one transit folder receives the private token');
  assert.equal([c, w].filter((r) => r.code === 0).length, 1, 'one export succeeds');
  assert.equal(existsSync(join(home, 'souls', A)), false);
  assert.equal(read(join(home, 'credentials.json')).souls[A], undefined);
  for (const r of [c, w]) assert.ok(!r.stdout.includes(token(A).split('.')[1]), 'no token in either output');
});

test('A3 carried adopt: W2 asks for an owned grant, never new; connected refusal and force preserve local cursor and print no token', async (t) => {
  const dir = folder(t), home = join(dir, '.souls'), requests = [];
  let connected = false;
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/w/eden/views/world.json') return res.end('{"history":"history/"}');
    // The pairing's entries fetch (#3760) reaches this stand-in for the gateway too: it serves none.
    if (req.method === 'GET' && req.url.endsWith('/v2/entries')) { res.statusCode = 404; return res.end('{"refused":"entries-not-served"}'); }
    let raw = ''; for await (const bytes of req) raw += bytes;
    const body = JSON.parse(raw); requests.push({ path: req.url, body });
    if (req.url.endsWith('/request')) {
      if (connected && !body.force) return res.end('{"refused":"soul-connected"}');
      return res.end(JSON.stringify({ link: 'https://directory.example/pair', code: 'BCDF-GHJK', interval: 0 }));
    }
    connected = true; return res.end(JSON.stringify({ grant: `soul-${A.slice(2)}`, token: token(A) }));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/eden`;
  const first = await cli(home, ['adopt', A, url], { cwd: dir });
  assert.equal(first.code, 0, first.out + first.err); assert.equal(first.value.paired, true);
  assert.equal(read(join(home, 'config.json')).worlds.eden.history, new URL('/w/eden/history/', url).href);
  assert.deepEqual(first.lines[0], { ok: true, step: 'approve', link: 'https://directory.example/pair', code: 'BCDF-GHJK' });
  assert.equal(requests[0].body.soul, `soul-${A.slice(2)}`); assert.equal('new' in requests[0].body, false);
  const count = requests.length;
  assert.equal((await cli(home, ['adopt', A], { cwd: dir })).value.code, 'already-here');
  assert.equal(requests.length, count, 'no second pairing or Soul');
  const next = join(dir, 'next');
  json(join(next, 'config.json'), { worlds: { eden: { url, gateway: `ws://127.0.0.1:${server.address().port}/v2/ws` } } });
  const rt = runtimeOf(next, A); json(rt.state, { cursor: 'keep', sequence: 11 });
  assert.equal((await cli(next, ['adopt', `soul-${A.slice(2)}`], { cwd: dir })).value.code, 'soul-connected');
  const forced = await cli(next, ['adopt', A, '--force'], { cwd: dir });
  assert.equal(forced.code, 0, forced.out + forced.err); assert.equal(requests.findLast((r) => r.path.endsWith('/request')).body.force, true);
  assert.deepEqual(read(rt.state), { cursor: 'keep', sequence: 11 });
  assert.equal(statSync(join(next, 'credentials.json')).mode & 0o777, 0o600);
  const conflict = join(dir, 'conflict');
  json(join(conflict, 'config.json'), { worlds: { eden: { url: 'https://other.example/eden', gateway: 'wss://other.example/v2/ws' } } });
  assert.equal((await cli(conflict, ['adopt', B, url], { cwd: dir })).value.code, 'world-conflict');
  assert.equal(existsSync(join(conflict, 'credentials.json')), false, 'no credentials or existing world overwritten');
});

test('A4 carried doctor: clears dead locks, keeps live locks and residents, reports unreachable/no-token/orphans, repairs mode, prints no token', async (t) => {
  const { home } = fixture(t), rtA = runtimeOf(home, A), rtB = runtimeOf(home, B);
  const creds = read(join(home, 'credentials.json')); delete creds.souls[B]; creds.souls.s_ghost = { lost: { token: 'fabricated-credential-only' } };
  json(join(home, 'credentials.json'), creds, 0o644);
  json(rtA.lock, { pid: 2 ** 30 }); writeFileSync(rtA.socket, 'dead socket');
  json(rtB.lock, { pid: process.pid });
  const server = createServer((_, res) => res.end('reachable'));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const address = `http://127.0.0.1:${server.address().port}/`;
  const config = read(join(home, 'config.json')); config.worlds.eden.gateway = address; json(join(home, 'config.json'), config);
  const up = await cli(home, ['doctor']);
  assert.equal(up.value.worlds[0].checked, 'reachable');
  assert.deepEqual(up.value.locksCleared, [{ soul: A, lock: 'daemon.lock' }]);
  assert.ok(!existsSync(rtA.socket)); assert.ok(existsSync(rtB.lock));
  assert.deepEqual(up.value.noToken, [B]);
  assert.deepEqual(up.value.orphanCredentials, [{ principal: 's_ghost', world: 'lost' }]);
  assert.ok(!up.out.includes('fabricated-credential-only'));
  assert.equal(statSync(join(home, 'credentials.json')).mode & 0o777, 0o600);
  await new Promise((ok) => server.close(ok));
  const before = listSouls(home), down = await cli(home, ['doctor']);
  assert.deepEqual(down.value.unreachable, ['eden']);
  assert.deepEqual(listSouls(home), before, 'unreachable never retires a resident');
});

test('A5 served eden.mjs carries the home commands, needs no WASM for list, and keeps every token private', async (t) => {
  const { dir, home } = fixture(t, [A]), out = join(dir, 'served');
  build({ out, version: '0.0.0' });
  const result = await cli(home, ['list'], { entry: join(out, 'eden.mjs') });
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(result.value.souls[0].id, A);
  assert.equal(readdirSync(join(home, 'souls')).length, 1);
});
