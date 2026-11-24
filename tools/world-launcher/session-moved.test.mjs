// node --test tools/world-launcher/session-moved.test.mjs (launcher, a fake world and a fake directory)
// The page's sign-in check on a moved world: GET /w/<slug>/v1/account/session answers {accountId, issuer, subject} from
// the directory's POST /v1/account/session (which verifies the token), never 404, so a signed-in person is signed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLauncher } from './launcher.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';

test('a moved world\'s sign-in check is the directory\'s, never 404', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'launcher-session-moved-'));
  const templatesDir = join(dir, 'templates'), webDir = join(dir, 'web'); mkdirSync(templatesDir); mkdirSync(webDir);
  const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  const good = jwt({ iss: 'https://issuer.test', sub: 'user_1' }), asked = [];
  const directory = createServer((req, res) => {
    asked.push({ method: req.method, path: req.url, authorization: req.headers.authorization ?? null });
    const send = (s, j) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(j));
    if (req.method !== 'POST' || req.url !== '/v1/account/session') return send(404, { refused: 'not-found' });
    if (req.headers.authorization !== `Bearer ${good}`) return send(401, { refused: 'token-invalid' });
    send(200, { account: 'acct_1', principal: 'person' });
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
  const call = (headers = {}, method = 'GET') => fetch(`${base}/w/${eden}/v1/account/session`, { method, headers }).then(async (x) => ({ status: x.status, body: await x.json() }));

  assert.deepEqual(await call({ authorization: `Bearer ${good}` }), { status: 200, body: { accountId: 'acct_1', issuer: 'https://issuer.test', subject: 'user_1' } });
  assert.deepEqual(asked.at(-1), { method: 'POST', path: '/v1/account/session', authorization: `Bearer ${good}` });
  assert.equal((await call()).status, 401, 'signed out: not asked');
  assert.equal((await call({ authorization: `Bearer ${jwt({ iss: 'x', sub: 'y' })}` })).status, 401, 'the directory\'s refusal stands');
  assert.equal((await call({ authorization: `Bearer ${good}` }, 'POST')).status, 405);
});
