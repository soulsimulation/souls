import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateTimed } from './generate.ts';
import { CASES, loadCases, loadKinds, loadTimedCases, PACKAGE, same } from './load.ts';
import { crossing, decide, valueAt } from './rules.ts';

const kinds = loadKinds();
const cases = loadTimedCases();

const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
// A1: each case's value at each stated time, and each crossing, from the stored three numbers alone.
for (const [file, c] of cases) {
  test(`${file.slice(CASES.length + 1)}: ${c.name}`, () => {
    const def = kinds[c.kind].state![c.field];
    assert.equal(def.type, 'timed');
    for (const [at, want] of c.values) assert.ok(same(valueAt(def, c.stored, at), want), `value at ${at}: ${show(valueAt(def, c.stored, at))}`);
    for (const { expect, from_us, ...level } of c.crossings) {
      const got = crossing(def, c.stored, level, from_us);
      assert.ok(same(got, expect), `${show(level)} from ${from_us}: ${show(got)}`);
    }
  });
}

test('A1: the kettle switched on boils at a stated time, and reads full heat from then on', () => {
  const boils = cases.flatMap(([, c]) => c.crossings.filter((x) => x.at_least === 100000 && typeof x.expect === 'number' && x.expect > x.from_us));
  assert.ok(boils.length > 0, 'a case states the boiling time');
});

// A2: a need on a timed field turns from no to yes at exactly the crossing: by hand-written cases, and over generated values.
test('A2: "heat at least 100000" is no one microsecond before the crossing and yes at it', () => {
  const mine = loadCases().filter(([, c]) => c.act.form === 'pour_boiling').map(([, c]) => c);
  const at = (v: string) => mine.filter((c) => c.expect.verdict === v).map((c) => c.state.now_us);
  const boiling = cases[0][1].crossings[0].expect as number;
  assert.deepEqual(at('yes'), [boiling]);
  assert.ok(at('no').includes(boiling - 1));
  const kettle = kinds['test:timed_kettle'];
  let checked = 0;
  for (const t of generateTimed(1000, 2845)) {
    const def = { ...kettle.state!.heat, ...t.def };
    const from = (t.stored as { set_us: number }).set_us;
    const c = crossing(def, t.stored, t.level, from);
    if (typeof c !== 'number' || c === from) continue;
    const ask = (now_us: number) =>
      decide({
        kinds: { 'test:timed_kettle': { ...kettle, state: { heat: def }, forms: { f: { who: 'anyone', starts: 'act', needs: [{ need: 'state', field: 'heat', ...t.level }] } } } },
        act: { this: 'k1', form: 'f' },
        state: { actor: 'b1', now_us, nodes: { k1: { kind: 'test:timed_kettle', fields: { heat: t.stored } }, b1: {} } },
        asker: { sees: 'all' },
      }).verdict;
    assert.equal(ask(c - 1), 'no', JSON.stringify(t));
    assert.equal(ask(c), 'yes', JSON.stringify(t));
    checked++;
  }
  assert.ok(checked > 100, `only ${checked} generated crossings`);
});

test('a crossing is the first whole microsecond the value meets the level, for rising and falling values', () => {
  for (const t of generateTimed(1000, 5)) {
    const c = crossing(t.def, t.stored, t.level, t.at_us);
    if (typeof c !== 'number') continue;
    const meets = (v: unknown) => ('at_least' in t.level ? (v as number) >= t.level.at_least : (v as number) <= t.level.at_most);
    assert.ok(meets(valueAt(t.def, t.stored, c)), JSON.stringify(t));
    if (c > t.at_us) assert.ok(!meets(valueAt(t.def, t.stored, c - 1)), JSON.stringify(t));
  }
});

// A3: the timed functions hold no floating-point number. Every number literal between the markers is a big integer,
// and JavaScript refuses to mix big integers with other numbers, so no float can enter the arithmetic.
test('A3: no floating-point number in the timed functions (a lint)', () => {
  const source = readFileSync(join(PACKAGE, 'src/rules.ts'), 'utf8');
  const begin = source.indexOf('// timed:begin'), end = source.indexOf('// timed:end');
  assert.ok(begin > 0 && end > begin, 'the markers are in rules.ts');
  const code = source
    .slice(begin, end)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'[^']*'/g, "''");
  assert.doesNotMatch(code, /\d\.\d|\.\d|\d[eE][+-]?\d/, 'a decimal or exponent literal');
  assert.doesNotMatch(code, /\bMath\.|parseFloat|toFixed|Number\.EPSILON/, 'floating-point arithmetic');
  const plain = [...code.matchAll(/(?<![\w$])\d+(?![\dn\w])/g)].map((m) => m[0]);
  assert.deepEqual(plain, [], 'every number literal is a big integer (ends in n)');
});
