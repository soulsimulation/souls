// A Soul that joined and has not moved is drawn where it stands (#3687): its body node carries a pose but no motion
// sample, which the page used to skip, so `bodies drawn` read 0 and the body showed as a thing's default box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldView } from './world.ts';
import type { NodeRec } from '../source/source.ts';

const node = (id: string, kind: string, o: Partial<NodeRec> = {}): NodeRec => ({ id, kind, parent: null, slot: null, pos: [0, 0, 0], rot: [1 << 30, 0, 0, 0], at: null, ...o });
const S = 1_000_000;
const T = 1_795_000_000 * S;

test('a joined body with no motion sample is drawn at its pose, not as a thing', () => {
  const w = new WorldView();
  w.apply([node('g', 'eden:ground'), node('b', 'souls:body@1220ab', { parent: 'g', pos: [140 * S, 0, 73 * S] })], []);
  assert.equal(w.draw(T), 1);
  assert.deepEqual(w.tracks.get('b')?.at(T), [140 * S, 0, 73 * S]);
  w.draw(T); // things rebuilt
  assert.equal((w as unknown as { things: unknown[] }).things.length, 0, 'the body is no thing box');
});

test('a still body then moved by a sample follows the sample', () => {
  const w = new WorldView();
  w.apply([node('g', 'eden:ground'), node('b', 'souls:body', { parent: 'g', pos: [0, 0, 0] })], []);
  w.apply([node('b', 'souls:body', { parent: 'g', at: T + 2 * S, pos: [2 * S, 0, 0] })], [], [['b', 'g', null, T, 0, 0, 0]] as never);
  assert.equal(w.draw(T + S), 1);
  assert.deepEqual(w.tracks.get('b')?.at(T + S), [S, 0, 0]);
  assert.deepEqual(w.tracks.get('b')?.at(T + 3 * S), [2 * S, 0, 0]);
});

test('a thing that is not a body is still no track', () => {
  const w = new WorldView();
  w.apply([node('g', 'eden:ground'), node('lamp', 'eden:lamp_post', { parent: 'g' })], []);
  assert.equal(w.draw(T), 0);
  assert.equal(w.tracks.has('lamp'), false);
});
