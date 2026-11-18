// Tests for the look gate's reading of an entry (look.mjs): one implementation of the fixes the content lanes each made.
import test from 'node:test';
import assert from 'node:assert/strict';
import {defOf, framesOf, shapeInMetres} from './look.mjs';

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
