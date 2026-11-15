// #2366: the watchdog's hard limits (A2 hang, A3 heap) and the fault guard (A1), as pure functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FAULT_EXIT, faultExit, faultGuard, installFaultGuard, killJudge, killRule, stoppedByFault} from './watchdog.ts';

const live = (age: number, usedMb = 100, limitMb = 1000, phase = 'serving', gcPct10s = 60) => ({phase, loop: {lastTurnAgeMs: age}, heap: {usedMb, limitMb, gcPct10s}});

test('killRule: 10 s hang, 95 % heap for 5 s while gc takes 30 % by default; each can be turned off', () => {
  assert.deepEqual(killRule({}), {hangMs: 10_000, heapPct: 95, heapMs: 5_000, gcPct: 30});
  assert.deepEqual(killRule({SIM_HANG_KILL_MS: '3000', SIM_HEAP_KILL_PCT: '0', SIM_HEAP_KILL_GC_PCT: '50'}), {hangMs: 3000, heapPct: 0, heapMs: 5_000, gcPct: 50});
  assert.equal(killRule({SIM_HANG_KILL_MS: '0', SIM_HEAP_KILL_PCT: '0'}), undefined);
});

test('a hang past the limit is a verdict on the second look in a row, never on one', () => {
  const j = killJudge({hangMs: 10_000, heapPct: 0, heapMs: 0});
  assert.equal(j(live(9_000), 0), null);
  assert.equal(j(live(10_500), 500), null, 'first look over the limit');
  assert.deepEqual(j(live(11_000), 1000), {reason: 'hang', stuckMs: 11_000});
  const k = killJudge({hangMs: 10_000, heapPct: 0, heapMs: 0});
  assert.equal(k(live(10_500), 0), null); assert.equal(k(live(200), 500), null, 'it turned'); assert.equal(k(live(10_600), 1000), null, 'starts again');
});

test('a gap between looks (the process was frozen, SIGSTOP) or a boot phase is never a verdict', () => {
  const j = killJudge({hangMs: 10_000, heapPct: 0, heapMs: 0});
  assert.equal(j(live(10_500), 0), null);
  assert.equal(j(live(600_000), 300_000), null, 'thawed after five minutes frozen: the age is the freeze');
  assert.equal(j(live(5), 300_500), null, 'the main thread turned at once');
  const b = killJudge({hangMs: 10_000, heapPct: 0, heapMs: 0});
  assert.equal(b(live(20_000, 1, 1, 'boot:replay'), 0), null); assert.equal(b(live(20_000, 1, 1, 'boot:replay'), 500), null);
  assert.equal(b(live(20_000, 1, 1, 'stopping'), 1000), null);
});

test('a heap at 95 % of its old-space cap (the limit less 96 MB of young generation) for 5 s is a verdict; dipping below starts again', () => {
  const j = killJudge({hangMs: 0, heapPct: 95, heapMs: 5_000});
  let t = 0;
  for (; t <= 5000; t += 500) assert.equal(j(live(10, 860, 1000), t), null, `${t} ms`);   // (the first look only starts the judge)
  assert.deepEqual(j(live(10, 870, 1000), t), {reason: 'heap', usedMb: 870, limitMb: 1000, gcPct10s: 60, forMs: 5000});
  const k = killJudge({hangMs: 0, heapPct: 95, heapMs: 5_000});
  for (t = 0; t <= 4500; t += 500) k(live(10, t === 2000 ? 850 : 860, 1000), t);
  assert.equal(k(live(10, 860, 1000), 5000), null, 'it dipped at 2 s');
});

test('a steady live set near the cap that collects calmly is never a verdict: the heap rule needs gc thrashing too', () => {
  const j = killJudge({hangMs: 0, heapPct: 95, heapMs: 5_000, gcPct: 30});
  for (let t = 0; t <= 60_000; t += 500) assert.equal(j(live(10, 880, 1000, 'serving', 8), t), null, `${t} ms at 8 % gc`);
  let v = null; for (let t = 60_500; t <= 66_000 && !v; t += 500) v = j(live(10, 880, 1000, 'serving', 45), t);
  assert.deepEqual(v, {reason: 'heap', usedMb: 880, limitMb: 1000, gcPct10s: 45, forMs: 5000}, 'thrashing at the cap is');
});

