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
import { stamp } from './soul/stamp.mjs';

const SOUL = fileURLToPath(new URL('./soul/', import.meta.url)), RELEASED = join(SOUL, 'released/2.32.0');
// The hashes SOURCES.json recorded when 2.32.0 was released (#1875, commit 4914e6788).
const RECORDED = { 'eden.mjs': 'b714263638d766d6a272f4f2f625ec79ec7b803964fa1b270f85215eb0360c52', 'skill.md': '9e0f4b792648af9a1d2f1da1558354a409d0eac3998b50ed5f8c26cb8169d945' };
const released = (file) => gunzipSync(readFileSync(join(RELEASED, `${file}.gz`)));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const HIGHER = '99.0.0';

test('A1: the committed 2.32.0 client and skill are the bytes that release recorded', () => {
  for (const [file, hash] of Object.entries(RECORDED)) assert.equal(sha(released(file)), hash, file);
});

test('A2: the released 2.32.0 client upgrades itself to head from the server\'s real manifest', async (t) => {
  const tmp = (p) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
  // Head, stamped higher the way a release stamps it.
  const head = tmp('souls-compat-head-');
  cpSync(SOUL, head, { recursive: true, filter: (p) => !p.includes('/released') && !p.includes('/builds') });
  stamp(HIGHER, `${head}/`);
  const files = { '/eden.mjs': join(head, 'eden.mjs'), '/skill.md': join(head, 'skill.md') };
  // The three frozen paths: plain GETs, no redirect, no sign-in.
  const server = createServer((req, res) => { req.resume(); req.on('end', () => {
    const path = req.url.replace(/^\/w\/compat/, '');
    if (path === '/v1/config') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ devAuth: true, worldId: 'w', worldName: 'Compat', soulClient: soulClientManifest(files['/eden.mjs'], files['/skill.md']) })); }
    if (files[path]) return res.end(readFileSync(files[path]));
    res.writeHead(404); res.end('{}');
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
