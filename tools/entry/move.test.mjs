// Tests for moves (Soul Actions SA-D4, #2856). Each test is one acceptance item of the issue; cases are data.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {loadMoves, validateMove, refOf} from './move.mjs';
import * as P from './pose.mjs';
import * as F from './format.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cases = JSON.parse(readFileSync(new URL('./cases/moves.json', import.meta.url), 'utf8'));
const loaded = loadMoves(root + 'content/moves');
const moves = Object.fromEntries(loaded.map(r => [r.move.move, r.move]));
const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));

test('A1: press and slide validate as moves; a move with a duration in ticks is refused', () => {
  assert.deepEqual(loaded.map(r => r.file), ['press.json', 'slide.json']);
  for (const r of loaded) { assert.deepEqual(r.errors, [], r.file); assert.match(r.ref, /^[a-z]+@prov-1220[0-9a-f]{64}$/); }
  assert.notEqual(loaded[0].ref, loaded[1].ref);
  for (const c of cases.refused) {
    const errors = c.raw !== undefined
      ? [...F.parseEntry(c.raw).errors, ...validateMove(F.parseEntry(c.raw).entry)]
      : validateMove({...structuredClone(moves.press), ...c.edit});
    assert.ok(errors.some(e => (!c.path || e.path === c.path) && e.reason.includes(c.word)), `${c.why}: got ${JSON.stringify(errors)}`);
  }
});

test('A2: a press on the kettle button puts the hand within 1 cm of the button at the contact time', () => {
  const {entry} = F.parseEntry(readFileSync(root + 'content/kinds/kitchen/kettle.json', 'utf8'));
  assert.equal(entry.forms.switch_on.steps[0].move, 'press');
  assert.equal(entry.forms.switch_on.steps[0].at, 'button');
  const button = entry.points.button.at_mm;
  const record = {start_us: 5000000, from_mm: [0, 900, 400], contact_mm: button};
  const {contact_us} = P.timesOf(moves.press);
  assert.ok(dist(P.handAt(moves.press, record, record.start_us + contact_us), button) <= 10);
  assert.ok(dist(P.handAt(moves.press, record, record.start_us + contact_us - 1), button) > 0, 'before contact the hand is still on its way');
});

test('A3: the same record and time give the same position in Node and in a browser build', () => {
  // The browser build is the same file with no imports; run it in a context that has none of Node's globals.
  const src = readFileSync(root + 'tools/entry/pose.mjs', 'utf8').replace(/^export /gm, '');
  const ctx = vm.createContext({});
  const bare = vm.runInContext(`${src}\n({handAt, timesOf, eased})`, ctx);
  for (const c of cases.pose) {
    for (const [t, want] of c.at_us) {
      assert.deepEqual(P.handAt(moves[c.move], c.record, t), want, `${c.why} at ${t}`);
      assert.deepEqual(Array.from(bare.handAt(moves[c.move], c.record, t)), want, `${c.why} at ${t} (bare context)`);
    }
  }
  assert.equal(refOf(moves.press), loaded[0].ref);
});
