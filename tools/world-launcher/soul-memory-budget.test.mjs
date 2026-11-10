// #1527 (#1133 A4): the projections that grow with the log stay under their stated budgets, the log keeps every event,
// and `memory` still finds what a projection dropped. A heavy synthetic life, through the real memory module: no model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECTION_BUDGETS } from '../edge-skill/memory-folder.mjs';
import { BRIEF_BYTES } from './soul/brief.mjs';
import { openSoulMemory } from './soul/memory.mjs';

const T0 = Date.parse('2026-11-01T08:00:00.000Z'), DAYS = 30;
const words = (n) => 'word '.repeat(n).trim();

test('#1527: 30 heavy days: knowledge, places and ledger stay under budget, the log is whole, memory finds the oldest', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'souls-budget-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let clock = T0, tick = 0, seq = 0, fed = { receipts: 0, turns: 0, facts: 0, things: 0 };
  const open = () => openSoulMemory(dir, { world: 'eden', url: 'https://x.test/w/eden', soul: 's_me', now: () => new Date(clock).toISOString() });
  let m = open();
  for (let day = 1; day <= DAYS; day++) {
    clock = T0 + (day - 1) * 86_400_000;
    for (let hour = 0; hour < 3; hour++) {
      clock += 3_600_000; tick += 600;
      const place = `place_${(day * 7 + hour * 3) % 120}`, near = [0, 1, 2].map((i) => { const id = `s_p${(day * 11 + hour * 5 + i) % 400}`; return { id, name: `Person ${id.slice(3)}`, dist: 2 + i }; });
      m.sawHere({ tick, clock: '10:00', now: `· world day ${day}`, me: { place, placePath: [`The ${place.replace('_', ' ')} ${words(20)}`], posture: 'standing' }, near });
      const events = [];
      for (let k = 0; k < 6; k++) { events.push({ id: `c_${++seq}`, kind: 'conversation.turn', tick: tick + k, at: clock + k, clock: '10:00', conversation: `cv_${day}_${hour}`, turn: { seq: k, from: { soulId: near[k % 3].id, name: near[k % 3].name }, text: `About ${place}: ${words(40)}` } }); fed.turns++; }
      for (let k = 0; k < 6; k++) {
        const n = ++seq; fed.receipts++; fed.facts += 5; fed.things++;
        events.push({ id: `c_${n}`, kind: 'receipt', tick: tick + 10 + k, at: clock + 100 + k, clock: '10:05', receipt: { id: `r_${n}`, capability: 'read:bench', phase: 'completed', endedTick: tick + 10 + k, endedAt: { place }, outcome: { summary: `Read ${n}.`, learned: [0, 1, 2, 3, 4].map((j) => ({ fact: `Fact ${n}x${j}: ${words(25)}`, about: place, source: `book:${n}:${j}`, provenance: 'authored-content' })), produced: [{ id: `o_${n}`, title: `Thing ${n} ${words(10)}`, kind: 'note', where: place }], met: [] } } });
      }
      m.sawEvents(events);
    }
    if (day % 10 === 0) m = open();   // restarts replay the log
  }
  m.sawHere({ tick: tick + 1, clock: '18:00', now: `· world day ${DAYS}`, me: { place: 'place_0', placePath: ['The place 0'], posture: 'standing' }, near: [] });
  const memory = join(dir, 'memory'), sizeOf = (f) => statSync(join(memory, f)).size;
  for (const [file, key] of [['knowledge.md', 'knowledge'], ['places.md', 'places'], ['ledger.md', 'ledger']]) assert.ok(sizeOf(file) <= PROJECTION_BUDGETS[key], `${file} ${sizeOf(file)} > ${PROJECTION_BUDGETS[key]}`);
  assert.match(readFileSync(join(memory, 'knowledge.md'), 'utf8'), /\(\d+ older reports are in the log only; memory <query> searches them\.\)\n$/);
  assert.match(readFileSync(join(memory, 'knowledge.md'), 'utf8'), new RegExp(`Fact ${seq}x4`), 'the newest fact is shown');
  assert.match(readFileSync(join(memory, 'ledger.md'), 'utf8'), /older things made are in the log only/);
  assert.match(readFileSync(join(memory, 'places.md'), 'utf8'), /older places are in the log only/);

  const log = readFileSync(join(memory, 'log/memory-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).value);
  const outcomes = log.filter((e) => e.type === 'outcome');
  assert.equal(outcomes.length, fed.receipts); assert.equal(log.filter((e) => e.type === 'speech').length, fed.turns);
  assert.equal(outcomes.reduce((n, e) => n + e.learned.length, 0), fed.facts); assert.equal(outcomes.reduce((n, e) => n + e.produced.length, 0), fed.things);

  // What the projections dropped is found in the log, marked as a world's words and where it came from.
  const first = m.search('book:7:3#');
  assert.equal(first.matches.length, 1); assert.deepEqual([first.matches[0].file, first.matches[0].untrusted], ['log', true]);
  assert.match(first.matches[0].text, /^Fact 7x3: .* — about eden:place_\d+; source eden:book:7:3#/); assert.match(first.matches[0].provenance, /in the log only/);
  assert.equal(m.search('o_7:').matches[0]?.file, 'log', 'the first thing made');
  const shown = m.search(`Fact ${seq}x4`);
  assert.deepEqual(shown.matches.map((x) => x.file), ['knowledge.md'], 'a fact still in the projection is found once, there');
  const all = m.search('fact provenance authored-fiction');
  assert.equal(all.matches.length + all.more, fed.facts, 'every fact counted once, shown or in the log');
  assert.ok(Buffer.byteLength(m.brief()) <= BRIEF_BYTES);
});

test('#1527: the Soul\'s own note on a place it left long ago is still found, as its own', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'souls-budget-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = openSoulMemory(dir, { world: 'eden', soul: 's_me', now: () => new Date(T0).toISOString() });
  const visit = (place, tick) => m.sawHere({ tick, clock: '10:00', now: '· world day 1', me: { place, placePath: [`The ${place} ${words(30)}`], posture: 'standing' }, near: [] });
  visit('place_first', 1); m.remember('place', 'place_first', 'A zebra sleeps under the bridge.');
  for (let i = 0; i < 200; i++) visit(`place_${i}`, 10 + i);
  assert.ok(statSync(join(dir, 'memory/places.md')).size <= PROJECTION_BUDGETS.places);
  assert.doesNotMatch(readFileSync(join(dir, 'memory/places.md'), 'utf8'), /zebra/, 'the place left the projection');
  const found = m.search('zebra');
  assert.deepEqual(found.matches.map((x) => [x.file, x.untrusted, x.text]), [['log', false, 'eden:place_first — Judgment: A zebra sleeps under the bridge.']]);
});
