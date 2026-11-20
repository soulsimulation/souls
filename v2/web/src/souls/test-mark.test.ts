import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicSoul } from '../source/source.ts';
import { SoulsCopy, TestMark } from './souls.ts';

const id = [new Uint8Array(16).fill(7), 4];
const relation = (other = id, audience = new Map([[1, 1]])) => [id, 'souls:body-of@revision', other, audience];
const grant = `soul-${'07'.repeat(16)}-4`;
test('public query link projection uses exact R1 layout and refuses private, malformed or ambiguous identity', () => {
  assert.equal(publicSoul([relation()]), grant);
  assert.equal(publicSoul([relation(), relation()]), grant);
  assert.equal(publicSoul([relation(), relation([new Uint8Array(16).fill(8), 0])]), null);
  assert.equal(publicSoul([relation(id, new Map([[1, 2]]))]), null);
  assert.equal(publicSoul([relation([new Uint8Array(1), 0])]), null);
  assert.equal(publicSoul([[id, new Map([[1, 'souls:body-of']])]]), null, 'not the Merkle encoding');
  assert.equal(publicSoul([]), null);
});

test('test status is cached by immutable public identity; stale and failed answers never clear a known test badge', async () => {
  const pending = new Map<string, (v: boolean | null) => void>();
  const calls: string[] = [];
  const mark = new TestMark((soul) => { calls.push(soul); return new Promise((resolve) => pending.set(soul, resolve)); });
  const shown: (boolean | null)[] = [];
  mark.open(grant, (v) => shown.push(v));
  mark.open('other', (v) => shown.push(v));
  pending.get(grant)!(true);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(JSON.stringify(shown), '[null,null]', 'first card cannot update the second');
  pending.get('other')!(false);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(shown.at(-1), false);
  mark.open(grant, (v) => shown.push(v));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(shown.at(-1), true);
  assert.deepEqual(calls, [grant, 'other']);
  const failed = new TestMark(async () => { throw Error('offline'); });
  failed.open(grant, (v) => shown.push(v));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(shown.at(-1), null, 'failure is unknown, never ordinary');
  const copy = new SoulsCopy();
  const body = { id: 'body', kind: 'souls:body', parent: null, slot: null, pos: [0, 0, 0] as [number, number, number], rot: [1, 0, 0, 0] as [number, number, number, number], at: null, soul: grant };
  copy.apply({ nodes: [body], removed: [], to: 0 });
  copy.apply({ nodes: [{ ...body, name: 'renamed', description: 'new words' }], removed: [], to: 1 });
  assert.equal(copy.souls.get('body')?.soul, grant);
});
