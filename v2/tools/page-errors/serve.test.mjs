// The page-error service (Engine v2 O25, #3336): node --test v2/tools/page-errors/serve.test.mjs
// A real server on a temporary folder, real requests: the summary, loopback only; a flood answered 429 with nothing
// stored; a Soul's name, a token and a query string never on disk; nothing imported from today's tree.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PATH, addressKey, pageErrors } from './serve.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SIX = [
  { k: 'js', m: 'Error: forced throw', s: 'main' },
  { k: 'rej', m: 'Error: forced rejection', s: 'main' },
  { k: 'gl', m: 'context lost' },
  { k: 'asset', m: '404', s: 'https://soul.example/models/models.json' },
  { k: 'stream', m: 'failed 3 times in a row: HTTP 503' },
  { k: 'arrival', m: 'not done in 60 s', s: 'no mark' },
];

async function service(limits = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'o25-'));
  const svc = pageErrors({ dir, build: 'v2-live', limits: { flushMs: 1, ...limits }, log: () => {} });
  await new Promise((r) => svc.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${svc.server.address().port}${PATH}`;
  const post = (body, xff = '198.51.100.7') => fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'user-agent': UA, 'x-forwarded-for': xff, 'content-type': 'text/plain' } });
  return { dir, svc, url, post };
}
const onDisk = (dir) => readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');

test('six kinds posted show in the summary with kind, count, browser class and build; the summary is the machine\'s own (A1)', async () => {
  const { svc, url, post } = await service();
  for (const e of SIX) assert.equal((await post({ b: 'v2-live', e: [e] }, `198.51.100.${SIX.indexOf(e) + 1}`)).status, 204);
  const s = await (await fetch(url)).json();
  assert.equal(s.kinds, 6); assert.equal(s.newSinceRelease, 6);
  assert.deepEqual(s.top.map((r) => r.kind).sort(), ['arrival', 'asset', 'gl', 'js', 'rej', 'stream']);
  for (const r of s.top) { assert.equal(r.count, 1); assert.deepEqual(r.browsers, { 'chrome/desktop': 1 }); assert.deepEqual(r.builds, { 'v2-live': 1 }); }
  assert.equal((await fetch(url, { headers: { 'x-forwarded-for': '203.0.113.9' } })).status, 404, 'through the proxy: no summary');
  svc.close();
});

test('a flood past today\'s limits is answered 429 and stores nothing (A2)', async () => {
  const { dir, svc, post } = await service();
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await post({ b: 'v2-live', e: [{ k: 'js', m: `boom ${i}` }] })).status);
  assert.deepEqual(codes, Array(10).fill(204), 'the burst of 10 from one address');
  svc.errors.flush();
  const before = readdirSync(dir).filter((f) => f !== 'health.json').map((f) => [f, statSync(join(dir, f)).size]);
  const flood = [];
  for (let i = 0; i < 200; i++) flood.push((await post({ b: 'v2-live', e: [{ k: 'js', m: `flood ${i}` }] })).status);
  assert.ok(flood.filter((c) => c === 429).length >= 199, `429s: ${flood.filter((c) => c === 429).length}`);
  svc.errors.flush();
  assert.deepEqual(readdirSync(dir).filter((f) => f !== 'health.json').map((f) => [f, statSync(join(dir, f)).size]), before, 'nothing stored');
  assert.equal((await fetch(`http://127.0.0.1:${svc.server.address().port}${PATH}`, { method: 'POST', body: 'x'.repeat(9000) })).status, 413);
  svc.close();
});

test('a Soul\'s name, a token and a query string put into an error never reach disk (A3)', async () => {
  const { dir, svc, post } = await service();
  await post({ b: 'v2-live', w: 'eden', e: [
    { k: 'js', m: 'TypeError: Kwyjibo cannot reach Oriel at /v1/souls?token=sk_live_abc123def456ghi789 with Bearer eyJhbGciOiJIUzI1NiJ9.e30.c2ln', s: 'main' },
    { k: 'rej', m: 'Error: said "meet me at the well, Oriel" key=hunter2secret', s: 'main' },
    { k: 'asset', m: '404', s: 'https://soul.example/models/worlds/models/a.glb?sig=Kwyjibo#Oriel' },
  ] });
  svc.close();
  const stored = onDisk(dir);
  for (const bad of ['Kwyjibo', 'Oriel', 'sk_live', 'eyJ', 'hunter2', 'token=sk', 'sig=', 'meet me', 'Macintosh']) assert.ok(!stored.includes(bad), `on disk: ${bad}`);
  assert.match(stored, /TypeError: ‹w› cannot reach ‹w› at \/v1\/souls/);
  const health = JSON.parse(readFileSync(join(dir, 'health.json'), 'utf8'));
  assert.equal(health.newSinceRelease, 3); assert.equal(health.build, 'v2-live');
  assert.deepEqual(health.new.map((k) => k.kind), ['js', 'rej', 'asset']);
});

test('one address: IPv6 counts by its /64, mapped IPv4 as IPv4', () => {
  assert.equal(addressKey('2001:db8:1:2:3:4:5:6, 10.0.0.1'), '2001:db8:1:2::/64');
  assert.equal(addressKey('::ffff:192.0.2.5'), '192.0.2.5');
  assert.equal(addressKey('192.0.2.5'), '192.0.2.5');
});

test('nothing here, in the beacon or in the watcher imports from today\'s tree (A5)', () => {
  const here = dirname(fileURLToPath(import.meta.url)), v2 = resolve(here, '../..');
  const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|new\s+URL\s*\(\s*)['"]([^'"]+)['"]/g;
  const dirs = [here, join(v2, 'tools/ops/watch'), join(v2, 'web/src/report')];
  const bad = [];
  for (const d of dirs) for (const f of readdirSync(d).filter((n) => /\.(m?[jt]s)$/.test(n))) {
    for (const [, spec] of readFileSync(join(d, f), 'utf8').matchAll(SPEC)) {
      if (spec.startsWith('.') && relative(v2, resolve(d, spec)).startsWith('..')) bad.push(`${f}: ${spec}`);
      if (!spec.startsWith('.') && !spec.startsWith('node:')) bad.push(`${f}: ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});
