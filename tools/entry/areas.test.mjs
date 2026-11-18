// Tests for areas (Soul Actions SA-D6, #2861). Each test is one acceptance item of the issue; the cases are data in
// tools/entry/cases/areas.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as F from './format.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const doc = JSON.parse(readFileSync(new URL('./cases/areas.json', import.meta.url), 'utf8'));
const load = name => { const {entry, errors} = F.parseEntry(readFileSync(root + doc.kinds[name], 'utf8')); assert.deepEqual(errors, []); return entry; };

test('the areas section is number 16 and is part of a kind\'s meaning', () => {
  assert.equal(F.SECTIONS.areas, 16);
  const bed = load('bed'), other = structuredClone(bed);
  other.areas.mattress.allows.sit = 'on';
  assert.notEqual(F.hashKinds([bed]).get('eden:bed').ref, F.hashKinds([other]).get('eden:bed').ref);
});

test('A1 and A2: a bed, a piano and a tree say what their shape cannot, and the entries are accepted', () => {
  for (const c of doc.cases) {
    const entry = load(c.entry);
    assert.deepEqual(F.validateEntry(entry), [], c.name);
    const a = entry.areas[c.area];
    assert.deepEqual(a.allows ?? {}, c.allows ?? a.allows ?? {}, c.name);
    if (c.forbids) assert.deepEqual(a.forbids ?? [], c.forbids, c.name);
    if (c.at_mm) { assert.deepEqual(a.at_mm, c.at_mm); assert.equal(a.radius_mm, c.radius_mm); }
    if (c.walk_form) assert.equal(entry.forms[c.walk_form].steps[0].point, c.area, 'a body can be sent to the area by its name');
  }
});

test('A3: the check gate refuses what repeats the slots, says nothing, or contradicts them', () => {
  for (const c of doc.refused) {
    const entry = load(c.entry);
    for (const [section, table] of Object.entries(c.set)) entry[section] = {...entry[section], ...table};
    const errors = F.validateEntry(entry);
    assert.ok(errors.some(e => e.path === c.path && e.reason.includes(c.reason_has)), `${c.name}: got ${JSON.stringify(errors)}`);
  }
});
