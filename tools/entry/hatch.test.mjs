// Tests for the code hatch (Soul Actions SA-F9, #2850). Each test is one acceptance item of the issue.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as F from './format.mjs';
import * as C from './check.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const CHECK = fileURLToPath(new URL('./check.mjs', import.meta.url));
const data = JSON.parse(readFileSync(new URL('./cases/hatch.json', import.meta.url), 'utf8'));
const kettle = JSON.parse(readFileSync(root + 'content/kinds/kitchen/kettle.json', 'utf8'));
const copy = v => structuredClone(v);
const MODULE = `prov-1220${'ab'.repeat(32)}`;
const refused = (entry, path, word) => {
  const errors = F.validateEntry(entry);
  assert.ok(errors.some(e => e.path === path && (!word || e.reason.includes(word))), `expected a refusal at ${path}, got ${JSON.stringify(errors)}`);
};

/** A kind that declares one of the two known uses, built from its `declares` in the cases file. */
function kindFor(name, edit = h => h) {
  const d = data.declares[name], e = copy(kettle);
  e.kind = `test:${name}`;
  e.state = {}; e.text.why_hatch = 'a function is needed here'; // the words, by key
  let n = 1;
  for (const [k, f] of Object.entries(d.fields)) e.state[k] = {n: n++, ...f, default: f.type === 'list' ? [] : f.type === 'bool' ? false : f.type === 'enum' ? f.values[0] : 0, audience: {rule: 'everyone'}};
  const takes = Object.fromEntries(Object.entries(d.args).map(([k, type]) => [k, {type}]));
  const field = typeof d.answers === 'object' ? d.answers.field : null;
  e.forms = {try_it: {who: 'anyone', starts: 'act', takes, needs: [], steps: [], effects: [{change: 'set', field: field ?? 'turn', to: field ? true : 'black', event: 'tried'}],
    hatch: edit({module: MODULE, reads: copy(d.reads), steps_most: d.steps_most, answers: copy(d.answers), why: 'why_hatch'})}};
  e.howtos = {};
  return e;
}

test('A1: a hatch with its reads, a step limit and an answer is accepted, for both known uses', () => {
  for (const name of Object.keys(data.declares)) {
    const e = kindFor(name);
    assert.deepEqual(F.validateEntry(e), [], name);
    assert.equal(F.hatchesOf(e).length, 1);
    assert.equal(F.hatchesOf(e)[0].module, MODULE);
  }
});

test('A1: a hatch without its module, reads, limit, answer or reason is refused at the field', () => {
  for (const key of ['module', 'reads', 'steps_most', 'answers', 'why']) {
    const e = kindFor('chess_move'); delete e.forms.try_it.hatch[key];
    refused(e, `forms.try_it.hatch.${key}`);
  }
  refused(kindFor('chess_move', h => ({...h, reads: []})), 'forms.try_it.hatch.reads', 'reads nothing');
  refused(kindFor('chess_move', h => ({...h, module: 'wasm:abc'})), 'forms.try_it.hatch.module', 'hash');
  refused(kindFor('chess_move', h => ({...h, steps_most: F.HATCH_STEPS_MOST + 1})), 'forms.try_it.hatch.steps_most');
  refused(kindFor('chess_move', h => ({...h, code: 'AGFzbQ=='})), 'forms.try_it.hatch.code', 'unknown key');
});

test('A1: a hatch reads only what the kind declares, once, in whole values', () => {
  refused(kindFor('chess_move', h => ({...h, reads: [...h.reads, {field: 'nowhere'}]})), 'forms.try_it.hatch.reads.6.field', 'state field');
  refused(kindFor('chess_move', h => ({...h, reads: [...h.reads, {arg: 'ghost'}]})), 'forms.try_it.hatch.reads.6.arg', 'takes');
  refused(kindFor('chess_move', h => ({...h, reads: [...h.reads, {field: 'turn'}]})), 'forms.try_it.hatch.reads.6', 'already read');
  const t = kindFor('chess_move'); t.forms.try_it.takes.who = {type: 'thing'}; t.forms.try_it.hatch.reads.push({arg: 'who'});
  refused(t, 'forms.try_it.hatch.reads.6.arg', 'count or a duration');
  const s = kindFor('chess_move'); s.state.note = {n: 9, type: 'text', default: null, audience: {rule: 'everyone'}}; s.forms.try_it.hatch.reads.push({field: 'note'});
  refused(s, 'forms.try_it.hatch.reads.6.field', 'whole values');
  refused(kindFor('signal_lamp', h => ({...h, answers: {field: 'nowhere'}})), 'forms.try_it.hatch.answers.field');
  refused(kindFor('chess_move', h => ({...h, why: 'no_such_text'})), 'forms.try_it.hatch.why');
});

