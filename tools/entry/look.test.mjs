// The look gate fails a kind the gallery drew nothing for, and names why (tools/entry/look.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {look, noCaptures} from './look.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A kind with a shape tagged `tags`, and a stand-in gallery script that runs `body` (it gets the --out dir as `out`). */
function setup(tags, body) {
  const dir = mkdtempSync(join(root, '.local/look-test-'));
  const entry = JSON.parse(readFileSync(join(root, 'content/kinds/seating/bench.json'), 'utf8'));
  entry.looks = {...entry.looks, shape: {make: {kind: 'gen', gen: 'test/1'}, tags}};
  mkdirSync(join(dir, 'kinds'));
  writeFileSync(join(dir, 'kinds/bench.json'), JSON.stringify(entry));
  const gallery = join(dir, 'gallery.mjs');
  writeFileSync(gallery, `import {mkdirSync, writeFileSync} from 'node:fs';\nconst a = process.argv, out = a[a.indexOf('--out') + 1];\n${body}\n`);
  return {dir, run: () => look(join(dir, 'kinds'), {out: join(dir, 'out'), gallery}).results};
}

mkdirSync(join(root, '.local'), {recursive: true});

test('a kind tagged marker fails with the tag named, not ok on an empty sheet', () => {
  const {dir, run} = setup(['marker'], `mkdirSync(out, {recursive: true}); writeFileSync(out + '/gallery.json', JSON.stringify({count: 0, captures: [], tris: [], errors: []}));`);
  try {
    const [r] = run();
    assert.equal(r.kind, 'eden:bench');
    assert.equal(r.distinct, 0);
    assert.deepEqual(r.errors, ['nothing drawn: the gallery skips a def tagged "marker" (looks.shape.tags)']);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a gallery that exits before capturing fails with its exit and its last words', () => {
  const {dir, run} = setup(['furniture'], `console.error('chrome lease: timed out waiting for a browser'); process.exit(1);`);
  try {
    const [r] = run();
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0], 'nothing drawn: the gallery exited (exit 1) before capturing anything: chrome lease: timed out waiting for a browser');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a gallery run with a capture is not a zero-capture failure', () => {
  assert.equal(noCaptures({tags: ['marker']}, {status: 0, gallery: {captures: [{file: 'pixels/0000.rgba'}]}}), null);
});
