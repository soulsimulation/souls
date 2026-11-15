// Strict offers: every id a world offers is actable or refused for a world reason, never as unknown. The toy engine has no
// mars:pose_v1, so it offered sit-ground:here (and every other pose offer) that the act then refused as action.unknown-verb.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {toyFactory} from '@souls/engine-toy';
import {fixture, invite, accept} from '../test/native-owner-fixture.ts';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import type {EdgeSoul} from './edge/contract.ts';
import type {WorldHost} from './world.ts';

const UNKNOWN = new Set(['action.unknown-verb', 'capability.unknown']);
// (edge-strict-sweep.test.ts makes the same strict-gate and dry-run checks on hello-hamlet, eden-2026 and mars-two from several places)
function unknowns(edge: EdgeLedger, host: WorldHost, soul: EdgeSoul) {
  const {caps, plans} = edge.coreA.binds(soul), bad: string[] = [];
  for (const c of caps) {
    const no = edge.offerGate(soul, {capability: c.id, params: {}});
    if (no && UNKNOWN.has(no.code)) bad.push(`${c.id}: ${no.code}`);
    const p = plans.get(c.id); if (!p) continue;
    const dry = host.engine.canPerform({actor: soul.entityId, label: p.label, steps: p.steps});
    if (dry && UNKNOWN.has(dry.code)) bad.push(`${c.id}: ${dry.code}`);
  }
  return {n: caps.length, bad};
}

test('toy world: no offer the act would refuse as unknown; sit-ground:here is not offered', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'known-verbs-'));
  const f = fixture(join(dir, 'world.db'), toyFactory as never, {durableClockV1: true}); f.brain.quiesce();
  const edge = new EdgeLedger(f.host, f.db, undefined, {ambient: false});
  t.after(() => {f.host.stop(); f.db.close(); rmSync(dir, {recursive: true, force: true});});
  const tick = async (k = 5) => {for (let i = 0; i < k; i++) {f.host.tickOnce(); await setImmediate(); f.host.drainInputs();}};
  await tick(); await invite(f, 'ana');
  const row = await accept(f.host, f.souls.create('dev:ana', {name: 'Ana', description: 'Known verbs test'})) as {id: string; entityId?: string; entity_id?: string};
  const soul = {soulId: row.id, entityId: (row.entityId ?? row.entity_id)!, name: 'Ana', owner: 'dev:ana'} as EdgeSoul;
  await tick();
  const {n, bad} = unknowns(edge, f.host, soul);
  assert.ok(n > 10, `${n} offers`);
  assert.deepEqual(bad, []);
  assert.ok(!edge.coreA.binds(soul).caps.some(c => c.id === 'sit-ground:here'));
  assert.ok(edge.coreA.binds(soul).caps.some(c => c.id === 'rest:here'), 'what the toy engine can do is still offered');
});

test('hello-hamlet: the mars engine keeps its pose offers', {timeout: 300000}, async t => {
  const w = await bootEden(() => {}, new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url));
  t.after(() => w.close());
  const {n, bad} = unknowns(w.edge, w.host, w.soul);
  assert.ok(n > 30, `${n} offers`);
  assert.deepEqual(bad, []);
  for (const id of ['sit-ground:here', 'wave:here', 'dance:here']) assert.ok(w.edge.coreA.binds(w.soul).caps.some(c => c.id === id), id);
});
