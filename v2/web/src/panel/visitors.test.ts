// A world's welcome and its recent visitors on the creator's panel (#3702).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ago, visitorLine, visitorsRequest, welcomeRequest, WELCOME_MOST } from './visitors.ts';

const identity = { testName: 'maker' } as never;
const answer = (status: number, body: unknown) => (async (url: URL | RequestInfo, init?: RequestInit) => {
  seen.push({ url: String(url), init: init! });
  return new Response(JSON.stringify(body), { status });
}) as typeof fetch;
let seen: { url: string; init: RequestInit }[] = [];

test('the welcome is set by the signed-in creator, and a refusal is named', async () => {
  seen = [];
  assert.equal(await welcomeRequest('https://example.invalid', 'garden', 'Tea at four.', identity, answer(200, { world: { name: 'garden', welcome: 'Tea at four.' } })), 'Tea at four.');
  assert.equal(seen[0]!.url, 'https://example.invalid/v1/worlds/welcome');
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { world: 'garden', welcome: 'Tea at four.' });
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, 'Bearer test:maker');
  await assert.rejects(welcomeRequest('https://example.invalid', 'garden', 'x', identity, answer(403, { refused: 'not-the-creator' })), /Refused: not-the-creator/);
  await assert.rejects(welcomeRequest('https://example.invalid', 'garden', 'a'.repeat(WELCOME_MOST + 1), identity, answer(200, {})), /At most/);
});

test('the visitors are read and each is a line of text', async () => {
  seen = [];
  const v = await visitorsRequest('https://example.invalid', 'garden', identity, answer(200, { welcome: null, visitors: [{ soul: 'soul-ab-1', name: 'Rowan', arrived: 1000, connected: true }] }));
  assert.equal(seen[0]!.url, 'https://example.invalid/v1/worlds/visitors');
  assert.equal(visitorLine(v.visitors[0]!, 1000 + 7200), 'Rowan, arrived 2 h ago, here now');
  assert.equal(visitorLine({ soul: 'soul-0123456789abcdef-12', name: null, arrived: 0, connected: false }, 30), 'Soul bcdef-12, arrived just now');
  assert.equal(ago(0, 3 * 86400), '3 d ago');
});
