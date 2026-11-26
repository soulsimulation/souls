// A form act's check inputs kept between acts (0.132 G-late follow-up): made again exactly when the copy's roots or the
// kind entries' files change, and reused while neither does.

import { strict as assert } from 'node:assert';
import fs, { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { folderStamp, keptKinds, keptOne } from './kept.mjs';

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

test("the kind entries' folder stamp changes when a file is added, rewritten by rename or removed", () => {
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
    // As `refreshEntries` writes an entry: to a .tmp beside it, then renamed over it.
    writeFileSync(join(dir, 'eden.cup.json.tmp'), '{"kind":"eden:cup"}');
    renameSync(join(dir, 'eden.cup.json.tmp'), join(dir, 'eden.cup.json'));
    const three = folderStamp(dir);
    assert.notEqual(three, two, 'rewritten by rename: a new stamp');
    rmSync(join(dir, 'eden.cup.json'));
    assert.notEqual(folderStamp(dir), three);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#5010 follow-up: the stamp is one look at the folder, and its entries are read again only when it changed", () => {
  // Eden's 415 entries were each stat'd at every check, and all read again at every change to the copy.
  const dir = mkdtempSync(join(tmpdir(), 'kept-'));
  const stats = mock.method(fs, 'statSync'), reads = mock.method(fs, 'readFileSync'), lists = mock.method(fs, 'readdirSync');
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 50; i++) writeFileSync(join(dir, `eden.k${i}.json`), JSON.stringify({ format: 'souls-entry/1', kind: `eden:k${i}` }));
    const kinds = keptKinds();
    const first = kinds(dir);
    assert.equal(Object.keys(first).length, 50);
    for (const m of [stats, reads, lists]) m.mock.resetCalls();
    assert.equal(folderStamp(dir), folderStamp(dir));
    assert.equal(stats.mock.callCount(), 2, 'one stat a stamp, not one a file');
    assert.equal(kinds(dir), first, 'unchanged: the same entries, not read again');
    assert.equal(reads.mock.callCount() + lists.mock.callCount(), 0);
    writeFileSync(join(dir, 'eden.more.json'), JSON.stringify({ format: 'souls-entry/1', kind: 'eden:more' }));
    assert.equal(Object.keys(kinds(dir)).length, 51, 'a new entry: read again');
    assert.equal(Object.keys(kinds(dir, 'eden:body')).length, 51, 'another body: read again');
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});
