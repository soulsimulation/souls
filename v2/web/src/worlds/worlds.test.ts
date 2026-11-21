// W3 (#2799): a click keeps one key until its answer (A4), and a limit's refusal names the limit and when to retry (A5).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClickKey, refusalText } from './worlds.ts';

test('a click keeps its key until it is answered', () => {
  let n = 0;
  const key = new ClickKey(() => `k${++n}`);
  assert.equal(key.take(), 'k1');
  assert.equal(key.take(), 'k1', 'a retry of an unanswered click sends the same key');
  key.answered();
  assert.equal(key.take(), 'k2', 'the next click is a new world');
});

test('a limit refusal names the limit and when to retry', () => {
  assert.equal(
    refusalText(429, { refused: 'world-limit-hourly', limit: "one world an hour in an account's first day", retry_after: 3540 }),
    "Refused: the limit is one world an hour in an account's first day. Try again in 59 min.",
  );
  assert.equal(
    refusalText(429, { refused: 'world-limit', limit: '5 worlds an account', retry_after: null }),
    'Refused: the limit is 5 worlds an account. It does not lift with time.',
  );
  assert.equal(refusalText(409, { refused: 'name-taken', detail: 'mine' }), 'Refused: name-taken (mine)');
});

import { handoffLink, readHandoff, handoffRequest } from './handoff.ts';

test('W16 offers stay in a validated fragment and require explicit acceptance', () => {
  const offer = { world: 'garden', code: 'a'.repeat(32) };
  const link = new URL(handoffLink('https://example.invalid', offer));
  assert.equal(link.search, '');
  assert.deepEqual(readHandoff(link.hash), offer);
  for (const hash of ['#handoff/../' + offer.code, '#handoff/garden/no', '#handoff/garden/' + offer.code + '/extra']) assert.equal(readHandoff(hash), null);
  assert.throws(() => handoffLink('https://example.invalid', { ...offer, world: '../other' }));
});

test('W16 each explicit submission uses fresh sign-in and rejects late account-switch results', async () => {
  let fresh = 0, stopped = 0;
  let changed: (() => void) | undefined;
  const identity = { bearer: async () => `fresh${++fresh}`, subscribeIdentity: (f: () => void) => { changed = f; return () => { stopped++; }; } };
  const post = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://example.invalid/v1/worlds/handoff/accept');
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer fresh${fresh}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { code: 'a'.repeat(32), world: 'garden' });
    return Response.json({ accepted: true });
  }) as typeof fetch;
  await handoffRequest('https://example.invalid', 'accept', 'garden', identity, { code: 'a'.repeat(32) }, post);
  await handoffRequest('https://example.invalid', 'accept', 'garden', identity, { code: 'a'.repeat(32) }, post);
  assert.equal(fresh, 2); assert.equal(stopped, 2);
  const late = (async () => { changed?.(); return Response.json({ code: 'private' }); }) as typeof fetch;
  await assert.rejects(handoffRequest('https://example.invalid', 'offer', 'garden', identity, {}, late), /Account changed/);
  assert.equal(stopped, 3);
  await assert.rejects(handoffRequest('https://example.invalid', 'cancel', 'garden', identity, {}, (async () => Response.json({ refused: 'not-the-creator' }, { status: 403 })) as typeof fetch), /not-the-creator/);
});
