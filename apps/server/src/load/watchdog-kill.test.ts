// #2366: the watchdog's hard limits (A2 hang, A3 heap) and the fault guard (A1), as pure functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {faultGuard, installFaultGuard, killJudge, killRule} from './watchdog.ts';

const live = (age: number, usedMb = 100, limitMb = 1000, phase = 'serving') => ({phase, loop: {lastTurnAgeMs: age}, heap: {usedMb, limitMb}});

test('killRule: 10 s hang, 95 % heap for 5 s by default; each can be turned off', () => {
  assert.deepEqual(killRule({}), {hangMs: 10_000, heapPct: 95, heapMs: 5_000});
  assert.deepEqual(killRule({SIM_HANG_KILL_MS: '3000', SIM_HEAP_KILL_PCT: '0'}), {hangMs: 3000, heapPct: 0, heapMs: 5_000});
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
  assert.deepEqual(j(live(10, 870, 1000), t), {reason: 'heap', usedMb: 870, limitMb: 1000, forMs: 5000});
  const k = killJudge({hangMs: 0, heapPct: 95, heapMs: 5_000});
  for (t = 0; t <= 4500; t += 500) k(live(10, t === 2000 ? 850 : 860, 1000), t);
  assert.equal(k(live(10, 860, 1000), 5000), null, 'it dipped at 2 s');
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
