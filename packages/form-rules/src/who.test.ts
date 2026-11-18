import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { generate } from './generate.ts';
import { CASES, loadCases, loadKinds, mismatches, PACKAGE } from './load.ts';
import { whoMay, WHO } from './rules.ts';

const kinds = loadKinds();
const cases = loadCases(join(CASES, 'who'), 'souls-who-cases/1');

// Every who-may case gives its expected verdict. Adding a case changes no code.
for (const [file, c] of cases) {
  test(`${file.slice(CASES.length + 1)}: ${c.name}`, () => {
    const verdict = whoMay({ kinds, ...c });
    assert.deepEqual(mismatches(c.expect, verdict), [], JSON.stringify(verdict));
  });
}

test('A1: the workbench, the chess move and the lecture speech are each asked by an owner, a member, the Soul whose turn it is and a stranger', () => {
  const examples: [string, string, string][] = [
    ['test:workbench', 'use', 'owner'],
    ['test:chess', 'move', 'turn'],
    ['test:lecture', 'speak', 'turn'],
  ];
  for (const [kind, form, allowed] of examples) {
    const mine = cases.map(([, c]) => c).filter((c) => c.act.form === form && c.state.nodes[c.act.this]?.kind === kind);
    for (const who of ['owner', 'member', 'turn', 'stranger']) {
      const c = mine.find((x) => x.name.endsWith(`_${who}`));
      assert.ok(c, `${kind} ${form}: no case for the ${who}`);
      assert.equal(c.expect.verdict, who === allowed ? 'yes' : 'no', `${kind} ${form} ${who}`);
    }
  }
});

test('A2: every refusal names who may: the rule, and for a link its type and its ends', () => {
  const check = (v: ReturnType<typeof whoMay>, what: string) => {
    if (v.verdict !== 'no' || v.reason !== 'not_permitted') return 0;
    assert.ok(v.who !== undefined && v.who !== null, `${what}: no rule named`);
    if (typeof v.who === 'object') {
      assert.equal(v.detail.link, (v.who as { link: string }).link, what);
      assert.ok(Array.isArray(v.detail.ends), `${what}: no ends named`);
    }
    return 1;
  };
  let refusals = 0;
  for (const [, c] of cases) refusals += check(whoMay({ kinds, ...c }), c.name);
  for (const input of generate(kinds, 1000, 2848)) refusals += check(whoMay({ kinds, ...input }), JSON.stringify(input.act));
  assert.ok(refusals > 0);
});

test('A3: no who-may rule reads a field: the code between the who markers never touches `fields`', () => {
  const src = readFileSync(join(PACKAGE, 'src/rules.ts'), 'utf8');
  const block = src.slice(src.indexOf('// who:begin'), src.indexOf('// who:end'));
  assert.ok(block.length > 0 && block.includes('export function whoMay'));
  const code = block.split('\n').filter((l) => !l.trim().startsWith('//'));
  assert.deepEqual(code.filter((l) => /fields|def\.type|\.default\b/.test(l)), []);
});

test('the who of every form of every kind is in the closed list', () => {
  for (const entry of Object.values(kinds)) {
    for (const [name, form] of Object.entries(entry.forms ?? {})) {
      const who = form.who ?? 'anyone';
      const test = typeof who === 'object' && who !== null && Object.keys(who).length === 1 && 'link' in who ? 'link' : who;
      assert.ok(WHO.includes(test as string), `${entry.kind} ${name}: ${JSON.stringify(who)}`);
    }
  }
});

test('never throws, whatever it is given', () => {
  const junk: unknown[] = [null, {}, { act: {}, state: {}, kinds: {}, asker: {} }, { kinds, act: { this: 'w1', form: 'use' }, state: { actor: 'b', nodes: { w1: { kind: 'test:workbench', links: { owner: 'x' } }, b: { links: { soul: 7 } } } }, asker: { sees: 'all' } }];
  for (const j of junk) assert.equal(whoMay(j as never).verdict, 'no');
});
