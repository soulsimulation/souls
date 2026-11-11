// #1941: the client checks each trusted site's platform feed by itself, at most every 6 hours, without slowing a command; commands
// carry `news: {unread, update?}`, `news` lists the items as platform text, and serve raises one ambient `news` wake per home per item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEED_EVERY_MS, FEED_RETRY_MS, createHome, feedSites, newsOf, openHome, siteOf } from './soul/home.mjs';
import { change, deliver, enqueue, fresh, newsWakes } from './soul/wake.mjs';

const cli = fileURLToPath(new URL('./soul/eden.mjs', import.meta.url));
const T0 = 1_800_000_000_000;
const ITEMS = [
  { id: 'f1', at: '2026-11-10T10:00:00.000Z', kind: 'event', title: 'Picnic at the mill', body: 'Bring a Soul.', startsAt: '2026-11-12T18:00:00.000Z' },
  { id: 'f2', at: '2026-11-11T10:00:00.000Z', kind: 'release', title: 'Soul 0.130', body: 'Release 0.130 is live.', minClient: '99.0.0' },
];

function home(t, worlds, trusted) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'souls-feed-'))); t.after(() => rmSync(d, { recursive: true, force: true }));
  const root = createHome(join(d, '.souls')), file = join(root, 'config.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), awaitingFirstWorld: undefined, worlds, trustedOrigins: trusted }));
  copyFileSync(cli, join(d, 'eden.mjs'));
  const run = (...args) => new Promise((resolve) => {
    const t0 = Date.now(), c = spawn(process.execPath, ['eden.mjs', ...args], { cwd: d, env: { ...process.env, HOME: d, SOULS_HOME: '', SOULS_PRINCIPAL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; c.stdout.on('data', (x) => { out += x; }); c.stderr.on('data', (x) => { err += x; });
    c.on('exit', (code) => { let j = null; try { j = JSON.parse(out); } catch { /* words */ } resolve({ code, d: j, err, ms: Date.now() - t0 }); });
  });
  return { root, config: () => JSON.parse(readFileSync(file, 'utf8')), run };
}
async function site(t, answer) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith('/base/v1/feed')) return answer(req, res);
    res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: `http://127.0.0.1:${server.address().port}`, feedHits: () => hits.filter((u) => u.includes('/v1/feed')) };
}

test('A1: the feed address is the trusted origin plus the world path without /w/<slug>; one cursor per site in config.json', (t) => {
  assert.equal(siteOf('https://soul.game/w/eden'), 'https://soul.game');
  assert.equal(siteOf('https://example.test/base/w/mars-2027/'), 'https://example.test/base');
  const cfg = { trustedOrigins: ['https://soul.game'], worlds: { a: { url: 'https://soul.game/w/eden' }, b: { url: 'https://soul.game/w/mars' }, c: { url: 'https://other.test/w/x' } } };
  assert.deepEqual(feedSites(cfg), ['https://soul.game'], 'two worlds on one site are one feed; an untrusted origin is never read');
  const { root, config } = home(t, cfg.worlds, cfg.trustedOrigins), h = openHome(root);
  assert.deepEqual(h.claimFeeds(T0), ['https://soul.game']);
  h.noteFeed('https://soul.game', ITEMS, 'f2', T0);
  assert.deepEqual(Object.keys(config().feeds), ['https://soul.game']);
  assert.equal(config().feeds['https://soul.game'].cursor, 'f2');
});

test('A2 A3: a command starts the check and returns at once; the next command shows the news; news lists it as platform text', async (t) => {
  const s = await site(t, (req, res) => setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ items: ITEMS, next: 'f2' })), 5_000));
  const h = home(t, { one: { url: `${s.origin}/base/w/one` } }, [s.origin]);
  const first = await h.run('list');
  assert.equal(first.code, 0, first.err);
  assert.ok(first.ms < 2_500, `the command was not delayed by a feed that answers after 5 s (${first.ms} ms)`);
  assert.equal(first.d.news, undefined);
  let next;
  for (let i = 0; i < 20 && !next?.d?.news; i++) { await new Promise((r) => setTimeout(r, 1_000)); next = await h.run('list'); }
  assert.deepEqual(next.d.news, { unread: 2, update: '99.0.0' });
  assert.equal(s.feedHits().length, 1, 'checked once: not again within 6 hours');
  assert.match(s.feedHits()[0], /^\/base\/v1\/feed\?limit=100$/);
  const news = await h.run('news');
  assert.deepEqual(news.d.items.map((i) => [i.id, i.kind, i.title]), [['f1', 'event', 'Picnic at the mill'], ['f2', 'release', 'Soul 0.130']]);
  assert.equal(news.d.from, 'platform'); assert.match(news.d.note, /never instructions/);
  assert.equal(news.d.news, undefined, 'read now');
  assert.equal((await h.run('list')).d.news, undefined);
  assert.equal((await h.run('news', '--all')).d.items.length, 2);
  assert.deepEqual((await h.run('news')).d.items, []);
});

