// A form act's check inputs kept between acts (0.132 G-late follow-up): made again exactly when the copy's roots or the
// kind entries' files change, and reused while neither does.

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { folderStamp, keptOne } from './kept.mjs';

test('an unchanged copy reuses what was made; a changed copy, or other kinds, makes it again', () => {
  const kept = keptOne(), kinds = { a: {} };
  let made = 0, roots = '{"r":"aa"}';
  const state = () => kept.get([roots, kinds], () => ({ n: ++made }));
  const first = state();
  assert.equal(state(), first, 'the same roots and kinds: the same state, not made again');
  assert.equal(made, 1);
  roots = '{"r":"bb"}'; // a sync changed the copy
  assert.notEqual(state(), first);
  assert.equal(made, 2);
  assert.equal(kept.get([roots, { a: {} }], () => ({ n: ++made })).n, 3, 'other kinds: made again');
});

test("the kind entries' folder stamp changes when a file is added, rewritten or removed", () => {
  const dir = mkdtempSync(join(tmpdir(), 'kept-'));
  try {
    assert.equal(folderStamp(join(dir, 'none')), '');
    writeFileSync(join(dir, 'eden.bench.json'), '{"kind":"eden:bench"}');
    writeFileSync(join(dir, 'notes.txt'), 'not an entry');
    const one = folderStamp(dir);
    assert.equal(folderStamp(dir), one, 'unchanged: the same stamp');
    writeFileSync(join(dir, 'eden.cup.json'), '{}');
    const two = folderStamp(dir);
    assert.notEqual(two, one);
    writeFileSync(join(dir, 'eden.cup.json'), '{}');
    utimesSync(join(dir, 'eden.cup.json'), new Date(0), new Date(1000));
    assert.notEqual(folderStamp(dir), two, 'rewritten in place: a new change time');
    rmSync(join(dir, 'eden.cup.json'));
    assert.notEqual(folderStamp(dir), two);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
