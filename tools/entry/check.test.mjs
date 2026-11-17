// Tests for the check gate (Soul Actions SA-P2, #2862). Each test is one acceptance item of the issue.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as C from './check.mjs';
import * as F from './format.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const CHECK = fileURLToPath(new URL('./check.mjs', import.meta.url));
const EXAMPLES = ['kitchen/kettle', 'seating/bench', 'gathering/lecture'].map(p => `${root}content/kinds/${p}.json`);
// One fixture per rule the data can break. `moves` is not here: its sections are SA-F10's, and until the format
// defines them no entry can break it (deferred: see the PR).
const RULES = Object.keys(C.RULES).filter(r => r !== 'moves' && r !== 'shape');
// The fixtures are the examples with one fault each, built here so they follow the examples as the format grows.
const ex = i => JSON.parse(readFileSync(EXAMPLES[i], 'utf8'));
const mk = (i, name, fn) => { const e = ex(i); e.kind = `fixture:${name.replace(/-/g, '_')}`; fn(e); return JSON.stringify(e, null, 2); };
const FIX = {
  exact: () => mk(0, 'exact', () => {}).replace(/"after_us": 150000000/, '"after_us": 1.5e8'),
  targets: () => mk(1, 'targets', e => { e.forms.sit.takes.seat.select.of = 'things'; }),
  makes: () => mk(0, 'makes', e => { e.forms.conjure = {who: 'anyone', starts: 'act', needs: [], steps: [], effects: [{change: 'create', kind: 'eden:bench', into: 'actor_hand', event: 'made'}]}; }),
  'engine-names': () => mk(0, 'engine-names', e => { e.state.server_flag = {...e.state.heating, n: 9}; }),
  'no-waiting': () => mk(0, 'no-waiting', e => { e.forms.boiled.effects.push({change: 'timer', form: 'boiled', after_us: 1000000, event: 'checked_again'}); }),
  bounded: () => mk(2, 'bounded', e => { delete e.links.listener.most; }),
  'way-out': () => mk(0, 'way-out', e => { e.state.water.values = ['empty', 'hot']; }),
  card: () => mk(0, 'card', e => { delete e.card; }),
  'no-labels': () => mk(0, 'no-labels', e => { e.text.card = 'A cosy kettle for quiet afternoons.'; }),
  refs: () => mk(0, 'refs', e => { e.forms.pour.effects.push({change: 'remove', what: 'this', event: 'used_up'}, {change: 'create', kind: 'fixture:missing', into: 'actor_hand', event: 'made'}); }),
};
const dir = mkdtempSync(join(tmpdir(), 'entry-fixtures-'));
const fixtureFile = rule => { const f = join(dir, `${rule}.json`); writeFileSync(f, FIX[rule]()); return f; };
test.after(() => rmSync(dir, {recursive: true, force: true}));
const run = (...args) => spawnSync(process.execPath, [CHECK, ...args], {encoding: 'utf8'});

test('A1: one fixture per rule fails with that rule\'s finding and nothing else', () => {
  for (const rule of RULES) {
    const file = fixtureFile(rule);
    const {findings} = C.checkText(readFileSync(file, 'utf8'));
    const rows = rule === 'refs' ? C.checkFiles([file], [file]).flatMap(r => r.findings) : findings;
    assert.ok(rows.length > 0, `${rule}: expected a finding`);
    assert.deepEqual([...new Set(rows.map(f => f.rule))], [rule], `${rule}: ${JSON.stringify(rows)}`);
    for (const f of rows) assert.ok(f.path && f.reason && f.fix && 'form' in f && 'field' in f, `${rule}: a finding names form, field and fix`);
    const r = run(file);
    assert.equal(r.status, 1, `${rule}: exits non-zero`);
    assert.ok(r.stdout.includes(`"rule":"${rule}"`), `${rule}: named in the output`);
  }
});

test('card: a card with a purpose text over 80 characters is refused, with the field and the fix', () => {
  const long = JSON.parse(FIX.card()); long.card = {text: 'card'}; long.text.card = 'A kettle: fill it, switch it on, and it boils water for tea, which you can then pour into a cup.';
  const f = C.checkText(JSON.stringify(long)).findings;
  assert.deepEqual(f.map(x => x.rule), ['card']);
  assert.equal(f[0].field, 'card');
  assert.match(f[0].fix, /80/);
  const none = C.checkText(FIX.card()).findings;
  assert.deepEqual(none.map(x => [x.rule, x.path]), [['card', 'card']]);
  assert.match(none[0].fix, /"card"/);
});

test('A1: a finding names the form and the field', () => {
  const f = C.checkText(FIX.targets()).findings[0];
  assert.equal(f.form, 'sit');
  assert.equal(f.path, 'forms.sit.takes.seat.select.of');
  assert.match(f.fix, /free_slots/);
});

test('A1: the rules the format already makes impossible are reported under their rule', () => {
  const kettle = JSON.parse(readFileSync(EXAMPLES[0], 'utf8'));
  const rule = e => [...new Set(C.checkText(JSON.stringify(e)).findings.map(f => f.rule))];
  const a = structuredClone(kettle); a.forms.switch_on.steps[0] = {step: 'teleport'};
  assert.deepEqual(rule(a), ['engine-names']);
  const b = structuredClone(kettle); b.forms.switch_on.effects[1].after_ticks = 3000;
  assert.deepEqual(rule(b), ['exact']);
  const c = structuredClone(kettle); c.forms.switch_on.steps.push({step: 'wait', us: 0});
  assert.deepEqual(rule(c), ['no-waiting']);
  const d = structuredClone(kettle); d.forms.switch_on.effects.push({change: 'create', kind: 'eden:kettle', into: 'nowhere', event: 'made'});
  assert.deepEqual(rule(d), ['makes']);
});

test('A2: the three example entries pass, as a family and as the whole folder', () => {
  for (const args of [[], ['check'], ['check', 'kitchen'], ['seating'], ...EXAMPLES.map(p => [p])]) {
    const r = run(...args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stdout}`);
    assert.match(r.stdout.trim().split('\n').at(-1), /"ok":true/);
  }
  assert.equal(run('nosuchfamily').status, 2);
});

test('A3: 1,000 entries are checked in under 10 seconds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'entry-check-'));
  try {
    mkdirSync(join(dir, 'many'));
    const texts = EXAMPLES.map(p => readFileSync(p, 'utf8'));
    for (let i = 0; i < 1000; i++) writeFileSync(join(dir, 'many', `k${i}.json`), texts[i % 3].replace(/"kind": "eden:(\w+)"/, `"kind": "eden:$1_${i}"`));
    const t = performance.now();
    const r = run(join(dir, 'many'));
    const took = performance.now() - t;
    assert.equal(r.status, 0, r.stdout.slice(-300));
    assert.equal(JSON.parse(r.stdout.trim().split('\n').at(-1)).checked, 1000);
    assert.ok(took < 10000, `took ${Math.round(took)} ms`);
    console.log(`1000 entries checked in ${Math.round(took)} ms`);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
