import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ALLOW, NO_SOUL_TO_FOLLOW, SKIPPED_AFTER_LOAD, badResponse, brief, dayOfTick, followSoul, settleMisses, siteProbes, verdict, walkBackMiss } from './controls.mjs';

test('the allow-list is empty: every same-origin 4xx/5xx fails', () => {
  assert.deepEqual(ALLOW, []);
  assert.equal(badResponse({ method: 'GET', path: '/w/eden/v1/world/seq', status: 404 }), true);
  assert.equal(badResponse({ method: 'GET', path: '/w/eden/', status: 200 }), false);
  assert.equal(badResponse({ method: 'GET', path: '/x', status: 404 }, [{ method: 'GET', path: /^\/x$/, status: 404, why: 'test' }]), false);
  assert.equal(badResponse({ method: 'GET', path: '/x', status: 500 }, [{ method: 'GET', path: /^\/x$/, status: 404, why: 'test' }]), true);
});

test('site probes: view-token 401, manifest 200, each world /v1/me 401', () => {
  const p = siteProbes(['eden', 'rna-studio']);
  assert.deepEqual(p.map((x) => `${x.method} ${x.path} ${x.want}`), ['POST /v1/account/view-token 401', 'GET /mars-assets/static-manifest.json 200', 'GET /w/eden/v1/me 401', 'GET /w/rna-studio/v1/me 401']);
});

test('a world fails on any failed step and names it', () => {
  const v = verdict('eden', [{ name: 'Live', ok: true, errors: [] }, { name: 'Back 1 min', ok: false, detail: 'never landed', errors: ['404 GET /s/x'] }]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.failures, ['Back 1 min: never landed | 404 GET /s/x']);
  assert.equal(verdict('eden', [{ name: 'Live', ok: true, errors: [] }]).ok, true);
});

test('steps skipped after a failed load fail the world, named in one line after the load failure', () => {
  const skip = (name) => ({ name, ok: false, skipped: SKIPPED_AFTER_LOAD, detail: SKIPPED_AFTER_LOAD, errors: [] });
  const v = verdict('eden', [{ name: 'load', ok: false, detail: 'no moment drawn in 60 s', errors: [] }, skip('Live'), skip('Pause')]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.failures, ['load: no moment drawn in 60 s', '2 step(s) skipped-after-load-failure: Live, Pause']);
  // a skipped step is never a pass, even alone
  assert.equal(verdict('eden', [{ name: 'load', ok: true, errors: [] }, { ...skip('Live'), ok: true }]).ok, false);
});

