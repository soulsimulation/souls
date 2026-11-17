import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkTable, declaredState, looks, NAME, type LookRow } from './looks.ts';

const DIR = join(import.meta.dirname, '../cases/looks');
type Kind = { kind: string; state: Record<string, { type: string; values?: string[] }>; looks: { model: string; table: LookRow[] } };
const kinds: Record<string, Kind> = {};
for (const f of readdirSync(join(DIR, 'kinds'))) {
  const e = JSON.parse(readFileSync(join(DIR, 'kinds', f), 'utf8'));
  kinds[e.kind] = e;
}
const doc = JSON.parse(readFileSync(join(DIR, 'cases.json'), 'utf8'));

for (const c of doc.cases) {
  test(`looks: ${c.name}`, () => {
    const table = c.table ?? kinds[c.kind].looks.table;
    const got = looks({ table, state: c.state, prev: c.prev, t_us: c.t_us });
    assert.deepEqual(JSON.parse(JSON.stringify(got)), c.expect);
    for (const p of Object.values(got)) for (const v of [p.rotate_mdeg, p.slide_mm, p.scale_permille, p.glow_permille].flat()) if (v !== undefined) assert.ok(Number.isInteger(v));
    assert.deepEqual(looks({ table, state: c.state, prev: c.prev, t_us: c.t_us }), got, 'the same input gives the same answer');
  });
}

test('A3: at least ten distinct states are cases', () => {
  assert.ok(doc.cases.length >= 10);
});

test('every table in the cases passes its own check, and look names keep to what Engine v2 accepts', () => {
  for (const [name, e] of Object.entries(kinds)) {
    assert.deepEqual(checkTable(e.looks.table, e.state), [], name);
    assert.match(e.looks.model, NAME);
  }
  for (const c of doc.cases) if (c.table) assert.deepEqual(checkTable(c.table), [], c.name);
});

test('a table that is wrong is named, not drawn', () => {
  const bad = (row: unknown) => checkTable([row]);
  assert.ok(bad({ part: 'a', field: 'x', do: 'slide', at: { true: 1 } }).some((m) => m.includes('axis')));
  assert.ok(bad({ part: 'kettle#2', field: 'x', do: 'show', at: { true: 1 } }).some((m) => m.includes('.part')));
  assert.ok(bad({ part: 'é', field: 'x', do: 'show', at: { true: 1 } }).length > 0);
  assert.ok(bad({ part: 'a', field: 'x', do: 'scale', at: { true: 1.5 } }).some((m) => m.includes('whole')));
  assert.ok(bad({ part: 'a', field: 'x', do: 'fly', at: { true: 1 } }).some((m) => m.includes('.do')));
  assert.ok(bad({ part: 'a', field: 'x', do: 'scale', range: [5, 5], to: [1, 2] }).some((m) => m.includes('range')));
  assert.ok(bad({ do: 'pick', field: 'x', at: { a: 'bad name!' } }).length > 0);
  assert.ok(checkTable([{ part: 'a', field: 'nope', do: 'show', at: { true: 1 } }], { x: { type: 'bool' } }).some((m) => m.includes('field')));
});

test('a table of 64 rows is answered in well under a millisecond', () => {
  const table: LookRow[] = Array.from({ length: 64 }, (_, i) => ({ part: `p${i % 8}`, field: 'n', do: 'scale', axis: 'y', range: [0, 1000], to: [1, 1000] }));
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) looks({ table, state: { n: i % 1000 } });
  assert.ok((performance.now() - t0) / 1000 < 1);
});

test('a field that is not in thousandths drives a look as declared; a permille field held as a fraction is scaled back', () => {
  const table: LookRow[] = [{ part: 'bar', field: 'height_mm', do: 'slide', axis: 'y', range: [0, 400], to: [0, 400] }, { part: 'tea', field: 'fullness', do: 'scale', axis: 'y', range: [0, 1000], to: [1, 1000] }];
  const state = declaredState({ height_mm: 300, fullness: 0.5 }, { fullness: 'permille' });
  assert.deepEqual(state, { height_mm: 300, fullness: 500 });
  assert.deepEqual(JSON.parse(JSON.stringify(looks({ table, state }))), { bar: { slide_mm: [0, 300, 0] }, tea: { scale_permille: [1000, 500, 1000] } });
});
