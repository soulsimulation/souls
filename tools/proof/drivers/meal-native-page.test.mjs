import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { mealWorldPage, mealBrowserInstall, mealBrowserStop, mealCheckpoint, mealFinalization } from './meal-native-page.mjs';

class PublicWorker extends EventTarget {
  message(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
}
const inPage = async work => {
  const old = globalThis.window;
  globalThis.window = { Worker: PublicWorker };
  try { await work(window); }
  finally { if (old === undefined) delete globalThis.window; else globalThis.window = old; }
};
const node = (id, extra) => ({ id, kind: id === 'bowl' ? 'eden:soup_bowl@observed' : 'souls:body@observed',
  parent: id === 'bowl' ? 'diner-body' : 'world', slot: id === 'bowl' ? 7 : null, pos: [1, 2, 3], rot: [2 ** 30, 0, 0, 0], ...extra });
const bowl = soup => node('bowl', { fields: { 28: soup } });
const body = () => node('diner-body', { slots: [[7, 200, 950, 0, 0, 1]] });
const expected = { bowl: 'bowl', holder: 'diner-body', soul: 'diner', soup: 2, phase: 'seated' };
function frame(soup = 2, activity = 'sit') {
  return { tick: 20, dt: .05, souls: [{ id: 'diner', entityId: 'visible-diner' }], entities: {
    'visible-diner': { activity, state: { heldEntries: { observedAt: 800000,
      entries: [{ ...bowl(soup), state: { soup } }] } } },
  } };
}

test('passive public observation forwards original messages and keeps lossless bounded native records', async () => inPage(async page => {
  const original = page.Worker;
  mealBrowserInstall({ bowl: 'bowl', bodies: ['diner-body'], limit: 2 });
  const worker = new page.Worker(), input = { t: 'snapshot', s: { nodes: [bowl(2n), body(), node('unrelated')], removed: [] } };
  let received;
  worker.addEventListener('message', event => { received = event.data; }); worker.message(input);
  assert.equal(received, input, 'the listener does not replace the message or payload');
  assert.deepEqual(input.s.nodes[0].fields, { 28: 2n });
  const observer = page.__mealPayloadObserver;
  assert.equal(observer.messages.length, 1); assert.equal(observer.messages[0].nodes.length, 2);
  assert.deepEqual(observer.messages[0].nodes[0].fields, { 28: { big: '2' } });
  worker.message({ t: 'part', p: { to: 1200000, nodes: [bowl(1)], removed: [] } });
  worker.message({ t: 'part', p: { to: 1300000, nodes: [bowl(0)], removed: [] } });
  assert.equal(observer.messages.length, 2); assert.match(observer.failures[0], /storage limit/);
  const stopped = mealBrowserStop(); assert.equal(page.Worker, original);
  worker.message({ t: 'part', p: { nodes: [], removed: ['bowl'] } });
  assert.equal(observer.messages.length, 2); assert.equal(mealBrowserStop(), stopped);
}));

test('a checkpoint binds same identity, native fields, parent/slot/pose and depicted state without guessing a hand', async () => inPage(async page => {
  mealBrowserInstall({ bowl: 'bowl', bodies: ['diner-body'] });
  const worker = new page.Worker(); worker.message({ t: 'snapshot', s: { nodes: [bowl(2), body()] } });
  page.__soulsEntity = { gameFrame: () => frame() };
  const checkpoint = mealCheckpoint(expected);
  assert.equal(checkpoint.native.handLabel, null); assert.deepEqual(checkpoint.native.slotRow, [7, 200, 950, 0, 0, 1]);
  assert.equal(checkpoint.native.worldAt, null); assert.equal(checkpoint.depicted.observedAt, 800000);
  assert.equal(checkpoint.depicted.tick, 20);
  worker.message({ t: 'part', p: { to: 1600000, nodes: [bowl(1)] } });
  assert.equal(mealCheckpoint(expected), null, 'current raw quantity cannot be replaced with a stale depicted value');
  page.__soulsEntity.gameFrame = () => frame(1);
  assert.equal(mealCheckpoint({ ...expected, soup: 1 }).native.worldAt, 1600000);
  worker.message({ t: 'part', p: { nodes: [node('diner-body')] } });
  assert.equal(mealCheckpoint({ ...expected, soup: 1 }).native.slotRow, null, 'a missing native slot stays unknown');
  worker.message({ t: 'part', p: { nodes: [], removed: ['bowl'] } });
  assert.equal(mealCheckpoint({ ...expected, soup: 1 }), null);
  mealBrowserStop();
}));

test('ambiguous workers, unknown quantities, mismatched poses and wrong posture cannot qualify a checkpoint', async () => inPage(async page => {
  mealBrowserInstall({ bowl: 'bowl', bodies: ['diner-body'] });
  const worker = new page.Worker(); worker.message({ t: 'snapshot', s: { nodes: [bowl(2), body()] } });
  page.__soulsEntity = { gameFrame: () => frame(2, 'idle') };
  assert.equal(mealCheckpoint(expected), null);
  page.__soulsEntity.gameFrame = () => frame();
  worker.message({ t: 'part', p: { nodes: [node('bowl', { fields: {} })] } });
  assert.equal(mealCheckpoint(expected), null);
  worker.message({ t: 'part', p: { nodes: [node('bowl', { fields: { 28: 2 }, pos: [9, 2, 3] })] } });
  assert.equal(mealCheckpoint(expected), null);
  worker.message({ t: 'part', p: { nodes: [bowl(2)] } });
  const another = new page.Worker(); another.message({ t: 'snapshot', s: { nodes: [bowl(2), body()] } });
  assert.equal(mealCheckpoint(expected), null, 'never guess which matching live/history worker is authoritative');
  mealBrowserStop();
}));

test('observer cleanup caches ownership failures and never overwrites another wrapper', async () => inPage(async page => {
  mealBrowserInstall({ bowl: 'bowl', bodies: [] });
  const replacement = class extends PublicWorker {}; page.Worker = replacement;
  let first; try { mealBrowserStop(); } catch (error) { first = error; }
  assert.match(first.message, /ownership changed/);
  assert.throws(mealBrowserStop, error => error === first); assert.equal(page.Worker, replacement);
}));

for (const mode of ['lost-context', 'missing-observer']) test(`finalization preserves receipts before ${mode} and caches rejection`, async () => {
  const scratch = resolve(import.meta.dirname, '../../../.local'); mkdirSync(scratch, { recursive: true });
  const paths = { dir: mkdtempSync(join(scratch, 'meal-finalize-test-')) }, state = { rows: [{ words: ['receipt'], answer: { phase: 'done' } }], checkpoints: [], installed: true };
  let calls = 0;
  mealFinalization({ evaluate: async () => {
    calls++; assert.deepEqual(JSON.parse(readFileSync(join(paths.dir, 'command-meal-sequence.json'))).rows, state.rows);
    if (mode === 'lost-context') throw Error('lost context'); return undefined;
  } }, paths, state);
  const first = state.finalize(); assert.equal(state.finalize(), first);
  await assert.rejects(first, mode === 'lost-context' ? /lost context/ : /collection missing/);
  await assert.rejects(state.finalize()); assert.equal(calls, 1);
  assert(readFileSync(join(paths.dir, 'command-meal-finalization-error.json'), 'utf8').includes(mode === 'lost-context' ? 'lost context' : 'collection missing'));
});

test('public world discovery rejects an unrelated or duplicate fixture and never leaves its origin', async () => {
  const original = globalThis.fetch;
  try {
    const row = { name: 'Shared camp meal', template: 'shared-camp-meal', url: '/w/shared-camp-meal/' };
    globalThis.fetch = async () => ({ status: 200, json: async () => ({ worlds: [row] }) });
    const url = await mealWorldPage({ base: 'https://example.invalid/' }); assert.equal(new URL(url).pathname, row.url);
    globalThis.fetch = async () => ({ status: 200, json: async () => ({ worlds: [row, row] }) });
    await assert.rejects(mealWorldPage({ base: 'https://example.invalid/' }), /unambiguous/);
    globalThis.fetch = async () => ({ status: 200, json: async () => ({ worlds: [{ ...row, url: 'https://other.invalid/w/meal/' }] }) });
    await assert.rejects(mealWorldPage({ base: 'https://example.invalid/' }), /owned origin/);
  } finally { globalThis.fetch = original; }
});
