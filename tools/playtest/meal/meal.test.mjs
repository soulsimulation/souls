import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ENTRIES, sceneOf, foundId, requireDone, requireField, terminalReceipt, meal } from './meal.mjs';
const entries = ENTRIES.map((p) => JSON.parse(readFileSync(resolve('content/kinds', p + '.json'), 'utf8')));

test('the scene keeps original entry defaults and the bowl on the only serving shelf', () => {
  const scene = sceneOf(entries), ops = scene.template.batches[0].ops;
  const pot = ops.find((o) => o.def?.name === 'meal-camp-soup-pot').def;
  assert.equal(pot.state.soup.default, 0);
  assert.equal(pot.state.vegetables.default, 3);
  assert.equal(pot.slots[0].id, 'shelf');
  assert.deepEqual(pot.slots[0].p, [0.3, 0.96, 0]);
  const bowl = ops.find((o) => o.name === 'meal-bowl');
  assert.deepEqual(bowl.in, { parent: '$pot', slot: 'shelf' });
  assert.equal(scene.map.rows.find((r) => r.def === bowl.def).entry, 'eden:soup_bowl');
  assert.equal(scene.map.rows.length, entries.length);
});

test('a refusal or an unfinished receipt never counts as completed work', () => {
  for (const answer of [{ ok: false, phase: 'refused', code: 'not-held' }, { ok: true, phase: 'started' }, { ok: true }, { phase: 'done' }]) {
    assert.throws(() => requireDone(answer, 'take bowl'));
  }
  assert.equal(requireDone({ ok: true, phase: 'done' }, 'take bowl').phase, 'done');
});

test('quantity evidence must name the exact value, with no missing-field success', () => {
  requireField({ state: { soup: 2 } }, 'soup', 2, 'serving');
  requireField({ state: { cooked: 0 } }, 'cooked', false, 'raw pot');
  requireField({ state: { cooked: true } }, 'cooked', true, 'cooked pot');
  assert.throws(() => requireField({ state: { cooked: 2 } }, 'cooked', true, 'invalid boolean'));
  assert.throws(() => requireField({ state: { soup: 1 } }, 'soup', 2, 'serving'));
  assert.throws(() => requireField({ state: {} }, 'soup', 2, 'serving'));
});

test('native identifiers come from a unique named client result, never from scene ids', () => {
  assert.equal(foundId({ found: [{ name: 'soup-pot', id: 'native-pot' }] }, 'soup-pot'), 'native-pot');
  assert.throws(() => foundId({ found: [] }, 'soup-pot'));
  assert.throws(() => foundId({ found: [{ name: 'soup-pot' }] }, 'soup-pot'), /missing public id/);
  assert.throws(() => foundId({ found: [{ name: 'soup-pot' }, { name: 'soup-pot' }] }, 'soup-pot'));
});

test('a real refusal stops the workflow before any food or ownership claim', async () => {
  const calls = [], seats = ['cook', 'server', 'diner'].map((label) => ({ label, run: async (...words) => {
    calls.push({ label, words }); return { ok: false, phase: 'refused', code: 'world-not-ready' };
  } })), report = { complete: false, steps: [] };
  await assert.rejects(meal({ seats, report }), /world-not-ready/);
  assert.equal(calls.length, 1);
  assert.equal(report.complete, false);
  assert.equal(report.steps.length, 1);
});

test('set-down waits for its final receipt rather than treating sent as success', () => {
  assert.equal(terminalReceipt({ ok: true, sequence: 14, sent: true }), null);
  assert.equal(terminalReceipt({ receipt: { answers: [{ answer: 'accepted' }] } }), null);
  assert.equal(terminalReceipt({ receipt: { answers: [{ answer: 'accepted' }, { answer: 'receipt' }] } }).phase, 'done');
  const refused = terminalReceipt({ receipt: { answers: [{ answer: 'refused', reason: 'setdown.no-room' }] } });
  assert.equal(refused.phase, 'refused');
  assert.throws(() => requireDone(refused, 'return bowl'));
});

test('already arrived Souls are not joined a second time', async () => {
  const calls = [], seats = ['cook', 'server', 'diner'].map(label => ({ label, run: async (...words) => {
    calls.push(words); return words[0] === 'status' ? { ok: true, in_world: true, body: label + '-body' } : words[0] === 'help' ? { ok: true, commands: ['look', 'find', 'inspect', 'can', 'act', 'give', 'receipt'] } : { ok: true, found: [] };
  } }));
  await assert.rejects(meal({ seats, report: { complete: false, steps: [] } }), /expected one named thing/);
  assert.equal(calls.filter(w => w[0] === 'status').length, 3);
  assert(!calls.some(w => w.includes('life:join')));
});

test('the meal table preserves canonical physical surface metadata without adding collision geometry', () => {
  const canonical = JSON.parse(readFileSync(resolve('packages/world-compiler/src/core-kit/furniture.json'), 'utf8')).find((d) => d.name === 'core-table');
  const table = sceneOf(entries).template.batches[0].ops.find((o) => o.def?.name === 'meal-table').def;
  assert.deepEqual(table.slots, canonical.slots);
  assert.deepEqual(table.components, canonical.components);
  assert.equal(table.slots[0].kind, 'surface');
  assert.deepEqual(table.slots[0].p, [0, 0.75, 0]);
  assert(!table.make.args.shapes.some((s) => s.collide === true));
});

