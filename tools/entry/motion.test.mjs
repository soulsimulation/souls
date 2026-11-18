// Tests for how a kind moves, how long it lasts loose, and the six base forms (Soul Actions SA-F10, #2882).
// Each test is one acceptance item of the issue; cases are data in tools/entry/cases/motion.json, and the lamp post's
// own run of the six body forms is in packages/form-rules/cases/base.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as F from './format.mjs';
import * as C from './check.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const doc = JSON.parse(readFileSync(new URL('./cases/motion.json', import.meta.url), 'utf8'));
const load = name => { const {entry, errors} = F.parseEntry(readFileSync(root + doc.kinds[name], 'utf8')); assert.deepEqual(errors, []); return entry; };
const body = F.parseEntry(readFileSync(root + 'content/kinds/body/humanoid.json', 'utf8')).entry;

test('motion and loose are sections 18 and 19, part of a kind\'s meaning', () => {
  assert.deepEqual([F.SECTIONS.motion, F.SECTIONS.loose], [18, 19]);
  const chair = load('chair'), other = structuredClone(chair);
  other.motion.how = 'one_hand';
  assert.notEqual(F.hashKinds([chair]).get('eden:chair').ref, F.hashKinds([other]).get('eden:chair').ref);
  assert.deepEqual(F.MOTIONS, ['one_hand', 'two_hands', 'pushed_by_one', 'two_souls', 'wheeled', 'fixed']);
});

test('A1: a kind with no forms of its own is gone to, looked at, pointed at, touched, leaned on and waited by, by the body\'s forms', () => {
  assert.deepEqual(doc.base.forms, [...F.BASE_FORMS]);
  for (const name of doc.base.every_thing) {
    const e = load(name);
    assert.deepEqual(F.validateEntry(e), [], name);
    for (const f of F.BASE_FORMS) assert.ok(!(e.forms && f in e.forms), `${name} writes none of the six`);
    for (const f of doc.base.forms) assert.deepEqual(F.allowsBase(name === 'railing' && f === 'lean_on' ? load('lamp_post') : e, f), {ok: true}, `${name} ${f}`);
  }
  for (const f of doc.base.forms) {
    const form = body.forms[f];
    assert.deepEqual([form.who, form.starts], ['anyone', 'act'], f);
    assert.ok(Object.values(form.takes).every(t => t.type === 'thing'), `${f} takes any thing`);
  }
  for (const c of doc.base.allowed) assert.deepEqual(F.allowsBase(load(c.entry), c.form), {ok: true}, `${c.entry} ${c.form}`);
});

test('A2: a chair is carried with two hands; a sofa is pushed by one Soul and refused to be carried, naming how it moves', () => {
  for (const c of doc.motion) {
    const r = F.moveBy(load(c.entry), {act: c.act, souls: c.souls});
    assert.equal(r.ok, c.ok, c.say);
    if (c.hands) assert.equal(r.hands, c.hands);
    if (c.how) assert.equal(r.how, c.how, c.say);
    if (!c.ok) { assert.equal(r.code, c.code); assert.ok(r.reason.includes(c.reason_has), r.reason); }
  }
  assert.equal(F.moveBy(load('sofa'), {act: 'push', souls: 0}).code, 'souls');
  assert.equal(F.moveBy({kind: 'eden:x'}, {act: 'carry'}).code, 'unsaid');
});

test('A3: the check gate refuses a kind that does not say how it moves or how long it lasts loose', () => {
  for (const section of ['motion', 'loose']) {
    const e = load('chair'); delete e[section];
    const rows = C.checkText(JSON.stringify(e)).findings;
    assert.deepEqual(rows.map(r => [r.rule, r.path]), [['moves', section]], section);
    assert.ok(rows[0].fix.includes(section));
  }
  const bad = load('chair'); bad.motion = {how: 'rolled'};
  assert.ok(F.validateEntry(bad).some(x => x.path === 'motion.how' && x.reason.includes('one_hand')));
  for (const l of doc.loose.accepted) { const e = load('chair'); e.loose = l; assert.deepEqual(F.validateEntry(e), [], JSON.stringify(l)); }
  for (const c of doc.loose.refused) {
    const e = load('chair'); e.loose = c.set;
    assert.ok(F.validateEntry(e).some(x => x.path === c.path && x.reason.includes(c.reason_has)), `${JSON.stringify(c.set)}: ${JSON.stringify(F.validateEntry(e))}`);
  }
  // A body's family is not a thing: it says neither.
  assert.deepEqual(C.checkFiles([root + 'content/kinds/body/humanoid.json'])[0].findings, []);
});

test('A4: a kind that forbids leaning refuses it by name; the rest of the six stay allowed', () => {
  const railing = load('railing');
  assert.deepEqual(F.validateEntry(railing), []);
  for (const c of doc.base.forbidden) {
    const r = F.allowsBase(load(c.entry), c.form);
    assert.deepEqual([r.ok, r.code, r.name, r.area], [false, 'forbidden', c.name, c.area]);
    assert.ok(r.reason.includes(`"${c.name}"`), r.reason);
  }
  for (const f of ['go_to', 'look_at', 'point', 'touch', 'wait_by']) assert.equal(F.allowsBase(railing, f).ok, true, f);
  // Any other of the six may be forbidden the same way, by the form's name.
  const post = load('lamp_post'); post.areas = {pole: {forbids: ['touch']}};
  assert.deepEqual(F.validateEntry(post), []);
  assert.equal(F.allowsBase(post, 'touch').name, 'touch');
  assert.equal(F.allowsBase(post, 'lean_on').ok, true);
  post.areas.pole.forbids = ['dance'];
  assert.ok(F.validateEntry(post).some(x => x.path === 'areas.pole.forbids'));
});
