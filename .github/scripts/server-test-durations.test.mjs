import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLog, fileTimes, testTimes, fillGaps } from './server-test-durations.mjs';

test('file times from a server job log: tests attributed in file order, each file from the previous report to its own', () => {
  const at = (s) => `server-0\tUNKNOWN STEP\t2026-11-04T10:00:${String(s).padStart(2, '0')}.0000000Z`;
  const log = [
    `${at(0)} {"shard":0,"totalServerFiles":3,"files":["src/a.test.ts","src/b.test.ts","src/c.test.ts"]}`,
    `${at(3)} # Subtest: alpha one`, `${at(3)} ok 1 - alpha one`, `${at(4)} ok 2 - alpha two`,
    `${at(4)}   ok 1 - a nested subtest does not count`,
    `${at(10)} ok 3 - computed name \${x}`,   // found nowhere: stays with the current file (a)... until c's own test
    `${at(25)} not ok 4 - gamma`,
  ].join('\n');
  const src = { 'src/a.test.ts': "test('alpha one'); test('alpha two')", 'src/b.test.ts': '', 'src/c.test.ts': "test('gamma')" };
  const times = fileTimes(parseLog(log), (f) => src[f]);
  assert.deepEqual(times, { 'src/a.test.ts': 10, 'src/c.test.ts': 15 });
  assert.equal(parseLog('no header'), null);
});

test('a parallel log fills only missing files: summed top-level test durations, scaled over the files both measure', () => {
  const at = `server-0\tUNKNOWN STEP\t2026-11-12T10:00:00.0000000Z`;
  const log = [
    `${at} {"shard":0,"totalServerFiles":2,"files":["src/a.test.ts","src/b.test.ts"]}`,
    `${at} ok 1 - alpha`, `${at}   ---`, `${at}   duration_ms: 3000`, `${at}   ...`,
    `${at}     ok 1 - nested`, `${at}     duration_ms: 999`,
    `${at} ok 2 - beta`, `${at}   ---`, `${at}   duration_ms: 1500`,
    `${at} ok 3 - beta two`, `${at}   ---`, `${at}   duration_ms: 500`,
  ].join('\n');
  const src = { 'src/a.test.ts': "test('alpha')", 'src/b.test.ts': "test('beta'); test('beta two')" };
  const t = testTimes(parseLog(log), (f) => src[f]);
  assert.deepEqual(t, { 'src/a.test.ts': 3, 'src/b.test.ts': 2 });
  const { ratio, seconds } = fillGaps({ 'src/a.test.ts': 1.5, 'src/old.test.ts': 9 }, t);
  assert.equal(ratio, 0.5);
  assert.deepEqual(seconds, { 'src/a.test.ts': 1.5, 'src/b.test.ts': 1, 'src/old.test.ts': 9 }, 'existing entries kept, the gap scaled');
  assert.throws(() => fillGaps({}, t), /cannot scale/);
});
