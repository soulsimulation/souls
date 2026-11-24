// The Mars College camp template's own rack yard: exported with the Mars map, its copies are the construction kinds a
// crew builds with, the frames stand in the stand's slots, and each is named; without the map they are plain things.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../../lib/paths.mjs';
import { exportFacts } from '../arena/new-engine/world.mjs';
import { AT, TEMPLATE, stageBatch, templateFacts } from './rack-bay.mjs';

test('the template exports its yard in the construction kinds, frames in the stand, each named', () => {
  const dir = mkdtempSync(join(REPO_ROOT, '.local', 'rack-yard-'));
  try {
    const f = JSON.parse(readFileSync(templateFacts({ out: dir }), 'utf8'));
    const kind = Object.fromEntries(f.kinds.map((k) => [k.ref, k.name]));
    const yard = f.things.filter((t) => /^mars:(frame_stand|rack_upright|rack_beam|rack_bay)$/.test(kind[t.ref]));
    assert.deepEqual(yard.map((t) => [t.name, kind[t.ref]]).sort(), [
      ['frame-stand', 'mars:frame_stand'], ['rack-bay', 'mars:rack_bay'], ['rack-beam-1', 'mars:rack_beam'], ['rack-beam-2', 'mars:rack_beam'],
      ['rack-frame-1', 'mars:rack_upright'], ['rack-frame-2', 'mars:rack_upright']]);
    const by = Object.fromEntries(yard.map((t) => [t.name, t]));
    assert.deepEqual(by['frame-stand'].slots.map((s) => [s.n, s.id]), [[1, 'frame_1'], [2, 'frame_2']], "the stand's slots in its entry's order");
    for (const [n, k] of [['rack-frame-1', 1], ['rack-frame-2', 2]]) {
      assert.equal(by[n].parent, by['frame-stand'].id);
      assert.equal(by[n].slot.n, k);
    }
    assert.deepEqual(by['rack-bay'].world.slice(0, 3), [AT.bay[0] * 1000, 0, AT.bay[1] * 1000]);
    // the template alone, with no map, keeps the yard as plain things of its own defs
    const bare = JSON.parse(readFileSync(exportFacts(TEMPLATE, join(dir, 'bare.facts.json')), 'utf8'));
    assert.equal(bare.kinds.find((k) => k.ref === 'mars-rack-frame@1').name, 'eden:mars_rack_frame');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a staged yard names each thing by its title, never by a field of plain text', () => {
  const ops = stageBatch('g-1');
  assert.deepEqual(ops.map((o) => o.title), ['frame stand', 'rack frame 1', 'rack frame 2', 'rack beam 1', 'rack beam 2', 'rack bay']);
  assert.ok(ops.every((o) => o.fields === undefined));
});
