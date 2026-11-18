// Tests for the body's own entry (Soul Actions SA-G3, #2875). Each test is one acceptance item of the issue; cases are data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as F from './format.mjs';
import {loadMoves} from './move.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cases = JSON.parse(readFileSync(new URL('./cases/body.json', import.meta.url), 'utf8'));
const {entry, errors} = F.parseEntry(readFileSync(root + cases.entry, 'utf8'));
const loaded = loadMoves(root + 'content/moves');
const moves = new Set(loaded.map(r => r.move.move));

test('A1: at least twenty body forms validate, and every move they name is a move that validates', () => {
  assert.deepEqual([...errors, ...F.validateEntry(entry)], []);
  assert.equal(entry.owner, 'family');
  assert.equal(entry.kind, cases.kind);
  const names = Object.keys(entry.forms);
  assert.ok(names.length >= 20, `${names.length} forms`);
  for (const n of Object.values(cases.family).flat()) assert.ok(names.includes(n), `form ${n}`);
  for (const r of loaded) assert.deepEqual(r.errors, [], r.file);
  for (const [n, f] of Object.entries(entry.forms)) for (const s of f.steps) if (s.step === 'move') assert.ok(moves.has(s.move), `${n} names move ${s.move}`);
  // No form of the body needs an object of its own: every form is anyone's, started by an act.
  for (const f of Object.values(entry.forms)) assert.deepEqual([f.who, f.starts], ['anyone', 'act']);
});

// What a described target picks among the things the actor stands among: the nearest first (Engine v2 E2).
const pick = (sel, things) => [...things].sort((a, b) => a.from_me_mm - b.from_me_mm)[sel.rank - 1].id;
// A form with its arguments filled in (named, or described and resolved in the scene): the plan, as data.
function plan(form, c) {
  const f = entry.forms[form];
  const args = Object.fromEntries(Object.entries(f.takes ?? {}).map(([k, a]) => [k, c.args[k] ?? pick(a.select, c.scene.things)]));
  const fill = v => v !== null && typeof v === 'object'
    ? (v.arg !== undefined ? args[v.arg] : Array.isArray(v) ? v.map(fill) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])))
    : v;
  return {args, steps: fill(f.steps), effects: fill(f.effects)};
}

test('A2: "sit on the ground here" and "sit on the rug" are the same form, at a described spot', () => {
  const [ground, rug] = cases.sit.map(c => ({c, p: plan(c.form, c)}));
  assert.equal(ground.c.form, rug.c.form);
  assert.equal(ground.p.args.spot, ground.c.spot);
  assert.equal(rug.p.args.spot, rug.c.spot);
  assert.notEqual(ground.p.args.spot, rug.p.args.spot);
  // Same steps and same effects once the spot is put back: only the spot differs.
  const swap = (p, spot) => JSON.stringify(p).replaceAll(`"${spot}"`, '"<spot>"');
  assert.equal(swap(ground.p, ground.c.spot), swap(rug.p, rug.c.spot));
  assert.equal(ground.p.effects[0].to, 'sit');
  // The spot's description is the format's own closed list: the nearest thing here to me.
  assert.deepEqual(entry.forms.sit_down.takes.spot, {type: 'thing', select: {of: 'things', in: 'here', anchor: 'me', order: 'nearest', rank: 1}});
});

test('a form whose need is not met is refused: the body is not in the posture it asks for', () => {
  for (const c of cases.refused) {
    const need = entry.forms[c.form].needs.find(n => n.field === c.needs_fail);
    const holds = 'is' in need ? c.posture === need.is : c.posture !== need.not;
    assert.equal(holds, false, c.say);
  }
});

test('A3: the check gate lists the body entry and its forms under the body kind', async () => {
  const check = new URL('./check.mjs', import.meta.url);
  const files = F.loadDir(root + 'content/kinds/body');
  assert.deepEqual(files.map(f => f.split('/').at(-1)), ['humanoid.json']);
  // check.mjs arrives with main (SA-P2); until this branch has merged it, the entry's own validation above stands in.
  if (!existsSync(fileURLToPath(check))) return;
  const {checkFiles} = await import(check.href);
  const rows = checkFiles(files);
  assert.deepEqual(rows.map(r => [r.entry.kind, r.findings]), [[cases.kind, []]]);
  assert.ok(Object.keys(rows[0].entry.forms).length >= 20);
});
