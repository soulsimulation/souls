// The run gate's verdicts are true (follow-up to SA-X23, PR #3304): what it loads, how it sets a scene and how it judges,
// each checked without a world. One test per proposal it answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadDef} from './load.mjs';
import {casesFor, newEngineGap, placeDistance, rulesFix, runOnce, setsOf, startFields, unloadedWhy} from './run.mjs';
import {loadEntries} from './look.mjs';
import {loadCases} from '../../packages/form-rules/src/load.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const entries = new Map(loadEntries(join(ROOT, 'content/kinds'), 'content/kinds').filter(r => r.entry && !r.errors.length).map(r => [r.entry.kind, r.entry]));
const kind = k => entries.get(`eden:${k}`);
const caseNamed = name => loadCases().find(([, c]) => c.name === name)[1];

/** A world that does what it is told: it places, sets and reads fields, offers every form and completes every act. */
function fakeWorld({unloaded = new Map()} = {}) {
  const things = new Map(), placed = [], acts = [];
  let n = 0;
  return {
    placed, acts, things, name: 'fake', timers: false, events: false, reads: [], unloaded,
    async place(k) { const id = `x${++n}`; things.set(id, {kind: k, fields: {}}); placed.push(k); return id; },
    async set(id, fields) { Object.assign(things.get(id).fields, fields); },
    async remove(id) { things.delete(id); },
    async offers(id) { return Object.keys(kind(things.get(id).kind.split(':')[1]).forms); },
    async fields(id) { return {...things.get(id)?.fields}; },
    async act(id, form, args) { acts.push({id, form, args}); return {verdict: 'yes', receipt: 'completed'}; },
  };
}

test('(1, 8) a kind the world refuses, or one with no shape, skips its own cases with that cause', async () => {
  const kinds = new Map([['eden:kiosk', kind('kiosk')]]), rows = casesFor([{kind: 'eden:kiosk', entry: kind('kiosk')}]).slice(0, 2);
  const why = 'the world refused its def: size.range (box below 0.05 m)';
  const out = await runOnce(fakeWorld({unloaded: new Map([['eden:kiosk', why]])}), kinds, rows);
  assert.deepEqual(out.map(r => [r.result, r.why]), rows.map(() => ['skip', `eden:kiosk: ${why}`]));
  assert.equal(unloadedWhy(['looks.shape.shapes is missing: there is nothing to draw']), 'no thing to place: the kind has no looks.shape');
});

test('(1) a thin thing\'s box is padded to 5 cm on the test world; the drawing is the entry\'s', () => {
  const thin = [...entries.values()].find(e => e.owner === 'thing' && e.looks?.shape?.shapes && Math.min(...e.geometry.bounds_mm) < 50);
  const {def} = loadDef(thin, 'x@1');
  assert.ok(Math.min(...def.size.box) >= 0.05, `${thin.kind}: ${def.size.box}`);
});

test('(2) a bool written 0/1 by an effect case is set and compared as false/true', () => {
  const kinds = new Map([['eden:kiosk', kind('kiosk')]]), c = {state: {nodes: {t1: {kind: 'eden:kiosk'}}}};
  assert.deepEqual(setsOf({changes: [{change: 'set', node: 't1', field: 'open', to: 1}]}, {t1: 'x1'}, c, kinds), {x1: {open: true}});
  assert.deepEqual(startFields(kind('kiosk'), {fields: {open: 0}}), {open: false, locked: false});
});

test('(3) text is carried as a string; a list, schedule or timed field is new engine only and its cases skip', () => {
  const {def, skipped} = loadDef(kind('kiosk'), 'x@1');
  assert.equal(def.state.open_times.type, 'json', 'held, so an effect can still set it');
  assert.equal(startFields(kind('kiosk'), {}).open_times, undefined, 'but never set or compared by the gate: a Soul does not read it back');
  assert.ok(skipped.some(s => s.what === 'state.open_times' && /new engine only/.test(s.why)));
  assert.equal(loadDef(kind('mural_panel'), 'x@1').def.state.picture.type, 'string');
  assert.deepEqual(startFields(kind('mural_panel'), {}), {}, 'a text with nothing written is left unset, not set to null');
  const kinds = new Map([['eden:kiosk', kind('kiosk')]]);
  assert.match(newEngineGap({state: {nodes: {t1: {kind: 'eden:kiosk', fields: {open_times: []}}}}}, kinds), /open_times \(a schedule field\): new engine only/);
  assert.equal(newEngineGap(caseNamed('open_a_closed_kiosk'), kinds), null, 'a default the case does not name is not needed');
});

test('(4) a rule case places the other things it names and maps its args to them', async () => {
  const kinds = new Map(['cutting_donor', 'nursery_pot'].map(k => [`eden:${k}`, kind(k)]));
  const row = casesFor([...kinds].map(([k, entry]) => ({kind: k, entry}))).find(r => r.name === 'take_cutting_every_need_met');
  const w = fakeWorld(), [r] = await runOnce(w, kinds, [row]);
  assert.equal(r.result, 'pass', r.why);
  assert.deepEqual(w.placed, ['eden:cutting_donor', 'eden:nursery_pot']);
  assert.deepEqual(w.acts[0].args, {pot: 'x2'}, 'the case\'s pot is the placed pot');
});

test('(5) a building is placed by its own size, not at 3 m', () => {
  assert.equal(placeDistance(kind('sink')), 3);
  const big = [...entries.values()].find(e => e.owner === 'thing' && Math.max(...(e.geometry?.bounds_mm ?? [0])) >= 8000);
  assert.ok(placeDistance(big) > Math.hypot(big.geometry.bounds_mm[0], big.geometry.bounds_mm[2]) / 2000, big.kind);
});

test('(6) a kind whose forms take it into a hand loads as carryable', () => {
  assert.deepEqual(loadDef(kind('molded_candle'), 'x@1').def.components, {carryable: {mass: 0.5}});
  assert.equal(loadDef(kind('sink'), 'x@1').def.components, undefined);
});

test('(7) a refusal whose case leaves the fix out is judged by the rules\' own fix', async () => {
  const c = caseNamed('sink_turn_on_out_of_reach');
  assert.equal(c.expect.fix, undefined);
  assert.deepEqual(rulesFix(c), {step: 'walk_to', point: 'tap'});
  const kinds = new Map([['eden:sink', kind('sink')]]);
  const row = casesFor([{kind: 'eden:sink', entry: kind('sink')}]).find(r => r.name === 'sink_turn_on_out_of_reach');
  const [r] = await runOnce(fakeWorld(), kinds, [row]);
  assert.deepEqual([r.result, r.via], ['pass', 'fix'], 'the world walked there, as the rules\' fix says');
});
