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


import { canonicalRows } from './list.ts';

test('W17 legacy fallback cannot resurrect archived or unlisted native worlds, without exposing an archive list', async () => {
  const counts = new Map<string, number>();
  const get = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    const slug = /\/w\/([^/]+)/.exec(String(url))![1]; counts.set(slug, (counts.get(slug) ?? 0) + 1);
    if (slug === 'eden') return Response.json({ refused: 'world-archived' }, { status: 410 });
    if (slug === 'unlisted') return Response.json({ world: slug, stream: '/s/unlisted/', directory: '/', gateway: `/w/${slug}/v2/ws`, creatorToken: `/w/${slug}/v2/creator-token` });
    if (slug === 'visible') return Response.json({ world: slug, stream: '/s/visible/', directory: '/', gateway: `/w/${slug}/v2/ws`, creatorToken: `/w/${slug}/v2/creator-token` });
    if (slug === 'malformed') return Response.json({ world: slug, gateway: 'https://untrusted.example.invalid/' });
    if (slug === 'offline') throw Error('fixture bootstrap unavailable');
    if (slug === 'unknown') return Response.json({ refused: 'unrelated' }, { status: 410 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const today = { worlds: ['eden', 'unlisted', 'preview', 'legacy', 'unknown', 'malformed', 'offline', 'visible'].map(slug => ({ slug })) };
  const result = await canonicalRows({ worlds: [{ name: 'eden' }, { name: 'preview' }, { name: 'visible' }] }, today, 'https://example.invalid', get);
  assert.deepEqual(result.map(w => w.slug), ['visible', 'preview', 'legacy', 'unknown', 'malformed', 'offline']);
  assert.deepEqual([...counts.values()], [1, 1, 1, 1, 1, 1, 1, 1], 'each already-public slug is probed once');
  assert.deepEqual((await canonicalRows(null, { worlds: [{ slug: 'unlisted' }] }, 'https://example.invalid', get)), []);
});
