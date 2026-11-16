// N1b (#2593): nav trust carries across the tick boundary while no engine code that can write has run, so the tick's
// first walk step and the reads between ticks take the last pass's scan; any write in between forces a rescan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory, GREEN_FIELD_WORLD } from './engine.ts';
import { navTrustChecking, setNavTrustCheck } from '../../../mars/viewer/engine/spatial/nav-trust.ts';

const factory = await marsFactory(GREEN_FIELD_WORLD);
type Probe = { rt: { services: { spatial: { stats: { scans: number } } }; submit(verb: string, params: unknown): unknown } };
type Reads = { navEpochV1(): number; navWarmV1(budgetMs: number): boolean; staticEpochV1(): number; readPassV1<T>(fn: () => T): T };

test('nav carry: a tick with no write since the last scan reuses it; an engine write or a runtime write between them rescans', () => {
  const was = navTrustChecking();
  setNavTrustCheck(true);   // the oracle: every trusted sync scans anyway and throws on a static change the trust skipped
  try {
    const e = factory.create(factory.genesis('nav-carry')), p = e as unknown as Probe, sp = p.rt.services.spatial, m = e as unknown as Reads;
    e.spawnHuman({ id: 'h_A', label: 'Alice', soul: 's_A' });
    const [x, , z] = e.world.entities.h_A.pose.p;
    const r = e.perform({ actor: 'h_A', label: 'carry walk', steps: [{ verb: 'mars:walk_to', params: { x: x + 20, z } }] });
    assert.equal(r.ok, true, JSON.stringify(r));
    for (let i = 0; i < 5; i++) e.step();
    assert.equal(e.world.entities.h_A.human!.activity, 'walk');
    const scans = () => sp.stats.scans;
    // nothing between ticks: no tick scans (the walk step and the pass take the last pass's scan)
    let s0 = scans();
    for (let i = 0; i < 10; i++) e.step();
    assert.equal(scans() - s0, 0, 'ten walking ticks with nothing between them scan nothing');
    // the reads between ticks take it too, and keep it for the next tick
    s0 = scans();
    m.navEpochV1(); m.navWarmV1(0); m.staticEpochV1(); m.readPassV1(() => m.navEpochV1());
    assert.equal(scans() - s0, 0, 'reads between ticks scan nothing');
    e.step();
    assert.equal(scans() - s0, 0, 'and the next tick still scans nothing');
    // an engine method that can write (a birth) between two ticks: the next tick scans
    e.spawnHuman({ id: 'h_B', label: 'Bob', soul: 's_B' });
    s0 = scans(); e.step();
    assert.ok(scans() - s0 >= 1, 'an engine write between ticks forces a rescan');
    e.step(); s0 = scans(); e.step();
    assert.equal(scans() - s0, 0, 'carried again once nothing writes');
    // a runtime call that can run action code, straight on the runtime past the engine's methods: the next tick scans
    p.rt.submit('no-such-verb', {});
    s0 = scans(); e.step();
    assert.ok(scans() - s0 >= 1, 'a runtime write between ticks forces a rescan');
    // a read between ticks after an engine write scans
    e.step(); e.spawnHuman({ id: 'h_C', label: 'Carol', soul: 's_C' });
    s0 = scans(); m.navEpochV1();
    assert.equal(scans() - s0, 1, 'a read after a write scans');
  } finally { setNavTrustCheck(was); }
});
