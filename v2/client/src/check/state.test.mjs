// E21 (#2791): the client's kinds give a Soul's own body kind its family's forms, by the same rule as replica's
// `kinds::entry::family_forms` (v2/crates/replica/tests/family_forms.rs, on the same entries).
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { kindsIn } from './state.mjs';

const HUMANOID = new URL('../../../../content/kinds/body/humanoid.json', import.meta.url);
const LAMP = { format: 'souls-entry/1', kind: 'eden:lamp', owner: 'thing', forms: {} };

function folder(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kinds-'));
  copyFileSync(HUMANOID, join(dir, 'humanoid.json'));
  writeFileSync(join(dir, 'lamp.json'), JSON.stringify(LAMP));
  for (const [f, e] of Object.entries(extra)) writeFileSync(join(dir, f), JSON.stringify(e));
  return dir;
}

test('a body with no entry gets the family forms', () => {
  const dir = folder();
  try {
    const k = kindsIn(dir, 'souls:body');
    assert.equal(k['souls:body'].kind, 'souls:body');
    for (const f of ['wave', 'bow', 'nod', 'shake_head', 'sit_down']) assert.ok(k['souls:body'].forms[f], f);
    assert.equal(k['eden:humanoid'].kind, 'eden:humanoid');
    assert.equal(kindsIn(dir)['souls:body'], undefined, 'no body named: nothing added');
  } finally { rmSync(dir, { recursive: true }); }
});

test('a body with its own entry, or two families, is left alone', () => {
  let dir = folder({ 'body.json': { format: 'souls-entry/1', kind: 'souls:body', forms: {} } });
  try { assert.deepEqual(kindsIn(dir, 'souls:body')['souls:body'].forms, {}); } finally { rmSync(dir, { recursive: true }); }
  dir = folder({ 'q.json': { format: 'souls-entry/1', kind: 'eden:quadruped', owner: 'family', forms: {} } });
  try { assert.equal(kindsIn(dir, 'souls:body')['souls:body'], undefined); } finally { rmSync(dir, { recursive: true }); }
});
