// node --test tools/world-launcher/agents-moved.test.mjs (launcher, a fake world and a fake directory)
// "Your agents" on a moved world: the page's GET /w/<slug>/v1/account/agents and POST .../agents/<id>/revoke are the
// directory's account logins, asked with the person's own sign-in; an old-engine world's go to its old process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLauncher } from './launcher.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';

test('a moved world\'s agents list and revoke are answered by the directory, never 404', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'launcher-agents-moved-'));
  const templatesDir = join(dir, 'templates'), webDir = join(dir, 'web'); mkdirSync(templatesDir); mkdirSync(webDir);
  const asked = [], logins = { alice: [{ id: 'g_1', agentLabel: 'Claude Code', device: { name: 'laptop' }, createdAt: 1000, lastUsedAt: null }] };
  const directory = createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const b = JSON.parse(body || '{}'), mine = logins[b.test_person];
      asked.push({ method: req.method, path: req.url, authorization: req.headers.authorization ?? null, body: b });
      const send = (s, j) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(j));
      if (req.method !== 'POST') return send(405, { refused: 'method' });
      if (!mine) return send(401, { refused: 'signed-out' });
      if (req.url === '/v1/account/agents') return send(200, { agents: mine });
      const id = /^\/v1\/account\/agents\/([^/]+)\/revoke$/.exec(req.url)?.[1], at = mine.findIndex((g) => g.id === id);
      if (at < 0) return send(409, { refused: 'not-found' });
      mine.splice(at, 1); send(200, { ok: true });
    });
  });
  await new Promise((ok) => directory.listen(0, '127.0.0.1', ok));
  const P = await testPort(5), base = `http://127.0.0.1:${P + 4}`, fake = new URL('./fake-world.mjs', import.meta.url).pathname;
  const binding = join(dir, 'binding.json'), routesFile = join(dir, 'routes.json');
  const L = await openLauncher({ port: P + 4, range: [P, P + 3], dataDir: join(dir, 'data'), webDir, templatesDir, eager: 0, log: () => {}, cutoverBindingFile: binding,
    v2DirectoryUrl: `http://127.0.0.1:${directory.address().port}`, command: (w, port) => ({ cmd: process.execPath, args: [fake], env: { ...process.env, WORLD_KEY: w.slug, PORT: String(port) } }) });
  t.after(async () => { await L.close(); directory.close(); rmSync(dir, { recursive: true, force: true }); });

  const r = await fetch(`${base}/__sim/worlds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Eden' }) });
  assert.equal(r.status, 201); const eden = (await r.json()).slug;
  writeFileSync(routesFile, JSON.stringify({ schema: 'souls/world-routes/1', worlds: { eden: { canonical: true, stream: '/s/eden/' } } }));
  writeFileSync(binding, JSON.stringify({ oldWorldId: `${eden}-1`, canonicalSlug: 'eden', routesFile, clientDir: dir }));
  await new Promise((ok) => setTimeout(ok, 1100));   // the launcher looks at the binding file once a second
  const call = (path, o = {}) => fetch(`${base}/w/${eden}/v1/account/agents${path}`, o).then(async (x) => ({ status: x.status, body: await x.json() }));
  const as = (who) => ({ authorization: `Bearer dev:${who}` });

  const listed = await call('', { headers: as('alice') });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.agents.map((g) => g.id), ['g_1']);
  assert.deepEqual(asked.at(-1), { method: 'POST', path: '/v1/account/agents', authorization: null, body: { test_person: 'alice' } }, 'asked as alice\'s own test sign-in');
  assert.equal((await call('', {})).status, 401, 'signed out: not asked');
  assert.equal((await call('', { headers: as('bob') })).status, 401, 'the directory\'s refusal stands');

  const revoked = await call('/g_1/revoke', { method: 'POST', headers: { ...as('alice'), 'content-type': 'application/json' }, body: '{}' });
  assert.deepEqual(revoked, { status: 200, body: { ok: true } }, 'the revoke is the directory\'s, not refused by the fence');
  assert.deepEqual((await call('', { headers: as('alice') })).body.agents, []);
  assert.equal((await call('/g_1/revoke', { headers: as('alice') })).status, 405, 'a revoke is a POST');
});
