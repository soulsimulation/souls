import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { generate } from './generate.ts';
import { CASES, loadCases, loadKinds, mismatches, PACKAGE } from './load.ts';
import { decide, NEEDS, REASONS } from './rules.ts';

const kinds = loadKinds();
const cases = loadCases();

// A1 and A4: every hand-written case gives its expected verdict. Adding a case file changes no code.
for (const [file, c] of cases) {
  test(`${file.slice(CASES.length + 1)}: ${c.name}`, () => {
    const verdict = decide({ kinds, ...c });
    assert.deepEqual(mismatches(c.expect, verdict), [], JSON.stringify(verdict));
  });
}

test('A1: the kettle, the seat and the lecture each have a yes per form and a case per need they declare', () => {
  for (const kind of ['eden:kettle', 'eden:bench', 'eden:lecture']) {
    for (const [name, form] of Object.entries(kinds[kind].forms ?? {})) {
      const mine = cases.filter(([, c]) => c.act.form === name && c.state.nodes[c.act.this]?.kind === kind).map(([, c]) => c);
      assert.ok(mine.some((c) => c.expect.verdict === 'yes'), `${kind} ${name}: no case where every need is met`);
      (form.needs ?? []).forEach((_, i) => {
        assert.ok(mine.some((c) => c.expect.verdict === 'no' && c.expect.need === i && c.expect.reason !== 'bad_input'), `${kind} ${name}: need ${i} has no unmet case`);
      });
    }
  }
});

test('a within_reach of another thing is unknown, not no, when its pose is not in the input', () => {
  const c = cases.find(([, k]) => k.name === 'fill_tap_in_reach')![1];
  const nodes = { ...c.state.nodes, t1: { kind: 'test:reach_tap' } };
  const v = decide({ kinds, ...c, state: { ...c.state, nodes } });
  assert.deepEqual([v.verdict, (v as { node?: string }).node, (v as { field?: string }).field], ['unknown', 't1', 'at_mm']);
});

test('A4: unknown only for a field outside the audience; the same state seen by all is definite', () => {
  for (const [, c] of cases.filter(([, c]) => c.expect.verdict === 'unknown')) {
    const all = decide({ kinds, ...c, asker: { sees: 'all' } });
    assert.notEqual(all.verdict, 'unknown', c.name);
  }
  for (const input of generate(kinds, 1000, 7)) {
    const v = decide({ kinds, ...input });
    if (v.verdict !== 'unknown') continue;
    assert.ok(v.field || v.link, 'an unknown names its field or link');
    assert.notEqual(decide({ kinds, ...input, asker: { sees: 'all' } }).verdict, 'unknown');
  }
});

test('every reason named by a verdict is in the closed list, and every verdict carries its read set', () => {
  for (const input of generate(kinds, 1000, 11)) {
    const v = decide({ kinds, ...input });
    assert.ok(Array.isArray(v.read));
    if (v.verdict === 'no') assert.ok(REASONS.includes(v.reason), v.reason);
  }
  for (const [, c] of cases) if (c.expect.reason) assert.ok(REASONS.includes(c.expect.reason as string));
  for (const entry of Object.values(kinds)) for (const f of Object.values(entry.forms ?? {})) for (const n of f.needs ?? []) assert.ok(NEEDS.includes(n.need), n.need);
});

test('never throws, whatever it is given', () => {
  const junk: unknown[] = [null, {}, { act: {}, state: {}, kinds: {}, asker: {} }, { kinds, act: { this: 'x', form: 'y' }, state: { actor: 'b', nodes: { x: { kind: 'eden:kettle' } } }, asker: { sees: [] } }];
  for (const j of junk) assert.equal(decide(j as never).verdict, 'no');
});

test('A3: the library imports nothing from apps/, mars/ or packages/engine-*', () => {
  const src = join(PACKAGE, 'src');
  for (const file of readdirSync(src)) {
    const text = readFileSync(join(src, file), 'utf8');
    const specifiers = [...text.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
    for (const s of specifiers) {
      assert.ok(s.startsWith('./') || s.startsWith('node:'), `${file} imports ${s}`);
      assert.doesNotMatch(s, /apps\/|mars\/|engine-/, `${file} imports ${s}`);
    }
    if (file === 'rules.ts') assert.deepEqual(specifiers, [], 'rules.ts imports nothing');
  }
});
