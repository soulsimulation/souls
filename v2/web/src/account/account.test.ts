// The account page's words and requests (Engine v2 W9, #2827).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceText, request, settingsText } from './account.ts';

test('a test person rides the body for account calls and the bearer for world calls; a session is a bearer', () => {
  const a = request({ person: 'ann' }, 'account', { soul: 's' });
  assert.equal((a.headers as Record<string, string>).authorization, undefined);
  assert.deepEqual(JSON.parse(a.body as string), { soul: 's', test_person: 'ann' });
  const w = request({ person: 'ann' }, 'world', { world: 'mine' });
  assert.equal((w.headers as Record<string, string>).authorization, 'Bearer test:ann');
  assert.deepEqual(JSON.parse(w.body as string), { world: 'mine' });
  const s = request({ session: 'tok' }, 'account', {});
  assert.equal((s.headers as Record<string, string>).authorization, 'Bearer tok');
  assert.equal(s.credentials, 'omit');
});

test('a Soul names its device, and a world its two switches', () => {
  assert.equal(deviceText({ soul: 's', device: 'studio laptop' }), 'on studio laptop');
  assert.equal(deviceText({ soul: 's', device: null }), 'no device');
  assert.equal(settingsText({ name: 'm', label: 'Ann' }), 'open to visitors · on the list');
  assert.equal(settingsText({ name: 'm', label: 'Ann', closed: true, unlisted: true }), 'closed to visitors · off the list');
});
