// node --test tools/world-launcher/feed.test.mjs (#1876): the platform feed on the launcher under --base, posted with
// op.mjs. No world processes; a free block of ports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { openLauncher } from './launcher.mjs';
import { platformFeed } from './feed.mjs';
import { testPort } from '../../apps/server/test/test-port.ts';
const P0 = await testPort(3);

const dir = mkdtempSync(join(tmpdir(), 'launcher-feed-'));
const templatesDir = join(dir, 'templates'); mkdirSync(templatesDir);
const webDir = join(dir, 'web'); mkdirSync(webDir); writeFileSync(join(webDir, 'index.html'), '<!doctype html>');
const dataDir = join(dir, 'data');
const command = () => { throw Error('no world is started in this test'); };
const op = async (...args) => {
  const r = await promisify(execFile)(process.execPath, [join(import.meta.dirname, 'op.mjs'), ...args, '--port', String(P0), '--base', '/worlds']).catch((e) => e);
  return { code: r.code ?? 0, out: JSON.parse(r.stdout) };
};

await test('feed: op.mjs posts, anyone reads under the base, replaced items hide, reads are counted by client version', async () => {
  const L = await openLauncher({ port: P0, range: [P0 + 2, P0 + 2], base: '/worlds', dataDir, webDir, templatesDir, command, eager: 0, log: () => {} });
  try {
    const feed = (q = '', headers = {}) => fetch(`http://127.0.0.1:${P0}/worlds/v1/feed${q}`, { headers });
    // A1: empty at first, under the base and not on a world
    const r0 = await feed();
    assert.equal(r0.status, 200);
    assert.deepEqual(await r0.json(), { items: [], next: null });
    assert.equal((await fetch(`http://127.0.0.1:${P0}/v1/feed`)).status, 404, 'only under the launcher base');

    // A3: op.mjs feed-post appends one item each
    const a = await op('feed-post', '--kind', 'announcement', '--title', 'Hello', '--body', 'The feed is open.', '--url', 'https://soul.game/changelog');
    assert.equal(a.code, 0); assert.equal(a.out.status, 201); assert.equal(a.out.item.id, 'f1');
    const b = await op('feed-post', '--kind', 'event', '--title', 'Gathering', '--starts-at', '2026-12-01T18:00:00Z', '--place', 'the bandstand');
    assert.equal(b.out.item.id, 'f2');
    const c = await op('feed-post', '--kind', 'release', '--title', 'Client 2.33.0', '--min-client', '2.33.0');
    const d = await op('feed-post', '--kind', 'event', '--title', 'Gathering, moved', '--starts-at', '2026-12-02T18:00:00Z', '--replaces', 'f2');
    assert.equal(d.out.item.replaces, 'f2');
    assert.deepEqual(readFileSync(join(dataDir, 'feed.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id), ['f1', 'f2', 'f3', 'f4'], 'append-only file');

    // A1: oldest first, replaced item hidden, item shape, cursor paging
    const all = await (await feed()).json();
    assert.deepEqual(all.items.map((i) => i.id), ['f1', 'f3', 'f4']);
    assert.equal(all.next, 'f4');
    assert.deepEqual(Object.keys(all.items[0]), ['id', 'at', 'kind', 'title', 'body', 'url']);
    assert.equal(all.items[2].startsAt, '2026-12-02T18:00:00.000Z');
    assert.equal(c.out.item.minClient, '2.33.0'); assert.equal(b.out.item.place, 'the bandstand');
    const p1 = await (await feed('?limit=1')).json();
    assert.deepEqual([p1.items.map((i) => i.id), p1.next], [['f1'], 'f1']);
    const p2 = await (await feed(`?after=${p1.next}&limit=1`)).json();
    assert.deepEqual([p2.items.map((i) => i.id), p2.next], [['f3'], 'f3'], 'the hidden f2 is skipped, not counted against the page');
    const p3 = await (await feed(`?after=${p2.next}`)).json();
    assert.deepEqual([p3.items.map((i) => i.id), p3.next], [['f4'], 'f4']);
    assert.deepEqual(await (await feed('?after=f4')).json(), { items: [], next: 'f4' });
    assert.equal((await feed('?after=nope')).status, 400);
    assert.equal((await feed('?limit=1000')).status, 400);

    // A2: public cache headers; no credentials needed and none change the answer
    const pub = await feed();
    assert.match(pub.headers.get('cache-control'), /^public, max-age=\d+$/);
    assert.deepEqual(await (await feed('', { authorization: 'Bearer god_x' })).json(), all);

    // A2: limits on posting
    for (const [args, why] of [
      [['--kind', 'promo', '--title', 'x'], /kind/],
      [['--kind', 'announcement', '--title', 'x'.repeat(121)], /title/],
      [['--kind', 'announcement', '--title', 'ok', '--body', 'x'.repeat(1001)], /body/],
      [['--kind', 'announcement', '--title', 'ok', '--url', 'http://soul.game/'], /url/],
      [['--kind', 'announcement', '--title', 'ok', '--replaces', 'f99'], /replaces/],
    ]) { const r = await op('feed-post', ...args); assert.equal(r.out.status, 400, args.join(' ')); assert.match(r.out.message, why); }
    assert.equal((await op('feed-post', '--kind', 'announcement', '--title', 'x'.repeat(120), '--body', 'y'.repeat(1000))).out.status, 201, 'the limits themselves pass');

    // A3: a non-loopback post (through the proxy: x-forwarded-for) gets 403 and appends nothing
    const before = readFileSync(join(dataDir, 'feed.jsonl'), 'utf8');
    for (const verb of ['feed-post', 'feed-stats']) {
      const r = await fetch(`http://127.0.0.1:${P0}/worlds/__sim/op/${verb}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify({ kind: 'announcement', title: 'nope' }) });
      assert.equal(r.status, 403, verb);
    }
    assert.equal(readFileSync(join(dataDir, 'feed.jsonl'), 'utf8'), before);

    // A4: reads counted per UTC day by x-soul-client version, nothing else
    await feed('', { 'x-soul-client': '2.32.0' }); await feed('', { 'x-soul-client': '2.32.0' }); await feed('', { 'x-soul-client': '<script>' });
    const s = await op('feed-stats');
    assert.equal(s.code, 0);
    const today = new Date().toISOString().slice(0, 10);
    assert.deepEqual(Object.keys(s.out.days), [today]);
    assert.equal(s.out.days[today]['2.32.0'], 2);
    assert.equal(s.out.days[today].other, 1);
    assert.equal(s.out.days[today].none, 8, 'the other successful GETs above, without the header; refused ones are not reads');
  } finally { await L.close(); }
});

await test('feed: read counts survive a restart of the launcher (flushed to <data>/feed-reads.json)', () => {
  const d = mkdtempSync(join(tmpdir(), 'feed-reads-')), at = () => new Date('2026-11-11T12:00:00Z');
  const res = { writeHead: () => res, end: () => {} }, read = (f, headers) => f.serve({ method: 'GET', headers }, res, new URL('http://x/v1/feed'));
  const f = platformFeed({ dataDir: d, now: at }); read(f, { 'x-soul-client': '2.33.0' }); f.flush();
  const g = platformFeed({ dataDir: d, now: at }); read(g, {}); g.flush();
  const body = JSON.parse(readFileSync(join(d, 'feed-reads.json'), 'utf8'));
  assert.deepEqual(body.days, { '2026-11-11': { '2.33.0': 1, none: 1 } });
});

await test('feed: a malformed line is skipped and moves no other id; a line without a stored id keeps its line number (#1993)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'feed-ids-')), at = () => new Date('2026-11-11T12:00:00Z');
  const line = (id, title) => JSON.stringify({ ...(id ? { id } : {}), at: '2026-11-10T00:00:00.000Z', kind: 'announcement', title, body: '' });
  writeFileSync(join(d, 'feed.jsonl'), `${line(null, 'legacy')}\n${line('f2', 'two')}\n{"id":"f3","at":"2026-11-1\n${line('f4', 'four')}\n`);
  const f = platformFeed({ dataDir: d, now: at });
  assert.deepEqual(f.page(undefined, 20).items.map((i) => [i.id, i.title]), [['f1', 'legacy'], ['f2', 'two'], ['f4', 'four']]);
  assert.deepEqual(f.page('f2', 20).items.map((i) => i.id), ['f4'], 'a client that read up to f2 gets f4 next, nothing skipped or repeated');
  let out; const res = { writeHead: () => res, end: (b) => { out = JSON.parse(b); } };
  const req = Object.assign([Buffer.from(JSON.stringify({ kind: 'announcement', title: 'five' }))], { headers: {} });
  await f.op(req, res, 'feed-post', true);
  assert.equal(out.item.id, 'f5', 'a new item never reuses an id');
  assert.deepEqual(f.page('f4', 20).items.map((i) => i.id), ['f5']);
});
