// #2297 A3: the gardens' last dried day is stored, so a world loaded three world days later dries exactly as one that ran.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { fixture, factory } from '../../test/native-owner-fixture.ts';
import { GodMode } from './god.ts';
import { installEngineBridge } from './engine-bridge.ts';

const DAY = 200;
function open(path: string, t: test.TestContext, origin: (tick: number) => number) {
  const f = fixture(path, factory); f.brain.quiesce();
  const god = new GodMode(f.db, { worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit: () => {} });
  installEngineBridge({ host: f.host, god, log: () => {}, worldLore: false, worldClock: false } as never);
  const living0 = (f.host as unknown as { living?: object }).living ?? {};
  Object.defineProperty(f.host, 'living', { configurable: true, value: { ...living0, origin: origin(f.host.engine.world.tick), dayTicks: DAY } });
  let open_ = true; const close = () => { if (!open_) return; open_ = false; f.host.stop(); f.db.close(); }; t.after(close);
  const tick = async (n: number) => { for (let i = 0; i < n; i++) { f.host.tickOnce(); if (i % 10 === 0) { await setImmediate(); f.host.drainInputs(); } } for (let i = 0; i < 5; i++) await setImmediate(); };
  return { f, god, tick, close };
}
const bed = (god: GodMode) => [...god.model.entities.values()].find((e) => e.name === 'garden-bed')!.state;

test('A3: a world loaded three days later dries its gardens by three days, as one that ran', { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'garden-day-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const defs = JSON.parse(readFileSync(new URL('../../../../worlds/patches/mars-water-20261016/defs.json', import.meta.url), 'utf8'));
  const plant = (god: GodMode) => assert.equal((god.act({ ops: [...defs.map((def: unknown) => ({ op: 'define', def })), { op: 'place', def: 'mars-planter@1', name: 'garden-bed', p: [4, 6], state: { moisture: 0.9 } }] } as never, 'garden') as { accepted: boolean }).accepted, true);
  // the control runs through three day turns
  const control = open(join(dir, 'control.db'), t, (tick) => tick - 10 * DAY - 20); plant(control.god); await control.tick(20);
  const start = structuredClone(bed(control.god));
  await control.tick(3 * DAY);
  assert.notDeepEqual(bed(control.god), start, 'the control dried');
  // the other world sees day 10, stops, and is loaded at day 13 (its clock having gone on meanwhile)
  const path = join(dir, 'away.db'); let at = 0;
  const a = open(path, t, (tick) => (at = tick - 10 * DAY - 20)); plant(a.god); await a.tick(20);
  assert.deepEqual(bed(a.god), start);
  a.f.host.saveSnapshot(true); a.close();
  const b = open(path, t, () => at - 3 * DAY);
  await b.tick(20);
  assert.deepEqual(bed(b.god), bed(control.god), 'three days of drying, the same as the control');
});
