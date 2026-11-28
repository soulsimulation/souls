import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { batchSchema } from '../../../packages/world-compiler/src/schemas.ts';
import { validateEntry, hashKinds } from '../../entry/format.mjs';
import { ENTRIES, sceneOf, mealTemplate, foundId, requireDone, requireField, terminalReceipt, requireMeetingRange, meal } from './meal.mjs';
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
    calls.push(words); return words[0] === 'status' ? { ok: true, in_world: true, body: label + '-body' } : words[0] === 'help' ? { ok: true, commands: ['look', 'find', 'inspect', 'can', 'act', 'give', 'receipt', 'events', 'wait', 'query'] } : { ok: true, found: [] };
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
function publicMeal({ lostHolder = false, missingBowlParameter = false, noMatchingOffer = false, expiredOffer = false, canAfter, ladleRefused = false, wrongLadleQuantity = false,
  chairNeedsPullOut = false, sitRefusal, pullOutResult, retrySitRefused = false, chairOfferTarget = 'chair',
  missingMeetingParameter = false, meetingRefused = false, meetingQuery, giveOfferRefused = false, giveAcceptRefused = false } = {}) {
  const calls = [], state = { cooked: false, soup: 0, bowl: 0, parent: 'pot', water: 5000, running: false, chairPulled: false };
  const ids = { 'soup-pot': 'pot', 'meal-bowl': 'bowl', 'wash-sink': 'sink', 'meal-table': 'table', 'diner-chair': 'chair' };
  const offer = (id, name, params, who = 'anyone') => ({ name, act: `${name}-public:${id}`, who, ...(params ? { params } : {}) });
  const inspect = (id) => ({ ok: true, id, card: id === 'pot' ? 'Cook 6; ladle 2 to empty shelf bowl. Meet position=serving_side or diner_side.' : `Public ${id} card`, ...(id === 'bowl' ? { parent: state.parent } : {}), state:
    id === 'pot' ? { soup: state.soup, vegetables: state.cooked ? 0 : 3, water: state.cooked ? 0 : 1500, fuel: state.cooked ? 0 : 1, cooked: state.cooked } :
    id === 'bowl' ? { soup: state.bowl } : id === 'sink' ? { water: state.water, running: state.running } : {},
    offers: [offer(id, 'walk'), ...(id === 'pot' ? [offer(id, 'cook'), offer(id, 'ladle', missingBowlParameter ? {} : { bowl: { type: 'thing', optional: true } }),
      offer(id, 'meet', missingMeetingParameter ? { position: { type: 'value' } } : { position: { type: 'part' } })] :
      id === 'bowl' ? [offer(id, 'take'), offer(id, 'bite', null, 'holder')] :
      id === 'sink' ? [offer(id, 'turn_on'), offer(id, 'turn_off'), offer(id, 'wash', { thing: { type: 'thing' } })] :
      id === 'chair' ? [offer(id, 'sit'), offer(chairOfferTarget, 'pull_out')] : [])] });
  const seats = ['cook', 'server', 'diner'].map((label) => ({ label, run: async (...words) => {
    calls.push({ label, words });
    const [command, word] = words;
    if (command === 'status') return { ok: true, in_world: true, body: `${label}-body` };
    if (command === 'help') return { ok: true, commands: ['look', 'find', 'inspect', 'can', 'act', 'give', 'receipt', 'events', 'wait', 'query'] };
    if (command === 'look') return { ok: true, nearby: Object.entries(ids).map(([name, id]) => ({ name, id })) };
    if (command === 'find') return { ok: true, found: [{ name: word, id: ids[word] }] };
    if (command === 'inspect') return inspect(word);
    if (command === 'can') return state.cooked ? canAfter ?? { ok: true, can: 'yes', current: true } : { ok: true, can: 'no', reason: 'field_differs', field: 'cooked', current: true };
    if (command === 'query') {
      assert.equal(label, 'diner'); assert.deepEqual(JSON.parse(word), [{ find: 'Server', near: 'me', within: 1.5 }]);
      return meetingQuery ?? { ok: true, answers: [{ near: { id: 'diner-body', name: 'Diner', within: 1.5 }, found: [{ id: 'server-body', name: 'Server', kind: 'souls:body', metres: 1.2 }] }] };
    }
    if (command === 'give') {
      if (word === 'accept') { assert.equal(words[2], 'bowl-offer'); if (giveAcceptRefused) return { ok: false, phase: 'refused', reason: 'give.too-far' }; state.parent = 'diner-body'; return { ok: true, phase: 'done' }; }
      if (giveOfferRefused) return { ok: false, phase: 'refused', reason: 'give.not-held' };
      return { ok: true, phase: 'done' };
    }
    if (command === 'events') return { ok: true, events: [{ kind: 'give', what: 'offered', offer: 'old-bowl-offer', thing: 'bowl', from_id: 'server-body' }] };
    if (command === 'wait') return { ok: true, give: { offer: 'untrusted-shortcut' }, events: [
      { kind: 'give', what: 'offered', offer: 'wrong-bowl', thing: 'other-bowl', from_id: 'server-body' },
      { kind: 'give', what: 'offered', offer: 'wrong-giver', thing: 'bowl', from_id: 'other-body' },
      { kind: 'give', what: 'offered', offer: 'old-bowl-offer', thing: 'bowl', from_id: 'server-body' },
      ...(!noMatchingOffer ? [{ kind: 'give', what: 'offered', offer: 'bowl-offer', thing: 'bowl', from_id: 'server-body' }] : []),
      ...(expiredOffer ? [{ kind: 'give', what: 'expired', offer: 'bowl-offer' }] : []),
    ] };
    if (command === 'set-down') return { ok: true, sequence: 17 };
    if (command === 'receipt') { state.parent = 'table'; return { ok: true, receipt: { answers: [{ answer: 'receipt' }] } }; }
    if (command === 'act') {
      const form = word.split(':')[0];
      if (form === 'meet-public') {
        assert.equal(words[2], `position=${label === 'server' ? 'serving' : 'diner'}_side`);
        if (meetingRefused) return { ok: false, phase: 'refused', reason: 'souls:no-way' };
      }
      if (form === 'sit-public' && (chairNeedsPullOut && !state.chairPulled || state.chairPulled && retrySitRefused)) return sitRefusal ?? {
        ok: false, phase: 'refused', reason: 'souls:no-way', receipt: { target: 'chair',
          answers: [{ answer: 'accepted' }, { answer: 'refused', reason: 'souls:no-way' }],
          try: { name: 'pull_out', act: 'pull_out-public:chair', checked: 'unknown' } },
      };
      if (form === 'pull_out-public') { if (pullOutResult) return pullOutResult; state.chairPulled = true; }
      if (form === 'cook-public') { state.cooked = true; state.soup = 6; }
      if (form === 'ladle-public') {
        if (ladleRefused) return { ok: false, phase: 'refused', reason: 'no_free_hand' };
        state.soup -= 2; state.bowl += wrongLadleQuantity ? 1 : 2;
      }
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
  const meeting = fixture.calls.filter(c => c.words[1] === 'meet-public:pot');
  assert.deepEqual(meeting.map(c => [c.label, c.words[2]]), [['server', 'position=serving_side'], ['diner', 'position=diner_side']]);
  const queryAt = fixture.calls.findIndex(c => c.words[0] === 'query'), offerAt = fixture.calls.findIndex(c => c.words[0] === 'give');
  assert(queryAt > fixture.calls.indexOf(meeting[1]) && queryAt < offerAt);
  assert.equal(report.meeting.server, 'server-body');
  assert(!fixture.calls.some(c => c.words[1] === 'walk:server-body'));
});

test('meeting discovery rejects a value selector in place of the supported part argument before cooking', async () => {
  const fixture = publicMeal({ missingMeetingParameter: true });
  await assert.rejects(meal({ seats: fixture.seats, report: { complete: false, steps: [] } }), /public part parameter position/);
  assert(!fixture.calls.some(c => c.words[0] === 'act'));
});

test('a refused meeting stops once, without an offer or blind walking retry', async () => {
  const fixture = publicMeal({ meetingRefused: true });
  await assert.rejects(meal({ seats: fixture.seats, report: { complete: false, steps: [] } }), /souls:no-way/);
  assert.equal(fixture.calls.filter(c => c.words[1] === 'meet-public:pot').length, 1);
  assert(!fixture.calls.some(c => c.words[0] === 'give'));
});

test('public proximity must return the exact server in the diner query radius; rounded nearest is not admission', async () => {
  const near = { id: 'diner-body', within: 1.5 };
  const replies = [
    { ok: false }, { ok: true, answers: [{ error: 'query.unknown-near' }] },
    { ok: true, answers: [{ near, found: [], nearest: { id: 'server-body', metres: 1 } }] },
    { ok: true, answers: [{ near, found: [{ id: 'another-body', metres: 1.2 }] }] },
    { ok: true, answers: [{ near: { ...near, id: 'cook-body' }, found: [{ id: 'server-body', metres: 1.2 }] }] },
    { ok: true, answers: [{ near, found: [{ id: 'server-body' }] }] },
  ];
  for (const meetingQuery of replies) {
    const fixture = publicMeal({ meetingQuery });
    await assert.rejects(meal({ seats: fixture.seats, report: { complete: false, steps: [] } }), /not confirmed within give range/);
    assert(!fixture.calls.some(c => c.words[0] === 'give'));
  }
  const actualBoundaryReply = { ok: true, answers: [{ near, found: [{ id: 'server-body', metres: 1.5 }] }] };
  assert.equal(requireMeetingRange(actualBoundaryReply, 'server-body', 'diner-body'), actualBoundaryReply);
});

test('give or accept refusal remains authoritative even after successful meeting and range query', async () => {
  for (const options of [{ giveOfferRefused: true }, { giveAcceptRefused: true }]) {
    const fixture = publicMeal(options), report = { complete: false, steps: [] };
    await assert.rejects(meal({ seats: fixture.seats, report }), /give\.(not-held|too-far)/);
    assert.equal(report.complete, false);
    assert(!fixture.calls.some(c => c.words[1] === 'sit-public:chair'));
    assert.equal(fixture.calls.filter(c => c.words[0] === 'give' && c.words[1] === 'accept').length, options.giveAcceptRefused ? 1 : 0);
  }
});

test('meeting points validate as existing parts, change the entry meaning and clear conservative fixture bounds', () => {
  const pot = entries.find(e => e.kind === 'eden:camp_soup_pot');
  assert.deepEqual(validateEntry(pot), []);
  assert.deepEqual(pot.forms.meet.takes, { position: { type: 'part' } });
  assert.deepEqual(pot.forms.meet.steps, [{ step: 'walk_to', point: { arg: 'position' } }]);
  assert.deepEqual(pot.forms.meet.effects, []);
  assert.deepEqual(pot.points.serving_side.at_mm, [-600, 0, 2000]);
  assert.deepEqual(pot.points.diner_side.at_mm, [600, 0, 2000]);
  assert.equal(pot.text.card.length <= 80, true);
  const old = structuredClone(pot); delete old.forms.meet; delete old.points.serving_side; delete old.points.diner_side;
  const kinds = entries.filter(e => e.kind !== pot.kind);
  assert.notEqual(hashKinds([...kinds, pot]).get(pot.kind).ref, hashKinds([...kinds, old]).get(pot.kind).ref);
  // Offline conservative boxes only. Monster's declared Giant class radius1300mm (not measured skin width),
  // plus native static margin60+1. Both still need actual-page skin/contact and crowd/route validation.
  const radius = 1300 + 60 + 1, ops = mealTemplate(entries).batches[0].ops;
  const rectangleDistance = (p, centre, half) => Math.hypot(Math.max(0, Math.abs(p[0] - centre[0]) - half[0]), Math.max(0, Math.abs(p[1] - centre[1]) - half[1]));
  for (const point of [pot.points.serving_side, pot.points.diner_side]) {
    const p = [point.at_mm[0] - 3000, point.at_mm[2]];
    assert(rectangleDistance(p, [-3000, 0], [475, 275]) > radius, 'clear of whole pot box with giant static cut');
    for (const [name, half] of [['meal-table', [585, 385]], ['diner-chair', [270, 270]]]) {
      const placed = ops.find(o => o.name === name), centre = placed.p.map(x => Math.round(x * 1000));
      assert(rectangleDistance(p, centre, half) > radius, `clear of conservative ${name} box`);
    }
  }
});

test('missing public bowl arguments stop discovery before anyone cooks', async () => {
  const fixture = publicMeal({ missingBowlParameter: true });
  await assert.rejects(meal({ seats: fixture.seats, report: { complete: false, steps: [] } }), /public thing parameter bowl/);
  assert(!fixture.calls.some((c) => c.words[0] === 'act'));
});

test('unknown hands remain unknown; only the authoritative ladle and both quantities prove recovery', async () => {
  const canAfter = { ok: true, can: 'unknown', why: 'not-seen:no_free_hand', current: true };
  const fixture = publicMeal({ canAfter }), report = { complete: false, steps: [] };
  await meal({ seats: fixture.seats, report, endpoint: 'empty-bowl-risen' });
  assert.deepEqual(report.recovery.after, canAfter);
  assert.equal(report.recovery.authoritative.ladled.phase, 'done');
  assert.equal(report.recovery.authoritative.pot.state.soup, 4);
  assert.equal(report.recovery.authoritative.bowl.state.soup, 2);
});

test('a definite refusal or a different unknown never sends the ladle', async () => {
  for (const canAfter of [{ ok: true, can: 'no', reason: 'no_free_hand', current: true }, { ok: true, can: 'unknown', why: 'not-in-copy' }]) {
    const fixture = publicMeal({ canAfter }), report = { complete: false, steps: [] };
    await assert.rejects(meal({ seats: fixture.seats, report }), /ladle has not recovered/);
    assert(!fixture.calls.some(c => c.words[0] === 'act' && c.words[1] === 'ladle-public:pot'));
    assert.equal(report.recovery, undefined);
  }
});

test('native ladle refusal or incorrect quantity cannot establish recovery', async () => {
  for (const options of [{ ladleRefused: true }, { wrongLadleQuantity: true }]) {
    const fixture = publicMeal({ ...options, canAfter: { ok: true, can: 'unknown', why: 'not-seen:no_free_hand' } }), report = { complete: false, steps: [] };
    await assert.rejects(meal({ seats: fixture.seats, report }));
    assert.equal(report.recovery, undefined); assert.equal(report.complete, false);
    assert(!fixture.calls.some(c => c.words.includes('take-public:bowl')));
  }
});

test('a bowl that leaves its holder during eating stops before washing or claiming completion', async () => {
  const fixture = publicMeal({ lostHolder: true }), report = { complete: false, steps: [] };
  await assert.rejects(meal({ seats: fixture.seats, report }), /consumed bowl left the diner/);
  assert.equal(report.complete, false);
  assert(!fixture.calls.some((c) => c.words.includes('wash-public:sink')));
});

test('the same-chair native refusal permits one offered pull-out and one authoritative sit retry', async () => {
  const fixture = publicMeal({ chairNeedsPullOut: true }), report = { complete: false, steps: [] };
  await meal({ seats: fixture.seats, report, endpoint: 'empty-bowl-risen' });
  assert.equal(report.chairRecovery.refused.receipt.try.checked, 'unknown');
  assert.equal(report.chairRecovery.pulledOut.phase, 'done'); assert.equal(report.chairRecovery.resat.phase, 'done');
  assert.equal(fixture.calls.filter(c => c.words[1] === 'pull_out-public:chair').length, 1);
  assert.equal(fixture.calls.filter(c => c.words[1] === 'sit-public:chair').length, 2);
  assert.equal(report.bowlIdentity.heldBy, 'diner-body');
});

test('another receipt target, suggested target, offer target or refusal cannot trigger chair recovery', async () => {
  const base = { ok: false, phase: 'refused', reason: 'souls:no-way', receipt: { target: 'chair', answers: [{ answer: 'refused', reason: 'souls:no-way' }], try: { name: 'pull_out', act: 'pull_out-public:chair' } } };
  const cases = [
    { sitRefusal: { ...base, receipt: { ...base.receipt, target: 'another-chair' } } },
    { sitRefusal: { ...base, receipt: { ...base.receipt, try: { name: 'pull_out', act: 'pull_out-public:another-chair' } } } },
    { chairOfferTarget: 'another-chair', sitRefusal: { ...base, receipt: { ...base.receipt, try: { name: 'pull_out', act: 'pull_out-public:another-chair' } } } },
    { sitRefusal: { ...base, reason: 'seat.out-of-reach', receipt: { ...base.receipt, answers: [{ answer: 'refused', reason: 'seat.out-of-reach' }] } } },
  ];
  for (const options of cases) {
    const fixture = publicMeal({ chairNeedsPullOut: true, ...options }), report = { complete: false, steps: [] };
    await assert.rejects(meal({ seats: fixture.seats, report }));
    assert(!fixture.calls.some(c => c.words[1]?.startsWith('pull_out-public:'))); assert.equal(report.chairRecovery, undefined);
  }
});

test('a refused or unfinished pull-out and a second sit refusal stop without another recovery', async () => {
  for (const options of [{ pullOutResult: { ok: false, phase: 'refused', reason: 'blocked' } }, { pullOutResult: { ok: true, phase: 'accepted' } }, { retrySitRefused: true }]) {
    const fixture = publicMeal({ chairNeedsPullOut: true, ...options }), report = { complete: false, steps: [] };
    await assert.rejects(meal({ seats: fixture.seats, report }));
    assert.equal(fixture.calls.filter(c => c.words[1] === 'pull_out-public:chair').length, 1);
    assert(fixture.calls.filter(c => c.words[1] === 'sit-public:chair').length <= 2);
    assert.equal(report.chairRecovery, undefined); assert.equal(report.complete, false);
    assert(!fixture.calls.some(c => c.words.includes('bite-public:bowl')));
  }
});


test('reduced endpoint observes the same bowl phases, rises, and never claims full cleanup', async () => {
  const fixture = publicMeal(), report = { complete: false, steps: [] }, phases = [];
  await meal({ seats: fixture.seats, report, endpoint: 'empty-bowl-risen', observe: async row => phases.push(row) });
  assert.deepEqual(phases.map(p => [p.phase, p.soup]), [['server-held', 2], ['diner-held', 2], ['seated', 2], ['bitten', 1], ['bitten', 0], ['risen', 0]]);
  assert(phases.every(p => p.bowl.id === 'bowl' && p.bowl.parent === p.holder));
  assert.equal(report.portionComplete, true); assert.equal(report.complete, false);
  assert.equal(report.diagnosticOnly, true); assert.equal(report.bowlIdentity.heldBy, 'diner-body');
  assert(fixture.calls.some(c => c.words[0] === 'act' && c.words[1] === 'rise'));
  assert(!fixture.calls.some(c => c.words[0] === 'set-down' || c.words.includes('wash-public:sink')));
});

test('only a fresh matching bowl invitation can be accepted; a shortcut cannot grant consent', async () => {
  const fixture = publicMeal({ noMatchingOffer: true });
  await assert.rejects(meal({ seats: fixture.seats, report: { complete: false, steps: [] } }), /give offer not observed/);
  assert(!fixture.calls.some(c => c.words[0] === 'give' && c.words[1] === 'accept'));
});

test('an expired matching invitation stops before acceptance', async () => {
  const fixture = publicMeal({ expiredOffer: true });
  await assert.rejects(meal({ seats: fixture.seats, report: { complete: false, steps: [] } }), /no longer available/);
  assert(!fixture.calls.some(c => c.words[0] === 'give' && c.words[1] === 'accept'));
});

test('a failed phase observer stops before the next native action or a completion claim', async () => {
  const fixture = publicMeal(), report = { complete: false, steps: [] };
  await assert.rejects(meal({ seats: fixture.seats, report, observe: async () => { throw Error('depicted metadata absent'); } }), /depicted metadata absent/);
  assert.equal(report.complete, false);
  assert(!fixture.calls.some(c => c.words[0] === 'give'));
});


test('tracked meal boot template reuses existing entry pictures and canonical core furniture', () => {
  const expected = mealTemplate(entries), tracked = JSON.parse(readFileSync(resolve('worlds/templates/shared-camp-meal.json')));
  assert.deepEqual(tracked, expected);
  for (const batch of tracked.batches) assert.equal(batchSchema.safeParse(batch).success, true, 'normal creator batch schema');
  const ops = tracked.batches[0].ops, defs = ops.filter(o => o.op === 'define');
  assert.deepEqual(defs.map(o => o.def.name), ['core-camp_soup_pot', 'core-soup_bowl']);
  const original = sceneOf(entries).template.batches[0].ops.filter(o => o.op === 'define').slice(0, 2);
  defs.forEach((o, i) => assert.deepEqual({ ...o.def, name: original[i].def.name }, original[i].def));
  for (const name of ['core/sink@1', 'core/table@1', 'core/chair@1']) assert(ops.some(o => o.op === 'place' && o.def === name));
  assert.deepEqual(ops.find(o => o.name === 'meal-bowl').in, { parent: '$pot', slot: 'shelf' });
  assert.deepEqual(ops.filter(o => o.op === 'place').map(o => o.p), [[-3, 0], [0, 0, 0], [3, 0], [0, 3], [0, 4.45]]);
});

test('boot chair spacing clears the retained native under-slot cuts; registered stand and routes remain unproved', () => {
  // Retained public genesis06133084 and chair entry5c105880: actual imported front539mm, not source509mm.
  // Historical native1ee0e45f: ground/scene.rs under_slots fills these elevated slots' leg spans;
  // ground/mod.rs prepare expands them by standard radius280 + MARGIN60 +1mm. This is offline geometry only.
  const furniture = JSON.parse(readFileSync(resolve('packages/world-compiler/src/core-kit/furniture.json')));
  const [table, chair] = ['core-table', 'core-chair'].map(name => furniture.find(d => d.name === name));
  const mm = metres => Math.round(metres * 1000);
  const cylinderLegs = def => def.make.args.shapes.filter(s => s.kind === 'cyl' && s.h >= .3)
    .map(s => [mm(s.at[0]), mm(s.at[2]), mm(s.r), mm(s.at[1] - s.h / 2)]);
  assert.deepEqual(cylinderLegs(table), [[-520, -320, 30, 0], [520, -320, 30, 0], [-520, 320, 30, 0], [520, 320, 30, 0]]);
  assert.deepEqual(cylinderLegs(chair), [[-160, -150, 22, 0], [160, -150, 22, 0], [-160, 150, 22, 0], [160, 150, 22, 0], [-200, -190, 20, 465], [200, -190, 20, 465]]);
  assert.equal(mm(table.slots[0].p[1]), 750); assert.equal(mm(chair.slots[0].p[1]), 470);
  const frontLegEdge = def => Math.max(...cylinderLegs(def).map(([, z, r]) => z + r));
  const expanded = 280 + 60 + 1;
  const ops = mealTemplate(entries).batches[0].ops;
  const tableAt = ops.find(o => o.name === 'meal-table'), chairAt = ops.find(o => o.name === 'diner-chair');
  assert.equal(chairAt.r, Math.PI);
  const tableCut = mm(tableAt.p[1]) + frontLegEdge(table) + expanded;
  const oldChairCut = 4100 - frontLegEdge(chair) - expanded;
  assert.equal(tableCut, 3691); assert.equal(tableCut - oldChairCut, 104, 'the previous actual cuts overlapped');
  const declaredFront = mm(chairAt.p[1]) - 539, chairCut = mm(chairAt.p[1]) - frontLegEdge(chair) - expanded;
  assert.equal(declaredFront, 3911); assert.equal(chairCut, 3937);
  assert(declaredFront > tableCut && declaredFront < chairCut, 'the declared front has clear ground between the actual cuts');
});
