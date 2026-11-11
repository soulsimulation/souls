// #1937: a client below the world's minimum gets one frozen refusal (server), and stops with the command that fixes it (client).
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Hono} from 'hono';
import {clientMinimum} from './client-minimum.ts';
import {fixture} from '../test/native-owner-fixture.ts';

const EDEN = fileURLToPath(new URL('../../../tools/world-launcher/soul/eden.mjs', import.meta.url));
const HEAD = /const VERSION = "([0-9.]+)"/.exec(readFileSync(EDEN, 'utf8'))![1];
const MIN = '99.0.0';
const gate = (minVersion: string, version = minVersion, warn?: (l: string) => void) => {
  const app = new Hono();
  app.use('*', clientMinimum({served: () => ({minVersion, version}), isSoul: c => c.req.header('authorization') === 'Bearer sim_ada', warn}));
  app.all('*', c => c.json({ok: true}));
  return app;
};
const get = (app: {request: Hono['request']}, path: string, client?: string, token = 'sim_ada') =>
  app.request(path, {headers: {...(token ? {authorization: `Bearer ${token}`} : {}), ...(client === undefined ? {} : {'x-soul-client': client})}});

test('A1: a Soul request under /v1/edge or /v1/agent from a bare version below the minimum gets the frozen 426', async () => {
  const app = gate('3.0.0');
  for (const path of ['/v1/edge/here', '/v1/agent/me']) {
    const r = await get(app, path, '2.40.1');
    assert.equal(r.status, 426, path);
    assert.deepEqual(await r.json(), {ok: false, code: 'client.upgrade-required', message: 'This Soul client is too old for this world. Run: node eden.mjs upgrade', min: '3.0.0', have: '2.40.1', run: 'node eden.mjs upgrade'});
  }
  // no header is 2.32.0: refused under a 2.32.1 minimum, served under 2.32.0
  assert.equal((await (await get(gate('2.32.1'), '/v1/edge/here')).json()).have, '2.32.0');
  assert.equal((await get(gate('2.32.0'), '/v1/edge/here')).status, 200);
  // a header that is not a bare version, the minimum itself, no Soul token, another route: never refused
  for (const [path, client, token] of [['/v1/edge/here', 'bench/1', 'sim_ada'], ['/v1/edge/here', '2.40', 'sim_ada'], ['/v1/edge/here', '3.0.0', 'sim_ada'], ['/v1/edge/here', '1.0.0', ''], ['/v1/edge/here', '1.0.0', 'dev:alice'], ['/v1/souls/s_ada', '1.0.0', 'sim_ada'], ['/v1/edgeless', '1.0.0', 'sim_ada']])
    assert.equal((await get(app, path, client, token)).status, 200, `${path} ${client} ${token}`);
});

test('A2: the upgrade routes are never refused, and a minimum above the served client refuses nobody and warns', async (t) => {
  const f = fixture(':memory:'); f.brain.quiesce(); t.after(() => { f.host.stop(); f.db.close(); });
  t.mock.method(f.souls, 'soulFromToken', (tok?: string) => (tok === 'sim_ada' ? {id: 's_ada', owner: 'dev:alice'} : null));
  const warned = t.mock.method(console, 'warn', () => {});
  // the real app: its minimum (2.0.0) is below the client it serves, so a 1.0.0 Soul is refused under /v1/agent only
  assert.equal((await get(f.app, '/v1/agent/me', '1.0.0')).status, 426);
  for (const path of ['/v1/config', '/eden.mjs', '/skill.md', '/instructions.md']) assert.notEqual((await get(f.app, path, '1.0.0')).status, 426, path);
  assert.equal((await get(f.app, '/v1/config', '1.0.0')).status, 200);
  assert.equal((await get(f.app, '/eden.mjs', '1.0.0')).status, 200);
  // the served client is stamped below the minimum: nobody is refused, and that is said once
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'souls-min-'))); t.after(() => rmSync(d, {recursive: true, force: true}));
  writeFileSync(join(d, 'eden.mjs'), 'const VERSION = "1.0.0";\n'); f.souls.cfg.controllerCliFile = join(d, 'eden.mjs');
  for (const path of ['/v1/agent/me', '/v1/edge/here']) assert.notEqual((await get(f.app, path, '0.9.0')).status, 426, path);
  assert.equal(warned.mock.calls.filter(c => /minimum client 2\.0\.0 is above the served 1\.0\.0/.test(String(c.arguments[0]))).length, 1);
  const lines: string[] = [];
  assert.equal((await get(gate('3.0.0', '2.99.0', l => lines.push(l)), '/v1/edge/here', '1.0.0')).status, 200);
  assert.equal(lines.length, 1);
});

