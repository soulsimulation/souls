import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abortReason, onTime, refusals, sample } from './guard.mjs';
import { judge } from './limits.mjs';

const G = 2 ** 30;
const at = (t, count, over, edenGb = 1, sliceGb = 4) => ({
  t, state: 'running', healthAgeS: 2, h: { ticks: { count }, over_budget: over },
  eden: { current: edenGb * G, max: 4 * G }, slice: { current: sliceGb * G, max: 14 * G },
});

test('a healthy Eden with headroom may start; each refusal is named', () => {
  assert.deepEqual(refusals(at(0, 1000, 0), at(10, 1200, 1)), []);
  const b = { ...at(10, 1200, 10, 3, 9), state: 'restart-loop', healthAgeS: 90 };
  assert.deepEqual(refusals(at(0, 1000, 0), b).map((w) => w.split(' ')[0] + ' ' + w.split(' ')[1]),
    ['Eden is', "Eden's health", "Eden's ticks", 'Eden uses', 'souls.slice uses']);
  assert.match(refusals(at(0, 1000, 0), at(10, 1000, 0))[0], /no tick ran/);
  // the cgroup's inactive page cache is not pressure: Eden at 2.4 of 4 GB with 0.6 GB of it is at 45 %
  const cached = at(10, 1200, 1, 2.4); cached.eden.inactive = 0.6 * G;
  assert.deepEqual(refusals(at(0, 1000, 0), cached), []);
});

test('the load stops on late ticks over 30 s, on memory past 85 %, and on a silent probe', () => {
  const ok = [at(0, 0, 0), at(5, 100, 0), at(35, 700, 10)];
  assert.equal(abortReason(ok, 36, 35), null);
  assert.match(abortReason([...ok, at(65, 1300, 50)], 66, 65), /ticks on time 93\.33 % over the last 30 s/);
  assert.match(abortReason([...ok, at(40, 800, 10, 3.5)], 41, 40), /^Eden at 88 % of its MemoryMax/);
  assert.match(abortReason([...ok, at(40, 800, 10, 1, 12)], 41, 40), /^souls\.slice at 86 %/);
  assert.match(abortReason(ok, 70, 35), /silent for 35 s/);
  assert.equal(onTime(at(0, 5, 0), at(5, 5, 0)), null);
});

test('a probe sample reads Eden, the slice and every world from files only', () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-')), cg = join(root, 'cg'), id = 'ed-e0-1';
  mkdirSync(join(root, 'worlds', id, 'views'), { recursive: true }); mkdirSync(join(root, 'health'));
  mkdirSync(join(cg, 'souls.slice', `worldd@${id}.service`), { recursive: true });
  writeFileSync(join(root, 'worlds', id, 'health.json'), JSON.stringify({ at_unix_ms: 1_000_000, ticks: { count: 7 }, over_budget: 0 }));
  writeFileSync(join(root, 'worlds', id, 'views', 'world.json'), JSON.stringify({ stream: '/eden-stream/' }));
  writeFileSync(join(root, 'health', `${id}.json`), JSON.stringify({ state: 'running' }));
  writeFileSync(join(root, 'health', 'a0-b0-2.json'), JSON.stringify({ state: 'stopped' }));
  writeFileSync(join(cg, 'souls.slice', 'memory.current'), `${2 * G}\n`); writeFileSync(join(cg, 'souls.slice', 'memory.max'), `${14 * G}\n`);
  writeFileSync(join(cg, 'souls.slice', `worldd@${id}.service`, 'memory.current'), `${G}\n`);
  writeFileSync(join(cg, 'souls.slice', `worldd@${id}.service`, 'memory.max'), 'max\n');
  const s = sample({ root, cgroup: cg, instance: id, now: 1_004_000 });
  assert.deepEqual({ state: s.state, age: s.healthAgeS, ticks: s.h.ticks.count, eden: s.eden, slice: s.slice.current, worlds: s.worlds, stream: s.stream, wrss: s.wrss },
    { state: 'running', age: 4, ticks: 7, eden: { current: G, max: null, inactive: 0 }, slice: 2 * G, worlds: { running: 1, stopped: 1 }, stream: '/eden-stream/', wrss: G / 1024 });
  assert.ok(refusals(s, s).includes("Eden's memory or MemoryMax unknown"));
});

test('a rung the guard stopped is judged aborted, with or without numbers', () => {
  assert.deepEqual(judge({ aborted: 'Eden at 88 %' }), ['aborted by the guard (Eden at 88 %)']);
});