test('A1: a hatch is a form\'s own key; a top-level "hatch" section does not exist, and the hatch is covered by the kind\'s hash', () => {
  const e = kindFor('chess_move'); e.hatch = {};
  refused(e, 'hatch', 'declared by the form');
  const a = kindFor('chess_move'), b = kindFor('chess_move', h => ({...h, module: `prov-1220${'cd'.repeat(32)}`})), c = kindFor('chess_move', h => ({...h, steps_most: 5}));
  const hash = x => F.hashKinds([x]).get(x.kind).hash;
  assert.notEqual(hash(a), hash(b));
  assert.notEqual(hash(a), hash(c));
});

test('A2: cases exist for the two known uses, and each case supplies exactly the declared reads and the right kind of answer', () => {
  const by = n => data.cases.filter(c => c.hatch === n);
  assert.ok(by('chess_move').length >= 10, 'chess: legal and illegal moves');
  assert.ok(by('chess_move').some(c => c.answer === true) && by('chess_move').some(c => c.answer === false));
  assert.ok(by('signal_lamp').some(c => c.answer === true) && by('signal_lamp').some(c => c.answer === false));
  for (const c of data.cases) {
    const d = data.declares[c.hatch];
    assert.ok(d, `${c.hatch} is declared`);
    assert.deepEqual(Object.keys(c.inputs).sort(), d.reads.map(r => r.field ?? r.arg).sort(), `${c.hatch}/${c.name ?? c.inputs.phase}: inputs are exactly the reads`);
    assert.equal(typeof c.answer, 'boolean');
    const check = (v, where) => {
      if (Array.isArray(v)) v.forEach((x, i) => check(x, `${where}.${i}`));
      else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => check(x, `${where}.${k}`));
      else assert.ok(Number.isSafeInteger(v) || typeof v === 'boolean' || typeof v === 'string', `${where}: whole numbers only`);
    };
    check(c.inputs, c.hatch);
    for (const [k, f] of Object.entries(d.fields)) if (f.type === 'enum' && k in c.inputs) assert.ok(f.values.includes(c.inputs[k]), `${k} is one of its values`);
    if (c.hatch === 'chess_move') for (const p of c.inputs.pieces) assert.ok(p.square >= 0 && p.square < 64 && p.piece >= 1 && p.piece <= 14);
  }
  // A case never names a clock or random value: its inputs are the reads, and the reads are state and arguments.
  assert.ok(!JSON.stringify(data.cases).match(/random|time|clock|now/i));
});

test('A3: the check gate prints the number of hatches, and marks an entry that names one as waiting for the new engine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hatch-check-'));
  try {
    const file = join(dir, 'chess.json');
    // The lamp has two reads and a field answer; the chess move has six. Both are what a form cannot say.
    writeFileSync(file, JSON.stringify(kindFor('chess_move'), null, 2));
    const r = spawnSync(process.execPath, [CHECK, file], {encoding: 'utf8'});
    const lines = r.stdout.trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines[0].hatches, 1);
    assert.equal(lines[0].waiting_for_engine, true);
    assert.equal(lines.at(-1).hatches, 1);
    assert.equal(lines.at(-1).waiting_for_engine, 1);
    const none = spawnSync(process.execPath, [CHECK, 'kitchen'], {encoding: 'utf8'}).stdout.trim().split('\n');
    assert.equal(JSON.parse(none.at(-1)).hatches, 0);
    assert.ok(!('waiting_for_engine' in JSON.parse(none[0])));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('the hatch is no way round the closed lists: the gate refuses what a declared form could say', () => {
  const rule = e => C.checkText(JSON.stringify(e)).findings.filter(f => f.rule === 'hatch');
  assert.deepEqual(rule(kindFor('chess_move')), [], 'chess is what a form cannot say');
  const one = kindFor('signal_lamp'); one.forms.try_it.hatch.reads = [{field: 'code'}];
  const f = rule(one);
  assert.equal(f.length, 1);
  assert.equal(f[0].path, 'forms.try_it.hatch.reads');
  assert.match(f[0].fix, /need|effect/);
  const flags = kindFor('chess_move');
  flags.state = {a: {n: 1, type: 'bool', default: false, audience: {rule: 'everyone'}}, b: {n: 2, type: 'bool', default: false, audience: {rule: 'everyone'}}};
  flags.forms.try_it = {who: 'anyone', starts: 'act', needs: [], steps: [], effects: [{change: 'set', field: 'a', to: true, event: 'done'}], hatch: {module: MODULE, reads: [{field: 'a'}, {field: 'b'}], steps_most: 10, answers: 'verdict', why: 'why_hatch'}};
  assert.equal(rule(flags).length, 1, 'a verdict over bool fields is a list of needs');
  const many = kindFor('chess_move');
  for (let i = 0; i < 5; i++) many.forms[`h${i}`] = copy(many.forms.try_it);
  assert.ok(rule(many).some(x => /6 hatches/.test(x.reason)));
});
