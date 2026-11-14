// #2378: the restart-loop record (A2) and the disk headroom (cause 4), as functions over a temporary data directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {noteLastExit, stepQuarantine} from './restart-loop.ts';
import {diskHeadroom, diskMinFreeMb} from './disk-headroom.ts';

const killedAt = (tick: number, index: number) => JSON.stringify({phase: 'serving', tick: {world: tick - 3}, killed: {reason: 'hang', stuckMs: 3000, at: 1, step: {tick, index}, top: 'stuck x.ts:1'}});

test('two deaths in a row at the same step of the same tick quarantine that step; a clean stop or another step does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restart-loop-'));
  try {
    assert.equal(noteLastExit(dir).quarantine, null, 'no live.json: a first boot');
    writeFileSync(join(dir, 'live.json'), killedAt(500, 7));
    assert.equal(noteLastExit(dir).quarantine, null, 'one death is not a loop');
    const r = noteLastExit(dir);   // the same live.json again: the next boot died in the same place
    assert.deepEqual(r.quarantine, {tick: 500, index: 7, name: 'afterTick[7] (stuck x.ts:1)', deaths: 2});
    assert.equal(JSON.parse(readFileSync(join(dir, 'deaths.json'), 'utf8')).length, 2);
    writeFileSync(join(dir, 'live.json'), killedAt(500, 8));
    assert.equal(noteLastExit(dir).quarantine, null, 'another step');
    writeFileSync(join(dir, 'live.json'), JSON.stringify({phase: 'stopping'}));
    assert.deepEqual(noteLastExit(dir).deaths, [], 'a clean stop clears the record');
  } finally { rmSync(dir, {recursive: true, force: true}); }
  const d = (tick: number | null, index: number | null) => ({at: 0, reason: 'hang', tick, index, name: null});
  assert.equal(stepQuarantine([d(5, 1), d(null, null)]), null, 'a death the watchdog could not name (an abort) never quarantines');
  assert.equal(stepQuarantine([d(5, 1), d(6, 1)]), null, 'a different tick');
  assert.equal(stepQuarantine([d(5, 1), d(5, 1), d(5, 1)])?.deaths, 3);
});

test('disk headroom: under it, the log says so and the retention rules prune once a look; the backup waits while low', () => {
  assert.equal(diskMinFreeMb({}), 1024); assert.equal(diskMinFreeMb({SIM_DISK_MIN_FREE_MB: '0'}), 0);
  let free = 5000, pruned = 0; const lines: string[] = [];
  const h = diskHeadroom({path: '.', minFreeMb: 1024, prune: () => { pruned++; }, log: l => lines.push(l), free: () => free});
  assert.equal(h.look(), false); assert.equal(pruned, 0);
  free = 300;
  assert.equal(h.look(), true); assert.equal(h.low, true); assert.equal(pruned, 1);
  assert.match(lines[0], /\[load\] disk\.low: 300 MB free, under the 1024 MB headroom: pruning by the retention rules/);
  free = 4000; assert.equal(h.look(), false); assert.match(lines.at(-1)!, /disk\.ok: 4000 MB free/);
  assert.equal(h.pretend(10), true); assert.equal(pruned, 2); assert.equal(h.pretend(null), false);
  const off = diskHeadroom({path: '.', minFreeMb: 0, prune: () => { pruned++; }, free: () => 0});
  assert.equal(off.look(), false); assert.equal(pruned, 2);
});
