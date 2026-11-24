// Tests for the scaffold command (0.135 R6, #4045): `new.mjs <family> <kind>` writes an entry and its two slimmed case
// files that pass the checks as written, and writes nothing when it refuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkFiles} from './check.mjs';
import {scrubLine} from '../../.github/scripts/guards.mjs';
import {decide} from '../../packages/form-rules/src/rules.ts';
import {apply, effects} from '../../packages/form-rules/src/effects.ts';
import {KIND_DIRS, loadKinds, mismatches, same} from '../../packages/form-rules/src/load.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NEW = fileURLToPath(new URL('./new.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [NEW, ...args], {encoding: 'utf8'});

test('A1: the entry and both case files are written where kinds live, and pass the checks as written', t => {
  const root = mkdtempSync(join(tmpdir(), 'entry-new-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const r = run('tide-gauges', 'tide_gauge', '--root', root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.files, ['content/kinds/tide-gauges/tide_gauge.json', 'packages/form-rules/cases/tide_gauge.json', 'packages/form-rules/cases/effects/tide_gauge.json']);
  const [entryFile, rulesFile, effectsFile] = out.files.map(f => join(root, f));

  // The entry check, with the committed kinds loaded beside it.
  const [row] = checkFiles([entryFile]);
  assert.deepEqual(row.findings, [], JSON.stringify(row.findings));

  // The form-rules cases, against the committed kinds plus the new one.
  const kinds = loadKinds([...KIND_DIRS, join(root, 'content/kinds')]);
  const rules = JSON.parse(readFileSync(rulesFile, 'utf8'));
  assert.equal(rules.format, 'souls-form-cases/1');
  for (const c of rules.cases) assert.deepEqual(mismatches(c.expect, decide({kinds, ...c})), [], c.name);
  const forms = Object.keys(kinds['eden:tide_gauge'].forms);
  for (const f of forms) assert.ok(rules.cases.some(c => c.act.form === f && c.expect.verdict === 'yes'), `${f}: a yes`);
  const doc = JSON.parse(readFileSync(effectsFile, 'utf8'));
  for (const c of doc.cases) {
    let state = structuredClone(c.state);
    for (const step of c.do) {
      const result = effects({kinds, act: step.act, state, receipt: step.receipt});
      assert.deepEqual(mismatches(step.expect, result), [], `${c.name}: ${JSON.stringify(result)}`);
      const done = apply(state, result);
      assert.ok(done.ok);
      state = done.state;
    }
    for (const [id, want] of Object.entries(c.after)) assert.ok(same(state.nodes[id], want), `${id}: ${JSON.stringify(state.nodes[id])}`);
  }

  // Slimmed: both case files together are at most 12 KB. And nothing the scrub guard refuses.
  assert.ok(statSync(rulesFile).size + statSync(effectsFile).size <= 12 * 1024);
  for (const f of out.files) for (const line of readFileSync(join(root, f), 'utf8').split('\n')) assert.deepEqual(scrubLine(line, f), [], f);
});

test('A1: a taken name, a defined kind or a bad name is refused, and nothing is written', t => {
  const root = mkdtempSync(join(tmpdir(), 'entry-new-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  assert.equal(run('gauges', 'tide_gauge', '--root', root).status, 0);
  const again = run('gauges', 'tide_gauge', '--root', root);
  assert.equal(again.status, 2);
  assert.match(JSON.parse(again.stdout).error, /exists/);
  const other = run('other', 'tide_gauge', '--root', root);
  assert.match(JSON.parse(other.stdout).error, /tide_gauge\.json exists/);
  assert.equal(existsSync(join(root, 'content/kinds/other')), false);
  // A kind committed in this checkout is refused by default (no --root).
  const real = run('lights', 'bollard_light');
  assert.equal(real.status, 2);
  assert.match(JSON.parse(real.stdout).error, /exists|already defined/);
  for (const [family, kind] of [['Tide', 'tide_gauge'], ['tide', 'Tide-Gauge'], ['tide', undefined]]) {
    const bad = run(...[family, kind].filter(Boolean), '--root', root);
    assert.equal(bad.status, 2, `${family} ${kind}`);
  }
  assert.equal(existsSync(join(ROOT, 'content/kinds/Tide')), false);
});
