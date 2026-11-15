// #2469: a world stopped inside a shard (startWorld with `exit`, as shard.mjs runs it) answers the requests still in
// flight 503 world.stopping, or closes them, at its stop. Its stopped code never answers them later: a world process's
// exit cut them; in a shard the program runs on, and before this they hung on the stopped world's closed database.
// One child process: a write whose body never finishes (so it is still in flight after the stop's write drain) and an
// idle keep-alive connection, then the stop.
import test from 'node:test'; import assert from 'node:assert/strict'; import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { testPort } from '../test/test-port.ts';

const here = (f: string) => new URL(f, import.meta.url).pathname;
const CHILD = `
const { request, Agent } = await import('node:http');
const { loadConfig } = await import(${JSON.stringify(here('./config.ts'))});
const { startWorld } = await import(${JSON.stringify(here('./world-main.ts'))});
const config = loadConfig(JSON.parse(process.argv[1]));
let exited = null;
const w = await startWorld(config, { exit: (code) => { exited = code; }, signals: false });
await w.listening;
// a write in flight: its body (100 bytes declared) never finishes
const inflight = new Promise((done) => {
  const req = request({ host: '127.0.0.1', port: config.port, method: 'POST', path: '/v1/god/claim', agent: false, headers: { authorization: 'Bearer dev:admin', 'content-type': 'application/json', 'content-length': '100' } }, (res) => {
    let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => done({ status: res.statusCode, body })); res.on('error', () => done({ closed: true, body }));
  });
  req.on('error', (e) => done({ closed: true, error: e.code })); req.write('{"a":'); });
// an idle keep-alive connection, left open by a first answered GET
const agent = new Agent({ keepAlive: true });
const first = await new Promise((done) => request({ host: '127.0.0.1', port: config.port, path: '/healthz', agent }, (res) => { res.resume(); res.on('end', () => done(res.statusCode)); }).end());
await new Promise((r) => setTimeout(r, 300));
const t0 = performance.now();
await w.shutdown('SIGTERM');
const answer = await Promise.race([inflight, new Promise((r) => setTimeout(() => r('none in 5 s'), 5000))]);
const idleSockets = Object.values(agent.sockets).flat().length + Object.values(agent.freeSockets).flat().filter((s) => !s.destroyed).length;
console.log('RESULT ' + JSON.stringify({ exited, first, answer, afterMs: Math.round(performance.now() - t0), connections: await new Promise((r) => w.server.getConnections((e, n) => r(e ? -1 : n))), idleSockets }));
process.exit(0);
`;

test('#2469: a world stopped in a shard answers its in-flight requests 503 world.stopping and closes its connections', { timeout: 180_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'world-stop-inflight-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const port = await testPort();
  const env = { WORLD_KEY: 'inflight', ENGINE: 'mars', MIND_DRIVER: 'central', WORLD_ID: 'stop-inflight', WORLD_PATH: '/w/stop-inflight', ENABLE_LIVING_WORLD: '1',
    DATA_DIR: join(root, 'w'), PORT: String(port), HOST: '127.0.0.1', PUBLIC_URL: `http://localhost:${port}`, BRAIN_MODE: 'fake', BRAIN_BUDGET_USD_PER_DAY: '0',
    SEED_NATIVES: '0', DEV_AUTH: '1', ARCHIVE_TAKES: '0', WRITE_DRAIN_MS: '200' };
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, JSON.stringify(env)], { cwd: root, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => child.once('exit', r));
  const line = out.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no result (exit ${code}): ${err.slice(-2000)}`);
  const r = JSON.parse(line.slice(7));
  t.diagnostic(JSON.stringify(r));
  assert.equal(r.exited, 0, 'the world ended through its exit, not the program');
  assert.equal(r.first, 200);
  assert.equal(r.answer?.status, 503, `the write in flight is answered by the stop: ${JSON.stringify(r.answer)}`);
  assert.equal(JSON.parse(r.answer.body).code, 'world.stopping');
  assert.equal(r.connections, 0, 'no connection to the stopped world is left open');
});
