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
  assert.ok(['press.json', 'slide.json'].every(f => loaded.some(r => r.file === f)));
  for (const r of loaded) { assert.deepEqual(r.errors, [], r.file); assert.match(r.ref, /^[a-z_]+@prov-1220[0-9a-f]{64}$/); }
  assert.notEqual(loaded.find(r => r.move.move === 'press').ref, loaded.find(r => r.move.move === 'slide').ref);
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
  assert.equal(refOf(moves.press), loaded.find(r => r.move.move === 'press').ref);
});

test('SA-D5a A1: pour validates; its spout is within 2 cm of the rim for the whole contact window (kettle to cup, can to planter)', () => {
  const m = moves.pour;
  assert.deepEqual(loaded.find(r => r.file === 'pour.json').errors, []);
  assert.ok(validateMove({...structuredClone(m), phases: {...m.phases, slide_us: 1000}}).some(e => e.path === 'phases' && e.reason.includes('not more than one')));
  assert.ok(validateMove({...structuredClone(m), effector: 'hand'}).some(e => e.path === 'effector'));
  const {contact_us, slide_end_us, end_us} = P.timesOf(m);
  assert.equal(slide_end_us - contact_us, m.phases.pour_us);
  for (const c of cases.pour) {
    let off = c.effector_mm;
    if (c.from_kind) {
      const pts = F.parseEntry(readFileSync(root + c.from_kind, 'utf8')).entry.points;
      off = pts[c.spout].at_mm.map((v, i) => v - pts[c.grip].at_mm[i]);
    }
    const record = {...c.record, effector_mm: off};
    const rim = record.contact_mm, s = record.start_us;
    for (let t = contact_us; t < slide_end_us; t += 50000) assert.ok(dist(P.effectorAt(m, record, s + t), rim) <= 20, `${c.why} at ${t}`);
    assert.ok(dist(P.effectorAt(m, record, s + contact_us / 2), rim) > 20, 'before the window the spout is still on its way');
    assert.ok(dist(P.effectorAt(m, record, s + slide_end_us + m.phases.recovery_us / 2), rim) > 20, 'after the window it leaves');
    assert.deepEqual(P.handAt(m, record, s + end_us), record.from_mm, 'the hand ends at rest');
  }
});

test('SA-D5c A1/A2: consume validates; the rim or bitten edge is at the mouth for the whole window, one record for a cup and a roll', () => {
  const m = moves.consume;
  assert.deepEqual(loaded.find(r => r.file === 'consume.json').errors, []);
  assert.equal(m.blocks.includes('gaze'), false, 'the gaze stays free');
  assert.ok(m.claims.includes('manipulator') && m.claims.includes('voice'));
  assert.ok(validateMove({...structuredClone(m), claims: ['manipulator']}).some(e => e.path === 'claims'));
  assert.ok(validateMove({...structuredClone(m), phases: {...m.phases, pour_us: 1000}}).some(e => e.path === 'phases' && e.reason.includes('not more than one')));
  for (const c of cases.consume) {
    const r = {...c.record, effector_mm: c.effector_mm};
    const mouth = r.contact_mm, s = r.start_us;
    const {contact_us, slide_end_us, end_us} = P.timesOf(m, r.count);
    assert.equal(slide_end_us - contact_us, m.phases.consume_us * r.count, c.why);
    for (let t = contact_us; t < slide_end_us; t += 50000) assert.deepEqual(P.effectorAt(m, r, s + t), mouth, `${c.why} at ${t}`);
    assert.ok(dist(P.effectorAt(m, r, s + contact_us / 2), mouth) > 20, 'before contact it is on its way');
    assert.ok(dist(P.effectorAt(m, r, s + slide_end_us + m.phases.recovery_us / 2), mouth) > 20, 'after the window it leaves');
    assert.deepEqual(P.handAt(m, r, s + end_us), r.from_mm, 'the hand ends at rest');
  }
});

test('SA-D4b A1: swing, stroke, tug, knock and lock validate, differ, and each has a case with the hand on its contact point at contact', () => {
  const names = ['swing', 'stroke', 'tug', 'knock', 'lock'];
  const refs = new Set(loaded.filter(r => names.includes(r.move?.move)).map(r => r.ref));
  assert.equal(refs.size, names.length, 'five distinct valid references');
  for (const n of names) {
    const own = cases.pose.filter(c => c.move === n);
    assert.equal(own.length, 1, `${n}: one position case`);
    const [c] = own;
    const {contact_us} = P.timesOf(moves[n]);
    const at = c.at_us.find(([t]) => t === c.record.start_us + contact_us);
    assert.ok(at, `${n}: the case names the contact instant`);
    assert.deepEqual(at[1], c.record.contact_mm, `${n}: the hand is on its contact point at contact`);
    assert.deepEqual(P.handAt(moves[n], c.record, c.record.start_us + contact_us), c.record.contact_mm);
    assert.equal(!!moves[n].phases.slide_us, !!c.record.to_mm, `${n}: a second point exactly when the move has a middle phase`);
  }
});