// The client side: head eden.mjs against a world that refuses it (the real middleware), and against a home's cached minimum.
async function world(t: TestContext, minVersion: string, config: object = {}) {
  const app = new Hono(), seen: string[] = [];
  app.use('*', async (c, next) => { seen.push(c.req.path); await next(); });
  app.use('*', clientMinimum({served: () => ({minVersion, version: minVersion}), isSoul: c => c.req.header('authorization') === 'Bearer sim_ada'}));
  app.get('/v1/config', c => c.json({accountAuthRequired: true, worldId: `w_${c.req.header('x-world')}`, worldName: 'Min', ...config}));
  app.all('*', c => c.json({ok: true}));
  const server = createServer((req, res) => { req.resume(); req.on('end', async () => {
    const r = await app.request(req.url!.replace(/^\/w\/[a-z-]+/, ''), {method: req.method, headers: {...req.headers as Record<string, string>, 'x-world': /^\/w\/([a-z-]+)/.exec(req.url!)?.[1] ?? ''}});
    res.writeHead(r.status, {'content-type': 'application/json'}); res.end(Buffer.from(await r.arrayBuffer()));
  }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return {base: `http://127.0.0.1:${(server.address() as {port: number}).port}/w`, seen};
}
function folder(t: TestContext) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'souls-min-cli-'))); t.after(() => rmSync(d, {recursive: true, force: true}));
  const run = (...args: string[]) => new Promise<{code: number | null; out: string; err: string; json: Record<string, unknown> | null}>((resolve) => {
    const c = spawn(process.execPath, [EDEN, ...args], {cwd: d, env: {...process.env, HOME: d, SOULS_HOME: '', SOULS_PRINCIPAL: ''}, stdio: ['ignore', 'pipe', 'pipe']});
    const kill = setTimeout(() => c.kill('SIGKILL'), 20_000);
    let out = '', err = ''; c.stdout.on('data', x => { out += x; }); c.stderr.on('data', x => { err += x; });
    c.on('exit', (code) => { clearTimeout(kill); let json = null; try { json = JSON.parse(out); } catch { /* words */ } resolve({code, out, err, json}); });
  });
  return {d, run};
}

test('A3: on the code a command fails with the run line, and serve stops and records why for status', async (t) => {
  const w = await world(t, MIN), {d, run} = folder(t);
  writeFileSync(join(d, '.eden-agent.json'), JSON.stringify({world: `${w.base}/min`, accountAuth: true, soul: 's_ada', token: 'sim_ada'}));
  const here = await run('here');
  assert.equal(here.code, 1);
  assert.match(here.err, new RegExp(`needs ${MIN} or newer, and this is ${HEAD}\\. Run: node eden\\.mjs upgrade\\n`));
  const served = await run('serve', '--foreground');
  assert.equal(served.code, 0, served.err);
  assert.match(served.err, /too old for the world .* stopping\. Run: node eden\.mjs upgrade/);
  const calls = w.seen.length;
  const after = await run('serve', '--status');
  assert.deepEqual([after.json?.serving, (after.json?.serveEnded as {code?: string})?.code, (after.json?.serveEnded as {run?: string})?.run], [false, 'client.upgrade-required', 'node eden.mjs upgrade']);
  const status = await run('status');
  assert.equal(status.code, 1);
  assert.deepEqual([status.json?.next, (status.json?.serveEnded as {code?: string})?.code], ['node eden.mjs upgrade', 'client.upgrade-required']);
  assert.equal(w.seen.length, calls + 1, 'nothing retried after serve stopped: only status asked again');
});

test('A3: a home\'s cached minimum fails that world\'s commands, not another world\'s, and never upgrade, help, version or doctor', async (t) => {
  const w = await world(t, '1.0.0', {soulClient: {contract: 'eden-edge/1', version: HEAD, bytes: 1, sha256: 'x', minVersion: '1.0.0'}}), {d, run} = folder(t);
  for (const slug of ['old', 'other']) assert.equal((await run('register', `${w.base}/${slug}`)).code, 0);
  const file = join(d, '.souls', 'config.json'), cfg = JSON.parse(readFileSync(file, 'utf8'));
  const key = Object.keys(cfg.worlds).find(k => cfg.worlds[k].url.endsWith('/old'))!, other = Object.keys(cfg.worlds).find(k => k !== key)!;
  cfg.worlds[key].minClient = MIN; writeFileSync(file, JSON.stringify(cfg));
  const refused = await run(`@${key}`, 'here');
  assert.equal(refused.code, 1);
  assert.match(refused.err, new RegExp(`needs ${MIN} or newer, and this is ${HEAD}\\. Run: node eden\\.mjs upgrade ${key}\\n`));
  assert.doesNotMatch((await run(`@${other}`, 'here')).err, /too old/);
  for (const args of [['version'], ['help'], ['doctor']]) assert.doesNotMatch((await run(...args)).err, /too old/, args[0]);
  assert.doesNotMatch((await run('upgrade', key)).err, /too old for this world/);
});
