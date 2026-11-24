import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
test('a public destination is rejected before a request, the batch modes too, and command reads no file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'x8a-'));
  let calls = 0;
  for (const args of [['list'], ['pair', 'eden', '3', '--out', join(dir, 'tokens')], ['retire-all', 'eden']]) {
    for (const origin of ['https://example.invalid', 'http://example.invalid', `${direct}/v1`]) {
      await assert.rejects(run([...args, '--directory', origin], async () => { calls++; }), /operator.direct-only/);
    }
  }
  assert.equal(calls, 0);
  await assert.rejects(stat(join(dir, 'tokens')), /ENOENT/, 'no tokens file is made');
  await rm(dir, { recursive: true });
  const source = await readFile(new URL('./test-soul', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /credentials|readFile|createReadStream|readdir/);
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]),
    ['node:crypto', 'node:fs/promises', 'node:path', 'node:url', '../../../tools/lib/is-main.mjs']);
  // The entry check resolves paths only (realpathSync on its own path and argv[1]); it reads no file's contents.
  const entry = await readFile(new URL('../../../tools/lib/is-main.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(entry, /credentials|readFile|createReadStream|openSync/);
  assert.deepEqual([...entry.matchAll(/^import (.*) from '([^']+)'/gm)].map((m) => `${m[1]} ${m[2]}`), ['{ realpathSync } node:fs', '{ fileURLToPath } node:url']);
});

/** A directory that answers the batch as directoryd does: a code per request, the token on the second poll. */
function directory() {
  const sent = [];
  const polls = new Map();
  const request = async (url, options) => {
    const body = JSON.parse(options.body);
    sent.push([url.pathname, body]);
    const n = sent.filter(([p]) => p === '/v1/pair/request').length;
    const answer = {
      '/v1/pair/request': () => ({ code: `CODE-${n}`, interval: 0 }),
      '/v1/pair/operator/approve': () => ({ ok: true, soul: `soul-${body.code}`, world: body.world, test: true }),
      '/v1/pair/poll': () => {
        polls.set(body.secret, (polls.get(body.secret) ?? 0) + 1);
        return polls.get(body.secret) < 2 ? { pending: 'slow_down', interval: 0 } : { token: `token-${body.secret.slice(0, 8)}`, grant: 'g' };
      },
      '/v1/pair/operator/list': () => ({ souls: [{ soul: 'soul-a', world: 'eden' }, { soul: 'soul-b', world: 'other' }, { soul: 'soul-c', world: 'eden' }] }),
      '/v1/pair/operator/retire': () => ({ ok: true, soul: body.soul, test: true }),
    }[url.pathname]();
    return { ok: true, json: async () => answer };
  };
  return { sent, request };
}

test('pair N asks, approves and polls N new Souls, writing their tokens outside the repo and never in its answer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'x8a-'));
  const out = join(dir, 'tokens');
  const { sent, request } = directory();
  const said = await run(['pair', 'eden', '3', '--out', out, '--directory', direct], request);
  assert.deepEqual(said, { ok: true, world: 'eden', paired: 3, test: true });
  assert.doesNotMatch(JSON.stringify(said), /token-/);
  const asks = sent.filter(([p]) => p === '/v1/pair/request').map(([, b]) => b);
  assert.equal(asks.length, 3);
  assert.ok(asks.every((b) => b.new === true && b.world === 'eden' && /^[0-9a-f]{64}$/.test(b.secret_hash)));
  assert.deepEqual(sent.filter(([p]) => p === '/v1/pair/operator/approve').map(([, b]) => b),
    [1, 2, 3].map((i) => ({ world: 'eden', code: `CODE-${i}` })));
  const lines = (await readFile(out, 'utf8')).trim().split('\n');
  assert.deepEqual(lines.map((l) => l.split(' ')[0]), ['soul-CODE-1', 'soul-CODE-2', 'soul-CODE-3']);
  assert.ok(lines.every((l) => /^soul-\S+ token-[0-9a-f]{8}$/.test(l)));
  assert.equal((await stat(out)).mode & 0o777, 0o600);
  // An existing file is refused before any request, and so is a file inside this repository.
  const before = sent.length;
  await assert.rejects(run(['pair', 'eden', '1', '--out', out, '--directory', direct], request), /EEXIST/);
  const inRepo = new URL('./x8a-tokens', import.meta.url).pathname;
  await assert.rejects(run(['pair', 'eden', '1', '--out', inRepo, '--directory', direct], request), /operator.tokens-in-repo/);
  assert.equal(sent.length, before);
  await rm(dir, { recursive: true });
});

test('retire-all asks the directory for one pass over the named world', async () => {
  const sent = [];
  const request = async (url, options) => {
    sent.push([url.pathname, JSON.parse(options.body)]);
    return { ok: true, json: async () => ({ ok: true, world: 'eden', retired: 500, test: true }) };
  };
  assert.deepEqual(await run(['retire-all', 'eden', '--directory', direct], request), { ok: true, world: 'eden', retired: 500, test: true });
  assert.deepEqual(sent, [['/v1/pair/operator/retire-all', { world: 'eden' }]]);
});

test('retire-all on a directory without the one-pass route retires every test Soul of the world, and no other', async () => {
  const { sent, request: answers } = directory();
  const request = (url, options) => url.pathname === '/v1/pair/operator/retire-all'
    ? Promise.resolve({ ok: false, status: 404, json: async () => ({ refused: 'not-found' }) })
    : answers(url, options);
  assert.deepEqual(await run(['retire-all', 'eden', '--directory', direct], request), { ok: true, world: 'eden', retired: 2 });
  assert.deepEqual(sent.map(([p, b]) => [p, b.soul]), [
    ['/v1/pair/operator/list', undefined], ['/v1/pair/operator/retire', 'soul-a'], ['/v1/pair/operator/retire', 'soul-c'],
  ]);
});
