// node --test v2/web/src/visitor-counts.test.ts: the carried-over counter (O19, #2830) sends no query, hash, Soul id or
// token, and nothing locally or under automation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countEndpoint, countedPath, countedReferrer, localHost } from './visitor-counts.ts';

test('the count URL: simeden by default, another code or a full URL, off when asked', () => {
  assert.equal(countEndpoint(undefined), 'https://simeden.goatcounter.com/count');
  assert.equal(countEndpoint('other-site'), 'https://other-site.goatcounter.com/count');
  assert.equal(countEndpoint('http://127.0.0.1:6962/count?x=1#y'), 'http://127.0.0.1:6962/count');
  for (const off of ['', ' ', 'off', '0', 'javascript:alert(1)', 'Not A Code']) assert.equal(countEndpoint(off), null, off);
});

test('local, private and tailnet hosts are never counted; public hosts are', () => {
  for (const h of ['localhost', 'sim.localhost', 'world.test', '127.0.0.1', '10.0.0.4', '192.168.1.20', '[::1]', 'fd00::1', ''])
    assert.equal(localHost(h), true, h);
  for (const h of ['soul.game', 'sim.eden.art', '8.8.8.8']) assert.equal(localHost(h), false, h);
});

test('a page counts as its world slug only (or / for the list); a referrer as its origin only', () => {
  assert.equal(countedPath('/w/eden/'), '/w/eden');
  assert.equal(countedPath('/w/eden/approve/abc123'), '/w/eden');
  assert.equal(countedPath('/'), '/');
  assert.equal(countedPath('/buildings'), null);
  assert.equal(countedPath('/w/Bad_Slug'), null);
  const o = 'https://soul.game';
  assert.equal(countedReferrer('https://news.example/p/x?utm=x#y', o), 'https://news.example');
  assert.equal(countedReferrer('https://soul.game/w/hamlet/?pair=SECRET', o), 'https://soul.game/w/hamlet');
  assert.equal(countedReferrer('https://soul.game/v1/agent?token=x', o), '');
});

/** A fresh module copy on a fake page: what it sends. */
async function visit(href: string, opts: { webdriver?: boolean; skipgc?: boolean; tag: string }) {
  const sent: string[] = [], u = new URL(href);
  Object.assign(globalThis, {
    location: { hostname: u.hostname, search: u.search, pathname: u.pathname, origin: u.origin, href },
    document: { referrer: 'https://www.instagram.com/p/xyz/?igsh=abc' },
    screen: { width: 390 },
    localStorage: { getItem: (k: string) => (k === 'skipgc' && opts.skipgc ? 't' : null) },
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { webdriver: !!opts.webdriver, sendBeacon: (url: string) => { sent.push(url); return true; } } });
  const m = await import(`./visitor-counts.ts?${opts.tag}`) as typeof import('./visitor-counts.ts');
  m.countPage(); m.countPage();
  return sent;
}

test('a visit sends one count with no query, hash, Soul id or token; locally and under automation nothing', async () => {
  const sent = await visit('https://soul.game/w/eden/?soul=s_123&token=tok_9#pair=CODE', { tag: 'public' });
  assert.equal(sent.length, 1, 'one page view (countPage twice)');
  const view = new URL(sent[0]!);
  assert.equal(view.origin + view.pathname, 'https://simeden.goatcounter.com/count');
  assert.deepEqual([...view.searchParams.keys()].sort(), ['p', 'r', 'rnd', 's', 't']);
  assert.equal(view.searchParams.get('p'), '/w/eden');
  assert.equal(view.searchParams.get('r'), 'https://www.instagram.com');
  assert.doesNotMatch(sent[0]!, /s_123|tok_9|CODE|igsh|soul=|token=/);
  assert.equal(new URL((await visit('https://soul.game/?x=1', { tag: 'list' }))[0]!).searchParams.get('p'), '/');
  for (const [href, o] of [['http://localhost:6960/w/eden/', {}], ['https://soul.game/w/eden/', { webdriver: true }],
    ['https://soul.game/w/eden/?shot=1', {}], ['https://soul.game/w/eden/', { skipgc: true }]] as const) {
    assert.deepEqual(await visit(href, { ...o, tag: 'off' + Math.random() }), [], href + JSON.stringify(o));
  }
});
