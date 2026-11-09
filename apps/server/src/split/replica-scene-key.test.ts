// #1560: the read replica rebuilds its spatial service when main's scene key moves. A restored engine (WorldHost.restoreBody:
// a decision rollback, a recovery rewind, a held head) counts its spatial epochs from the snapshot's, so after a rollback a
// different static change could land on the very key the replica last built: it kept the old static world. The key now
// names the spatial service in use, so a swapped engine's scene is always sent and built.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {fixture, factory} from '../../test/native-owner-fixture.ts';
import {EdgeLedger} from '../edge/ledger/ledger.ts';
import {installDeltaStream, type StreamMessage} from './delta.ts';
import {worldInit} from './world-init.ts';
import {ReplicaWorld} from './replica-world.ts';

type Host = {captureBody(): unknown; restoreBody(b: unknown): void};
type Eng = {installNavV1(spec: unknown): {installed: boolean}; clearanceAtV1(x: number, z: number): number};
const solid = (id: string, x: number) => ({version: 'nav/1', ground: [], solids: [{id, c: [x, 20], half: [1, 1], yaw: 0, height: 2}]});

test('#1560: a rollback then another static change at the same epoch sends a new scene, and the replica reads it', {timeout: 300000}, async t => {
  const f = fixture(':memory:', factory); f.brain.quiesce();
  const edge = new EdgeLedger(f.host, f.db);
  t.after(() => {f.brain.quiesce(); f.host.stop(); f.db.close();});
  const settle = async (n = 3) => {for (let i = 0; i < n; i++) {f.host.tickOnce(); await setImmediate(); f.host.drainInputs();}};
  await settle();
  const tap = installDeltaStream(f.host, edge, {SIM_READ_WORKER: '1'})!;
  const RW = new ReplicaWorld(), msgs: StreamMessage[] = [];
  tap.subscribe(m => msgs.push(structuredClone(m)));
  RW.init(structuredClone(worldInit(f.host, edge, tap)));
  // as the read worker takes main's stream: deltas in order, a resnapshot signal (or a refused delta) re-inits
  const flush = () => {for (const m of msgs.splice(0)) if ('t' in m || !RW.apply(m)) {msgs.length = 0; RW.init(structuredClone(worldInit(f.host, edge, tap))); break;}};
  const host = f.host as unknown as Host, eng = () => f.host.engine as unknown as Eng, replica = RW.mw as unknown as {clearanceAtV1(x: number, z: number): number};
  const blocked = (read: {clearanceAtV1(x: number, z: number): number}, x: number) => read.clearanceAtV1(x, 20) < 0.5;
  flush();
  const before = host.captureBody();
  assert.equal(blocked(eng(), 15), false, 'open ground where solid A will stand');
  assert.ok(eng().installNavV1(solid('solid-a', 15)).installed, 'solid A installed');
  await settle(); flush();
  const keyA = RW.R.sceneKey;
  assert.equal(blocked(replica, 15), true, 'the replica reads solid A');
  // the rollback and the next static change before the stream is read again (a rolled-back decision, then the next one)
  host.restoreBody(before);
  assert.equal(blocked(eng(), 15), false, 'the rollback took solid A away on main');
  assert.ok(eng().installNavV1(solid('solid-b', -15)).installed, 'solid B installed');
  await settle(); flush();
  const epochOf = (k: string) => k.split(':').at(-1)!;
  t.diagnostic(`scene key with A: ${keyA}; with B after the rollback: ${RW.R.sceneKey}`);
  assert.equal(epochOf(RW.R.sceneKey), epochOf(keyA), 'the same spatial epoch and physics hash as with A (the case #1560 names)');
  assert.equal(blocked(replica, 15), false, 'the replica no longer reads solid A');
  assert.equal(blocked(replica, -15), true, 'the replica reads solid B');
  assert.equal(blocked(replica, -15), blocked(eng(), -15), 'as main reads it');
  assert.notEqual(RW.R.sceneKey, keyA, 'a new scene key at the same epoch');
  // the static layer (the named solids, places and spots the read code lists) is resent too: its key names the service
  const solids = () => ((RW.R.static as {solids?: {id: string}[]} | null)?.solids ?? []).map(x => x.id);
  assert.deepEqual(solids(), ['nav-solid:solid-b'], 'the replica\'s static layer lists solid B, not solid A');
});