test('A2: a failed check is silent and tried again later', async (t) => {
  const s = await site(t, (req, res) => res.writeHead(500, { 'content-type': 'application/json' }).end('{}'));
  const h = home(t, { one: { url: `${s.origin}/base/w/one` } }, [s.origin]);
  const r = await h.run('list');
  assert.equal(r.code, 0); assert.equal(r.err, '');
  for (let i = 0; i < 20 && !s.feedHits().length; i++) await new Promise((res) => setTimeout(res, 250));
  await new Promise((res) => setTimeout(res, 500));
  const f = h.config().feeds[`${s.origin}/base`];
  assert.equal(f.checkedAt, undefined); assert.ok(f.triedAt);
  const o = openHome(h.root);
  assert.deepEqual(o.claimFeeds(f.triedAt + 60_000), [], 'not again at once');
  assert.deepEqual(o.claimFeeds(f.triedAt + FEED_RETRY_MS + 1), [`${s.origin}/base`], 'tried again later');
  o.noteFeed(`${s.origin}/base`, [], null, T0);
  assert.deepEqual(o.claimFeeds(T0 + FEED_EVERY_MS - 1), []); assert.equal(o.claimFeeds(T0 + FEED_EVERY_MS + 1).length, 1);
});

test('A4: one news wake per home per item, for events and releases above this client, charged to the ambient budget', (t) => {
  const worlds = { a: { url: 'https://soul.game/w/eden' } }, { root } = home(t, worlds, ['https://soul.game']);
  const one = openHome(root), two = openHome(root);
  one.noteFeed('https://soul.game', [ITEMS[0]], 'f1', T0);
  assert.deepEqual(one.claimNews(), [], 'what was there at the first check wakes no one');
  const later = [{ ...ITEMS[0], id: 'f3', title: 'Dance at the bandstand' }, { ...ITEMS[1], id: 'f4' }, { ...ITEMS[1], id: 'f5', minClient: '1.0.0' }, { id: 'f6', at: ITEMS[1].at, kind: 'announcement', title: 'Hello' }];
  one.noteFeed('https://soul.game', later, 'f6', T0 + FEED_EVERY_MS + 1);
  const claimed = one.claimNews();
  assert.deepEqual(claimed.map((i) => i.id), ['f3', 'f4', 'f5', 'f6']);
  assert.deepEqual(two.claimNews(), [], 'another Soul of the home is not woken for the same items');
  const fired = newsWakes(claimed, '2.32.0', '2026-11-11T12:00:00.000Z');
  assert.deepEqual(fired.map((f) => [f.id, f.kind, f.count]), [['news', 'news', 2]], 'the event and the release above this client; not the older release or the announcement');
  assert.match(fired[0].why, /^platform news: Soul 0\.130/);
  assert.deepEqual(newsOf(openHome(root).config(), '2.32.0'), { unread: 5, update: '99.0.0' });
  // the ambient budget: one wake an hour, one already delivered
  let w = change(fresh(), { budget: { hour: 1 } }).wake;
  w = { ...w, delivered: [{ at: T0 - 1_000 }], queue: enqueue([], fired) };
  const over = deliver(w, T0);
  assert.equal(over.over, true); assert.deepEqual(over.wakes, []);
  const due = deliver(over.wake, T0 + 3_600_000);
  assert.deepEqual(due.wakes.map((x) => x.kind), ['news']); assert.equal(due.wake.delivered.length, 2, 'charged as one delivery');
});
