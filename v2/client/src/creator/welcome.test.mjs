// A world's welcome and its recent visitors (#3702): `souls-god welcome` and `visitors` ask the world's directory with
// the creator's token from the home, name the world, and never print the token.

import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { requestOf } from './souls-god.mjs';

const GOD = join(dirname(fileURLToPath(import.meta.url)), 'souls-god.mjs');

test('welcome and visitors are directory requests', () => {
  assert.deepEqual(requestOf(['welcome', 'Tea at four.']).body, { welcome: 'Tea at four.' });
  assert.equal(requestOf(['welcome']).body.welcome, '', 'no words clears it');
  assert.equal(requestOf(['visitors']).directory, '/v1/worlds/visitors');
  assert.throws(() => requestOf(['welcome', 'two', 'words']), /quote the words/);
});

test('souls-god sets the welcome and reads the visitors as the creator, and prints no token', async () => {
  const scope = randomBytes(16).toString('hex'), secret = randomBytes(32).toString('hex');
  const token = `creator-${scope}-1.${secret}`;
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${token}`) return res.end(JSON.stringify({ refused: 'token-refused' }));
      if (req.url === '/v1/worlds/welcome') return res.end(JSON.stringify({ world: { name: 'garden', welcome: JSON.parse(body).welcome } }));
      res.end(JSON.stringify({ world: 'garden', welcome: 'Tea at four.', visitors: [{ soul: 'soul-ab-1', name: 'Rowan', arrived: 1, connected: true }] }));
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const dir = mkdtempSync(join(tmpdir(), 'souls-3702-'));
  const home = join(dir, '.souls');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ worlds: { garden: { url: `http://127.0.0.1:${server.address().port}`, gateway: 'ws://127.0.0.1:1/v2/ws' } } }));
  writeFileSync(join(home, 'credentials.json'), JSON.stringify({ souls: { [`c_${scope}-1`]: { garden: { token } } } }), { mode: 0o600 });
  const run = (...args) => new Promise((ok) => execFile(process.execPath, [GOD, ...args], { cwd: dir, env: { PATH: process.env.PATH } }, (e, stdout) => ok({ code: e?.code ?? 0, stdout })));
  try {
    const set = await run('welcome', 'Tea at four.');
    assert.deepEqual(JSON.parse(set.stdout), { ok: true, world: { name: 'garden', welcome: 'Tea at four.' } });
    const read = await run('visitors');
    assert.equal(JSON.parse(read.stdout).visitors[0].name, 'Rowan');
    assert.deepEqual(seen.map((s) => [s.path, s.body.world]), [['/v1/worlds/welcome', 'garden'], ['/v1/worlds/visitors', 'garden']]);
    for (const out of [set.stdout, read.stdout]) assert.ok(!out.includes(secret), 'no token printed');
  } finally {
    server.close();
  }
});
