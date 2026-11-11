// #1936 A1: every request the client makes says which client it is (x-soul-client: <version>), through worldFetch and
// through each raw fetch. A fake world over HTTP, the real CLI as a child process, the real detached serve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
const VERSION = /^const VERSION = "([0-9.]+)";$/m.exec(readFileSync(cli, 'utf8'))[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('A1: a command, the catalog, the live picture and the event stream each carry x-soul-client', { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'eden-client-header-')), seen = [];
  const server = createServer((req, res) => {
    const p = new URL(req.url, 'http://w').pathname;
    seen.push([p, req.headers['x-soul-client']]);
    const json = (status, v) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (p === '/v1/edge/here') return json(200, { place: 'green' });
    if (p === '/v1/edge/catalog') return json(200, { contract: 'soul-catalog/1', worldId: 'w1', placeVerbs: [], anywhere: [], places: [{ id: 'p_town', name: 'Town', kind: 'district', parent: null, at: [0, 0] }], things: [], acts: [], counts: {} });
    if (p === '/v1/edge/live') return json(200, { contract: 'soul-live/1', tick: 1, souls: [{ id: 's_ada', name: 'Ada', at: [0, 0], place: 'p_town' }], speech: [] });
    if (p === '/v1/edge/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: hello\ndata: {"cursor":"c_0"}\n\n'); return undefined; }
    if (p === '/v1/edge/inbox/listen') return setTimeout(() => json(200, { inbox: { connected: true }, backlog: [] }), 200);
    if (p === '/v1/edge/wait') return setTimeout(() => json(200, { events: [], cursor: 'c_0' }), 200);
    return json(404, { error: { code: 'nope', message: p } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ world: `http://127.0.0.1:${server.address().port}`, soul: 's_ada', token: 'sim_s_synthetic' }), { mode: 0o600 });
  const run = (...args) => new Promise((ok) => { const c = spawn(process.execPath, [cli, ...args], { cwd: dir, stdio: 'ignore', env: { ...process.env, EDEN_NO_NOW: '1' } }); c.on('exit', ok); });
  t.after(async () => { await run('serve', '--stop'); await sleep(50); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });

  await run('here');
  await run('look');
  await run('serve');
  for (let i = 0; i < 100 && !seen.some(([p]) => p === '/v1/edge/events'); i++) await sleep(50);
  const header = (path) => seen.find(([p]) => p === path)?.[1];
  for (const path of ['/v1/edge/here', '/v1/edge/catalog', '/v1/edge/live', '/v1/edge/events']) assert.equal(header(path), VERSION, path);
  assert.deepEqual(seen.filter(([, h]) => h !== VERSION), [], 'every request this client made carries it');
});
