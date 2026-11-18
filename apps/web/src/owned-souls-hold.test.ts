import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHeldSouls, shownOwnedSouls, writeHeldSouls, type HeldSouls } from './owned-souls-hold.ts';
import { readDraft, writeDraft } from './input-draft.ts';

const me = { userId: 'dev:ada', souls: ['s_a', 's_b'] };

test('#2280 A2: a reconnect keeps the last list, marked reconnecting, until the welcome', () => {
  const live = shownOwnedSouls(null, true, 'dev:ada', me, false);
  assert.deepEqual(live.ids, ['s_a', 's_b']); assert.equal(live.reconnecting, false);
  const gap = shownOwnedSouls(live.held, true, 'dev:ada', null, true);           // socket replaced: Me retired, no welcome yet
  assert.deepEqual(gap.ids, ['s_a', 's_b']); assert.equal(gap.reconnecting, true); assert.equal(gap.owner, 'dev:ada');
  const back = shownOwnedSouls(gap.held, true, 'dev:ada', { ...me, souls: ['s_a'] }, false);
  assert.deepEqual(back.ids, ['s_a']); assert.equal(back.reconnecting, false); assert.deepEqual(back.held?.souls, ['s_a']);
});

test('#2280 A2: the held list is never shown to anyone else, and a welcome without Me ends it', () => {
  const held: HeldSouls = { identity: 'dev:ada', souls: ['s_a'] };
  assert.deepEqual(shownOwnedSouls(held, true, 'dev:bo', null, true), { ids: [], owner: null, reconnecting: false, held: null });
  assert.deepEqual(shownOwnedSouls(held, true, 'dev:ada', null, false), { ids: [], owner: null, reconnecting: false, held: null });
  // signed out, or sign-in still loading after a reload: nothing shown, the list kept for the same identity
  assert.deepEqual(shownOwnedSouls(held, false, null, null, true), { ids: [], owner: null, reconnecting: false, held });
  assert.deepEqual(shownOwnedSouls(held, true, 'dev:ada', null, true).ids, ['s_a']);
});

test('#2368 A2: after a reload, while sign-in is still loading, the tab keeps its last list (never empty in between)', () => {
  const held: HeldSouls = { identity: 'dev:ada', souls: ['s_a', 's_b'] };
  const loading = shownOwnedSouls(held, false, null, null, true, false);         // Clerk not loaded / account not known yet
  assert.deepEqual(loading.ids, ['s_a', 's_b']); assert.equal(loading.reconnecting, true); assert.equal(loading.owner, 'dev:ada');
  const welcomed = shownOwnedSouls(loading.held, false, null, null, false, false); // the socket's welcome came first
  assert.deepEqual(welcomed.ids, ['s_a', 's_b']);
  const known = shownOwnedSouls(welcomed.held, true, 'dev:ada', null, true, true); // signed in, Me on its way
  assert.deepEqual(known.ids, ['s_a', 's_b']);
  assert.deepEqual(shownOwnedSouls(held, false, null, null, true, true).ids, []);  // loaded and signed out: nothing shown
  assert.deepEqual(shownOwnedSouls(null, false, null, null, true, false).ids, []); // nothing held: nothing invented
});

test('#2280 A3: the held list and drafts survive in tab storage; a bad or blocked store is ignored', () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
  writeHeldSouls('k', { identity: 'dev:ada', souls: ['s_a'] }, store);
  assert.deepEqual(readHeldSouls('k', store), { identity: 'dev:ada', souls: ['s_a'] });
  m.set('k', JSON.stringify({ identity: 'dev:ada', souls: ['s_a', 7, '<x>'] }));
  assert.deepEqual(readHeldSouls('k', store), { identity: 'dev:ada', souls: ['s_a'] });
  m.set('k', '{'); assert.equal(readHeldSouls('k', store), null);
  writeDraft('soul:w:s_a', 'half a thought', store);
  assert.equal(readDraft('soul:w:s_a', store), 'half a thought');
  assert.equal(readDraft('god:w', store), '');
  writeDraft('soul:w:s_a', '', store); assert.equal(m.has('sim.draft.soul:w:s_a'), false);
  const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
  assert.equal(readDraft('god:w', blocked), ''); writeDraft('god:w', 'x', blocked); assert.equal(readHeldSouls('k', blocked), null);
});
