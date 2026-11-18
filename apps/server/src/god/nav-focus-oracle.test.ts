// #2486 A1: a focused build that names walk, sit, hang-out or stroll ids finds their entries of the walk ranking without
// ranking every thing (GodNav.selectedRefs). The oracle: for every named thing and room of Eden 2026, one ref at a time
// and in sets, the bounded entries equal the whole ranking's (same things, distances and order), at the arrival and
// after walks; and a focused nav listing's wanted offers equal the whole listing's, in order, with their plans.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {setImmediate} from 'node:timers/promises';
import {bootEden} from '../../test/eden-capabilities-timing.ts';
import {accept} from '../../test/native-owner-fixture.ts';
import {focusFor, wants, type MenuFocus} from '../edge/ledger/focus.ts';
import type {EdgeCapability, EdgeSoul} from '../edge/contract.ts';

const NO_EDEN = existsSync(new URL('../../../../worlds/templates/eden-2026.json', import.meta.url)) ? false : 'needs worlds/templates/eden-2026.json';
type Plans = Map<string, {label: string; steps: unknown[]}>;
type Nav = {
  things(): {ref: string}[];
  pickOracleV1(soul: EdgeSoul, refs: ReadonlySet<string>): {bounded: unknown; full: unknown};
  capabilities(soul: EdgeSoul, caps: EdgeCapability[], plans: Plans, focus?: MenuFocus | null): void;
};

/** Every ref alone, then sets of eight: the number of refs whose entries were compared. */
function sweep(nav: Nav, soul: EdgeSoul, what: string): number {
  const refs = nav.things().map(t => t.ref), bad: string[] = [];
  const check = (set: Set<string>) => {const o = nav.pickOracleV1(soul, set); if (JSON.stringify(o.bounded) !== JSON.stringify(o.full)) bad.push(`${[...set].join(',')}: ${JSON.stringify(o.bounded).slice(0, 160)} | ${JSON.stringify(o.full).slice(0, 160)}`);};
  for (const r of refs) check(new Set([r]));
  for (let i = 0; i < refs.length; i += 8) check(new Set(refs.slice(i, i + 8)));
  check(new Set(['no-such-thing-anywhere']));
  assert.deepEqual(bad.slice(0, 6), [], `${what}: ${bad.length} sets differ`);
  return refs.length;
}

/** The nav listing for one id's focus equals the whole listing's offers that focus wants (and their plans). */
function listings(nav: Nav, soul: EdgeSoul, ids: string[], what: string) {
  const all: EdgeCapability[] = [], allPlans: Plans = new Map(); nav.capabilities(soul, all, allPlans, null);
  const bad: string[] = [];
  for (const id of ids) {
    const focus = focusFor(id), built: EdgeCapability[] = [], plans: Plans = new Map(); nav.capabilities(soul, built, plans, focus);
    // (a focused build may make more than it names, the walk beside a hang-out: the ledger keeps what the focus wants)
    const caps = built.filter(c => wants(focus, c.id, c.verb, c.target?.id)), want = all.filter(c => wants(focus, c.id, c.verb, c.target?.id));
    const a = JSON.stringify([caps, caps.map(c => plans.get(c.id) ?? null)]), b = JSON.stringify([want, want.map(c => allPlans.get(c.id) ?? null)]);
    if (a !== b) bad.push(`${id}: ${a.slice(0, 200)} | ${b.slice(0, 200)}`);
  }
  assert.deepEqual(bad.slice(0, 6), [], `${what}: ${bad.length} of ${ids.length} focused listings differ`);
}

test('Eden 2026: a focused walk build finds its ranking entries exactly as the whole ranking does', {timeout: 900_000, skip: NO_EDEN}, async t => {
  const w = await bootEden(); t.after(() => w.close());
  const L = w.edge, host = w.host, soul = w.soul, nav = (w.bridge as unknown as {nav: Nav}).nav;
  const run = async (n: number) => {for (let i = 0; i < n; i++) {host.tickOnce(); if (i % 10 === 0) {await setImmediate(); host.drainInputs();}} await setImmediate(); host.drainInputs();};
  await run(120);
  const idsOf = () => {
    const all: EdgeCapability[] = []; nav.capabilities(soul, all, new Map(), null);
    const listed = all.map(c => c.id), refs = nav.things().map(x => x.ref);
    // the listing's own ids, ids of things it leaves out (far, upstairs) and a few kinds of id no thing has
    return [...listed, ...refs.filter((_, i) => i % 23 === 0).flatMap(r => [`walk:${r}`, `sit:${r}`, `hang-out:${r}`, `stroll:${r}`]), 'walk:no-such-thing', 'sit:here', 'object:x:read', 'sit-ground:here'];
  };
  assert.ok(sweep(nav, soul, 'arrival') > 1000, 'Eden 2026 has thousands of named things');
  listings(nav, soul, idsOf(), 'arrival');
  const raw = L as unknown as {binds(s: EdgeSoul): {caps: EdgeCapability[]}};
  for (const k of [5, 40]) {
    const go = raw.binds(soul).caps.filter(c => c.verb === 'walk' && c.available && c.target?.kind === 'place')[k];
    if (!go) continue;
    const r = await accept(host, L.act(soul, {capability: go.id})); assert.equal(r.accepted, true, `${go.id}: ${JSON.stringify(r).slice(0, 200)}`);
    for (let i = 0; i < 12 && L.openReceipts(soul.soulId).length; i++) await run(25);
    sweep(nav, soul, `after ${go.id}`); listings(nav, soul, idsOf(), `after ${go.id}`);
  }
});
