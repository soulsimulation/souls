// Tests for the look gate (tools/entry/look.mjs): its reading of an entry (one implementation of the fixes the content
// lanes each made), and its failing a kind the gallery drew nothing for, naming why.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defOf, framesOf, look, noCaptures, shapeInMetres} from './look.mjs';

test('a polygon\'s points are whole millimetres, drawn in metres', () => {
  assert.deepEqual(shapeInMetres({polygon: [[0, 0], [500, 0], [500, 250]]}), {polygon: [[0, 0], [0.5, 0], [0.5, 0.25]]});
});

test('a part\'s scale and glow are permille, drawn as fractions; a number under an unknown key is still refused', () => {
  assert.deepEqual(shapeInMetres({scale: [1000, 500, 2000], glow: 750}), {scale: [1, 0.5, 2], glow: 0.75});
  assert.throws(() => shapeInMetres({brightness: 3}), /"brightness".*permille/);
});

test('a text, list or schedule field is neither a frame nor a state of the drawn def; the rest are', () => {
  const entry = {
    kind: 'test:board',
    state: {
      lit: {n: 0, type: 'bool', default: false},
      level: {n: 1, type: 'int', unit: 'permille', min: 0, max: 1000, default: 500},
      title: {n: 2, type: 'text', default: 'title'},
      notes: {n: 3, type: 'list', most: 4, of: {}, default: []},
      hours: {n: 4, type: 'schedule', default: {}},
    },
    looks: {shape: {shapes: [{at: [0, 0, 0], size: [1000, 1000, 20]}]}},
  };
  const def = defOf(entry);
  assert.deepEqual(Object.keys(def.state), ['lit', 'level']);
  assert.deepEqual(def.state.level, {type: 'number', default: 0.5});
  const frames = framesOf(entry);
  assert.ok(frames.every(f => Object.keys(f.values).join() === 'lit,level'), JSON.stringify(frames.map(f => f.values)));
  assert.deepEqual(frames.map(f => f.label), ['lit=false level=500 (default)', 'lit=true', 'level=0', 'level=1000']);
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A kind with a shape tagged `tags`, and a stand-in gallery script that runs `body` (it gets the --out dir as `out`). */
function setup(tags, body) {
  const dir = mkdtempSync(join(root, '.local/look-test-'));
  const entry = JSON.parse(readFileSync(join(root, 'content/kinds/seating/bench.json'), 'utf8'));
  entry.looks = {...entry.looks, shape: {shapes: [{at: [0, 0, 0], size: [1000, 1000, 20]}], tags}};
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