// Public reply fixtures, deliberately independent of the client implementation. Act aliases make it observable
// that the workflow uses inspected offers rather than reconstructing form:<id> from authored fixture entries.
function publicMeal({ lostHolder = false, missingBowlParameter = false } = {}) {
  const calls = [], state = { cooked: false, soup: 0, bowl: 0, parent: 'pot', water: 5000, running: false };
  const ids = { 'soup-pot': 'pot', 'meal-bowl': 'bowl', 'wash-sink': 'sink', 'meal-table': 'table', 'diner-chair': 'chair' };
  const offer = (id, name, params, who = 'anyone') => ({ name, act: `${name}-public:${id}`, who, ...(params ? { params } : {}) });
  const inspect = (id) => ({ ok: true, id, card: `Public ${id} card`, ...(id === 'bowl' ? { parent: state.parent } : {}), state:
    id === 'pot' ? { soup: state.soup, vegetables: state.cooked ? 0 : 3, water: state.cooked ? 0 : 1500, fuel: state.cooked ? 0 : 1, cooked: state.cooked } :
    id === 'bowl' ? { soup: state.bowl } : id === 'sink' ? { water: state.water, running: state.running } : {},
    offers: [offer(id, 'walk'), ...(id === 'pot' ? [offer(id, 'cook'), offer(id, 'ladle', missingBowlParameter ? {} : { bowl: { type: 'thing', optional: true } })] :
      id === 'bowl' ? [offer(id, 'take'), offer(id, 'bite', null, 'holder')] :
      id === 'sink' ? [offer(id, 'turn_on'), offer(id, 'turn_off'), offer(id, 'wash', { thing: { type: 'thing' } })] :
      id === 'chair' ? [offer(id, 'sit')] : [])] });
  const seats = ['cook', 'server', 'diner'].map((label) => ({ label, run: async (...words) => {
    calls.push({ label, words });
    const [command, word] = words;
    if (command === 'status') return { ok: true, in_world: true, body: `${label}-body` };
    if (command === 'help') return { ok: true, commands: ['look', 'find', 'inspect', 'can', 'act', 'give', 'receipt'] };
    if (command === 'look') return { ok: true, nearby: Object.entries(ids).map(([name, id]) => ({ name, id })) };
    if (command === 'find') return { ok: true, found: [{ name: word, id: ids[word] }] };
    if (command === 'inspect') return inspect(word);
    if (command === 'can') return state.cooked ? { ok: true, can: 'yes', current: true } : { ok: true, can: 'no', reason: 'field_differs', field: 'cooked', current: true };
    if (command === 'give') {
      if (word === 'accept') { state.parent = 'diner-body'; return { ok: true, phase: 'done' }; }
      return { ok: true, sent: true };
    }
    if (command === 'wait') return { ok: true, give: { offer: 'bowl-offer' } };
    if (command === 'set-down') return { ok: true, sequence: 17 };
    if (command === 'receipt') { state.parent = 'table'; return { ok: true, receipt: { answers: [{ answer: 'receipt' }] } }; }
    if (command === 'act') {
      const form = word.split(':')[0];
      if (form === 'cook-public') { state.cooked = true; state.soup = 6; }
      if (form === 'ladle-public') { state.soup -= 2; state.bowl += 2; }
      if (form === 'take-public') state.parent = 'server-body';
      if (form === 'bite-public') { state.bowl--; if (lostHolder) state.parent = 'unrelated-body'; }
      if (form === 'turn_on-public') state.running = true;
      if (form === 'turn_off-public') state.running = false;
      if (form === 'wash-public') state.water -= 1000;
      return { ok: true, phase: 'done' };
    }
    throw new Error(`unexpected public command ${command}`);
  } }));
  return { seats, calls };
}

test('the meal discovers each role, recovers from raw soup and conserves the same held bowl', async () => {
  const fixture = publicMeal(), report = { complete: false, steps: [] };
  await meal({ seats: fixture.seats, report });
  assert.equal(report.complete, true);
  assert.deepEqual(report.quantities, { cooked: 6, remaining: 4, eaten: 2, washWaterUsed: 1000 });
  assert.deepEqual(report.bowlIdentity, { id: 'bowl', server: 'server-body', diner: 'diner-body', returnedTo: 'table' });
  assert.equal(report.recovery.before.can, 'no'); assert.equal(report.recovery.after.can, 'yes');
  assert.equal(Object.keys(report.discovery).length, 3);
  for (const role of ['cook', 'server', 'diner']) {
    assert(fixture.calls.some((c) => c.label === role && c.words[0] === 'look'));
    assert.match(report.discovery[role].responsibility, /cook|ladle|bowl/i);
  }
  assert(fixture.calls.some((c) => c.words.includes('ladle-public:pot') && c.words.includes('bowl=bowl')));
  assert(!fixture.calls.some((c) => c.words.includes('ladle:pot')));
});

test('missing public bowl arguments stop discovery before anyone cooks', async () => {
  const fixture = publicMeal({ missingBowlParameter: true });
  await assert.rejects(meal({ seats: fixture.seats, report: { complete: false, steps: [] } }), /public thing parameter bowl/);
  assert(!fixture.calls.some((c) => c.words[0] === 'act'));
});

test('a bowl that leaves its holder during eating stops before washing or claiming completion', async () => {
  const fixture = publicMeal({ lostHolder: true }), report = { complete: false, steps: [] };
  await assert.rejects(meal({ seats: fixture.seats, report }), /consumed bowl left the diner/);
  assert.equal(report.complete, false);
  assert(!fixture.calls.some((c) => c.words.includes('wash-public:sink')));
});
