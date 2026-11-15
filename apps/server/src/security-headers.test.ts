// #1006, #1017, #1025: every answer carries the shared security headers (security-headers.ts). The walk covers every
// route in the built app's route table (a world with edge, god and travel), an unknown path, an early middleware's
// refusal and onError; a route's own CSP keeps its directives. /mcp from an actual main.ts process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from '../test/native-owner-fixture.ts';
import {testPort} from '../test/test-port.ts';
import {buildApp} from './http.ts';
import {config} from './config.ts';
import {GodMode} from './god/god.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {SECURITY_HEADERS, withFrameAncestors} from './security-headers.ts';

function world(t: {after(fn: () => void): void}) {
  const f = fixture(':memory:'); f.brain.quiesce(); t.after(() => { f.host.stop(); f.db.close(); });
  const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:alice', tick: () => f.host.engine.world.tick, emit() {}});
  return buildApp({cfg: {...config, port: 5965, worldPath: '/w/eden', publicUrl: 'http://127.0.0.1:5965/w/eden', accountAuthRequired: false, inviteRequired: true, webDir: '/nonexistent-security-headers', marsWebDir: '/nonexistent-security-headers'}, db: f.db, host: f.host, auth: f.auth, brain: f.brain, souls: f.souls, edge: new EdgeLedger(f.host, f.db), god, hub: {clients: new Map(), refreshMe() {}, joinMessages: [], upgradeHandlers: []} as never});
}

/** What is missing or wrong in an answer's shared headers ('' when all are there). An indexable page may omit X-Robots-Tag. */
function lacks(r: Response, indexable = false): string {
  const out: string[] = [];
  if (!indexable && r.headers.get('x-robots-tag') !== SECURITY_HEADERS['X-Robots-Tag']) out.push(`x-robots-tag=${r.headers.get('x-robots-tag')}`);
  if (r.headers.get('x-frame-options') !== SECURITY_HEADERS['X-Frame-Options']) out.push(`x-frame-options=${r.headers.get('x-frame-options')}`);
  if (!/(^|;\s*)frame-ancestors 'none'/.test(r.headers.get('content-security-policy') ?? '')) out.push(`csp=${r.headers.get('content-security-policy')}`);
  return out.join(' ');
}

const ask = (app: {request(u: string, i: RequestInit): Response | Promise<Response>}, method: string, url: string, init: RequestInit = {}) =>
  Promise.race([
    Promise.resolve(app.request(url, {method, ...init, headers: {host: '127.0.0.1:5965', ...(method === 'GET' || method === 'HEAD' ? {} : {'content-type': 'application/json'}), ...(init.headers ?? {})}, ...(method === 'GET' || method === 'HEAD' ? {} : {body: init.body ?? '{}'})})),
    new Promise<null>(r => setTimeout(() => r(null), 3000).unref()),   // a long-poll that holds is not an answer yet
  ]);

test('every route in the route table answers with the shared security headers', async t => {
  const app = world(t), seen = new Set<string>(), failures: string[] = [];
  for (const r of app.routes) {
    const method = r.method === 'ALL' ? 'GET' : r.method, url = r.path.replace(/:[^/{]+(\{[^}]*\})?/g, 'x').replace(/\*/g, 'x');
    if (seen.has(`${method} ${url}`)) continue; seen.add(`${method} ${url}`);
    const res = await ask(app as never, method, url);
    if (res === null) continue;
    const why = lacks(res, method === 'GET' && ['/', '/SKILL.md', '/skill.md', '/instructions.md', '/llms.txt', '/cards.md'].includes(url));
    if (why) failures.push(`${method} ${url} (${r.path}) ${res.status}: ${why}`);
  }
  assert.ok(seen.size > 300, `the walk sees the whole route table (${seen.size})`);
  for (const early of ['GET /v1/edge/here', 'POST /v1/edge/act', 'POST /v1/god/act', 'GET /v1/world/visitors', 'GET /SKILL.md', 'POST /v1/souls/x/command']) assert.ok(seen.has(early), `${early} is walked`);
  assert.deepEqual(failures, []);
});

test('an unknown path, an early refusal and an error answer carry them too', async t => {
  const app = world(t);
  assert.equal(lacks((await ask(app as never, 'GET', '/no/such/path'))!), '');
  const big = await ask(app as never, 'POST', '/v1/edge/say', {body: JSON.stringify({pad: 'x'.repeat(1100 * 1024)})});
  assert.equal(big!.status, 413, 'the body ceiling refuses before any route');
  assert.equal(lacks(big!), '');
  const bad = await ask(app as never, 'POST', '/v1/souls', {body: 'not json', headers: {authorization: 'Bearer dev:alice'}});
  assert.ok(bad!.status >= 400); assert.equal(lacks(bad!), '');
  const page = await ask(app as never, 'GET', '/SKILL.md');
  assert.equal(page!.headers.get('x-robots-tag'), null, '#894: a public guide stays indexable');
});

test('a route CSP keeps its directives and gains frame-ancestors', () => {
  assert.equal(withFrameAncestors("default-src 'none'"), "default-src 'none'; frame-ancestors 'none'");
  assert.equal(withFrameAncestors(null), "frame-ancestors 'none'");
  assert.equal(withFrameAncestors("default-src 'self'; frame-ancestors *"), "default-src 'self'; frame-ancestors 'none'");
});

test('main.ts answers /mcp itself with the shared headers (actual process)', async t => {
  const port = await testPort(), base = `http://127.0.0.1:${port}/w/eden`, data = mkdtempSync(join(tmpdir(), 'security-headers-')), logs: string[] = [];
  const env: NodeJS.ProcessEnv = {PATH: process.env.PATH, DATA_DIR: data, WORLD_KEY: 'eden', WORLD_ID: 'security-headers-test', WORLD_PATH: '/w/eden', ENGINE: 'mars', SEED_NATIVES: '0', DEV_AUTH: '1', BRAIN_MODE: 'fake', BRAIN_BUDGET_USD_PER_DAY: '0', ARCHIVE_TAKES: '0', PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: base, BUILD_ID: 'security-headers-test'};
  const child: ChildProcess = spawn(process.execPath, [new URL('./main.ts', import.meta.url).pathname], {cwd: new URL('../../../', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout!.on('data', d => logs.push(String(d))); child.stderr!.on('data', d => logs.push(String(d)));
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); for (let i = 0; i < 200 && child.exitCode === null; i++) await delay(20); if (child.exitCode === null) child.kill('SIGKILL'); } rmSync(data, {recursive: true, force: true}); });
  let up = false;
  for (let i = 0; i < 1500 && !up; i++) { if (child.exitCode !== null) throw Error('main exited: ' + logs.join('')); try { up = (await fetch(base + '/healthz')).ok; } catch { /* not listening yet */ } if (!up) await delay(20); }
  assert.ok(up, 'main.ts started: ' + logs.join('').slice(-2000));
  for (const [method, headers] of [['POST', {}], ['GET', {authorization: 'Bearer nope'}]] as const) {
    const r = await fetch(base + '/mcp', {method, headers: {'content-type': 'application/json', ...headers}, ...(method === 'POST' ? {body: '{}'} : {})});
    assert.equal(r.status, 401, `${method} /mcp is refused without a soul token`);
    assert.equal(lacks(r), '', `${method} /mcp`);
  }
});
