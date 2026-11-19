// node --test v2/web/src/home/list.test.ts: the front door's one list (O19, #2830).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rows, signInHref } from './list.ts';

test('one list: the directory\'s worlds as the new system, today\'s listed others; a slug in both is the new system\'s', () => {
  const r = rows(
    { worlds: [{ name: 'eden', label: 'Gene', template: 'eden', awake: true }, { name: 'Bad Name' }] },
    { worlds: [{ slug: 'eden', name: 'Eden' }, { slug: 'mars-college-2027', name: 'Mars College', souls: 3 }, { slug: 'hidden', unlisted: true }] },
  );
  assert.deepEqual(r.map((w) => [w.slug, w.system, w.href]), [['eden', 'v2', '/w/eden/'], ['mars-college-2027', 'today', '/w/mars-college-2027/']]);
  assert.equal(r[0]!.note, 'Gene · eden · awake');
  assert.deepEqual(rows(null, null), []);
  assert.deepEqual(rows(null, { worlds: [{ slug: 'x' }] }).map((w) => w.name), ['x']);
});

test('sign-in goes to the primary\'s bridge and returns to the page it left', () => {
  const today = { auth: { clerkSatellite: { signInUrl: 'https://sim.eden.art/sign-in' } } };
  const href = signInHref(today, 'https://soul.game/?a=1#b');
  assert.equal(new URL(href!).origin + new URL(href!).pathname, 'https://sim.eden.art/sign-in');
  assert.equal(new URL(href!).searchParams.get('redirect_url'), 'https://soul.game/?a=1#b');
  assert.equal(signInHref({}, 'https://soul.game/'), null);
});
