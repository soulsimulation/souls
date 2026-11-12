import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wallVerdict } from './hostile.mjs';

test('a wall eden-god refused or moved is not placed; only one placed where asked counts (#1974 review)', () => {
  // run r2: refused, yet exit 0
  const refused = wallVerdict({ code: 0, stdout: 'REFUSED: overlap.solid (op 0): overlaps commons-pavilion — suggest p [0.64,-17.36]\n  tried: blocked (overlap.solid) → nudge', stderr: '' });
  assert.deepEqual([refused.placed, refused.code], [false, 'overlap.solid']);
  // repaired by the CLI's own solver: placed somewhere else, exit 0
  const moved = wallVerdict({ code: 0, stdout: 'placed garden-wall (blocked (overlap.solid: overlaps commons-pavilion) → the server\'s suggestion [0.64,-17.36])', stderr: '' });
  assert.deepEqual([moved.placed, moved.code], [false, 'overlap.solid']);
  assert.match(moved.why, /moved, not where asked/);
  const failed = wallVerdict({ code: 1, stdout: '', stderr: 'error: not paired' });
  assert.deepEqual([failed.placed, failed.code], [false, 'exit.1']);
  const placed = wallVerdict({ code: 0, stdout: 'placed garden-wall at path [[2.2,-19.7],[19.9,4.5]]', stderr: '' });
  assert.deepEqual([placed.placed, placed.code], [true, null]);
});
