// #2269: a conversation is out loud by default; `converse start … --private` asks the world to keep it to its members.
// The flag is never sent as part of the opening line, wherever it stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));

test('converse start: --private sets private:true and is not opening text; without it the body is unchanged', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'souls-private-')), bodies = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/edge/converse') bodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/v1/edge/converse' ? { accepted: true, conversation: { id: 'cv_fixture', state: 'open' } } : {}));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, '.eden-agent.json'), JSON.stringify({ world: `http://127.0.0.1:${server.address().port}`, soul: 's_me', token: 'synthetic-token' }), { mode: 0o600 });
  // async spawn: the fake world runs on this event loop
  const go = (...args) => new Promise(resolve => { const c = spawn(process.execPath, [cli, ...args], { cwd: dir, stdio: 'ignore' }); c.on('exit', resolve); });
  await go('converse', 'start', 's_bo', 'Between', 'us', '--private');
  await go('converse', 'start', '--private', 's_bo,s_cy', 'Hi');
  await go('converse', 'start', 's_cy', 'Lovely', 'morning');
  assert.deepEqual(bodies, [
    { op: 'start', with: ['s_bo'], text: 'Between us', private: true },
    { op: 'start', with: ['s_bo', 's_cy'], text: 'Hi', private: true },
    { op: 'start', with: ['s_cy'], text: 'Lovely morning' },
  ]);
});
