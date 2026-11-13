// #2248: a Soul's local dashboard. Through the real CLI, with the world unreachable: the page and /data.json, the refusals,
// no secret in any answer, the template and an owner's page, and `help dashboard`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE } from './soul/dashboard.mjs';

const cli = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
const TOKEN = 'sim_s_a1_0123456789abcdefSECRETTOKEN', POLL = 'poll-secret-0123456789abcdefghijklmnopqrstuvwxyz0';
const today = new Date().toISOString().slice(0, 10);

/** A world that takes no request: every connection is cut at once, and counted. */
async function deadWorld(t) {
  const world = { connections: 0 };
  const server = createServer(() => {});
  server.on('connection', (s) => { world.connections++; s.destroy(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  world.url = `http://127.0.0.1:${server.address().port}/w/a`;
  return world;
}
/** A home with one Soul, Mira, its memory on disk and serve's log, and a credentials file holding its token and a poll secret. */
function home(t, worldUrl) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'soul-dashboard-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const h = join(root, '.souls'), soul = join(h, 'souls', 's_a1'), runtime = join(soul, 'runtime'), memory = join(soul, 'memory');
  for (const d of [runtime, join(memory, 'journal'), join(memory, 'people'), join(soul, 'worlds')]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const json = (file, v) => writeFileSync(file, JSON.stringify(v), { mode: 0o600 });
  json(join(h, 'config.json'), { version: 1, client: null, default: null, currentWorld: 'a', worlds: { a: { url: worldUrl } }, souls: { s_a1: { name: 'Mira', world: 'a', state: 'active' } }, gods: {}, accounts: {}, activeAccount: {} });
  json(join(h, 'credentials.json'), { version: 1, souls: { s_a1: { a: { token: TOKEN } } }, worlds: {}, approvals: { a: { pollSecret: POLL } }, gods: {}, accounts: {}, logins: {} });
  json(join(runtime, 'state.json'), { world: worldUrl, soul: 's_a1' });
  json(join(soul, 'worlds', 'a.json'), { world: 'a', url: worldUrl, role: 'home', soul: 's_a1', place: 'p_mill', placeName: 'The mill', posture: 'standing', lastSeen: null });
  writeFileSync(join(memory, 'self.md'), `# Self\n\n- I am Mira. (a note that once quoted ${POLL})\n`);
  writeFileSync(join(memory, 'goals.md'), '# Goals — model judgments\n\n- [g1] Meet the miller. Next: walk to the mill\n');
  writeFileSync(join(memory, 'people', 'Ivo-0123456789ab.md'), '# Ivo [eden]\n\nMet at the mill.\n');
  writeFileSync(join(memory, 'ledger.md'), '# Ledger — normalized public facts\n\n## Holding\n\n## Observed budget by UTC day\n2026-11-12: known USD 0.010000; unknown USD records 0; calls 3\n');
  writeFileSync(join(memory, 'journal', `${today}.md`), `# ${today}\n\n- 08:00:00Z Arrived at The mill [p_mill]. Bearer ${TOKEN}\n`);
  writeFileSync(join(memory, 'journal', '2026-11-01.md'), '# 2026-11-01\n\n- 09:00:00Z Woke.\n');
  symlinkSync(join(h, 'credentials.json'), join(memory, 'journal', '2026-01-02.md'));   // a link out of the folder
  linkSync(join(h, 'credentials.json'), join(memory, 'journal', '2026-01-03.md'));      // a second name for the credentials
  writeFileSync(join(runtime, '.eden-serve.log'), Array.from({ length: 250 }, (_, i) => `line ${i} ${i === 249 ? `token ${TOKEN}` : ''}`).join('\n') + '\n');
  return { root, runtime, memory };
}
const run = (cwd, args) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, HOME: cwd, SOULS_HOME: '', SOULS_PRINCIPAL: '', BRAIN_MODE: 'fake' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
  const done = new Promise((r) => child.on('exit', (code) => r({ code, out, err })));
  const started = new Promise((resolve, reject) => {
    child.stdout.on('data', () => { try { resolve(JSON.parse(out)); } catch { /* not all of it yet */ } });
    child.on('exit', () => reject(new Error(`dashboard exited: ${err}`)));
  });
  started.catch(() => {});   // a run that is not a dashboard (--template, help) ends on its own
  return { child, done, started };
};
const seen = [];   // every body any answer carried
function get(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => { seen.push(body); resolve({ status: res.statusCode, type: res.headers['content-type'], body }); });
    });
    req.on('error', reject); req.end();
  });
}