test('#2366 fix 1: after a tick fault, a clock stopped for good (no timer, or unavailable with no named halt) is a crash exit', () => {
  const ok = {running: true, clockAvailable: true, haltNamed: false};
  assert.equal(stoppedByFault(ok, false), null, 'ticking');
  assert.equal(stoppedByFault({...ok, running: false}, false), 'world.fault.clock-stopped', 'the drain stopped the host and threw');
  assert.equal(stoppedByFault({...ok, running: false, clockAvailable: false}, false), 'world.fault.clock-unavailable', 'unavailable, no halt named');
  assert.equal(stoppedByFault({running: false, clockAvailable: false, haltNamed: true}, false), null, 'a named halt: the launcher restarts it (#2133)');
  assert.equal(stoppedByFault({...ok, running: false}, true), null, 'a stop that was asked for (shutdown)');
  const dir = mkdtempSync(join(tmpdir(), 'fault-exit-'));
  try {
    const lines: string[] = [], codes: number[] = [];
    faultExit(dir, 'world.fault.clock-stopped', null, {log: l => lines.push(l), exit: c => codes.push(c), now: 7});
    assert.deepEqual(codes, [FAULT_EXIT]); assert.notEqual(FAULT_EXIT, 75, 'never the planned exit: the breaker counts it');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'fault-exit.json'), 'utf8')), {at: 7, reason: 'world.fault.clock-stopped'});
    assert.match(lines[0], /world\.fault\.clock-stopped: exiting 70, a crash the launcher restarts and counts/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('#2366 fix 2: a storm names the step that threw most of it (its stable id and ticks), for the exit record', () => {
  const storms: unknown[] = []; let now = 0;
  const g = faultGuard({log: () => {}, stormN: 5, stormMs: 10_000, onStorm: (n, step) => storms.push({n, step}), now: () => now});
  const step = (tick: number) => ({id: 0xabc, name: 'afterTick bad', tick});
  g.note('world.fault.timer', new Error('t'));
  for (let tick = 100; tick < 104; tick++) { now += 50; g.note('world.fault.step', new Error('s'), step(tick)); }
  assert.deepEqual(storms, [{n: 5, step: {id: 0xabc, name: 'afterTick bad', fromTick: 100, tick: 103, faults: 4}}]);
  const h: unknown[] = []; const g2 = faultGuard({log: () => {}, stormN: 4, onStorm: (n, s) => h.push(s), now: () => 0});
  for (const k of ['a', 'b', 'c']) g2.note('world.fault.timer', new Error(k)); g2.note('world.fault.step', new Error('s'), step(1));
  assert.deepEqual(h, [null], 'no step threw half of it: none is named');
});

test('the fault guard names each fault, logs the first stack of a minute, and restarts once on a storm', () => {
  const lines: string[] = []; let storms = 0, now = 0;
  const g = faultGuard({log: l => lines.push(l), stormN: 3, stormMs: 10_000, onStorm: () => storms++, now: () => now});
  g.note('world.fault.tick', new Error('a'));
  assert.match(lines[0], /^\[world\] fault world\.fault\.tick \(1 in 10 s\): Error: a\n\s+at /);
  now = 1000; g.note('world.fault.tick', new Error('b'));
  assert.equal(lines[1], '[world] fault world.fault.tick (2 in 10 s): Error: b', 'no stack again within the minute');
  now = 20_000; g.note('world.fault.timer', 'not an error');
  assert.equal(storms, 0, 'the first two left the window');
  g.note('world.fault.timer', new Error('c')); g.note('world.fault.timer', new Error('d'));
  assert.equal(storms, 1); g.note('world.fault.timer', new Error('e')); assert.equal(storms, 1, 'once');
  const counts: Record<string, number> = g.counts;
  assert.deepEqual({...counts}, {'world.fault.tick': 2, 'world.fault.timer': 4});
  const proc = new EventEmitter();
  installFaultGuard(g, proc as unknown as NodeJS.Process);
  proc.emit('uncaughtException', new Error('u')); proc.emit('unhandledRejection', new Error('r'));
  assert.equal(counts['world.fault.uncaught'], 1); assert.equal(counts['world.fault.rejection'], 1);
});
