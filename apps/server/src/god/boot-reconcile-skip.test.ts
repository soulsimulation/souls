// The boot reconcile skip: a boot from a snapshot written by the same build, with the bridge in step at the god model's
// present edit, takes the engine's physics as they are instead of deriving every entity again (engine-bridge.ts
// bootRecord). A boot that skips ends in the same state, and a later edit sends the same world-edit, as one that derives;
// a different build or a god edit after the snapshot derives everything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { marsFactory, GREEN_FIELD_WORLD } from '@souls/engine-mars';
import { coreRef } from '@souls/world-compiler';
import { Db } from '../db.ts';
import { WorldHost } from '../world.ts';
import { GodMode } from './god.ts';
import { installEngineBridge, type BootRecordV1 } from './engine-bridge.ts';

const factory = await marsFactory(GREEN_FIELD_WORLD);
const seed = 'boot-reconcile-skip', worldId = 'boot-reconcile-skip';
const turns = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
// a walled yard with a gate and a door standing in it: the door facts (doorIds, gated) are what a skipped derive keeps
const yard = [
  { op: 'place', def: coreRef('garden-wall'), name: 'yard', shape: { path: [[-4, 0], [4, 0], [4, 6], [-4, 6], [-4, 0]] }, params: { gates: [{ at: 4, width: 1.2 }] } },
  { op: 'place', def: coreRef('door'), name: 'door', p: [0, 0] },
  { op: 'place', def: coreRef('chair'), name: 'chair', p: [10, 3] },
];

function open(file: string, record?: { file: string; build: string }) {
  const db = new Db(file), host = new WorldHost(db, factory, seed, 1e9, worldId);
  host.boot(); host.drainInputs();
  const god = new GodMode(db, { worldId, ownerId: 'dev:admin', tick: () => host.engine.world.tick, emit() {} });
  const logs: string[] = [];
  const bridge = installEngineBridge({ host, god, log: (m) => logs.push(m), worldClock: false, worldLore: false, ...(record ? { bootRecord: record } : {}) });
  const close = () => { host.stop(); db.close(); };
  return { db, host, god, bridge, logs, close };
}
const ticks = async (w: ReturnType<typeof open>, n: number) => { for (let i = 0; i < n; i++) { w.host.tickOnce(); await turns(); } };

/** A world built and snapshotted by build `b1`, closed: its database file and the record beside it. */
async function made(dir: string) {
  const file = join(dir, 'world.db'), record = { file: join(dir, 'boot-reconcile.json'), build: 'b1' };
  const w = open(file, record);
  assert.equal(w.god.act({ ops: yard as never }).accepted, true);
  await ticks(w, 3);
  w.host.saveSnapshot(true);
  w.close();
  return { file, record };
}

test('a boot from a snapshot of this build at the present edit skips the derive and ends where a full derive does', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'souls-boot-skip-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { file, record } = await made(dir);
  const rec = JSON.parse(readFileSync(record.file, 'utf8')) as BootRecordV1;
  assert.equal(rec.build, 'b1'); assert.ok(rec.doorIds.length >= 1, 'the door is recorded'); assert.ok(rec.gated.length >= 1, 'the gated wall is recorded');
  copyFileSync(file, join(dir, 'skip.db')); copyFileSync(file, join(dir, 'full.db'));
  const skip = open(join(dir, 'skip.db'), record), full = open(join(dir, 'full.db'));
  t.after(() => { skip.close(); full.close(); });
  assert.equal(skip.host.engine.stateHash(), full.host.engine.stateHash(), 'the same boot head');
  await ticks(skip, 2); await ticks(full, 2);
  assert.equal(skip.bridge.stats.bootSkipped, true); assert.equal(full.bridge.stats.bootSkipped, false);
  assert.ok(skip.logs.some((l) => l.includes('nothing to derive')));
  assert.equal(skip.bridge.stats.edits, 0); assert.equal(full.bridge.stats.edits, 0, 'the full derive found nothing to send either');
  assert.equal(skip.host.engine.stateHash(), full.host.engine.stateHash(), 'the boot state hash is unchanged');
  assert.equal(skip.bridge.initialProjectionReady(), true);
  const doors = (w: ReturnType<typeof open>) => { const b = w.bridge as unknown as { doorIds: Set<string>; gated: Set<string> }; return { doorIds: [...b.doorIds].sort(), gated: [...b.gated].sort() }; };
  assert.deepEqual(doors(skip), doors(full), 'the door facts a skipped derive keeps are the ones a full derive finds');
  // an edit after boot: the door leaves the gate (the gated wall is derived again from the kept door facts)
  for (const w of [skip, full]) assert.equal(w.god.act({ ops: [{ op: 'move', id: w.god.model.get('door')!.id, p: [12, 0] }] as never }).accepted, true);
  await ticks(skip, 3); await ticks(full, 3);
  const edits = (w: ReturnType<typeof open>) => w.db.events(worldId).filter((e) => e.kind === 'world-edit').map((e) => e.payload);
  assert.deepEqual(edits(skip), edits(full), 'the same world-edit after boot');
  assert.equal(skip.host.engine.stateHash(), full.host.engine.stateHash(), 'the same state after the edit');
});

test('a different build, or a god edit after the snapshot, derives everything', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'souls-boot-skip-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { file, record } = await made(dir);
  copyFileSync(file, join(dir, 'other.db'));
  const b2 = open(join(dir, 'other.db'), { ...record, build: 'b2' }); t.after(() => b2.close());
  await ticks(b2, 1);
  assert.equal(b2.bridge.stats.bootSkipped, false, 'another build derives');

  copyFileSync(file, join(dir, 'edited.db'));
  // a god edit committed after the snapshot (the model's edit sequence moves past the record's)
  const db = new Db(join(dir, 'edited.db')), god = new GodMode(db, { worldId, ownerId: 'dev:admin', tick: () => 0, emit() {} });
  assert.equal(god.act({ ops: [{ op: 'place', def: coreRef('chair'), name: 'chair-2', p: [14, 3] }] as never }).accepted, true); db.close();
  const edited = open(join(dir, 'edited.db'), record); t.after(() => edited.close());
  await ticks(edited, 1);
  assert.equal(edited.bridge.stats.bootSkipped, false, 'an edit after the snapshot derives');
  assert.ok(edited.bridge.stats.edits >= 1, 'and sends the new chair');

  // a dev build neither skips nor keeps a record
  copyFileSync(file, join(dir, 'dev.db'));
  const dev = open(join(dir, 'dev.db'), { ...record, build: 'dev' }); t.after(() => dev.close());
  await ticks(dev, 2); dev.host.saveSnapshot(true);
  assert.equal(dev.bridge.stats.bootSkipped, false); assert.equal(existsSync(record.file), false, 'the record is removed');
});
