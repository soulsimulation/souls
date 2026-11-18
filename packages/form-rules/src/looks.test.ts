import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkTable, declaredState, looks, NAME, type LookRow } from './looks.ts';

const DIR = join(import.meta.dirname, '../cases/looks');
type Kind = { kind: string; state: Record<string, { type: string; values?: string[]; min?: number; max?: number }>; looks: { model: string; table: LookRow[] } };
const kinds: Record<string, Kind> = {};
for (const f of readdirSync(join(DIR, 'kinds'))) {
  const e = JSON.parse(readFileSync(join(DIR, 'kinds', f), 'utf8'));
  kinds[e.kind] = e;
}
const doc = JSON.parse(readFileSync(join(DIR, 'cases.json'), 'utf8'));

for (const c of doc.cases) {
  test(`looks: ${c.name}`, () => {
    const table = c.table ?? kinds[c.kind].looks.table;
    const input = { table, state: c.state, prev: c.prev, t_us: c.t_us, now_us: c.now_us, fields: c.kind ? kinds[c.kind].state : undefined };
    const got = looks(input);
    assert.deepEqual(JSON.parse(JSON.stringify(got)), c.expect);
    for (const p of Object.values(got)) for (const v of [p.rotate_mdeg, p.slide_mm, p.scale_permille, p.glow_permille, p.steam_permille, p.flame_permille, p.growth_permille, p.wilt_permille].flat()) if (v !== undefined) assert.ok(Number.isInteger(v));
    assert.deepEqual(looks(input), got, 'the same input gives the same answer');
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

// SA-D1b (#2886): a look that follows a timed value is worked out on the viewer from the three stored numbers and world time.
const kettle = kinds['looks:timed_kettle'];
const filling = { level: { value: 0, per_s: 16, set_us: 5000000 } };
const levelAt = (now_us: number | bigint, state: Record<string, unknown> = filling) =>
  looks({ table: kettle.looks.table, state: state as never, now_us, fields: kettle.state }).fill?.scale_permille?.[1];

test('A1: one stored value rises smoothly for 60 s of world time, never falling, in steps of at most one permille', () => {
  let last = levelAt(5000000)!, rises = 0;
  for (let t = 5000000 + 50000; t <= 65000000; t += 50000) {   // every 50 ms of world time, from the one record
    const now = levelAt(t)!;
    assert.ok(now >= last && now - last <= 1, `at ${t} us: ${last} then ${now}`);
    if (now > last) rises++;
    last = now;
  }
  assert.equal(last, 960);
  assert.ok(rises >= 900, `rose ${rises} times`);
});

test('A2: two viewers at the same world time draw the same level, whenever each began watching', () => {
  const a = Array.from({ length: 61 }, (_, s) => levelAt(5000000 + s * 1000000));
  const b = Array.from({ length: 61 }, (_, s) => levelAt(5000000 + (60 - s) * 1000000)).reverse();
  assert.deepEqual(a, b);
});

test('a world time past 2^53 microseconds is read as a big integer', () => {
  const late = { level: { value: 0, per_s: 1, set_us: 9007199000000000n } };
  assert.equal(levelAt(9007199500000000n, late), 500);
});

test('a timed field passes the page hook as its three numbers, untouched', () => {
  assert.deepEqual(declaredState({ level: { value: 0, per_s: 16, set_us: 5000000 } }, { level: 'permille' }), { level: { value: 0, per_s: 16, set_us: 5000000 } });
});
