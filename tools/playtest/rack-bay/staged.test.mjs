// The staged run's own pieces: where the live yard and its camera go, the owner's creator grant, an answer's lines.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AT, CAMERA } from './rack-bay.mjs';
import { LIVE_SOUTH, creatorGrantOf, jsonLines, southOf } from './staged.mjs';

test('the live yard and the camera move south together, nothing else changes', () => {
  const { at, camera } = southOf(LIVE_SOUTH);
  assert.deepEqual(at.bay, [AT.bay[0], AT.bay[1] + 6]);
  assert.deepEqual(at.beams, AT.beams.map(([x, z]) => [x, z + 6]));
  assert.equal(camera.position[2] - camera.target[2], CAMERA.position[2] - CAMERA.target[2]);
  assert.equal(camera.fov, CAMERA.fov);
});

test("the owner's one creator grant, and a refusal by reason otherwise", () => {
  const c = `creator-${'ab'.repeat(16)}-3`;
  assert.equal(creatorGrantOf([{ grant: `soul-${'cd'.repeat(16)}-0` }, { grant: c }]), c);
  assert.throws(() => creatorGrantOf([{ grant: `soul-${'cd'.repeat(16)}-0` }]), /no creator grant/);
  assert.throws(() => creatorGrantOf(undefined), /no creator grant/);
});

test("a command's JSON lines, whatever else it printed", () => {
  assert.deepEqual(jsonLines('installing\n{"step":"approve","code":"AB12"}\nnot json\n{"ok":true}\n'), [{ step: 'approve', code: 'AB12' }, { ok: true }]);
});
