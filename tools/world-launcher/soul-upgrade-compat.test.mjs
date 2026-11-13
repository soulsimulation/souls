// #1938: the upgrade interface is frozen (docs/architecture/api.md, "Soul client upgrade"). The released 2.32.0 client,
// committed gzipped, upgrades itself to a copy of head stamped higher, described by the server's own manifest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { soulClientManifest } from '../../apps/server/src/soul-client-manifest.ts';
import { refusalFor } from '../../apps/server/src/client-minimum.ts';
import { fixture } from '../../apps/server/test/native-owner-fixture.ts';
import { stamp } from './soul/stamp.mjs';

const SOUL = fileURLToPath(new URL('./soul/', import.meta.url)), RELEASED = join(SOUL, 'released/2.32.0');
// The hashes SOURCES.json recorded when 2.32.0 was released (#1875, commit 4914e6788).
const RECORDED = { 'eden.mjs': 'b714263638d766d6a272f4f2f625ec79ec7b803964fa1b270f85215eb0360c52', 'skill.md': '9e0f4b792648af9a1d2f1da1558354a409d0eac3998b50ed5f8c26cb8169d945' };
const released = (file) => gunzipSync(readFileSync(join(RELEASED, `${file}.gz`)));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const HIGHER = '99.0.0';
// The frozen `soulClient` fields (docs/architecture/api.md).
const FIELDS = ['bytes', 'contract', 'minVersion', 'sha256', 'skill', 'version'], SKILL_FIELDS = ['bytes', 'sha256', 'version'];

test('A1: the committed 2.32.0 client and skill are the bytes that release recorded', () => {
  for (const [file, hash] of Object.entries(RECORDED)) assert.equal(sha(released(file)), hash, file);
});

test('A2: the released 2.32.0 client upgrades itself to head from the server\'s real manifest', async (t) => {
  const tmp = (p) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
  // Head, stamped higher the way a release stamps it.
  const head = tmp('souls-compat-head-');
  cpSync(SOUL, head, { recursive: true, filter: (p) => !p.includes('/released') && !p.includes('/builds') });
  stamp(HIGHER, `${head}/`);
  const eden = join(head, 'eden.mjs'), skill = join(head, 'skill.md'), m = soulClientManifest(eden, skill);
  assert.deepEqual([Object.keys(m).sort(), Object.keys(m.skill).sort()], [FIELDS, SKILL_FIELDS], 'the frozen soulClient fields');
  // The server's own routes, reached with no sign-in; a redirect reaches the client, which refuses it.
  const f = fixture(':memory:'); f.brain.quiesce(); t.after(() => { f.host.stop(); f.db.close(); });
  f.souls.cfg.controllerCliFile = eden; f.souls.cfg.skillFile = skill;
  const server = createServer((req, res) => { req.resume(); req.on('end', async () => {
    const r = await f.app.request(req.url.replace(/^\/w\/compat/, ''));
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/w/compat`;

  const d = tmp('souls-compat-');
  writeFileSync(join(d, 'eden.mjs'), released('eden.mjs')); writeFileSync(join(d, 'SKILL.md'), released('skill.md'));
  const run = (...args) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['eden.mjs', ...args], { cwd: d, env: { ...process.env, HOME: d, SOULS_HOME: '', SOULS_PRINCIPAL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; c.stdout.on('data', (x) => { out += x; }); c.stderr.on('data', (x) => { err += x; });
    c.on('exit', (code) => { let j = null; try { j = JSON.parse(out); } catch { /* words */ } resolve({ code, d: j, err }); });
  });
  assert.equal((await run('register', url)).code, 0);
  const up = await run('upgrade', 'compat');
  assert.equal(up.code, 0, up.err);
  assert.deepEqual([up.d.upgraded, up.d.from, up.d.to, up.d.skill?.to], [true, '2.32.0', HIGHER, HIGHER], up.err);
  const after = await run('upgrade', 'compat');
  assert.equal(after.d?.version, HIGHER, `the installed client reports ${HIGHER}: ${after.err}`);
  assert.match(readFileSync(join(d, 'SKILL.md'), 'utf8'), new RegExp(`version: "${HIGHER}"`));
});

test('#1937: the released 2.32.0 client prints the refusal of a client below the world\'s minimum', async (t) => {
  // the server's own rule, with the world's minimum above the released client
  const server = createServer((req, res) => {
    const no = refusalFor(req.url.replace(/^\/w\/compat/, ''), req.headers['x-soul-client'], { minVersion: HIGHER, version: HIGHER }, () => req.headers.authorization === 'Bearer sim_ada');
    res.writeHead(no ? 426 : 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(no ?? { ok: true }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'souls-compat-old-'))); t.after(() => rmSync(d, { recursive: true, force: true }));
  writeFileSync(join(d, 'eden.mjs'), released('eden.mjs'));
  writeFileSync(join(d, '.eden-agent.json'), JSON.stringify({ world: `http://127.0.0.1:${server.address().port}/w/compat`, accountAuth: true, soul: 's_ada', token: 'sim_ada' }));
  const { code, err } = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['eden.mjs', 'here'], { cwd: d, env: { ...process.env, HOME: d, SOULS_HOME: '', SOULS_PRINCIPAL: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let e = ''; c.stderr.on('data', (x) => { e += x; }); c.on('exit', (n) => resolve({ code: n, err: e }));
  });
  assert.equal(code, 1);
  assert.match(err, /client\.upgrade-required: This Soul client is too old for this world\. Run: node eden\.mjs upgrade\n/);
});
