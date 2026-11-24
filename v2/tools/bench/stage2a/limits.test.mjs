import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gaveWay, judge } from './limits.mjs';

const held = () => ({
  accepted: { p50Ms: 50, p95Ms: 150 }, wait: { streamLagP50Ms: 400, streamLagP95Ms: 700 }, tick: { onTimeShare: 0.999 },
  stuck: { stuck: 0 }, cpu: { worldMb: 1500, gatewayMb: 100, originMb: 60 },
  viewers: { latency: { n: 900, p50Ms: 500, p95Ms: 900 }, firstMinute: { p50Ms: 480 }, lastMinute: { p50Ms: 520 } },
});

test('a rung inside every limit holds', () => assert.deepEqual(judge(held()), []));

test('each limit is named when missed', () => {
  const r = held();
  r.accepted.p95Ms = 400; r.tick.onTimeShare = 0.97; r.stuck.stuck = 2; r.viewers.lastMinute.p50Ms = 1200;
  assert.deepEqual(judge(r, 1000).map((m) => m.split(' (')[0]), ['receipt', 'viewer delay grows', 'ticks on time', 'stuck Souls', 'memory']);
});

test('viewer delay falls back to the driver without viewers, and no result is a crash', () => {
  const r = held(); r.viewers = null; r.wait.streamLagP95Ms = 2500;
  assert.deepEqual(judge(r).map((m) => m.split(' (')[0]), ['viewer delay']);
  assert.match(judge(null)[0], /^no result/);
});

test('the first count with a miss is the one that gave way', () => {
  const bad = held(); bad.tick.onTimeShare = 0.9;
  const rows = [{ n: 500, arm: 'even', rate: 'every4', repeat: 'r1', r: bad }, { n: 100, arm: 'even', rate: 'every4', repeat: 'r1', r: held() }];
  assert.match(gaveWay(rows), /^\*\*Gave way first:\*\* at 500 agents: even every4 r1: ticks on time/);
  assert.match(gaveWay(rows.slice(1)), /Every limit held\*\* up to 100/);
});