test('release.yml: the controls job runs on the GPU runner with a hardware SHIP_GPU', () => {
  const y = readFileSync(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8');
  const job = y.slice(y.indexOf('\n  controls:\n'), y.indexOf('\n  # feed_only:'));
  assert.match(job, /runs-on: \[self-hosted, souls-timed\]/);
  assert.match(job, /pickHardwareGl/);
  assert.match(job, /SHIP_GPU=/);
});

test('printed errors collapse numbered paths and drop the console copy of a listed response', () => {
  assert.deepEqual(brief(['404 GET /s/w/dev/history/bundles/00020780/index', 'console: Failed to load resource: 404 ()', '404 GET /s/w/dev/history/bundles/00020779/index', '404 GET /w/eden/v1/world/seq']),
    ['404 GET /s/w/dev/history/bundles/N/index (x2)', '404 GET /w/eden/v1/world/seq']);
});

// A page as followSoul reads it: Explore open or not, the Soul rows it lists, the camera a click leaves.
// `ys`: where the first row is at each read (Explore's dialog grows when its location search comes in).
function fakePage({ open = true, souls = [], follows = true, ys = [], searching = 0 } = {}) {
  const st = { open, camera: 'free', pressed: [], y: 0, clickedAt: null };
  const loc = (sel) => ({
    sel,
    first: () => loc(sel),
    locator: () => ({ first: () => ({ textContent: async () => souls[0] }) }),
    isVisible: async () => (sel === 'input.explore-search' ? st.open : false),
    count: async () => (sel === '.explore-soul' && st.open ? souls.length : 0),
    waitFor: async () => { if (!(sel === '.explore-soul' && st.open && souls.length)) throw Error('locator.waitFor: Timeout 10000ms exceeded.'); },
    boundingBox: async () => { if (ys.length) st.y = ys.shift(); return { x: 10, y: st.y }; },
    textContent: async () => (searching-- > 0 ? 'Searching locations…' : '100 of 340 locations'),
  });
  const press = async (l) => {
    st.pressed.push(l.sel);
    if (l.sel === '.explore-open') st.open = true;
    if (l.sel === '.explore-soul') { st.clickedAt = st.y; if (follows) st.camera = 'follow'; }
  };
  const until = async (fn, ms) => { for (let i = 0; i < 50; i++) { const v = await fn(); if (v) return v; } return null; };
  return { st, page: { locator: loc }, helpers: { press, until, camera: async () => st.camera } };
}

test('Follow a Soul: a listed Soul is followed by its name; none listed passes and says so; a dead row fails', async () => {
  let f = fakePage({ open: false, souls: ['Fern'] });
  assert.equal(await followSoul(f.page, f.helpers), 'following Fern');
  assert.deepEqual(f.st.pressed, ['.explore-open', '.explore-soul']);
  // release run of 26 Nov: six worlds whose Explore lists no Soul failed on a 10 s wait for a row
  f = fakePage({ open: false, souls: [] });
  assert.equal(await followSoul(f.page, f.helpers), NO_SOUL_TO_FOLLOW);
  assert.deepEqual(f.st.pressed, ['.explore-open']);
  // Explore never opened: still the timeout, not a pass
  f = fakePage({ open: false, souls: [] });
  await assert.rejects(followSoul(f.page, { ...f.helpers, press: async () => {} }), /Timeout 10000ms/);
  f = fakePage({ souls: ['Fern'], follows: false });
  await assert.rejects(followSoul(f.page, f.helpers), /clicking Fern did not follow \(camera free\)/);
});

test('Follow a Soul clicks the row once Explore has its locations and the row holds still (release 0.138 on Eden)', async () => {
  // the dialog grows as the locations come and the row moves up: the click waits for it to stop
  const f = fakePage({ souls: ['Fern'], searching: 2, ys: [410, 300, 300] });
  assert.equal(await followSoul(f.page, f.helpers), 'following Fern');
  assert.equal(f.st.clickedAt, 300);
});

test('release.yml: publish needs the controls job, which runs after the engine move', () => {
  const y = readFileSync(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(y, /needs: \[preflight, ship, v2-move, eden-check, controls\]/);
  assert.match(y, /needs\.controls\.result == 'success'/);
  assert.match(y, /controls:\n    needs: \[preflight, ship, v2-move\]/);
  assert.match(y, /node tools\/test-harness\/e2e-controls\/controls\.mjs/);
});

// #5144's walk-back: a world still for days has no index for them, and the page's walk asks each on its way back.
const BASE = '/s/w/x/history/';
const ix = (day) => `${BASE}bundles/${String(day).padStart(8, '0')}/index`;
const held = (...days) => days.map((d) => ({ path: ix(d), line: `404 GET ${ix(d)}` }));
const reads = (o) => new Map([[BASE, new Map(Object.entries(o).map(([d, s]) => [Number(d), s]))]]);
const noEvents = async () => false;

test('a world still for several days: the walk-back misses before the first found day pass', async () => {
  // Back 1 min on day 20790: 20790, 20789 and 20788 have no index (still), 20787 has one (its last bundle)
  const r = reads({ 20790: 404, 20789: 404, 20788: 404, 20787: 200 });
  assert.deepEqual(await settleMisses(held(20790, 20789, 20788), r, { nowDay: 20790, eventful: noEvents }), []);
  // a later step reads only today's again (the worker keeps the days before): still a miss over the same still days
  assert.deepEqual(await settleMisses(held(20790), r, { nowDay: 20790, eventful: noEvents }), []);
  // a created world, in its own day 3 after two still days (world time from its start, v2/docs/time.md rule 1)
  assert.deepEqual(await settleMisses(held(3, 2), reads({ 3: 404, 2: 404, 1: 200 }), { nowDay: 3, eventful: noEvents }), []);
  assert.equal(walkBackMiss(20789, reads({ 20790: 404, 20789: 404, 20788: 404, 20787: 200 }).get(BASE)), true);
});

test('a real day\'s index missing still fails', async () => {
  const r = reads({ 20790: 404, 20789: 404, 20788: 404, 20787: 200 });
  // 20789 had public events: it wrote bundles, so its index is real and missing
  const busy = async (base, day) => base === BASE && day === 20789;
  assert.deepEqual(await settleMisses(held(20790, 20789, 20788), r, { nowDay: 20790, eventful: busy }),
    [`404 GET ${ix(20789)} (a day with public events: its index is missing)`]);
  assert.equal(walkBackMiss(20789, r.get(BASE), { eventful: true }), false);
  // the walk found no index at all: it ran past the world's first day
  assert.deepEqual(await settleMisses(held(2, 1, 0), reads({ 2: 404, 1: 404, 0: 404 }), { eventful: noEvents }), held(2, 1, 0).map((h) => h.line));
  // a day after the world's own today (#5140: a created world in day 0 asked for day 1)
  assert.deepEqual(await settleMisses(held(1), reads({ 0: 200, 1: 404 }), { nowDay: 0, eventful: noEvents }), [`404 GET ${ix(1)}`]);
  // a day between the found day and the miss never read: not the walk
  assert.deepEqual(await settleMisses(held(5), reads({ 5: 404, 3: 200 }), { nowDay: 5, eventful: noEvents }), [`404 GET ${ix(5)}`]);
});

test('a tick is 50 ms of world time', () => {
  assert.equal(dayOfTick(0), 0);
  assert.equal(dayOfTick(86_400 * 20 - 1), 0);
  assert.equal(dayOfTick(86_400 * 20), 1);
});
