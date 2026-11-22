// #4038: the origin keeps the frozen upgrade answer after today's launcher is gone. The released 2.36.1 and 2.36.2 clients'
// first request gets the launcher's exact 426 (apps/server/src/client-minimum.ts); a current client and the routes a client
// upgrades through are untouched; and the frozen-world stand-in of the compat test (v2/client/test/compat) answers the
// same status and body. Run: node --test v2/tools/origin/upgrade-refusal.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { build } from '../../client/served/build.mjs';
import { frozenWorld } from '../../client/test/compat/frozen-world.mjs';
import { createOrigin } from './origin.mjs';

const RELEASED = fileURLToPath(new URL('../../client/test/compat/released/', import.meta.url));
const released = (version) => gunzipSync(readFileSync(join(RELEASED, version, 'eden.mjs.gz')));
const EXACT = (have) => ({ ok: false, code: 'client.upgrade-required', message: 'This Soul client is too old for this world. Run: node eden.mjs upgrade', min: '3.0.0', have, run: 'node eden.mjs upgrade' });

let dir, server, base;
before(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'v2-upgrade-refusal-')));
  for (const d of ['views', 'web', 'data', 'pkg']) mkdirSync(join(dir, d));
  writeFileSync(join(dir, 'pkg', 'replica.js'), 'export const test = true;');
  writeFileSync(join(dir, 'pkg', 'replica_bg.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  build({ out: join(dir, 'client'), version: '3.0.0', min: '3.0.0', pkg: join(dir, 'pkg') });
  ({ server } = createOrigin(join(dir, 'views'), { web: join(dir, 'web'), data: join(dir, 'data'), client: join(dir, 'client') }));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

const call = (path, headers = {}, auth = true) => fetch(`${base}${path}`, { headers: { ...(auth ? { authorization: 'Bearer sim_test' } : {}), ...headers } });

for (const version of ['2.36.1', '2.36.2']) test(`A1: released ${version} gets the exact 426 from the origin`, async () => {
  for (const path of ['/w/eden/v1/edge/here', '/w/eden/v1/agent/account']) {
    const r = await call(path, { 'x-soul-client': version });
    assert.equal(r.status, 426, path);
    assert.deepEqual(await r.json(), EXACT(version), path);
  }
});

test('A1: the released client prints the refusal against the origin itself', async () => {
  const d = join(dir, 'old'); mkdirSync(d);
  writeFileSync(join(d, 'eden.mjs'), released('2.36.2'));
  writeFileSync(join(d, '.eden-agent.json'), JSON.stringify({ world: `${base}/w/eden`, accountAuth: true, soul: 's_ada', token: 'sim_ada' }));
  const { code, err } = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['eden.mjs', 'here'], { cwd: d, env: { PATH: process.env.PATH, HOME: d, SOULS_PRINCIPAL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let e = ''; c.stderr.on('data', (x) => { e += x; }); c.stdout.resume(); c.on('exit', (code) => resolve({ code, err: e }));
  });
  assert.equal(code, 1);
  assert.match(err, /This Soul client is too old for this world: it needs 3\.0\.0 or newer, and this is 2\.36\.2\. Run: node eden\.mjs upgrade\n/);
});

test('A1: no header counts as 2.32.0', async () => {
  const r = await call('/w/eden/v1/edge/here');
  assert.equal(r.status, 426);
  assert.deepEqual(await r.json(), EXACT('2.32.0'));
});

test('A2: a current client, a header that is not a bare version, a call with no token and the upgrade routes are not refused', async () => {
  assert.notEqual((await call('/w/eden/v1/edge/here', { 'x-soul-client': '3.0.0' })).status, 426);
  assert.notEqual((await call('/w/eden/v1/edge/here', { 'x-soul-client': '3.1.0' })).status, 426);
  assert.notEqual((await call('/w/eden/v1/edge/here', { 'x-soul-client': 'browser' })).status, 426);
  assert.notEqual((await call('/w/eden/v1/edge/here', { 'x-soul-client': '2.36.1' }, false)).status, 426);
  for (const p of ['/w/eden/v1/config', '/w/eden/eden.mjs', '/w/eden/skill.md']) {
    const r = await call(p, { 'x-soul-client': '2.36.1' });
    assert.equal(r.status, 200, p);
  }
});

test('A3: the frozen-world stand-in answers the same status and body as the origin', async (t) => {
  const w = await frozenWorld({ client: Buffer.from('const VERSION = "3.0.0";\n') }); t.after(() => w.close());
  for (const version of ['2.36.1', '2.36.2', undefined]) {
    const headers = { authorization: 'Bearer sim_test', ...(version ? { 'x-soul-client': version } : {}) };
    const [stand, real] = await Promise.all([fetch(`${w.url}/v1/edge/here`, { headers }), fetch(`${base}/w/eden/v1/edge/here`, { headers })]);
    assert.equal(real.status, stand.status);
    assert.deepEqual(await real.json(), await stand.json());
  }
});
