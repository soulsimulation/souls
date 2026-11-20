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

import { archiveRequest, creatorArchive } from './archive.ts';

test('W17 archive requires exact name and fresh identity, and distinguishes pending from stopped', async () => {
  let fresh = 0, stopped = 0; let changed: (() => void) | undefined;
  const identity = { bearer: async () => `fresh${++fresh}`, subscribeIdentity: (f: () => void) => { changed = f; return () => { stopped++; }; } };
  const post = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://example.invalid/v1/worlds/archive');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store'); assert.equal(init?.credentials, 'omit');
    assert.deepEqual(JSON.parse(String(init?.body)), { world: 'garden', confirm: 'garden' });
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer fresh${fresh}`);
    return Response.json({ pending: true }, { status: 202 });
  }) as typeof fetch;
  await assert.rejects(archiveRequest('https://example.invalid', 'garden', 'Garden', identity, post), /exact world name/); assert.equal(fresh, 0);
  assert.deepEqual(await archiveRequest('https://example.invalid', 'garden', 'garden', identity, post), { pending: true, archived: false });
  assert.deepEqual(await archiveRequest('https://example.invalid', 'garden', 'garden', identity, (async () => Response.json({ archived: true })) as typeof fetch), { pending: false, archived: true });
  assert.equal(fresh, 2);
  await assert.rejects(archiveRequest('https://example.invalid', 'garden', 'garden', identity, (async () => { changed?.(); return Response.json({ archived: true }); }) as typeof fetch), /Account changed/);
  assert.equal(stopped, 3);
});


test('W17 pending completion remains isolated from edit tools and account changes clear its controls', async () => {
  let submit: (event: { preventDefault(): void }) => Promise<void> = async () => {};
  const form = { hidden: false, addEventListener: (_type: string, callback: typeof submit) => { submit = callback; } };
  const confirm = { value: 'garden' }, status = { textContent: '' }, button = { textContent: 'Archive world', disabled: false }, name = { textContent: '' };
  const elements = { form, input: confirm, '[role=status]': status, button, '[data-world]': name };
  const container = { dataset: {} as Record<string, string>, querySelector: (key: keyof typeof elements) => elements[key] };
  const listeners = new Set<() => void>();
  const identity = { bearer: async () => 'fresh fixture identity', subscribeIdentity: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; } };
  let response = { pending: true, archived: false }, delayed: (() => void) | null = null;
  const post = (async () => { if (delayed) delayed(); return Response.json(response); }) as typeof fetch;
  const reset = creatorArchive(container as unknown as HTMLElement, 'garden', 'https://example.invalid', () => '', async () => identity, post);
  await submit({ preventDefault() {} });
  assert.equal(container.dataset.operation, 'pending'); assert.equal(form.hidden, false); assert.equal(button.textContent, 'Check archive');
  assert.match(status.textContent, /Archiving this world/);
  // The operation attribute, not a socket's creator class, keeps only this section visible.
  response = { pending: false, archived: true }; await submit({ preventDefault() {} });
  assert.equal(container.dataset.operation, 'archived'); assert.equal(form.hidden, true); assert.match(status.textContent, /World archived/);
  for (const changed of [...listeners]) changed();
  assert.equal(container.dataset.operation, undefined); assert.equal(status.textContent, ''); assert.equal(confirm.value, ''); assert.equal(form.hidden, false);
  confirm.value = 'garden'; delayed = () => { for (const changed of [...listeners]) changed(); };
  await submit({ preventDefault() {} }); assert.equal(container.dataset.operation, undefined); assert.equal(status.textContent, '');
  delayed = null; response = { pending: true, archived: false }; confirm.value = 'garden'; await submit({ preventDefault() {} });
  reset(); assert.equal(container.dataset.operation, undefined); assert.equal(status.textContent, ''); assert.equal(confirm.value, '');
  response = { pending: false, archived: false }; confirm.value = 'garden'; await submit({ preventDefault() {} });
  assert.equal(container.dataset.operation, undefined); assert.match(status.textContent, /did not confirm an operation/);
});
