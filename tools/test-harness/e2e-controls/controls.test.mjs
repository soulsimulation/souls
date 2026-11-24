import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ALLOW, badResponse, siteProbes, verdict } from './controls.mjs';

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

test('release.yml: publish needs the controls job, which runs after the engine move', () => {
  const y = readFileSync(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(y, /needs: \[preflight, ship, v2-move, eden-check, controls\]/);
  assert.match(y, /needs\.controls\.result == 'success'/);
  assert.match(y, /controls:\n    needs: \[preflight, ship, v2-move\]/);
  assert.match(y, /node tools\/test-harness\/e2e-controls\/controls\.mjs/);
});
