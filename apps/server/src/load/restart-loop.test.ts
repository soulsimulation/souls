// #2378: the restart-loop record (A2) and the disk headroom (cause 4), as functions over a temporary data directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {noteLastExit, QUARANTINE_TICKS, stepQuarantine} from './restart-loop.ts';
import {diskHeadroom, diskMinFreeMb} from './disk-headroom.ts';

const killedAt = (tick: number, id: number) => JSON.stringify({phase: 'serving', tick: {world: tick - 3}, killed: {reason: 'hang', stuckMs: 3000, at: 1, step: {tick, id}, top: 'stuck x.ts:1'}});

test('two deaths in a row in the same step (by its stable id) at near ticks quarantine it for a window; a clean stop or another step does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restart-loop-'));
  try {
    assert.equal(noteLastExit(dir).quarantine, null, 'no live.json: a first boot');
    writeFileSync(join(dir, 'live.json'), killedAt(500, 7));
    assert.equal(noteLastExit(dir).quarantine, null, 'one death is not a loop');
    // a durable-clock world (Eden) writes its frontier before its listeners: the next boot dies one tick later
    writeFileSync(join(dir, 'live.json'), killedAt(501, 7));
    const r = noteLastExit(dir);
    assert.deepEqual(r.quarantine, {id: 7, name: 'step 00000007 (stuck x.ts:1)', fromTick: 500, untilTick: 501 + QUARANTINE_TICKS, deaths: 2});
    assert.equal(JSON.parse(readFileSync(join(dir, 'deaths.json'), 'utf8')).length, 2);
    writeFileSync(join(dir, 'live.json'), killedAt(501, 8));
    assert.equal(noteLastExit(dir).quarantine, null, 'another step');
    writeFileSync(join(dir, 'live.json'), JSON.stringify({phase: 'stopping'}));
    assert.deepEqual(noteLastExit(dir).deaths, [], 'a clean stop clears the record');
    // #2366: a fault storm's exit record names its step (and the first tick it threw at); it is read once
    const storm = (tick: number) => writeFileSync(join(dir, 'fault-exit.json'), JSON.stringify({at: 2, reason: 'world.fault.storm: 50 faults in a minute', step: {id: 9, name: 'afterTick 00000009 (bad)', fromTick: tick - 49, tick, faults: 50}}));
    writeFileSync(join(dir, 'live.json'), JSON.stringify({phase: 'serving', tick: {world: 1000}}));
    storm(1000); assert.equal(noteLastExit(dir).quarantine, null);
    assert.throws(() => readFileSync(join(dir, 'fault-exit.json')), 'read once, then gone');
    storm(1060);
    assert.deepEqual(noteLastExit(dir).quarantine, {id: 9, name: 'afterTick 00000009 (bad)', fromTick: 951, untilTick: 1060 + QUARANTINE_TICKS, deaths: 2});
  } finally { rmSync(dir, {recursive: true, force: true}); }
  const d = (tick: number | null, id: number | null) => ({at: 0, reason: 'hang', tick, id, name: null});
  assert.equal(stepQuarantine([d(5, 1), d(null, null)]), null, 'a death the watchdog could not name (an abort) never quarantines');
  assert.equal(stepQuarantine([d(5, 1), d(5 + QUARANTINE_TICKS + 1, 1)]), null, 'too far apart: not the same loop');
  assert.equal(stepQuarantine([d(5, 1), d(6, 1)])?.untilTick, 6 + QUARANTINE_TICKS, 'adjacent ticks');
  const three = stepQuarantine([d(5, 1), d(6, 1), d(7, 1)]);
  assert.equal(three?.deaths, 3); assert.equal(three?.untilTick, 7 + 2 * QUARANTINE_TICKS, 'the window doubles for each death past two');
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
