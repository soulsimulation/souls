import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ALLOW, NO_SOUL_TO_FOLLOW, SKIPPED_AFTER_LOAD, badResponse, brief, followSoul, siteProbes, verdict } from './controls.mjs';

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
function fakePage({ open = true, souls = [], follows = true } = {}) {
  const st = { open, camera: 'free', pressed: [] };
  const loc = (sel) => ({
    sel,
    first: () => loc(sel),
    locator: () => ({ first: () => ({ textContent: async () => souls[0] }) }),
    isVisible: async () => (sel === 'input.explore-search' ? st.open : false),
    count: async () => (sel === '.explore-soul' && st.open ? souls.length : 0),
    waitFor: async () => { if (!(sel === '.explore-soul' && st.open && souls.length)) throw Error('locator.waitFor: Timeout 10000ms exceeded.'); },
  });
  const press = async (l) => { st.pressed.push(l.sel); if (l.sel === '.explore-open') st.open = true; if (l.sel === '.explore-soul' && follows) st.camera = 'follow'; };
  return { st, page: { locator: loc }, helpers: { press, until: async (fn) => (await fn()) || null, camera: async () => st.camera } };
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

test('release.yml: publish needs the controls job, which runs after the engine move', () => {
  const y = readFileSync(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(y, /needs: \[preflight, ship, v2-move, eden-check, controls\]/);
  assert.match(y, /needs\.controls\.result == 'success'/);
  assert.match(y, /controls:\n    needs: \[preflight, ship, v2-move\]/);
  assert.match(y, /node tools\/test-harness\/e2e-controls\/controls\.mjs/);
});
