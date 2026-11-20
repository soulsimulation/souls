import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { servedBy } from './served.mjs';

test('a real config rollback header is a named refusal before accepting an older manifest', async t => {
  const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json', 'x-souls-engine': 'old' }).end(JSON.stringify({ soulClient: { version: '2.36.1' } })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(servedBy(`http://127.0.0.1:${server.address().port}`), { code: 'world.previous-engine', message: /node eden\.mjs upgrade --rollback/ });
});
