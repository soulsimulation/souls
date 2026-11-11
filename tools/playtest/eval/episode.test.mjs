import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEpisode, runCase } from './episode.mjs';

// A stand-in client: `serve` starts a detached process and logs its pid, `serve --stop` ends it, `listen` logs its pid and blocks.
const FAKE_CLI = `import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
const [cmd, arg] = process.argv.slice(2), out = (o) => console.log(JSON.stringify(o));
if (cmd === 'status') out({ paired: true, soul: { id: 's_test', name: 'Wren' } });
else if (cmd === 'serve' && arg === '--stop') { if (existsSync('.serve.pid')) { try { process.kill(Number(readFileSync('.serve.pid', 'utf8')), 'SIGTERM'); } catch {} rmSync('.serve.pid'); } out({ serving: false }); }
else if (cmd === 'serve') { const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { detached: true, stdio: 'ignore' }); c.unref(); writeFileSync('.serve.pid', String(c.pid)); appendFileSync('pids.log', 'serve ' + c.pid + '\\n'); out({ serving: true }); }
else if (cmd === 'look') { writeFileSync('world-catalog.json', JSON.stringify({ catalog: { places: [{ id: 'field', kind: 'walkable' }], things: [] } })); out({ ok: true }); }
else if (cmd === 'listen') { appendFileSync('pids.log', 'listen ' + process.pid + '\\n'); setInterval(() => {}, 1e6); }
else if (cmd === 'register' && process.cwd().includes('-second')) process.exit(3);
else out({ ok: true });
`;

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid) { for (let i = 0; i < 40 && alive(pid); i++) await new Promise((ok) => setTimeout(ok, 50)); return !alive(pid); }
const pids = (folder) => (existsSync(join(folder, 'pids.log')) ? readFileSync(join(folder, 'pids.log'), 'utf8').trim().split('\n').map((l) => l.split(' ')).map(([k, p]) => ({ k, pid: Number(p) })) : []);

test('an episode that throws after wakeLoop() still stops its seat and its serve (#1989)', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'episode-test-')), folder = join(root, 'folder'), dir = join(root, 'run');
  mkdirSync(folder); mkdirSync(dir);
  writeFileSync(join(folder, 'eden.mjs'), FAKE_CLI);
  writeFileSync(join(folder, 'skill.md'), 'version: "0"\n');
  // The world shows the Soul in the field and refuses the owner's message, so sendCard throws after the wake loop started.
  const server = createServer((req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url.startsWith('/v1/edge/public/souls/')) return json(200, { self: { placePath: [{ id: 'field' }] }, receipts: [] });
    json(500, { code: 'test.refused' });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const item = { id: 'walk', instruction: 'Walk to the field.', check: { place: ['field'] }, timeoutSec: 5 };
    const seatCfg = { adapter: 'scripted-owner', script: { rules: [{ match: '.', do: [['status']] }] } };
    await assert.rejects(runEpisode({ dir, base: `http://127.0.0.1:${server.address().port}`, item, seatCfg, folder }), /POST .*\/inbox → 500 test\.refused/);
    const started = pids(folder);
    assert.ok(started.some((p) => p.k === 'serve'), 'serve started');
    for (const p of started) assert.ok(await gone(p.pid), `${p.k} (pid ${p.pid}) is still running`);
  } finally {
    for (const p of pids(folder)) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a case that throws during setup still stops every serve it started (#1950 review)', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'case-test-')), dir = join(root, 'run');
  mkdirSync(dir);
  // The world serves the stand-in client; the case's second folder cannot register, so setup throws after Wren's serve started.
  const server = createServer((req, res) => {
    if (req.url === '/eden.mjs') { res.writeHead(200); return res.end(FAKE_CLI); }
    if (req.url === '/skill.md') { res.writeHead(200); return res.end('version: "0"\n'); }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const folder = join(dir, 'seats', 'wren', 'folder');
  try {
    const item = { id: 'double-claim', bar: 'test', souls: [{ id: 'wren', name: 'Wren', folders: ['second'], script: [{ run: ['status'], expect: 'ok' }] }] };
    await assert.rejects(runCase({ dir, base: `http://127.0.0.1:${server.address().port}`, item, seatCfg: { adapter: 'scripted-owner' } }), /wren second: register exited 3/);
    const started = pids(folder);
    assert.ok(started.some((p) => p.k === 'serve'), 'serve started');
    for (const p of started) assert.ok(await gone(p.pid), `${p.k} (pid ${p.pid}) is still running`);
  } finally {
    for (const p of pids(folder)) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
