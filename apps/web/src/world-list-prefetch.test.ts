// 25 Nov: the homepage's world list GET leaves from index.html's head (world-list-prefetch.ts), once, on the homepage only,
// and WorldList takes it instead of fetching again.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { WORLD_LIST_GLOBAL, takeWorldListPrefetch, worldListPrefetchScript } from './world-list-prefetch.ts';

function runEntry(base: string, pathname: string, hash = '') {
  const calls: unknown[][] = [];
  const ctx: Record<string, unknown> = { location: { pathname, hash }, fetch: (...a: unknown[]) => { calls.push(a); return Promise.resolve(new Response('{}')); } };
  ctx.window = ctx;
  vm.runInNewContext(worldListPrefetchScript(base), ctx);
  return { calls, left: ctx[WORLD_LIST_GLOBAL] as { url: string; response: Promise<Response> } | undefined };
}

test('entry script: the homepage GETs its world list once, with the page\'s own fetch defaults; no other page does', () => {
  for (const base of ['', '/worlds']) {
    for (const home of [`${base}/`, `${base}/index.html`]) {
      const { calls, left } = runEntry(base, home);
      assert.deepEqual(calls, [[`${base}/__sim/worlds.json`]], `${base} ${home}`);
      assert.equal(left?.url, `${base}/__sim/worlds.json`);
    }
    for (const [pathname, hash] of [[`${base}/w/eden`, ''], [`${base}/w/eden/`, '#watch'], [`${base}/`, '#god'], [`${base}/docs`, ''], [`${base}/nope`, '']]) {
      const { calls, left } = runEntry(base, pathname, hash);
      assert.equal(calls.length, 0, `${base} ${pathname}${hash}: not the list, no GET`);
      assert.equal(left, undefined);
    }
  }
});

test('entry script: a failed GET leaves no unhandled rejection and hands the failure to its taker', async () => {
  const ctx: Record<string, unknown> = { location: { pathname: '/', hash: '' }, fetch: () => Promise.reject(new TypeError('offline')) };
  ctx.window = ctx;
  let unhandled = 0; const on = () => { unhandled++; }; process.on('unhandledRejection', on);
  try {
    vm.runInNewContext(worldListPrefetchScript(''), ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled, 0);
    await assert.rejects((ctx[WORLD_LIST_GLOBAL] as { response: Promise<Response> }).response, /offline/);
  } finally { process.off('unhandledRejection', on); }
});

test('takeWorldListPrefetch: the matching URL once; a mismatch or a second take gets null', () => {
  const g = globalThis as Record<string, unknown>; const hadWindow = 'window' in g; g.window ??= g;
  try {
    const response = Promise.resolve(new Response('{}'));
    g[WORLD_LIST_GLOBAL] = { url: '/__sim/worlds.json', response };
    assert.equal(takeWorldListPrefetch('/__sim/worlds.json'), response);
    assert.equal(takeWorldListPrefetch('/__sim/worlds.json'), null, 'taken once');
    g[WORLD_LIST_GLOBAL] = { url: '/worlds/__sim/worlds.json', response };
    assert.equal(takeWorldListPrefetch('/__sim/worlds.json'), null, 'another URL: fetch afresh');
    assert.equal(g[WORLD_LIST_GLOBAL], undefined);
  } finally { delete g[WORLD_LIST_GLOBAL]; if (!hadWindow) delete g.window; }
});
