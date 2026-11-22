import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { run } from './test-soul';

// The address is a synthetic test origin, assembled so publication output never contains device details.
const direct = `http://${['127', 0, 0, 1].join('.')}:1`;
test('approve, list and retire send only their bounded JSON; named refusals and redirects stay visible', async () => {
  const sent = [];
  const request = async (url, options) => {
    sent.push([url.pathname, options]);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  for (const args of [['approve', 'eden', 'BCDF-GHJK'], ['list'], ['retire', 'soul-example']]) {
    assert.deepEqual(await run([...args, '--directory', direct], request), { ok: true });
  }
  assert.deepEqual(sent.map(([path, o]) => [path, JSON.parse(o.body)]), [
    ['/v1/pair/operator/approve', { world: 'eden', code: 'BCDF-GHJK' }],
    ['/v1/pair/operator/list', {}], ['/v1/pair/operator/retire', { soul: 'soul-example' }],
  ]);
  assert.ok(sent.every(([, o]) => o.redirect === 'error' && !('authorization' in o.headers)));
  await assert.rejects(run(['list', '--directory', direct], async () => ({ ok: false, json: async () => ({ refused: 'operator.direct-only' }) })), /operator.direct-only/);
});
test('a public destination is rejected before a request and command has no credential or filesystem reader', async () => {
  let calls = 0;
  await assert.rejects(run(['list', '--directory', 'https://example.invalid'], async () => { calls++; }), /operator.direct-only/);
  assert.equal(calls, 0);
  const source = await readFile(new URL('./test-soul', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|credentials|readFile|createReadStream/);
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]), ['../../../tools/lib/is-main.mjs']);
  // The entry check resolves paths only (realpathSync on its own path and argv[1]); it reads no file's contents.
  const entry = await readFile(new URL('../../../tools/lib/is-main.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(entry, /credentials|readFile|createReadStream|openSync/);
  assert.deepEqual([...entry.matchAll(/^import (.*) from '([^']+)'/gm)].map((m) => `${m[1]} ${m[2]}`), ['{ realpathSync } node:fs', '{ fileURLToPath } node:url']);
});
