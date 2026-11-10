import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pianoNotes, pieceNotes, recordNotes, PIECE_COUNT, PIANO_STEP } from '../../../mars/viewer/app/engine-view/piano-score.ts';
import { RECORD_SLEEVES } from '../../../packages/world-compiler/src/core-kit/hand-music.ts';
import { EXPANDED_RECORD_SLEEVES } from '../../../packages/world-compiler/src/core-kit/record-repertoire.ts';

test('adding record repertoire preserves every original piece and seeded piano exactly', () => {
  const original = { count: PIECE_COUNT, pieces: Array.from({length: 4}, (_, i) => pieceNotes(i, 192, 224)), seeds: Array.from({length: 16}, (_, i) => pianoNotes('record_legacy_' + i, 192, 224)) };
  assert.equal(createHash('sha256').update(JSON.stringify(original)).digest('hex'), '6c1576f09a73441686b219446edd2aa5dc308968ee776092f2dfee1a18eee87f');
  assert.deepEqual(EXPANDED_RECORD_SLEEVES.slice(0,4), RECORD_SLEEVES);
  for (const title of RECORD_SLEEVES) assert.deepEqual(recordNotes(EXPANDED_RECORD_SLEEVES, title, 192, 224), recordNotes(RECORD_SLEEVES, title, 192, 224));
});

test('two new original records are distinct, deterministic and compose on the existing clock', () => {
  const all = EXPANDED_RECORD_SLEEVES.map(title => recordNotes(EXPANDED_RECORD_SLEEVES, title, 200, 208));
  for (const title of EXPANDED_RECORD_SLEEVES.slice(4)) {
    const notes = recordNotes(EXPANDED_RECORD_SLEEVES, title, 200, 208);
    assert.ok(notes.length > 20);
    assert.deepEqual(notes, recordNotes(EXPANDED_RECORD_SLEEVES, title, 200, 204).concat(recordNotes(EXPANDED_RECORD_SLEEVES, title, 204, 208)));
    assert.deepEqual(notes, recordNotes(EXPANDED_RECORD_SLEEVES, title, 200, 208));
    assert.ok(notes.every(n => n.t / PIANO_STEP === Math.round(n.t / PIANO_STEP)));
  }
  for(let i=0;i<all.length;i++)for(let j=i+1;j<all.length;j++)assert.notDeepEqual(all[i].map(n=>[n.midi,n.hand]),all[j].map(n=>[n.midi,n.hand]));
  assert.deepEqual(recordNotes(RECORD_SLEEVES, 'Paper Lanterns', 200,208), [], 'not in the old player collection');
  assert.deepEqual(recordNotes(EXPANDED_RECORD_SLEEVES, 'missing', 200,208), []);
  assert.doesNotThrow(()=>recordNotes(['a','b','c','d','__proto__'], '__proto__', 200,208));
});