test('dashboard: the page and dashboard-data/1 for one Soul, with the world unreachable and no serve', async (t) => {
  const world = await deadWorld(t), { root } = home(t, world.url);
  const d = run(root, ['dashboard', '--port', '0']);
  t.after(() => d.child.kill());
  const said = await d.started, port = Number(new URL(said.dashboard).port);
  assert.match(said.dashboard, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(said.soul, 'Mira');
  assert.match(said.resident, /no serve here/);

  const page = await get(port, '/');
  assert.equal(page.status, 200); assert.match(page.type, /text\/html/); assert.equal(page.body, PAGE);
  const r = await get(port, '/data.json'), data = JSON.parse(r.body);
  assert.equal(data.version, 'dashboard-data/1');
  assert.deepEqual(data.status.soul, { id: 's_a1', name: 'Mira' });
  assert.equal(data.status.world, world.url);
  assert.equal(data.status.place.name, 'The mill');
  assert.equal(data.status.now, null);
  assert.equal(data.status.link.paired, true);
  assert.match(data.status.client, /^\d+\.\d+\.\d+$/);
  assert.equal(data.resident.up, false);
  assert.equal(data.plan, null);
  assert.equal(data.wakes.budget.budget, 'normal'); assert.equal(data.wakes.budget.deliveredLastHour, 0); assert.ok(data.wakes.rules.some((r) => r.id === 'owner-message'));
  assert.equal(data.journal.today, today); assert.match(data.journal.page, /Arrived at The mill/);
  assert.ok(data.journal.days.includes('2026-11-01'));
  assert.match(data.memory.self, /I am Mira/); assert.match(data.memory.goals, /Meet the miller/);
  assert.equal(data.memory.lessons, null, 'a part that does not exist yet is null');
  assert.deepEqual(data.memory.people, ['Ivo']);
  assert.match(data.cost, /^2026-11-12: known USD 0\.010000/);
  assert.equal(data.log.length, 200); assert.equal(data.log[0], 'line 50 ');
  const day = await get(port, '/journal/2026-11-01');
  assert.equal(day.status, 200); assert.match(day.body, /Woke/);
  assert.equal((await get(port, '/journal/2026-11-02')).status, 404);

  // A3: only this address on this machine, read-only, nothing outside the Soul's folders, no secret
  for (const host of ['localhost:' + port, 'evil.example', `127.0.0.1:${port + 1}`]) assert.equal((await get(port, '/data.json', { headers: { host } })).status, 403, host);
  assert.equal((await get(port, '/data.json', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await get(port, '/data.json', { method })).status, 405, method);
  for (const path of ['/credentials.json', '/../credentials.json', '/journal/../../../../credentials.json', '/journal/..%2F..%2F..%2F..%2Fcredentials.json',
    '/journal/2026-01-02', '/journal/2026-01-03', '/.eden-serve.log', '/state.json', '/runtime/state.json', '/memory/self.md'])
    assert.equal((await get(port, path)).status, 404, path);
  for (const body of seen) { assert.ok(!body.includes(TOKEN), 'no token'); assert.ok(!body.includes(POLL), 'no poll secret'); assert.ok(!body.includes('"souls":{"s_a1"'), 'no credentials bytes'); }
  assert.match(data.log.at(-1), /\[redacted\]/);
  assert.equal(world.connections, 0, 'the dashboard sends nothing to the world');
});

test('dashboard: with serve running it says so; --template prints the page; --page serves the owner\'s file; help dashboard', async (t) => {
  const world = await deadWorld(t), { root, runtime } = home(t, world.url);
  // A stand-in for this folder's serve: a process whose command line and folder are serve's, and its lock.
  const serve = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', join(runtime, 'eden.mjs'), 'serve', '--foreground'], { cwd: runtime, stdio: 'ignore' });
  t.after(() => serve.kill());
  writeFileSync(join(runtime, '.eden-serve.lock'), JSON.stringify({ pid: serve.pid, start: '2026-11-13T08:00:00.000Z', beatAt: Date.now() }));
  writeFileSync(join(root, 'mine.html'), '<!doctype html><title>Mine</title><p>my own page</p>');
  const d = run(root, ['dashboard', '--page', 'mine.html']);
  t.after(() => d.child.kill());
  const said = await d.started, port = Number(new URL(said.dashboard).port);
  assert.equal(said.resident, 'serve is running here');
  assert.match((await get(port, '/')).body, /my own page/);
  const data = JSON.parse((await get(port, '/data.json')).body);
  assert.equal(data.resident.up, true); assert.equal(data.resident.since, '2026-11-13T08:00:00.000Z'); assert.equal(data.status.link.by, 'serve');

  const tpl = await run(root, ['dashboard', '--template']).done;
  assert.equal(tpl.code, 0); assert.equal(tpl.out, PAGE);
  const help = await run(root, ['help', 'dashboard']).done;
  assert.equal(help.code, 0); assert.match(help.out, /dashboard --template/); assert.match(help.out, /dashboard-data\/1/);
  assert.ok(help.out.trimEnd().split('\n').length <= 24, 'one screen');
  assert.equal(world.connections, 0);
});
